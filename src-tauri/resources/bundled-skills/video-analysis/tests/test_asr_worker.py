from __future__ import annotations

import contextlib
import io
import json
import subprocess
import sys
import tempfile
import unittest
from pathlib import Path
from types import SimpleNamespace
from unittest import mock

SCRIPTS = Path(__file__).resolve().parents[1] / "scripts"
sys.path.insert(0, str(SCRIPTS))

import acceleration  # noqa: E402
import analyze_video  # noqa: E402
import asr_worker  # noqa: E402


class FakeWhisperModel:
    """Records construction args and yields two segments (one blank)."""

    last_init: tuple | None = None

    def __init__(self, model_path, device=None, compute_type=None):
        FakeWhisperModel.last_init = (model_path, device, compute_type)

    def transcribe(self, audio_path, **kwargs):
        segments = [
            SimpleNamespace(start=0.0, end=1.5, text="  你好世界  "),
            SimpleNamespace(start=1.5, end=3.0, text="   "),  # blank text must be dropped
        ]
        info = SimpleNamespace(language="zh", language_probability=0.9876)
        return iter(segments), info


def install_stub_modules(cuda_device_count: int = 0):
    """Inject faster_whisper/ctranslate2 stubs into sys.modules."""
    sys.modules["faster_whisper"] = SimpleNamespace(WhisperModel=FakeWhisperModel)
    sys.modules["ctranslate2"] = SimpleNamespace(get_cuda_device_count=lambda: cuda_device_count)


class StubModulesMixin:
    def setUp(self):
        self._saved_modules = {
            name: sys.modules.get(name) for name in ("faster_whisper", "ctranslate2")
        }
        self._saved_env = {
            name: __import__("os").environ.pop(name, None)
            for name in ("TOKENICODE_VIDEO_ASR_DEVICE",)
        }

    def tearDown(self):
        for name, module in self._saved_modules.items():
            if module is None:
                sys.modules.pop(name, None)
            else:
                sys.modules[name] = module
        import os

        for name, value in self._saved_env.items():
            if value is None:
                os.environ.pop(name, None)
            else:
                os.environ[name] = value


class AsrWorkerProcessTests(StubModulesMixin, unittest.TestCase):
    """Run the worker's main() in-process with stubbed native libraries."""

    def _run_main(self, audio_path: Path):
        buffer = io.StringIO()
        with contextlib.redirect_stdout(buffer):
            exit_code = asr_worker.main(
                ["--audio-path", str(audio_path), "--model", "small", "--language", "zh"]
            )
        return exit_code, buffer.getvalue()

    def test_success_emits_ok_json_and_drops_blank_segments(self):
        install_stub_modules(cuda_device_count=0)
        with tempfile.TemporaryDirectory() as tmp:
            audio = Path(tmp) / "audio.wav"
            audio.write_bytes(b"riff")
            exit_code, out = self._run_main(audio)
        self.assertEqual(exit_code, 0)
        payload = json.loads(out.strip().splitlines()[-1])
        self.assertTrue(payload["ok"])
        self.assertEqual(len(payload["segments"]), 1)
        segment = payload["segments"][0]
        self.assertEqual(segment["text"], "你好世界")  # stripped
        self.assertEqual(segment["start_seconds"], 0.0)
        self.assertEqual(segment["end_seconds"], 1.5)
        self.assertEqual(payload["language"], "zh")
        self.assertEqual(payload["language_probability"], 0.9876)
        self.assertEqual(payload["device"], "cpu")
        self.assertEqual(payload["compute_type"], "int8")
        # CPU path: int8 compute type forwarded to the model constructor.
        self.assertEqual(FakeWhisperModel.last_init[1:], ("cpu", "int8"))

    def test_cuda_probe_selects_int8_float16(self):
        install_stub_modules(cuda_device_count=1)
        with tempfile.TemporaryDirectory() as tmp:
            audio = Path(tmp) / "audio.wav"
            audio.write_bytes(b"riff")
            exit_code, out = self._run_main(audio)
        self.assertEqual(exit_code, 0)
        payload = json.loads(out.strip().splitlines()[-1])
        self.assertEqual(payload["device"], "cuda")
        self.assertEqual(payload["compute_type"], "int8_float16")
        self.assertEqual(FakeWhisperModel.last_init[1:], ("cuda", "int8_float16"))

    def test_env_var_forces_cpu_without_cuda_probe(self):
        import os

        os.environ["TOKENICODE_VIDEO_ASR_DEVICE"] = "cpu"
        install_stub_modules(cuda_device_count=1)  # would be cuda without the override
        self.assertEqual(acceleration.get_accel_compute_type(), ("int8", "cpu"))

    def test_missing_audio_file_is_controlled_failure(self):
        install_stub_modules()
        exit_code, out = self._run_main(Path(tempfile.gettempdir()) / "does-not-exist-9x.wav")
        self.assertEqual(exit_code, 1)
        payload = json.loads(out.strip().splitlines()[-1])
        self.assertFalse(payload["ok"])
        self.assertEqual(payload["error_type"], "Input")

    def test_missing_faster_whisper_is_controlled_import_failure(self):
        sys.modules["faster_whisper"] = None  # makes `import faster_whisper` raise ImportError
        sys.modules["ctranslate2"] = SimpleNamespace(get_cuda_device_count=lambda: 0)
        with tempfile.TemporaryDirectory() as tmp:
            audio = Path(tmp) / "audio.wav"
            audio.write_bytes(b"riff")
            exit_code, out = self._run_main(audio)
        self.assertEqual(exit_code, 1)
        payload = json.loads(out.strip().splitlines()[-1])
        self.assertFalse(payload["ok"])
        self.assertEqual(payload["error_type"], "ImportError")
        self.assertIn("faster-whisper", payload["error"])


