#!/usr/bin/env bash
set -euo pipefail

base_ref="${NEOCODE_CANDIDATE_BASE_REF:-main}"
git rev-parse --verify "$base_ref" >/dev/null
base="$(git rev-parse "$base_ref")"
head="$(git rev-parse HEAD)"
parent="$(git rev-parse HEAD^)"
merge_base="$(git merge-base "$base_ref" HEAD)"
tree="$(git rev-parse 'HEAD^{tree}')"

printf '$ git rev-parse %s HEAD HEAD^\n' "$base_ref"
printf '%s\n%s\n%s\n' "$base" "$head" "$parent"
printf '$ git rev-parse HEAD^{tree}\n%s\n' "$tree"
printf '$ git merge-base %s HEAD\n%s\n' "$base_ref" "$merge_base"

printf '$ git diff --name-status %s..HEAD\n' "$merge_base"
git diff --name-status "$merge_base"..HEAD
printf '$ git diff --binary %s..HEAD | shasum -a 256\n' "$merge_base"
git diff --binary "$merge_base"..HEAD | shasum -a 256
printf '$ git status --porcelain\n'
porcelain="$(git status --porcelain)"
printf '%s' "$porcelain"
if [[ -n "$porcelain" ]]; then
  printf '\nworktree is dirty\n' >&2
  exit 1
fi
printf '$ git diff --check %s..HEAD\n' "$merge_base"
git diff --check "$merge_base"..HEAD
printf 'git diff --check exit: 0\n'
