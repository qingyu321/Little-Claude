"""Explicit model providers for video frame observation and text report synthesis.

The analyzer never imports vendor SDKs directly. This module owns provider
capability metadata, credential checks, request construction, response
extraction, and JSON normalization.

Data boundaries:

- Vision providers may receive JPEG frames as Base64 data URLs. OpenAI GPT and
  xAI Grok use their documented official routes; the `custom` provider targets a
  user-supplied OpenAI-compatible endpoint (Chat Completions `image_url` format,
  the most widely supported shape across relays and local gateways).
- Synthesis providers receive text-only timeline evidence. DeepSeek hosted API
  is supported for synthesis only; it never receives images.

A failed selected provider must not fail over to another provider. The analyzer
is responsible for degrading to the deterministic local report.
"""

from __future__ import annotations

import base64
import json
import re
from dataclasses import dataclass
from pathlib import Path
from typing import Any, Callable
from urllib.parse import urlparse

NONE = "none"
OPENAI = "openai"
XAI = "xai"
DEEPSEEK = "deepseek"
CUSTOM = "custom"
DETERMINISTIC = "deterministic"

VISION = "vision"
SYNTHESIS = "synthesis"

VISION_PROVIDERS = (NONE, OPENAI, XAI, CUSTOM)
SYNTHESIS_PROVIDERS = (NONE, OPENAI, XAI, DEEPSEEK, CUSTOM)

DEFAULT_MODELS = {
    OPENAI: "gpt-5",
    XAI: "grok-4.5",
    DEEPSEEK: "deepseek-v4-pro",
}

API_KEY_ENV = {
    OPENAI: "OPENAI_API_KEY",
    XAI: "XAI_API_KEY",
    DEEPSEEK: "DEEPSEEK_API_KEY",
}

DEFAULT_CUSTOM_API_KEY_ENV = "CUSTOM_API_KEY"

# Fixed endpoints for named providers prevent silent data redirection.
XAI_BASE_URL = "https://api.x.ai/v1"
DEEPSEEK_BASE_URL = "https://api.deepseek.com"

# Documented xAI per-image cap; enforced conservatively for all remote vision.
MAX_IMAGE_BYTES = 20 * 1024 * 1024

# Valid 1x1 JPEG, used for the image-input probe only when the caller has no
# real frame to spare. A real extracted frame is preferred when available.
PROBE_IMAGE_DATA_URL = (
    "data:image/jpeg;base64,"
    "/9j/4AAQSkZJRgABAQEAYABgAAD/2wBDAAgGBgcGBQgHBwcJCQgKDBQNDAsLDBkSEw8UHRofHh0a"
    "HBwgJC4nICIsIxwcKDcpLDAxNDQ0Hyc5PTgyPC4zNDL/wAALCAABAAEBAREA/8QAFAABAAAAAAAA"
    "AAAAAAAAAAAACf/EABQQAQAAAAAAAAAAAAAAAAAAAAD/2gAIAQEAAD8AVN//2Q=="
)

_LOOPBACK_HOSTS = {"127.0.0.1", "localhost", "::1"}


class ProviderConfigurationError(RuntimeError):
    """The selected provider cannot be configured for the requested stage."""


class ProviderResponseError(RuntimeError):
    """The selected provider returned an unusable response."""


@dataclass(frozen=True)
class ProviderSpec:
    """Immutable description of what a configured stage will send where."""

    stage: str
    provider: str
    model: str
    api_key_env: str | None
    base_url: str | None
    remote: bool
    supports_images: bool
    data_sent: tuple[str, ...]

    @property
    def label(self) -> str:
        return f"{self.provider}:{self.model}" if self.provider != NONE else NONE


@dataclass(frozen=True)
class StageRequest:
    """User-requested provider/model selection for one pipeline stage."""

    stage: str
    provider: str
    model: str | None = None
    base_url: str | None = None
    api_key_env: str | None = None

    @property
    def requested_label(self) -> str:
        if self.provider == NONE:
            return NONE
        return f"{self.provider}:{self.model or DEFAULT_MODELS.get(self.provider, '')}"


