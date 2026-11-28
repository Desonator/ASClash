#!/bin/sh
set -eu
SCRIPT_DIR=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)
RULES_SCRIPT="$SCRIPT_DIR/../luci-app-asclash/rootfs/opt/clash/bin/clash-rules"
TEST_DIR=$(mktemp -d)
trap 'rm -rf "$TEST_DIR"' EXIT INT TERM
mkdir -p "$TEST_DIR/runtime"
awk '/^apply_fakeip_policy_transaction\(\) \{/ { active=1 } active && /^update_fakeip_whitelist_sets\(\) \{/ { exit } active { print }' "$RULES_SCRIPT" | sed "s@/tmp/clash@$TEST_DIR/runtime@g" > "$TEST_DIR/function"
. "$TEST_DIR/function"
GROUPED_FAKEIP_PORT_RULES_ENABLED=true
GROUPED_FAKEIP_PORT_RULES_DRY_RUN=false
GROUPED_FAKEIP_DIGEST_FILE="$TEST_DIR/source"
GROUPED_FAKEIP_APPLIED_DIGEST_FILE="$TEST_DIR/applied"
FAKEIP_WHITELIST_DIGEST_FILE="$TEST_DIR/whitelist-applied"
FAKEIP_WHITELIST_IPS_FILE="$TEST_DIR/whitelist"
printf '%s\n' '192.0.2.0/24' > "$FAKEIP_WHITELIST_IPS_FILE"
printf '%s\n' 'source-1' > "$GROUPED_FAKEIP_DIGEST_FILE"
printf '%s\n' 'group' > "$TEST_DIR/runtime/fakeip_port_groups"
profile_run() { shift; "$@"; }
warn() { :; }
msg() { :; }
apply_grouped_port_nft_rules() {
    printf '%s\n' 'add set inet clash fp_123456789abc { type ipv4_addr; flags interval; auto-merge; }' 'add rule inet clash ASCLASH_GROUPED ip daddr @fp_123456789abc tcp dport 443 counter' > "$1"
}
nft() {
    case "$*" in
        'list set inet clash fakeip_whitelist'|'list chain inet clash ASCLASH_GROUPED') return 0 ;;
        '-t list table inet clash') printf '\tset fp_abcdef123456 {\n\tset proxy_servers {\n'; return 0 ;;
        '-c -f '*) [ "${FAIL_CHECK:-false}" != true ] ;;
        '-f '*) cp "$2" "$TEST_DIR/committed"; [ "${FAIL_COMMIT:-false}" != true ] ;;
        *) return 1 ;;
    esac
}
apply_fakeip_policy_transaction whitelist-1
[ "$(cat "$GROUPED_FAKEIP_APPLIED_DIGEST_FILE")" = source-1 ]
[ "$(cat "$FAKEIP_WHITELIST_DIGEST_FILE")" = whitelist-1 ]
grep -q '^flush set inet clash fakeip_whitelist' "$TEST_DIR/committed"
grep -q '^delete set inet clash fp_abcdef123456' "$TEST_DIR/committed"
! grep -q '^delete set inet clash proxy_servers' "$TEST_DIR/committed"
rm -f "$TEST_DIR/committed"
apply_fakeip_policy_transaction whitelist-1
[ ! -e "$TEST_DIR/committed" ]
printf '%s\n' source-2 > "$GROUPED_FAKEIP_DIGEST_FILE"
FAIL_CHECK=true
if apply_fakeip_policy_transaction whitelist-2; then exit 1; fi
[ ! -e "$TEST_DIR/committed" ]
[ "$(cat "$GROUPED_FAKEIP_APPLIED_DIGEST_FILE")" = source-1 ]
FAIL_CHECK=false
FAIL_COMMIT=true
if apply_fakeip_policy_transaction whitelist-2; then exit 1; fi
[ "$(cat "$GROUPED_FAKEIP_APPLIED_DIGEST_FILE")" = source-1 ]
[ "$(cat "$FAKEIP_WHITELIST_DIGEST_FILE")" = whitelist-1 ]
FAIL_COMMIT=false
apply_fakeip_policy_transaction whitelist-2
[ "$(cat "$GROUPED_FAKEIP_APPLIED_DIGEST_FILE")" = source-2 ]
GROUPED_FAKEIP_PORT_RULES_ENABLED=false
apply_grouped_port_nft_rules() { : > "$1"; }
apply_fakeip_policy_transaction whitelist-2
[ "$(cat "$GROUPED_FAKEIP_APPLIED_DIGEST_FILE")" = empty ]
grep -q '^flush chain inet clash ASCLASH_GROUPED' "$TEST_DIR/committed"
! grep -q '^add set inet clash fp_' "$TEST_DIR/committed"
printf '%s\n' 'Fake-IP policy transaction tests passed.'
