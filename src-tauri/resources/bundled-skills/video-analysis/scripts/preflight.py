"""Report whether the video-analysis skill can run on this machine.

This check is read-only. It does not install software, start services, validate
API-key contents, download models, or contact remote providers unless an
explicit capability probe is requested for a custom endpoint.
"""

from __future__ import annotations

import argparse
import importlib.util
import json
import os
import shutil
import sys
from pathlib import Path
from typing import Any

import bundled_env
import providers as provider_layer

# Make the bundled ffmpeg/ffprobe discoverable before any PATH lookup below.
bundled_env.activate()


def build_report(
    *,
    which=shutil.which,
    find_spec=importlib.util.find_spec,
    environ=os.environ,
    vision_provider: str = provider_layer.NONE,
    synthesis_provider: str = provider_layer.NONE,
    custom_base_url: str | None = None,
    custom_api_key_env: str = provider_layer.DEFAULT_CUSTOM_API_KEY_ENV,
    custom_probe_model: str | None = None,
) -> dict[str, Any]:
    ffmpeg = which("ffmpeg")
    ffprobe = which("ffprobe")
    yt_dlp = which("yt-dlp")
    dependencies = {
        "openai": find_spec("openai") is not None,
        "faster_whisper": find_spec("faster_whisper") is not None,
        "requests": find_spec("requests") is not None,
    }
    credentials = {
        "openai_api_key_present": bool(environ.get(provider_layer.API_KEY_ENV[provider_layer.OPENAI])),
        "xai_api_key_present": bool(environ.get(provider_layer.API_KEY_ENV[provider_layer.XAI])),
        "deepseek_api_key_present": bool(environ.get(provider_layer.API_KEY_ENV[provider_layer.DEEPSEEK])),
        "custom_api_key_present": bool(environ.get(custom_api_key_env)),
    }
    media_ready = bool(ffmpeg and ffprobe)
    asr_ready = media_ready and dependencies["faster_whisper"]

    capability_matrix: dict[str, Any] = {}
    for provider in (provider_layer.OPENAI, provider_layer.XAI, provider_layer.DEEPSEEK):
        capability_matrix[provider] = {
            "vision": provider_layer.provider_readiness(
                provider=provider,
                stage=provider_layer.VISION,
                find_spec=find_spec,
                environ=environ,
            ),
            "synthesis": provider_layer.provider_readiness(
                provider=provider,
                stage=provider_layer.SYNTHESIS,
                find_spec=find_spec,
                environ=environ,
            ),
        }

    def requested_readiness(stage: str, provider: str) -> dict[str, Any]:
        readiness = provider_layer.provider_readiness(
            provider=provider,
            stage=stage,
            find_spec=find_spec,
            environ=environ,
            api_key_env=custom_api_key_env,
            base_url=custom_base_url,
        )
        if provider == provider_layer.CUSTOM and custom_probe_model and custom_base_url:
            readiness = dict(readiness)
            readiness["probed_model"] = custom_probe_model
            readiness["image_support"] = provider_layer.probe_image_support(
                custom_base_url,
                custom_probe_model,
                environ.get(custom_api_key_env, ""),
            )
        return readiness

    requested = {
        "vision": requested_readiness(provider_layer.VISION, vision_provider),
        "synthesis": requested_readiness(provider_layer.SYNTHESIS, synthesis_provider),
    }

    bundled = bundled_env.bundled_status()
    offline_hint = ""
    if bundled["wheelhouse_wheels"]:
        skill_root = Path(bundled["skill_root"])
        offline_hint = (
            f" (offline: pip install --no-index --find-links \"{skill_root / 'wheelhouse'}\" -r \"{skill_root / 'requirements.txt'}\")"
        )

    recommendations: list[str] = []
    if not media_ready:
        recommendations.append(
            "Install ffmpeg and ensure both ffmpeg and ffprobe are on PATH "
            "(or place the skill's bundled binaries under its bin/ directory)."
        )
    if not dependencies["requests"]:
        recommendations.append(f"Install Python dependencies: pip install -r requirements.txt{offline_hint}")
    if not dependencies["faster_whisper"]:
        recommendations.append(
            f"Install faster-whisper for timestamped speech transcription, or use --skip-asr.{offline_hint}"
        )
    if not yt_dlp:
        recommendations.append(
            f"Optional: install yt-dlp (pip install yt-dlp{offline_hint}) to fetch public videos from platform pages with --allow-platform."
        )
    for stage_name, readiness in requested.items():
        if readiness.get("supported") and not readiness.get("ready") and readiness.get("reason"):
            recommendations.append(f"{stage_name}: {readiness['reason']}")
        if readiness.get("image_support") is False:
            recommendations.append(
                f"{stage_name}: the probed custom model does not advertise image input; choose a vision-capable model."
            )

    return {
        "python": {"version": sys.version.split()[0], "executable": sys.executable},
        "executables": {"ffmpeg": ffmpeg, "ffprobe": ffprobe, "yt_dlp": yt_dlp},
        "bundled": bundled,
        "python_dependencies": dependencies,
        "credentials": credentials,
        "provider_capabilities": capability_matrix,
        "requested_pipeline": {
            "vision_provider": vision_provider,
            "synthesis_provider": synthesis_provider,
            "custom_base_url": custom_base_url,
            "vision": requested["vision"],
            "synthesis": requested["synthesis"],
        },
        "capabilities": {
            "offline_media_pipeline": media_ready,
            "asr": asr_ready,
            "platform_extraction": bool(ffmpeg and yt_dlp),
            "requested_vision_ready": vision_provider != provider_layer.NONE and bool(requested["vision"].get("ready")),
            "requested_synthesis_ready": synthesis_provider != provider_layer.NONE and bool(requested["synthesis"].get("ready")),
            "deterministic_report": True,
        },
        "recommendations": recommendations,
    }


