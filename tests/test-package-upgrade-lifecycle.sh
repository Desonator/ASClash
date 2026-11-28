#!/bin/sh
set -eu

SCRIPT_DIR=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)
MAKEFILE="$SCRIPT_DIR/../luci-app-asclash/Makefile"
TEST_DIR=$(mktemp -d)
trap 'rm -rf "$TEST_DIR"' EXIT INT TERM

awk '
  index($0, "define Package/$(PKG_NAME)/postrm") == 1 { active=1; next }
  active && /^endef$/ { exit }
  active { print }
' "$MAKEFILE" > "$TEST_DIR/postrm"

grep -Fq 'rm -f /opt/clash/.dns_backup' "$TEST_DIR/postrm"
grep -Fq 'rm -rf /tmp/clash' "$TEST_DIR/postrm"

awk '
  index($0, "case \"$$1\" in") == 1 { active=1 }
  active { print }
  active && /^[[:space:]]*esac[[:space:]]*$/ { exit }
' "$TEST_DIR/postrm" | sed 's/\$\$/\$/g' | tr -d '\r' > "$TEST_DIR/upgrade-guard"
[ -s "$TEST_DIR/upgrade-guard" ] || {
	echo 'postrm upgrade guard is missing' >&2
	exit 1
}

{
	printf '%s\n' '#!/bin/sh'
	cat "$TEST_DIR/upgrade-guard"
	printf '%s\n' 'printf cleanup-ran'
} > "$TEST_DIR/run-guard.sh"

upgrade_output=$(sh "$TEST_DIR/run-guard.sh" upgrade 4.8.5.10)
[ -z "$upgrade_output" ] || {
	printf 'Cleanup guard did not exit on upgrade: %s\n' "$upgrade_output" >&2
	exit 1
}
remove_output=$(sh "$TEST_DIR/run-guard.sh" remove)
[ "$remove_output" = cleanup-ran ] || {
	printf 'Cleanup guard unexpectedly blocked removal: %s\n' "$remove_output" >&2
	exit 1
}

printf '%s\n' 'Package postrm preserves DNS/runtime state on upgrade and permits uninstall cleanup.'
