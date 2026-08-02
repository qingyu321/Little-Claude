"""Fetch a single public video from a video-platform page via yt-dlp.

This module is intentionally narrow: one publicly accessible video per call, no
playlists, no cookies, no login of any kind, and no DRM circumvention. Content
that requires authentication, membership, or decryption is refused with an honest
error instead of being worked around. Platform terms of service and content
authorization remain the caller's responsibility.
"""

from __future__ import annotations

import shutil
import subprocess
from dataclasses import dataclass
from pathlib import Path
from typing import Callable

from safe_download import assert_public_http_url

OUTPUT_STEM = "platform-video"
FETCH_TIMEOUT_SECONDS = 900
MAX_STDERR_SNIPPET = 400

# yt-dlp output markers indicating the content is not anonymously public.
ACCESS_BLOCK_MARKERS = (
    "login",
    "log in",
    "sign in",
    "cookies",
    "member",
    "vip",
    "premium",
    "private",
    "password",
    "subscription",
    "subscriber",
    "age gate",
    "age-gate",
    "age verification",
    "verify your age",
    "drm",
    "widevine",
    "fairplay",
    "登录",
    "会员",
    "密码",
    "私密",
    "仅自己可见",
    "好友可见",
    "加密",
)


class PlatformFetchError(RuntimeError):
    """Raised when yt-dlp is missing, fails, or produces no usable file."""


class PlatformAccessRefused(PlatformFetchError):
    """Raised when the platform demands login, membership, or DRM. Never worked around."""


@dataclass(frozen=True)
class PlatformFetchResult:
    path: Path
    url: str
    bytes_written: int


def find_yt_dlp() -> str | None:
    return shutil.which("yt-dlp")


def _stderr_snippet(output: str) -> str:
    lines = [line.strip() for line in output.splitlines() if line.strip()]
    return " | ".join(lines[-3:])[:MAX_STDERR_SNIPPET]


def _access_is_blocked(output: str) -> bool:
    lowered = output.lower()
    return any(marker in lowered for marker in ACCESS_BLOCK_MARKERS)


def _merge_failed(output: str) -> bool:
    """Detect yt-dlp postprocessing/ffmpeg merge failures (often an outdated local ffmpeg)."""
    lowered = output.lower()
    return "error: postprocessing" in lowered or "stream #" in lowered


def build_argv(
    yt_dlp: str,
    url: str,
    output_template: str,
    *,
    max_bytes: int,
    max_duration: float,
    ffmpeg_location: str | None,
) -> list[str]:
    argv = [
        yt_dlp,
        # --no-playlist already limits the fetch to one video; --max-downloads is
        # deliberately NOT used because DASH video+audio count as two downloads
        # and the cap would abort before the ffmpeg merge step.
        "--no-playlist",
        "--max-filesize",
        str(max_bytes),
        "--match-filter",
        f"duration <= {int(max_duration)} & !is_live",
        "-f",
        # Prefer H.264 (avc1) video plus m4a audio: the combination any ffmpeg
        # build can merge, including old ones that fail on HEVC/AV1 DASH parts.
        # Limit video resolution to 720p: vision models downscale anyway, and
        # higher resolutions waste bandwidth + disk without improving analysis.
        # Fall back to the best available streams, then a single best file.
        "bv*[vcodec^=avc1][height<=720]+ba[ext=m4a]/bv*[height<=720]+ba/b",
        "--merge-output-format",
        "mp4",
        "--no-part",
        "--quiet",
        "--no-progress",
        "--socket-timeout",
        "30",
        "--retries",
        "2",
        "-o",
        output_template,
    ]
    if ffmpeg_location:
        argv += ["--ffmpeg-location", ffmpeg_location]
    argv.append(url)
    return argv


def download_platform_video(
    url: str,
    destination_dir: Path,
    *,
    max_bytes: int,
    max_duration: float,
    finder: Callable[[], str | None] = find_yt_dlp,
    runner: Callable[..., "subprocess.CompletedProcess[str]"] = subprocess.run,
) -> PlatformFetchResult:
    """Fetch one public platform video; refuses anything needing credentials or DRM."""
    yt_dlp = finder()
    if not yt_dlp:
        raise PlatformFetchError(
            "yt-dlp is not installed. Install it (pip install yt-dlp) or use a direct media URL or a local file."
        )
    if max_bytes <= 0:
        raise ValueError("max_bytes must be positive")
    if max_duration <= 0:
        raise ValueError("max_duration must be positive")
    # Reuse the SSRF-safe validator: scheme, embedded credentials, and private
    # addresses are rejected before yt-dlp ever sees the URL.
    assert_public_http_url(url)

    destination_dir.mkdir(parents=True, exist_ok=True)
    template = str(destination_dir / f"{OUTPUT_STEM}.%(ext)s")
    ffmpeg = shutil.which("ffmpeg")
    argv = build_argv(
        yt_dlp,
        url,
        template,
        max_bytes=max_bytes,
        max_duration=max_duration,
        ffmpeg_location=str(Path(ffmpeg).parent) if ffmpeg else None,
    )
    try:
        completed = runner(
            argv,
            capture_output=True,
            text=True,
            encoding="utf-8",
            errors="replace",
            timeout=FETCH_TIMEOUT_SECONDS,
        )
    except subprocess.TimeoutExpired as exc:
        raise PlatformFetchError("yt-dlp timed out while fetching the platform video.") from exc

    output = f"{completed.stdout or ''}\n{completed.stderr or ''}"
    produced = sorted(destination_dir.glob(f"{OUTPUT_STEM}.*"))
    if completed.returncode != 0 or not produced:
        for leftover in produced:
            leftover.unlink(missing_ok=True)
        if _merge_failed(output):
            raise PlatformFetchError(
                "yt-dlp downloaded the streams but ffmpeg could not merge them (the local "
                "ffmpeg may be too old for the selected codecs; H.264+m4a was already preferred). "
                "Download the video yourself by authorized means and rerun with --input, or "
                f"install a current ffmpeg. yt-dlp said: {_stderr_snippet(output)}"
            )
        if _access_is_blocked(output):
            raise PlatformAccessRefused(
                "The platform refused anonymous public access (login, membership, private, "
                "age-gate, or DRM). This skill never sends credentials or bypasses access "
                f"controls; provide an authorized file or direct media URL instead. yt-dlp said: {_stderr_snippet(output)}"
            )
        raise PlatformFetchError(
            "yt-dlp could not fetch this platform video (it may be unavailable, longer than "
            f"--max-duration, or larger than --max-download-bytes): "
            f"{_stderr_snippet(output) or '(yt-dlp produced no error output)'}"
        )

    primary, *extras = produced
    for extra in extras:
        extra.unlink(missing_ok=True)
    bytes_written = primary.stat().st_size
    if bytes_written > max_bytes:
        primary.unlink(missing_ok=True)
        raise PlatformFetchError("The fetched platform video exceeds the download size limit.")
    return PlatformFetchResult(path=primary, url=url, bytes_written=bytes_written)
