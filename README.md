📖 Read this in other languages:
- [Русский](README.ru.md)

> **ASClash (Advanced Simple Clash)** is an OpenWrt proxy-management application maintained by Desonator and based on the [SSClash project by ZeroChaos](https://github.com/zerolabnet/SSClash).

<h3 align="center">Advanced Simple Clash — install and configure ASClash on OpenWrt</h3>

# Setup Guide

# Autoinstall script

Installs or updates all dependencies, the ASClash LuCI package and the Mihomo core.
The installer migrates the old `luci-app-ssclash` package to `luci-app-asclash`
and preserves configuration and user data under `/opt/clash`.

```bash
wget --no-proxy -qO- https://github.com/Desonator/ASClash/raw/refs/heads/main/install-asclash.sh | ash
```

# Manual install

## Step 1: Update Package List

Update the package list to ensure you have the latest available versions.

For **OpenWrt >= 25** (apk):

```bash
apk update
```

For **OpenWrt < 25** (opkg):

```bash
opkg update
```

## Step 2: Install Required Packages

In general, package managers resolve dependencies automatically when you install from a package repository. In this guide, we use manual installation from GitHub Releases, and required dependencies are:

- `coreutils-base64` – for scripts that use Base64;
- `kmod-tun` – for TUN mode;
- the appropriate transparent proxy module depending on your firewall stack:
  - `kmod-nft-tproxy` for **firewall4 / nftables**;
  - `iptables-mod-tproxy` for **firewall3 / iptables**.

Only if you are installing packages manually (`.apk`/`.ipk`) or building a custom image and dependencies are missing, you can install the transparent proxy modules manually:

```bash
# For nftables (firewall4) on OpenWrt >= 25:
apk add kmod-nft-tproxy

# For nftables (firewall4) on older OpenWrt:
opkg install kmod-nft-tproxy

# For iptables (firewall3, OpenWrt < 22.03.x):
opkg install iptables-mod-tproxy
```

## Step 3: Download and Install the ASClash Package

Download the ASClash package and install it. If migrating manually from the
old package, stop the service and remove `luci-app-ssclash` first; the config
and user data under `/opt/clash` are kept.

```bash
# OpenWrt >= 25:
/etc/init.d/clash stop 2>/dev/null || true
curl -L https://github.com/Desonator/ASClash/releases/download/v4.7.1/luci-app-asclash-4.7.1-r1.apk -o /tmp/luci-app-asclash-4.7.1-r1.apk
apk del luci-app-ssclash 2>/dev/null || true
apk add --allow-untrusted /tmp/luci-app-asclash-4.7.1-r1.apk

# OpenWrt < 25:
/etc/init.d/clash stop 2>/dev/null || true
curl -L https://github.com/Desonator/ASClash/releases/download/v4.7.1/luci-app-asclash_4.7.1-r1_all.ipk -o /tmp/luci-app-asclash_4.7.1-r1_all.ipk
opkg remove luci-app-ssclash 2>/dev/null || true
opkg install /tmp/luci-app-asclash_4.7.1-r1_all.ipk

rm -f /tmp/luci-app-asclash_4.7.1-r1_all.ipk /tmp/luci-app-asclash-4.7.1-r1.apk
```

## Step 4: Kernel management

Open **Services → ASClash → Status → Mihomo Kernel Management**. The page detects
the router architecture, checks the installed binary and can install the latest
release from either the official `MetaCubeX/mihomo` repository or a custom
GitHub repository (for example, `legiz-ru/Prizrak-Core`). Choose and save the
release source before checking or installing its kernel. The installer selects
the matching release asset, verifies the installed executable and reports the
installed and latest versions. Restart the Clash service after an installation
or update to start the new binary.

On a first package installation, the service is deliberately left disabled at
boot so you can review/edit the example configuration before starting it. Start
the service from LuCI (or enable it with `/etc/init.d/clash enable`) after the
configuration is ready; subsequent boots will then start it automatically.

The status badges periodically check the init service and the running
`/opt/clash/bin/clash` process. The page refreshes when it detects a service or
kernel transition. Configuration validation uses the selected core's
capabilities; when using Prizrak-Core, the configured-source validator is used
so Prizrak-specific configuration fields are not rejected by stock Mihomo.

## Step 5: Configure traffic processing

ASClash offers two interface processing modes:

### Exclude Mode (Universal approach) - **Recommended for most users**

- **Default mode** that processes traffic from ALL interfaces except selected ones
- Automatically detects and excludes WAN interface
- Simple to configure - just select interfaces to bypass proxy
- Best for typical home router setups

### Explicit Mode (Precise control) - **For advanced users**

- Processes traffic ONLY from selected interfaces
- More secure but requires manual configuration
- Automatically detects LAN bridge when enabled
- Ideal for complex network setups requiring precise control

### Additional Settings:

- **Block QUIC traffic**: Blocks UDP port 443 to improve proxy effectiveness for services like YouTube
- **Store rules and proxy providers in RAM**: rulesets and proxy-providers directories are placed on tmpfs to extend the lifespan of the NAND chip
- **Add HWID headers to subscriptions**: Automatically adds HWID headers to proxy-providers (Remnawave compatibility)

The service supports TPROXY, TUN and MIXED proxy modes. In MIXED mode, TCP is
handled through TPROXY and UDP through TUN. TUN mode requires `/dev/net/tun` and
the `kmod-tun` package; transparent proxy mode requires the matching TPROXY
kernel module for the router's firewall stack. TUN/MIXED also install the
necessary forwarding and policy-routing state for the `clash-tun` interface.
The optional TUN stack (`system`, `gvisor` or `mixed`) is configured in the
Mihomo YAML configuration.

<p align="center">
 <img src=".github/assets/images/screenshots/scr-01.png" width="100%">
</p>

## Step 6: ASClash Configuration Management

Edit your Clash configuration with the built-in editor featuring:

- **Syntax highlighting** for YAML files
- **Live service control** (Start/Stop/Restart)
- **Service status indicator**

<p align="center">
 <img src=".github/assets/images/screenshots/scr-02.png" width="100%">
</p>

## Step 7: Local Rulesets Management

Create and manage local rule files for use with `rule-providers`:

- **Create custom rule lists** with validation
- **Organized file management** with collapsible sections

<p align="center">
 <img src=".github/assets/images/screenshots/scr-03.png" width="100%">
</p>

## Step 8: Real-time Log Monitoring

Monitor Clash activity with the integrated log viewer:

- **Real-time log streaming** with automatic updates
- **Filtered display** showing only Clash-related entries
- **Color-coded log levels** and daemon identification
- **Auto-scroll** to latest entries

<p align="center">
 <img src=".github/assets/images/screenshots/scr-04.png" width="100%">
</p>

## Step 9: Dashboard Access

Access the Clash dashboard directly from the LuCI interface with automatic configuration detection.

<p align="center">
 <img src=".github/assets/images/screenshots/scr-05.png" width="100%">
</p>

# Network behavior and generated IP-CIDR lists

### Interface selection and traffic outside the proxy

In **Exclude** interface mode, eligible traffic is processed except traffic on
excluded interfaces (WAN is detected and excluded when automatic detection is
enabled). In **Explicit** mode, only selected interfaces are processed. The
firewall rules also bypass reserved/local networks, the router's own proxy
servers, configured Clash ports and traffic already carrying routing marks, to
avoid proxy loops. These firewall rules select which connections enter Mihomo;
the final route/action for traffic that does enter the core remains governed by
the Mihomo configuration and rule order.

### Fake-IP whitelist (plain IP-CIDR list)

When `dns.fake-ip-filter-mode` is `whitelist` or `rule`, the firewall can mark
traffic to IPv4 addresses/subnets in `/opt/clash/lst/fakeip-whitelist-ipcidr.txt`.
The LuCI status page shows provider counts and a FAQ for this list. The file
supports manual entries and an auto-generated section delimited by
`AUTO-BEGIN`/`AUTO-END`; manual content outside these markers is preserved.
Automatic generation reads IPv4 `IP-CIDR` entries from providers referenced by
non-`DIRECT`/non-`REJECT` rules and relevant `RULE-SET` entries in
`dns.fake-ip-filter`, plus literal top-level `IP-CIDR` rules whose action is
not `DIRECT`, `REJECT`, `REJECT-DROP` or `PASS`. Set `AUTO_FAKEIP_WHITELIST=false` in
`/opt/clash/settings` to disable generation and manage the list manually.
Changes are applied by the firewall without restarting Mihomo.

In `whitelist` mode, only DNS matches selected by Mihomo receive fake IPs; in
`rule` mode, `fake-ip-filter` is evaluated top-down and each match chooses
`fake-ip` or `real-ip`. Fake-IP destinations are routed by the fake-IP range;
real-IP destinations reach Mihomo only when matched by the generated/manual
CIDR lists or other firewall rules. Arbitrary DNS answers for domain-only
`real-ip` rules cannot be inferred into static IP sets, so they may bypass the
core unless separately covered.

### Grouped `AND` IP-CIDR rules (nftables only)

For supported `AND` rules combining a provider or direct IPv4 `IP-CIDR` entries
with `NETWORK` and/or `DST-PORT`, ASClash creates separate nftables IPv4 sets
and applies compact protocol/port marking rules. Port ranges stay ranges; CIDRs
are not expanded into IP/port pairs. This feature is nftables-only; grouped
`AND` rules are not applied by the iptables backend. The status page reports
providers, networks, destination ports and entry counts, and provides a FAQ.
When an AND rule has several CIDR operands, the generated set contains their
intersection, not their union. Rules whose final action is `DIRECT`, `REJECT`
or `REJECT-DROP` are omitted from grouped firewall generation. Other actions
are marked into Mihomo so its own rule engine can continue evaluating them.
Identical resulting CIDR sets are shared across rules with different
network/port conditions; those conditions remain separate nftables rules. The
status table lists each provider once, combines its network/port conditions,
and counts that provider's own unique CIDRs. The overall total counts each
unique merged firewall set only once.
Grouped rules process eligible transit traffic; router-originated traffic uses
the separate output-chain policy and is intentionally not matched by these sets.

Generation is enabled by default in the `clash-rules` configuration and has
limits (`GROUPED_FAKEIP_MAX_GROUPS=32`,
`GROUPED_FAKEIP_MAX_CIDRS=150000`). If a limit is exceeded, generation fails
instead of applying an oversized generated batch. `GROUPED_FAKEIP_PORT_RULES_DRY_RUN=true`
generates/validates without applying the grouped batch. Generated source and
batch digests avoid unnecessary parsing and firewall changes; updates are
serialized with a lock. Provider-derived data is refreshed after the core has
started and its provider files become available, on WAN-up, and by the
30-minute cron job installed with the package. Unchanged source data does not
require a firewall rebuild.

### Smart-group weights

On the Status page, ASClash detects groups configured with `type: smart` and
queries the core's external-controller API for their unique server weights.
Each group is displayed separately; server cards are sorted by current weight
and color-coded from red (low) through yellow to green (high). Weights refresh
in the browser every 30 seconds while the page is visible. The section is
omitted when there are no Smart groups or the core does not expose the required
API. The LuCI backend requests the weights from the router, so the configured
external controller must be reachable from the router. Configure its access
secret if one is set.

## Grouped `AND` rule example

For example, this supported rule refers to an IP-CIDR provider and restricts
the firewall mark to the specified UDP destination-port range:

```yaml
- AND,((RULE-SET,cloudflare-ip),(DST-PORT,80,443,2052,2053,2082,2083,2086,2087,2095,2096,8080,8443,8880)),Подсети IP-CIDR
- AND,((RULE-SET,discord-voice),(NETWORK,udp),(DST-PORT,50000-50100)),Discord
- AND,((IP-CIDR,186.157.42.56/32),(NETWORK,tcp),(DST-PORT,80,443,2050-2100,8080-8880)),Подсети IP-CIDR
```

The following settings in `/opt/clash/settings` control the generated batch
(they do not replace Mihomo's own rule engine):

```sh
GROUPED_FAKEIP_PORT_RULES_ENABLED="true"
GROUPED_FAKEIP_PORT_RULES_DRY_RUN="false"
GROUPED_FAKEIP_MAX_GROUPS="32"
GROUPED_FAKEIP_MAX_CIDRS="150000"
```

To syntax-check a generated batch without applying it, use:

```sh
nft -c -f /tmp/clash/fakeip_port_groups.nft
```

# Remove ASClash

To remove the ASClash package completely:

```bash
# OpenWrt >= 25:
apk del luci-app-asclash

# OpenWrt < 25:
opkg remove luci-app-asclash
```

Package removal does not require deleting `/opt/clash`. That directory contains
the configuration, subscriptions and user data; remove it manually only if you
intentionally want to erase those files.
