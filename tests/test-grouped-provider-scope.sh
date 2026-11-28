#!/bin/sh
set -eu

SCRIPT_DIR=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)
RULES_SCRIPT="$SCRIPT_DIR/../luci-app-asclash/rootfs/opt/clash/bin/clash-rules"
TEST_DIR=$(mktemp -d)
trap 'rm -rf "$TEST_DIR"' EXIT INT TERM

awk '
    /^select_rule_provider_rows\(\) \{/ { active=1 }
    active && /^[A-Za-z_][A-Za-z0-9_]*\(\) \{/ && $0 !~ /^select_rule_provider_rows\(\) \{/ { exit }
    active { print }
' "$RULES_SCRIPT" > "$TEST_DIR/function.sh"

{
	printf '%s\n' '#!/bin/sh'
	cat "$TEST_DIR/function.sh"
	cat <<'EOF'
providers='alpha|ipcidr|http|/rules/alpha.mrs
unused|classical|http|/rules/unused.yaml
beta|classical|file|./beta.yaml'
selected='beta
alpha
not-configured'
select_rule_provider_rows "$providers" "$selected"
EOF
} > "$TEST_DIR/test.sh"

actual=$(sh "$TEST_DIR/test.sh")
expected='alpha|ipcidr|http|/rules/alpha.mrs
beta|classical|file|./beta.yaml'
[ "$actual" = "$expected" ] || {
	printf 'Unexpected provider selection.\nExpected:\n%s\nActual:\n%s\n' "$expected" "$actual" >&2
	exit 1
}

printf '%s\n' 'Grouped provider digest scope tests passed.'
