#!/bin/sh
set -eu

MAKEFILE=$(CDPATH= cd -- "$(dirname -- "$0")/.." && pwd)/luci-app-asclash/Makefile

grep -Eq '^PKG_FILE_MODES:=[[:space:]]*/etc/init\.d/clash:root:root:0755[[:space:]]*$' "$MAKEFILE"
grep -Fq 'chown 0:0 "$$INIT_SCRIPT" || exit 1' "$MAKEFILE"
grep -Fq 'chmod 0755 "$$INIT_SCRIPT" || exit 1' "$MAKEFILE"
printf '%s\n' 'Init script package ownership is pinned to root:root (0755).'
