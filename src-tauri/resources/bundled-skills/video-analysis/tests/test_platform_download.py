from __future__ import annotations

import json
import shutil
import subprocess
import sys
import tempfile
import unittest
from pathlib import Path
from unittest import mock

SCRIPTS = Path(__file__).resolve().parents[1] / "scripts"
sys.path.insert(0, str(SCRIPTS))

import analyze_video  # noqa: E402
import platform_download  # noqa: E402
from safe_download import DirectMediaTypeError, DownloadSafetyError  # noqa: E402

FAKE_VIDEO_BYTES = b"\x00\x00\x00\x18ftypmp42fake-platform-video"


def fake_runner(*, returncode=0, stderr="", stdout="", create_file=True):
    calls: list[list[str]] = []

    def runner(argv, **kwargs):
        calls.append(list(argv))
        if create_file and returncode == 0:
            template = argv[argv.index("-o") + 1]
            Path(template.replace("%(ext)s", "mp4")).write_bytes(FAKE_VIDEO_BYTES)
        return subprocess.CompletedProcess(argv, returncode, stdout=stdout, stderr=stderr)

    runner.calls = calls  # type: ignore[attr-defined]
    return runner


def create_sample_video(directory: Path) -> Path:
    source = directory / "sample.mp4"
    subprocess.run(
        [
            "ffmpeg",
            "-y",
            "-f",
            "lavfi",
            "-i",
            "testsrc=size=320x240:rate=10",
            "-f",
            "lavfi",
            "-i",
            "sine=frequency=880:sample_rate=16000",
            "-t",
            "2",
            "-pix_fmt",
            "yuv420p",
            "-c:v",
            "libx264",
            "-c:a",
            "aac",
            str(source),
        ],
        check=True,
        capture_output=True,
        text=True,
    )
    return source


class PlatformDownloadPolicyTests(unittest.TestCase):
    def test_missing_yt_dlp_raises_install_hint(self):
        with self.assertRaises(platform_download.PlatformFetchError) as ctx:
            platform_download.download_platform_video(
                "https://platform.example/watch?v=1",
                Path("ignored"),
                max_bytes=1000,
                max_duration=60,
                finder=lambda: None,
            )
        self.assertIn("yt-dlp", str(ctx.exception))

    def test_rejects_non_http_scheme_before_any_fetch(self):
        runner = fake_runner()
        with self.assertRaises(DownloadSafetyError):
            platform_download.download_platform_video(
                "file:///d/video.mp4",
                Path("ignored"),
                max_bytes=1000,
                max_duration=60,
                finder=lambda: "/bin/yt-dlp",
                runner=runner,
            )
        self.assertEqual(runner.calls, [])

    def test_rejects_urls_with_embedded_credentials(self):
        runner = fake_runner()
        with self.assertRaises(DownloadSafetyError):
            platform_download.download_platform_video(
                "http://user:pw@127.0.0.1/watch",
                Path("ignored"),
                max_bytes=1000,
                max_duration=60,
                finder=lambda: "/bin/yt-dlp",
                runner=runner,
            )
        self.assertEqual(runner.calls, [])

    def test_argv_enforces_single_public_fetch_policy(self):
        runner = fake_runner()
        with mock.patch.object(
            platform_download, "assert_public_http_url", return_value=None
        ) as validator:
            with tempfile.TemporaryDirectory() as tmp:
                result = platform_download.download_platform_video(
                    "https://platform.example/watch?v=abc",
                    Path(tmp),
                    max_bytes=12345,
                    max_duration=90.0,
                    finder=lambda: "/bin/yt-dlp",
                    runner=runner,
                )
        validator.assert_called_once_with("https://platform.example/watch?v=abc")
        argv = runner.calls[0]
        self.assertIn("--no-playlist", argv)
        # DASH video+audio count as two downloads, so this cap would break merges.
        self.assertNotIn("--max-downloads", argv)
        self.assertEqual(argv[argv.index("--max-filesize") + 1], "12345")
        self.assertEqual(argv[argv.index("--match-filter") + 1], "duration <= 90 & !is_live")
        # H.264+m4a ≤720p is preferred so old ffmpeg builds can merge DASH parts,
        # vision models downscale anyway, and we avoid wasted bandwidth.
        # Falls back to best streams rather than a download-count cap.
        self.assertEqual(
            argv[argv.index("-f") + 1], "bv*[vcodec^=avc1][height<=720]+ba[ext=m4a]/bv*[height<=720]+ba/b"
        )
        self.assertEqual(argv[-1], "https://platform.example/watch?v=abc")
        for token in argv:
            self.assertNotIn("cookie", token.lower())
        self.assertNotIn("--no-check-certificates", argv)
        self.assertEqual(result.bytes_written, len(FAKE_VIDEO_BYTES))

    def test_member_only_video_is_refused_not_bypassed(self):
        runner = fake_runner(
            returncode=1,
            create_file=False,
            stderr="ERROR: [BiliBili] 这是一个大会员专属视频，请登录 (login required).",
        )
        with mock.patch.object(platform_download, "assert_public_http_url", return_value=None):
            with tempfile.TemporaryDirectory() as tmp:
                with self.assertRaises(platform_download.PlatformAccessRefused) as ctx:
                    platform_download.download_platform_video(
                        "https://platform.example/watch?v=vip",
                        Path(tmp),
                        max_bytes=12345,
                        max_duration=90.0,
                        finder=lambda: "/bin/yt-dlp",
                        runner=runner,
                    )
                self.assertFalse(list(Path(tmp).glob("platform-video.*")))
        self.assertIn("never sends credentials", str(ctx.exception))

    def test_merge_failure_points_to_local_file_workaround(self):
        runner = fake_runner(
            returncode=1,
            create_file=False,
            stderr="ERROR: Postprocessing: Stream #1:0 -> #0:1 (copy): Could not write header",
        )
        with mock.patch.object(platform_download, "assert_public_http_url", return_value=None):
            with tempfile.TemporaryDirectory() as tmp:
                with self.assertRaises(platform_download.PlatformFetchError) as ctx:
                    platform_download.download_platform_video(
                        "https://platform.example/watch?v=merge",
                        Path(tmp),
                        max_bytes=12345,
                        max_duration=90.0,
                        finder=lambda: "/bin/yt-dlp",
                        runner=runner,
                    )
                self.assertFalse(list(Path(tmp).glob("platform-video.*")))
        message = str(ctx.exception)
        self.assertIn("ffmpeg could not merge", message)
        self.assertIn("--input", message)
        # A merge failure is an environment problem, not an access-control one.
        self.assertNotIsInstance(ctx.exception, platform_download.PlatformAccessRefused)

    def test_no_output_file_reports_honest_failure(self):
        runner = fake_runner(
            returncode=0,
            create_file=False,
            stderr="[download] Skipping video, duration 3600 exceeds limit",
        )
        with mock.patch.object(platform_download, "assert_public_http_url", return_value=None):
            with tempfile.TemporaryDirectory() as tmp:
                with self.assertRaises(platform_download.PlatformFetchError):
                    platform_download.download_platform_video(
                        "https://platform.example/watch?v=long",
                        Path(tmp),
                        max_bytes=12345,
                        max_duration=90.0,
                        finder=lambda: "/bin/yt-dlp",
                        runner=runner,
                    )

    def test_oversized_result_is_removed(self):
        runner = fake_runner()
        with mock.patch.object(platform_download, "assert_public_http_url", return_value=None):
            with tempfile.TemporaryDirectory() as tmp:
                with self.assertRaises(platform_download.PlatformFetchError):
                    platform_download.download_platform_video(
                        "https://platform.example/watch?v=big",
                        Path(tmp),
                        max_bytes=len(FAKE_VIDEO_BYTES) - 1,
                        max_duration=90.0,
                        finder=lambda: "/bin/yt-dlp",
                        runner=runner,
                    )
                self.assertFalse(list(Path(tmp).glob("platform-video.*")))


