#!/usr/bin/env python3
"""Give a text-only model eyes.

image-reader is a TOKENICODE / Little Claude skill that lets an AI agent
without vision capabilities recognize images by delegating to an external
vision-capable model over an OpenAI-compatible Chat Completions endpoint.

The script is Python-3.9+ stdlib only: no pip install, no SDK. Images are
encoded locally and sent to the explicitly configured endpoint; the vision
model's text answer is printed to stdout.

Data boundaries (mirroring the video-analysis skill's discipline):

- Local image files leave the machine only as Base64 payloads addressed to
  the explicitly configured endpoint. Nothing is uploaded anywhere else.
- Public http(s) image URLs are handed to the endpoint as-is by default (the
  endpoint fetches them). With --no-pass-url the script downloads the image
  and embeds it instead; script-side downloads refuse private, loopback,
  link-local, reserved, and metadata-service addresses, and re-validate
  every redirect target.
- The API key is read from the environment (or an explicit flag) and is
  never echoed to stdout/stderr, and never written to any file.
- A failed endpoint never fails over to another vendor. The script exits
  with a clear error and the calling agent decides what to do.

Exit codes:
  0  success
  2  configuration error (missing/invalid endpoint, key, or model)
  3  input error (missing file, unsupported format, oversized image,
     blocked URL)
  4  API error (unreachable endpoint, non-2xx response, unusable answer)
"""

from __future__ import annotations

import argparse
import base64
import ipaddress
import json
import os
import socket
import sys
import time
import urllib.error
import urllib.request
from dataclasses import dataclass
from pathlib import Path
from typing import Any, Optional
from urllib.parse import urlparse

EXIT_OK = 0
EXIT_CONFIG = 2
EXIT_INPUT = 3
EXIT_API = 4

PROVENANCE_TAG = "image-reader"
CUSTOM_API_KEY_ENV = "CUSTOM_API_KEY"

DEFAULT_TIMEOUT_SECONDS = 120.0
DEFAULT_MAX_IMAGE_MB = 18.0
DEFAULT_MAX_IMAGES = 8

# Only raster formats with a near-universal image_url contract. SVG is
# deliberately excluded (vector; most vision endpoints reject it).
EXTENSION_MIME = {
    ".png": "image/png",
    ".jpg": "image/jpeg",
    ".jpeg": "image/jpeg",
    ".gif": "image/gif",
    ".webp": "image/webp",
    ".bmp": "image/bmp",
}
SUPPORTED_FORMATS = "PNG, JPEG, GIF, WebP, BMP"

_LOOPBACK_HOSTS = {"127.0.0.1", "localhost", "::1"}

DEFAULT_PROMPTS = {
    "en": (
        "You are the eyes of a text-only AI agent that cannot see images itself. "
        "Describe this image thoroughly and faithfully: overall layout, objects and "
        "people, actions, all visible text (transcribed verbatim), chart or diagram "
        "content, and anything else notable. If something is uncertain or illegible, "
        "say so explicitly. Do not invent content that is not visible."
    ),
    "zh": (
        "你是一个无法直接看到图片的文本 AI 的「眼睛」。请完整、如实地描述这张图片："
        "整体布局、物体与人物、正在发生的动作、所有可见文字（逐字转录）、"
        "图表或图示的内容，以及任何值得注意的细节。不确定或看不清的地方请明确指出，"
        "不要编造图中不存在的内容。"
    ),
}

OCR_PROMPTS = {
    "en": (
        "Extract ALL visible text from this image verbatim, preserving line breaks "
        "and layout as much as possible. Output only the text itself — no "
        "explanation, no summary, no description of the image. If there is no "
        "visible text, output exactly: (no visible text)"
    ),
    "zh": (
        "逐字提取这张图片中的所有可见文字（中文、英文、数字、标点均包含），"
        "尽量保持原有的换行与排版。只输出文字本身，不要解释、不要总结、"
        "不要描述图片内容。图中没有文字时，只输出：（无可见文字）"
    ),
}


