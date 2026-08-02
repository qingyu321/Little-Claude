"""Offline tests for describe_image.py (stdlib unittest, no network needed)."""

from __future__ import annotations

import base64
import io
import json
import sys
import tempfile
import unittest
from contextlib import redirect_stderr, redirect_stdout
from pathlib import Path
from types import SimpleNamespace

SCRIPTS = Path(__file__).resolve().parents[1] / "scripts"
sys.path.insert(0, str(SCRIPTS))

import describe_image as di  # noqa: E402

PNG_HEADER = b"\x89PNG\r\n\x1a\n" + b"fake-png-payload"
JPEG_HEADER = b"\xff\xd8\xff\xe0" + b"fake-jpeg-payload"


def make_args(**overrides):
    defaults = dict(
        images=[],
        prompt=None,
        ocr=False,
        lang="en",
        detail=None,
        json=False,
        pass_url=True,
        base_url=None,
        model=None,
        api_key=None,
        api_key_env=None,
        timeout=10.0,
        max_image_mb=18.0,
        max_images=8,
        max_tokens=None,
    )
    defaults.update(overrides)
    return SimpleNamespace(**defaults)


def write_png(directory: Path, name: str = "shot.png", payload: bytes = PNG_HEADER) -> Path:
    path = directory / name
    path.write_bytes(payload)
    return path


class ConfigResolutionTests(unittest.TestCase):
    def test_app_defaults_are_reused_without_flags(self):
        env = {
            "TOKENICODE_VIDEO_ANALYSIS_BASE_URL": "https://dashscope.example/v1",
            "TOKENICODE_VIDEO_ANALYSIS_MODEL": "qwen-vl-max",
            "CUSTOM_API_KEY": "sk-injected",
        }
        config = di.resolve_config(make_args(), env)
        self.assertEqual(config.base_url, "https://dashscope.example/v1")
        self.assertEqual(config.model, "qwen-vl-max")
        self.assertEqual(config.api_key, "sk-injected")
        self.assertIn("CUSTOM_API_KEY", config.key_source)

    def test_skill_specific_vars_override_video_analysis_vars(self):
        env = {
            "TOKENICODE_IMAGE_READER_BASE_URL": "https://reader.example/v1",
            "TOKENICODE_IMAGE_READER_MODEL": "glm-4v-plus",
            "TOKENICODE_IMAGE_READER_API_KEY": "sk-reader",
            "TOKENICODE_VIDEO_ANALYSIS_BASE_URL": "https://video.example/v1",
            "TOKENICODE_VIDEO_ANALYSIS_MODEL": "video-model",
            "TOKENICODE_VIDEO_ANALYSIS_API_KEY": "sk-video",
        }
        config = di.resolve_config(make_args(), env)
        self.assertEqual(config.base_url, "https://reader.example/v1")
        self.assertEqual(config.model, "glm-4v-plus")
        self.assertEqual(config.api_key, "sk-reader")

    def test_cli_flags_win_over_environment(self):
        env = {
            "TOKENICODE_VIDEO_ANALYSIS_BASE_URL": "https://video.example/v1",
            "TOKENICODE_VIDEO_ANALYSIS_MODEL": "video-model",
            "CUSTOM_API_KEY": "sk-injected",
        }
        config = di.resolve_config(
            make_args(base_url="https://cli.example/v1", model="cli-model", api_key="sk-cli"),
            env,
        )
        self.assertEqual(config.base_url, "https://cli.example/v1")
        self.assertEqual(config.model, "cli-model")
        self.assertEqual(config.api_key, "sk-cli")
        self.assertIn("--api-key", config.key_source)

    def test_missing_everything_raises_actionable_error(self):
        with self.assertRaises(di.ConfigError) as ctx:
            di.resolve_config(make_args(), {})
        message = str(ctx.exception)
        self.assertIn("Base URL", message)
        self.assertIn("视频分析", message)

    def test_api_key_env_name_is_honored(self):
        config = di.resolve_config(
            make_args(
                base_url="https://x.example/v1",
                model="m",
                api_key_env="MY_SPECIAL_KEY",
            ),
            {"MY_SPECIAL_KEY": "sk-special", "CUSTOM_API_KEY": "sk-injected"},
        )
        self.assertEqual(config.api_key, "sk-special")

    def test_base_url_must_be_https_except_loopback(self):
        self.assertEqual(di.assert_valid_base_url("https://api.example/v1"), "https://api.example/v1")
        self.assertEqual(di.assert_valid_base_url("http://127.0.0.1:8080/v1"), "http://127.0.0.1:8080/v1")
        with self.assertRaises(di.ConfigError):
            di.assert_valid_base_url("http://api.example/v1")


