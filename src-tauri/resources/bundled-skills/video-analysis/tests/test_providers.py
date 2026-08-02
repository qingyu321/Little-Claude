from __future__ import annotations

import base64
import json
import sys
import tempfile
import unittest
from pathlib import Path
from types import SimpleNamespace

SCRIPTS = Path(__file__).resolve().parents[1] / "scripts"
sys.path.insert(0, str(SCRIPTS))

import providers as provider_layer  # noqa: E402


def fake_openai_client(response_text: str | None = None, *, choices_text: str | None = None):
    calls: dict[str, list[dict]] = {"responses": [], "chat": []}

    class Responses:
        def create(self, **kwargs):
            calls["responses"].append(kwargs)
            return SimpleNamespace(output_text=response_text)

    class Completions:
        def create(self, **kwargs):
            calls["chat"].append(kwargs)
            return SimpleNamespace(choices=[SimpleNamespace(message=SimpleNamespace(content=choices_text))])

    return SimpleNamespace(responses=Responses(), chat=SimpleNamespace(completions=Completions())), calls


class ProviderTests(unittest.TestCase):
    def make_frames(self, tmp: Path, count: int = 2) -> list[dict]:
        frames = []
        for index in range(count):
            image = tmp / f"frame_{index}.jpg"
            image.write_bytes(b"jpeg-bytes")
            frames.append({"timestamp_seconds": float(index * 3), "path": str(image)})
        return frames

    def test_deepseek_vision_is_rejected(self):
        request = provider_layer.StageRequest(stage="vision", provider="deepseek")
        with self.assertRaises(provider_layer.ProviderConfigurationError):
            provider_layer.create_vision_provider(
                request,
                environ={"DEEPSEEK_API_KEY": "test"},
                client_factory=lambda spec, key: object(),
            )

    def test_none_provider_requires_no_client_or_key(self):
        provider = provider_layer.create_vision_provider(
            provider_layer.StageRequest(stage="vision", provider="none"),
            environ={},
            client_factory=lambda spec, key: self.fail("client factory must not run for none"),
        )
        self.assertFalse(provider.spec.remote)

    def test_openai_vision_uses_data_urls_and_source_timestamps(self):
        with tempfile.TemporaryDirectory() as tmp:
            frames = self.make_frames(Path(tmp))
            observations_json = json.dumps(
                {
                    "observations": [
                        {"timestamp_seconds": 999, "scene": "a", "visible_text": [], "actions": [], "important_objects": [], "is_key_moment": False},
                        {"timestamp_seconds": 888, "scene": "b", "visible_text": [], "actions": [], "important_objects": [], "is_key_moment": True},
                    ]
                }
            )
            client, calls = fake_openai_client(observations_json)
            provider = provider_layer.create_vision_provider(
                provider_layer.StageRequest(stage="vision", provider="openai"),
                environ={"OPENAI_API_KEY": "test"},
                client_factory=lambda spec, key: client,
            )
            observations = provider.analyze_batch(frames)
            self.assertEqual([item["timestamp_seconds"] for item in observations], [0.0, 3.0])
            request = calls["responses"][0]
            self.assertEqual(request["model"], "gpt-5")
            content = request["input"][0]["content"]
            image_parts = [part for part in content if part["type"] == "input_image"]
            expected = "data:image/jpeg;base64," + base64.standard_b64encode(b"jpeg-bytes").decode("ascii")
            self.assertEqual([part["image_url"] for part in image_parts], [expected, expected])

    def test_xai_vision_uses_fixed_endpoint_and_grok_model(self):
        with tempfile.TemporaryDirectory() as tmp:
            frames = self.make_frames(Path(tmp), count=1)
            observations_json = json.dumps(
                {
                    "observations": [
                        {"scene": "x", "visible_text": [], "actions": [], "important_objects": [], "is_key_moment": False}
                    ]
                }
            )
            client, calls = fake_openai_client(observations_json)
            captured_specs: list[provider_layer.ProviderSpec] = []

            def factory(spec, key):
                captured_specs.append(spec)
                return client

            provider = provider_layer.create_vision_provider(
                provider_layer.StageRequest(stage="vision", provider="xai"),
                environ={"XAI_API_KEY": "test"},
                client_factory=factory,
            )
            observations = provider.analyze_batch(frames)
            self.assertEqual(observations[0]["timestamp_seconds"], 0.0)
            self.assertEqual(captured_specs[0].base_url, provider_layer.XAI_BASE_URL)
            self.assertEqual(calls["responses"][0]["model"], "grok-4.5")

    def test_deepseek_synthesis_uses_text_chat_only(self):
        client, calls = fake_openai_client(choices_text=json.dumps({"title": "t", "summary": "s", "chapters": [], "key_moments": [], "limitations": []}))
        captured_specs: list[provider_layer.ProviderSpec] = []

        def factory(spec, key):
            captured_specs.append(spec)
            return client

        provider = provider_layer.create_synthesis_provider(
            provider_layer.StageRequest(stage="synthesis", provider="deepseek"),
            environ={"DEEPSEEK_API_KEY": "test"},
            client_factory=factory,
        )
        report = provider.synthesize({"source_label": "x", "duration_seconds": 1, "timeline": [], "known_limitations": []})
        self.assertEqual(report["title"], "t")
        self.assertEqual(captured_specs[0].base_url, provider_layer.DEEPSEEK_BASE_URL)
        self.assertEqual(len(calls["responses"]), 0)
        message = calls["chat"][0]["messages"][0]["content"]
        self.assertNotIn("data:image", message)
        self.assertNotIn("base64", message.lower())

    def test_missing_api_key_fails_configuration(self):
        with self.assertRaises(provider_layer.ProviderConfigurationError):
            provider_layer.create_vision_provider(
                provider_layer.StageRequest(stage="vision", provider="openai"),
                environ={},
            )

    def test_invalid_vision_response_count_raises_response_error(self):
        with tempfile.TemporaryDirectory() as tmp:
            frames = self.make_frames(Path(tmp), count=2)
            client, _ = fake_openai_client(json.dumps({"observations": []}))
            provider = provider_layer.create_vision_provider(
                provider_layer.StageRequest(stage="vision", provider="openai"),
                environ={"OPENAI_API_KEY": "test"},
                client_factory=lambda spec, key: client,
            )
            with self.assertRaises(provider_layer.ProviderResponseError):
                provider.analyze_batch(frames)


    def test_custom_vision_uses_chat_completions_image_url(self):
        with tempfile.TemporaryDirectory() as tmp:
            frames = self.make_frames(Path(tmp), count=1)
            observations_json = json.dumps(
                {
                    "observations": [
                        {"timestamp_seconds": 999, "scene": "relay", "visible_text": [], "actions": [], "important_objects": [], "is_key_moment": False}
                    ]
                }
            )
            client, calls = fake_openai_client(choices_text=observations_json)
            captured_specs = []

            def factory(spec, key):
                captured_specs.append((spec, key))
                return client

            provider = provider_layer.create_vision_provider(
                provider_layer.StageRequest(
                    stage="vision",
                    provider="custom",
                    model="gpt5.6-luna",
                    base_url="https://relay.example.com/v1",
                    api_key_env="CUSTOM_API_KEY",
                ),
                environ={"CUSTOM_API_KEY": "secret"},
                client_factory=factory,
            )
            observations = provider.analyze_batch(frames)
            self.assertEqual(observations[0]["timestamp_seconds"], 0.0)
            spec, key = captured_specs[0]
            self.assertEqual(spec.base_url, "https://relay.example.com/v1")
            self.assertEqual(key, "secret")
            request = calls["chat"][0]
            self.assertEqual(request["model"], "gpt5.6-luna")
            content = request["messages"][0]["content"]
            image_parts = [part for part in content if part["type"] == "image_url"]
            self.assertTrue(image_parts[0]["image_url"]["url"].startswith("data:image/jpeg;base64,"))
            self.assertEqual(len(calls["responses"]), 0)

    def test_custom_base_url_must_be_https_or_loopback(self):
        request = provider_layer.StageRequest(
            stage="vision", provider="custom", model="m", base_url="http://relay.example.com/v1"
        )
        with self.assertRaises(provider_layer.ProviderConfigurationError):
            provider_layer.create_vision_provider(
                request, environ={"CUSTOM_API_KEY": "k"}, client_factory=lambda spec, key: object()
            )
        loopback = provider_layer.assert_custom_base_url("http://127.0.0.1:8080/v1")
        self.assertEqual(loopback, "http://127.0.0.1:8080/v1")

    def test_custom_requires_model_and_base_url(self):
        with self.assertRaises(provider_layer.ProviderConfigurationError):
            provider_layer.create_vision_provider(
                provider_layer.StageRequest(stage="vision", provider="custom", base_url="https://relay.example.com/v1"),
                environ={"CUSTOM_API_KEY": "k"},
                client_factory=lambda spec, key: object(),
            )
        with self.assertRaises(provider_layer.ProviderConfigurationError):
            provider_layer.create_synthesis_provider(
                provider_layer.StageRequest(stage="synthesis", provider="custom", model="m"),
                environ={"CUSTOM_API_KEY": "k"},
                client_factory=lambda spec, key: object(),
            )

    def test_custom_synthesis_is_text_only(self):
        client, calls = fake_openai_client(
            choices_text=json.dumps({"title": "t", "summary": "s", "chapters": [], "key_moments": [], "limitations": []})
        )
        provider = provider_layer.create_synthesis_provider(
            provider_layer.StageRequest(
                stage="synthesis",
                provider="custom",
                model="any-model",
                base_url="https://relay.example.com/v1",
            ),
            environ={"CUSTOM_API_KEY": "k"},
            client_factory=lambda spec, key: client,
        )
        report = provider.synthesize({"source_label": "x", "duration_seconds": 1, "timeline": [], "known_limitations": []})
        self.assertEqual(report["title"], "t")
        message = calls["chat"][0]["messages"][0]["content"]
        self.assertNotIn("data:image", message)
        self.assertEqual(len(calls["responses"]), 0)

    def test_custom_image_probe_succeeds_and_sends_the_real_frame(self):
        with tempfile.TemporaryDirectory() as tmp:
            frames = self.make_frames(Path(tmp), count=1)
            client, calls = fake_openai_client(choices_text="ok")
            provider = provider_layer.create_vision_provider(
                provider_layer.StageRequest(
                    stage="vision",
                    provider="custom",
                    model="vision-model",
                    base_url="https://relay.example.com/v1",
                ),
                environ={"CUSTOM_API_KEY": "k"},
                client_factory=lambda spec, key: client,
            )
            result = provider.probe_image_input(Path(frames[0]["path"]))
            self.assertTrue(result["probed"])
            self.assertTrue(result["ok"])
            request = calls["chat"][0]
            self.assertEqual(request["model"], "vision-model")
            content = request["messages"][0]["content"]
            expected = "data:image/jpeg;base64," + base64.standard_b64encode(b"jpeg-bytes").decode("ascii")
            self.assertEqual(content[1]["image_url"]["url"], expected)

    def test_custom_image_probe_reports_text_only_model_rejection(self):
        class RaisingCompletions:
            def create(self, **kwargs):
                raise RuntimeError("This model does not support image input")

        client = SimpleNamespace(chat=SimpleNamespace(completions=RaisingCompletions()))
        provider = provider_layer.create_vision_provider(
            provider_layer.StageRequest(
                stage="vision",
                provider="custom",
                model="text-only-model",
                base_url="https://relay.example.com/v1",
            ),
            environ={"CUSTOM_API_KEY": "k"},
            client_factory=lambda spec, key: client,
        )
        result = provider.probe_image_input()
        self.assertTrue(result["probed"])
        self.assertFalse(result["ok"])
        self.assertIn("does not appear to support image input", result["detail"])
        self.assertIn("text-only-model", result["detail"])

    def test_named_provider_image_probe_is_skipped_without_network(self):
        client, calls = fake_openai_client(response_text="unused")
        provider = provider_layer.create_vision_provider(
            provider_layer.StageRequest(stage="vision", provider="openai"),
            environ={"OPENAI_API_KEY": "k"},
            client_factory=lambda spec, key: client,
        )
        result = provider.probe_image_input()
        self.assertFalse(result["probed"])
        self.assertTrue(result["ok"])
        self.assertEqual(calls["chat"], [])
        self.assertEqual(calls["responses"], [])


    def test_vision_instruction_prefers_custom_label_and_falls_back(self):
        frames = [
            {"timestamp_seconds": 0.0, "path": "a.jpg"},
            {
                "timestamp_seconds": 3.0,
                "path": "grid_0000.jpg",
                "label": "Image 1 of 1: a 2x2 montage of frames at 3.0s, 6.0s, 9.0s, 12.0s.",
            },
        ]
        instruction = provider_layer._vision_instruction(frames)
        # Custom label wins for the grid entry...
        self.assertIn("a 2x2 montage of frames at 3.0s", instruction)
        # ...and the instruction tells the model how to answer montages.
        self.assertIn("a montage image gets one observation covering all its cells", instruction)
        # ...while plain frames keep the classic line format.
        self.assertIn("Frame 1: 0.000 seconds", instruction)
        self.assertNotIn("Frame 2:", instruction)

    def test_grid_entries_propagate_source_timestamps(self):
        with tempfile.TemporaryDirectory() as tmp:
            image = Path(tmp) / "grid_0000.jpg"
            image.write_bytes(b"jpeg-bytes")
            frames = [
                {
                    "timestamp_seconds": 3.0,
                    "path": str(image),
                    "source_timestamps": [3.0, 6.0, 9.0, 12.0],
                    "kind": "grid",
                }
            ]
            observations_json = json.dumps(
                {
                    "observations": [
                        {"timestamp_seconds": 999, "scene": "montage", "visible_text": [], "actions": [], "important_objects": [], "is_key_moment": False}
                    ]
                }
            )
            for kind in ("responses", "chat"):
                if kind == "responses":
                    client, _ = fake_openai_client(observations_json)
                    provider = provider_layer.create_vision_provider(
                        provider_layer.StageRequest(stage="vision", provider="openai"),
                        environ={"OPENAI_API_KEY": "test"},
                        client_factory=lambda spec, key: client,
                    )
                else:
                    client, _ = fake_openai_client(choices_text=observations_json)
                    provider = provider_layer.create_vision_provider(
                        provider_layer.StageRequest(
                            stage="vision", provider="custom", model="m", base_url="https://relay.example.com/v1"
                        ),
                        environ={"CUSTOM_API_KEY": "k"},
                        client_factory=lambda spec, key: client,
                    )
                observations = provider.analyze_batch(frames)
                # Pipeline-owned timestamp (grid start) overrides model output...
                self.assertEqual(observations[0]["timestamp_seconds"], 3.0)
                # ...and the montage coverage range rides along (both client paths).
                self.assertEqual(observations[0]["source_timestamps"], [3.0, 6.0, 9.0, 12.0])

    def test_cli_rejects_insecure_custom_base_url(self):
        import analyze_video

        args = analyze_video.build_parser().parse_args(
            [
                "--input",
                "missing.mp4",
                "--output-dir",
                "out",
                "--vision-provider",
                "custom",
                "--custom-base-url",
                "http://relay.example.com/v1",
                "--vision-model",
                "m",
            ]
        )
        with self.assertRaises(analyze_video.PipelineError):
            analyze_video.analyze(args)


if __name__ == "__main__":
    unittest.main()
