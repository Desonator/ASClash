#!/bin/sh
set -eu

SCRIPT_DIR=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)
RULES_SCRIPT="$SCRIPT_DIR/../luci-app-asclash/rootfs/opt/clash/bin/clash-rules"
HOTPLUG_SCRIPT="$SCRIPT_DIR/../luci-app-asclash/rootfs/etc/hotplug.d/net/99-clash-tun"
TEST_DIR=$(mktemp -d)
trap 'rm -rf "$TEST_DIR"' EXIT INT TERM

extract_function() {
	awk -v name="$1" '
		$0 ~ ("^" name "\\(\\) \\{") { active=1 }
		active && $0 ~ /^[A-Za-z_][A-Za-z0-9_]*\(\) \{/ && $0 !~ ("^" name "\\(\\) \\{") { exit }
		active { print }
	' "$RULES_SCRIPT"
}

{
	printf '%s\n' '#!/bin/sh' 'MARK_TPROXY=0x0001' 'MARK_TUN_UDP=0x0003' 'TABLE_TPROXY=100' 'TABLE_TUN_UDP=101' 'PREF_TPROXY=1000' 'PREF_TUN_UDP=1001' 'ASCLASH_OPERATION_LOCK_HELD=false' 'CLASH_RULES_UPDATE_LOCK=/tmp/asclash-route-test-lock' 'msg() { :; }' 'warn() { :; }'
	extract_function release_update_lock
	extract_function with_operation_lock
	extract_function tun_route_reset_rule
	extract_function setup_routing_rules
	extract_function teardown_routing_rules
	extract_function tun_route_ensure_policy_state
	extract_function tun_route_fallback_unlocked
	cat <<'EOF'
ip() {
  printf '%s\n' "$*" >> "$IP_CALLS"
  case "$1 $2" in
    'rule del'|'route del') return 1 ;;
    *) return 0 ;;
  esac
}
load_all_settings_once() { :; }
PROXY_MODE=mixed
setup_routing_rules
first_fallback=$(grep -n 'route replace unreachable default table 101' "$IP_CALLS" | head -n 1 | cut -d: -f1)
udp_rule=$(grep -n 'rule add pref 1001' "$IP_CALLS" | head -n 1 | cut -d: -f1)
[ -n "$first_fallback" ] && [ -n "$udp_rule" ] && [ "$first_fallback" -lt "$udp_rule" ] || {
  printf '%s\n' 'MIXED UDP fail-closed route was not installed before its policy rule.' >&2
  exit 1
}
tun_route_fallback_unlocked
[ "$(grep -c 'route replace unreachable default table 101' "$IP_CALLS")" -ge 2 ] || {
  printf '%s\n' 'MIXED tunnel removal did not restore an unreachable default route.' >&2
  exit 1
}
: > "$IP_CALLS"
PROXY_MODE=tun
tun_route_fallback_unlocked
grep -F -q 'route replace local default dev lo table 100' "$IP_CALLS" || {
  printf '%s\n' 'TUN removal did not restore its local fail-closed fallback.' >&2
  exit 1
}
: > "$IP_CALLS"
PROXY_MODE=tproxy
tun_route_fallback_unlocked
grep -F -q 'route replace local default dev lo table 100' "$IP_CALLS"
grep -F -q 'route replace unreachable default table 101' "$IP_CALLS" || {
  printf '%s\n' 'A tunnel removal during a saved-mode transition did not restore both reserved-table fallbacks.' >&2
  exit 1
}
EOF
} > "$TEST_DIR/test.sh"

IP_CALLS="$TEST_DIR/ip-calls" sh "$TEST_DIR/test.sh"
grep -F -q 'tun_route_fallback' "$HOTPLUG_SCRIPT" || {
	printf '%s\n' 'TUN interface remove event is not wired to the route fallback.' >&2
	exit 1
}
printf '%s\n' 'TUN route fallback tests passed.'
