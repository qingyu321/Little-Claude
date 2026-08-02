#!/usr/bin/env bash
set -euo pipefail

# ============================================================
# Bump version across all three sources of truth:
#   - package.json
#   - src-tauri/tauri.conf.json
#   - src-tauri/Cargo.toml
#
# Usage:
#   ./scripts/bump-version.sh 0.9.0
# ============================================================

if [ $# -ne 1 ]; then
  echo "Usage: $0 <new-version>"
  echo "Example: $0 0.9.0"
  exit 1
fi

NEW_VERSION="$1"
PROJECT_DIR="$(cd "$(dirname "$0")/.." && pwd)"

# Validate semver format (basic check)
if ! echo "$NEW_VERSION" | grep -qE '^[0-9]+\.[0-9]+\.[0-9]+$'; then
  echo "ERROR: Version must be semver format (e.g., 0.9.0)"
  exit 1
fi

OLD_VERSION=$(python3 -c "import json; print(json.load(open('$PROJECT_DIR/package.json'))['version'])")
echo "Bumping version: $OLD_VERSION → $NEW_VERSION"

# 1. package.json
python3 -c "
import json, pathlib
p = pathlib.Path('$PROJECT_DIR/package.json')
d = json.loads(p.read_text())
d['version'] = '$NEW_VERSION'
p.write_text(json.dumps(d, indent=2, ensure_ascii=False) + '\n')
"
echo "  package.json ✓"

# 2. tauri.conf.json
python3 -c "
import json, pathlib
p = pathlib.Path('$PROJECT_DIR/src-tauri/tauri.conf.json')
d = json.loads(p.read_text())
d['version'] = '$NEW_VERSION'
p.write_text(json.dumps(d, indent=2, ensure_ascii=False) + '\n')
"
echo "  tauri.conf.json ✓"

# 3. Cargo.toml (line-based replacement)
sed -i '' "s/^version = \"$OLD_VERSION\"/version = \"$NEW_VERSION\"/" "$PROJECT_DIR/src-tauri/Cargo.toml"
echo "  Cargo.toml ✓"

echo ""
echo "Done! Version bumped to $NEW_VERSION across all files."
echo "Don't forget to update CHANGELOG.md with the new version header."
