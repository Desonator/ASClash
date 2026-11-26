#!/bin/sh
set -eu

SCRIPT_DIR=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)
RULES_SCRIPT="$SCRIPT_DIR/../luci-app-asclash/rootfs/opt/clash/bin/clash-rules"
TEST_DIR=$(mktemp -d)
trap 'rm -rf "$TEST_DIR"' EXIT INT TERM

awk '
  /^update_rules\(\) \{/ { active=1 }
  active && /^[A-Za-z_][A-Za-z0-9_]*\(\) \{/ && $0 !~ /^update_rules\(\) \{/ { exit }
  active { print }
' "$RULES_SCRIPT" > "$TEST_DIR/update-function.sh"

cat > "$TEST_DIR/test.sh" <<'EOF'
#!/bin/sh
set -eu
. "$1"
ASCLASH_UPDATE_DEFERRED=false
ASCLASH_FAKEIP_STATE=unknown
ASCLASH_GROUPED_STATE=unknown
hash() { return 0; }
nft() { return 1; }
msg() { :; }
warn() { :; }
update_fakeip_whitelist_sets() { printf '%s\n' 'unexpected firewall-set refresh' >&2; return 91; }
cache_subscription_ips() { printf '%s\n' 'unexpected subscription cache refresh' >&2; return 92; }
update_rules
[ "$ASCLASH_UPDATE_DEFERRED" = true ]
[ "$ASCLASH_FAKEIP_STATE" = waiting ]
[ "$ASCLASH_GROUPED_STATE" = waiting ]
EOF

sh "$TEST_DIR/test.sh" "$TEST_DIR/update-function.sh"
printf '%s\n' 'Update deferral without active firewall tests passed.'