class ConfigError(RuntimeError):
    """The vision endpoint, key, or model is missing or invalid (exit 2)."""


class InputError(RuntimeError):
    """An image path/URL/format/size is unusable (exit 3)."""


class ApiError(RuntimeError):
    """The configured vision endpoint failed or answered unusably (exit 4)."""


# ─── Configuration resolution ─────────────────────────────────────


@dataclass(frozen=True)
class VisionConfig:
    """A fully resolved vision endpoint. Never prints the key."""

    base_url: str
    model: str
    api_key: str
    key_source: str

    @property
    def host(self) -> str:
        return urlparse(self.base_url).netloc


def assert_valid_base_url(url: str) -> str:
    """Require HTTPS, except loopback HTTP for local relays/gateways.

    Same rule as the video-analysis skill: API keys must never travel in
    plaintext over the network.
    """
    parsed = urlparse(url)
    if parsed.scheme == "https" and parsed.netloc:
        return url
    if parsed.scheme == "http" and (parsed.hostname or "") in _LOOPBACK_HOSTS:
        return url
    raise ConfigError(
        "The vision endpoint must be https:// (or http:// only for loopback "
        "addresses such as http://127.0.0.1:8080). Got: " + url
    )


def _first_non_empty(*values: Optional[str]) -> str:
    for value in values:
        if value is None:
            continue
        cleaned = value.strip()
        if cleaned:
            return cleaned
    return ""


def resolve_api_key(args: argparse.Namespace, environ: dict[str, Any]) -> tuple[str, str]:
    """Resolve the API key and a human-readable, secret-free source label.

    Order (explicit choice always wins over app injection):
      1. --api-key on the command line
      2. --api-key-env <NAME> (when given explicitly)
      3. CUSTOM_API_KEY (TOKENICODE injects it from Settings → 视频分析)
      4. TOKENICODE_IMAGE_READER_API_KEY
      5. TOKENICODE_VIDEO_ANALYSIS_API_KEY
    """
    if args.api_key and args.api_key.strip():
        return args.api_key.strip(), "command line (--api-key)"
    candidates: list[tuple[str, str]] = []
    if args.api_key_env:
        candidates.append(
            (args.api_key_env, f"environment variable {args.api_key_env} (explicit --api-key-env)")
        )
    candidates.extend(
        [
            (CUSTOM_API_KEY_ENV, f"environment variable {CUSTOM_API_KEY_ENV} (TOKENICODE injection)"),
            (
                "TOKENICODE_IMAGE_READER_API_KEY",
                "environment variable TOKENICODE_IMAGE_READER_API_KEY",
            ),
            (
                "TOKENICODE_VIDEO_ANALYSIS_API_KEY",
                "environment variable TOKENICODE_VIDEO_ANALYSIS_API_KEY (TOKENICODE Settings -> 视频分析)",
            ),
        ]
    )
    for name, source in candidates:
        value = (environ.get(name) or "").strip()
        if value:
            return value, source
    raise ConfigError(
        "No API key found. Provide one via the environment or --api-key. Tried: "
        + ", ".join(name for name, _ in candidates)
        + ". In TOKENICODE you can also save the key once in Settings -> 视频分析; "
        "it is then injected into every session automatically."
    )


