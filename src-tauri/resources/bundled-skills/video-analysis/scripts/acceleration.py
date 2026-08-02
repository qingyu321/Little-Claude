"""Video analysis acceleration pipeline.

This module provides the acceleration primitives described in the
video-analysis efficiency report. It is designed to be imported by
`analyze_video.py` and used as a drop-in acceleration path when the
user enables it (via CLI flag or environment variable).

Optimizations implemented:
1. Scene-detection frame extraction (FFmpeg `scene > 0.3`)
2. Perceptual hash (pHash) deduplication
3. 2x2 frame grid stitching
4. Optimized faster-whisper parameters (beam_size=1, VAD filter)
5. Parallel audio / video processing via ThreadPoolExecutor
6. Versioned content caching with SHA-256 keys

All acceleration functions have graceful fallbacks: if a dependency is
missing or an operation fails, the caller can fall back to the original
code path in analyze_video.py.
"""

from __future__ import annotations

import hashlib
import json
import os
import subprocess
import sys
from concurrent.futures import ThreadPoolExecutor, as_completed
from pathlib import Path
from typing import Any, Callable, Optional

# ---------------------------------------------------------------------------
# Constants
# ---------------------------------------------------------------------------

PIPELINE_VERSION = "1"  # Bump to invalidate all caches
SCENE_THRESHOLD = 0.3
PHASH_HAMMING_THRESHOLD = 0.08  # Fraction of differing bits
GRID_COLS = 2
GRID_ROWS = 2
GRID_CELLS = GRID_COLS * GRID_ROWS  # 4 frames per grid
GRID_MAX_WIDTH = 1024
FRAME_MAX_WIDTH = 1024

# ---------------------------------------------------------------------------
# Helpers
# ---------------------------------------------------------------------------

def _is_accel_env() -> Optional[bool]:
    """Read the acceleration override from the environment.

    Returns True for "1", False for "0", None when unset (fall through to
    the default). The TOKENICODE app sets this variable from the settings
    toggle; either polarity must keep working.
    """
    value = os.environ.get("TOKENICODE_VIDEO_ANALYSIS_ACCELERATE")
    if value is None:
        return None
    if value == "1":
        return True
    if value == "0":
        return False
    return None


def should_accelerate(explicit: Optional[bool]) -> bool:
    """Resolve whether acceleration should be active.

    Priority: explicit CLI arg > env var > True (on by default).
    """
    if explicit is True:
        return True
    if explicit is False:
        return False
    env_value = _is_accel_env()
    if env_value is not None:
        return env_value
    return True


# ---------------------------------------------------------------------------
# 1. Scene-detection frame extraction
# ---------------------------------------------------------------------------

def extract_frames_scene_aware(
    source: Path,
    frames_dir: Path,
    *,
    interval_seconds: float,
    duration_seconds: float,
    scene_threshold: float = SCENE_THRESHOLD,
    max_width: int = FRAME_MAX_WIDTH,
) -> list[dict[str, Any]]:
    """Extract key frames using scene detection + a minimum-density backstop.

    Uses FFmpeg's `select` filter: keeps frames where the scene change
    exceeds *scene_threshold*, the frame is a keyframe (I-frame), OR at
    least *interval_seconds* have passed since the previous selected frame.
    The time-gap term guarantees a minimum density of 1 frame per interval
    even for static content, while scene changes add extra frames on top.

    Falls back to the simple fixed-interval method on any error.
    """
    if interval_seconds <= 0:
        raise ValueError("interval_seconds must be positive")
    frames_dir.mkdir(parents=True, exist_ok=True)
    pattern = frames_dir / "frame_%06d.jpg"

    # Primary: scene-aware filter. The comma inside min() must be escaped
    # (\,) or ffmpeg's filtergraph parser splits the scale filter in two
    # ("No such filter: 'iw):-2'"). Commas inside the single-quoted select
    # expression are protected by the quotes.
    vf = (
        f"scale=min({max_width}\\,iw):-2,"
        f"select='gt(scene,{scene_threshold})"
        f"+eq(pict_type,I)"
        f"+gte(t-prev_selected_t,{interval_seconds})'"
    )
    try:
        subprocess.run(
            [
                "ffmpeg", "-y",
                "-i", str(source),
                "-vf", vf,
                "-vsync", "vfr",
                "-q:v", "3",
                str(pattern),
            ],
            check=True,
            capture_output=True,
            text=True,
        )
    except (subprocess.CalledProcessError, FileNotFoundError):
        # Fallback: simple fixed-interval extraction.
        pattern2 = frames_dir / "frame_%06d.jpg"
        subprocess.run(
            [
                "ffmpeg", "-y",
                "-i", str(source),
                "-vf", f"fps=1/{interval_seconds},scale=min({max_width}\\,iw):-2",
                "-q:v", "3",
                str(pattern2),
            ],
            check=True,
            capture_output=True,
            text=True,
        )

    paths = sorted(frames_dir.glob("frame_*.jpg"))
    if not paths:
        from analyze_video import PipelineError
        raise PipelineError("ffmpeg did not produce any frames (acceleration mode).")

    frames: list[dict[str, Any]] = []
    for index, path in enumerate(paths):
        frames.append({
            "timestamp_seconds": round(min(index * interval_seconds, duration_seconds), 3),
            "path": str(path),
        })
    return frames


