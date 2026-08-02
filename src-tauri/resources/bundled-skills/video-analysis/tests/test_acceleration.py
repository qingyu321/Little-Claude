from __future__ import annotations

import importlib.util
import os
import sys
import tempfile
import unittest
from pathlib import Path
from types import SimpleNamespace
from unittest import mock

SCRIPTS = Path(__file__).resolve().parents[1] / "scripts"
sys.path.insert(0, str(SCRIPTS))

import acceleration  # noqa: E402

ENV = "TOKENICODE_VIDEO_ANALYSIS_ACCELERATE"
HAS_NUMPY = importlib.util.find_spec("numpy") is not None
HAS_PIL = importlib.util.find_spec("PIL") is not None


class ShouldAccelerateTests(unittest.TestCase):
    def test_explicit_flags_override_everything(self):
        with mock.patch.dict(os.environ, {ENV: "0"}):
            self.assertTrue(acceleration.should_accelerate(explicit=True))
        with mock.patch.dict(os.environ, {ENV: "1"}):
            self.assertFalse(acceleration.should_accelerate(explicit=False))

    def test_env_var_overrides_default(self):
        with mock.patch.dict(os.environ, {ENV: "0"}):
            self.assertFalse(acceleration.should_accelerate(explicit=None))
        with mock.patch.dict(os.environ, {ENV: "1"}):
            self.assertTrue(acceleration.should_accelerate(explicit=None))

    def test_default_is_on_when_env_unset(self):
        environ = {k: v for k, v in os.environ.items() if k != ENV}
        with mock.patch.dict(os.environ, environ, clear=True):
            self.assertTrue(acceleration.should_accelerate(explicit=None))

    def test_unknown_env_value_falls_through_to_default(self):
        with mock.patch.dict(os.environ, {ENV: "maybe"}):
            self.assertTrue(acceleration.should_accelerate(explicit=None))


class CacheKeyTests(unittest.TestCase):
    def test_extra_params_change_the_key(self):
        with tempfile.TemporaryDirectory() as tmp:
            source = Path(tmp) / "video.mp4"
            source.write_bytes(b"payload")
            base = dict(
                pipeline_version=acceleration.PIPELINE_VERSION,
                asr_model="small",
                language=None,
                scene_threshold=acceleration.SCENE_THRESHOLD,
                phash_threshold=acceleration.PHASH_HAMMING_THRESHOLD,
            )
            transcript_key = acceleration.cache_key(source, **base)
            vision_key = acceleration.cache_key(source, extra_params="vision|custom|m|3.0|grids", **base)
            self.assertNotEqual(transcript_key, vision_key)
            # Same inputs are stable.
            self.assertEqual(transcript_key, acceleration.cache_key(source, **base))
            # Different source content changes the key.
            source.write_bytes(b"other payload")
            self.assertNotEqual(transcript_key, acceleration.cache_key(source, **base))


class CacheManifestTests(unittest.TestCase):
    def test_roundtrip_and_invalidation(self):
        with tempfile.TemporaryDirectory() as tmp:
            cache_dir = Path(tmp)
            key = "abc123_def456"
            artifact = cache_dir / key / "transcript.json"
            artifact.parent.mkdir(parents=True)
            artifact.write_bytes(b"[1,2,3]")
            acceleration.save_cache_manifest(
                cache_dir, key, data={"stage": "asr"}, entries=[{"path": "transcript.json", "size": 7}]
            )
            manifest = acceleration.load_cache_manifest(cache_dir, key)
            self.assertIsNotNone(manifest)
            self.assertEqual(manifest["stage"], "asr")
            # Tampering with the artifact size invalidates the manifest.
            artifact.write_bytes(b"[1]")
            self.assertIsNone(acceleration.load_cache_manifest(cache_dir, key))
            # A missing artifact invalidates too.
            artifact.unlink()
            self.assertIsNone(acceleration.load_cache_manifest(cache_dir, key))
            # An unknown key is simply a miss.
            self.assertIsNone(acceleration.load_cache_manifest(cache_dir, "nope_nope"))


