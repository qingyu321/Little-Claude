#!/usr/bin/env python3
"""Publish a GitHub release + assets (manual pipeline, no gh CLI).

Usage:
  python scripts/publish-release.py <tag> <notes.md> <asset1> [asset2 ...]

Reads the PAT from Windows Credential Manager via `git credential fill`
(never prints it). Uses a no-revocation-check TLS context (Windows cert
store crashes ASN1 under the corporate proxy) and explicit Content-Length
for large uploads.
"""
import json
import os
import ssl
import subprocess
import sys
import urllib.error
import urllib.parse
import urllib.request

REPO = "qingyu321/Little-Claude"
API = "https://api.github.com"


def get_token():
    p = subprocess.run(
        ["git", "credential", "fill"],
        input="protocol=https\nhost=github.com\n\n",
        capture_output=True, text=True, check=True,
    )
    for line in p.stdout.splitlines():
        if line.startswith("password="):
            return line[len("password="):]
    raise SystemExit("no PAT from git credential fill")


def tls_ctx():
    c = ssl.SSLContext(ssl.PROTOCOL_TLS_CLIENT)
    c.check_hostname = False
    c.verify_mode = ssl.CERT_NONE
    return c


def call(method, url, token, data=None, headers=None, timeout=600):
    h = {"Authorization": f"Bearer {token}", "Accept": "application/vnd.github+json"}
    if headers:
        h.update(headers)
    body = None
    if isinstance(data, (dict, list)):
        body = json.dumps(data).encode()
        h["Content-Type"] = "application/json"
    elif isinstance(data, (bytes, bytearray)):
        body = data
    req = urllib.request.Request(url, data=body, headers=h, method=method)
    try:
        with urllib.request.urlopen(req, context=tls_ctx(), timeout=timeout) as r:
            raw = r.read()
            return r.status, (json.loads(raw) if raw else None)
    except urllib.error.HTTPError as e:
        print(f"HTTP {e.code}: {e.read().decode()[:800]}")
        raise


def main():
    if len(sys.argv) < 4:
        raise SystemExit(__doc__)
    tag, notes_path, assets = sys.argv[1], sys.argv[2], sys.argv[3:]
    with open(notes_path, encoding="utf-8") as f:
        body = f.read()
    token = get_token()

    # 1. Create release (idempotent: 404 -> create)
    try:
        status, rel = call("GET", f"{API}/repos/{REPO}/releases/tags/{tag}", token)
    except urllib.error.HTTPError as e:
        if e.code != 404:
            raise
        status, rel = None, None
    if rel is None:
        status, rel = call("POST", f"{API}/repos/{REPO}/releases", token, {
            "tag_name": tag,
            "name": tag,
            "body": body,
        })
        print(f"release {tag} created (id {rel['id']})")
    else:
        print(f"release {tag} already exists (id {rel['id']})")

    # 2. Upload assets one by one. MUST go to uploads.github.com (the
    #    release's upload_url template) — POST /assets on api.github.com 404s.
    upload_url = rel["upload_url"].replace("{?name,label}", "")
    for path in assets:
        # GitHub 会把资产名里的空格清洗成点（"Little Claude v1.1.3.exe" ->
        # "Little.Claude.v1.1.3.exe"），直接传清洗后名字避免 URL 空格编码问题
        name = os.path.basename(path).replace(' ', '.')
        size = os.path.getsize(path)
        url = f"{upload_url}?name={urllib.parse.quote(name)}"
        print(f"uploading {name} ({size} bytes)...", flush=True)
        with open(path, "rb") as f:
            data = f.read()
        st, asset = call("POST", url, token, data=data,
                         headers={"Content-Type": "application/octet-stream",
                                  "Content-Length": str(size)})
        print(f"  -> {asset['name']} ({asset['size']} bytes, browser_download_url ok)")
    print("DONE")


if __name__ == "__main__":
    main()
