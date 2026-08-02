"""Activate the offline resources bundled with this skill.

The skill folder ships everything that would otherwise be downloaded on demand,
so another machine (or another agent) can run the pipeline without network
access or long downloads:

- ``bin/``        — ffmpeg and ffprobe executables (Gyan full build).
- ``models/``     — faster-whisper ASR models, e.g. ``faster-whisper-small``.
- ``wheelhouse/`` — offline Python wheels for ``requirements.txt``
                    (installed with ``setup_offline.bat`` / ``setup_offline.sh``).

Call :func:`activate` at process start, before any subprocess is spawned, to
prepend ``bin/`` to ``PATH``. When the bundled binaries are absent (for example
a stripped-down copy of the skill), ``PATH`` is left untouched and a system
ffmpeg installation keeps working exactly as before.
"""

from __future__ import annotations

import os
from pathlib import Path
from typing import Any

SKILL_ROOT = Path(__file__).resolve().parent.parent
BUNDLED_BIN = SKILL_ROOT / "bin"
BUNDLED_MODELS = SKILL_ROOT / "models"
BUNDLED_WHEELHOUSE = SKILL_ROOT / "wheelhouse"

_EXECUTABLE_STEMS = ("ffmpeg", "ffprobe")


def _exe_name(stem: str) -> str:
    return f"{stem}.exe" if os.name == "nt" else stem


def bundled_executables() -> dict[str, str | None]:
    """Return absolute paths of the bundled ffmpeg/ffprobe, or None if missing."""
    found: dict[str, str | None] = {}
    for stem in _EXECUTABLE_STEMS:
        candidate = BUNDLED_BIN / _exe_name(stem)
        found[stem] = str(candidate) if candidate.is_file() else None
    return found


def activate(*, environ: dict[str, Any] | None = None) -> bool:
    """Prepend the bundled ``bin/`` directory to PATH.

    Returns True when the bundled directory was applied (or was already first
    on PATH), False when no bundled executables are present.
    """
    environ = os.environ if environ is None else environ
    executables = bundled_executables()
    if any(path is None for path in executables.values()):
        return False
    bin_str = str(BUNDLED_BIN)
    current = environ.get("PATH", "")
    parts = current.split(os.pathsep) if current else []
    if parts and os.path.normcase(parts[0]) == os.path.normcase(bin_str):
        return True  # idempotent: already prepended
    environ["PATH"] = bin_str + os.pathsep + current
    return True


def bundled_asr_models() -> list[str]:
    """Names of bundled faster-whisper models (e.g. ["small"])."""
    if not BUNDLED_MODELS.is_dir():
        return []
    models = []
    for entry in sorted(BUNDLED_MODELS.iterdir()):
        if entry.is_dir() and entry.name.startswith("faster-whisper-") and (entry / "model.bin").is_file():
            models.append(entry.name[len("faster-whisper-"):])
    return models


def resolve_asr_model(model_name: str) -> str:
    """Map an ``--asr-model`` name to the bundled local directory when present.

    ``WhisperModel`` accepts a local directory in place of a model name, so a
    bundled model directory avoids the ~460 MB first-run download entirely.
    Names without a bundled directory (or explicit local paths) pass through
    unchanged, preserving the original Hugging Face hub behavior.
    """
    candidate = BUNDLED_MODELS / f"faster-whisper-{model_name}"
    if candidate.is_dir() and (candidate / "model.bin").is_file():
        return str(candidate)
    return model_name


def bundled_status() -> dict[str, Any]:
    """Read-only inventory of bundled resources, for preflight reporting."""
    executables = bundled_executables()
    wheel_files = (
        [path.name for path in sorted(BUNDLED_WHEELHOUSE.glob("*.whl"))]
        if BUNDLED_WHEELHOUSE.is_dir()
        else []
    )
    return {
        "skill_root": str(SKILL_ROOT),
        "bin_dir": str(BUNDLED_BIN) if any(executables.values()) else None,
        "executables": executables,
        "asr_models": bundled_asr_models(),
        "wheelhouse_wheels": len(wheel_files),
    }
