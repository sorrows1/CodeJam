#!/usr/bin/env bash
set -euo pipefail

usage() {
  printf 'Usage: npm run demo:reset -- /absolute/path/to/conductor-demo\n' >&2
}

if [[ "$#" -ne 1 || -z "$1" ]]; then
  usage
  exit 2
fi

destination_input="$1"
while [[ "$destination_input" != "/" && "$destination_input" == */ ]]; do
  destination_input="${destination_input%/}"
done

has_symlink_component() {
  local current="$1"
  while [[ "$current" != "/" && -n "$current" ]]; do
    if [[ -L "$current" ]]; then return 0; fi
    current="$(dirname -- "$current")"
  done
  return 1
}

if [[ "$destination_input" != /* || ! -d "$destination_input" ]] || has_symlink_component "$destination_input"; then
  printf 'Refusing reset: provide an existing absolute demo-root directory without symlinked path components.\n' >&2
  exit 2
fi

destination="$(cd -P -- "$destination_input" && pwd -P)"
destination_name="$(basename -- "$destination")"
repo_dir="$(cd -P -- "$(dirname -- "${BASH_SOURCE[0]}")/.." && pwd -P)"

if [[ "$destination" == "/" || "$destination" == "$repo_dir" || "$destination" == "$repo_dir"/* || "$destination" == "${HOME:-}" ]]; then
  printf 'Refusing reset: the repository, home directory, and filesystem root are not demo roots.\n' >&2
  exit 2
fi

if [[ ! "$destination_name" =~ ^conductor-demo(-[^/]*)?$ ]]; then
  printf 'Refusing reset: name the dedicated root conductor-demo or conductor-demo-*.\n' >&2
  exit 2
fi

for item in data workspaces codex-home; do
  target="$destination/$item"
  if [[ -L "$target" ]]; then
    printf 'Refusing reset: %s is symlinked.\n' "$target" >&2
    exit 2
  fi
done

for item in data workspaces codex-home; do
  target="$destination/$item"
  if [[ -e "$target" ]]; then
    rm -rf -- "$target"
  fi
done

printf 'Reset named Conductor demo state under %s (data, workspaces, codex-home).\n' "$destination"
printf 'The demo-root directory and unrelated files were preserved.\n'
