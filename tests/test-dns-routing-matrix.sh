#!/bin/sh
set -eu
SCRIPT_DIR=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)
SCRIPT="$SCRIPT_DIR/../luci-app-asclash/rootfs/opt/clash/bin/clash-rules"
TEST_DIR=$(mktemp -d)
trap 'rm -rf "$TEST_DIR"' EXIT INT TERM
for name in is_valid_ip is_valid_ipv4_cidr extract_fake_ip_config apply_nft_marking_mangle apply_nft_tproxy_proxy; do
    awk -v name="$name" '$0 ~ ("^" name "\\(\\) \\{") { active=1 } active && /^[A-Za-z_][A-Za-z0-9_]*\(\) \{/ && $0 !~ ("^" name "\\(\\) \\{") { exit } active { print }' "$SCRIPT"
done > "$TEST_DIR/functions"
. "$TEST_DIR/functions"
CONFIG_FILE="$TEST_DIR/config.yaml"
MARK_TPROXY=0x0001
MARK_TUN_UDP=0x0003
TPROXY_PORT=7894
nft() { printf '%s\n' "$*" >> "$TEST_DIR/calls"; }
msg() { :; }
warn() { printf '%s\n' "$*" >&2; }
is_ipcidr_whitelist_mode() { [ "$FAKE_IP_FILTER_MODE" = whitelist ] || [ "$FAKE_IP_FILTER_MODE" = rule ]; }
for PROXY_MODE in tproxy tun mixed; do
    for dns_case in fake-blacklist fake-whitelist fake-rule redir-host disabled; do
        case "$dns_case" in
            fake-*) filter=${dns_case#fake-}; enabled=true; enhanced=fake-ip ;;
            redir-host) filter=blacklist; enabled=true; enhanced=redir-host ;;
            disabled) filter=blacklist; enabled=false; enhanced=fake-ip ;;
        esac
        printf 'dns:\n  enable: %s\n  enhanced-mode: %s\n  fake-ip-filter-mode: %s\n' "$enabled" "$enhanced" "$filter" > "$CONFIG_FILE"
        config=$(extract_fake_ip_config)
        FAKE_IP_FILTER_MODE=blacklist
        range=''
        if [ -n "$config" ]; then range=${config%|*}; FAKE_IP_FILTER_MODE=${config#*|}; fi
        : > "$TEST_DIR/calls"
        apply_nft_marking_mangle "$range"
        apply_nft_tproxy_proxy
        if [ -n "$range" ]; then
            grep -q 'CLASH_MARK ip daddr 198.18.0.0/15 meta l4proto tcp.*0x0001' "$TEST_DIR/calls"
        else
            grep -q 'CLASH_MARK meta l4proto tcp.*0x0001' "$TEST_DIR/calls"
            ! grep -q '@fakeip_whitelist' "$TEST_DIR/calls"
        fi
        case "$dns_case" in
            fake-whitelist|fake-rule) grep -q '@fakeip_whitelist' "$TEST_DIR/calls" ;;
            *) ! grep -q '@fakeip_whitelist' "$TEST_DIR/calls" ;;
        esac
        case "$PROXY_MODE" in
            mixed) grep -q 'meta l4proto udp.*0x0003' "$TEST_DIR/calls"; grep -q 'proxy.*tcp.*tproxy' "$TEST_DIR/calls"; ! grep -q 'proxy.*udp.*tproxy' "$TEST_DIR/calls" ;;
            tproxy) grep -q 'meta l4proto udp.*0x0001' "$TEST_DIR/calls"; grep -q 'proxy.*tcp.*tproxy' "$TEST_DIR/calls"; grep -q 'proxy.*udp.*tproxy' "$TEST_DIR/calls" ;;
            tun) grep -q 'meta l4proto udp.*0x0001' "$TEST_DIR/calls"; ! grep -q 'proxy.*tproxy' "$TEST_DIR/calls" ;;
        esac
    done
done
printf '%s\n' 'DNS and transport matrix: 15 combinations passed.'