# ---------------------------------------------------------------------------
# 2. Perceptual hash (pHash) deduplication
# ---------------------------------------------------------------------------

_DCT_MATRIX: Any = None  # Cached 32x32 DCT-II transform matrix


def _dct2(a: Any) -> Any:
    """Apply the 2D type-II DCT to a square matrix via M @ a @ M.T.

    The transform matrix is built once and cached at module level. NumPy is
    imported lazily so this module stays importable without it.
    """
    global _DCT_MATRIX
    import numpy as np
    if _DCT_MATRIX is None or _DCT_MATRIX.shape[0] != a.shape[0]:
        n = a.shape[0]
        k = np.arange(n)[:, None]
        i = np.arange(n)[None, :]
        _DCT_MATRIX = np.cos(np.pi * k * (2 * i + 1) / (2 * n))
    return _DCT_MATRIX @ a @ _DCT_MATRIX.T


def _perceptual_hash(img_path: str | Path) -> int:
    """Compute a 64-bit DCT-II perceptual hash for a JPEG image.

    Uses the standard pHash algorithm:
    1. Convert to grayscale, resize to 32x32.
    2. Compute the 2D DCT (Type II).
    3. Take the top-left 8x8 coefficients, excluding DC.
    4. Compare each to the median — above-median = 1, else 0.

    Returns an integer whose lower 64 bits represent the hash.
    """
    try:
        import numpy as np
        from PIL import Image
    except ImportError:
        return 0  # Can't deduplicate without Pillow+NumPy

    img = Image.open(img_path).convert("L").resize((32, 32), Image.LANCZOS)
    pixels = np.array(img, dtype=np.float64)

    # 2D DCT-II via a precomputed transform matrix: M @ a @ M.T applies the
    # type-II DCT along both axes in two matmuls (~microseconds), replacing
    # the former pure-Python O(n^2) loops. The ortho normalization constant
    # is deliberately omitted: the hash thresholds against the median of the
    # low block, which is invariant to any positive global scaling.
    dct = _dct2(pixels)

    low = dct[:8, :8].flatten()[1:]  # Skip DC component (index 0)
    median = float(np.median(low))
    hash_bits = "".join("1" if v > median else "0" for v in low)
    return int(hash_bits, 2)


def _hamming_distance(h1: int, h2: int, bits: int = 63) -> float:
    """Fraction of differing bits between two hashes."""
    return bin(h1 ^ h2).count("1") / bits


def deduplicate_frames(
    frames: list[dict[str, Any]],
    threshold: float = PHASH_HAMMING_THRESHOLD,
) -> list[dict[str, Any]]:
    """Remove near-duplicate frames using perceptual hashing.

    Adjacent frames with pHash difference <= *threshold* are dropped.
    Returns the filtered frame list.
    """
    if len(frames) < 2:
        return frames

    try:
        kept = [frames[0]]
        prev_hash = _perceptual_hash(frames[0]["path"])
        for f in frames[1:]:
            h = _perceptual_hash(f["path"])
            if h == 0 or _hamming_distance(prev_hash, h) > threshold:
                kept.append(f)
                if h != 0:
                    prev_hash = h
        return kept
    except Exception:
        return frames  # Graceful fallback: keep all