@dataclass(frozen=True)
class StageResult:
    """Outcome metadata for a pipeline stage, safe for provenance output."""

    request: StageRequest
    spec: ProviderSpec | None = None
    status: str = "not_requested"
    detail: str | None = None
    extra: dict[str, Any] | None = None

    def provenance(self) -> dict[str, Any]:
        value: dict[str, Any] = {
            "status": self.status,
            "requested": self.request.requested_label,
        }
        if self.spec is not None:
            value.update(
                {
                    "provider": self.spec.provider,
                    "model": self.spec.model,
                    "remote": self.spec.remote,
                }
            )
            if self.spec.base_url:
                value["base_url"] = self.spec.base_url
            if self.spec.remote:
                value["data_sent"] = list(self.spec.data_sent)
        if self.detail:
            value["detail"] = self.detail
        if self.extra:
            value.update(self.extra)
        return value


def extract_json(text: str) -> Any:
    """Parse JSON from provider output, tolerating fenced blocks and prose."""
    cleaned = text.strip()
    fenced = re.search(r"```(?:json)?\s*(.*?)\s*```", cleaned, re.DOTALL | re.IGNORECASE)
    if fenced:
        cleaned = fenced.group(1)
    try:
        return json.loads(cleaned)
    except json.JSONDecodeError:
        start = cleaned.find("{")
        end = cleaned.rfind("}")
        if start >= 0 and end > start:
            return json.loads(cleaned[start : end + 1])
        raise


def assert_custom_base_url(url: str | None) -> str:
    """Validate a user-supplied OpenAI-compatible endpoint.

    Requires HTTPS, except loopback HTTP for local relays/gateways, so API keys
    are never sent in plaintext over the network.
    """
    if not url:
        raise ProviderConfigurationError("Provider 'custom' requires an explicit base URL.")
    parsed = urlparse(url)
    if parsed.scheme == "https" and parsed.netloc:
        return url
    if parsed.scheme == "http" and (parsed.hostname or "") in _LOOPBACK_HOSTS:
        return url
    raise ProviderConfigurationError(
        "Custom base URL must be https:// (or http:// only for loopback addresses such as http://127.0.0.1:8080)."
    )


def provider_readiness(
    *,
    provider: str,
    stage: str,
    find_spec: Callable[[str], Any],
    environ: dict[str, Any],
    api_key_env: str | None = None,
    base_url: str | None = None,
) -> dict[str, Any]:
    """Report read-only readiness without instantiating clients or keys."""
    if stage == VISION and provider not in VISION_PROVIDERS:
        return {
            "supported": False,
            "reason": f"{provider} has no confirmed image-input contract and cannot be used for vision.",
        }
    if stage == SYNTHESIS and provider not in SYNTHESIS_PROVIDERS:
        return {"supported": False, "reason": f"{provider} is not supported for synthesis."}
    if provider == NONE:
        return {"supported": True, "ready": True, "reason": "No remote provider requested."}
    sdk_present = find_spec("openai") is not None
    if provider == CUSTOM:
        key_env = api_key_env or DEFAULT_CUSTOM_API_KEY_ENV
        url_valid = True
        try:
            assert_custom_base_url(base_url)
        except ProviderConfigurationError:
            url_valid = bool(base_url is None)  # Missing URL is reported as not-ready, not unsupported.
        key_present = bool(environ.get(key_env))
        ready = sdk_present and key_present and url_valid and bool(base_url)
        reasons: list[str] = []
        if not sdk_present:
            reasons.append("Install the official openai Python SDK: pip install -r requirements.txt")
        if not key_present:
            reasons.append(f"Set {key_env} to enable the custom endpoint.")
        if not base_url:
            reasons.append("Pass --custom-base-url to identify the OpenAI-compatible endpoint.")
        elif not url_valid:
            reasons.append("Custom base URL must be https:// or loopback http://.")
        return {
            "supported": True,
            "ready": ready,
            "sdk_present": sdk_present,
            "api_key_present": key_present,
            "base_url_valid": url_valid,
            "reason": "; ".join(reasons) if reasons else "Custom endpoint is configured.",
        }
    key_present = bool(environ.get(API_KEY_ENV[provider]))
    ready = sdk_present and key_present
    reasons = []
    if not sdk_present:
        reasons.append("Install the official openai Python SDK: pip install -r requirements.txt")
    if not key_present:
        reasons.append(f"Set {API_KEY_ENV[provider]} to enable the selected {provider} stage.")
    return {
        "supported": True,
        "ready": ready,
        "sdk_present": sdk_present,
        "api_key_present": key_present,
        "reason": "; ".join(reasons) if reasons else "Selected provider is configured.",
    }


