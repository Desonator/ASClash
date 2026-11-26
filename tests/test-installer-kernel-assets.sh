#!/bin/sh
set -eu

SCRIPT_DIR=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)
INSTALLER="$SCRIPT_DIR/../install-asclash.sh"
TEST_DIR=$(mktemp -d)
trap 'rm -rf "$TEST_DIR"' EXIT INT TERM

extract_function() {
	awk -v name="$1" '
		$0 ~ ("^" name "\\(\\) \\{") { active=1 }
		active && $0 ~ /^[A-Za-z_][A-Za-z0-9_]*\(\) \{/ && $0 !~ ("^" name "\\(\\) \\{") { exit }
		active { print }
	' "$INSTALLER"
}

{
	printf '%s\n' '#!/bin/sh'
	extract_function choose_mihomo_source
	extract_function get_mihomo_asset_list
	extract_function find_mihomo_asset
	cat <<'EOF'
info() { :; }
OFFICIAL_MIHOMO_REPO=MetaCubeX/mihomo
PRIZRAK_MIHOMO_REPO=legiz-ru/Prizrak-Core
ASCLASH_KERNEL_SOURCE=prizrak
choose_mihomo_source
[ "$MIHOMO_REPO" = "$PRIZRAK_MIHOMO_REPO" ]
[ "$MIHOMO_API" = "https://api.github.com/repos/$PRIZRAK_MIHOMO_REPO/releases/latest" ]
MIHOMO_REPO=legiz-ru/Prizrak-Core
MIHOMO_VER=v1.19.34-r4
MIHOMO_ARCH=arm64
MIHOMO_ASSET_LIST=$(get_mihomo_asset_list < "$1")
find_mihomo_asset
printf '%s|%s\n' "$MIHOMO_ASSET_FILENAME" "$MIHOMO_URL"
EOF
} > "$TEST_DIR/test.sh"

cat > "$TEST_DIR/prizrak-release.json" <<'EOF'
{
  "assets": [
    {
      "name": "prizrak-core-linux-arm64-v1.19.34-r4.gz",
      "browser_download_url": "https://example.invalid/prizrak-arm64.gz"
    },
    {
      "name": "prizrak-kroha-linux-arm64-v1.19.34-r4.gz",
      "browser_download_url": "https://example.invalid/kroha-arm64.gz"
    }
  ]
}
EOF

actual=$(sh "$TEST_DIR/test.sh" "$TEST_DIR/prizrak-release.json")
expected='prizrak-core-linux-arm64-v1.19.34-r4.gz|https://example.invalid/prizrak-arm64.gz'
if [ "$actual" != "$expected" ]; then
	printf 'Unexpected Prizrak asset selection.\nExpected: %s\nActual:   %s\n' "$expected" "$actual" >&2
	exit 1
fi

printf '%s\n' 'Installer kernel asset selection test passed.'
