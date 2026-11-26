# ASClash — Advanced Simple Clash

**ASClash** is a LuCI application for OpenWrt that manages Mihomo and routes IPv4 traffic through TPROXY and/or TUN. It is a fork of [SSClash by ZeroChaos](https://github.com/zerolabnet/SSClash).

**Language:** [Русский — primary README](README.md) · English.

> ASClash uses Mihomo to process connections. The application creates firewall and policy-routing rules; the final action for traffic that reaches the core is controlled by your Mihomo configuration and rule order.

## What ASClash adds to the fork

ASClash retains the original LuCI project's core capabilities—kernel installation and updates, interface selection, TPROXY/TUN, configuration editing, local rule sets, logs and Mihomo dashboard access—and adds tools focused on rule parsing and diagnostics.

The comparison below is with the LuCI application in the [SSClash repository](https://github.com/zerolabnet/SSClash), not its separate Go edition.

| Area | ASClash additions |
| --- | --- |
| Diagnostics | A separate page checks service and core state, local Mihomo API availability, and consistency between the configured network mode and nftables, `ip rule`, routes and the TUN interface. Checks are read-only. |
| Rule-list status | Shows the latest list-generation cycle, states and counters for plain IP-CIDR and grouped AND lists, parser/provider issues, and whether the previous list was retained while provider files were unavailable. Historical log messages remain separately expandable. |
| Fake-IP IP-CIDR | Builds an IPv4 list from referenced rule providers and supported inline rules. LuCI shows per-provider counts and an FAQ; manual entries outside the generated block are preserved. |
| Forced DNS | Redirects client IPv4 TCP/UDP requests to router port 53 and reports active rules and conntrack-flow counters in Diagnostics. It follows interface-processing scope and exempts DIRECT sources. |
| Grouped AND rules | Supported `AND` rules are translated into IPv4 nftables sets and compact protocol/port rules. Matching sources/sets can be reused while TCP/UDP and port conditions stay separate. |
| Per-device DIRECT | Selecting a permanent IPv4 DHCP reservation adds a LuCI-managed Mihomo rule: the selected device's traffic goes through the core and exits directly. |
| Smart groups | An optional Status-page widget displays servers and weights for `type: smart` groups when the selected core exposes the required API. |
| Kernel source | The installer offers official Mihomo or Prizrak-Core. The selection is saved in settings; router architecture is detected automatically. |
| Service operation | Status notifications report service restarts and rule-list generation/application; the configuration page includes service controls and a dashboard link. |

See [Traffic processing and IP-CIDR lists](#traffic-processing-and-ip-cidr-lists) for behavior and limitations.

## Requirements and compatibility

- OpenWrt **22.03 or newer**, using **firewall4/nftables only**. Iptables-only systems are unsupported. CI packages are built using OpenWrt 24.10 and 25.12 SDKs.
- **IPv4 only**; ASClash does not configure IPv6 routing.
- TPROXY requires `kmod-nft-tproxy`; TUN requires `kmod-tun`. The automatic installer installs the required packages.
- The LuCI package is architecture-independent, but the Mihomo binary must match the router architecture.
- OpenWrt 22.03–24.10 uses `opkg`; OpenWrt 25 and later uses `apk`.

Grouped AND rules are implemented with nftables only. ASClash targets firewall4/nftables.

## Installation

### Automatic installation

The installer detects OpenWrt and the router architecture, offers official Mihomo or Prizrak-Core, installs dependencies and the latest published ASClash package, then downloads a compatible core from the selected repository:

```sh
wget --no-proxy -qO- https://github.com/Desonator/ASClash/raw/refs/heads/main/install-asclash.sh | ash
```

Review the installer before running it. It installs the latest published ASClash release. On reruns, the current kernel source is the default choice; set `ASCLASH_KERNEL_SOURCE=official` or `ASCLASH_KERNEL_SOURCE=prizrak` for non-interactive use. Rerunning replaces the core with the latest release from the selected source.

### Manual installation

1. Open [ASClash Releases](https://github.com/Desonator/ASClash/releases) and download the package matching your OpenWrt version: `.ipk` for `opkg` or `.apk` for `apk`.
2. Install dependencies if they were not installed automatically:

```sh
# OpenWrt 22.03–24.10
opkg update
opkg install firewall4 kmod-nft-tproxy kmod-tun coreutils-base64 curl

# OpenWrt 25+
apk update
apk add firewall4 kmod-nft-tproxy kmod-tun coreutils-base64 curl
```

3. Install the downloaded package:

```sh
# OpenWrt 22.03–24.10
opkg install /tmp/luci-app-asclash_<version>_all.ipk

# OpenWrt 25+
apk add --allow-untrusted /tmp/luci-app-asclash-<version>-r1.apk
```

User configuration is kept under `/opt/clash`. On first installation, review `/opt/clash/config.yaml`, then enable and start the service from LuCI or run:

```sh
/etc/init.d/clash enable
/etc/init.d/clash start
```

## Configuration

Open ASClash in LuCI under **Services → ASClash**.

### Traffic settings

The **interface processing mode** selects which traffic is sent to the core:

- **Exclude:** process all interfaces except those explicitly excluded. Automatic WAN detection can add the WAN interface to the exclusions.
- **Explicit:** process only selected interfaces. Use it when you need precise control over traffic sources.

Available network modes:

- **TPROXY** — transparently intercept TCP and UDP.
- **TUN** — route traffic through the `clash-tun` interface.
- **MIXED** — TCP uses TPROXY; UDP uses TUN.

For TUN/MIXED, ASClash configures policy routing and watches for `clash-tun`. The TUN stack (`system`, `gvisor` or `mixed`) is selected in the Mihomo configuration; availability depends on the chosen core.

Additional settings include QUIC blocking (reject UDP/443), forced client DNS redirection (IPv4 TCP/UDP 53), placing rule sets and proxy providers in RAM (`tmpfs`), adding HWID headers to proxy-provider requests (Remnawave compatibility; header values are configurable), and showing Smart-group weights on the Status page.

### Kernel management

In Settings, choose a release source:

1. official Mihomo;
2. Prizrak-Core;
3. a custom GitHub repository in `owner/repository` format.

ASClash detects the router architecture, compares installed and available versions, downloads the matching binary and installs it as `/opt/clash/bin/clash`. Restart the service after replacing the core. Configuration validation follows the selected source; a core fork may accept additional configuration fields.

### Configuration, lists and logs

- **Configuration** — YAML editor with syntax highlighting, service controls and a dashboard link.
- **Status** — service/core state, IP-CIDR lists, grouped AND rules and, when enabled, Smart-group weights.
- **Diagnostics** — read-only summary of the Mihomo API, configured/active network mode, rule-list cycle and parser/provider messages.
- **Local rule sets** — manage user rule files under `/opt/clash/lst`.
- **Log** — service and core messages.

## Traffic processing and IP-CIDR lists

ASClash installs firewall and policy-routing rules for selected interfaces. Reserved/local networks, proxy-server addresses, service ports and already-marked traffic are excluded to reduce routing loops. The firewall decides which connections reach Mihomo; Mihomo's configuration and rule order decide the final route/action for those connections.

### DIRECT for a selected device

Select a device with a permanent IPv4 DHCP reservation in Settings. ASClash adds a marked `SRC-IP-CIDR,<IP>/32,DIRECT` rule near the start of Mihomo's rules, after leading `REJECT`/`PASS` rules. Traffic still passes through Mihomo, which chooses the DIRECT outbound; this preserves Fake-IP handling. It works with TPROXY, TUN and MIXED, including `redir-host`, when the ingress interface is in ASClash's scope: selected interfaces in Explicit mode, all but excluded interfaces in Exclude mode. Mihomo must use `mode: rule`; earlier `REJECT`/`PASS` rules and enabled QUIC blocking retain priority.

### Fake-IP and real IP addresses

With `fake-ip-filter-mode: whitelist`, Mihomo returns Fake-IP addresses only for DNS names selected by its whitelist logic. With `rule`, it checks `fake-ip-filter` from top to bottom and chooses `fake-ip` or `real-ip` for each match. Fake-IP traffic is identified by the configured range.

For a domain resolved to a real IP, the firewall cannot infer the original domain from an arbitrary DNS answer. That traffic reaches Mihomo only if it matches an IP-CIDR set or another interception rule; otherwise it may bypass the core. This is particularly important for domain rules that return `real-ip`.

`redir-host` does not use a Fake-IP range. Interception follows the interface mode and firewall policy; domain rules need domain information available to the core, for example through sniffing.

### Forced DNS redirection

The **Force client DNS through the router** option intercepts new IPv4 TCP and UDP requests to port 53 and redirects them to the router's local DNS resolver (dnsmasq, which must listen on the standard port 53). While the ASClash service is running, dnsmasq uses the upstream configured by ASClash for Mihomo. This also catches requests sent to manually configured resolvers such as `8.8.8.8:53`.

The redirect follows interface scope: **Explicit** applies only to selected interfaces; **Exclude** applies to all interfaces except excluded ones. WAN ingress, router-originated DNS and the `clash-tun` interface are not redirected. In Explicit mode with Fake-IP `whitelist`/`rule`, sources matching a simple `SRC-IP-CIDR,...,DIRECT` rule are exempt from this firewall redirect. This option does not create a per-device DNS upstream: clients already using the router DNS from DHCP continue to use dnsmasq's shared upstream.

New port-53 requests are redirected before ordinary firewall redirect rules; already-established conntrack DNAT flows keep their prior destination until the state expires. The option is active only while ASClash is running and **does not block DoT/DoH**. DoT uses a separate port; DoH resembles HTTPS and requires a separate policy. Diagnostics shows active nftables rules and conntrack-flow counters, not a count of every DNS query. If dnsmasq is configured to listen on a non-standard DNS port, ASClash does not apply forced DNS rather than redirecting clients to an unbound port.

> External DNS, browser DoH/DoT and device-specific DNS clients can bypass router DNS settings. Receiving a real IP does not guarantee that Mihomo can apply a domain rule to the connection.

### Plain IP-CIDR list

For `whitelist` and `rule`, ASClash can mark IPv4 traffic to addresses in `/opt/clash/lst/fakeip-whitelist-ipcidr.txt`, allowing known real-IP destinations to reach the core.

The generator extracts suitable `IP-CIDR` entries from referenced rule providers, `RULE-SET` references in `dns.fake-ip-filter`, and supported inline rules. Entries with terminal actions `DIRECT`, `REJECT`, `REJECT-DROP` and `PASS` are excluded from the proxy list. Generated content is bounded by `AUTO-BEGIN` and `AUTO-END`; manual lines outside that block are preserved. To manage the file manually, set in `/opt/clash/settings`:

```sh
AUTO_FAKEIP_WHITELIST="false"
```

LuCI shows total and per-provider counts. Addresses across different providers are intentionally not fully deduplicated, avoiding expensive whole-list optimization on the router.

### Grouped AND IP-CIDR rules (nftables)

The parser supports a subset of `AND` rules containing an IPv4 `IP-CIDR` or `RULE-SET` source, one `NETWORK` condition (`tcp` or `udp`), and `DST-PORT` values/ranges. For example:

```yaml
- AND,((RULE-SET,cloudflare-ip),(NETWORK,udp),(DST-PORT,19200-19500,50000-50100)),Discord
- AND,((RULE-SET,cloudflare-ip),(NETWORK,tcp),(DST-PORT,80,443,2050-2100,8080-8880)),IP-CIDR subnets
- AND,((IP-CIDR,186.157.42.56/32),(NETWORK,tcp),(DST-PORT,80,443)),IP-CIDR subnets
```

Matching CIDR sources are placed in nftables sets and matching traffic is marked for Mihomo. The final action remains a Mihomo rule; the generator does not replace the core's routing engine. Rules ending in `DIRECT`, `REJECT` or `REJECT-DROP` are not converted into grouped sets. Multiple CIDR operands in one AND rule are intersected.

When the same `RULE-SET` appears with different TCP/UDP or port conditions, the CIDR source can be reused while each set of conditions remains separate. Global deduplication of every address across different providers is not performed. Grouped rules apply to eligible forwarded client traffic, not traffic generated by the router itself.

Generation is enabled by default and has group/CIDR limits; exceeding a limit fails generation instead of applying an oversized set. Add this setting to `/opt/clash/settings` and restart the service to generate the batch without applying it:

```sh
GROUPED_FAKEIP_PORT_RULES_DRY_RUN="true"
```

Check the generated file's syntax with:

```sh
nft -c -f /tmp/clash/fakeip_port_groups.nft
```

Supported rules and skip reasons are shown on the Status and Diagnostics pages.

### Limitations and safe configuration

- IPv4 only; IPv6 firewall and routing rules are not generated.
- Per-device DIRECT requires Mihomo `mode: rule` and applies only on interfaces processed by ASClash.
- Automatic fail-open routing when all servers in a Smart group fail is not implemented.
- The AND parser handles a documented subset of rule syntax; operands must match that subset.
- Early firewall rules and IP lists can determine whether a connection reaches the core. Mihomo configuration controls the final route and domain-rule ordering.
- If `external-controller` is enabled, set `secret` and restrict access to trusted networks. Never expose the API/dashboard port to WAN or the Internet.

## Updating and uninstalling

Update from [the latest ASClash release](https://github.com/Desonator/ASClash/releases) or rerun the installer. User data and `config.yaml` live under `/opt/clash`; removing the package does not delete them.

Remove the application:

```sh
# OpenWrt 22.03–24.10
opkg remove luci-app-asclash

# OpenWrt 25+
apk del luci-app-asclash
```

Remove `/opt/clash` separately only if you intend to erase configuration, lists and other user data. Back it up first.

## Project and license

- Fork: [Desonator/ASClash](https://github.com/Desonator/ASClash)
- Upstream: [zerolabnet/SSClash](https://github.com/zerolabnet/SSClash)
- Fork maintainer: [Desonator](https://github.com/Desonator)
- Upstream author: [ZeroChaos](https://zerolab.net/) · [Support](https://zerolab.net/donate/)
- License: GNU GPL v2.