def probe_image_support(
    base_url: str,
    model: str,
    api_key: str,
    *,
    timeout: float = 8.0,
) -> bool | None:
    """Best-effort check whether a custom endpoint/model advertises image input.

    Returns True/False when the endpoint's model metadata is conclusive, and
    None when the endpoint does not expose usable capability metadata.
    """
    try:
        import requests
    except ImportError:
        return None
    url = base_url.rstrip("/") + f"/models/{model}"
    try:
        response = requests.get(url, headers={"Authorization": f"Bearer {api_key}"}, timeout=timeout)
    except Exception:
        return None
    if response.status_code != 200:
        return None
    try:
        data = response.json()
    except ValueError:
        return None
    if not isinstance(data, dict):
        return None
    capabilities = data.get("capabilities")
    if isinstance(capabilities, dict):
        modalities = capabilities.get("input_modalities")
        if isinstance(modalities, list):
            return "image" in modalities
    for key in ("supports_vision", "vision", "supports_image_input"):
        if isinstance(data.get(key), bool):
            return data[key]
    return None


def create_vision_provider(
    request: StageRequest,
    *,
    environ: dict[str, Any],
    client_factory: Callable[[ProviderSpec, str], Any] | None = None,
) -> "VisionProvider":
    spec = _resolve_spec(request, supports_images=True)
    api_key = environ.get(spec.api_key_env or "", "") if spec.provider != NONE else ""
    if spec.provider == CUSTOM and client_factory is None:
        support = probe_image_support(spec.base_url or "", spec.model, api_key)
        if support is False:
            raise ProviderConfigurationError(
                f"The endpoint reports that model '{spec.model}' does not support image input; it cannot be used for vision."
            )
    return VisionProvider(spec, _build_client(spec, api_key, client_factory))


def create_synthesis_provider(
    request: StageRequest,
    *,
    environ: dict[str, Any],
    client_factory: Callable[[ProviderSpec, str], Any] | None = None,
) -> "SynthesisProvider":
    spec = _resolve_spec(request, supports_images=False)
    api_key = environ.get(spec.api_key_env or "", "") if spec.provider != NONE else ""
    return SynthesisProvider(spec, _build_client(spec, api_key, client_factory))


class VisionProvider:
    """Analyzes one ordered batch of frames and returns one observation per frame."""

    def __init__(self, spec: ProviderSpec, client: Any) -> None:
        self.spec = spec
        self._client = client

    def analyze_batch(self, frames: list[dict[str, Any]]) -> list[dict[str, Any]]:
        if self.spec.provider in {OPENAI, XAI}:
            return self._analyze_responses_batch(frames)
        if self.spec.provider == CUSTOM:
            return self._analyze_chat_batch(frames)
        raise ProviderConfigurationError(f"Provider '{self.spec.provider}' cannot analyze frames.")

    def _analyze_responses_batch(self, frames: list[dict[str, Any]]) -> list[dict[str, Any]]:
        content: list[dict[str, Any]] = [{"type": "input_text", "text": _vision_instruction(frames)}]
        for frame in frames:
            content.append({"type": "input_image", "image_url": _read_jpeg_data_url(Path(frame["path"]))})
        text = _responses_text(
            self._client.responses.create(
                model=self.spec.model,
                input=[{"role": "user", "content": content}],
            )
        )
        return _finalize_observations(text, frames)

    def _analyze_chat_batch(self, frames: list[dict[str, Any]]) -> list[dict[str, Any]]:
        content: list[dict[str, Any]] = [{"type": "text", "text": _vision_instruction(frames)}]
        for frame in frames:
            content.append(
                {"type": "image_url", "image_url": {"url": _read_jpeg_data_url(Path(frame["path"]))}}
            )
        text = _chat_completion_text(
            self._client.chat.completions.create(
                model=self.spec.model,
                messages=[{"role": "user", "content": content}],
            )
        )
        return _finalize_observations(text, frames)

    def probe_image_input(self, frame_path: Path | None = None) -> dict[str, Any]:
        """Verify with one real request that the endpoint accepts image input.

        Named providers have a confirmed image contract, so no probe is sent.
        The custom provider is verified by submitting a single image before any
        frame batch: vision-capable models answer, text-only models reject the
        image_url content, which yields a definitive early failure instead of
        failing every batch.
        """
        if self.spec.provider != CUSTOM:
            return {"probed": False, "ok": True, "detail": "Provider has a confirmed image-input contract."}
        try:
            image_url = _read_jpeg_data_url(frame_path) if frame_path is not None else PROBE_IMAGE_DATA_URL
        except (OSError, ProviderConfigurationError):
            image_url = PROBE_IMAGE_DATA_URL
        content = [
            {"type": "text", "text": "Image-input probe: reply with the single word ok."},
            {"type": "image_url", "image_url": {"url": image_url}},
        ]
        try:
            response = self._client.chat.completions.create(
                model=self.spec.model,
                messages=[{"role": "user", "content": content}],
            )
            _chat_completion_text(response)
        except Exception as exc:
            return {
                "probed": True,
                "ok": False,
                "detail": (
                    f"The endpoint rejected a single test image, so model '{self.spec.model}' "
                    f"does not appear to support image input. {exc}"
                ),
            }
        return {"probed": True, "ok": True, "detail": "The endpoint accepted a test image."}