def resolve_config(args: argparse.Namespace, environ: dict[str, Any]) -> VisionConfig:
    """Resolve endpoint + model + key, or fail with an actionable message.

    TOKENICODE / Little Claude injects TOKENICODE_VIDEO_ANALYSIS_* into the
    Claude session when the user saved a default multimodal model in
    Settings → 视频分析, so this skill reuses that configuration with zero
    extra setup. Skill-specific TOKENICODE_IMAGE_READER_* vars take
    precedence for power users who want a different endpoint per skill.
    """
    base_url = _first_non_empty(
        args.base_url,
        environ.get("TOKENICODE_IMAGE_READER_BASE_URL"),
        environ.get("TOKENICODE_VIDEO_ANALYSIS_BASE_URL"),
    )
    model = _first_non_empty(
        args.model,
        environ.get("TOKENICODE_IMAGE_READER_MODEL"),
        environ.get("TOKENICODE_VIDEO_ANALYSIS_MODEL"),
    )
    missing = []
    if not base_url:
        missing.append(
            "API endpoint (Base URL): pass --base-url, or set "
            "TOKENICODE_IMAGE_READER_BASE_URL, or save it in TOKENICODE Settings -> 视频分析"
        )
    if not model:
        missing.append(
            "vision model name: pass --model, or set TOKENICODE_IMAGE_READER_MODEL, "
            "or save it in TOKENICODE Settings → 视频分析"
        )
    if missing:
        raise ConfigError(
            "Missing vision provider configuration:\n  - "
            + "\n  - ".join(missing)
            + "\nAsk the user for an OpenAI-compatible vision endpoint and model, "
            "or configure them once in TOKENICODE Settings -> 视频分析."
        )
    base_url = assert_valid_base_url(base_url)
    api_key, key_source = resolve_api_key(args, environ)
    return VisionConfig(base_url=base_url, model=model, api_key=api_key, key_source=key_source)


# ─── Image loading ────────────────────────────────────────────────


def sniff_mime(raw: bytes) -> Optional[str]:
    """Identify the image format from magic bytes."""
    if raw.startswith(b"\x89PNG\r\n\x1a\n"):
        return "image/png"
    if raw.startswith(b"\xff\xd8\xff"):
        return "image/jpeg"
    if raw[:6] in (b"GIF87a", b"GIF89a"):
        return "image/gif"
    if raw[:4] == b"RIFF" and raw[8:12] == b"WEBP":
        return "image/webp"
    if raw.startswith(b"BM"):
        return "image/bmp"
    return None


def detect_mime(path: Path, raw: bytes) -> str:
    # Trust the payload's magic bytes over the extension: misnamed screenshots
    # are common, and the MIME label must match the bytes the endpoint decodes.
    sniffed = sniff_mime(raw)
    if sniffed:
        return sniffed
    mime = EXTENSION_MIME.get(path.suffix.lower())
    if mime:
        return mime
    raise InputError(
        f"Unsupported image type for {path.name!r} (extension "
        f"{path.suffix or '(none)'!r}, content not recognized). "
        f"Supported formats: {SUPPORTED_FORMATS}."
    )


def data_url_from_bytes(mime: str, raw: bytes) -> str:
    return f"data:{mime};base64," + base64.standard_b64encode(raw).decode("ascii")


def assert_public_http_url(url: str) -> None:
    """SSRF guard for script-side downloads: public addresses only."""
    parsed = urlparse(url)
    if parsed.scheme not in ("http", "https"):
        raise InputError(f"Only http(s) image URLs are supported, got: {url}")
    host = parsed.hostname
    if not host:
        raise InputError(f"Image URL has no host: {url}")
    default_port = 443 if parsed.scheme == "https" else 80
    try:
        infos = socket.getaddrinfo(host, parsed.port or default_port, proto=socket.IPPROTO_TCP)
    except socket.gaierror as exc:
        raise InputError(f"Cannot resolve image URL host {host!r}: {exc}") from exc
    for info in infos:
        ip = ipaddress.ip_address(info[4][0].split("%")[0])
        if (
            ip.is_private
            or ip.is_loopback
            or ip.is_link_local
            or ip.is_reserved
            or ip.is_multicast
            or ip.is_unspecified
        ):
            raise InputError(
                f"Refusing to fetch image from {host!r}: it resolves to the "
                f"non-public address {ip}. Local, private, and metadata-service "
                "addresses are blocked. Provide a local file path instead."
            )


class _PublicRedirectHandler(urllib.request.HTTPRedirectHandler):
    """Re-validate every redirect target against the SSRF guard."""

    def redirect_request(self, req, fp, code, msg, headers, newurl):  # type: ignore[override]
        assert_public_http_url(newurl)
        return super().redirect_request(req, fp, code, msg, headers, newurl)


