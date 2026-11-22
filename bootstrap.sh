#!/usr/bin/env bash
set -euo pipefail

if [[ "$EUID" == 0 ]] || ! command -v omarchy >/dev/null; then
  printf '%s\n' 'Run this as your regular desktop user on Omarchy.' >&2
  exit 1
fi

if ! command -v bun >/dev/null; then
  omarchy pkg add bun || omarchy pkg aur add bun-bin
fi

if [[ -n "${BASH_SOURCE[0]:-}" ]]; then
  source_dir="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"
  if [[ -f "$source_dir/snshah.ts" ]]; then
    exec bun "$source_dir/snshah.ts" apply "$@"
  fi
fi

remote=https://github.com/shah/ergonex.git
ref="$(git ls-remote --exit-code "$remote" refs/heads/main)"
revision="${ref%%[[:space:]]*}"
[[ "$revision" =~ ^[0-9a-f]{40}$ ]]
scratch="$(mktemp -d)"
trap 'rm -rf -- "$scratch"' EXIT
curl -fsSL "https://codeload.github.com/shah/ergonex/tar.gz/$revision" -o "$scratch/source.tar.gz"
tar -xzf "$scratch/source.tar.gz" -C "$scratch" --strip-components=1
bun "$scratch/snshah.ts" apply "$@"
