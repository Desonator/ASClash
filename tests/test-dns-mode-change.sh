#!/bin/sh
set -eu
SCRIPT_DIR=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)
TEST_DIR=$(mktemp -d)
trap 'rm -rf "$TEST_DIR"' EXIT INT TERM
awk '/^update_fakeip_whitelist_sets\(\) \{/ { active=1 } active && /^[A-Za-z_][A-Za-z0-9_]*\(\) \{/ && $0 !~ /^update_fakeip_whitelist_sets\(\) \{/ { exit } active { print }' "$SCRIPT_DIR/../luci-app-asclash/rootfs/opt/clash/bin/clash-rules" > "$TEST_DIR/function"
. "$TEST_DIR/function"
ASCLASH_PROGRESS_ID=test
FAKEIP_WHITELIST_DIGEST_FILE="$TEST_DIR/digest"
printf '%s\n' previous > "$FAKEIP_WHITELIST_DIGEST_FILE"
hash() { return 0; }
msg() { :; }
warn() { :; }
set_list_progress() { :; }
load_all_settings_once() { :; }
profile_run() { shift; "$@"; }
extract_fake_ip_config() { printf '%s\n' "$CONFIG_RESULT"; }
nft() { echo 'Unexpected nft operation during DNS-mode change' >&2; return 1; }
for CONFIG_RESULT in '' '198.18.0.0/15|blacklist'; do
    update_fakeip_whitelist_sets
    [ "$(cat "$FAKEIP_WHITELIST_DIGEST_FILE")" = previous ]
    [ "$ASCLASH_FAKEIP_STATE" = disabled ]
done
printf '%s\n' 'DNS mode changes preserve the running firewall policy until restart.'