class SynthesisProvider:
    """Produces a structured report from text-only timeline evidence."""

    def __init__(self, spec: ProviderSpec, client: Any) -> None:
        self.spec = spec
        self._client = client

    def synthesize(self, payload: dict[str, Any]) -> dict[str, Any]:
        prompt = _synthesis_prompt(payload)
        if self.spec.provider in {DEEPSEEK, CUSTOM}:
            response = self._client.chat.completions.create(
                model=self.spec.model,
                messages=[{"role": "user", "content": prompt}],
            )
            text = _chat_completion_text(response)
        else:
            response = self._client.responses.create(
                model=self.spec.model,
                input=[{"role": "user", "content": [{"type": "input_text", "text": prompt}]}],
            )
            text = _responses_text(response)
        report = extract_json(text)
        if not isinstance(report, dict):
            raise ProviderResponseError("The selected synthesis provider returned a non-object report.")
        return report


def _resolve_spec(request: StageRequest, *, supports_images: bool) -> ProviderSpec:
    if request.stage == VISION and request.provider not in VISION_PROVIDERS:
        raise ProviderConfigurationError(
            f"{request.provider} has no confirmed hosted image-input contract and cannot be used for vision."
        )
    if request.stage == SYNTHESIS and request.provider not in SYNTHESIS_PROVIDERS:
        raise ProviderConfigurationError(f"{request.provider} is not supported for synthesis.")
    if request.provider == NONE:
        return ProviderSpec(
            stage=request.stage,
            provider=NONE,
            model="none",
            api_key_env=None,
            base_url=None,
            remote=False,
            supports_images=False,
            data_sent=(),
        )
    if request.provider == CUSTOM:
        base_url = assert_custom_base_url(request.base_url)
        if not request.model:
            raise ProviderConfigurationError(
                "Provider 'custom' requires an explicit model name via --vision-model/--synthesis-model."
            )
        model = request.model
        api_key_env = request.api_key_env or DEFAULT_CUSTOM_API_KEY_ENV
    else:
        model = request.model or DEFAULT_MODELS[request.provider]
        api_key_env = API_KEY_ENV[request.provider]
        base_url = None
        if request.provider == XAI:
            base_url = XAI_BASE_URL
        elif request.provider == DEEPSEEK:
            base_url = DEEPSEEK_BASE_URL
    if supports_images:
        data_sent = ("jpeg_frames_base64", "frame_timestamps", "vision_instruction")
    else:
        data_sent = (
            "source_label",
            "duration_seconds",
            "timeline_text",
            "transcript_text",
            "visual_observation_text",
            "known_limitations",
        )
    return ProviderSpec(
        stage=request.stage,
        provider=request.provider,
        model=model,
        api_key_env=api_key_env,
        base_url=base_url,
        remote=True,
        supports_images=supports_images,
        data_sent=data_sent,
    )


def _build_client(
    spec: ProviderSpec,
    api_key: str,
    client_factory: Callable[[ProviderSpec, str], Any] | None,
) -> Any:
    if spec.provider == NONE:
        return None
    if client_factory is not None:
        return client_factory(spec, api_key)
    if not api_key:
        raise ProviderConfigurationError(
            f"{spec.api_key_env} is not set for the selected {spec.provider} {spec.stage} provider."
        )
    try:
        from openai import OpenAI
    except ImportError as exc:
        raise ProviderConfigurationError(
            "The official openai Python SDK is not installed. Install requirements.txt or choose provider 'none'."
        ) from exc
    if spec.base_url:
        return OpenAI(api_key=api_key, base_url=spec.base_url, max_retries=0, timeout=300.0)
    return OpenAI(api_key=api_key, max_retries=0, timeout=300.0)


