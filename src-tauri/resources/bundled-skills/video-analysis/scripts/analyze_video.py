"""Analyze an authorized local video or a public direct-media URL.

The pipeline is intentionally staged. Media decoding can be verified offline; speech
transcription and remote semantic analysis only run when their dependencies and
explicitly selected provider credentials are available.
"""

from __future__ import annotations

import argparse
import dataclasses
import json
import math
import os
import shutil
import subprocess
import sys
import time
from collections import defaultdict
from concurrent.futures import ThreadPoolExecutor
from contextlib import contextmanager
from pathlib import Path
from typing import Any, Callable, Iterable

import bundled_env
import platform_download
import providers as provider_layer
import acceleration
from safe_download import (
    DEFAULT_MAX_BYTES,
    DirectMediaTypeError,
    DownloadLimitError,
    DownloadSafetyError,
    download_public_video,
)

# Prefer the ffmpeg/ffprobe bundled in the skill's bin/ directory; machines
# with a system installation are unaffected when bin/ is absent.
bundled_env.activate()

WINDOW_SECONDS = 300


class PipelineError(RuntimeError):
    """Raised when a mandatory stage of the requested pipeline cannot complete."""


def write_json(path: Path, value: Any) -> None:
    path.write_text(json.dumps(value, ensure_ascii=False, indent=2), encoding="utf-8")


@contextmanager
def _timed(durations: dict[str, float], name: str) -> Any:
    """Record the wall-clock duration of a pipeline stage into *durations*."""
    start = time.perf_counter()
    try:
        yield
    finally:
        durations[name] = round(time.perf_counter() - start, 3)


def run_command(command: list[str], *, error_context: str) -> subprocess.CompletedProcess[str]:
    try:
        return subprocess.run(command, check=True, text=True, capture_output=True)
    except FileNotFoundError as exc:
        raise PipelineError(f"Missing required executable: {command[0]}") from exc
    except subprocess.CalledProcessError as exc:
        detail = exc.stderr.strip() or exc.stdout.strip() or "no diagnostic output"
        raise PipelineError(f"{error_context}: {detail}") from exc


def probe_video(source: Path) -> dict[str, Any]:
    result = run_command(
        [
            "ffprobe",
            "-v",
            "error",
            "-show_entries",
            "format=duration,format_name,size:stream=index,codec_type,codec_name,width,height",
            "-of",
            "json",
            str(source),
        ],
        error_context="ffprobe could not read the source as a video",
    )
    try:
        metadata = json.loads(result.stdout)
        duration = float(metadata["format"]["duration"])
    except (KeyError, TypeError, ValueError, json.JSONDecodeError) as exc:
        raise PipelineError("ffprobe did not return a valid video duration.") from exc
    if not math.isfinite(duration) or duration <= 0:
        raise PipelineError("The source video has no usable positive duration.")
    if not any(stream.get("codec_type") == "video" for stream in metadata.get("streams", [])):
        raise PipelineError("The source has no video stream.")
    return {"duration_seconds": duration, "ffprobe": metadata}


def extract_audio(source: Path, audio_path: Path) -> None:
    run_command(
        [
            "ffmpeg",
            "-y",
            "-i",
            str(source),
            "-vn",
            "-ac",
            "1",
            "-ar",
            "16000",
            "-c:a",
            "pcm_s16le",
            str(audio_path),
        ],
        error_context="ffmpeg could not extract a 16 kHz mono WAV",
    )


def extract_frames(
    source: Path,
    frames_dir: Path,
    *,
    interval_seconds: float,
    duration_seconds: float,
) -> list[dict[str, Any]]:
    if interval_seconds <= 0:
        raise ValueError("frame_interval must be positive")
    frames_dir.mkdir(parents=True, exist_ok=True)
    pattern = frames_dir / "frame_%06d.jpg"
    run_command(
        [
            "ffmpeg",
            "-y",
            "-i",
            str(source),
            "-vf",
            f"fps=1/{interval_seconds},scale=min(1280\,iw):-2",
            "-q:v",
            "3",
            str(pattern),
        ],
        error_context="ffmpeg could not extract video key frames",
    )
    paths = sorted(frames_dir.glob("frame_*.jpg"))
    if not paths:
        raise PipelineError("ffmpeg did not produce any frames.")
    frames: list[dict[str, Any]] = []
    for index, path in enumerate(paths):
        frames.append(
            {
                "timestamp_seconds": round(min(index * interval_seconds, duration_seconds), 3),
                "path": str(path),
            }
        )
    return frames


ASR_WORKER_PATH = Path(__file__).resolve().parent / "asr_worker.py"


