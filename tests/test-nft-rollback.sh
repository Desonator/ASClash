#!/bin/sh
set -eu

SCRIPT_DIR=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)
RULES_SCRIPT="$SCRIPT_DIR/../luci-app-asclash/rootfs/opt/clash/bin/clash-rules"
TEST_DIR=$(mktemp -d)
trap 'rm -rf "$TEST_DIR"' EXIT INT TERM

awk '
  /^rollback_nft_rules\(\) \{/ { active=1 }
  active && /^[A-Za-z_][A-Za-z0-9_]*\(\) \{/ && $0 !~ /^rollback_nft_rules\(\) \{/ { exit }
  active { print }
' "$RULES_SCRIPT" > "$TEST_DIR/rollback.sh"

cat > "$TEST_DIR/nft" <<'EOF'
#!/bin/sh
printf '%s\n' "$*" >> "$NFT_CALLS"
exit 0
EOF
chmod +x "$TEST_DIR/nft"

cat > "$TEST_DIR/test.sh" <<'EOF'
#!/bin/sh
set -eu
. "$1"
NFT_FAILURE_TRACKER=''
NFT_PREVIOUS_TABLE_SNAPSHOT="$2"
NFT_PREVIOUS_TUN_FORWARD=true
PROXY_MODE=tproxy
NFT_CALLS="$3"
msg() { :; }
warn() { :; }
teardown_nft_tun_forward_rules() { :; }
apply_nft_tun_forward_rules() { printf 'forward-rules-restored-in-%s\n' "$PROXY_MODE" >> "$NFT_CALLS"; }
setup_routing_rules() { printf '%s\n' 'policy-routes-restored' >> "$NFT_CALLS"; }
export NFT_CALLS
if rollback_nft_rules '' true; then
  printf '%s\n' 'Rollback should report the failed rebuild.' >&2
  exit 1
fi
EOF

printf '%s\n' 'table inet clash { }' > "$TEST_DIR/previous.nft"
if PATH="$TEST_DIR:$PATH" sh "$TEST_DIR/test.sh" "$TEST_DIR/rollback.sh" "$TEST_DIR/previous.nft" "$TEST_DIR/nft-calls"; then :; fi
grep -F -q 'delete table inet clash' "$TEST_DIR/nft-calls"
grep -F -q -- "-f $TEST_DIR/previous.nft" "$TEST_DIR/nft-calls"
grep -F -q 'forward-rules-restored-in-mixed' "$TEST_DIR/nft-calls"
grep -F -q 'policy-routes-restored' "$TEST_DIR/nft-calls"
[ ! -e "$TEST_DIR/previous.nft" ] || { printf '%s\n' 'Rollback snapshot was not cleaned.' >&2; exit 1; }
printf '%s\n' 'nftables rollback snapshot tests passed.'
