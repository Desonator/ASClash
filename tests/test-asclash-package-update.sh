#!/bin/sh
set -eu

SCRIPT_DIR=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)
HELPER="$SCRIPT_DIR/../luci-app-asclash/rootfs/opt/clash/bin/asclash-update"
TEST_DIR=$(mktemp -d)
trap 'rm -rf "$TEST_DIR"' EXIT INT TERM

if grep -Fq '/etc/init.d/clash' "$HELPER"; then
	echo 'ASClash package updater must not restart the Mihomo service' >&2
	exit 1
fi

extract_function() {
	awk -v name="$1" '
		$0 ~ ("^" name "\\(.*\\) \\{") { active=1 }
		active && $0 ~ /^[A-Za-z_][A-Za-z0-9_]*\(\) \{/ && $0 !~ ("^" name "\\(.*\\) \\{") { exit }
		active { print }
	' "$HELPER"
}

{
	printf '%s\n' '#!/bin/sh'
	extract_function release_version
	extract_function release_package_url
	cat <<'EOF'
json=$(cat "$1")
version=$(release_version "$json")
format=${2:-ipk}
url=$(release_package_url "$json" "$format")
printf '%s|%s\n' "$version" "$url"
EOF
} > "$TEST_DIR/test.sh"
chmod +x "$TEST_DIR/test.sh"

cat > "$TEST_DIR/release.json" <<'EOF'
{
  "tag_name": "v4.8.2.46",
  "assets": [
    { "name": "mihomo-linux-arm64-v1.19.34.gz", "browser_download_url": "https://github.com/Desonator/ASClash/releases/download/v4.8.2.46/mihomo.gz" },
    { "name": "luci-app-asclash_4.8.2.46_all.ipk", "browser_download_url": "https://github.com/Desonator/ASClash/releases/download/v4.8.2.46/luci-app-asclash_4.8.2.46_all.ipk" },
    { "name": "luci-app-asclash-4.8.2.46-r1.apk", "browser_download_url": "https://github.com/Desonator/ASClash/releases/download/v4.8.2.46/luci-app-asclash-4.8.2.46-r1.apk" }
  ]
}
EOF

actual=$(sh "$TEST_DIR/test.sh" "$TEST_DIR/release.json" ipk)
expected='4.8.2.46|https://github.com/Desonator/ASClash/releases/download/v4.8.2.46/luci-app-asclash_4.8.2.46_all.ipk'
[ "$actual" = "$expected" ] || { printf 'Wrong IPK release selected: %s\n' "$actual" >&2; exit 1; }

actual=$(sh "$TEST_DIR/test.sh" "$TEST_DIR/release.json" apk)
expected='4.8.2.46|https://github.com/Desonator/ASClash/releases/download/v4.8.2.46/luci-app-asclash-4.8.2.46-r1.apk'
[ "$actual" = "$expected" ] || { printf 'Wrong APK release selected: %s\n' "$actual" >&2; exit 1; }

printf '%s\n' 'ASClash package update release selection tests passed.'
