#!/bin/sh

main() {
  set -eu

  if [ "$(id -u)" -eq 0 ] || ! command -v omarchy >/dev/null; then
    printf '%s\n' 'Run this as your regular desktop user on Omarchy.' >&2
    exit 1
  fi

  if [ -f "$0" ]; then
    source_dir=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)
    if [ -f "$source_dir/snshah.ts" ]; then
      install_bun
      exec bun --no-env-file "$source_dir/snshah.ts" apply "$@"
    fi
  fi

  remote=https://github.com/shah/workshop.git
  ref=$(git ls-remote --exit-code "$remote" refs/heads/main)
  revision=${ref%%[[:space:]]*}
  case "$revision" in
    ''|*[!0-9a-f]*) exit 1 ;;
  esac
  [ "${#revision}" -eq 40 ] || exit 1

  scratch=$(mktemp -d "${TMPDIR:-/tmp}/workshop.auto.bootstrap-XXXXXX")
  trap 'rm -rf -- "$scratch"' 0
  curl -fsSL "https://codeload.github.com/shah/workshop/tar.gz/$revision" -o "$scratch/source.auto.tar.gz"
  tar -xzf "$scratch/source.auto.tar.gz" -C "$scratch" --strip-components=1
  install_bun
  bun --no-env-file "$scratch/snshah.ts" apply "$@"
}

install_bun() {
  command -v bun >/dev/null || omarchy pkg add bun || omarchy pkg aur add bun-bin
}

main "$@"
