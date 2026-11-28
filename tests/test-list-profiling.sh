#!/bin/sh
set -eu
SCRIPT_DIR=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)
RULES_SCRIPT="$SCRIPT_DIR/../luci-app-asclash/rootfs/opt/clash/bin/clash-rules"
TEST_DIR=$(mktemp -d)
trap 'rm -rf "$TEST_DIR"' EXIT INT TERM
for name in profile_now_ms profile_run; do
    awk -v name="$name" '
        $0 ~ ("^" name "\\(\\) \\{") { active=1 }
        active && /^[A-Za-z_][A-Za-z0-9_]*\(\) \{/ && $0 !~ ("^" name "\\(\\) \\{") { exit }
        active { print }
    ' "$RULES_SCRIPT" >> "$TEST_DIR/functions"
done
. "$TEST_DIR/functions"
ASCLASH_PROFILE_FILE="$TEST_DIR/profile"
state=before
success() { state=after; printf 'payload\n'; }
failure() { return 7; }
profile_run generation success > "$TEST_DIR/output"
[ "$state" = after ]
[ "$(cat "$TEST_DIR/output")" = payload ]
if profile_run parsing failure; then exit 1; else rc=$?; fi
[ "$rc" -eq 7 ]
grep -Eq '^timing\|generation\|[0-9]+\|0$' "$ASCLASH_PROFILE_FILE"
grep -Eq '^timing\|parsing\|[0-9]+\|7$' "$ASCLASH_PROFILE_FILE"
ASCLASH_PROFILE_FILE=''
[ "$(profile_run generation success)" = payload ]
printf '%s\n' 'List profiling preserves stdout, state and exit status.'
