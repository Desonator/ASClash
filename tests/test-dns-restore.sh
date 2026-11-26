#!/bin/sh
set -eu

SCRIPT_DIR=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)
INIT_SCRIPT="$SCRIPT_DIR/../luci-app-asclash/rootfs/etc/init.d/clash"
TEST_DIR=$(mktemp -d)
trap 'rm -rf "$TEST_DIR"' EXIT INT TERM

sed -n '/^restore_dns() {/,/^# Function to apply firewall rules/p' "$INIT_SCRIPT" | sed '$d' > "$TEST_DIR/restore.sh"

cat > "$TEST_DIR/test.sh" <<'EOF'
#!/bin/sh
set -eu
. "$1"
DNS_BACKUP_FILE="$2"
DNS_SERVERS="$3"
DNS_CACHESIZE=0
DNS_NORESOLV=1
UCI_COMMIT_FAIL="$4"
msg() { :; }
uci() {
  case "$1" in
    get)
      case "$2" in
        dhcp.@dnsmasq\[0\].server) printf '%s\n' "$DNS_SERVERS" ;;
        dhcp.@dnsmasq\[0\].cachesize) [ -n "$DNS_CACHESIZE" ] && printf '%s\n' "$DNS_CACHESIZE" ;;
        dhcp.@dnsmasq\[0\].noresolv) [ -n "$DNS_NORESOLV" ] && printf '%s\n' "$DNS_NORESOLV" ;;
      esac
      ;;
    del_list)
      value=${2#*=}
      DNS_SERVERS=$(printf '%s\n' "$DNS_SERVERS" | grep -F -x -v "$value" || true)
      ;;
    set)
      case "$2" in
        dhcp.@dnsmasq\[0\].cachesize=*) DNS_CACHESIZE=${2#*=} ;;
        dhcp.@dnsmasq\[0\].noresolv=*) DNS_NORESOLV=${2#*=} ;;
      esac
      ;;
    delete)
      case "$2" in
        dhcp.@dnsmasq\[0\].cachesize) DNS_CACHESIZE='' ;;
        dhcp.@dnsmasq\[0\].noresolv) DNS_NORESOLV='' ;;
      esac
      ;;
    commit) [ "$UCI_COMMIT_FAIL" != true ] ;;
    *) return 2 ;;
  esac
}

restore_dns
EOF

printf 'CACHESIZE=150\nNORESOLV=0\nDNS_SERVER=127.0.0.1#7874\nDNS_SERVER_OWNED=1\n' > "$TEST_DIR/backup"
if sh "$TEST_DIR/test.sh" "$TEST_DIR/restore.sh" "$TEST_DIR/backup" '127.0.0.1#7874' true 2>/dev/null; then
	printf '%s\n' 'Restore unexpectedly succeeded when UCI commit failed.' >&2
	exit 1
fi
[ -f "$TEST_DIR/backup" ] || { printf '%s\n' 'DNS backup was removed after failed commit.' >&2; exit 1; }

sh "$TEST_DIR/test.sh" "$TEST_DIR/restore.sh" "$TEST_DIR/backup" '127.0.0.1#7874' false
[ ! -f "$TEST_DIR/backup" ] || { printf '%s\n' 'DNS backup was not removed after verified restore.' >&2; exit 1; }

printf 'CACHESIZE=150\nNORESOLV=0\nDNS_SERVER=9.9.9.9\nDNS_SERVER_OWNED=0\n' > "$TEST_DIR/external-backup"
sh "$TEST_DIR/test.sh" "$TEST_DIR/restore.sh" "$TEST_DIR/external-backup" '9.9.9.9' false
[ ! -f "$TEST_DIR/external-backup" ] || { printf '%s\n' 'Externally owned DNS config was not restored.' >&2; exit 1; }

printf '%s\n' 'DNS restore ownership and backup-retention tests passed.'