class ImageLoadingTests(unittest.TestCase):
    def test_mime_from_extension(self):
        with tempfile.TemporaryDirectory() as tmp:
            path = write_png(Path(tmp), "a.png", payload=b"not-really-png")
            mime = di.detect_mime(path, path.read_bytes())
            self.assertEqual(mime, "image/png")

    def test_mime_sniffed_when_extension_missing(self):
        with tempfile.TemporaryDirectory() as tmp:
            path = write_png(Path(tmp), "screenshot", payload=JPEG_HEADER)
            mime = di.detect_mime(path, path.read_bytes())
            self.assertEqual(mime, "image/jpeg")

    def test_unsupported_format_is_rejected(self):
        with tempfile.TemporaryDirectory() as tmp:
            path = write_png(Path(tmp), "icon.svg", payload=b"<svg></svg>")
            with self.assertRaises(di.InputError) as ctx:
                di.detect_mime(path, path.read_bytes())
            self.assertIn("Unsupported image type", str(ctx.exception))
            self.assertIn(di.SUPPORTED_FORMATS, str(ctx.exception))

    def test_local_file_becomes_base64_data_url(self):
        with tempfile.TemporaryDirectory() as tmp:
            path = write_png(Path(tmp))
            part, info = di.build_image_part(str(path), make_args())
            self.assertEqual(part["type"], "image_url")
            url = part["image_url"]["url"]
            self.assertTrue(url.startswith("data:image/png;base64,"))
            decoded = base64.standard_b64decode(url.split(",", 1)[1])
            self.assertEqual(decoded, PNG_HEADER)
            self.assertEqual(info["kind"], "local_file")
            self.assertEqual(info["bytes"], len(PNG_HEADER))

    def test_missing_file_is_an_input_error(self):
        with self.assertRaises(di.InputError):
            di.build_image_part("/definitely/not/here.png", make_args())

    def test_oversized_file_is_rejected(self):
        with tempfile.TemporaryDirectory() as tmp:
            path = write_png(Path(tmp), payload=PNG_HEADER + b"x" * 2048)
            args = make_args(max_image_mb=0.001)
            with self.assertRaises(di.InputError):
                di.build_image_part(str(path), args)

    def test_http_url_is_passed_through_by_default(self):
        part, info = di.build_image_part("https://cdn.example/pic.jpg", make_args())
        self.assertEqual(part["image_url"]["url"], "https://cdn.example/pic.jpg")
        self.assertEqual(info["kind"], "http_url_passthrough")

    def test_data_url_is_passed_through(self):
        source = "data:image/png;base64," + base64.b64encode(PNG_HEADER).decode()
        part, info = di.build_image_part(source, make_args())
        self.assertEqual(part["image_url"]["url"], source)
        self.assertEqual(info["mime"], "image/png")

    def test_detail_hint_is_applied_when_requested(self):
        with tempfile.TemporaryDirectory() as tmp:
            path = write_png(Path(tmp))
            parts, _ = di.build_content(make_args(detail="low", images=[str(path)]), [str(path)])
            self.assertEqual(parts[1]["image_url"]["detail"], "low")


class UrlGuardTests(unittest.TestCase):
    def test_loopback_is_blocked(self):
        with self.assertRaises(di.InputError):
            di.assert_public_http_url("http://127.0.0.1/x.png")

    def test_metadata_service_is_blocked(self):
        with self.assertRaises(di.InputError):
            di.assert_public_http_url("http://169.254.169.254/latest/meta-data/")

    def test_private_ranges_are_blocked(self):
        for url in ("http://10.0.0.5/x.png", "http://192.168.1.9/x.png", "http://[::1]/x.png"):
            with self.assertRaises(di.InputError):
                di.assert_public_http_url(url)

    def test_non_http_scheme_is_blocked(self):
        with self.assertRaises(di.InputError):
            di.assert_public_http_url("file:///C:/secrets.png")

    def test_public_literal_is_allowed(self):
        di.assert_public_http_url("https://93.184.216.34/x.png")  # no DNS needed for IP literals


class PromptTests(unittest.TestCase):
    def test_multi_image_prompt_lists_every_image(self):
        prompt = di.build_prompt(make_args(), ["a.png", "b.png"])
        self.assertIn("Image 1/2: a.png", prompt)
        self.assertIn("Image 2/2: b.png", prompt)
        self.assertIn("## Image N", prompt)

    def test_ocr_prompt_by_language(self):
        self.assertIn("verbatim", di.build_prompt(make_args(ocr=True, lang="en"), ["a.png"]))
        self.assertIn("逐字", di.build_prompt(make_args(ocr=True, lang="zh"), ["a.png"]))

    def test_custom_prompt_overrides_defaults(self):
        prompt = di.build_prompt(make_args(prompt="只看表格"), ["a.png"])
        self.assertTrue(prompt.startswith("只看表格"))


class ResponseParsingTests(unittest.TestCase):
    def test_string_content(self):
        data = {"choices": [{"message": {"content": "a red button"}}]}
        self.assertEqual(di.extract_completion_text(data), "a red button")

    def test_list_content(self):
        data = {"choices": [{"message": {"content": [{"type": "text", "text": "part1 "}, {"type": "text", "text": "part2"}]}}]}
        self.assertEqual(di.extract_completion_text(data), "part1 part2")

    def test_empty_content_raises(self):
        with self.assertRaises(di.ApiError):
            di.extract_completion_text({"choices": [{"message": {"content": ""}}]})
        with self.assertRaises(di.ApiError):
            di.extract_completion_text({"choices": []})


