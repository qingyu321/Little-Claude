#!/usr/bin/env python3
"""Replace an existing GitHub release asset (DELETE old + POST new).

Same credentials/TLS plumbing as publish-release.py, plus the asset-id
lookup and DELETE step that script lacks (GitHub refuses same-name
duplicates with 409).

Usage:
  python scripts/replace-release-asset.py <tag> <local_path> [<asset_name>]

Prints the new asset's server-side sha256 digest for verification.
"""
import hashlib
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
    if len(sys.argv) < 3:
        raise SystemExit(__doc__)
    tag, path = sys.argv[1], sys.argv[2]
    # GitHub sanitizes spaces in asset names to dots; default to the
    # sanitized basename (same rule publish-release.py applies).
    name = sys.argv[3] if len(sys.argv) > 3 else os.path.basename(path).replace(' ', '.')
    token = get_token()

    # 1. Find the release + its current assets
    _, rel = call("GET", f"{API}/repos/{REPO}/releases/tags/{tag}", token)
    print(f"release {tag} (id {rel['id']})")
    old = [a for a in rel["assets"] if a["name"] == name]
    if old:
        for a in old:
            st, _ = call("DELETE", f"{API}/repos/{REPO}/releases/assets/{a['id']}", token)
            assert st == 204, f"DELETE asset {a['id']} -> {st}"
            print(f"deleted old asset {a['id']} ({a['name']}, {a['size']} bytes, sha {a.get('digest')})")
    else:
        print(f"no existing asset named {name} on {tag} — uploading fresh")

    # 2. Upload the replacement (uploads.github.com only)
    size = os.path.getsize(path)
    local_sha = hashlib.sha256()
    with open(path, "rb") as f:
        data = f.read()
    local_sha.update(data)
    local_hex = local_sha.hexdigest()
    print(f"local  sha256: {local_hex}")
    upload_url = rel["upload_url"].replace("{?name,label}", "")
    url = f"{upload_url}?name={urllib.parse.quote(name)}"
    print(f"uploading {name} ({size} bytes)...", flush=True)
    st, asset = call("POST", url, token, data=data,
                     headers={"Content-Type": "application/octet-stream",
                              "Content-Length": str(size)})
    print(f"  -> {asset['name']} ({asset['size']} bytes)")
    digest = asset.get("digest", "")
    print(f"server sha256: {digest}")
    if digest and digest.startswith("sha256:") and digest[len("sha256:"):] == local_hex:
        print("MATCH: server digest equals local sha256")
    else:
        print("WARNING: server digest mismatch or absent — verify manually")
    print("DONE")


if __name__ == "__main__":
    main()
