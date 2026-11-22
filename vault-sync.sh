#!/bin/sh
# Managed by snshah (vault compatibility)
if [ "$#" -eq 0 ]; then set -- status; fi
exec "$HOME/.local/bin/snshah" vault "$@"
