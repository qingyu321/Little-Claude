from __future__ import annotations

import sys
import tempfile
import unittest
from pathlib import Path
from unittest.mock import Mock

SCRIPTS = Path(__file__).resolve().parents[1] / "scripts"
sys.path.insert(0, str(SCRIPTS))

from safe_download import (  # noqa: E402
    DirectMediaTypeError,
    DownloadLimitError,
    DownloadSafetyError,
    assert_public_http_url,
    download_public_video,
)


def public_resolver(host: str, port: int, type: int):
    return [(None, None, None, None, ("93.184.216.34", port))]


class FakeResponse:
    def __init__(self, *, status=200, headers=None, chunks=()):
        self.status_code = status
        self.headers = headers or {"Content-Type": "video/mp4"}
        self._chunks = list(chunks)
        self.is_redirect = status in {301, 302, 303, 307, 308}
        self.is_permanent_redirect = status in {301, 308}

    def raise_for_status(self):
        if self.status_code >= 400:
            raise RuntimeError(f"HTTP {self.status_code}")

    def iter_content(self, chunk_size):
        yield from self._chunks

    def close(self):
        return None


class SafeDownloadTests(unittest.TestCase):
    def test_allows_public_https(self):
        self.assertEqual(
            assert_public_http_url("https://example.com/video.mp4", public_resolver),
            "https://example.com/video.mp4",
        )

    def test_rejects_non_http_localhost_and_private_networks(self):
        with self.assertRaises(DownloadSafetyError):
            assert_public_http_url("file:///tmp/video.mp4", public_resolver)
        with self.assertRaises(DownloadSafetyError):
            assert_public_http_url("https://localhost/video.mp4", public_resolver)

        def private_resolver(host, port, type):
            return [(None, None, None, None, ("127.0.0.1", port))]

        with self.assertRaises(DownloadSafetyError):
            assert_public_http_url("http://example.com/video.mp4", private_resolver)

    def test_redirect_target_is_revalidated(self):
        session = Mock()
        session.get.side_effect = [
            FakeResponse(status=302, headers={"Location": "http://private.example/video.mp4"})
        ]

        def resolver(host, port, type):
            address = "93.184.216.34" if host == "public.example" else "10.0.0.5"
            return [(None, None, None, None, (address, port))]

        with tempfile.TemporaryDirectory() as tmp:
            with self.assertRaises(DownloadSafetyError):
                download_public_video(
                    "https://public.example/video.mp4",
                    Path(tmp) / "video.mp4",
                    session=session,
                    resolver=resolver,
                )

    def test_rejects_bad_content_type_and_removes_partial_download(self):
        session = Mock()
        session.get.return_value = FakeResponse(headers={"Content-Type": "text/html"})
        with tempfile.TemporaryDirectory() as tmp:
            destination = Path(tmp) / "video.mp4"
            with self.assertRaises(DirectMediaTypeError):
                download_public_video(
                    "https://example.com/page",
                    destination,
                    session=session,
                    resolver=public_resolver,
                )
            self.assertFalse(destination.exists())

    def test_enforces_streaming_size_limit(self):
        session = Mock()
        session.get.return_value = FakeResponse(chunks=[b"1234", b"5678"])
        with tempfile.TemporaryDirectory() as tmp:
            destination = Path(tmp) / "video.mp4"
            with self.assertRaises(DownloadLimitError):
                download_public_video(
                    "https://example.com/video.mp4",
                    destination,
                    max_bytes=5,
                    session=session,
                    resolver=public_resolver,
                )
            self.assertFalse(destination.exists())


if __name__ == "__main__":
    unittest.main()
