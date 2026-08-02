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
import providers as provider_layer  # noqa: E402


def fake_vision_provider(observations_by_batch: list[list[dict]]) -> provider_layer.VisionProvider:
    calls: list[list[dict]] = []
    iterator = iter(observations_by_batch)

    class Provider:
        def __init__(self):
            self.spec = provider_layer.ProviderSpec(
                stage="vision",
                provider="openai",
                model="gpt-5",
                api_key_env="OPENAI_API_KEY",
                base_url=None,
                remote=True,
                supports_images=True,
                data_sent=("jpeg_frames_base64",),
            )

        def analyze_batch(self, frames):
            calls.append(frames)
            return next(iterator)

    provider = Provider()
    provider.calls = calls  # type: ignore[attr-defined]
    return provider


def fake_synthesis_provider(report: dict) -> provider_layer.SynthesisProvider:
    class Provider:
        def __init__(self):
            self.spec = provider_layer.ProviderSpec(
                stage="synthesis",
                provider="deepseek",
                model="deepseek-v4-pro",
                api_key_env="DEEPSEEK_API_KEY",
                base_url="https://api.deepseek.com",
                remote=True,
                supports_images=False,
                data_sent=("timeline_text",),
            )
            self.payload = None

        def synthesize(self, payload):
            self.payload = payload
            return report

    return Provider()


class MediaPipelineTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        if not shutil.which("ffmpeg") or not shutil.which("ffprobe"):
            raise unittest.SkipTest("ffmpeg and ffprobe are required for the local media integration test")

    def create_sample_video(self, directory: Path) -> Path:
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

    def test_offline_pipeline_generates_honest_artifacts(self):
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            source = self.create_sample_video(root)
            output = root / "result"
            exit_code = analyze_video.main(
                [
                    "--input",
                    str(source),
                    "--output-dir",
                    str(output),
                    "--frame-interval",
                    "0.5",
                    "--skip-asr",
                    "--skip-vision",
                    "--accel-cache-dir",
                    str(root / "accel-cache"),
                ]
            )
            self.assertEqual(exit_code, 0)
            for filename in [
                "media.json",
                "frames.json",
                "transcript.json",
                "vision.json",
                "timeline.json",
                "analysis.json",
                "report.md",
            ]:
                self.assertTrue((output / filename).is_file(), filename)
            media = json.loads((output / "media.json").read_text(encoding="utf-8"))
            frames = json.loads((output / "frames.json").read_text(encoding="utf-8"))
            analysis = json.loads((output / "analysis.json").read_text(encoding="utf-8"))
            self.assertGreater(media["duration_seconds"], 1)
            self.assertGreaterEqual(len(frames), 3)
            self.assertEqual(frames[0]["timestamp_seconds"], 0.0)
            self.assertIn("Speech transcription was skipped by request.", analysis["limitations"])
            self.assertIn("Frame interpretation was skipped by request.", analysis["limitations"])
            self.assertEqual(analysis["provenance"]["stages"]["vision"]["status"], "skipped")
            self.assertEqual(analysis["provenance"]["stages"]["synthesis"]["status"], "not_requested")
            self.assertFalse((output / ".processing").exists())

    def test_audio_extraction_and_timestamp_alignment(self):
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            source = self.create_sample_video(root)
            audio = root / "audio.wav"
            analyze_video.extract_audio(source, audio)
            self.assertGreater(audio.stat().st_size, 1000)
            timeline = analyze_video.build_timeline(
                duration_seconds=620,
                transcript=[{"start_seconds": 10, "end_seconds": 12, "text": "first"}],
                observations=[{"timestamp_seconds": 310, "scene": "second window"}],
                window_seconds=300,
            )
            self.assertEqual(len(timeline), 3)
            self.assertEqual(timeline[0]["transcript_segments"][0]["text"], "first")
            self.assertEqual(timeline[1]["visual_observations"][0]["scene"], "second window")

    def test_mocked_vision_and_synthesis_generate_structured_report(self):
        with tempfile.TemporaryDirectory() as tmp:
            image_path = Path(tmp) / "frame.jpg"
            image_path.write_bytes(b"not-decoded-by-mock")
            frames = [
                {"timestamp_seconds": 0.0, "path": str(image_path)},
                {"timestamp_seconds": 3.0, "path": str(image_path)},
            ]
            observations = analyze_video.analyze_frame_batches(
                frames,
                batch_size=2,
                vision_provider=fake_vision_provider(
                    [
                        [
                            {
                                "scene": "desk",
                                "visible_text": [],
                                "actions": [],
                                "important_objects": [],
                                "is_key_moment": False,
                            },
                            {
                                "scene": "screen",
                                "visible_text": ["Hello"],
                                "actions": [],
                                "important_objects": [],
                                "is_key_moment": True,
                            },
                        ]
                    ]
                ),
            )
            self.assertEqual(observations[1]["timestamp_seconds"], 3.0)
            self.assertTrue(observations[1]["is_key_moment"])

            synthesis_provider = fake_synthesis_provider(
                {
                    "title": "Test report",
                    "summary": "A screen appears.",
                    "chapters": [],
                    "key_moments": [{"timestamp_seconds": 3, "description": "Screen text"}],
                    "limitations": [],
                }
            )
            report = analyze_video.synthesize_analysis(
                source_label="test.mp4",
                duration_seconds=4,
                timeline=[],
                limitations=[],
                evidence_modalities=["visual_observations"],
                synthesis_provider=synthesis_provider,
            )
            self.assertEqual(report["title"], "Test report")
            self.assertEqual(report["key_moments"][0]["timestamp_seconds"], 3)


    def test_skip_vision_conflicts_with_remote_provider(self):
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            source = self.create_sample_video(root)
            output = root / "conflict"
            exit_code = analyze_video.main(
                [
                    "--input",
                    str(source),
                    "--output-dir",
                    str(output),
                    "--skip-vision",
                    "--vision-provider",
                    "openai",
                ]
            )
            self.assertEqual(exit_code, 1)

    def test_vision_failure_can_still_use_transcript_only_synthesis(self):
        class FailingVisionProvider:
            def __init__(self):
                self.spec = provider_layer.ProviderSpec(
                    stage="vision",
                    provider="openai",
                    model="gpt-5",
                    api_key_env="OPENAI_API_KEY",
                    base_url=None,
                    remote=True,
                    supports_images=True,
                    data_sent=("jpeg_frames_base64",),
                )
                self.calls = 0

            def analyze_batch(self, frames):
                self.calls += 1
                raise RuntimeError("provider unavailable")

        synthesis_provider = fake_synthesis_provider(
            {
                "title": "Transcript report",
                "summary": "From transcript only.",
                "chapters": [],
                "key_moments": [],
                "limitations": [],
            }
        )
        vision_provider = FailingVisionProvider()

        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            source = self.create_sample_video(root)
            output = root / "result"
            args = analyze_video.build_parser().parse_args(
                [
                    "--input",
                    str(source),
                    "--output-dir",
                    str(output),
                    "--frame-interval",
                    "0.5",
                    "--skip-asr",
                    "--vision-provider",
                    "openai",
                    "--synthesis-provider",
                    "deepseek",
                ]
            )
            limitations: list[str] = []
            frames = analyze_video.extract_frames(
                source,
                output / ".processing" / "frames",
                interval_seconds=args.frame_interval,
                duration_seconds=2,
            )
            observations = analyze_video.analyze_frame_batches(
                frames, batch_size=8, vision_provider=vision_provider
            )
            self.assertTrue(all("batch_error" in item for item in observations))
            timeline = analyze_video.build_timeline(
                duration_seconds=2,
                transcript=[{"start_seconds": 0, "end_seconds": 1, "text": "hello"}],
                observations=observations,
                window_seconds=300,
            )
            report = analyze_video.synthesize_analysis(
                source_label="sample.mp4",
                duration_seconds=2,
                timeline=timeline,
                limitations=limitations,
                evidence_modalities=["transcript"],
                synthesis_provider=synthesis_provider,
            )
            self.assertEqual(report["title"], "Transcript report")
            self.assertEqual(synthesis_provider.payload["available_evidence_modalities"], ["transcript"])

    def test_custom_vision_probe_failure_produces_honest_report(self):
        fake_spec = provider_layer.ProviderSpec(
            stage="vision",
            provider="custom",
            model="text-only-model",
            api_key_env="CUSTOM_API_KEY",
            base_url="https://relay.example.com/v1",
            remote=True,
            supports_images=True,
            data_sent=("jpeg_frames_base64", "frame_timestamps", "vision_instruction"),
        )
        probe_failure = {
            "probed": True,
            "ok": False,
            "detail": (
                "The endpoint rejected a single test image, so model 'text-only-model' "
                "does not appear to support image input."
            ),
        }
        fake_provider = provider_layer.VisionProvider(fake_spec, client=None)
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            source = self.create_sample_video(root)
            output = root / "probe-fail"
            with mock.patch.object(
                provider_layer, "create_vision_provider", return_value=fake_provider
            ), mock.patch.object(
                provider_layer.VisionProvider, "probe_image_input", return_value=probe_failure
            ):
                exit_code = analyze_video.main(
                    [
                        "--input",
                        str(source),
                        "--output-dir",
                        str(output),
                        "--frame-interval",
                        "0.5",
                        "--skip-asr",
                        "--vision-provider",
                        "custom",
                        "--custom-base-url",
                        "https://relay.example.com/v1",
                        "--vision-model",
                        "text-only-model",
                        "--accel-cache-dir",
                        str(root / "accel-cache"),
                    ]
                )
            self.assertEqual(exit_code, 0)
            analysis = json.loads((output / "analysis.json").read_text(encoding="utf-8"))
            vision_stage = analysis["provenance"]["stages"]["vision"]
            self.assertEqual(vision_stage["status"], "failed")
            self.assertEqual(vision_stage["base_url"], "https://relay.example.com/v1")
            self.assertIn("probe", vision_stage)
            self.assertTrue(
                any("does not appear to support image input" in item for item in analysis["limitations"])
            )


    def test_asr_native_crash_is_contained_as_nonfatal_limitation(self):
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            source = self.create_sample_video(root)
            output = root / "crash"
            with mock.patch.object(
                analyze_video,
                "run_asr_subprocess",
                side_effect=RuntimeError(
                    "ASR worker crashed (exit code 3221226505); stderr tail: OpenMP: Error 1"
                ),
            ):
                exit_code = analyze_video.main(
                    [
                        "--input",
                        str(source),
                        "--output-dir",
                        str(output),
                        "--frame-interval",
                        "0.5",
                        "--skip-vision",
                        "--accel-cache-dir",
                        str(root / "accel-cache"),
                    ]
                )
            # A native ASR abort must degrade the pipeline, not kill it.
            self.assertEqual(exit_code, 0)
            self.assertEqual(json.loads((output / "transcript.json").read_text(encoding="utf-8")), [])
            analysis = json.loads((output / "analysis.json").read_text(encoding="utf-8"))
            self.assertEqual(analysis["provenance"]["stages"]["asr"]["status"], "failed")
            self.assertIn("3221226505", analysis["provenance"]["stages"]["asr"]["detail"])
            self.assertTrue(
                any("Speech transcription failed" in item for item in analysis["limitations"])
            )

    def test_asr_subprocess_success_writes_transcript(self):
        fixed = [
            {
                "start_seconds": 0.0,
                "end_seconds": 1.0,
                "text": "hello",
                "language": "en",
                "language_probability": 0.9,
            }
        ]
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            source = self.create_sample_video(root)
            output = root / "asr-ok"
            with mock.patch.object(analyze_video, "run_asr_subprocess", return_value=fixed):
                exit_code = analyze_video.main(
                    [
                        "--input",
                        str(source),
                        "--output-dir",
                        str(output),
                        "--frame-interval",
                        "0.5",
                        "--skip-vision",
                        "--accel-cache-dir",
                        str(root / "accel-cache"),
                    ]
                )
            self.assertEqual(exit_code, 0)
            self.assertEqual(json.loads((output / "transcript.json").read_text(encoding="utf-8")), fixed)
            analysis = json.loads((output / "analysis.json").read_text(encoding="utf-8"))
            self.assertEqual(analysis["provenance"]["stages"]["asr"]["status"], "succeeded")
            self.assertEqual(analysis["provenance"]["stages"]["asr"]["segment_count"], 1)

    def test_vision_batches_dispatch_concurrently_in_submission_order(self):
        import threading

        second_started = threading.Event()

        class ConcurrencyProbeProvider:
            def analyze_batch(self, frames):
                if frames[0]["timestamp_seconds"] >= 4.0:
                    second_started.set()
                else:
                    # The first batch blocks until the second batch starts —
                    # only satisfiable when batches run concurrently.
                    if not second_started.wait(timeout=2.0):
                        raise RuntimeError("batches ran serially")
                return [
                    {
                        "timestamp_seconds": frame["timestamp_seconds"],
                        "scene": "scene",
                        "visible_text": [],
                        "actions": [],
                        "important_objects": [],
                        "is_key_moment": False,
                    }
                    for frame in frames
                ]

        frames = [{"timestamp_seconds": float(index), "path": f"f{index}.jpg"} for index in range(8)]
        observations = analyze_video.analyze_frame_batches(
            frames,
            batch_size=4,
            vision_provider=ConcurrencyProbeProvider(),
            concurrency=2,
        )
        # Overlap happened and submission order is preserved.
        self.assertTrue(second_started.is_set())
        self.assertEqual([item["timestamp_seconds"] for item in observations], [float(i) for i in range(8)])

    def test_serial_batches_contain_errors_in_place(self):
        import threading

        second_started = threading.Event()

        class ConcurrencyProbeProvider:
            def analyze_batch(self, frames):
                if frames[0]["timestamp_seconds"] >= 4.0:
                    second_started.set()
                elif not second_started.wait(timeout=0.3):
                    raise RuntimeError("batches ran serially")
                return [
                    {"timestamp_seconds": frame["timestamp_seconds"], "scene": "s", "visible_text": [], "actions": [], "important_objects": [], "is_key_moment": False}
                    for frame in frames
                ]

        frames = [{"timestamp_seconds": float(index), "path": f"f{index}.jpg"} for index in range(8)]
        observations = analyze_video.analyze_frame_batches(
            frames,
            batch_size=4,
            vision_provider=ConcurrencyProbeProvider(),
            concurrency=1,  # serial: batch 0 times out and becomes a batch_error entry
        )
        self.assertIn("batch_error", observations[0])
        self.assertEqual(observations[0]["batch_start_seconds"], 0.0)
        self.assertEqual(observations[1]["timestamp_seconds"], 4.0)

    def test_acceleration_is_on_by_default_and_opts_out(self):
        for extra, expected in (([], True), (["--no-accelerate"], False)):
            with tempfile.TemporaryDirectory() as tmp:
                root = Path(tmp)
                source = self.create_sample_video(root)
                output = root / "accel"
                exit_code = analyze_video.main(
                    [
                        "--input",
                        str(source),
                        "--output-dir",
                        str(output),
                        "--frame-interval",
                        "0.5",
                        "--skip-asr",
                        "--skip-vision",
                        "--accel-cache-dir",
                        str(root / "accel-cache"),
                        *extra,
                    ]
                )
                self.assertEqual(exit_code, 0)
                analysis = json.loads((output / "analysis.json").read_text(encoding="utf-8"))
                self.assertEqual(analysis["provenance"]["acceleration"]["requested"], expected)
                self.assertEqual(analysis["provenance"]["acceleration"]["effective"], expected)
                self.assertIn("stage_durations_seconds", analysis["provenance"])

    def test_second_run_hits_transcript_and_vision_cache(self):
        asr_calls = {"n": 0}

        def fake_asr(audio_path, *, model, language, duration_seconds, accel_stats=None):
            asr_calls["n"] += 1
            return [
                {
                    "start_seconds": 0.0,
                    "end_seconds": 1.0,
                    "text": "cache me",
                    "language": "zh",
                    "language_probability": 0.9,
                }
            ]

        vision_batches = {"n": 0}

        class CountingVisionProvider:
            spec = provider_layer.ProviderSpec(
                stage="vision",
                provider="openai",
                model="gpt-5",
                api_key_env="OPENAI_API_KEY",
                base_url=None,
                remote=True,
                supports_images=True,
                data_sent=("jpeg_frames_base64",),
            )

            def probe_image_input(self, frame_path=None):
                return {"probed": False, "ok": True, "detail": ""}

            def analyze_batch(self, frames):
                vision_batches["n"] += 1
                return [
                    {"scene": "grid", "visible_text": [], "actions": [], "important_objects": [], "is_key_moment": False}
                    for _ in frames
                ]

        argv_template = [
            "--frame-interval",
            "0.5",
            "--vision-provider",
            "openai",
        ]
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            source = self.create_sample_video(root)
            cache_dir = root / "accel-cache"
            runs = []
            for index in range(2):
                output = root / f"run{index}"
                argv = [
                    "--input",
                    str(source),
                    "--output-dir",
                    str(output),
                    "--accel-cache-dir",
                    str(cache_dir),
                    *argv_template,
                ]
                args = analyze_video.build_parser().parse_args(argv)
                with mock.patch.object(
                    analyze_video, "run_asr_subprocess", side_effect=fake_asr
                ), mock.patch.object(
                    provider_layer, "create_vision_provider", return_value=CountingVisionProvider()
                ):
                    analysis = analyze_video.analyze(args)
                runs.append(analysis)

        # Run 1 computed both stages.
        self.assertEqual(asr_calls["n"], 1)
        first_vision_calls = vision_batches["n"]
        self.assertGreaterEqual(first_vision_calls, 1)
        self.assertEqual(runs[0]["provenance"]["acceleration"]["cache"]["saved"], ["transcript", "vision"])
        # Run 2 served both stages from the cache — zero new API work.
        self.assertEqual(asr_calls["n"], 1)
        self.assertEqual(vision_batches["n"], first_vision_calls)
        accel = runs[1]["provenance"]["acceleration"]
        self.assertTrue(accel["cache"]["transcript_hit"])
        self.assertTrue(accel["cache"]["vision_hit"])
        stages = runs[1]["provenance"]["stages"]
        self.assertTrue(stages["asr"]["cache_hit"])
        self.assertTrue(stages["vision"]["cache_hit"])
        self.assertEqual(stages["vision"]["status"], "succeeded")
        # The cached vision evidence is identical.
        self.assertEqual(runs[0]["provenance"]["vision_observation_count"], runs[1]["provenance"]["vision_observation_count"])


if __name__ == "__main__":
    unittest.main()