def download_public_image(url: str, *, max_bytes: int, timeout: float) -> bytes:
    assert_public_http_url(url)
    request = urllib.request.Request(
        url, headers={"User-Agent": "Mozilla/5.0 (TOKENICODE image-reader skill)"}
    )
    opener = urllib.request.build_opener(_PublicRedirectHandler)
    try:
        with opener.open(request, timeout=timeout) as response:
            chunks: list[bytes] = []
            total = 0
            while True:
                chunk = response.read(65536)
                if not chunk:
                    break
                total += len(chunk)
                if total > max_bytes:
                    raise InputError(
                        f"Remote image from {urlparse(url).netloc} exceeds the "
                        f"{max_bytes}-byte limit. Download it locally and pass the "
                        "file path instead."
                    )
                chunks.append(chunk)
    except urllib.error.URLError as exc:
        raise InputError(f"Failed to download image URL {url}: {exc.reason}") from exc
    return b"".join(chunks)


def build_image_part(
    source: str, args: argparse.Namespace
) -> tuple[dict[str, Any], dict[str, Any]]:
    """Turn one CLI image argument into a Chat Completions image_url part.

    Returns (content_part, provenance_info). Three input kinds:
      - "data:image/...;base64,..."  → passed through unchanged
      - "http(s)://..."              → passed through by default (the vision
        endpoint fetches it); downloaded + embedded with --no-pass-url
      - anything else               → treated as a local file path
    """
    max_bytes = int(args.max_image_mb * 1024 * 1024)

    if source.startswith("data:"):
        lowered = source.lower()
        if not lowered.startswith("data:image/") or ";base64," not in lowered[:64]:
            raise InputError(
                "data: inputs must look like data:image/png;base64,<payload>."
            )
        mime = lowered[len("data:") : lowered.index(";")]
        return (
            {"type": "image_url", "image_url": {"url": source}},
            {"source": "<inline data url>", "kind": "data_url", "mime": mime, "bytes": None},
        )

    if source.startswith("http://") or source.startswith("https://"):
        if args.pass_url:
            return (
                {"type": "image_url", "image_url": {"url": source}},
                {"source": source, "kind": "http_url_passthrough", "mime": None, "bytes": None},
            )
        raw = download_public_image(source, max_bytes=max_bytes, timeout=args.timeout)
        mime = sniff_mime(raw)
        if mime is None:
            raise InputError(
                f"The URL {source} did not serve a recognized image format "
                f"({SUPPORTED_FORMATS})."
            )
        return (
            {"type": "image_url", "image_url": {"url": data_url_from_bytes(mime, raw)}},
            {"source": source, "kind": "http_url_embedded", "mime": mime, "bytes": len(raw)},
        )

    path = Path(os.path.expanduser(source))
    if not path.exists():
        raise InputError(f"Image file not found: {path}")
    if path.is_dir():
        raise InputError(f"Expected an image file but got a directory: {path}")
    try:
        size = path.stat().st_size
    except OSError as exc:
        raise InputError(f"Cannot access image file {path}: {exc}") from exc
    if size > max_bytes:
        raise InputError(
            f"Image {path.name} is {size} bytes, above the {max_bytes}-byte limit "
            f"(--max-image-mb {args.max_image_mb:g}). Resize it before retrying."
        )
    try:
        raw = path.read_bytes()
    except OSError as exc:
        raise InputError(f"Cannot read image file {path}: {exc}") from exc
    mime = detect_mime(path, raw)
    return (
        {"type": "image_url", "image_url": {"url": data_url_from_bytes(mime, raw)}},
        {"source": str(path), "kind": "local_file", "mime": mime, "bytes": size},
    )


# ─── Prompt construction ──────────────────────────────────────────


def _image_label(source: str, index: int) -> str:
    if source.startswith("data:"):
        return f"<inline image {index}>"
    if source.startswith("http://") or source.startswith("https://"):
        return source
    return Path(os.path.expanduser(source)).name or source


