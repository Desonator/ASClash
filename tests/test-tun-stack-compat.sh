#!/bin/sh
set -eu

SCRIPT_DIR=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)
RULES_SCRIPT="$SCRIPT_DIR/../luci-app-asclash/rootfs/opt/clash/bin/clash-rules"
SETTINGS_JS="$SCRIPT_DIR/../luci-app-asclash/rootfs/www/luci-static/resources/view/asclash/settings.js"
TEST_DIR=$(mktemp -d)
trap 'rm -rf "$TEST_DIR"' EXIT INT TERM

awk '
    /^preflight_check_tun_stack\(\) \{/ { active=1 }
    active && /^[A-Za-z_][A-Za-z0-9_]*\(\) \{/ && $0 !~ /^preflight_check_tun_stack\(\) \{/ { exit }
    active { print }
' "$RULES_SCRIPT" > "$TEST_DIR/function.sh"
awk '
    /^get_config_routing_mark\(\) \{/ { active=1 }
    active && /^[A-Za-z_][A-Za-z0-9_]*\(\) \{/ && $0 !~ /^get_config_routing_mark\(\) \{/ { exit }
    active { print }
' "$RULES_SCRIPT" >> "$TEST_DIR/function.sh"
awk '
    /^get_config_tun_auto_flags\(\) \{/ { active=1 }
    active && /^[A-Za-z_][A-Za-z0-9_]*\(\) \{/ && $0 !~ /^get_config_tun_auto_flags\(\) \{/ { exit }
    active { print }
' "$RULES_SCRIPT" >> "$TEST_DIR/function.sh"
cat > "$TEST_DIR/config.yaml" <<'EOF'
routing-mark: 2
tun:
  enable: true
  stack: mips
  device: clash-tun
  auto-route: false
  auto-redirect: false
  auto-detect-interface: false
EOF

{
	printf '%s\n' '#!/bin/sh' 'msg() { printf "INFO:%s\n" "$*"; }' 'warn() { printf "WARN:%s\n" "$*"; }'
	cat "$TEST_DIR/function.sh"
	printf '%s\n' "CONFIG_FILE='$TEST_DIR/config.yaml'" 'PROXY_MODE=tun' 'TUN_STACK=system' 'preflight_check_tun_stack'
} > "$TEST_DIR/test.sh"

output=$(sh "$TEST_DIR/test.sh")
case "$output" in
	*"INFO:TUN stack 'mips' selected"*) ;;
	*) printf 'mips stack was not accepted by preflight: %s\n' "$output" >&2; exit 1 ;;
esac
case "$output" in
	*WARN:*) printf 'mips stack unexpectedly warned: %s\n' "$output" >&2; exit 1 ;;
esac

grep -Fq "'value': 'mips'" "$SETTINGS_JS"
grep -Fq "'mixed', 'mips'].includes(currentTunStack)" "$SETTINGS_JS"

cat > "$TEST_DIR/config.yaml" <<'EOF'
routing-mark: 2
tun:
  enable: true
  stack: mips
  device: other-tun
  auto-route: "true"
  auto-redirect: true
  auto-detect-interface: false
EOF
output=$(sh "$TEST_DIR/test.sh")
case "$output" in
    *"tun.auto-route is enabled"*"tun.auto-redirect is enabled"*"ASClash expects 'clash-tun'"*) ;;
	*) printf 'TUN ownership conflicts were not reported: %s\n' "$output" >&2; exit 1 ;;
esac
case "$output" in
	*"tun.auto-detect-interface is enabled"*) printf 'False auto-detect-interface was reported enabled: %s\n' "$output" >&2; exit 1 ;;
esac

sed 's/enable: true/enable: false/' "$TEST_DIR/config.yaml" > "$TEST_DIR/disabled.yaml"
cp "$TEST_DIR/disabled.yaml" "$TEST_DIR/config.yaml"
output=$(sh "$TEST_DIR/test.sh")
case "$output" in
	*"tun.enable is not true"*) ;;
	*) printf 'Disabled TUN interface was not reported: %s\n' "$output" >&2; exit 1 ;;
esac

printf '%s\n' 'Mihomo mips TUN stack and routing ownership compatibility tests passed.'
