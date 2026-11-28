#!/bin/sh
set -eu
SCRIPT_DIR=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)
RULES_SCRIPT="$SCRIPT_DIR/../luci-app-asclash/rootfs/opt/clash/bin/clash-rules"
TEST_DIR=$(mktemp -d)
trap 'rm -rf "$TEST_DIR"' EXIT INT TERM
for name in profile_now_ms select_rule_provider_rows generate_grouped_port_sources_impl filter_valid_provider_entries; do
    awk -v name="$name" '
        $0 ~ ("^" name "\\(\\) \\{") { active=1 }
        active && /^[A-Za-z_][A-Za-z0-9_]*\(\) \{/ && $0 !~ ("^" name "\\(\\) \\{") { exit }
        active { print }
    ' "$RULES_SCRIPT"
done | sed "s@/tmp/clash@$TEST_DIR/runtime@g" > "$TEST_DIR/functions"
. "$TEST_DIR/functions"
mkdir -p "$TEST_DIR/runtime"
CONFIG_FILE="$TEST_DIR/config"
: > "$CONFIG_FILE"
FAKEIP_WHITELIST_FILE="$TEST_DIR/whitelist"
: > "$FAKEIP_WHITELIST_FILE"
GROUPED_FAKEIP_PORT_RULES_ENABLED=true
GROUPED_FAKEIP_MAX_GROUPS=32
GROUPED_FAKEIP_MAX_CIDRS=150000
GROUPED_FAKEIP_DIGEST_FILE="$TEST_DIR/runtime/digest"
GROUPED_FAKEIP_STATS_FILE="$TEST_DIR/runtime/stats"
GROUPED_FAKEIP_SUMMARY_FILE="$TEST_DIR/runtime/summary"
GROUPED_FAKEIP_MISSING_SOURCES_FILE="$TEST_DIR/runtime/missing"
ASCLASH_PROFILE_FILE=''
profile_run() { shift; "$@"; }
extract_grouped_port_rules() { printf '%s\n' 'IP-CIDR:10.0.0.0/24|tcp|443|VPN'; }
extract_rule_providers() { :; }
extract_proxy_rule_set_names() { :; }
get_providers_base_dir() { printf '%s\n' "$TEST_DIR"; }
msg() { :; }
warn() { printf '%s\n' "$*" >&2; }
generate_grouped_port_sources_impl
original=$(cat "$GROUPED_FAKEIP_DIGEST_FILE")
[ -s "$TEST_DIR/runtime/fakeip_port_groups" ]
printf 'cached batch\n' > "$TEST_DIR/runtime/fakeip_port_groups.nft"
# Only the ordinary AUTO list changes; config/grouped rule is identical.
printf '# AUTO-BEGIN\n10.0.0.0/24\n# AUTO-END\n' > "$FAKEIP_WHITELIST_FILE"
generate_grouped_port_sources_impl
[ "$(cat "$GROUPED_FAKEIP_DIGEST_FILE")" != "$original" ]
[ ! -s "$TEST_DIR/runtime/fakeip_port_groups" ]
# Removing unconditional coverage must restore the conditional group.
: > "$FAKEIP_WHITELIST_FILE"
generate_grouped_port_sources_impl
[ -s "$TEST_DIR/runtime/fakeip_port_groups" ]
printf '%s\n' 'Grouped cache tracks unconditional AUTO coverage correctly.'
