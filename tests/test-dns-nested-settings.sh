#!/bin/sh
set -eu
SCRIPT_DIR=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)
TEST_DIR=$(mktemp -d)
trap 'rm -rf "$TEST_DIR"' EXIT INT TERM
awk '/^setup_dns\(\) \{/ { active=1 } active && /^restore_dns\(\) \{/ { exit } active { print }' "$SCRIPT_DIR/../luci-app-asclash/rootfs/etc/init.d/clash" > "$TEST_DIR/function"
. "$TEST_DIR/function"
CLASH_DIR="$TEST_DIR"
DNS_BACKUP_FILE="$TEST_DIR/backup"
msg() { :; }
uci() { printf '%s\n' "$*" >> "$TEST_DIR/uci"; return 0; }
write_dns_backup() { printf 'DNS_SERVER=%s\n' "$3" > "$DNS_BACKUP_FILE"; }
cat > "$CLASH_DIR/config.yaml" <<'EOF'
dns:
  enable: true
  listen: 127.0.0.1:7874
  nested:
    enable: false
    listen: 127.0.0.1:9999
EOF
if setup_dns; then :; else exit 1; fi
grep -Fq 'add_list dhcp.@dnsmasq[0].server=127.0.0.1#7874' "$TEST_DIR/uci"
! grep -Fq '9999' "$TEST_DIR/uci"
printf '%s\n' 'Nested DNS settings do not override the listener.'
