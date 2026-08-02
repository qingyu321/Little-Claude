from __future__ import annotations

import json
import os
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


def parse(argv: list[str]):
    return analyze_video.build_parser().parse_args(argv)


def custom_argv(*extra: str) -> list[str]:
    return [
        "--input",
        "video.mp4",
        "--output-dir",
        "out",
        "--custom-base-url",
        "https://relay.example.com/v1",
        "--custom-model",
        "qwen3.6-vl",
        *extra,
    ]


class CustomDefaultsTests(unittest.TestCase):
    def test_custom_model_fills_both_stage_models(self):
        args = parse(custom_argv("--vision-provider", "custom", "--synthesis-provider", "custom"))
        analyze_video.apply_custom_defaults(args, environ={"CUSTOM_API_KEY": "k"})
        self.assertEqual(args.vision_model, "qwen3.6-vl")
        self.assertEqual(args.synthesis_model, "qwen3.6-vl")

    def test_per_stage_models_take_precedence_over_custom_model(self):
        args = parse(custom_argv("--synthesis-model", "text-model"))
        analyze_video.apply_custom_defaults(args, environ={"CUSTOM_API_KEY": "k"})
        self.assertEqual(args.vision_model, "qwen3.6-vl")
        self.assertEqual(args.synthesis_model, "text-model")

    def test_key_endpoint_and_model_auto_select_custom_for_vision_only(self):
        args = parse(custom_argv())
        notes = analyze_video.apply_custom_defaults(args, environ={"CUSTOM_API_KEY": "k"})
        self.assertEqual(args.vision_provider, provider_layer.CUSTOM)
        # Synthesis is deliberately left off: the calling agent reports from evidence.
        self.assertEqual(args.synthesis_provider, provider_layer.NONE)
        self.assertTrue(any("auto-selected" in note for note in notes))
        self.assertTrue(any("Synthesis is not run by default" in note for note in notes))

    def test_missing_key_keeps_remote_stages_disabled(self):
        args = parse(custom_argv())
        notes = analyze_video.apply_custom_defaults(args, environ={})
        self.assertEqual(args.vision_provider, provider_layer.NONE)
        self.assertEqual(args.synthesis_provider, provider_layer.NONE)
        self.assertTrue(any("CUSTOM_API_KEY" in note for note in notes))

    def test_explicit_provider_choice_is_never_overridden(self):
        args = parse(
            custom_argv("--vision-provider", "openai", "--synthesis-provider", "deepseek")
        )
        notes = analyze_video.apply_custom_defaults(args, environ={"CUSTOM_API_KEY": "k"})
        self.assertEqual(args.vision_provider, provider_layer.OPENAI)
        self.assertEqual(args.synthesis_provider, provider_layer.DEEPSEEK)
        self.assertEqual(args.vision_model, "qwen3.6-vl")
        self.assertEqual(notes, [])

    def test_custom_api_key_env_name_is_respected(self):
        args = parse(custom_argv("--custom-api-key-env", "RELAY_KEY"))
        notes = analyze_video.apply_custom_defaults(args, environ={"RELAY_KEY": "k"})
        self.assertEqual(args.vision_provider, provider_layer.CUSTOM)
        self.assertEqual(args.synthesis_provider, provider_layer.NONE)  # synthesis stays opt-in
        notes = analyze_video.apply_custom_defaults(parse(custom_argv("--custom-api-key-env", "RELAY_KEY")), environ={})
        self.assertTrue(any("RELAY_KEY" in note for note in notes))

    def test_vision_concurrency_parses_and_validates(self):
        args = parse(custom_argv("--vision-concurrency", "2"))
        self.assertEqual(args.vision_concurrency, 2)
        self.assertEqual(parse(custom_argv()).vision_concurrency, 4)  # default
        bad = parse(custom_argv("--vision-concurrency", "0"))
        with self.assertRaises(analyze_video.PipelineError):
            analyze_video.analyze(bad)


class CustomAutoSelectPipelineTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        if not shutil.which("ffmpeg") or not shutil.which("ffprobe"):
            raise unittest.SkipTest("ffmpeg and ffprobe are required for the auto-select pipeline test")

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

    def test_key_endpoint_and_model_run_vision_by_default_synthesis_on_request(self):
        vision_spec = provider_layer.ProviderSpec(
            stage="vision",
            provider="custom",
            model="qwen3.6-vl",
            api_key_env="CUSTOM_API_KEY",
            base_url="https://relay.example.com/v1",
            remote=True,
            supports_images=True,
            data_sent=("jpeg_frames_base64", "frame_timestamps", "vision_instruction"),
        )
        synthesis_spec = provider_layer.ProviderSpec(
            stage="synthesis",
            provider="custom",
            model="qwen3.6-vl",
            api_key_env="CUSTOM_API_KEY",
            base_url="https://relay.example.com/v1",
            remote=True,
            supports_images=False,
            data_sent=("timeline_text",),
        )

        class FakeVisionProvider:
            def __init__(self):
                self.spec = vision_spec
                self.probed = False

            def probe_image_input(self, frame_path=None):
                self.probed = True
                return {"probed": True, "ok": True, "detail": "The endpoint accepted a test image."}

            def analyze_batch(self, frames):
                return [
                    {
                        "timestamp_seconds": frame["timestamp_seconds"],
                        "scene": "test pattern",
                        "visible_text": [],
                        "actions": [],
                        "important_objects": [],
                        "is_key_moment": False,
                    }
                    for frame in frames
                ]

        class FakeSynthesisProvider:
            def __init__(self):
                self.spec = synthesis_spec

            def synthesize(self, payload):
                return {
                    "title": "Custom endpoint report",
                    "summary": "Generated through the user-supplied endpoint.",
                    "chapters": [],
                    "key_moments": [],
                    "limitations": [],
                }

        vision_provider = FakeVisionProvider()
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            source = self.create_sample_video(root)

            def argv_for(output_dir: Path, *extra: str) -> list[str]:
                return [
                    "--input",
                    str(source),
                    "--output-dir",
                    str(output_dir),
                    "--frame-interval",
                    "0.5",
                    "--skip-asr",
                    "--custom-base-url",
                    "https://relay.example.com/v1",
                    "--custom-model",
                    "qwen3.6-vl",
                    # Isolate the acceleration cache in the temp dir so a
                    # previous run's hit cannot skip the mocked vision stage.
                    "--accel-cache-dir",
                    str(root / "accel-cache"),
                    *extra,
                ]

            with mock.patch.dict(os.environ, {"CUSTOM_API_KEY": "test-key"}), mock.patch.object(
                provider_layer, "create_vision_provider", return_value=vision_provider
            ), mock.patch.object(
                provider_layer, "create_synthesis_provider", return_value=FakeSynthesisProvider()
            ):
                # Run 1 — default flow: vision auto-selected, synthesis stays off
                # so the calling agent reports from the evidence directly.
                self.assertEqual(analyze_video.main(argv_for(root / "run1")), 0)
                # Run 2 — explicit --synthesis-provider opts the report stage in.
                self.assertEqual(
                    analyze_video.main(argv_for(root / "run2", "--synthesis-provider", "custom")), 0
                )

            self.assertTrue(vision_provider.probed)
            analysis = json.loads((root / "run1" / "analysis.json").read_text(encoding="utf-8"))
            stages = analysis["provenance"]["stages"]
            self.assertEqual(stages["vision"]["status"], "succeeded")
            self.assertEqual(stages["vision"]["provider"], "custom")
            self.assertEqual(stages["vision"]["base_url"], "https://relay.example.com/v1")
            self.assertEqual(stages["synthesis"]["status"], "not_requested")
            self.assertNotEqual(analysis["title"], "Custom endpoint report")
            self.assertTrue(any("auto-selected" in item for item in analysis["limitations"]))

            analysis2 = json.loads((root / "run2" / "analysis.json").read_text(encoding="utf-8"))
            stages2 = analysis2["provenance"]["stages"]
            self.assertEqual(stages2["synthesis"]["status"], "succeeded")
            self.assertEqual(stages2["synthesis"]["provider"], "custom")
            self.assertEqual(analysis2["title"], "Custom endpoint report")


if __name__ == "__main__":
    unittest.main()
