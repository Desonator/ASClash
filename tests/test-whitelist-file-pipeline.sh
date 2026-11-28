#!/bin/sh
set -eu
SCRIPT_DIR=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)
RULES_SCRIPT="$SCRIPT_DIR/../luci-app-asclash/rootfs/opt/clash/bin/clash-rules"
TEST_DIR=$(mktemp -d)
trap 'rm -rf "$TEST_DIR"' EXIT INT TERM
FAKEIP_WHITELIST_IPS_FILE="$TEST_DIR/whitelist"
msg() { :; }
nft() {
    if [ "$*" = '-f -' ]; then cat > "$TEST_DIR/batch"; fi
}
# Exercise the actual production batching block with a large file, preserving
# batch boundaries and every input CIDR for both supported filter modes.
{
    printf 'populate() {\n'
    awk '
        /# Create nft set for fakeip whitelist IP-CIDR entries/ { active=1 }
        active && /^    case "\$MODE"/ { exit }
        active { print }
    ' "$RULES_SCRIPT"
    printf '}\n'
    printf 'prepare() {\n'
    awk '
        /local whitelist_tmp=/ { active=1 }
        active { print }
        active && /^    fi$/ { exit }
    ' "$RULES_SCRIPT"
    printf '}\n'
} > "$TEST_DIR/functions"
. "$TEST_DIR/functions"
for fake_ip_filter_mode in whitelist rule; do
    for count in 0 1 500 501 1201; do
        awk -v n="$count" 'BEGIN { for (i=0; i<n; i++) printf "10.%d.%d.0/24\n", int(i/256), i%256 }' > "$FAKEIP_WHITELIST_IPS_FILE"
        : > "$TEST_DIR/batch"
        populate
        [ "$(wc -l < "$TEST_DIR/batch")" -eq $(((count + 499) / 500)) ]
        sed 's/^add element inet clash fakeip_whitelist { //; s/ }$//' "$TEST_DIR/batch" | tr ',' '\n' > "$TEST_DIR/actual"
        cmp "$FAKEIP_WHITELIST_IPS_FILE" "$TEST_DIR/actual"
    done
done
# Failed reads keep the previous snapshot and clean the staging file.
read_fakeip_whitelist_entries() { echo partial; return 1; }
cp "$FAKEIP_WHITELIST_IPS_FILE" "$TEST_DIR/previous"
if prepare; then exit 1; fi
cmp "$FAKEIP_WHITELIST_IPS_FILE" "$TEST_DIR/previous"
[ ! -e "${FAKEIP_WHITELIST_IPS_FILE}.tmp.$$" ]
read_fakeip_whitelist_entries() { printf '%s\n' '192.0.2.0/24'; }
prepare
[ "$(cat "$FAKEIP_WHITELIST_IPS_FILE")" = 192.0.2.0/24 ]
printf '%s\n' 'Whitelist file pipeline tests passed.'
