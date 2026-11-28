#!/bin/sh
set -eu
SCRIPT_DIR=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)
RULES_SCRIPT="$SCRIPT_DIR/../luci-app-asclash/rootfs/opt/clash/bin/clash-rules"
TEST_DIR=$(mktemp -d)
trap 'rm -rf "$TEST_DIR"' EXIT INT TERM
export TEST_DIR
extract_function() {
    awk -v name="$1" '
        $0 ~ ("^" name "\\(\\) \\{") { active=1 }
        active && $0 ~ /^[A-Za-z_][A-Za-z0-9_]*\(\) \{/ && $0 !~ ("^" name "\\(\\) \\{") { exit }
        active { print }
    ' "$RULES_SCRIPT"
}
{
    for name in profile_now_ms profile_run parsed_provider_cache extract_ipv4_cidr_from_rule_provider_file extract_classical_and_ipcidr_entries is_valid_ip is_valid_ipv4_cidr intersect_ipv4_cidr_files; do
        extract_function "$name"
    done
} | sed -e 's@/tmp/clash@'"$TEST_DIR"'/runtime@g' \
    -e 's@/opt/clash/lst/mrs_cache@'"$TEST_DIR"'/persistent@g' \
    -e 's@/opt/clash/bin/clash@'"$TEST_DIR"'/converter@g' > "$TEST_DIR/functions"
. "$TEST_DIR/functions"
ASCLASH_PROFILE_FILE=""
mkdir -p "$TEST_DIR/a" "$TEST_DIR/b" "$TEST_DIR/runtime"
cat > "$TEST_DIR/converter" <<'EOF'
#!/bin/sh
echo call >> "$TEST_DIR/calls"
case "$(cat "$4")" in
    fail) echo partial > "$5"; exit 2 ;;
    mutate) printf '%s\n' changed > "$4"; echo partial > "$5" ;;
    empty) : > "$5" ;;
    *) cat "$4" > "$5" ;;
