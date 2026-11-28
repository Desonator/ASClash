#!/bin/sh
set -eu

SCRIPT_DIR=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)
INSTALLER="$SCRIPT_DIR/../install-asclash.sh"
TEST_DIR=$(mktemp -d)
trap 'rm -rf "$TEST_DIR"' EXIT INT TERM

grep -Fq '( : </dev/tty ) 2>/dev/null' "$INSTALLER"
grep -Fq 'if [ -z "$answer" ] && installer_has_tty;' "$INSTALLER"

awk '
    /^choose_mihomo_source\(\) \{/ { active=1 }
    active && /^[A-Za-z_][A-Za-z0-9_]*\(\) \{/ && $0 !~ /^choose_mihomo_source\(\) \{/ { exit }
    active { print }
' "$INSTALLER" > "$TEST_DIR/choose.sh"

{
	printf '%s\n' '#!/bin/sh'
	cat "$TEST_DIR/choose.sh"
	cat <<'EOF'
installer_has_tty() { return 1; }
die() { printf 'DIE:%s\n' "$*"; exit 23; }
info() { :; }
OFFICIAL_MIHOMO_REPO=MetaCubeX/mihomo
PRIZRAK_MIHOMO_REPO=legiz-ru/Prizrak-Core
ASCLASH_SETTINGS_FILE="$1"
ASCLASH_KERNEL_SOURCE="$2"
choose_mihomo_source
printf '%s|%s\n' "$MIHOMO_REPO" "$MIHOMO_API"
EOF
} > "$TEST_DIR/test.sh"
chmod +x "$TEST_DIR/test.sh"

expected='MetaCubeX/mihomo|https://api.github.com/repos/MetaCubeX/mihomo/releases/latest'
actual=$("$TEST_DIR/test.sh" "$TEST_DIR/no-settings" official)
[ "$actual" = "$expected" ] || { printf 'Official selection mismatch: %s\n' "$actual" >&2; exit 1; }

expected='legiz-ru/Prizrak-Core|https://api.github.com/repos/legiz-ru/Prizrak-Core/releases/latest'
actual=$("$TEST_DIR/test.sh" "$TEST_DIR/no-settings" prizrak)
[ "$actual" = "$expected" ] || { printf 'Prizrak selection mismatch: %s\n' "$actual" >&2; exit 1; }

printf 'MIHOMO_RELEASE_REPO=legiz-ru/Prizrak-Core\r\n' > "$TEST_DIR/settings"
actual=$("$TEST_DIR/test.sh" "$TEST_DIR/settings" '')
[ "$actual" = "$expected" ] || { printf 'Saved Prizrak source was not reused: %s\n' "$actual" >&2; exit 1; }

if output=$("$TEST_DIR/test.sh" "$TEST_DIR/no-settings" '' 2>&1); then
	echo 'Non-interactive first install unexpectedly chose a kernel source' >&2
	exit 1
fi
case "$output" in
	*'ASCLASH_KERNEL_SOURCE=official'*'ASCLASH_KERNEL_SOURCE=prizrak'*) ;;
	*) printf 'Missing actionable non-interactive selection error: %s\n' "$output" >&2; exit 1 ;;
esac

if output=$("$TEST_DIR/test.sh" "$TEST_DIR/no-settings" mihomo 2>&1); then
	echo 'Invalid ASCLASH_KERNEL_SOURCE value was silently accepted' >&2
	exit 1
fi
case "$output" in
	*'Допустимо: official или prizrak'*) ;;
	*) printf 'Invalid source value was not explained: %s\n' "$output" >&2; exit 1 ;;
esac

printf '%s\n' 'Installer interactive/non-interactive kernel choice tests passed.'
