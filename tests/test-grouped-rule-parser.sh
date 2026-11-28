#!/bin/sh
set -eu

SCRIPT_DIR=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)
RULES_SCRIPT="$SCRIPT_DIR/../luci-app-asclash/rootfs/opt/clash/bin/clash-rules"
TEST_DIR=$(mktemp -d)
trap 'rm -rf "$TEST_DIR"' EXIT INT TERM

awk '
	/^extract_grouped_port_rules\(\) \{/ { active=1 }
	active && /^[A-Za-z_][A-Za-z0-9_]*\(\) \{/ && $0 !~ /^extract_grouped_port_rules\(\) \{/ { exit }
	active { print }
' "$RULES_SCRIPT" | sed "s@/tmp/clash@$TEST_DIR/runtime@g" > "$TEST_DIR/function.sh"

cat > "$TEST_DIR/rules.yaml" <<'EOF'
rules:
  - AND,((IP-CIDR,10.1.0.0/16),(NETWORK,tcp),(DST-PORT,443)),VPN
  - AND,((RULE-SET,proxy-ip),(DST-PORT,80-443)),VPN
  - AND,((IP-CIDR,10.2.0.0/16),(DOMAIN,example.org),(NETWORK,tcp),(DST-PORT,443)),VPN
  - AND,((IP-CIDR,10.3.0.0/16),(SRC-IP-CIDR,192.168.1.110/32),(NETWORK,udp),(DST-PORT,443)),VPN
  - AND,((SRC-IP-CIDR,192.168.1.110/32),(NETWORK,tcp),(DST-PORT,443)),VPN
  - AND,((IP-CIDR,10.4.0.0/16),(PROCESS-NAME,discord.exe),(DST-PORT,443)),VPN
EOF

{
	printf '%s\n' '#!/bin/sh' "CONFIG_FILE=\"$TEST_DIR/rules.yaml\"" "GROUPED_FAKEIP_DIAGNOSTICS_FILE=\"$TEST_DIR/diagnostics\""
	cat "$TEST_DIR/function.sh"
	printf '%s\n' 'extract_grouped_port_rules'
} > "$TEST_DIR/run.sh"

sh "$TEST_DIR/run.sh" > "$TEST_DIR/actual"
expected='IP-CIDR:10.1.0.0/16|tcp|443|VPN
RULE-SET:proxy-ip|*|80-443|VPN'
[ "$(cat "$TEST_DIR/actual")" = "$expected" ] || {
	printf 'Unexpected grouped rules.\nExpected:\n%s\nActual:\n%s\n' "$expected" "$(cat "$TEST_DIR/actual")" >&2
	exit 1
}

grep -q '^accepted|2$' "$TEST_DIR/diagnostics"
grep -q '^skipped|unsupported-condition-domain|1|' "$TEST_DIR/diagnostics"
grep -q '^skipped|unsupported-condition-src-ip-cidr|2|' "$TEST_DIR/diagnostics"
grep -q '^skipped|unsupported-condition-process-name|1|' "$TEST_DIR/diagnostics"
printf '%s\n' 'Grouped AND parser accepts only supported matcher sets.'
