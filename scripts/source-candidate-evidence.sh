#!/usr/bin/env bash
set -euo pipefail
source_commit="62657b930701a392e943be402982f2fdf43b765b"
source_parent="bb615e9f1f3d874ee3498bdc16faa8636cd8e5d4"
printf '$ git rev-parse %s %s %s^{tree}\n' "$source_commit" "$source_parent" "$source_commit"
git rev-parse "$source_commit" "$source_parent" "$source_commit^{tree}"
printf '$ git diff --name-status %s %s\n' "$source_parent" "$source_commit"
git diff --name-status "$source_parent" "$source_commit"
printf '$ git diff --binary %s %s | shasum -a 256\n' "$source_parent" "$source_commit"
git diff --binary "$source_parent" "$source_commit" | shasum -a 256
