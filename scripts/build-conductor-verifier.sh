#!/usr/bin/env bash
set -euo pipefail

repo_dir="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
engine="${CONTAINER_ENGINE:-docker}"
image="${VERIFIER_IMAGE:-conductor-verifier:phase10}"

if ! command -v "$engine" >/dev/null 2>&1; then
  printf 'Verifier build failed: container engine %s was not found.\n' "$engine" >&2
  exit 2
fi

if ! "$engine" info >/dev/null 2>&1; then
  printf 'Verifier build failed: container engine %s is not running.\n' "$engine" >&2
  exit 2
fi

"$engine" build \
  --file "$repo_dir/apps/server/Dockerfile.verifier" \
  --tag "$image" \
  "$repo_dir/apps/server"

printf 'Built Conductor verifier image %s with %s.\n' "$image" "$engine"
