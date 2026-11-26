#!/bin/sh
set -eu

SCRIPT_DIR=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)
API_HELPER="$SCRIPT_DIR/../luci-app-asclash/rootfs/opt/clash/bin/asclash-api"
TEST_DIR=$(mktemp -d)
trap 'rm -rf "$TEST_DIR"' EXIT INT TERM

awk '
  /^validate_encoded_segment\(\) \{/ { active=1 }
  active && /^[A-Za-z_][A-Za-z0-9_]*\(\) \{/ && $0 !~ /^validate_encoded_segment\(\) \{/ { exit }
  active { print }
' "$API_HELPER" > "$TEST_DIR/validate.sh"

cat > "$TEST_DIR/test.sh" <<'EOF'
#!/bin/sh
set -eu
. "$1"
validate_encoded_segment 'group%20with%20space'
validate_encoded_segment '%E2%9C%93'
for invalid in '' '.' '..' '../version' 'group/name' 'name?force=true' 'bad%2' 'bad%GG' '%2fadmin'; do
  if validate_encoded_segment "$invalid"; then
    printf 'Unsafe API path segment was accepted: %s\n' "$invalid" >&2
    exit 1
  fi
done
EOF

sh "$TEST_DIR/test.sh" "$TEST_DIR/validate.sh"
printf '%s\n' 'API helper path validation tests passed.'
