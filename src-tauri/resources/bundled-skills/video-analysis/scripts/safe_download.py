"""Secure downloader for authorized, public direct video URLs.

This module deliberately supports only direct HTTP(S) media resources. It does not
parse video-platform pages, send cookies, or bypass access controls.
"""

from __future__ import annotations

import argparse
import ipaddress
import json
import socket
from dataclasses import dataclass
from pathlib import Path
from typing import Callable
from urllib.parse import urlparse

import requests

DEFAULT_MAX_BYTES = 250 * 1024 * 1024
DEFAULT_TIMEOUT = (10, 60)
DEFAULT_MAX_REDIRECTS = 3
ALLOWED_CONTENT_TYPE_PREFIXES = ("video/", "application/octet-stream")


class DownloadSafetyError(RuntimeError):
    """Raised when a URL or response violates the downloader safety policy."""


class DownloadLimitError(RuntimeError):
    """Raised when a remote resource exceeds the configured size limit."""


class DirectMediaTypeError(DownloadSafetyError):
    """Raised when the response is not direct video media, e.g. a platform HTML page."""


@dataclass(frozen=True)
class DownloadResult:
    path: Path
    url: str
    content_type: str
    bytes_written: int


def _is_public_ip(value: str) -> bool:
    try:
        return ipaddress.ip_address(value).is_global
    except ValueError:
        return False


def assert_public_http_url(
    url: str,
    resolver: Callable[..., list[tuple]] = socket.getaddrinfo,
) -> str:
    """Validate scheme, host and every resolved address before connecting."""
    parsed = urlparse(url)
    if parsed.scheme not in {"http", "https"}:
        raise DownloadSafetyError("Only direct http:// and https:// URLs are allowed.")
    if not parsed.hostname:
        raise DownloadSafetyError("The URL must include a hostname.")
    if parsed.username or parsed.password:
        raise DownloadSafetyError("URLs with embedded credentials are not allowed.")

    hostname = parsed.hostname.rstrip(".")
    if hostname.lower() == "localhost":
        raise DownloadSafetyError("Localhost URLs are not allowed.")

    try:
        addresses = resolver(hostname, parsed.port or 443, type=socket.SOCK_STREAM)
    except socket.gaierror as exc:
        raise DownloadSafetyError("The URL hostname could not be resolved.") from exc

    resolved_ips = {entry[4][0] for entry in addresses}
    if not resolved_ips:
        raise DownloadSafetyError("The URL hostname did not resolve to an address.")
    blocked = sorted(ip for ip in resolved_ips if not _is_public_ip(ip))
    if blocked:
        raise DownloadSafetyError("The URL resolves to a non-public network address.")
    return url


def _content_type_is_allowed(content_type: str) -> bool:
    return content_type.lower().split(";", 1)[0].strip().startswith(
        ALLOWED_CONTENT_TYPE_PREFIXES
    )


def download_public_video(
    url: str,
    destination: Path,
    *,
    max_bytes: int = DEFAULT_MAX_BYTES,
    timeout: tuple[int, int] = DEFAULT_TIMEOUT,
    max_redirects: int = DEFAULT_MAX_REDIRECTS,
    session: requests.Session | None = None,
    resolver: Callable[..., list[tuple]] = socket.getaddrinfo,
) -> DownloadResult:
    """Download one public direct-media URL after validating each redirect target."""
    if max_bytes <= 0:
        raise ValueError("max_bytes must be positive")
    if max_redirects < 0:
        raise ValueError("max_redirects cannot be negative")

    current_url = assert_public_http_url(url, resolver)
    client = session or requests.Session()
    headers = {"User-Agent": "video-analysis-skill/1.0", "Accept": "video/*"}
    destination.parent.mkdir(parents=True, exist_ok=True)

    for redirect_count in range(max_redirects + 1):
        response = client.get(
            current_url,
            headers=headers,
            stream=True,
            timeout=timeout,
            allow_redirects=False,
        )
        try:
            if response.is_redirect or response.is_permanent_redirect:
                location = response.headers.get("Location")
                if not location:
                    raise DownloadSafetyError("The server sent a redirect without a location.")
                if redirect_count >= max_redirects:
                    raise DownloadSafetyError("The URL exceeded the redirect limit.")
                next_url = requests.compat.urljoin(current_url, location)
                current_url = assert_public_http_url(next_url, resolver)
                continue

            response.raise_for_status()
            content_type = response.headers.get("Content-Type", "")
            if not _content_type_is_allowed(content_type):
                raise DirectMediaTypeError(
                    "The URL did not return an allowed video media Content-Type "
                    "(it may be a platform page rather than a direct media link)."
                )

            declared_length = response.headers.get("Content-Length")
            if declared_length:
                try:
                    if int(declared_length) > max_bytes:
                        raise DownloadLimitError("The video exceeds the download size limit.")
                except ValueError:
                    pass

            bytes_written = 0
            try:
                with destination.open("wb") as output:
                    for chunk in response.iter_content(chunk_size=1024 * 256):
                        if not chunk:
                            continue
                        bytes_written += len(chunk)
                        if bytes_written > max_bytes:
                            raise DownloadLimitError(
                                "The video exceeds the download size limit."
                            )
                        output.write(chunk)
            except Exception:
                destination.unlink(missing_ok=True)
                raise

            return DownloadResult(
                path=destination,
                url=current_url,
                content_type=content_type,
                bytes_written=bytes_written,
            )
        finally:
            response.close()

    raise DownloadSafetyError("The URL could not be downloaded.")


def main() -> int:
    parser = argparse.ArgumentParser(description="Safely download a public direct video URL.")
    parser.add_argument("url")
    parser.add_argument("destination", type=Path)
    parser.add_argument("--max-bytes", type=int, default=DEFAULT_MAX_BYTES)
    args = parser.parse_args()

    try:
        result = download_public_video(args.url, args.destination, max_bytes=args.max_bytes)
    except (DownloadSafetyError, DownloadLimitError, requests.RequestException) as exc:
        print(json.dumps({"ok": False, "error": str(exc)}, ensure_ascii=False))
        return 1

    print(
        json.dumps(
            {
                "ok": True,
                "path": str(result.path),
                "url": result.url,
                "content_type": result.content_type,
                "bytes_written": result.bytes_written,
            },
            ensure_ascii=False,
        )
    )
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