def _vision_instruction(frames: list[dict[str, Any]]) -> str:
    # Entries may carry a custom `label` (2x2 grid montages on the acceleration
    # path); plain frames fall back to the classic "Frame N: X.XXX seconds" line.
    lines = [
        frame.get("label") or f"Frame {index + 1}: {frame['timestamp_seconds']:.3f} seconds"
        for index, frame in enumerate(frames)
    ]
    return (
        "These images are ordered video frames. "
        + "\n".join(lines)
        + "\nReturn exactly one JSON object with an `observations` array in the same order "
        "(one observation per image; a montage image gets one observation covering all its cells). "
        "Each item must contain: timestamp_seconds (number copied from the label), "
        "scene (string), visible_text (array of strings), actions (array of strings), "
        "important_objects (array of strings), and is_key_moment (boolean). "
        "Only describe visible information; use empty arrays where evidence is absent."
    )


def _finalize_observations(text: str, frames: list[dict[str, Any]]) -> list[dict[str, Any]]:
    observations = _parse_observations(text, expected=len(frames))
    for frame, observation in zip(frames, observations, strict=True):
        observation["timestamp_seconds"] = frame["timestamp_seconds"]
        if "source_timestamps" in frame:  # Grid montage coverage (acceleration path)
            observation["source_timestamps"] = frame["source_timestamps"]
    return observations


def _read_jpeg_data_url(path: Path) -> str:
    raw = path.read_bytes()
    if len(raw) > MAX_IMAGE_BYTES:
        raise ProviderConfigurationError(
            f"Frame image {path.name} exceeds the {MAX_IMAGE_BYTES}-byte provider limit."
        )
    return "data:image/jpeg;base64," + base64.standard_b64encode(raw).decode("ascii")


def _responses_text(response: Any) -> str:
    text = getattr(response, "output_text", None)
    if isinstance(text, str) and text.strip():
        return text
    parts: list[str] = []
    for item in getattr(response, "output", []) or []:
        for block in getattr(item, "content", []) or []:
            candidate = getattr(block, "text", None)
            if isinstance(candidate, str):
                parts.append(candidate)
    if parts:
        return "".join(parts)
    raise ProviderResponseError("The selected provider returned no text output.")


def _chat_completion_text(response: Any) -> str:
    choices = getattr(response, "choices", None)
    if not choices:
        raise ProviderResponseError("The selected provider returned no choices.")
    message = getattr(choices[0], "message", None)
    text = getattr(message, "content", None)
    if not isinstance(text, str) or not text.strip():
        raise ProviderResponseError("The selected provider returned no text output.")
    return text


def _parse_observations(text: str, *, expected: int) -> list[dict[str, Any]]:
    try:
        parsed = extract_json(text)
    except (json.JSONDecodeError, ValueError) as exc:
        raise ProviderResponseError("The selected vision provider did not return parseable JSON.") from exc
    items = parsed.get("observations", []) if isinstance(parsed, dict) else []
    if not isinstance(items, list) or len(items) != expected:
        raise ProviderResponseError(
            f"The selected vision provider returned {len(items) if isinstance(items, list) else 0} observations for {expected} frames."
        )
    observations: list[dict[str, Any]] = []
    for item in items:
        if not isinstance(item, dict):
            raise ProviderResponseError("The selected vision provider returned a non-object frame observation.")
        observations.append(item)
    return observations


def _synthesis_prompt(payload: dict[str, Any]) -> str:
    timeline_text = payload.get("timeline_text", "")
    return (
        "Create a faithful, timestamped video report from this extracted evidence. "
        "Do not invent facts absent from the supplied timeline. Explicitly retain known limitations. "
        "Cross-validate the speech transcript against the visual observations: when what is said "
        "and what is shown disagree (including proper-noun spellings seen on screen versus heard), "
        "report both readings with timestamps instead of silently picking one. "
        "Return exactly JSON with title (string), summary (string), chapters "
        "(array of {start_seconds, end_seconds, title, summary}), "
        "key_moments (array of {timestamp_seconds, description}), limitations (array of strings).\n\n"
        f"Source: {payload.get('source_label', 'unknown')}\n"
        f"Duration: {payload.get('duration_seconds', 0):.1f}s\n"
        f"Evidence: {', '.join(payload.get('available_evidence_modalities', []))}\n"
        f"Known limitations: {json.dumps(payload.get('known_limitations', []), ensure_ascii=False)}\n\n"
        "=== TIMELINE EVIDENCE ===\n\n"
        f"{timeline_text}\n\n"
        "=== END OF EVIDENCE ==="
    )
