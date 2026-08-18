#!/usr/bin/env python3
"""Verify a published release: latest.json consistency + web-dist zip SHA256 +
installer size. TLS verification is ON (default context) — a release-verifier
that disables certificate validation defeats its own purpose.

Usage:
    python3 scripts/verify-release.py [VERSION]
Reads expected values from env overrides when provided:
    EXPECTED_ZIP_SHA256, EXPECTED_EXE_SIZE, REPO (default qingyu321/Little-Claude)
"""

import hashlib
import json
import os
import sys
import urllib.request

REPO = os.environ.get("REPO", "qingyu321/Little-Claude")
VERSION = sys.argv[1] if len(sys.argv) > 1 else ""


def get(url, head=False):
    req = urllib.request.Request(url, method="HEAD" if head else "GET")
    with urllib.request.urlopen(req, timeout=60) as r:
        return r.status, dict(r.headers), r.read() if not head else b""


def main():
    # 1. raw latest.json
    st, h, body = get(f"https://raw.githubusercontent.com/{REPO}/main/latest.json")
    d = json.loads(body)
    print("1. raw latest.json:", json.dumps(d, ensure_ascii=False))
    version = VERSION or d.get("version", "")
    if not version:
        print("ERROR: no version — pass it as argv[1] or read latest.json")
        return 1
    if VERSION and d.get("version") != VERSION:
        print(f"ERROR: latest.json version {d.get('version')} != requested {VERSION}")
        return 1

    # 2. download zip, compare sha256
    st, h, body = get(
        f"https://github.com/{REPO}/releases/download/v{version}/web-dist-v{version}.zip"
    )
    sha = hashlib.sha256(body).hexdigest()
    print("2. web-dist zip  sha256:", sha, "| size:", len(body))
    expected_sha = os.environ.get("EXPECTED_ZIP_SHA256", d.get("sha256", ""))
    if not expected_sha:
        print("WARNING: no EXPECTED_ZIP_SHA256 / latest.json sha256 to compare")
    elif sha != expected_sha:
        print(f"ERROR: zip sha mismatch (expected {expected_sha})")
        return 1

    # 3. exe HEAD -> Content-Length
    st, h, body = get(
        f"https://github.com/{REPO}/releases/download/v{version}/Little.Claude.v{version}.exe",
        head=True,
    )
    cl = h.get("Content-Length")
    print("3. exe HEAD status:", st, "| Content-Length:", cl)
    expected_size = os.environ.get("EXPECTED_EXE_SIZE")
    if expected_size and cl != expected_size:
        print(f"ERROR: exe size mismatch (expected {expected_size})")
        return 1

    print("ALL VERIFIED OK")


if __name__ == "__main__":
    sys.exit(main())