esac
EOF
chmod +x "$TEST_DIR/converter"
ASCLASH_OPERATION_LOCK_HELD=true
printf '%s\n' '- IP-CIDR,10.0.0.0/24' > "$TEST_DIR/a/same.mrs"
printf '%s\n' '- IP-CIDR,20.0.0.0/24' > "$TEST_DIR/b/same.mrs"
parse() { extract_ipv4_cidr_from_rule_provider_file "$1" "${2:-classical}"; }
[ "$(parse "$TEST_DIR/a/same.mrs")" = 10.0.0.0/24 ]
[ "$(parse "$TEST_DIR/b/same.mrs")" = 20.0.0.0/24 ]
[ "$(parse "$TEST_DIR/a/same.mrs")" = 10.0.0.0/24 ]
[ "$(wc -l < "$TEST_DIR/calls")" -eq 2 ]
# Identical bytes at a different path reuse the completed parse.
cp "$TEST_DIR/a/same.mrs" "$TEST_DIR/b/copy.mrs"
parse "$TEST_DIR/b/copy.mrs" > /dev/null
[ "$(wc -l < "$TEST_DIR/calls")" -eq 2 ]
# Behavior and content both invalidate, including same-length replacements.
parse "$TEST_DIR/a/same.mrs" ipcidr > /dev/null
printf '%s\n' '- IP-CIDR,30.0.0.0/24' > "$TEST_DIR/a/same.mrs"
[ "$(parse "$TEST_DIR/a/same.mrs")" = 30.0.0.0/24 ]
[ "$(wc -l < "$TEST_DIR/calls")" -eq 4 ]
printf '%s\n' empty > "$TEST_DIR/empty.mrs"
[ -z "$(parse "$TEST_DIR/empty.mrs")" ]
[ -z "$(parse "$TEST_DIR/empty.mrs")" ]
[ "$(wc -l < "$TEST_DIR/calls")" -eq 5 ]
printf '%s\n' fail > "$TEST_DIR/fail.mrs"
before=$(find "$TEST_DIR/runtime/parsed_provider_cache" -name '*.parsed' | wc -l)
if parse "$TEST_DIR/fail.mrs" > "$TEST_DIR/result"; then exit 1; fi
if parse "$TEST_DIR/fail.mrs" > "$TEST_DIR/result"; then exit 1; fi
[ ! -s "$TEST_DIR/result" ]
[ "$(find "$TEST_DIR/runtime/parsed_provider_cache" -name '*.parsed' | wc -l)" -eq "$before" ]
[ "$(wc -l < "$TEST_DIR/calls")" -eq 7 ]
# Unlocked calls do not write or prune shared cache state.
ASCLASH_OPERATION_LOCK_HELD=false
parse "$TEST_DIR/a/same.mrs" > /dev/null
[ "$(wc -l < "$TEST_DIR/calls")" -eq 7 ]
[ "$(find "$TEST_DIR/runtime/parsed_provider_cache" -name '*.parsed' | wc -l)" -eq "$before" ]
ASCLASH_OPERATION_LOCK_HELD=true
# Nested parses preserve the existing intersection semantics.
printf '%s\n' '- AND,((IP-CIDR,10.0.0.0/24),(IP-CIDR,10.0.0.128/25),(NETWORK,tcp),(DST-PORT,443))' > "$TEST_DIR/nested.yaml"
[ "$(extract_classical_and_ipcidr_entries "$TEST_DIR/nested.yaml")" = '10.0.0.128/25|tcp|443' ]
# Source replacement during conversion must publish neither cache nor output.
printf '%s\n' mutate > "$TEST_DIR/mutate.mrs"
before=$(find "$TEST_DIR/runtime/parsed_provider_cache" -name '*.parsed' | wc -l)
if parse "$TEST_DIR/mutate.mrs" > "$TEST_DIR/result"; then exit 1; fi
[ ! -s "$TEST_DIR/result" ]
[ "$(find "$TEST_DIR/runtime/parsed_provider_cache" -name '*.parsed' | wc -l)" -eq "$before" ]
# A failing parser must not cache partial stdout. Enable real profile_run to
# check hit/miss records and nonzero provider_parse timing results.
ASCLASH_PROFILE_FILE="$TEST_DIR/profile"
profile_now_ms() { printf '1\n'; }
printf '%s\n' '10.9.0.0/24' > "$TEST_DIR/error.txt"
awk() { printf '%s\n' partial; return 1; }
if parse "$TEST_DIR/error.txt" ipcidr > "$TEST_DIR/result"; then exit 1; fi
unset -f awk
[ ! -s "$TEST_DIR/result" ]
[ "$(find "$TEST_DIR/runtime/parsed_provider_cache" -name '*.parsed' | wc -l)" -eq "$before" ]
parse "$TEST_DIR/error.txt" ipcidr > /dev/null
parse "$TEST_DIR/error.txt" ipcidr > /dev/null
grep -q '^cache|provider|hit$' "$ASCLASH_PROFILE_FILE"
grep -q '^cache|provider|miss$' "$ASCLASH_PROFILE_FILE"
grep -q '^timing|provider_parse|0|1$' "$ASCLASH_PROFILE_FILE"
# A simulated reboot clears only RAM state; persistent conversion is reused.
calls_before=$(wc -l < "$TEST_DIR/calls")
rm -f "$TEST_DIR/runtime/parsed_provider_cache"/*.parsed
[ "$(parse "$TEST_DIR/b/same.mrs")" = 20.0.0.0/24 ]
[ "$(wc -l < "$TEST_DIR/calls")" -eq "$calls_before" ]
# Both count and byte limits are enforced on publication.
cache="$TEST_DIR/runtime/parsed_provider_cache"
dd if=/dev/zero of="$cache/oversize.parsed" bs=1024 count=16385 2>/dev/null
i=0
while [ "$i" -lt 70 ]; do
    printf '%s\n' "10.0.$i.0/24" > "$cache/seed$i.parsed"
    i=$((i + 1))
done
printf '%s\n' '10.1.0.0/24' > "$TEST_DIR/plain.txt"
parse "$TEST_DIR/plain.txt" ipcidr > /dev/null
[ "$(find "$cache" -name '*.parsed' | wc -l)" -le 64 ]
[ "$(find "$cache" -name '.parse.*' | wc -l)" -eq 0 ]
[ "$(cat "$cache"/*.parsed | wc -c)" -le 16777216 ]
printf '%s\n' 'Parsed provider cache tests passed.'