def main() -> int:
    # Windows consoles often default to GBK and mangle Chinese characters in
    # reported paths; the JSON report is UTF-8 regardless of console codepage.
    if hasattr(sys.stdout, "reconfigure"):
        try:
            sys.stdout.reconfigure(encoding="utf-8", errors="replace")
        except (ValueError, OSError):
            pass
    parser = argparse.ArgumentParser(description="Check video-analysis skill prerequisites.")
    parser.add_argument("--json", action="store_true", help="Print a JSON diagnostic report.")
    parser.add_argument(
        "--vision-provider",
        default=provider_layer.NONE,
        choices=provider_layer.VISION_PROVIDERS,
        help="Provider to validate for frame interpretation.",
    )
    parser.add_argument(
        "--synthesis-provider",
        default=provider_layer.NONE,
        choices=provider_layer.SYNTHESIS_PROVIDERS,
        help="Provider to validate for text report synthesis.",
    )
    parser.add_argument("--custom-base-url", help="Endpoint to validate for provider 'custom'.")
    parser.add_argument(
        "--custom-api-key-env",
        default=provider_layer.DEFAULT_CUSTOM_API_KEY_ENV,
        help="Environment variable holding the custom endpoint API key.",
    )
    parser.add_argument(
        "--custom-probe-model",
        help="Optional model name; queries the custom endpoint's model metadata for image-input support.",
    )
    args = parser.parse_args()
    report = build_report(
        vision_provider=args.vision_provider,
        synthesis_provider=args.synthesis_provider,
        custom_base_url=args.custom_base_url,
        custom_api_key_env=args.custom_api_key_env,
        custom_probe_model=args.custom_probe_model,
    )
    if args.json:
        print(json.dumps(report, ensure_ascii=False, indent=2))
    else:
        print("Video-analysis preflight")
        for capability, ready in report["capabilities"].items():
            print(f"- {capability}: {'ready' if ready else 'not ready'}")
        for recommendation in report["recommendations"]:
            print(f"  * {recommendation}")
    return 0 if report["capabilities"]["offline_media_pipeline"] else 1


if __name__ == "__main__":
    raise SystemExit(main())