class RunAsRSubprocessTests(unittest.TestCase):
    """Parent-side contract: stdout JSON first, exit code second."""

    AUDIO = Path("fake.wav")

    def _call(self, accel_stats=None):
        return analyze_video.run_asr_subprocess(
            self.AUDIO,
            model="small",
            language=None,
            duration_seconds=10.0,
            accel_stats=accel_stats,
        )

    def test_success_returns_segments_and_records_device(self):
        payload = {
            "ok": True,
            "segments": [{"start_seconds": 0.0, "end_seconds": 1.0, "text": "hi"}],
            "language": "en",
            "language_probability": 0.9,
            "device": "cpu",
            "compute_type": "int8",
        }
        with mock.patch("analyze_video.subprocess.run") as run:
            run.return_value = SimpleNamespace(returncode=0, stdout=json.dumps(payload), stderr="")
            stats: dict = {}
            segments = self._call(accel_stats=stats)
        self.assertEqual(segments, payload["segments"])
        self.assertEqual(stats["asr_device"], "cpu")
        self.assertEqual(stats["asr_compute_type"], "int8")
        # The worker is launched with the OpenMP escape hatches in its env.
        env = run.call_args.kwargs["env"]
        self.assertEqual(env["KMP_DUPLICATE_LIB_OK"], "TRUE")
        self.assertEqual(env["OMP_WAIT_POLICY"], "PASSIVE")

    def test_native_crash_without_json_raises_with_exit_code(self):
        with mock.patch("analyze_video.subprocess.run") as run:
            run.return_value = SimpleNamespace(returncode=3221226505, stdout="", stderr="OpenMP: Error 1")
            with self.assertRaises(RuntimeError) as ctx:
                self._call()
        message = str(ctx.exception)
        self.assertIn("crashed", message)
        self.assertIn("3221226505", message)
        self.assertIn("OpenMP: Error 1", message)

    def test_controlled_failure_json_raises_worker_error(self):
        payload = {"ok": False, "error": "model exploded", "error_type": "ModelLoad"}
        with mock.patch("analyze_video.subprocess.run") as run:
            run.return_value = SimpleNamespace(returncode=1, stdout=json.dumps(payload), stderr="")
            with self.assertRaises(RuntimeError) as ctx:
                self._call()
        self.assertIn("model exploded", str(ctx.exception))
        self.assertIn("ModelLoad", str(ctx.exception))

    def test_timeout_raises_runtime_error(self):
        with mock.patch("analyze_video.subprocess.run") as run:
            run.side_effect = subprocess.TimeoutExpired(cmd="asr_worker", timeout=5)
            with self.assertRaises(RuntimeError) as ctx:
                self._call()
        self.assertIn("timed out", str(ctx.exception))

    def test_garbage_stdout_with_zero_exit_still_raises(self):
        with mock.patch("analyze_video.subprocess.run") as run:
            run.return_value = SimpleNamespace(returncode=0, stdout="not json at all", stderr="")
            with self.assertRaises(RuntimeError) as ctx:
                self._call()
        self.assertIn("crashed", str(ctx.exception))


if __name__ == "__main__":
    unittest.main()
