#!/bin/sh
set -eu

SCRIPT_DIR=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)
RULES_SCRIPT="$SCRIPT_DIR/../luci-app-asclash/rootfs/opt/clash/bin/clash-rules"
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
	printf '%s\n' '#!/bin/sh' 'warn() { printf "%s\n" "$*" >&2; }'
	extract_function is_valid_ip
	extract_function is_valid_ipv4_cidr
	extract_function extract_fake_ip_config
	printf '%s\n' 'CONFIG_FILE="$1"' 'extract_fake_ip_config'
} > "$TEST_DIR/check.sh"
chmod +x "$TEST_DIR/check.sh"

for mode in fake-ip redir-host normal; do
	for filter_mode in blacklist whitelist rule; do
		cat > "$TEST_DIR/config.yaml" <<EOF
dns:
  enable: true
  enhanced-mode: "$mode"
  fake-ip-range: "198.18.0.0/15"
  fake-ip-filter-mode: "$filter_mode"
EOF
		actual=$("$TEST_DIR/check.sh" "$TEST_DIR/config.yaml")
		case "$mode" in
			fake-ip)
				[ "$actual" = "198.18.0.0/15|$filter_mode" ] || {
					printf 'Unexpected fake-ip parse result for %s/%s: %s\n' "$mode" "$filter_mode" "$actual" >&2
					exit 1
				}
				;;
			redir-host|normal)
				[ -z "$actual" ] || {
					printf 'Expected no fake-ip policy for %s/%s, got: %s\n' "$mode" "$filter_mode" "$actual" >&2
					exit 1
				}
				;;
		esac
	done
done

cat > "$TEST_DIR/config.yaml" <<'EOF'
dns:
  enable: true
  enhanced-mode: fake-ip
  fake-ip-filter-mode: whitelist
  nested:
    enable: false
    enhanced-mode: normal
    fake-ip-filter-mode: blacklist
EOF
[ "$("$TEST_DIR/check.sh" "$TEST_DIR/config.yaml")" = '198.18.0.0/15|whitelist' ] || {
	echo 'Nested DNS options changed the top-level Fake-IP policy' >&2
	exit 1
}

cat > "$TEST_DIR/config.yaml" <<'EOF'
dns:
  enable: false
  enhanced-mode: fake-ip
  fake-ip-range: 198.18.0.0/15
EOF
[ -z "$("$TEST_DIR/check.sh" "$TEST_DIR/config.yaml")" ] || {
	echo 'Disabled Mihomo DNS unexpectedly enabled Fake-IP firewall policy' >&2
	exit 1
}

{
	printf '%s\n' '#!/bin/sh'
	extract_function get_config_tproxy_port
	printf '%s\n' 'CONFIG_FILE="$1"' 'get_config_tproxy_port'
} > "$TEST_DIR/tproxy-port.sh"
chmod +x "$TEST_DIR/tproxy-port.sh"
printf '%s\n' 'tproxy-port: "9000" # custom listener' > "$TEST_DIR/config.yaml"
[ "$(sh "$TEST_DIR/tproxy-port.sh" "$TEST_DIR/config.yaml")" = '9000' ] || {
	echo 'Custom TPROXY port was not parsed' >&2
	exit 1
}
[ "$(sh "$TEST_DIR/tproxy-port.sh" "$TEST_DIR/missing.yaml")" = '7894' ] || {
	echo 'Default TPROXY port changed unexpectedly' >&2
	exit 1
}

grep -Fq 'tproxy ip to 127.0.0.1:"$TPROXY_PORT"' "$RULES_SCRIPT"
! grep -Fq 'tproxy ip to 127.0.0.1:7894' "$RULES_SCRIPT"

printf '%s\n' 'Fake-IP/DNS modes and configurable TPROXY port tests passed.'
