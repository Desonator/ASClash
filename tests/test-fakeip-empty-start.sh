#!/bin/sh
set -eu
SCRIPT_DIR=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)
SCRIPT="$SCRIPT_DIR/../luci-app-asclash/rootfs/opt/clash/bin/clash-rules"
TEST_DIR=$(mktemp -d)
trap 'rm -rf "$TEST_DIR"' EXIT INT TERM
awk '/^apply_nft_marking_mangle\(\) \{/ { active=1 } active && /^[A-Za-z_][A-Za-z0-9_]*\(\) \{/ && $0 !~ /^apply_nft_marking_mangle\(\) \{/ { exit } active { print }' "$SCRIPT" > "$TEST_DIR/function"
awk '/^apply_nft_output_rules\(\) \{/ { active=1 } active && /^[A-Za-z_][A-Za-z0-9_]*\(\) \{/ && $0 !~ /^apply_nft_output_rules\(\) \{/ { exit } active { print }' "$SCRIPT" >> "$TEST_DIR/function"
. "$TEST_DIR/function"
nft() { printf '%s\n' "$*" >> "$TEST_DIR/calls"; }
msg() { :; }
is_ipcidr_whitelist_mode() { [ "$FAKE_IP_FILTER_MODE" = whitelist ] || [ "$FAKE_IP_FILTER_MODE" = rule ]; }
PROXY_MODE=mixed
MARK_TPROXY=0x0001
MARK_TUN_UDP=0x0003
FAKEIP_WHITELIST_IPS_FILE="$TEST_DIR/empty"
MARK_CLASH_ROUTING=0xff
RESERVED_NETWORKS=''
apply_nft_interface_exclusion_output() { :; }
apply_nft_clash_exclusions_output() { :; }
: > "$FAKEIP_WHITELIST_IPS_FILE"
for FAKE_IP_FILTER_MODE in whitelist rule; do
    : > "$TEST_DIR/calls"
    apply_nft_marking_mangle 198.18.0.0/15
    grep -q 'ip daddr @fakeip_whitelist meta l4proto tcp.*0x0001' "$TEST_DIR/calls"
    grep -q 'ip daddr @fakeip_whitelist meta l4proto udp.*0x0003' "$TEST_DIR/calls"
    : > "$TEST_DIR/calls"
    apply_nft_output_rules '' '' "$FAKE_IP_FILTER_MODE" 198.18.0.0/15
    grep -q 'output ip daddr @proxy_servers return' "$TEST_DIR/calls"
    grep -q 'output ip daddr @fakeip_whitelist meta mark 0 meta l4proto tcp.*0x0001' "$TEST_DIR/calls"
    grep -q 'output ip daddr @fakeip_whitelist meta l4proto udp.*0x0003' "$TEST_DIR/calls"
done
FAKE_IP_FILTER_MODE=blacklist
: > "$TEST_DIR/calls"
apply_nft_marking_mangle 198.18.0.0/15
! grep -q '@fakeip_whitelist' "$TEST_DIR/calls"
awk '/^apply_nft_rules_impl\(\) \{/ { active=1 } active && /    apply_nft_src_ip_cidr_policy$/ { policy=NR } active && /nft add rule inet clash CLASH_MARK jump ASCLASH_GROUPED/ { grouped=NR; exit } END { exit !(policy && grouped && policy < grouped) }' "$SCRIPT"
awk '/^apply_nft_rules_impl\(\) \{/ { active=1 } active && /    apply_nft_server_exclusions_mangle$/ { server=NR } active && /    apply_nft_src_ip_cidr_policy$/ { exit } END { exit !server }' "$SCRIPT"
printf '%s\n' 'Empty whitelist startup and source policy ordering tests passed.'