class ComputeTypeProbeTests(unittest.TestCase):
    def setUp(self):
        self._saved_ct2 = sys.modules.get("ctranslate2")
        self._saved_env = os.environ.pop("TOKENICODE_VIDEO_ASR_DEVICE", None)

    def tearDown(self):
        if self._saved_ct2 is None:
            sys.modules.pop("ctranslate2", None)
        else:
            sys.modules["ctranslate2"] = self._saved_ct2
        if self._saved_env is not None:
            os.environ["TOKENICODE_VIDEO_ASR_DEVICE"] = self._saved_env

    def test_no_cuda_devices_falls_back_to_cpu_int8(self):
        sys.modules["ctranslate2"] = SimpleNamespace(get_cuda_device_count=lambda: 0)
        self.assertEqual(acceleration.get_accel_compute_type(), ("int8", "cpu"))

    def test_cuda_devices_select_int8_float16(self):
        sys.modules["ctranslate2"] = SimpleNamespace(get_cuda_device_count=lambda: 1)
        self.assertEqual(acceleration.get_accel_compute_type(), ("int8_float16", "cuda"))

    def test_probe_failure_falls_back_to_cpu(self):
        sys.modules["ctranslate2"] = None  # import ctranslate2 -> ImportError
        self.assertEqual(acceleration.get_accel_compute_type(), ("int8", "cpu"))

    def test_env_override_skips_probe(self):
        os.environ["TOKENICODE_VIDEO_ASR_DEVICE"] = "cpu"
        sys.modules["ctranslate2"] = SimpleNamespace(get_cuda_device_count=lambda: 4)
        self.assertEqual(acceleration.get_accel_compute_type(), ("int8", "cpu"))


class WhisperKwargsTests(unittest.TestCase):
    def test_greedy_decoding_and_vad_for_every_language(self):
        kwargs = acceleration.get_whisper_transcribe_kwargs("zh")
        self.assertEqual(kwargs["beam_size"], 1)
        self.assertFalse(kwargs["condition_on_previous_text"])
        self.assertTrue(kwargs["vad_filter"])
        self.assertEqual(kwargs["language"], "zh")


@unittest.skipUnless(HAS_NUMPY and HAS_PIL, "numpy and Pillow are required for pHash/grid tests")
class PerceptualHashTests(unittest.TestCase):
    def _write_image(self, path: Path, color) -> None:
        from PIL import Image

        Image.new("RGB", (64, 64), color).save(path, quality=90)

    def test_identical_images_hash_identical_and_inverted_differ(self):
        with tempfile.TemporaryDirectory() as tmp:
            a = Path(tmp) / "a.jpg"
            b = Path(tmp) / "b.jpg"
            c = Path(tmp) / "c.jpg"
            self._write_image(a, (10, 120, 230))
            # Gradient vs inverted gradient: clearly different content.
            import numpy as np
            from PIL import Image

            gradient = np.tile(np.arange(64, dtype=np.uint8), (64, 1))
            Image.fromarray(gradient).save(c)
            Image.fromarray(255 - gradient).save(b)

            hash_a = acceleration._perceptual_hash(a)
            hash_c = acceleration._perceptual_hash(c)
            hash_b = acceleration._perceptual_hash(b)
            self.assertIsInstance(hash_a, int)
            self.assertLess(hash_a, 1 << 63)  # 63-bit hash
            # Same content hashes to zero distance...
            self.assertEqual(acceleration._hamming_distance(hash_c, hash_c), 0.0)
            # ...inverted content exceeds the dedup threshold.
            self.assertGreater(
                acceleration._hamming_distance(hash_b, hash_c),
                acceleration.PHASH_HAMMING_THRESHOLD,
            )


@unittest.skipUnless(HAS_NUMPY and HAS_PIL, "numpy and Pillow are required for pHash/grid tests")
class MakeGridsTests(unittest.TestCase):
    def test_five_frames_produce_two_grids(self):
        from PIL import Image

        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            frames = []
            for index in range(5):
                path = root / f"frame_{index:06d}.jpg"
                Image.new("RGB", (64, 48), (index * 40, 0, 0)).save(path)
                frames.append({"timestamp_seconds": float(index), "path": str(path)})
            grids = acceleration.make_grids(frames, root)
            self.assertEqual(len(grids), 2)
            grid_path, source_paths = grids[0]
            self.assertTrue(Path(grid_path).is_file())
            self.assertTrue(Path(grid_path).name.startswith("grid_"))
            self.assertEqual(len(source_paths), 4)
            self.assertEqual(len(grids[1][1]), 1)
            # Grid JPEGs must not collide with the frame_*.jpg glob.
            self.assertEqual(len(list(root.glob("frame_*.jpg"))), 5)


if __name__ == "__main__":
    unittest.main()
