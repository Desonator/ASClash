#!/bin/sh
set -eu

SCRIPT_DIR=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)
INIT_SCRIPT="$SCRIPT_DIR/../luci-app-asclash/rootfs/etc/init.d/clash"
TEST_DIR=$(mktemp -d)
trap 'rm -rf "$TEST_DIR"' EXIT INT TERM

awk '
  /^write_dns_backup\(\) \{/ { active=1 }
  active && /^# Function to configure DNS/ { exit }
  active { print }
' "$INIT_SCRIPT" > "$TEST_DIR/write-backup.sh"

cat > "$TEST_DIR/test.sh" <<'EOF'
#!/bin/sh
set -eu
. "$1"
DNS_BACKUP_FILE="$2"
write_dns_backup '150' '0' '127.0.0.1#7874' '1'
grep -F -x -q 'CACHESIZE=150' "$DNS_BACKUP_FILE"
grep -F -x -q 'NORESOLV=0' "$DNS_BACKUP_FILE"
grep -F -x -q 'DNS_SERVER=127.0.0.1#7874' "$DNS_BACKUP_FILE"
grep -F -x -q 'DNS_SERVER_OWNED=1' "$DNS_BACKUP_FILE"
EOF

sh "$TEST_DIR/test.sh" "$TEST_DIR/write-backup.sh" "$TEST_DIR/backup"
[ "$(stat -c '%a' "$TEST_DIR/backup")" = 600 ] || {
	printf '%s\n' 'DNS backup was not created with private permissions.' >&2
	exit 1
}

cp "$TEST_DIR/backup" "$TEST_DIR/expected"
cat > "$TEST_DIR/test-failure.sh" <<'EOF'
#!/bin/sh
set -eu
. "$1"
DNS_BACKUP_FILE="$2"
mv() { return 1; }
if write_dns_backup '0' '1' '127.0.0.1#7874' '1'; then
  printf '%s\n' 'DNS backup unexpectedly reported success when atomic rename failed.' >&2
  exit 1
fi
EOF
sh "$TEST_DIR/test-failure.sh" "$TEST_DIR/write-backup.sh" "$TEST_DIR/backup"
cmp -s "$TEST_DIR/backup" "$TEST_DIR/expected" || {
	printf '%s\n' 'Failed DNS backup update corrupted the previous backup.' >&2
	exit 1
}

printf '%s\n' 'Atomic DNS backup tests passed.'
