#!/usr/bin/env python3
"""Task 04: sign a web-update manifest (latest.json) with ed25519.

Usage:
  python scripts/sign-web-update.py [path/to/latest.json]

Signs the canonical string  "{version}|{sha256}|{zipUrl}"  with the private
key at .tokenicode/secrets/webupdate-signing.key (raw 32 bytes, gitignored)
and writes the base64 signature into the manifest's `sig` field (in place).

The matching PUBLIC key is embedded in src-tauri/src/commands/web_update.rs
(WEB_UPDATE_SIGNING_KEY_B64) and verified by download_web_update. Rotating
the key = regenerate the pair, update the embedded constant, ship a binary.

Requires: pip install cryptography
"""
import base64
import json
import os
import sys

REPO_ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
KEY_PATH = os.path.join(REPO_ROOT, ".tokenicode", "secrets", "webupdate-signing.key")


def main() -> None:
    manifest_path = sys.argv[1] if len(sys.argv) > 1 else os.path.join(REPO_ROOT, "latest.json")

    if not os.path.exists(KEY_PATH):
        raise SystemExit(
            f"private key not found: {KEY_PATH}\n"
            "generate one (then update the public key embedded in web_update.rs):\n"
            "  python - <<'EOF'\n"
            "  from cryptography.hazmat.primitives.asymmetric import ed25519\n"
            "  from cryptography.hazmat.primitives import serialization\n"
            "  import base64\n"
            "  k = ed25519.Ed25519PrivateKey.generate()\n"
            "  priv = k.private_bytes(serialization.Encoding.Raw, serialization.PrivateFormat.Raw, serialization.NoEncryption())\n"
            "  pub = k.public_key().public_bytes(serialization.Encoding.Raw, serialization.PublicFormat.Raw)\n"
            "  open('.tokenicode/secrets/webupdate-signing.key','wb').write(priv)\n"
            "  print('PUBLIC_KEY_B64=' + base64.b64encode(pub).decode())\n"
            "  EOF"
        )

    with open(manifest_path, "r", encoding="utf-8") as f:
        manifest = json.load(f)

    version = manifest.get("version", "")
    sha256 = manifest.get("sha256", "")
    zip_url = manifest.get("zipUrl", "")
    if not (version and sha256 and zip_url):
        raise SystemExit("manifest missing version/sha256/zipUrl — run make-web-update.ps1 first")

    payload = f"{version}|{sha256}|{zip_url}".encode("utf-8")

    from cryptography.hazmat.primitives.asymmetric import ed25519

    with open(KEY_PATH, "rb") as f:
        key_bytes = f.read()
    key = ed25519.Ed25519PrivateKey.from_private_bytes(key_bytes[:32])
    sig = key.sign(payload)

    manifest["sig"] = base64.b64encode(sig).decode("ascii")
    with open(manifest_path, "w", encoding="utf-8") as f:
        json.dump(manifest, f, ensure_ascii=False, separators=(",", ":"))

    print(f"signed {manifest_path}")
    print(f"  payload: {payload.decode()}")
    print(f"  sig    : {manifest['sig']}")


if __name__ == "__main__":
    main()