class AnalyzerPlatformRoutingTests(unittest.TestCase):
    def test_platform_page_without_flag_is_rejected_with_hint(self):
        with tempfile.TemporaryDirectory() as tmp:
            args = analyze_video.build_parser().parse_args(
                [
                    "--url",
                    "https://platform.example/watch?v=abc",
                    "--output-dir",
                    str(Path(tmp) / "out"),
                ]
            )
            with mock.patch.object(
                analyze_video, "download_public_video", side_effect=DirectMediaTypeError("text/html")
            ):
                with self.assertRaises(analyze_video.PipelineError) as ctx:
                    analyze_video.analyze(args)
        self.assertIn("--allow-platform", str(ctx.exception))

    def test_allow_platform_routes_to_platform_downloader(self):
        if not shutil.which("ffmpeg") or not shutil.which("ffprobe"):
            raise unittest.SkipTest("ffmpeg and ffprobe are required for this routing test")
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            sample = create_sample_video(root)
            output = root / "out"
            argv = [
                "--url",
                "https://platform.example/watch?v=abc",
                "--output-dir",
                str(output),
                "--frame-interval",
                "0.5",
                "--allow-platform",
                "--skip-asr",
                "--skip-vision",
            ]

            def fake_platform(url, destination_dir, *, max_bytes, max_duration):
                target = Path(destination_dir) / "platform-video.mp4"
                shutil.copy(sample, target)
                return platform_download.PlatformFetchResult(
                    path=target, url=url, bytes_written=target.stat().st_size
                )

            with mock.patch.object(
                analyze_video, "download_public_video", side_effect=DirectMediaTypeError("text/html")
            ), mock.patch.object(platform_download, "download_platform_video", side_effect=fake_platform):
                exit_code = analyze_video.main(argv)
            self.assertEqual(exit_code, 0)
            analysis = json.loads((output / "analysis.json").read_text(encoding="utf-8"))
            self.assertEqual(
                analysis["provenance"]["source_acquisition"],
                {"method": "platform_extraction", "tool": "yt-dlp"},
            )
            media = json.loads((output / "media.json").read_text(encoding="utf-8"))
            self.assertEqual(media["source"]["acquisition"]["method"], "platform_extraction")
            self.assertTrue(any("yt-dlp" in item for item in analysis["limitations"]))
            report = (output / "report.md").read_text(encoding="utf-8")
            self.assertIn("platform page extracted with `yt-dlp`", report)


if __name__ == "__main__":
    unittest.main()