def build_prompt(args: argparse.Namespace, sources: list[str]) -> str:
    if args.prompt and args.prompt.strip():
        text = args.prompt.strip()
    elif args.ocr:
        text = OCR_PROMPTS[args.lang]
    else:
        text = DEFAULT_PROMPTS[args.lang]
    if len(sources) > 1:
        listing = "\n".join(
            f"Image {index + 1}/{len(sources)}: {_image_label(source, index + 1)}"
            for index, source in enumerate(sources)
        )
        text += (
            f"\n\nThis request contains {len(sources)} images:\n{listing}\n"
            "Structure your answer with one section per image in the same order, "
            'headed "## Image N — <name>".'
        )
    return text


def build_content(args: argparse.Namespace, sources: list[str]) -> tuple[list[dict], list[dict]]:
    parts: list[dict[str, Any]] = [{"type": "text", "text": build_prompt(args, sources)}]
    infos: list[dict[str, Any]] = []
    for source in sources:
        part, info = build_image_part(source, args)
        if args.detail:
            part["image_url"]["detail"] = args.detail
        parts.append(part)
        infos.append(info)
    return parts, infos


# ─── Vision API call ──────────────────────────────────────────────


def _error_detail(body: str) -> str:
    body = body.strip()
    return f" Endpoint said: {body[:400]}" if body else ""


def _http_post_json(url: str, headers: dict[str, str], payload: dict, timeout: float) -> Any:
    """POST JSON and parse the JSON response. Indirection point for tests."""
    request = urllib.request.Request(
        url, data=json.dumps(payload).encode("utf-8"), headers=headers, method="POST"
    )
    try:
        with urllib.request.urlopen(request, timeout=timeout) as response:
            return json.loads(response.read().decode("utf-8", "replace"))
    except urllib.error.HTTPError as exc:
        body = ""
        try:
            body = exc.read(800).decode("utf-8", "replace")
        except Exception:
            pass
        if exc.code in (401, 403):
            raise ConfigError(
                f"The vision endpoint rejected the API key (HTTP {exc.code}). "
                "Verify the key with the user; it was read from "
                "{key_source}.".format(key_source=headers.get("X-Key-Source", "the environment"))
                + _error_detail(body)
            ) from exc
        raise ApiError(
            f"The vision endpoint returned HTTP {exc.code}.{_error_detail(body)}"
        ) from exc
    except urllib.error.URLError as exc:
        raise ApiError(f"Cannot reach the vision endpoint {url}: {exc.reason}") from exc
    except (TimeoutError, socket.timeout) as exc:
        raise ApiError(f"The vision endpoint timed out after {timeout:.0f}s.") from exc


def extract_completion_text(data: Any) -> str:
    choices = data.get("choices") if isinstance(data, dict) else None
    if not isinstance(choices, list) or not choices:
        raise ApiError("The vision endpoint returned no choices.")
    message = choices[0].get("message") if isinstance(choices[0], dict) else None
    content = message.get("content") if isinstance(message, dict) else None
    if isinstance(content, str) and content.strip():
        return content
    if isinstance(content, list):  # some providers return an array of text parts
        text = "".join(
            part.get("text", "")
            for part in content
            if isinstance(part, dict) and part.get("type") in (None, "text")
        ).strip()
        if text:
            return text
    raise ApiError("The vision model returned no usable text content.")


def call_vision_api(
    config: VisionConfig,
    content: list[dict],
    *,
    timeout: float,
    max_tokens: Optional[int],
) -> str:
    url = config.base_url.rstrip("/") + "/chat/completions"
    payload: dict[str, Any] = {
        "model": config.model,
        "messages": [{"role": "user", "content": content}],
    }
    if max_tokens and max_tokens > 0:
        payload["max_tokens"] = max_tokens
    data = _http_post_json(
        url,
        {
            "Authorization": f"Bearer {config.api_key}",
            "Content-Type": "application/json",
        },
        payload,
        timeout,
    )
    return extract_completion_text(data)


