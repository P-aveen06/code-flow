#!/usr/bin/env bash
set -euo pipefail

cd -- "$(dirname -- "${BASH_SOURCE[0]}")/.."

max_commits=${1:-50}
if [[ $# -gt 1 || ! $max_commits =~ ^[1-9][0-9]*$ ]]; then
    printf 'Usage: %s [positive commit count]\n' "$0" >&2
    exit 1
fi

name=Flagsmith/flagsmith
url="https://github.com/$name"
subdir=api
clone=data/repos/Flagsmith__flagsmith
output=data/Flagsmith__flagsmith
depth=$((4 * max_commits))
if (( depth < 100 )); then
    depth=100
fi

SECONDS=0
mkdir -p -- data/repos
if [[ -e "$clone/.git" ]]; then
    remote_head=$(git ls-remote --symref "$url" HEAD)
    read -r label head _ <<< "$remote_head"
    if [[ $label != ref: || $head != refs/heads/* ]]; then
        printf 'Could not find the default branch for %s.\n' "$name" >&2
        exit 1
    fi
    branch="refs/remotes/origin/${head#refs/heads/}"
    git -C "$clone" fetch "$url" "+$head:$branch"
else
    git clone --depth "$depth" --single-branch --no-checkout -- "$url" "$clone"
    branch=$(git -C "$clone" symbolic-ref refs/remotes/origin/HEAD)
    head="refs/heads/${branch#refs/remotes/origin/}"
fi

# Keep one extra matching commit so the oldest listed diff has a base.
needed=$((max_commits + 1))
while [[ $(git -C "$clone" rev-parse --is-shallow-repository) == true ]]; do
    count=$(git -C "$clone" rev-list --first-parent --count --max-count="$needed" "$branch" -- "$subdir")
    if (( count >= needed )); then
        break
    fi
    git -C "$clone" fetch --deepen="$depth" "$url" "+$head:$branch"
done

uv run --project analyzer code-flow analyze "$clone" \
    --branch "$branch" --source-root "$subdir" --touching "$subdir" \
    --max-commits "$max_commits" --out "$output"

python3 - "$output" "$url" "$name" "$subdir" "$max_commits" <<'PY'
import json
import sys
from datetime import datetime, timezone
from pathlib import Path
from tempfile import NamedTemporaryFile

output, url, name, subdir, max_commits = sys.argv[1:]
metadata = {
    "url": url,
    "name": name,
    "subdir": subdir,
    "max_commits": int(max_commits),
    "imported_at": datetime.now(timezone.utc).isoformat(),
}
with NamedTemporaryFile(mode="w", encoding="utf-8", dir=output, delete=False) as stream:
    stream.write(json.dumps(metadata, indent=2) + "\n")
Path(stream.name).replace(Path(output) / "source.json")
PY

printf '\nFlagsmith fetch and analysis took %s seconds.\n' "$SECONDS"
