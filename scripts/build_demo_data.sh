#!/usr/bin/env bash
set -euo pipefail

if [[ $# != 1 || -z "$1" ]]; then
    printf 'Usage: %s NEW_DATA_DIRECTORY\n' "$0" >&2
    exit 1
fi
# Require a fresh destination so a local run can't overwrite analyzed data.
mkdir -- "$1"
data_dir=$(cd -- "$1" && pwd -P)
repo_root=$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")/.." && pwd -P)

shop="$data_dir/repos/shop-demo"
bash "$repo_root/examples/make_shop_demo.sh" "$shop"
code-flow analyze "$shop" --branch main --out "$data_dir/shop-demo"

url=https://github.com/Flagsmith/flagsmith
pin=0c37fca299b94d54760fe7fa76818d19f05bf639
subdir=api
limit=50
depth=200
branch=refs/remotes/origin/main
clone="$data_dir/repos/Flagsmith__flagsmith"
output="$data_dir/Flagsmith__flagsmith"

git init --quiet --initial-branch=main "$clone"
git -C "$clone" remote add origin "$url"
git -C "$clone" fetch --no-tags --depth="$depth" origin "$pin:$branch"
# Keep one extra api/ commit so the oldest displayed diff has a base.
while [[ $(git -C "$clone" rev-list --first-parent --count --max-count=$((limit + 1)) "$branch" -- "$subdir") -le $limit ]]; do
    if [[ $(git -C "$clone" rev-parse --is-shallow-repository) == false ]]; then
        printf 'Pinned Flagsmith history contains fewer than %s api/ commits and a base.\n' "$limit" >&2
        exit 1
    fi
    git -C "$clone" fetch --no-tags --deepen="$depth" origin "$pin:$branch"
done
git -C "$clone" update-ref refs/heads/main "$pin"
git -C "$clone" symbolic-ref refs/remotes/origin/HEAD "$branch"

code-flow analyze "$clone" --branch "$branch" --source-root "$subdir" \
    --touching "$subdir" --max-commits "$limit" --out "$output"

python3 - "$output" "$url" "$subdir" "$limit" "$pin" <<'PY'
import json
import sys
from datetime import UTC, datetime
from pathlib import Path

output, url, subdir, limit, pin = sys.argv[1:]
directory = Path(output)
commits = json.loads((directory / "commits.json").read_text())["commits"]
if len(commits) != int(limit) or commits[-1]["sha"] != pin or not commits[0]["base"]:
    raise SystemExit("The Flagsmith demo must contain 50 pinned commits and a base snapshot.")
metadata = {
    "url": url,
    "name": "Flagsmith/flagsmith",
    "subdir": subdir,
    "max_commits": int(limit),
    "imported_at": datetime.now(UTC).isoformat(),
}
(directory / "source.json").write_text(json.dumps(metadata, indent=2) + "\n")
PY