class MainEndToEndTests(unittest.TestCase):
    """Run main() with a stubbed HTTP layer — fully offline."""

    def run_main(self, argv, env, response_text="The image shows a login form."):
        calls = []

        def fake_post(url, headers, payload, timeout):
            calls.append({"url": url, "headers": headers, "payload": payload})
            return {"choices": [{"message": {"content": response_text}}]}

        original = di._http_post_json
        di._http_post_json = fake_post
        stdout, stderr = io.StringIO(), io.StringIO()
        try:
            with redirect_stdout(stdout), redirect_stderr(stderr):
                code = di.main(argv, env)
        finally:
            di._http_post_json = original
        return code, stdout.getvalue(), stderr.getvalue(), calls

    def test_happy_path_prints_description_and_provenance(self):
        with tempfile.TemporaryDirectory() as tmp:
            image = write_png(Path(tmp))
            env = {
                "TOKENICODE_VIDEO_ANALYSIS_BASE_URL": "https://vision.example/v1",
                "TOKENICODE_VIDEO_ANALYSIS_MODEL": "qwen-vl-max",
                "CUSTOM_API_KEY": "sk-secret-value",
            }
            code, out, err, calls = self.run_main([str(image), "--lang", "zh"], env)
            self.assertEqual(code, di.EXIT_OK)
            self.assertIn("login form", out)
            self.assertIn("[image-reader]", err)
            self.assertIn("model=qwen-vl-max", err)
            # The key must never appear anywhere.
            self.assertNotIn("sk-secret-value", out + err)
            # Request shape: chat/completions on the configured endpoint.
            self.assertEqual(calls[0]["url"], "https://vision.example/v1/chat/completions")
            content = calls[0]["payload"]["messages"][0]["content"]
            self.assertEqual(content[0]["type"], "text")
            self.assertTrue(content[1]["image_url"]["url"].startswith("data:image/png;base64,"))

    def test_json_output_is_machine_readable_and_key_free(self):
        with tempfile.TemporaryDirectory() as tmp:
            image = write_png(Path(tmp))
            env = {
                "TOKENICODE_IMAGE_READER_BASE_URL": "https://vision.example/v1",
                "TOKENICODE_IMAGE_READER_MODEL": "glm-4v-plus",
                "TOKENICODE_IMAGE_READER_API_KEY": "sk-secret-value",
            }
            code, out, err, _ = self.run_main([str(image), "--json"], env)
            self.assertEqual(code, di.EXIT_OK)
            self.assertNotIn("sk-secret-value", out + err)
            result = json.loads(out)
            self.assertTrue(result["ok"])
            self.assertEqual(result["model"], "glm-4v-plus")
            self.assertEqual(result["images"][0]["kind"], "local_file")
            self.assertIn("description", result)

    def test_missing_config_exits_2(self):
        code, out, err, calls = self.run_main(["whatever.png"], {})
        self.assertEqual(code, di.EXIT_CONFIG)
        self.assertIn("error:", err)
        self.assertEqual(calls, [])  # never reached the network

    def test_missing_file_exits_3(self):
        env = {
            "TOKENICODE_VIDEO_ANALYSIS_BASE_URL": "https://vision.example/v1",
            "TOKENICODE_VIDEO_ANALYSIS_MODEL": "m",
            "CUSTOM_API_KEY": "sk-x",
        }
        code, _, err, calls = self.run_main(["/no/such/file.png"], env)
        self.assertEqual(code, di.EXIT_INPUT)
        self.assertIn("not found", err)
        self.assertEqual(calls, [])

    def test_multiple_images_go_in_a_single_request(self):
        with tempfile.TemporaryDirectory() as tmp:
            first = write_png(Path(tmp), "a.png")
            second = write_png(Path(tmp), "b.png", payload=JPEG_HEADER)
            env = {
                "TOKENICODE_VIDEO_ANALYSIS_BASE_URL": "https://vision.example/v1",
                "TOKENICODE_VIDEO_ANALYSIS_MODEL": "m",
                "CUSTOM_API_KEY": "sk-x",
            }
            code, _, _, calls = self.run_main([str(first), str(second)], env)
            self.assertEqual(code, di.EXIT_OK)
            self.assertEqual(len(calls), 1)
            content = calls[0]["payload"]["messages"][0]["content"]
            image_parts = [part for part in content if part["type"] == "image_url"]
            self.assertEqual(len(image_parts), 2)
            self.assertTrue(image_parts[0]["image_url"]["url"].startswith("data:image/png"))
            self.assertTrue(image_parts[1]["image_url"]["url"].startswith("data:image/jpeg"))


if __name__ == "__main__":
    unittest.main()