def run_asr_subprocess(
    audio_path: Path,
    *,
    model: str,
    language: str | None,
    duration_seconds: float,
    accel_stats: dict[str, Any] | None = None,
) -> list[dict[str, Any]]:
    """Run ASR in a crash-isolated subprocess; raise RuntimeError on any failure.

    faster-whisper loads several native OpenMP runtimes (ctranslate2/numpy-MKL
    plus onnxruntime's VAD) whose duplicates abort the process natively — an
    abort Python cannot catch, which used to kill this pipeline. Running the
    worker (scripts/asr_worker.py) as a separate process confines any native
    abort to the child and converts it into a reportable, nonfatal failure
    here. The worker also sets the OpenMP compatibility environment before its
    first import, which an in-process setdefault could never achieve.

    On success returns the transcript segments and records device/compute_type
    into *accel_stats* when a dict is supplied.
    """
    env = dict(os.environ)
    env.setdefault("KMP_DUPLICATE_LIB_OK", "TRUE")
    env.setdefault("OMP_WAIT_POLICY", "PASSIVE")

    command = [
        sys.executable, "-X", "utf8", str(ASR_WORKER_PATH),
        "--audio-path", str(audio_path),
        "--model", model,
    ]
    if language:
        command += ["--language", language]

    timeout = float(os.environ.get("TOKENICODE_VIDEO_ASR_TIMEOUT_SECONDS") or 0)
    if timeout <= 0:
        # Model load (~30-90s cold) plus int8 CPU decoding at worst a few times
        # realtime; generous because the audio lane overlaps other work.
        timeout = max(120.0, 90.0 + 5.0 * duration_seconds)

    try:
        completed = subprocess.run(
            command,
            capture_output=True,
            text=True,
            encoding="utf-8",
            errors="replace",
            timeout=timeout,
            env=env,
        )
    except subprocess.TimeoutExpired as exc:
        raise RuntimeError(f"ASR worker timed out after {timeout:.0f}s") from exc

    # Contract: stdout carries exactly one JSON line. Parse it first, look at
    # the exit code second — a native crash exits with an arbitrary code and
    # no JSON, which is exactly the case parse-first disambiguates.
    payload: dict[str, Any] | None = None
    stdout = (completed.stdout or "").strip()
    if stdout:
        try:
            parsed = json.loads(stdout.splitlines()[-1])
            if isinstance(parsed, dict):
                payload = parsed
        except json.JSONDecodeError:
            payload = None

    if payload is None:
        stderr_tail = (completed.stderr or "").strip()[-1500:]
        raise RuntimeError(
            f"ASR worker crashed (exit code {completed.returncode}); "
            f"stderr tail: {stderr_tail or 'no output'}"
        )
    if not payload.get("ok"):
        error_type = payload.get("error_type", "Unknown")
        raise RuntimeError(f"{payload.get('error', 'ASR worker failed')} ({error_type})")

    if accel_stats is not None:
        if payload.get("device"):
            accel_stats["asr_device"] = payload["device"]
        if payload.get("compute_type"):
            accel_stats["asr_compute_type"] = payload["compute_type"]
    return payload.get("segments", [])


def analyze_frame_batches(
    frames: list[dict[str, Any]],
    *,
    batch_size: int,
    vision_provider: provider_layer.VisionProvider,
    concurrency: int = 1,
) -> list[dict[str, Any]]:
    """Send bounded, timestamp-labelled JPEG batches to the selected vision provider.

    With *concurrency* > 1 the batches are dispatched on a thread pool.
    ``pool.map`` yields results in submission order regardless of completion
    order, so the observation list always matches the frame order without any
    index bookkeeping. The shared OpenAI client underneath the provider is
    documented thread-safe, so no provider-layer change is needed.
    """
    if batch_size <= 0:
        raise ValueError("vision_batch_size must be positive")
    if concurrency <= 0:
        raise ValueError("vision_concurrency must be positive")

    batches = [frames[offset : offset + batch_size] for offset in range(0, len(frames), batch_size)]

    def _process_batch(batch: list[dict[str, Any]]) -> list[dict[str, Any]]:
        try:
            batch_observations = vision_provider.analyze_batch(batch)
        except Exception as exc:  # Preserve partial results and let the caller report the failed batch.
            return [
                {
                    "batch_error": str(exc),
                    "batch_start_seconds": batch[0]["timestamp_seconds"],
                    "batch_end_seconds": batch[-1]["timestamp_seconds"],
                }
            ]
        # Pipeline-owned evidence rule: source timestamps always override model output.
        for frame, observation in zip(batch, batch_observations, strict=True):
            observation["timestamp_seconds"] = frame["timestamp_seconds"]
            if "source_timestamps" in frame:  # Grid montage coverage (acceleration path)
                observation["source_timestamps"] = frame["source_timestamps"]
        return batch_observations

    observations: list[dict[str, Any]] = []
    if concurrency <= 1 or len(batches) <= 1:
        for batch in batches:
            observations.extend(_process_batch(batch))
        return observations

    with ThreadPoolExecutor(max_workers=max(1, min(concurrency, len(batches)))) as pool:
        for batch_observations in pool.map(_process_batch, batches):
            observations.extend(batch_observations)
    return observations


