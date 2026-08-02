from __future__ import annotations

import sys
import unittest
from pathlib import Path

SCRIPTS = Path(__file__).resolve().parents[1] / "scripts"
sys.path.insert(0, str(SCRIPTS))

from preflight import build_report  # noqa: E402


class PreflightTests(unittest.TestCase):
    def test_reports_offline_only_readiness(self):
        report = build_report(
            which=lambda name: f"/bin/{name}" if name in {"ffmpeg", "ffprobe"} else None,
            find_spec=lambda name: object() if name == "requests" else None,
            environ={},
        )
        self.assertTrue(report["capabilities"]["offline_media_pipeline"])
        self.assertFalse(report["capabilities"]["asr"])
        self.assertFalse(report["capabilities"]["platform_extraction"])
        self.assertFalse(report["capabilities"]["requested_vision_ready"])
        self.assertFalse(report["capabilities"]["requested_synthesis_ready"])
        self.assertTrue(report["capabilities"]["deterministic_report"])
        self.assertFalse(report["provider_capabilities"]["openai"]["vision"]["ready"])

    def test_reports_selected_provider_readiness(self):
        report = build_report(
            which=lambda name: f"/bin/{name}",
            find_spec=lambda name: object(),
            environ={"OPENAI_API_KEY": "test-key", "DEEPSEEK_API_KEY": "test-key"},
            vision_provider="openai",
            synthesis_provider="deepseek",
        )
        self.assertTrue(report["capabilities"]["offline_media_pipeline"])
        self.assertTrue(report["capabilities"]["asr"])
        self.assertTrue(report["capabilities"]["platform_extraction"])
        self.assertTrue(report["capabilities"]["requested_vision_ready"])
        self.assertTrue(report["capabilities"]["requested_synthesis_ready"])
        self.assertTrue(report["provider_capabilities"]["openai"]["vision"]["ready"])
        self.assertTrue(report["provider_capabilities"]["deepseek"]["synthesis"]["ready"])
        self.assertFalse(report["provider_capabilities"]["deepseek"]["vision"]["supported"])

    def test_credentials_are_reported_as_presence_flags_only(self):
        report = build_report(
            which=lambda name: f"/bin/{name}",
            find_spec=lambda name: object(),
            environ={"XAI_API_KEY": "secret-value"},
        )
        self.assertTrue(report["credentials"]["xai_api_key_present"])
        serialized = str(report)
        self.assertNotIn("secret-value", serialized)


if __name__ == "__main__":
    unittest.main()