# ---------------------------------------------------------------------------
# 3. 2x2 frame grid stitching
# ---------------------------------------------------------------------------

def make_grids(
    frames: list[dict[str, Any]],
    frames_dir: Path,
    cols: int = GRID_COLS,
    rows: int = GRID_ROWS,
    max_w: int = GRID_MAX_WIDTH,
) -> list[tuple[str, list[str]]]:
    """Stitch up to `cols * rows` frames into a single grid JPEG.

    Returns a list of (grid_path, source_frame_paths) tuples.
    Grid JPEGs are saved alongside the source frames.
    """
    cells_per_grid = cols * rows
    if len(frames) == 0:
        return []

    try:
        import numpy as np
        from PIL import Image, ImageDraw, ImageFont
    except ImportError:
        return []  # Can't grid without Pillow

    cell_w = max_w // cols
    grids = []

    for start in range(0, len(frames), cells_per_grid):
        batch = frames[start:start + cells_per_grid]
        cells: list[Image.Image] = []
        labels: list[str] = []

        for f in batch:
            try:
                img = Image.open(f["path"])
                h = max(1, int(img.height * cell_w / img.width))
                img = img.resize((cell_w, h), Image.LANCZOS)
            except Exception:
                img = Image.new("RGB", (cell_w, 60), (240, 240, 240))
            cells.append(img)
            labels.append(os.path.basename(str(f.get("path", ""))))

        cell_h = max(c.height for c in cells)

        # Build rows
        row_imgs = []
        for r in range(rows):
            row_cells = cells[r * cols:(r + 1) * cols]
            # Pad to full cols
            while len(row_cells) < cols:
                row_cells.append(Image.new("RGB", (cell_w, cell_h), (240, 240, 240)))
            # Resize all cells to uniform height
            uniform = [c.resize((cell_w, cell_h), Image.LANCZOS) if c.size != (cell_w, cell_h) else c for c in row_cells]
            row_array = np.hstack([np.array(c) for c in uniform])
            row_imgs.append(row_array)

        # Pad rows
        while len(row_imgs) < rows:
            row_imgs.append(np.full((cell_h, cell_w * cols, 3), 240, dtype=np.uint8))

        grid = Image.fromarray(np.vstack(row_imgs))

        # Add timestamp labels in top-left of each cell
        try:
            draw = ImageDraw.Draw(grid)
            for idx, f in enumerate(batch):
                r, c = divmod(idx, cols)
                ts = f.get("timestamp_seconds", 0)
                x, y = c * cell_w + 3, r * cell_h + 2
                draw.text((x, y), f"{ts:.1f}s", fill=(255, 255, 0))
        except Exception:
            pass

        out_path = frames_dir / f"grid_{start:04d}.jpg"
        grid.save(out_path, quality=85)
        grids.append((str(out_path), [str(f["path"]) for f in batch]))

    return grids


# ---------------------------------------------------------------------------
# 4. Optimized faster-whisper parameters
# ---------------------------------------------------------------------------

def get_whisper_transcribe_kwargs(language: str | None) -> dict[str, Any]:
    """Return optimized transcribe() kwargs for the acceleration path.

    - beam_size=1 (greedy, 3-5x faster)
    - condition_on_previous_text=False
    - vad_filter=True with tuned parameters
    """
    return {
        "language": language,
        "beam_size": 1,
        "condition_on_previous_text": False,
        "vad_filter": True,
        "vad_parameters": {
            "min_speech_duration_ms": 250,
            "min_silence_duration_ms": 300,
        },
    }


def get_accel_compute_type() -> tuple[str, str]:
    """Return (compute_type, device_label) for fastest available backend.

    Tries CUDA int8_float16 first, falls back to CPU int8 on failure.
    Probes via ctranslate2 (a hard dependency of faster-whisper) instead of
    torch, which is not installed by this skill and whose OpenMP runtime
    collides with onnxruntime's VAD runtime.
    """
    if os.environ.get("TOKENICODE_VIDEO_ASR_DEVICE", "").lower() == "cpu":
        return ("int8", "cpu")
    try:
        import ctranslate2
        if ctranslate2.get_cuda_device_count() > 0:
            return ("int8_float16", "cuda")
    except Exception:
        pass
    return ("int8", "cpu")


