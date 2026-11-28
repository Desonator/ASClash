#!/bin/sh
set -eu
TEST_DIR=$(mktemp -d)
trap 'rm -rf "$TEST_DIR"' EXIT INT TERM
SCRIPT_DIR=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)
RULES_SCRIPT="$SCRIPT_DIR/../luci-app-asclash/rootfs/opt/clash/bin/clash-rules"
awk '
  /^extract_subscription_ips\(\) \{/ { active=1 }
  active && /^[A-Za-z_][A-Za-z0-9_]*\(\) \{/ && $0 !~ /^extract_subscription_ips\(\) \{/ { exit }
  active { print }
' "$RULES_SCRIPT" | sed "s@/tmp/clash@$TEST_DIR@g" > "$TEST_DIR/functions"
awk '
  /^cache_subscription_ips\(\) \{/ { active=1 }
  active && /^[A-Za-z_][A-Za-z0-9_]*\(\) \{/ && $0 !~ /^cache_subscription_ips\(\) \{/ { exit }
  active { print }
' "$RULES_SCRIPT" >> "$TEST_DIR/functions"
. "$TEST_DIR/functions"
ASCLASH_PROFILE_FILE="$TEST_DIR/profile"
profile_now_ms() { printf '100\n'; }
msg() { :; }
get_providers_base_dir() { printf '%s\n' "$TEST_DIR"; }
extract_proxy_providers() { printf 'one|first|10\ntwo|second|10\n'; }
extract_servers_from_subscription() { cat "$1"; }
is_valid_ip() { case "$1" in 192.0.2.*) return 0;; *) return 1;; esac; }
resolve_domain() { printf '%s\n' "$1" >> "$TEST_DIR/lookups"; [ "$1" != fail.example ] || return 1; printf '192.0.2.50\n'; }
printf 'same.example\n192.0.2.1\nsame.example\n' > "$TEST_DIR/first"
printf 'same.example\nother.example\n' > "$TEST_DIR/second"
extract_subscription_ips > "$TEST_DIR/result"
[ "$(wc -l < "$TEST_DIR/lookups")" -eq 2 ]
[ "$(grep -c '^same.example$' "$TEST_DIR/lookups")" -eq 1 ]
grep -q '^subscription|servers|5|3$' "$TEST_DIR/profile"
grep -q '^subscription|dns|2|0$' "$TEST_DIR/profile"
printf 'fail.example\n' >> "$TEST_DIR/second"
if extract_subscription_ips > "$TEST_DIR/result"; then exit 1; fi
grep -q '^subscription|dns|3|1$' "$TEST_DIR/profile"
rm "$TEST_DIR/second"
if extract_subscription_ips > "$TEST_DIR/result"; then exit 1; fi
grep -q '^subscription|provider_errors|1|0$' "$TEST_DIR/profile"
SUBSCRIPTION_CACHE_FILE="$TEST_DIR/cache"
SUBSCRIPTION_LOCK_FILE="$TEST_DIR/lock"
printf '192.0.2.77\n' > "$SUBSCRIPTION_CACHE_FILE"
cache_subscription_ips
[ "$(cat "$SUBSCRIPTION_CACHE_FILE")" = 192.0.2.77 ]
printf 'same.example\n' > "$TEST_DIR/second"
cache_subscription_ips
grep -q '^192.0.2.1$' "$SUBSCRIPTION_CACHE_FILE"
grep -q '^192.0.2.50$' "$SUBSCRIPTION_CACHE_FILE"
[ ! -e "$SUBSCRIPTION_LOCK_FILE" ]
printf '%s\n' 'Subscription DNS deduplication and incomplete-source checks passed.'