def build_timeline(
    *,
    duration_seconds: float,
    transcript: list[dict[str, Any]],
    observations: list[dict[str, Any]],
    window_seconds: int = WINDOW_SECONDS,
) -> list[dict[str, Any]]:
    buckets: dict[int, dict[str, list[Any]]] = defaultdict(lambda: {"transcript": [], "visual": []})
    for item in transcript:
        buckets[int(item["start_seconds"] // window_seconds)]["transcript"].append(item)
    for item in observations:
        if "timestamp_seconds" in item:
            buckets[int(float(item["timestamp_seconds"]) // window_seconds)]["visual"].append(item)

    timeline = []
    total_windows = max(1, math.ceil(duration_seconds / window_seconds))
    for index in range(total_windows):
        start = index * window_seconds
        timeline.append(
            {
                "start_seconds": start,
                "end_seconds": round(min((index + 1) * window_seconds, duration_seconds), 3),
                "transcript_segments": buckets[index]["transcript"],
                "visual_observations": buckets[index]["visual"],
            }
        )
    return timeline


def local_fallback_analysis(
    *,
    source_label: str,
    duration_seconds: float,
    timeline: list[dict[str, Any]],
    limitations: list[str],
) -> dict[str, Any]:
    return {
        "title": f"Video analysis: {source_label}",
        "summary": "Semantic summary was not generated because one or more interpretation stages were skipped or unavailable.",
        "chapters": [
            {
                "start_seconds": item["start_seconds"],
                "end_seconds": item["end_seconds"],
                "title": f"Time window {item['start_seconds']:.0f}–{item['end_seconds']:.0f}s",
                "summary": "See the aligned transcript segments and visual observations in timeline.json.",
            }
            for item in timeline
        ],
        "key_moments": [],
        "duration_seconds": round(duration_seconds, 3),
        "limitations": limitations,
        "timeline": timeline,
    }


def _compact_timeline_text(timeline: list[dict[str, Any]], max_scene_chars: int = 200) -> str:
    """Convert rich timeline JSON into a dense text block suitable for synthesis.

    The synthesis model only needs to understand the video's content to produce a
    title, summary, chapters, and key moments.  Sending the full verbose JSON
    (with ``language_probability``, ``actions`` arrays, ``important_objects``
    arrays, etc.) wastes tokens and causes timeouts on large videos.  This
    function strips the structural overhead and keeps only the evidence the model
    actually needs.
    """
    parts: list[str] = []
    for window in timeline:
        start_s = window["start_seconds"]
        end_s = window["end_seconds"]
        duration = end_s - start_s
        parts.append(
            f"\n=== Window {start_s:.0f}s–{end_s:.0f}s "
            f"({int(duration // 60)}m {int(duration % 60)}s) ==="
        )

        # Transcript: compact timestamped lines
        segments = window.get("transcript_segments", [])
        if segments:
            parts.append("\n[Transcript]")
            for seg in segments:
                parts.append(f"  [{seg['start_seconds']:.1f}s] {seg['text']}")

        # Visual: scene descriptions only, mark key moments
        observations = window.get("visual_observations", [])
        if observations:
            parts.append("\n[Visual Timeline]")
            for obs in observations:
                ts = obs.get("timestamp_seconds", 0)
                scene = obs.get("scene", "")
                if len(scene) > max_scene_chars:
                    scene = scene[: max_scene_chars - 3] + "..."
                marker = " ★" if obs.get("is_key_moment") else ""
                parts.append(f"  [{ts:.0f}s]{marker} {scene}")

    return "\n".join(parts)


def synthesize_analysis(
    *,
    source_label: str,
    duration_seconds: float,
    timeline: list[dict[str, Any]],
    limitations: list[str],
    evidence_modalities: list[str],
    synthesis_provider: provider_layer.SynthesisProvider,
) -> dict[str, Any]:
    compact_text = _compact_timeline_text(timeline)
    payload = {
        "source_label": source_label,
        "duration_seconds": duration_seconds,
        "timeline_text": compact_text,
        "known_limitations": limitations,
        "available_evidence_modalities": evidence_modalities,
    }
    report = synthesis_provider.synthesize(payload)
    report["duration_seconds"] = round(duration_seconds, 3)
    report["timeline"] = timeline
    report["limitations"] = list(dict.fromkeys([*limitations, *report.get("limitations", [])]))
    return report


def render_markdown(analysis: dict[str, Any], source_label: str) -> str:
    lines = [f"# {analysis.get('title', 'Video analysis')}", "", f"**Source:** `{source_label}`"]
    lines += ["", "## Summary", analysis.get("summary", "No semantic summary was produced.")]
    lines += ["", "## Chapters"]
    for chapter in analysis.get("chapters", []):
        lines.append(
            f"- **{chapter.get('start_seconds', 0):.0f}s–{chapter.get('end_seconds', 0):.0f}s — {chapter.get('title', 'Untitled')}**: {chapter.get('summary', '')}"
        )
    lines += ["", "## Key moments"]
    moments = analysis.get("key_moments", [])
    if moments:
        for moment in moments:
            lines.append(f"- **{moment.get('timestamp_seconds', 0):.0f}s** — {moment.get('description', '')}")
    else:
        lines.append("- No verified key moments were generated.")
    lines += ["", "## Limitations"]
    for limitation in analysis.get("limitations", []):
        lines.append(f"- {limitation}")
    lines += ["", "## Provenance and data handling"]
    acquisition = analysis.get("provenance", {}).get("source_acquisition", {})
    if acquisition.get("method") == "platform_extraction":
        lines.append(
            f"- source: platform page extracted with `{acquisition.get('tool', 'yt-dlp')}`; no credentials sent."
        )
    elif acquisition.get("method"):
        lines.append(f"- source acquisition: `{acquisition['method']}`; no credentials sent.")
    stages = analysis.get("provenance", {}).get("stages", {})
    for stage_name in ("asr", "vision", "synthesis"):
        stage = stages.get(stage_name, {})
        label = stage.get("provider", stage.get("requested", "none"))
        model = stage.get("model", "")
        base_url = stage.get("base_url")
        endpoint = f" endpoint `{base_url}`" if base_url else ""
        if stage.get("remote"):
            data_sent = ", ".join(stage.get("data_sent", [])) or "no remote data"
            lines.append(
                f"- {stage_name}: provider `{label}` model `{model}`{endpoint} status `{stage.get('status', 'unknown')}`; remote data sent: {data_sent}."
            )
        else:
            lines.append(
                f"- {stage_name}: provider `{label}` status `{stage.get('status', 'unknown')}`; no remote data sent."
            )
    return "\n".join(lines) + "\n"


def clean_processing(processing_dir: Path) -> None:
    shutil.rmtree(processing_dir, ignore_errors=True)


def apply_custom_defaults(args: argparse.Namespace, *, environ: dict[str, Any] | None = None) -> list[str]:
    """Complete custom-provider configuration from `--custom-model`.

    An API key (environment variable), `--custom-base-url`, and a model name are
    enough to run vision against any OpenAI-compatible endpoint: when all three
    are present and the caller has not explicitly chosen a vision provider, the
    custom provider is auto-selected for vision only. Synthesis is deliberately
    NOT auto-selected — the default flow produces timestamped evidence
    (transcript.json / vision.json / timeline.json) that the agent running this
    skill reads and reports on directly; pass --synthesis-provider explicitly to
    have the pipeline generate its own report (headless/automated use). The
    vision stage still verifies image input with a test image before sending
    frame batches, so any vision-capable model works and a text-only model
    degrades honestly.
    """
    environ = os.environ if environ is None else environ
    notes: list[str] = []
    if getattr(args, "custom_model", None):
        if not args.vision_model:
            args.vision_model = args.custom_model
        if not args.synthesis_model:
            args.synthesis_model = args.custom_model
    if args.vision_provider != provider_layer.NONE:
        return notes
    if not (args.custom_base_url and args.vision_model):
        return notes
    key_env = args.custom_api_key_env or provider_layer.DEFAULT_CUSTOM_API_KEY_ENV
    if environ.get(key_env):
        args.vision_provider = provider_layer.CUSTOM
        notes.append(
            "Vision was auto-selected for the custom endpoint because an API key, "
            f"--custom-base-url, and model '{args.vision_model}' were supplied. "
            "Synthesis is not run by default: the calling agent reads the evidence "
            "(timeline.json / vision.json / transcript.json) and reports directly — "
            "pass --synthesis-provider to generate a pipeline report instead."
        )
    else:
        notes.append(
            f"{key_env} is not set, so the supplied custom endpoint was not used; "
            "set the key to enable vision on the custom provider."
        )
    return notes


def validate_provider_args(args: argparse.Namespace) -> None:
    if args.vision_provider not in provider_layer.VISION_PROVIDERS:
        raise PipelineError(f"--vision-provider must be one of {', '.join(provider_layer.VISION_PROVIDERS)}.")
    if args.synthesis_provider not in provider_layer.SYNTHESIS_PROVIDERS:
        raise PipelineError(
            f"--synthesis-provider must be one of {', '.join(provider_layer.SYNTHESIS_PROVIDERS)}."
        )
    if args.skip_vision and args.vision_provider != provider_layer.NONE:
        raise PipelineError("--skip-vision is only valid together with --vision-provider none.")
    if args.vision_provider == provider_layer.CUSTOM:
        if not args.custom_base_url:
            raise PipelineError("--vision-provider custom requires --custom-base-url.")
        if not args.vision_model:
            raise PipelineError("--vision-provider custom requires --vision-model.")
    if args.synthesis_provider == provider_layer.CUSTOM:
        if not args.custom_base_url:
            raise PipelineError("--synthesis-provider custom requires --custom-base-url.")
        if not args.synthesis_model:
            raise PipelineError("--synthesis-provider custom requires --synthesis-model.")


def build_stage_result(request: provider_layer.StageRequest) -> provider_layer.StageResult:
    if request.provider == provider_layer.NONE:
        return provider_layer.StageResult(request=request, status="not_requested")
    return provider_layer.StageResult(request=request, status="pending")


def resolve_stage_provider(
    request: provider_layer.StageRequest,
    *,
    stage_name: str,
    result: provider_layer.StageResult,
    limitations: list[str],
    environ: dict[str, Any] | None = None,
    client_factory: Callable[[provider_layer.ProviderSpec, str], Any] | None = None,
) -> tuple[provider_layer.VisionProvider | provider_layer.SynthesisProvider | None, provider_layer.StageResult]:
    if request.provider == provider_layer.NONE:
        return None, result
    environ = os.environ if environ is None else environ
    try:
        if request.stage == provider_layer.VISION:
            provider = provider_layer.create_vision_provider(
                request, environ=environ, client_factory=client_factory
            )
        else:
            provider = provider_layer.create_synthesis_provider(
                request, environ=environ, client_factory=client_factory
            )
    except provider_layer.ProviderConfigurationError as exc:
        limitations.append(f"The selected {stage_name} provider could not be configured: {exc}")
        return None, dataclasses.replace(result, status="failed", detail=str(exc))
    return provider, dataclasses.replace(result, spec=provider.spec)


def analyze(args: argparse.Namespace) -> dict[str, Any]:
    if bool(args.input) == bool(args.url):
        raise PipelineError("Supply exactly one of --input or --url.")
    if args.max_duration <= 0:
        raise PipelineError("--max-duration must be positive.")
    if args.vision_concurrency <= 0:
        raise PipelineError("--vision-concurrency must be positive.")
    custom_notes = apply_custom_defaults(args)
    validate_provider_args(args)
    if args.vision_provider == provider_layer.CUSTOM or args.synthesis_provider == provider_layer.CUSTOM:
        try:
            provider_layer.assert_custom_base_url(args.custom_base_url)
        except provider_layer.ProviderConfigurationError as exc:
            raise PipelineError(str(exc)) from exc

    vision_request = provider_layer.StageRequest(
        stage=provider_layer.VISION,
        provider=args.vision_provider,
        model=args.vision_model,
        base_url=args.custom_base_url,
        api_key_env=args.custom_api_key_env,
    )
    synthesis_request = provider_layer.StageRequest(
        stage=provider_layer.SYNTHESIS,
        provider=args.synthesis_provider,
        model=args.synthesis_model,
        base_url=args.custom_base_url,
        api_key_env=args.custom_api_key_env,
    )
    asr_result = provider_layer.StageResult(
        request=provider_layer.StageRequest(stage="asr", provider="faster-whisper", model=args.asr_model)
    )
    vision_result = build_stage_result(vision_request)
    synthesis_result = build_stage_result(synthesis_request)

    output_dir = Path(args.output_dir).resolve()
    output_dir.mkdir(parents=True, exist_ok=True)
    processing_dir = output_dir / ".processing"
    clean_processing(processing_dir)
    # exist_ok=True: a directory a locked/stale file prevented us from removing
    # (common on Windows after a failed run) must not crash the retry.
    processing_dir.mkdir(exist_ok=True)
    limitations: list[str] = []
    limitations.extend(custom_notes)

    durations: dict[str, float] = {}
    total_start = time.perf_counter()

    if args.input:
        source = Path(args.input).expanduser().resolve()
        if not source.is_file():
            raise PipelineError("The supplied local video file does not exist.")
        source_label = str(source)
        downloaded = False
        acquisition = {"method": "local_file"}
    else:
        downloaded = True
        with _timed(durations, "download"):
            try:
                result = download_public_video(
                    args.url, processing_dir / "downloaded-video", max_bytes=args.max_download_bytes
                )
                source = result.path
                source_label = result.url
                acquisition = {"method": "direct_media_download"}
            except DirectMediaTypeError as exc:
                if not args.allow_platform:
                    raise PipelineError(
                        "The URL did not serve direct video media; it looks like a platform page. "
                        "For a public video on a supported platform, rerun with --allow-platform "
                        "(requires yt-dlp); otherwise supply a direct media URL or a local file."
                    ) from exc
                try:
                    fetched = platform_download.download_platform_video(
                        args.url,
                        processing_dir,
                        max_bytes=args.max_download_bytes,
                        max_duration=args.max_duration,
                    )
                except (platform_download.PlatformFetchError, DownloadSafetyError) as platform_exc:
                    raise PipelineError(f"Platform fetch failed: {platform_exc}") from platform_exc
                source = fetched.path
                source_label = args.url
                acquisition = {"method": "platform_extraction", "tool": "yt-dlp"}
                limitations.append(
                    "Media was extracted from a video-platform page with yt-dlp; confirm you are "
                    "authorized to analyze it and review the platform's terms of service."
                )
            except (DownloadSafetyError, DownloadLimitError, Exception) as exc:
                raise PipelineError(f"Safe download failed: {exc}") from exc

    try:
        with _timed(durations, "probe"):
            media = probe_video(source)
            if media["duration_seconds"] > args.max_duration:
                raise PipelineError(
                    f"Video duration {media['duration_seconds']:.1f}s exceeds --max-duration {args.max_duration:.1f}s."
                )
            media["source"] = {
                "label": source_label,
                "downloaded": downloaded,
                "acquisition": acquisition,
            }
            write_json(output_dir / "media.json", media)

        # --- Acceleration toggle (on by default; --no-accelerate opts out) ---
        use_accel = acceleration.should_accelerate(
            explicit=True if args.accelerate else (False if args.no_accelerate else None)
        )
        accel_stats: dict[str, Any] = {
            "requested": use_accel,
            "effective": use_accel,
        }
        if use_accel and not args.skip_vision:
            limitations.append(
                "Acceleration pipeline enabled: scene-detection frames, pHash dedup, 2x2 grid "
                "montage vision input, parallel audio/video lanes, stage caching. "
                "See provenance.acceleration for details."
            )

        # --- Content cache (acceleration only; never fatal to the pipeline) ---
        cache_root: Path | None = None
        transcript_cache_key: str | None = None
        cache_saved: list[str] = []
        if use_accel:
            cache_root = acceleration.get_cache_dir(args.accel_cache_dir)
            try:
                transcript_cache_key = acceleration.cache_key(
                    source,
                    acceleration.PIPELINE_VERSION,
                    args.asr_model,
                    args.language,
                    acceleration.SCENE_THRESHOLD,
                    acceleration.PHASH_HAMMING_THRESHOLD,
                )
            except OSError:
                transcript_cache_key = None

        transcript: list[dict[str, Any]] = []
        transcript_cache_hit = False
        if use_accel and not args.skip_asr and transcript_cache_key:
            try:
                manifest = acceleration.load_cache_manifest(cache_root, transcript_cache_key)
                if manifest is not None:
                    cached = json.loads(
                        (cache_root / transcript_cache_key / "transcript.json").read_text(encoding="utf-8")
                    )
                    if isinstance(cached, list):
                        transcript = cached
                        transcript_cache_hit = True
            except (OSError, ValueError, json.JSONDecodeError):
                transcript_cache_hit = False
                transcript = []

        # --- Lane closures: video (frames+dedup+grids) and audio (extract+ASR) ---
        frames_dir = processing_dir / "frames"

        def _video_lane() -> tuple[list[dict[str, Any]], list[tuple[str, list[str]]], dict[str, Any]]:
            stats: dict[str, Any] = {}
            with _timed(durations, "frame_extraction"):
                if use_accel:
                    # Single scene-aware pass (has its own fixed-interval
                    # fallback), replacing the old double ffmpeg decode.
                    lane_frames = acceleration.extract_frames_scene_aware(
                        source,
                        frames_dir,
                        interval_seconds=args.frame_interval,
                        duration_seconds=media["duration_seconds"],
                    )
                    stats["scene_extraction"] = "scene_aware"
                else:
                    lane_frames = extract_frames(
                        source,
                        frames_dir,
                        interval_seconds=args.frame_interval,
                        duration_seconds=media["duration_seconds"],
                    )
                    stats["scene_extraction"] = "fixed_interval"
            stats["raw_frame_count"] = len(lane_frames)
            lane_grids: list[tuple[str, list[str]]] = []
            if use_accel and lane_frames:
                with _timed(durations, "dedup"):
                    lane_frames = acceleration.deduplicate_frames(lane_frames)
                stats["deduped_frame_count"] = len(lane_frames)
                with _timed(durations, "grids"):
                    try:
                        lane_grids = acceleration.make_grids(lane_frames, frames_dir)
                        stats["grid_count"] = len(lane_grids)
                    except Exception:
                        stats["grid_count"] = 0
            else:
                stats["grid_count"] = 0
            return lane_frames, lane_grids, stats

        audio_path = processing_dir / "audio.wav"

        def _audio_lane() -> tuple[list[dict[str, Any]], dict[str, Any]]:
            lane_stats: dict[str, Any] = {}
            with _timed(durations, "audio_extraction"):
                extract_audio(source, audio_path)
            with _timed(durations, "asr"):
                lane_transcript = run_asr_subprocess(
                    audio_path,
                    model=args.asr_model,
                    language=args.language,
                    duration_seconds=media["duration_seconds"],
                    accel_stats=lane_stats,
                )
            return lane_transcript, lane_stats

        # --- Acquire frames + transcript (parallel lanes when accelerating) ---
        frames: list[dict[str, Any]] = []
        grids: list[tuple[str, list[str]]] = []
        if args.skip_asr:
            frames, grids, lane_stats = _video_lane()
            accel_stats.update(lane_stats)
            asr_result = dataclasses.replace(
                asr_result, status="skipped", detail="Speech transcription was skipped by request."
            )
            limitations.append("Speech transcription was skipped by request.")
        elif transcript_cache_hit:
            frames, grids, lane_stats = _video_lane()
            accel_stats.update(lane_stats)
            asr_result = dataclasses.replace(
                asr_result,
                status="succeeded",
                extra={
                    "cache_hit": True,
                    "cache_key": transcript_cache_key,
                    "segment_count": len(transcript),
                },
            )
        elif use_accel:
            audio_out, video_out, audio_err, video_err = acceleration.run_parallel_audio_video(
                _audio_lane, _video_lane
            )
            if video_err is not None:
                raise PipelineError(f"Frame extraction failed: {video_err}")
            frames, grids, lane_stats = video_out
            accel_stats.update(lane_stats)
            if audio_err is not None:  # ASR failures are reportable but nonfatal.
                transcript = []
                asr_result = dataclasses.replace(asr_result, status="failed", detail=audio_err)
                limitations.append(f"Speech transcription failed: {audio_err}")
            else:
                transcript, asr_lane_stats = audio_out
                accel_stats.update(asr_lane_stats)
                asr_result = dataclasses.replace(
                    asr_result, status="succeeded", extra={"segment_count": len(transcript)}
                )
        else:
            frames, grids, lane_stats = _video_lane()
            accel_stats.update(lane_stats)
            try:
                transcript, asr_lane_stats = _audio_lane()
                accel_stats.update(asr_lane_stats)
                asr_result = dataclasses.replace(
                    asr_result, status="succeeded", extra={"segment_count": len(transcript)}
                )
            except Exception as exc:  # ASR failures are reportable but nonfatal.
                transcript = []
                asr_result = dataclasses.replace(asr_result, status="failed", detail=str(exc))
                limitations.append(f"Speech transcription failed: {exc}")

        write_json(output_dir / "frames.json", frames)
        write_json(output_dir / "transcript.json", transcript)

        # Persist a successful transcript to the content cache (accel only).
        if use_accel and transcript_cache_key and not transcript_cache_hit and asr_result.status == "succeeded":
            try:
                payload_bytes = json.dumps(transcript, ensure_ascii=False).encode("utf-8")
                key_dir = cache_root / transcript_cache_key
                key_dir.mkdir(parents=True, exist_ok=True)
                (key_dir / "transcript.json").write_bytes(payload_bytes)
                acceleration.save_cache_manifest(
                    cache_root,
                    transcript_cache_key,
                    data={"stage": "asr", "pipeline_version": acceleration.PIPELINE_VERSION},
                    entries=[{"path": "transcript.json", "size": len(payload_bytes)}],
                )
                cache_saved.append("transcript")
            except OSError:
                pass  # A cache write failure never breaks the pipeline.

        # --- Vision input: 2x2 grid montages when accelerating, else raw frames ---
        vision_frames: list[dict[str, Any]] = frames
        accel_stats["vision_input"] = "frames"
        if use_accel and grids and not args.skip_vision:
            vision_frames = []
            for index, (grid_path, _grid_sources) in enumerate(grids):
                cell_frames = frames[index * acceleration.GRID_CELLS : (index + 1) * acceleration.GRID_CELLS]
                cell_stamps = [cell["timestamp_seconds"] for cell in cell_frames]
                vision_frames.append(
                    {
                        "path": grid_path,
                        "timestamp_seconds": cell_frames[0]["timestamp_seconds"],
                        "label": (
                            f"Image {index + 1} of {len(grids)}: a 2x2 montage of frames at "
                            + ", ".join(f"{stamp:.1f}s" for stamp in cell_stamps)
                            + " in reading order (top-left, top-right, bottom-left, bottom-right). "
                              "Return exactly ONE observation covering all cells of this montage."
                        ),
                        "source_timestamps": cell_stamps,
                        "kind": "grid",
                    }
                )
            accel_stats["vision_input"] = "grids"
            accel_stats["grids"] = [
                {"path": entry["path"], "source_timestamps": entry["source_timestamps"]}
                for entry in vision_frames
            ]

        # --- Vision cache lookup (key includes grids-vs-frames input mode) ---
        observations: list[dict[str, Any]] = []
        vision_cache_key: str | None = None
        vision_cache_hit = False
        if use_accel and not args.skip_vision and cache_root is not None:
            try:
                vision_cache_key = acceleration.cache_key(
                    source,
                    acceleration.PIPELINE_VERSION,
                    args.asr_model,
                    args.language,
                    acceleration.SCENE_THRESHOLD,
                    acceleration.PHASH_HAMMING_THRESHOLD,
                    extra_params=(
                        f"vision|{args.vision_provider}|{args.vision_model or ''}"
                        f"|{args.frame_interval}|{accel_stats['vision_input']}"
                    ),
                )
                manifest = acceleration.load_cache_manifest(cache_root, vision_cache_key)
                if manifest is not None:
                    cached = json.loads(
                        (cache_root / vision_cache_key / "vision.json").read_text(encoding="utf-8")
                    )
                    if isinstance(cached, list):
                        observations = cached
                        vision_cache_hit = True
            except (OSError, ValueError, json.JSONDecodeError):
                vision_cache_hit = False
                observations = []

        if args.skip_vision:
            vision_result = dataclasses.replace(
                vision_result, status="skipped", detail="Frame interpretation was skipped by request."
            )
            limitations.append("Frame interpretation was skipped by request.")
        elif vision_cache_hit:
            vision_result = dataclasses.replace(
                vision_result,
                status="succeeded",
                extra={
                    "cache_hit": True,
                    "cache_key": vision_cache_key,
                    "submitted_frame_count": len(vision_frames),
                },
            )
        else:
            with _timed(durations, "vision"):
                vision_provider, vision_result = resolve_stage_provider(
                    vision_request,
                    stage_name="vision",
                    result=vision_result,
                    limitations=limitations,
                )
                if vision_provider is not None:
                    probe = vision_provider.probe_image_input(Path(vision_frames[0]["path"]))
                    if not probe["ok"]:
                        vision_result = dataclasses.replace(
                            vision_result, status="failed", detail=probe["detail"], extra={"probe": probe}
                        )
                        limitations.append(
                            "Frame interpretation was aborted because the custom endpoint rejected a test image: "
                            f"model '{vision_provider.spec.model}' does not appear to support image input."
                        )
                    else:
                        observations = analyze_frame_batches(
                            vision_frames,
                            batch_size=args.vision_batch_size,
                            vision_provider=vision_provider,
                            concurrency=args.vision_concurrency,
                        )
                        failures = [item for item in observations if "batch_error" in item]
                        successful = [item for item in observations if "timestamp_seconds" in item]
                        extra = {
                            "submitted_frame_count": len(vision_frames),
                            "successful_observation_count": len(successful),
                            "failed_batch_count": len(failures),
                        }
                        if probe.get("probed"):
                            extra["probe"] = probe
                        if failures:
                            status = "partial" if successful else "failed"
                            limitations.append("One or more vision batches failed; see vision.json for details.")
                        elif successful:
                            status = "succeeded"
                        else:
                            status = "failed"
                            limitations.append("The selected vision provider produced no usable observations.")
                        vision_result = dataclasses.replace(vision_result, status=status, extra=extra)
        write_json(output_dir / "vision.json", observations)

        # Persist successful vision observations only (never partial/failed batches).
        if use_accel and vision_cache_key and not vision_cache_hit and vision_result.status == "succeeded":
            try:
                payload_bytes = json.dumps(observations, ensure_ascii=False).encode("utf-8")
                key_dir = cache_root / vision_cache_key
                key_dir.mkdir(parents=True, exist_ok=True)
                (key_dir / "vision.json").write_bytes(payload_bytes)
                acceleration.save_cache_manifest(
                    cache_root,
                    vision_cache_key,
                    data={"stage": "vision", "pipeline_version": acceleration.PIPELINE_VERSION},
                    entries=[{"path": "vision.json", "size": len(payload_bytes)}],
                )
                cache_saved.append("vision")
            except OSError:
                pass

        if use_accel:
            accel_stats["cache"] = {
                "dir": str(cache_root),
                "transcript_hit": transcript_cache_hit,
                "vision_hit": vision_cache_hit,
                "saved": cache_saved,
            }

        with _timed(durations, "timeline"):
            timeline = build_timeline(
                duration_seconds=media["duration_seconds"],
                transcript=transcript,
                observations=observations,
                window_seconds=args.segment_seconds,
            )
            write_json(output_dir / "timeline.json", timeline)

        usable_transcript = bool(transcript)
        usable_visual = any("timestamp_seconds" in item for item in observations)
        evidence_modalities = []
        if usable_transcript:
            evidence_modalities.append("transcript")
        if usable_visual:
            evidence_modalities.append("visual_observations")

        analysis: dict[str, Any] | None = None
        if synthesis_request.provider == provider_layer.NONE:
            synthesis_result = dataclasses.replace(synthesis_result, status="not_requested")
            limitations.append("Semantic synthesis was not requested; use --synthesis-provider to enable it.")
        elif not evidence_modalities:
            synthesis_result = dataclasses.replace(
                synthesis_result,
                status="skipped",
                detail="No transcript or visual evidence was available for synthesis.",
            )
            limitations.append("Semantic synthesis was skipped because no transcript or visual evidence was available.")
        else:
            synthesis_provider, synthesis_result = resolve_stage_provider(
                synthesis_request,
                stage_name="synthesis",
                result=synthesis_result,
                limitations=limitations,
            )
            if synthesis_provider is not None:
                try:
                    with _timed(durations, "synthesis"):
                        analysis = synthesize_analysis(
                            source_label=source_label,
                            duration_seconds=media["duration_seconds"],
                            timeline=timeline,
                            limitations=limitations,
                            evidence_modalities=evidence_modalities,
                            synthesis_provider=synthesis_provider,
                        )
                    synthesis_result = dataclasses.replace(
                        synthesis_result,
                        status="succeeded",
                        extra={"evidence_modalities": evidence_modalities},
                    )
                except Exception as exc:
                    synthesis_result = dataclasses.replace(synthesis_result, status="failed", detail=str(exc))
                    limitations.append(f"The selected synthesis provider failed: {exc}")

        if analysis is None:
            analysis = local_fallback_analysis(
                source_label=source_label,
                duration_seconds=media["duration_seconds"],
                timeline=timeline,
                limitations=limitations,
            )

        durations["total"] = round(time.perf_counter() - total_start, 3)
        analysis["provenance"] = {
            "schema_version": 3,
            "source_acquisition": acquisition,
            "frame_interval_seconds": args.frame_interval,
            "segment_seconds": args.segment_seconds,
            "frame_count": len(frames),
            "transcript_segment_count": len(transcript),
            "vision_observation_count": len([item for item in observations if "timestamp_seconds" in item]),
            "stage_durations_seconds": durations,
            "acceleration": accel_stats,
            "stages": {
                "asr": asr_result.provenance(),
                "vision": vision_result.provenance(),
                "synthesis": synthesis_result.provenance(),
            },
        }
        write_json(output_dir / "analysis.json", analysis)
        (output_dir / "report.md").write_text(render_markdown(analysis, source_label), encoding="utf-8")
        return analysis
    finally:
        if not args.keep_artifacts:
            clean_processing(processing_dir)


def build_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(description="Analyze an authorized local video or direct public video URL.")
    source_group = parser.add_mutually_exclusive_group(required=True)
    source_group.add_argument("--input", help="Authorized local video file.")
    source_group.add_argument(
        "--url",
        help="Authorized public direct HTTP(S) media URL; with --allow-platform, a public video-platform page too.",
    )
    parser.add_argument(
        "--allow-platform",
        action="store_true",
        help=(
            "If --url is a video-platform page rather than direct media, fetch the single public "
            "video with yt-dlp. No login, cookies, or access-control bypass is ever used."
        ),
    )
    parser.add_argument("--output-dir", required=True, help="Directory for JSON artifacts and report.md.")
    parser.add_argument("--frame-interval", type=float, default=3.0)
    parser.add_argument("--max-duration", type=float, default=600.0, help="Maximum source duration in seconds.")
    parser.add_argument("--segment-seconds", type=int, default=WINDOW_SECONDS)
    parser.add_argument("--max-download-bytes", type=int, default=DEFAULT_MAX_BYTES)
    parser.add_argument("--skip-asr", action="store_true")
    parser.add_argument(
        "--skip-vision",
        action="store_true",
        help="Compatibility flag; equivalent to --vision-provider none.",
    )
    parser.add_argument(
        "--asr-model",
        default=os.environ.get("TOKENICODE_VIDEO_ANALYSIS_ASR_MODEL", "small"),
        help="faster-whisper model size (tiny/base/small/medium/large-v2/large-v3/large-v3-turbo). "
             "Also settable via TOKENICODE_VIDEO_ANALYSIS_ASR_MODEL env var.",
    )
    parser.add_argument("--language", help="Optional Whisper language code, for example zh or en.")
    parser.add_argument("--vision-batch-size", type=int, default=8)
    parser.add_argument(
        "--vision-concurrency",
        type=int,
        default=4,
        help="Number of vision batches dispatched in parallel (observation order is preserved).",
    )
    parser.add_argument(
        "--vision-provider",
        default=provider_layer.NONE,
        choices=provider_layer.VISION_PROVIDERS,
        help="Explicit frame-interpretation provider. Defaults to none (no remote vision call).",
    )
    parser.add_argument("--vision-model", help="Optional model override for the selected vision provider.")
    parser.add_argument(
        "--synthesis-provider",
        default=provider_layer.NONE,
        choices=provider_layer.SYNTHESIS_PROVIDERS,
        help="Explicit text-report synthesis provider. Defaults to none (deterministic local report).",
    )
    parser.add_argument("--synthesis-model", help="Optional model override for the selected synthesis provider.")
    parser.add_argument(
        "--custom-base-url",
        help="OpenAI-compatible endpoint base URL for provider 'custom', e.g. https://api.example.com/v1.",
    )
    parser.add_argument(
        "--custom-model",
        help=(
            "Model name applied to both the vision and synthesis stages of provider 'custom' unless "
            "--vision-model/--synthesis-model override it. Supplying this together with --custom-base-url "
            "and the custom API key auto-selects the custom provider for both stages; the vision stage "
            "verifies image input with a test image, so any vision-capable model works."
        ),
    )
    parser.add_argument(
        "--custom-api-key-env",
        default=provider_layer.DEFAULT_CUSTOM_API_KEY_ENV,
        help="Environment variable holding the API key for provider 'custom' (default CUSTOM_API_KEY).",
    )
    parser.add_argument("--keep-artifacts", action="store_true")
    parser.add_argument(
        "--accelerate",
        action="store_true",
        default=None,
        help="Force the acceleration pipeline on (it is on by default; kept for compatibility; "
             "overrides env var TOKENICODE_VIDEO_ANALYSIS_ACCELERATE).",
    )
    parser.add_argument(
        "--no-accelerate",
        action="store_true",
        default=None,
        help="Disable the acceleration pipeline (overrides env var).",
    )
    parser.add_argument(
        "--accel-cache-dir",
        help="Directory for acceleration artifact cache (default ~/.tokenicode/video-cache).",
    )
    return parser


def _force_utf8_stdio() -> None:
    # Windows consoles often default to GBK, which mangles Chinese characters in
    # paths (e.g. an output dir under C:\桌面). Report JSON is UTF-8 regardless.
    for stream in (sys.stdout, sys.stderr):
        if hasattr(stream, "reconfigure"):
            try:
                stream.reconfigure(encoding="utf-8", errors="replace")
            except (ValueError, OSError):
                pass


def main(argv: Iterable[str] | None = None) -> int:
    _force_utf8_stdio()
    args = build_parser().parse_args(argv)
    try:
        analysis = analyze(args)
    except PipelineError as exc:
        print(json.dumps({"ok": False, "error": str(exc)}, ensure_ascii=False), file=sys.stderr)
        return 1
    print(
        json.dumps(
            {
                "ok": True,
                "output_dir": str(Path(args.output_dir).resolve()),
                "title": analysis.get("title"),
                "limitations": analysis.get("limitations", []),
            },
            ensure_ascii=False,
        )
    )
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