# ---------------------------------------------------------------------------
# 5. Parallel execution helper
# ---------------------------------------------------------------------------

def run_parallel_audio_video(
    audio_fn: Callable[[], Any],
    video_fn: Callable[[], Any],
) -> tuple[Any, Any, Optional[str], Optional[str]]:
    """Run audio and video extraction in parallel threads.

    Returns (audio_result, video_result, audio_error, video_error).
    Each error is None on success.
    """
    audio_result = None
    video_result = None
    audio_err = None
    video_err = None

    with ThreadPoolExecutor(max_workers=2) as pool:
        futures = {
            pool.submit(audio_fn): "audio",
            pool.submit(video_fn): "video",
        }
        for future in as_completed(futures):
            kind = futures[future]
            try:
                result = future.result()
                if kind == "audio":
                    audio_result = result
                else:
                    video_result = result
            except Exception as exc:
                if kind == "audio":
                    audio_err = str(exc)
                else:
                    video_err = str(exc)

    return audio_result, video_result, audio_err, video_err


# ---------------------------------------------------------------------------
# 6. Versioned content cache
# ---------------------------------------------------------------------------

def cache_key(
    source: Path | str,
    pipeline_version: str,
    asr_model: str,
    language: str | None,
    scene_threshold: float,
    phash_threshold: float,
    *,
    extra_params: str = "",
) -> str:
    """Build a stable cache key from source + pipeline parameters.

    *extra_params* is appended to the parameter blob before hashing so
    different stages (transcript vs vision) get distinct keys without
    duplicating the hashing logic.
    """
    source_str = str(source)
    if os.path.isfile(source_str):
        sha = hashlib.sha256()
        with open(source_str, "rb") as f:
            for chunk in iter(lambda: f.read(1 << 20), b""):
                sha.update(chunk)
        source_id = sha.hexdigest()[:16]
    else:
        source_id = hashlib.sha256(source_str.encode()).hexdigest()[:16]

    params = (
        f"v{pipeline_version}_model{asr_model}_lang{language or 'auto'}"
        f"_scene{scene_threshold}_phash{phash_threshold}"
    )
    if extra_params:
        params += f"|{extra_params}"
    return f"{source_id}_{hashlib.md5(params.encode()).hexdigest()[:8]}"


def load_cache_manifest(cache_dir: Path, key: str) -> dict[str, Any] | None:
    """Load a previously written cache manifest, or None if invalid/missing."""
    manifest = cache_dir / key / "manifest.json"
    if not manifest.is_file():
        return None
    try:
        data = json.loads(manifest.read_text(encoding="utf-8"))
        # Verify stored files exist
        for entry in data.get("entries", []):
            path = entry.get("path")
            expected_size = entry.get("size")
            if path:
                fpath = cache_dir / key / path
                if not fpath.is_file():
                    return None
                if expected_size is not None and fpath.stat().st_size != expected_size:
                    return None
        return data
    except (json.JSONDecodeError, OSError):
        return None


def save_cache_manifest(
    cache_dir: Path,
    key: str,
    data: dict[str, Any],
    entries: list[dict[str, Any]],
) -> None:
    """Atomically write a cache manifest."""
    manifest_dir = cache_dir / key
    manifest_dir.mkdir(parents=True, exist_ok=True)
    manifest = manifest_dir / "manifest.json"
    payload = {"key": key, "entries": entries, **data}
    tmp = manifest.with_suffix(".tmp")
    tmp.write_text(json.dumps(payload, ensure_ascii=False, indent=2), encoding="utf-8")
    tmp.replace(manifest)


def get_cache_dir(cache_root: str | None = None) -> Path:
    """Resolve the cache directory for acceleration artifacts."""
    if cache_root:
        return Path(cache_root)
    env_dir = os.environ.get("TOKENICODE_VIDEO_CACHE_DIR")
    if env_dir:
        return Path(env_dir)
    skill_dir = os.environ.get("TOKENICODE_VIDEO_SKILL_DIR")
    if skill_dir:
        return Path(skill_dir) / "cache"
    return Path.home() / ".tokenicode" / "video-cache"
