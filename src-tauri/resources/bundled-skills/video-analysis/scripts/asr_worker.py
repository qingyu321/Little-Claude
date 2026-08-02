"""Crash-isolated ASR worker for the video-analysis pipeline.

faster-whisper pulls in several native libraries that each ship their own
OpenMP runtime (ctranslate2 / numpy-MKL use Intel's libiomp5md, onnxruntime's
silero VAD uses vcomp140). When two copies load into one process, the second
one aborts the process natively — a crash Python's try/except cannot catch,
which used to kill the whole pipeline.

Running transcription in this separate worker process confines any native
abort to the child: the parent (analyze_video.py) only sees a nonzero exit
code without JSON on stdout and reports speech transcription as a nonfatal
limitation instead of dying.

Contract with the parent:
- stdout carries exactly one JSON line, printed at the very end:
    success: {"ok": true, "segments": [...], "language": ..., "device": ...}
    failure: {"ok": false, "error": "...", "error_type": "..."}
- exit 0 = success, exit 1 = controlled failure (JSON explains it),
  exit 2 = usage error, anything else = native crash (no JSON).
- stderr is free-form library diagnostics only.
"""

# OpenMP compatibility environment. These MUST be set before any library that
# may load an OpenMP runtime is imported — which is why they live above every
# other import. The parent additionally sets them in this process's startup
# environment; setdefault keeps both layers honest.
import os

os.environ.setdefault("KMP_DUPLICATE_LIB_OK", "TRUE")  # Intel libiomp5md duplicates (numpy-MKL / ctranslate2)
os.environ.setdefault("OMP_WAIT_POLICY", "PASSIVE")  # idle OpenMP threads must not spin against onnxruntime VAD
os.environ.setdefault("OMP_NUM_THREADS", str(max(1, min(8, os.cpu_count() or 1))))  # cap oversubscription

import argparse
import json
import sys
from pathlib import Path
from typing import Any, Iterable

import acceleration
import bundled_env


def _force_utf8_stdio() -> None:
    # Windows consoles often default to GBK, which mangles Chinese text in
    # transcription output. The JSON result is UTF-8 regardless.
    for stream in (sys.stdout, sys.stderr):
        if hasattr(stream, "reconfigure"):
            try:
                stream.reconfigure(encoding="utf-8", errors="replace")
            except (ValueError, OSError):
                pass


def _emit(payload: dict[str, Any]) -> None:
    print(json.dumps(payload, ensure_ascii=False))


def run_transcription(audio_path: Path, model_name: str, language: str | None) -> dict[str, Any]:
    """Run faster-whisper end to end and return the result payload.

    Never raises for library-level problems: import failures, model load
    failures, and transcription errors come back as ``{"ok": false, ...}``
    so main() can turn them into a controlled exit 1.
    """
    try:
        from faster_whisper import WhisperModel
    except ImportError as exc:
        return {
            "ok": False,
            "error": (
                f"faster-whisper is not installed ({exc}). "
                "Install requirements.txt or rerun with --skip-asr."
            ),
            "error_type": "ImportError",
        }

    compute_type, device = acceleration.get_accel_compute_type()
    # A bundled model directory (skill models/faster-whisper-<name>) is passed
    # as a local path so first run needs no ~460 MB download; unknown names
    # fall through to the original Hugging Face hub behavior.
    model_path = bundled_env.resolve_asr_model(model_name)
    try:
        model = WhisperModel(model_path, device=device, compute_type=compute_type)
    except Exception as cuda_exc:
        if device != "cuda":
            return {
                "ok": False,
                "error": f"ASR model failed to load: {cuda_exc}",
                "error_type": "ModelLoad",
            }
        # CUDA load failures (driver mismatch, too little VRAM) are common;
        # retry once on CPU instead of giving up.
        device, compute_type = "cpu", "int8"
        try:
            model = WhisperModel(model_path, device=device, compute_type=compute_type)
        except Exception as cpu_exc:
            return {
                "ok": False,
                "error": f"ASR model failed to load on CUDA ({cuda_exc}) and CPU ({cpu_exc})",
                "error_type": "ModelLoad",
            }

    kwargs = acceleration.get_whisper_transcribe_kwargs(language)
    try:
        segments_iter, info = model.transcribe(str(audio_path), **kwargs)
        segments = []
        for segment in segments_iter:
            text = segment.text.strip()
            if text:
                segments.append(
                    {
                        "start_seconds": round(float(segment.start), 3),
                        "end_seconds": round(float(segment.end), 3),
                        "text": text,
                        "language": info.language,
                        "language_probability": round(float(info.language_probability), 4),
                    }
                )
    except Exception as exc:
        return {"ok": False, "error": f"ASR transcription failed: {exc}", "error_type": "Transcribe"}

    return {
        "ok": True,
        "segments": segments,
        "language": info.language,
        "language_probability": round(float(info.language_probability), 4),
        "device": device,
        "compute_type": compute_type,
    }


def main(argv: Iterable[str] | None = None) -> int:
    _force_utf8_stdio()
    parser = argparse.ArgumentParser(description="Crash-isolated faster-whisper worker (internal).")
    parser.add_argument("--audio-path", required=True, help="16 kHz mono WAV extracted by the parent.")
    parser.add_argument("--model", required=True, help="faster-whisper model name (e.g. small).")
    parser.add_argument("--language", default=None, help="Optional Whisper language code, e.g. zh or en.")
    args = parser.parse_args(list(argv) if argv is not None else None)

    audio_path = Path(args.audio_path)
    if not audio_path.is_file():
        _emit({"ok": False, "error": f"Audio file not found: {audio_path}", "error_type": "Input"})
        return 1

    result = run_transcription(audio_path, args.model, args.language)
    _emit(result)
    return 0 if result.get("ok") else 1


if __name__ == "__main__":
    raise SystemExit(main())
