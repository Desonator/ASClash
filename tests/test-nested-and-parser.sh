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
	printf '%s\n' '#!/bin/sh' 'mkdir -p /tmp/clash'
	extract_function is_valid_ip
	extract_function is_valid_ipv4_cidr
	extract_function intersect_ipv4_cidr_files
	extract_function extract_classical_and_ipcidr_entries
	printf '%s\n' 'extract_classical_and_ipcidr_entries "$1"'
} > "$TEST_DIR/parser.sh"

cat > "$TEST_DIR/rules.yaml" <<'EOF'
- AND,((IP-CIDR,10.1.2.0/24),(IP-CIDR,10.1.2.128/25),(NETWORK,tcp),(DST-PORT,443))
- AND,((IP-CIDR,10.1.2.0/24),(IP-CIDR,10.1.3.0/24),(NETWORK,udp),(DST-PORT,53))
- AND,((IP-CIDR,10.1.2.0/24),(DOMAIN,example.org),(NETWORK,tcp),(DST-PORT,443))
EOF

actual=$(sh "$TEST_DIR/parser.sh" "$TEST_DIR/rules.yaml")
expected='10.1.2.128/25|tcp|443'

if [ "$actual" != "$expected" ]; then
	printf 'Unexpected parser result.\nExpected: %s\nActual:   %s\n' "$expected" "$actual" >&2
	exit 1
fi

printf '%s\n' 'Nested AND CIDR intersection tests passed.'