# ─── CLI ──────────────────────────────────────────────────────────


def build_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(
        prog="describe_image.py",
        description=(
            "Let a text-only model read images: send local image files or public "
            "image URLs to a vision-capable model through an OpenAI-compatible "
            "endpoint and print the recognition result."
        ),
    )
    parser.add_argument("images", nargs="+", metavar="IMAGE",
                        help="local image path, public http(s) image URL, or data:image/...;base64 URL")
    parser.add_argument("--prompt", help="custom instruction to the vision model (overrides --ocr/--lang defaults)")
    parser.add_argument("--ocr", action="store_true", help="extract visible text verbatim instead of describing")
    parser.add_argument("--lang", choices=("en", "zh"), default="en",
                        help="language of the default prompt and expected answer (default: en)")
    parser.add_argument("--detail", choices=("auto", "low", "high"),
                        help="image_url detail level hint (default: omit, let the endpoint decide)")
    parser.add_argument("--json", action="store_true", help="print a machine-readable JSON result")
    parser.add_argument("--no-pass-url", dest="pass_url", action="store_false",
                        help="download http(s) image URLs and embed them instead of handing the URL to the endpoint")
    parser.add_argument("--base-url", help="OpenAI-compatible base URL (overrides env)")
    parser.add_argument("--model", help="vision model name (overrides env)")
    parser.add_argument("--api-key", help="API key value (prefer the environment; never persisted)")
    parser.add_argument("--api-key-env", help=f"name of the env var holding the key (default: {CUSTOM_API_KEY_ENV})")
    parser.add_argument("--timeout", type=float, default=DEFAULT_TIMEOUT_SECONDS,
                        help=f"network timeout in seconds (default: {DEFAULT_TIMEOUT_SECONDS:g})")
    parser.add_argument("--max-image-mb", type=float, default=DEFAULT_MAX_IMAGE_MB,
                        help=f"per-image size cap in MB (default: {DEFAULT_MAX_IMAGE_MB:g})")
    parser.add_argument("--max-images", type=int, default=DEFAULT_MAX_IMAGES,
                        help=f"maximum images per request (default: {DEFAULT_MAX_IMAGES})")
    parser.add_argument("--max-tokens", type=int, default=None,
                        help="optional max_tokens cap for the vision model response")
    return parser


def main(argv: Optional[list[str]] = None, environ: Optional[dict[str, Any]] = None) -> int:
    args = build_parser().parse_args(argv)
    env = os.environ if environ is None else environ
    try:
        if len(args.images) > args.max_images:
            raise InputError(
                f"Got {len(args.images)} images, above --max-images {args.max_images}. "
                "Split the request into smaller batches."
            )
        config = resolve_config(args, env)
        content, infos = build_content(args, args.images)

        started = time.monotonic()
        description = call_vision_api(
            config, content, timeout=args.timeout, max_tokens=args.max_tokens
        )
        elapsed = time.monotonic() - started

        # Provenance goes to stderr so stdout stays clean text for the agent.
        print(
            f"[{PROVENANCE_TAG}] model={config.model} endpoint={config.host} "
            f"images={len(infos)} key_from={config.key_source} elapsed={elapsed:.1f}s",
            file=sys.stderr,
        )

        if args.json:
            result = {
                "ok": True,
                "description": description,
                "images": infos,
                "model": config.model,
                "endpoint_host": config.host,
                "elapsed_seconds": round(elapsed, 2),
            }
            print(json.dumps(result, ensure_ascii=False, indent=2))
        else:
            print(description)
        return EXIT_OK
    except ConfigError as exc:
        print(f"error: {exc}", file=sys.stderr)
        return EXIT_CONFIG
    except InputError as exc:
        print(f"error: {exc}", file=sys.stderr)
        return EXIT_INPUT
    except ApiError as exc:
        print(f"error: {exc}", file=sys.stderr)
        return EXIT_API


if __name__ == "__main__":
    sys.exit(main())
