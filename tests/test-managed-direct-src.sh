#!/bin/sh
set -eu

SCRIPT_DIR=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)
RULES_SCRIPT="$SCRIPT_DIR/../luci-app-asclash/rootfs/opt/clash/bin/clash-rules"
TEST_DIR=$(mktemp -d)
trap 'rm -rf "$TEST_DIR"' EXIT INT TERM

extract_function() {
	awk -v name="$1" '
		$0 ~ ("^" name "\\(\\) \\{") { active=1 }
		active && $0 ~ /^[A-Za-z_][A-Za-z0-9_]*\(\) \{/ && $0 !~ ("^" name "\\(\\) \\{") { exit }
		active { print }
	' "$RULES_SCRIPT"
}

{
	printf '%s\n' '#!/bin/sh' 'warn() { :; }'
	extract_function is_valid_ip
	extract_function is_valid_ipv4_cidr
	extract_function extract_src_ip_cidrs_by_action
	extract_function extract_managed_direct_src_ip_cidrs
	extract_function extract_direct_src_ip_cidrs
	extract_function extract_reject_src_ip_cidrs
	extract_function apply_nft_src_ip_cidr_managed_direct_marking
	cat <<'EOF'
CONFIG_FILE="$1"
NFT_CAPTURE="$2"
nft() { printf '%s\n' "$*" >> "$NFT_CAPTURE"; }
msg() { :; }
MARK_TPROXY=0x0001
MARK_TUN_UDP=0x0003
RESERVED_NETWORKS=192.168.0.0/16
printf 'firewall-direct=%s\n' "$(extract_direct_src_ip_cidrs | tr '\n' ',')"
printf 'managed-direct=%s\n' "$(extract_managed_direct_src_ip_cidrs | tr '\n' ',')"
printf 'reject=%s\n' "$(extract_reject_src_ip_cidrs | tr '\n' ',')"
for MODE in explicit exclude; do
  for PROXY_MODE in tproxy tun mixed; do
    : > "$NFT_CAPTURE"
    apply_nft_src_ip_cidr_managed_direct_marking 203.0.113.5
    grep -F -q 'ip saddr 192.168.1.110/32 meta l4proto tcp counter meta mark set 0x0001' "$NFT_CAPTURE"
    if [ "$PROXY_MODE" = mixed ]; then
      grep -F -q 'ip saddr 192.168.1.110/32 meta l4proto udp counter meta mark set 0x0003' "$NFT_CAPTURE"
    else
      grep -F -q 'ip saddr 192.168.1.110/32 meta l4proto udp counter meta mark set 0x0001' "$NFT_CAPTURE"
    fi
  done
done
EOF
} > "$TEST_DIR/test.sh"

cat > "$TEST_DIR/config.yaml" <<'EOF'
rules:
  - SRC-IP-CIDR,192.168.1.10/32,DIRECT
  - SRC-IP-CIDR,192.168.1.110/32,DIRECT
  - SRC-IP-CIDR,192.168.1.110/32,DIRECT # ASCLASH:DEVICE-DIRECT
  - SRC-IP-CIDR,192.168.1.20/32,REJECT
  - MATCH,PROXY
EOF

actual=$(sh "$TEST_DIR/test.sh" "$TEST_DIR/config.yaml" "$TEST_DIR/nft-calls")
expected=$(printf '%s\n' 'firewall-direct=192.168.1.10/32,' 'managed-direct=192.168.1.110/32,' 'reject=192.168.1.20/32,')
if [ "$actual" != "$expected" ]; then
	printf 'Unexpected source-rule classification.\nExpected:\n%s\nActual:\n%s\n' "$expected" "$actual" >&2
	exit 1
fi

printf '%s\n' 'Managed DIRECT source classification tests passed.'
