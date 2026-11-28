#!/bin/sh
set -eu
SCRIPT_DIR=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)
TEST_DIR=$(mktemp -d)
trap 'rm -rf "$TEST_DIR"' EXIT INT TERM
awk '/^update_rules\(\) \{/ { active=1 } active && /^[A-Za-z_][A-Za-z0-9_]*\(\) \{/ && $0 !~ /^update_rules\(\) \{/ { exit } active { print }' "$SCRIPT_DIR/../luci-app-asclash/rootfs/opt/clash/bin/clash-rules" | sed "s@/tmp/clash@$TEST_DIR@g" > "$TEST_DIR/function"
. "$TEST_DIR/function"
SUBSCRIPTION_CACHE_FILE="$TEST_DIR/cache"
printf '%s\n' 192.0.2.1 > "$SUBSCRIPTION_CACHE_FILE"
msg() { :; }
warn() { :; }
hash() { return 0; }
update_fakeip_whitelist_sets() { return 0; }
cache_subscription_ips() { printf '%s\n' 198.51.100.1 > "$SUBSCRIPTION_CACHE_FILE"; }
extract_server_ips() { cat "$SUBSCRIPTION_CACHE_FILE"; }
nft() {
    case "$1" in
        list|-c) return 0 ;;
        -f) printf '%s\n' apply >> "$TEST_DIR/calls"; [ "${FAIL_APPLY:-false}" != true ] ;;
        *) return 1 ;;
    esac
}
FAIL_APPLY=true
if update_rules; then echo 'Expected nft failure' >&2; exit 1; fi
[ -f "${SUBSCRIPTION_CACHE_FILE}.nft-pending" ]
FAIL_APPLY=false
update_rules
[ ! -e "${SUBSCRIPTION_CACHE_FILE}.nft-pending" ]
[ "$(wc -l < "$TEST_DIR/calls" | tr -d ' ')" -eq 2 ]
update_rules
[ "$(wc -l < "$TEST_DIR/calls" | tr -d ' ')" -eq 2 ]
printf '%s\n' 'Subscription firewall retry tests passed.'
