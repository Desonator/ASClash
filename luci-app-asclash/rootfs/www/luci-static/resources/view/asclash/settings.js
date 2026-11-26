'use strict';
'require view';
'require fs';
'require ui';
'require network';
'require uci';
'require view.asclash.utils';

view_asclash_utils.bumpRpcTimeout();

function watchListProgress(previous) {
	view_asclash_utils.monitorListProgress(previous);
}

// =============================================================================
// SECTION: Network interface helpers
// =============================================================================

async function getNetworkInterfaces() {
    const result = [];
    const seenInterfaces = new Set();

    try {
        const sysNetResult = await fs.exec('ls', ['/sys/class/net/']);
        if (sysNetResult.code === 0 && sysNetResult.stdout) {
            const sysNetInterfaces = sysNetResult.stdout.trim().split('\n');
            sysNetInterfaces.forEach(function(name) {
                name = name.trim();
                if (name && !seenInterfaces.has(name) && name !== 'lo') {
                    seenInterfaces.add(name);
                    result.push(createInterfaceEntry(name));
                }
            });
        }
    } catch (e) {
        console.error('Failed to read /sys/class/net:', e);
    }

    try {
        const ipResult = await fs.exec('ip', ['link', 'show']);
        if (ipResult.code === 0 && ipResult.stdout) {
            const lines = ipResult.stdout.split('\n');
            lines.forEach(function(line) {
                const match = line.match(/^\d+:\s+([^:@]+)/);
                if (match && match[1] && match[1] !== 'lo') {
                    const name = match[1];
                    if (!seenInterfaces.has(name)) {
                        seenInterfaces.add(name);
                        result.push(createInterfaceEntry(name));
                    }
                }
            });
        }
    } catch (e) {
        console.error('Failed to execute ip link:', e);
    }

    try {
        const bridgeResult = await fs.exec('brctl', ['show']);
        if (bridgeResult.code === 0 && bridgeResult.stdout) {
            const lines = bridgeResult.stdout.split('\n');
            lines.forEach(function(line) {
                const match = line.match(/^([^\s]+)\s/);
                if (match && match[1] && match[1] !== 'bridge') {
                    const name = match[1];
                    if (!seenInterfaces.has(name)) {
                        seenInterfaces.add(name);
                        result.push(createInterfaceEntry(name));
                    }
                }
            });
        }
    } catch (e) {
    }

    try {
        const interfaces = await network.getDevices();
        interfaces.forEach(function(iface) {
            if (iface.getName() && iface.getName() !== 'lo') {
                const name = iface.getName();
                if (!seenInterfaces.has(name)) {
                    seenInterfaces.add(name);
                    result.push(createInterfaceEntry(name));
                }
            }
        });
    } catch (e) {
        console.warn('LuCI network API not available:', e.message);
    }

    try {
        const networks = await network.getNetworks();
        networks.forEach(function(net) {
            const device = net.getL3Device();
            if (device && device.getName() && device.getName() !== 'lo') {
                const name = device.getName();
                if (!seenInterfaces.has(name)) {
                    seenInterfaces.add(name);
                    result.push(createInterfaceEntry(name));
                }
            }
        });
    } catch (e) {
        console.warn('LuCI network.getNetworks() not available:', e.message);
    }

    if (result.length === 0) {
        console.warn('No network interfaces found on this system');
    } else {
        console.log(`Found ${result.length} network interfaces:`, result.map(i => i.name).join(', '));
    }

    const filteredResult = result.filter(iface => iface.name !== 'clash-tun');

    const categoryOrder = ['wan', 'ethernet', 'wifi', 'usb', 'vpn', 'virtual', 'other'];
    return filteredResult.sort((a, b) => {
        const catA = categoryOrder.indexOf(a.category);
        const catB = categoryOrder.indexOf(b.category);
        if (catA !== catB) return catA - catB;
        return a.name.localeCompare(b.name);
    });
}

function createInterfaceEntry(name) {
    let category = 'other';
    let icon = '🔗';

    if (name.match(/\.\d+$/)) {
        category = 'ethernet';
        icon = '🏷️';
    } else if (name.match(/^(br-|bridge)/)) {
        category = 'ethernet';
        icon = '🔀';
    } else if (name.match(/^(eth|lan|switch|bond|team)/)) {
        category = 'ethernet';
        icon = '🌐';
    } else if (name.match(/^(wlan|wifi|ath|phy|ra|mt|rtl|iwl)/)) {
        category = 'wifi';
        icon = '📶';
    } else if (name.match(/^(wan|ppp|modem|3g|4g|5g|lte|gsm|cdma|hsdpa|hsupa|umts)/)) {
        category = 'wan';
        icon = '🌍';
    } else if (name.match(/^(tun|tap|vpn|wg|nord|express|surf|pia|ovpn|openvpn|l2tp|pptp|sstp|ikev2|ipsec)/)) {
        category = 'vpn';
        icon = '🔐';
    } else if (name.match(/^(usb|rndis|cdc|ecm|ncm|qmi|rmnet|mbim)/)) {
        category = 'usb';
        icon = '🔌';
    } else if (name.match(/^(veth|macvlan|ipvlan|dummy|vrf|vcan|vxcan)/)) {
        category = 'virtual';
        icon = '💭';
    }
    return {
        name: name,
        description: name,
        category: category,
        icon: icon
    };
}

// =============================================================================
// SECTION: HWID (device fingerprint) collection and YAML injection
// NOTE: This feature is opt-in (disabled by default). When enabled it sends
//       a hashed MAC address, OpenWrt version, and device model as custom HTTP
//       headers to every proxy-provider request. See createAdditionalSettings()
//       for the UI toggle and its description.
// =============================================================================

async function getHwidValues() {
    try {
        let hwid = 'unknown';
        try {
            const macResult = await fs.exec('/bin/sh', ['-c',
                "cat /sys/class/net/eth0/address 2>/dev/null | tr -d ':' | md5sum | cut -c1-14"
            ]);
            if (macResult.code === 0 && macResult.stdout) {
                hwid = macResult.stdout.trim();
            }
        } catch (e) {}

        let verOs = 'unknown';
        try {
            const verResult = await fs.exec('/bin/sh', ['-c',
                ". /etc/openwrt_release && echo $DISTRIB_RELEASE"
            ]);
            if (verResult.code === 0 && verResult.stdout) {
                verOs = verResult.stdout.trim();
            }
        } catch (e) {}

        let deviceModel = 'Router';
        try {
            const modelResult = await fs.exec('/bin/sh', ['-c',
                "cat /tmp/sysinfo/model 2>/dev/null"
            ]);
            if (modelResult.code === 0 && modelResult.stdout) {
                deviceModel = modelResult.stdout.trim();
            }
        } catch (e) {}

        return { hwid, verOs, deviceModel };
    } catch (e) {
        return {
            hwid: 'unknown',
            verOs: 'unknown',
            deviceModel: 'Router'
        };
    }
}

function addHwidToYaml(yamlContent, userAgent, deviceOS, hwid, verOs, deviceModel) {
    const lines = yamlContent.split('\n');
    const result = [];
    let inProxyProviders = false;
    let inProvider = false;
    let currentProvider = [];
    let hasHeader = false;

    function flushProvider() {
        result.push(...currentProvider);
        if (!hasHeader) {
            while (result.length > 0 && result[result.length - 1].trim() === '') {
                result.pop();
            }
            result.push('    header:');
            result.push(`      User-Agent: [${userAgent}]`);
            result.push(`      x-hwid: [${hwid}]`);
            result.push(`      x-device-os: [${deviceOS}]`);
            result.push(`      x-ver-os: [${verOs}]`);
            result.push(`      x-device-model: [${deviceModel}]`);
            result.push('');
        }
    }

    for (let i = 0; i < lines.length; i++) {
        const line = lines[i];

        if (line.match(/^proxy-providers:\s*$/)) {
            inProxyProviders = true;
            result.push(line);
            continue;
        }

        if (inProxyProviders) {
            if (line.match(/^[a-zA-Z]/)) {
                if (inProvider) flushProvider();
                inProxyProviders = false;
                inProvider = false;
                result.push(line);
                continue;
            }

            const providerMatch = line.match(/^  ([a-zA-Z0-9_-]+):\s*$/);
            if (providerMatch) {
                if (inProvider) flushProvider();
                currentProvider = [line];
                inProvider = true;
                hasHeader = false;
                continue;
            }

            if (inProvider && line.match(/^    header:\s*$/)) {
                hasHeader = true;
            }

            if (inProvider) {
                currentProvider.push(line);
            } else {
                result.push(line);
            }
        } else {
            result.push(line);
        }
    }

    if (inProvider) flushProvider();

    return result.join('\n');
}

// =============================================================================
// SECTION: config.yaml transformations
// These functions perform text-based mutations of the YAML config.  They rely
// on heuristic line scanning (not a full YAML parser) and are sensitive to
// indentation and key placement.  The expected config.yaml format is the one
// produced by Mihomo / generated by this app.
// =============================================================================

function transformProxyMode(content, proxyMode, tunStack) {
    let lines = content.split('\n');
    let newLines = [];
    let inTunSection = false;
    let tunIndentLevel = 0;

    for (let i = 0; i < lines.length; i++) {
        const line = lines[i];
        const trimmed = line.trim();

        if (trimmed.match(/^#\s*Proxy\s+Mode:/i)) continue;

        if (trimmed === '' && i + 1 < lines.length && lines[i + 1].trim() === '') {
            continue;
        }

        if (trimmed === '' && i + 1 < lines.length) {
            const nextLine = lines[i + 1].trim();
            if (nextLine.match(/^#\s*Proxy\s+Mode:/i) ||
                nextLine.match(/^tproxy-port/) ||
                nextLine.match(/^tun:/)) {
                continue;
            }
        }

        if (trimmed.match(/^tproxy-port:/)) {
            continue;
        }

        if (trimmed.match(/^tun:/)) {
            inTunSection = true;
            tunIndentLevel = line.search(/\S/);
            continue;
        }

        if (inTunSection) {
            const currentIndent = line.search(/\S/);
            if (line.trim() === '' ||
                line.trim().startsWith('#') ||
                (currentIndent > tunIndentLevel && line.trim() !== '')) {
                continue;
            } else {
                inTunSection = false;
            }
        }

        newLines.push(line);
    }

    let insertIndex = 0;
    for (let i = 0; i < newLines.length; i++) {
        if (newLines[i].trim().match(/^mode:/)) {
            insertIndex = i + 1;
            break;
        }
    }

    const normalizedTunStack = ['system', 'gvisor', 'mixed'].includes(tunStack) ? tunStack : 'system';
    let configToInsert = [];
    switch (proxyMode) {
        case 'tproxy':
            configToInsert = [
                '# Proxy Mode: TPROXY',
                'tproxy-port: 7894'
            ];
            break;
        case 'tun':
            configToInsert = [
                '# Proxy Mode: TUN',
                'tun:',
                '  enable: true',
                '  device: clash-tun',
                `  stack: ${normalizedTunStack}`,
                '  auto-route: false',
                '  auto-redirect: false',
                '  auto-detect-interface: false'
            ];
            break;
        case 'mixed':
            configToInsert = [
                '# Proxy Mode: MIXED (TCP via TPROXY port 7894, UDP via TUN)',
                'tproxy-port: 7894',
                'tun:',
                '  enable: true',
                '  device: clash-tun',
                `  stack: ${normalizedTunStack}`,
                '  auto-route: false',
                '  auto-redirect: false',
                '  auto-detect-interface: false'
            ];
            break;
    }

    newLines.splice(insertIndex, 0, ...configToInsert);
    return newLines.join('\n');
}

async function detectCurrentProxyMode() {
    try {
        const configContent = await L.resolveDefault(fs.read('/opt/clash/config.yaml'), '');
        if (!configContent) return 'tproxy';

        const lines = configContent.split('\n');
        let hasTproxy = false;
        let hasTun = false;

        for (const line of lines) {
            const trimmed = line.trim();
            if (trimmed.match(/^tproxy-port:/) && !trimmed.startsWith('#')) {
                hasTproxy = true;
            }
            if (trimmed.match(/^tun:/)) {
                const tunIndex = lines.indexOf(line);
                for (let i = tunIndex + 1; i < Math.min(tunIndex + 10, lines.length); i++) {
                    const nextLine = lines[i].trim();
                    if (nextLine.match(/^enable:\s*true/)) {
                        hasTun = true;
                        break;
                    }
                    if (nextLine.match(/^[a-zA-Z]/) && !nextLine.startsWith('#')) {
                        break;
                    }
                }
            }
        }

        if (hasTproxy && hasTun) return 'mixed';
        if (hasTun) return 'tun';
        if (hasTproxy) return 'tproxy';
        return 'tproxy';
    } catch (e) {
        console.error('Failed to detect proxy mode:', e);
        return 'tproxy';
    }
}

// =============================================================================
// SECTION: Settings persistence — read/write /opt/clash/settings
// =============================================================================

async function loadSettings() {
    try {
        const content = await L.resolveDefault(fs.read('/opt/clash/settings'), '');
        const settings = {
            mode: 'exclude',
            proxyMode: '',
            tunStack: 'system',
            autoDetectLan: true,
            autoDetectWan: true,
            blockQuic: true,
            forceDnsRedirect: false,
            useTmpfsRules: true,
            showSmartWeights: true,
            detectedLan: '',
            detectedWan: '',
            includedInterfaces: [],
            excludedInterfaces: [],
            enableHwid: false,
            hwidUserAgent: 'ASClash',
            hwidDeviceOS: 'OpenWrt',
            mihomoReleaseRepo: 'MetaCubeX/mihomo'
        };

        content.split('\n').forEach(line => {
            const eqIdx = line.indexOf('=');
            if (eqIdx === -1) return;
            const key = line.slice(0, eqIdx).trim();
            const value = line.slice(eqIdx + 1).trim();
            if (!key) return;
            switch(key) {
                case 'INTERFACE_MODE': settings.mode = value; break;
                case 'PROXY_MODE': settings.proxyMode = value; break;
                case 'TUN_STACK': settings.tunStack = value || 'system'; break;
                case 'AUTO_DETECT_LAN': settings.autoDetectLan = value === 'true'; break;
                case 'AUTO_DETECT_WAN': settings.autoDetectWan = value === 'true'; break;
                case 'BLOCK_QUIC': settings.blockQuic = value === 'true'; break;
                case 'FORCE_DNS_REDIRECT': settings.forceDnsRedirect = value === 'true'; break;
                case 'USE_TMPFS_RULES': settings.useTmpfsRules = value === 'true'; break;
                case 'SHOW_SMART_WEIGHTS': settings.showSmartWeights = value !== 'false'; break;
                case 'DETECTED_LAN': settings.detectedLan = value; break;
                case 'DETECTED_WAN': settings.detectedWan = value; break;
                case 'INCLUDED_INTERFACES':
                    settings.includedInterfaces = value ? value.split(',').map(i => i.trim()) : [];
                    break;
                case 'EXCLUDED_INTERFACES':
                    settings.excludedInterfaces = value ? value.split(',').map(i => i.trim()) : [];
                    break;
                case 'ENABLE_HWID':
                    settings.enableHwid = value === 'true';
                    break;
                case 'HWID_USER_AGENT':
                    settings.hwidUserAgent = value;
                    break;
                case 'HWID_DEVICE_OS':
                    settings.hwidDeviceOS = value;
                    break;
                case 'MIHOMO_RELEASE_REPO':
                    if (/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(value))
                        settings.mihomoReleaseRepo = value;
                    break;
            }
        });

        return settings;
    } catch (e) {
        return {
            mode: 'exclude',
            proxyMode: '',
            tunStack: 'system',
            autoDetectLan: true,
            autoDetectWan: true,
            blockQuic: true,
            forceDnsRedirect: false,
            useTmpfsRules: true,
            showSmartWeights: true,
            detectedLan: '',
            detectedWan: '',
            includedInterfaces: [],
            excludedInterfaces: [],
            enableHwid: false,
            hwidUserAgent: 'ASClash',
            hwidDeviceOS: 'OpenWrt',
            mihomoReleaseRepo: 'MetaCubeX/mihomo'
        };
    }
}

function normalizeDhcpIPv4(value) {
    const parts = String(value || '').trim().split('.');
    if (parts.length !== 4 || parts.some(part => !/^\d{1,3}$/.test(part) || Number(part) > 255))
        return null;
    return parts.map(part => String(Number(part))).join('.');
}

async function getPermanentDhcpDevices() {
    await uci.load('dhcp');
    const byIp = new Map();
    for (const host of uci.sections('dhcp', 'host') || []) {
        if (host.ignore === '1' || host.ignore === 'true') continue;
        const ip = normalizeDhcpIPv4(host.ip);
        const macs = (Array.isArray(host.mac) ? host.mac : [host.mac])
            .map(mac => String(mac || '').trim().toLowerCase())
            .filter(mac => /^(?:[0-9a-f]{2}:){5}[0-9a-f]{2}$/.test(mac));
        if (!ip || !macs.length) continue;

        const item = byIp.get(ip) || { ip, name: '', macs: [] };
        item.name = item.name || String(host.name || '').trim();
        item.macs = [...new Set(item.macs.concat(macs))];
        byIp.set(ip, item);
    }
    return [...byIp.values()].sort((a, b) => a.ip.localeCompare(b.ip, undefined, { numeric: true }));
}

function getManagedDirectIPs(config) {
    const result = new Set();
    for (const line of String(config || '').split(/\r?\n/)) {
        if (!line.includes('# ASCLASH:DEVICE-DIRECT')) continue;
        const rule = line.replace(/#.*/, '').trim();
        const match = rule.match(/^-\s*SRC-IP-CIDR\s*,\s*([^,\s]+)\s*,\s*DIRECT\s*$/i);
        if (!match || !match[1].endsWith('/32')) continue;
        const ip = normalizeDhcpIPv4(match[1].slice(0, -3));
        if (ip) result.add(ip);
    }
    return [...result].sort((a, b) => a.localeCompare(b, undefined, { numeric: true }));
}

function ruleTarget(rule) {
    let depth = 0;
    const commas = [];
    for (let i = 0; i < rule.length; i++) {
        if (rule[i] === '(') depth++;
        else if (rule[i] === ')') depth--;
        else if (rule[i] === ',' && depth === 0) commas.push(i);
    }
    if (!commas.length) return '';
    const actionSeparator = commas.length > 1 ? commas[1] : commas[0];
    return rule.slice(actionSeparator + 1).split(',')[0].trim().replace(/^['"]|['"]$/g, '').toUpperCase();
}

function applyManagedDirectRules(config, selectedIPs) {
    const beginMarker = '  # ASCLASH:DEVICE-DIRECT-BEGIN';
    const endMarker = '  # ASCLASH:DEVICE-DIRECT-END';
    const lines = String(config || '').replace(/\r\n/g, '\n').split('\n');
    let begin = -1;
    let end = -1;
    for (let i = 0; i < lines.length; i++) {
        if (lines[i].trim() === beginMarker.trim()) {
            if (begin !== -1) throw new Error(_('More than one ASClash device-direct block was found.'));
            begin = i;
        } else if (lines[i].trim() === endMarker.trim()) {
            if (end !== -1) throw new Error(_('More than one ASClash device-direct block was found.'));
            end = i;
        }
    }
    if ((begin === -1) !== (end === -1) || (begin !== -1 && end < begin))
        throw new Error(_('The ASClash device-direct block markers are incomplete; repair the marked section in config.yaml before saving.'));
    if (begin !== -1) lines.splice(begin, end - begin + 1);

    // Older builds surrounded generated rules with a comment block. Newer
    // output uses the inline ownership tag on each rule, which is sufficient
    // for safe replacement and keeps the user's rules file uncluttered.
    for (let i = lines.length - 1; i >= 0; i--) {
        if (!lines[i].includes('# ASCLASH:DEVICE-DIRECT')) continue;
        const rule = lines[i].replace(/#.*/, '').trim();
        if (/^-\s*SRC-IP-CIDR\s*,\s*[^,\s]+\s*,\s*DIRECT\s*$/i.test(rule))
            lines.splice(i, 1);
    }

    const ips = [...new Set((selectedIPs || []).map(normalizeDhcpIPv4).filter(Boolean))]
        .sort((a, b) => a.localeCompare(b, undefined, { numeric: true }));
    if (!ips.length) return lines.join('\n');

    const modeLine = lines.find(line => /^mode\s*:/.test(line));
    const configuredMode = modeLine
        ? modeLine.replace(/^mode\s*:\s*/, '').replace(/\s+#.*$/, '').trim().replace(/^['"]|['"]$/g, '').toLowerCase()
        : 'rule';
    if (configuredMode !== 'rule')
        throw new Error(_('Per-device DIRECT requires Mihomo mode: rule; global/direct mode does not apply rules.'));

    const rulesIndex = lines.findIndex(line => /^rules:\s*(?:#.*)?$/.test(line));
    if (rulesIndex === -1) {
        if (lines.some(line => /^rules\s*:/.test(line)))
            throw new Error(_('The rules section uses an unsupported YAML form; add a standalone rules: key before enabling device-direct rules.'));
        const prefix = lines.join('\n').replace(/\n*$/, '\n\n');
        return prefix + ['rules:',
            ...ips.map(ip => `  - SRC-IP-CIDR,${ip}/32,DIRECT # ASCLASH:DEVICE-DIRECT`),
            ''].join('\n');
    }

    let firstRule = -1;
    const leadingPolicyIndices = [];
    let nonRejectSeen = false;
    for (let i = rulesIndex + 1; i < lines.length; i++) {
        if (/^[^\s#][^:]*:/.test(lines[i])) break;
        const match = lines[i].match(/^\s*-\s*(.*)$/);
        if (!match) continue;
        if (firstRule === -1) firstRule = i;
        const target = ruleTarget(match[1].replace(/\s+#.*$/, ''));
        const isReject = target === 'REJECT' || target.startsWith('REJECT-');
        if (isReject) {
            if (nonRejectSeen)
                throw new Error(_('Move all REJECT/REJECT-DROP rules before other routing rules so they retain priority over device DIRECT rules.'));
            leadingPolicyIndices.push(i);
        } else if (target === 'PASS') {
            if (!nonRejectSeen) leadingPolicyIndices.push(i);
        } else {
            nonRejectSeen = true;
        }
    }

    const indent = firstRule === -1 ? '  ' : (lines[firstRule].match(/^\s*/) || ['  '])[0];
    const insertAt = leadingPolicyIndices.length ? leadingPolicyIndices[leadingPolicyIndices.length - 1] + 1 : (firstRule === -1 ? rulesIndex + 1 : firstRule);
    const generatedRules = ips.map(ip => `${indent}- SRC-IP-CIDR,${ip}/32,DIRECT # ASCLASH:DEVICE-DIRECT`);
    lines.splice(insertAt, 0, ...generatedRules);
    return lines.join('\n');
}

function createDeviceDirectSection(dhcpDevices, existingIPs, dhcpAvailable) {
    const container = E('section', {
        'class': 'cbi-section',
        'style': 'margin:12px 0;padding:12px;border:1px solid ' + PANEL_BORDER + ';border-radius:5px;background:' + PANEL_CARD_BG + ';color:' + PANEL_TEXT + ';'
    });
    container.appendChild(E('h3', { 'style': 'margin:0 0 6px;' }, _('Direct routing for reserved DHCP devices')));
    container.appendChild(E('p', { 'class': 'cbi-section-descr', 'style': 'margin:0 0 10px;' },
        _('Selected traffic still passes through Mihomo and uses DIRECT, preserving Fake-IP. Applies only on ASClash-processed interfaces; earlier REJECT/PASS rules and enabled QUIC blocking take priority.')));

    if (!dhcpAvailable) {
        container.appendChild(E('p', { 'style': 'color:#b42336;margin:0;' },
            _('Could not read DHCP reservations. Existing managed rules will be preserved; device selection is unavailable.')));
        return { element: container, getSelectedDevices: function() { return null; } };
    }

    const byIp = new Map(dhcpDevices.map(device => [device.ip, device]));
    const devices = dhcpDevices.slice();
    devices.sort((a, b) => a.ip.localeCompare(b.ip, undefined, { numeric: true }));
    const staleIPs = existingIPs.filter(ip => !byIp.has(ip));
    if (staleIPs.length) {
        container.appendChild(E('p', { 'style': 'color:#b7791f;margin:0 0 8px;' },
            _('These generated rules have no matching permanent DHCP reservation and will be removed when settings are saved: %s').format(staleIPs.join(', '))));
    }

    const selectedDevices = new Map();
    if (!devices.length) {
        container.appendChild(E('p', { 'style': 'margin:0;' }, _('No permanent IPv4 DHCP reservations with MAC addresses were found.')));
    } else {
        const deviceByIP = new Map(devices.map(device => [device.ip, device]));
        for (const ip of existingIPs) {
            const device = deviceByIP.get(ip);
            if (device) selectedDevices.set(ip, device);
        }

        const deviceSelect = E('select', {
            'class': 'cbi-input-select',
            'style': 'min-width:260px;max-width:100%;'
        });
        const selectedList = E('div', {
            'style': 'display:flex;flex-wrap:wrap;gap:6px;margin-top:8px;'
        });
        const addButton = E('button', {
            'class': 'btn',
            'type': 'button',
            'click': function() {
                const device = deviceByIP.get(deviceSelect.value);
                if (!device || selectedDevices.has(device.ip)) return;
                selectedDevices.set(device.ip, device);
                renderDeviceOptions();
                renderSelectedDevices();
            }
        }, _('Add device'));

        function renderDeviceOptions() {
            const options = [E('option', { 'value': '' }, _('Select a device…'))];
            for (const device of devices) {
                if (selectedDevices.has(device.ip)) continue;
                const label = device.name ? `${device.name} — ${device.ip}` : device.ip;
                options.push(E('option', { 'value': device.ip }, label));
            }
            deviceSelect.replaceChildren(...options);
            addButton.disabled = options.length === 1;
        }

        function renderSelectedDevices() {
            const rows = [...selectedDevices.values()].map(device => {
                const removeButton = E('button', {
                    'class': 'btn',
                    'type': 'button',
                    'title': _('Remove'),
                    'aria-label': _('Remove'),
                    'style': 'padding:2px 7px;margin-left:8px;line-height:18px;',
                    'click': function() {
                        selectedDevices.delete(device.ip);
                        renderDeviceOptions();
                        renderSelectedDevices();
                    }
                }, '×');
                return E('div', {
                    'style': 'display:flex;align-items:center;padding:5px 8px;border:1px solid ' + PANEL_BORDER_ITEM + ';border-radius:4px;background:' + PANEL_ITEM_BG + ';color:' + PANEL_TEXT + ';'
                }, [
                    E('span', {}, [
                        E('strong', {}, device.name || _('Unnamed device')),
                        E('small', { 'style': 'margin-left:6px;' }, `${device.ip} · ${device.macs.join(', ')}`)
                    ]),
                    removeButton
                ]);
            });
            if (!rows.length) rows.push(E('small', { 'style': 'color:' + PANEL_MUTED_TEXT + ';' }, _('No devices selected.')));
            selectedList.replaceChildren(...rows);
        }

        renderDeviceOptions();
        renderSelectedDevices();
        container.appendChild(E('div', { 'style': 'display:flex;align-items:center;gap:8px;flex-wrap:wrap;' }, [deviceSelect, addButton]));
        container.appendChild(selectedList);
    }

    return {
        element: container,
        getSelectedDevices: function() {
            return [...selectedDevices.values()];
        }
    };
}

async function loadInterfacesByMode(mode) {
    try {
        const settings = await loadSettings();
        const manualList = mode === 'explicit' ? settings.includedInterfaces : settings.excludedInterfaces;
        const detectedInterface = mode === 'explicit' ? settings.detectedLan : settings.detectedWan;

        const allInterfaces = [...manualList];
        if (detectedInterface && !allInterfaces.includes(detectedInterface)) {
            allInterfaces.push(detectedInterface);
        }

        return allInterfaces;
    } catch (e) {
        return [];
    }
}

async function saveSettings(mode, proxyMode, tunStack, autoDetectLan, autoDetectWan, blockQuic, forceDnsRedirect, useTmpfsRules, showSmartWeights, interfaces, enableHwid, hwidUserAgent, hwidDeviceOS, mihomoReleaseRepo, managedDirectIPs) {
    try {
        let detectedLan = '';
        let detectedWan = '';

        if (autoDetectLan) {
            detectedLan = await detectLanBridge() || '';
        }

        if (autoDetectWan) {
            detectedWan = await detectWanInterface() || '';
        }

        let cleanInterfaces = interfaces.slice();

        if (mode === 'explicit' && autoDetectLan && detectedLan) {
            cleanInterfaces = cleanInterfaces.filter(iface => iface !== detectedLan);
        } else if (mode === 'exclude' && autoDetectWan && detectedWan) {
            cleanInterfaces = cleanInterfaces.filter(iface => iface !== detectedWan);
        }

        const includedInterfaces = mode === 'explicit' ? cleanInterfaces : [];
        const excludedInterfaces = mode === 'exclude' ? cleanInterfaces : [];

        const settingsContent = `INTERFACE_MODE=${mode}
PROXY_MODE=${proxyMode}
TUN_STACK=${tunStack}
AUTO_DETECT_LAN=${autoDetectLan}
AUTO_DETECT_WAN=${autoDetectWan}
BLOCK_QUIC=${blockQuic}
FORCE_DNS_REDIRECT=${forceDnsRedirect}
USE_TMPFS_RULES=${useTmpfsRules}
SHOW_SMART_WEIGHTS=${showSmartWeights}
DETECTED_LAN=${detectedLan}
DETECTED_WAN=${detectedWan}
INCLUDED_INTERFACES=${includedInterfaces.join(',')}
EXCLUDED_INTERFACES=${excludedInterfaces.join(',')}
ENABLE_HWID=${enableHwid}
HWID_USER_AGENT=${hwidUserAgent}
HWID_DEVICE_OS=${hwidDeviceOS}
MIHOMO_RELEASE_REPO=${mihomoReleaseRepo || 'MetaCubeX/mihomo'}
`;

        const previousSettings = await L.resolveDefault(fs.read('/opt/clash/settings'), '');
        let configStage = null;
        const configContent = await L.resolveDefault(fs.read('/opt/clash/config.yaml'), '');
        const previousConfig = configContent;
        if (Array.isArray(managedDirectIPs) && managedDirectIPs.length && !configContent)
            throw new Error(_('Cannot add device-direct rules because config.yaml is empty.'));
        if (configContent) {
            let updatedConfig = transformProxyMode(configContent, proxyMode, tunStack);

            if (enableHwid) {
                const hwidValues = await getHwidValues();
                updatedConfig = addHwidToYaml(
                    updatedConfig,
                    hwidUserAgent,
                    hwidDeviceOS,
                    hwidValues.hwid,
                    hwidValues.verOs,
                    hwidValues.deviceModel
                );
            }

            if (Array.isArray(managedDirectIPs)) {
                updatedConfig = applyManagedDirectRules(updatedConfig, managedDirectIPs);
            }

            configStage = await view_asclash_utils.stageValidatedConfig(updatedConfig);
            if (!configStage.ok) {
                ui.addNotification(null, E('div', {}, [
                    E('p', _('Updated Clash configuration failed validation; settings were not saved.')),
                    E('pre', {
                        'style': 'margin:6px 0 0;padding:0 0 0 10px;font-size:11px;line-height:1.45;font-family:monospace;white-space:pre-wrap;word-break:break-word;max-height:280px;overflow:auto;background:none;border:0;border-left:2px solid rgba(0,0,0,0.18);'
                    }, configStage.detail || _('unknown error'))
                ]), 'error');
                return false;
            }
        }

        try {
            await view_asclash_utils.writeFileAtomic('/opt/clash/settings', settingsContent);
            if (configStage)
                await view_asclash_utils.commitStagedConfig(configStage.path);
        } catch (e) {
            if (configStage)
                await view_asclash_utils.discardStagedConfig(configStage.path);
            if (configStage && previousConfig !== null) {
                try {
                    await view_asclash_utils.writeFileAtomic('/opt/clash/config.yaml', previousConfig);
                } catch (rollbackError) {
                    e.message += '; ' + _('Failed to restore previous config.yaml: %s').format(rollbackError.message || String(rollbackError));
                }
            }
            try {
                await view_asclash_utils.writeFileAtomic('/opt/clash/settings', previousSettings);
            } catch (rollbackError) {
                e.message += '; failed to restore previous settings: ' + (rollbackError.message || String(rollbackError));
            }
            throw e;
        }

        ui.addNotification(null, E('p', _('Settings saved. Please restart the Clash service for changes to take effect.')), 'info');
        return true;
    } catch (e) {
        ui.addNotification(null, E('p', _('Failed to save settings: %s').format(e.message)), 'error');
        return false;
    }
}

// =============================================================================
// SECTION: System detection — LAN/WAN interfaces and CPU architecture
// =============================================================================

async function detectLanBridge() {
    try {
        try {
            const networks = await network.getNetworks();
            for (const net of networks) {
                if (net.getName() === 'lan') {
                    const device = net.getL3Device();
                    if (device && device.getName() && device.isUp()) {
                        return device.getName();
                    }
                }
            }
        } catch (e) {
            console.warn('UCI network detection failed, using fallback:', e.message);
        }

        try {
            const ipResult = await fs.exec('ip', ['addr', 'show']);
            if (ipResult.code === 0 && ipResult.stdout) {
                const lines = ipResult.stdout.split('\n');
                let currentInterface = '';

                for (const line of lines) {
                    const ifaceMatch = line.match(/^\d+:\s+([^:@]+):/);
                    if (ifaceMatch) {
                        currentInterface = ifaceMatch[1];
                        continue;
                    }

                    const ipMatch = line.match(/inet\s+(\d+\.\d+\.\d+\.\d+)/);
                    if (ipMatch && currentInterface && currentInterface !== 'lo') {
                        const ip = ipMatch[1];
                        if (ip.match(/^192\.168\.|^10\.|^172\.(1[6-9]|2[0-9]|3[01])\./)) {
                            if (currentInterface.match(/^(br-|bridge)/) ||
                                currentInterface === 'lan') {
                                return currentInterface;
                            }
                        }
                    }
                }
            }
        } catch (e) {
            console.error('Failed to detect LAN bridge via ip command:', e);
        }

        return null;
    } catch (e) {
        console.error(_('Failed to detect LAN bridge:'), e);
        return null;
    }
}

async function detectWanInterface() {
    try {
        try {
            const networks = await network.getNetworks();
            for (const net of networks) {
                if (net.getName() === 'wan' || net.getName() === 'wan6') {
                    const device = net.getL3Device();
                    if (device && device.getName()) {
                        return device.getName();
                    }
                }
            }
        } catch (e) {
            console.warn('UCI WAN detection failed, using fallback:', e.message);
        }

        try {
            const routeContent = await L.resolveDefault(fs.read('/proc/net/route'), '');
            const lines = routeContent.split('\n');
            for (const line of lines) {
                const fields = line.split('\t');
                if (fields[1] === '00000000' && fields[0] !== 'Iface') {
                    return fields[0];
                }
            }
        } catch (e) {
            console.error(_('Failed to read route table:'), e);
        }

        return null;
    } catch (e) {
        console.error(_('Failed to detect WAN interface:'), e);
        return null;
    }
}

async function detectSystemArchitecture() {
    try {
        const releaseInfo = await L.resolveDefault(fs.read('/etc/openwrt_release'), null);
        let distribArch = '';

        if (releaseInfo) {
            const match = releaseInfo.match(/^DISTRIB_ARCH='([^']*)'/m);
            if (match && match[1]) {
                distribArch = match[1];
            }
        }

        if (distribArch) {
            if (distribArch.startsWith('aarch64_')) return 'arm64';
            if (distribArch === 'x86_64') return 'amd64';
            if (distribArch.startsWith('i386_')) return '386';
            if (distribArch.startsWith('riscv64_')) return 'riscv64';
            if (distribArch.startsWith('loongarch64_')) return 'loong64';

            // 32-bit Cortex-A cores (a5/a7/a8/a9/a15/a17) are all ARMv7-A, so
            // map them to armv7 first — otherwise e.g. arm_cortex-a9_vfpv3
            // would fall through to the _vfp check and pick a slower armv6 build.
            if (distribArch.startsWith('arm_') && distribArch.includes('cortex-a')) return 'armv7';
            if (distribArch.includes('_neon-vfp')) return 'armv7';
            if (distribArch.includes('_neon') || distribArch.includes('_vfp')) return 'armv6';
            if (distribArch.startsWith('arm_')) return 'armv5';

            if (distribArch.startsWith('mips64el_')) return 'mips64le';
            if (distribArch.startsWith('mips64_')) return 'mips64';
            if (distribArch.startsWith('mipsel_')) {
                if (distribArch.includes('hardfloat')) return 'mipsle-hardfloat';
                return 'mipsle-softfloat';
            }
            if (distribArch.startsWith('mips_')) {
                if (distribArch.includes('hardfloat')) return 'mips-hardfloat';
                return 'mips-softfloat';
            }
        }
    } catch (e) {
        console.error('Failed to read /etc/openwrt_release or parse architecture.', e.message);
    }

    ui.addNotification(null, E('p', 'Could not determine system architecture from /etc/openwrt_release. This might not be a standard OpenWrt system. Falling back to default: amd64.'), 'error');
    return 'amd64';
}

function getDownloadArch(arch) {
    return arch === 'amd64' ? 'amd64-compatible' : arch;
}

// =============================================================================
// SECTION: Mihomo kernel management — version check, download
// =============================================================================

const OFFICIAL_MIHOMO_REPO = 'MetaCubeX/mihomo';
const DEFAULT_CUSTOM_MIHOMO_REPO = 'legiz-ru/Prizrak-Core';
let activeMihomoReleaseRepo = OFFICIAL_MIHOMO_REPO;

async function getLatestMihomoRelease(repo = activeMihomoReleaseRepo) {
    try {
        if (!/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(repo))
            throw new Error(_('Invalid GitHub repository. Use owner/repository format.'));
        const response = await fetch(`https://api.github.com/repos/${repo}/releases/latest`, {
            headers: { 'Accept': 'application/vnd.github+json' }
        });
        if (!response.ok) {
            throw new Error(_('HTTP %d: %s').format(response.status, response.statusText));
        }
        const data = await response.json();
        if (data.prerelease) {
            throw new Error(_('Latest release is a pre-release'));
        }
        return { version: data.tag_name, assets: data.assets || [], repo };
    } catch (e) {
        console.error(_('Failed to get latest release:'), e);
        return null;
    }
}

function findMihomoReleaseAsset(release, arch) {
    if (!release || !Array.isArray(release.assets)) return null;
    const repo = (release.repo || OFFICIAL_MIHOMO_REPO).toLowerCase();
    const version = release.version;
    if (repo === OFFICIAL_MIHOMO_REPO.toLowerCase()) {
        const name = `mihomo-linux-${arch}-${version}.gz`;
        return release.assets.find(asset => asset.name === name) || null;
    }

    const archCandidates = {
        'amd64-compatible': ['amd64-v1', 'amd64-compatible'],
        amd64: ['amd64-v1', 'amd64-compatible'],
        arm64: ['arm64'], armv7: ['armv7'], armv6: ['armv6'], armv5: ['armv5'],
        'mips-softfloat': ['mips-softfloat'], 'mips-hardfloat': ['mips-hardfloat'],
        'mipsle-softfloat': ['mipsle-softfloat'], 'mipsle-hardfloat': ['mipsle-hardfloat'],
        mips64: ['mips64'], mips64le: ['mips64le'], riscv64: ['riscv64'], loong64: ['loong64']
    }[arch] || [arch];
    const ownerRepo = repo.split('/')[1].toLowerCase();

    for (const candidateArch of archCandidates) {
        const exactNames = [
            `${ownerRepo}-linux-${candidateArch}-${version}.gz`,
            `mihomo-linux-${candidateArch}-${version}.gz`
        ];
        const exact = release.assets.find(asset => exactNames.includes(asset.name));
        if (exact) return exact;

        // Support custom repositories that use a project-specific binary
        // prefix, while requiring an exact Linux architecture/version suffix.
        const suffix = `-linux-${candidateArch}-${version}.gz`;
        const matches = release.assets.filter(asset =>
            asset.name.endsWith(suffix) && !asset.name.toLowerCase().includes('compressed')
        );
        if (matches.length === 1) return matches[0];
    }
    return null;
}

async function persistMihomoReleaseRepo(repo) {
    if (!/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(repo))
        throw new Error(_('Invalid GitHub repository. Use owner/repository format.'));
    const current = await L.resolveDefault(fs.read('/opt/clash/settings'), '');
    const lines = current.split(/\r?\n/).filter(line => !/^MIHOMO_RELEASE_REPO=/.test(line));
    lines.push(`MIHOMO_RELEASE_REPO=${repo}`);
    await fs.write('/opt/clash/settings', lines.filter((line, index, all) => line || index < all.length - 1).join('\n') + '\n');
}

function normalizeVersion(str) {
    if (!str) return '';
    const match = str.trim().match(/v?(\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?)/);
    return match ? match[1] : str.trim().replace(/^v/i, '');
}

async function getMihomoStatus() {
    try {
        const binPath = '/opt/clash/bin/clash';
        const stat = await L.resolveDefault(fs.stat(binPath), null);
        if (!stat) {
            return { installed: false, version: null };
        }

        try {
            const result = await fs.exec(binPath, ['-v']);
            let output = '';
            if (result && typeof result === 'object') {
                output = result.stdout || result.stderr || '';
            } else if (typeof result === 'string') {
                output = result;
            }

            if (output && output.trim()) {
                const patterns = [
                    /Mihomo\s+Meta\s+(v\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?)/i,
                    /Mihomo\s+[^v]*?(v\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?)/i,
                    /(v\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?)/i
                ];

                for (const pattern of patterns) {
                    const match = output.match(pattern);
                    if (match && match[1]) {
                        return { installed: true, version: match[1] };
                    }
                }

                if (output.toLowerCase().includes('mihomo')) {
                    const firstLine = output.split('\n')[0].trim();
                    if (firstLine.length < 100) {
                        return { installed: true, version: firstLine };
                    }
                    return { installed: true, version: _('Mihomo (version detected)') };
                }
            }
        } catch (execError) {}

        const size = Math.round(stat.size / 1024 / 1024);
        return { installed: true, version: _('Installed (%dMB)').format(size) };
    } catch (e) {
        return { installed: false, version: null };
    }
}

async function downloadMihomoKernel(downloadUrl, version, arch) {
    try {
        ui.addNotification(null, E('p', _('Downloading mihomo kernel...')), 'info');

        const fileName = `mihomo-linux-${arch}-${version}.gz`;
        const downloadPath = `/tmp/${fileName}`;
        const extractedFile = downloadPath.replace('.gz', '');
        const targetFile = '/opt/clash/bin/clash';

        await fs.exec('rm', ['-f', downloadPath, extractedFile]).catch(function() {});

        const curlResult = await fs.exec('curl', ['-fL', '--retry', '2', '--connect-timeout', '15', '--max-time', '300', downloadUrl, '-o', downloadPath]);
        if (curlResult.code !== 0) {
            throw new Error(_('Download failed: %s').format((curlResult.stderr || '').trim() || _('unknown error')));
        }

        const extractResult = await fs.exec('gzip', ['-df', downloadPath]);
        if (extractResult.code !== 0) {
            throw new Error(_('Extraction failed: %s').format((extractResult.stderr || '').trim() || _('unknown error')));
        }

        await fs.exec('/etc/init.d/clash', ['stop']).catch(function() {});

        const mvResult = await fs.exec('mv', ['-f', extractedFile, targetFile]);
        if (mvResult.code !== 0) {
            throw new Error(_('Failed to install new binary: %s').format((mvResult.stderr || '').trim() || _('unknown error')));
        }

        const chmodResult = await fs.exec('chmod', ['0755', targetFile]);
        if (chmodResult.code !== 0) {
            throw new Error(_('Failed to set executable permissions: %s').format((chmodResult.stderr || '').trim() || _('unknown error')));
        }

        // Verify with the binary itself
        const verifyResult = await fs.exec(targetFile, ['-v']);
        if (verifyResult.code !== 0) {
            let currentMode = '';
            try {
                const st = await L.resolveDefault(fs.stat(targetFile), null);
                if (st && st.mode != null) {
                    currentMode = (st.mode & 511).toString(8);
                }
            } catch (_e) {}

            ui.addNotification(null, E('p',
                _('WARNING: Binary at %s is not executable after chmod (mode: %s). Check filesystem permissions, then manually run: chmod 0755 %s')
                .format(targetFile, currentMode || _('unknown'), targetFile)
            ), 'warning');
            return false;
        }

        ui.addNotification(null, E('p',
            _('Mihomo kernel installed successfully. The service was stopped for a safe replacement — press "Restart Service" to activate the new kernel.')
        ), 'info');
        return true;
    } catch (e) {
        ui.addNotification(null, E('p', _('Failed to download mihomo kernel: %s').format(e.message)), 'error');
        return false;
    }
}

let updateKernelStatusFn = null;

function createKernelDownloadSection(releaseRepo = OFFICIAL_MIHOMO_REPO, onRepoSaved = null) {
    const container = E('div', { 'class': 'cbi-section' });
    activeMihomoReleaseRepo = /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(releaseRepo) ? releaseRepo : OFFICIAL_MIHOMO_REPO;
    const uiLang = String((L.env && L.env.lang) || document.documentElement.lang || navigator.language || '').toLowerCase();
    const isRussianUi = uiLang.startsWith('ru');

    container.appendChild(E('h2', _('Mihomo Kernel Management')));
    container.appendChild(E('div', { 'class': 'cbi-section-descr' },
        _('Download and manage the Mihomo (Clash Meta) kernel binary.')));

    const sourceSelect = E('select', { 'class': 'cbi-input-select', 'style': 'min-width: 190px;' }, [
        E('option', { 'value': 'official' }, isRussianUi ? 'Официальный Mihomo' : _('Official Mihomo')),
        E('option', { 'value': 'custom' }, isRussianUi ? 'Свой релиз GitHub' : _('Custom GitHub release'))
    ]);
    const customRepoInput = E('input', {
        'type': 'text', 'class': 'cbi-input-text', 'placeholder': 'legiz-ru/Prizrak-Core',
        'style': 'min-width: 230px;'
    });
    const saveSourceButton = E('button', { 'class': 'btn' }, isRussianUi ? 'Сохранить источник' : _('Save release source'));
    const sourceIsOfficial = activeMihomoReleaseRepo.toLowerCase() === OFFICIAL_MIHOMO_REPO.toLowerCase();
    sourceSelect.value = sourceIsOfficial ? 'official' : 'custom';
    customRepoInput.value = sourceIsOfficial ? DEFAULT_CUSTOM_MIHOMO_REPO : activeMihomoReleaseRepo;
    customRepoInput.style.display = sourceIsOfficial ? 'none' : '';
    sourceSelect.addEventListener('change', () => {
        customRepoInput.style.display = sourceSelect.value === 'custom' ? '' : 'none';
    });
    saveSourceButton.addEventListener('click', async () => {
        const repo = sourceSelect.value === 'official' ? OFFICIAL_MIHOMO_REPO : customRepoInput.value.trim();
        if (!/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(repo)) {
            ui.addNotification(null, E('p', isRussianUi ? 'Укажите GitHub-репозиторий в формате владелец/репозиторий.' : _('Enter a GitHub repository as owner/repository.')), 'error');
            return;
        }
        saveSourceButton.disabled = true;
        try {
            await persistMihomoReleaseRepo(repo);
            activeMihomoReleaseRepo = repo;
            if (onRepoSaved) onRepoSaved(repo);
            ui.addNotification(null, E('p', isRussianUi ? `Источник релизов сохранён: ${repo}` : _('Release source saved: %s').format(repo)), 'success');
            if (updateKernelStatusFn) await updateKernelStatusFn();
        } catch (e) {
            ui.addNotification(null, E('p', isRussianUi ? `Не удалось сохранить источник релизов: ${e.message}` : _('Failed to save release source: %s').format(e.message)), 'error');
        } finally {
            saveSourceButton.disabled = false;
        }
    });
    container.appendChild(E('div', { 'class': 'cbi-value', 'style': 'display: flex; align-items: center; gap: 8px; flex-wrap: wrap; margin: 12px 0;' }, [
        E('label', { 'class': 'cbi-value-title', 'style': 'width: auto;' }, isRussianUi ? 'Источник релизов' : _('Release source')),
        sourceSelect,
        customRepoInput,
        saveSourceButton
    ]));

    const statusContainer = E('div', {
        'id': 'kernel-status',
        'style': 'margin: 15px 0; padding: 12px; border: 1px solid ' + PANEL_BORDER + '; border-radius: 4px; background: ' + PANEL_CARD_BG + '; color: ' + PANEL_TEXT + ';'
    });

    container.appendChild(statusContainer);

    async function updateKernelStatus() {
        const statusElement = document.getElementById('kernel-status');
        const downloadButton = document.getElementById('download-kernel-btn');
        if (downloadButton) {
            downloadButton.disabled = true;
            downloadButton.textContent = _('Checking...');
        }

        try {
            const [status, arch, release] = await Promise.all([
                getMihomoStatus(),
                detectSystemArchitecture(),
                getLatestMihomoRelease(activeMihomoReleaseRepo)
            ]);

            let statusHTML = '';
            if (status.installed) {
                statusHTML += `<div style="color: #28a745; font-weight: bold;">✅ ${_('Kernel Status')}: ${_('Installed')}</div>`;
                statusHTML += `<div style="margin-top: 5px;">📦 ${_('Version')}: ${status.version}</div>`;
            } else {
                statusHTML += `<div style="color: #dc3545; font-weight: bold;">❌ ${_('Kernel Status')}: ${_('Not Installed')}</div>`;
                statusHTML += `<div style="margin-top: 5px; color: ${PANEL_MUTED_TEXT};">${_('Mihomo kernel binary not found')}</div>`;
            }

            statusHTML += `<div style="margin-top: 5px;">🏗️ ${_('System Architecture')}: ${arch}</div>`;

            if (release) {
                if (downloadButton) downloadButton.disabled = false;

                statusHTML += `<div style="margin-top: 5px;">🚀 ${_('Latest Available')}: ${release.version}</div>`;

                const localVer = normalizeVersion(status.version);
                const latestVer = normalizeVersion(release.version);

                if (status.installed && localVer !== latestVer) {
                    statusHTML += `<div style="margin-top: 5px; color: #ffc107; font-weight: bold;">⚠️ ${_('Update Available')}</div>`;
                    if (downloadButton) downloadButton.textContent = _('Download Update');
                } else if (status.installed) {
                    statusHTML += `<div style="margin-top: 5px; color: #28a745;">✨ ${_('Kernel is up to date')}</div>`;
                    if (downloadButton) downloadButton.textContent = _('Reinstall Kernel');
                } else {
                    if (downloadButton) downloadButton.textContent = _('Download Latest Kernel');
                }
            } else {
                statusHTML += `<div style="margin-top: 5px; color: #dc3545;">❌ ${_('Failed to check latest version')}</div>`;
                if (downloadButton) {
                    downloadButton.disabled = true;
                    if (status.installed) {
                        downloadButton.textContent = _('Reinstall Kernel');
                    } else {
                        downloadButton.textContent = _('Download Latest Kernel');
                    }
                }
            }

            statusElement.innerHTML = statusHTML;
        } catch (e) {
            statusElement.innerHTML = `<div style="color: #dc3545;">❌ ${_('Error checking status')}: ${e.message}</div>`;
            if (downloadButton) {
                downloadButton.disabled = true;
                downloadButton.textContent = _('Download Latest Kernel');
            }
            console.error(_('Failed to update kernel status:'), e);
        }
    }

    updateKernelStatusFn = updateKernelStatus;
    setTimeout(updateKernelStatus, 100);

    return container;
}

// =============================================================================
// SECTION: UI component builders
// =============================================================================

let PANEL_TEXT = '#1f2937';
let PANEL_MUTED_TEXT = '#4b5563';
let PANEL_INPUT_STYLE = 'background: #fff; color: #1f2937; border-color: #93c5fd;';
let PANEL_CARD_BG = '#f9f9f9';
let PANEL_ITEM_BG = 'white';
let PANEL_SEL_BG = '#f0f8ff';
let PANEL_AUTO_BG = '#f8fff8';
let PANEL_CHK_BG = '#e6f3ff';
let PANEL_BORDER = '#ddd';
let PANEL_BORDER_ITEM = '#ccc';
let PANEL_STATUS_BG = '#f8f9fa';
let PANEL_STATUS_GREEN = '#e8f5e8';
let PANEL_STATUS_WARN = '#fff3cd';
let PANEL_STATUS_TEXT_GREEN = '#155724';
let PANEL_STATUS_TEXT_WARN = '#856404';

function createModeSelector(currentMode) {
    const container = E('div', { 'class': 'cbi-section' });

    container.appendChild(E('h2', _('Interface Processing Mode')));
    container.appendChild(E('div', { 'class': 'cbi-section-descr' },
        _('Choose how to handle network interfaces for proxy processing.')));

    const modeContainer = E('div', { 'style': 'margin: 15px 0;' });

    const excludeRadio = E('input', {
        'type': 'radio', 'id': 'mode_exclude', 'name': 'interface_mode', 'value': 'exclude'
    });

    const excludeLabel = E('label', {
        'for': 'mode_exclude',
        'style': 'display: block; padding: 12px; border: 2px solid ' + PANEL_BORDER + '; border-radius: 6px; margin-bottom: 10px; cursor: pointer; background: ' + PANEL_ITEM_BG + '; color: ' + PANEL_TEXT + ';'
    }, [
        E('div', { 'style': 'display: flex; align-items: flex-start; gap: 10px;' }, [
            excludeRadio,
            E('div', {}, [
                E('strong', { 'style': 'display: block; margin-bottom: 5px;' },
                    '⭕ ' + _('Exclude Mode (Universal approach)')),
                E('div', { 'style': 'color: ' + PANEL_MUTED_TEXT + '; font-size: 13px; line-height: 1.4;' },
                    _('Process traffic from ALL interfaces except selected ones. Automatically detects and excludes WAN. Recommended for most users.'))
            ])
        ])
    ]);

    const explicitRadio = E('input', {
        'type': 'radio', 'id': 'mode_explicit', 'name': 'interface_mode', 'value': 'explicit'
    });

    const explicitLabel = E('label', {
        'for': 'mode_explicit',
        'style': 'display: block; padding: 12px; border: 2px solid ' + PANEL_BORDER + '; border-radius: 6px; cursor: pointer; background: ' + PANEL_ITEM_BG + '; color: ' + PANEL_TEXT + ';'
    }, [
        E('div', { 'style': 'display: flex; align-items: flex-start; gap: 10px;' }, [
            explicitRadio,
            E('div', {}, [
                E('strong', { 'style': 'display: block; margin-bottom: 5px;' },
                    '🎯 ' + _('Explicit Mode (Precise control)')),
                E('div', { 'style': 'color: ' + PANEL_MUTED_TEXT + '; font-size: 13px; line-height: 1.4;' },
                    _('Process traffic ONLY from selected interfaces. More secure but requires manual configuration. Recommended for advanced users.'))
            ])
        ])
    ]);

    setTimeout(() => {
        if (currentMode === 'explicit') {
            explicitRadio.checked = true;
        } else {
            excludeRadio.checked = true;
        }
        updateLabels();
    }, 0);

    function updateLabels() {
        if (excludeRadio.checked) {
            excludeLabel.style.borderColor = '#0066cc';
            excludeLabel.style.backgroundColor = PANEL_SEL_BG;
            excludeLabel.style.color = PANEL_TEXT;
            explicitLabel.style.borderColor = PANEL_BORDER;
            explicitLabel.style.backgroundColor = PANEL_ITEM_BG;
            explicitLabel.style.color = PANEL_TEXT;
        } else if (explicitRadio.checked) {
            explicitLabel.style.borderColor = '#0066cc';
            explicitLabel.style.backgroundColor = PANEL_SEL_BG;
            explicitLabel.style.color = PANEL_TEXT;
            excludeLabel.style.borderColor = PANEL_BORDER;
            excludeLabel.style.backgroundColor = PANEL_ITEM_BG;
            excludeLabel.style.color = PANEL_TEXT;
        }
    }

    excludeRadio.addEventListener('change', updateLabels);
    explicitRadio.addEventListener('change', updateLabels);

    modeContainer.appendChild(excludeLabel);
    modeContainer.appendChild(explicitLabel);
    container.appendChild(modeContainer);

    return container;
}

function createProxyModeSection(currentProxyMode) {
    const container = E('div', { 'class': 'cbi-section' });

    container.appendChild(E('h3', _('Proxy Mode')));
    container.appendChild(E('div', { 'class': 'cbi-section-descr' },
        _('Choose how traffic is redirected to Clash: TPROXY (all traffic), TUN (all traffic via virtual interface), or MIXED (TCP via TPROXY, UDP via TUN — best for gaming).')
    ));

    const fieldContainer = E('div', { 'style': 'margin: 10px 0;' });

    const select = E('select', {
        'class': 'cbi-input-select',
        'id': 'proxy-mode-select'
    }, [
        E('option', { 'value': 'tproxy' }, 'TPROXY'),
        E('option', { 'value': 'tun' }, 'TUN'),
        E('option', { 'value': 'mixed' }, 'MIXED (TCP+UDP)')
    ]);

    const hint = E('div', {
        'id': 'proxy-mode-hint',
        'style': 'margin-top: 8px; padding: 10px; border-left: 3px solid #777; border-radius: 3px; font-size: 12px; background: ' + PANEL_CARD_BG + '; color: ' + PANEL_TEXT + ';'
    });

    function updateHint() {
        const value = select.value;
        hint.innerHTML = '';
        if (value === 'tproxy') {
            hint.style.borderLeftColor = '#0066cc';
            hint.appendChild(E('strong', {}, 'TPROXY: '));
            hint.appendChild(document.createTextNode(
                _('Transparent proxy mode. Routes both TCP and UDP through TPROXY port 7894. Best compatibility, requires kernel TPROXY support.')
            ));
        } else if (value === 'tun') {
            hint.style.borderLeftColor = '#28a745';
            hint.appendChild(E('strong', {}, 'TUN: '));
            hint.appendChild(document.createTextNode(
                _('TUN interface mode. Creates virtual network interface for all traffic. Better performance, works without TPROXY. Requires TUN kernel module.')
            ));
        } else {
            hint.style.borderLeftColor = '#ff9900';
            hint.appendChild(E('strong', {}, 'MIXED: '));
            hint.appendChild(document.createTextNode(
                _('Hybrid mode (best for gaming). TCP via TPROXY (stable), UDP via TUN (low latency). Optimal for online games requiring fast UDP.')
            ));
        }
    }

    fieldContainer.appendChild(select);
    fieldContainer.appendChild(hint);
    container.appendChild(fieldContainer);

    setTimeout(function() {
        select.value = currentProxyMode || 'tproxy';
        updateHint();
        select.dispatchEvent(new Event('change'));
    }, 0);

    select.addEventListener('change', updateHint);

    return container;
}

function createTunStackSection(currentTunStack) {
    const container = E('div', {
        'id': 'tun-stack-container',
        'class': 'cbi-section'
    });

    container.appendChild(E('h3', _('TUN Stack')));
    container.appendChild(E('div', { 'class': 'cbi-section-descr' },
        _('Choose Mihomo TUN stack. `system` is fastest but depends on kernel capabilities; `gvisor` is more compatible; `mixed` combines both.')
    ));

    const select = E('select', {
        'class': 'cbi-input-select',
        'id': 'tun-stack-select'
    }, [
        E('option', { 'value': 'system' }, 'system'),
        E('option', { 'value': 'gvisor' }, 'gvisor'),
        E('option', { 'value': 'mixed' }, 'mixed')
    ]);

    const hint = E('div', {
        'id': 'tun-stack-hint',
        'style': 'margin-top: 8px; padding: 8px; background: ' + PANEL_CARD_BG + '; border-left: 3px solid #777; border-radius: 3px; font-size: 12px; color: ' + PANEL_TEXT + ';'
    });

    function updateHint() {
        const value = select.value;
        if (value === 'system') {
            hint.textContent = _('system: kernel network stack. If TCP in TUN fails on your device, try gvisor.');
            hint.style.borderLeftColor = '#0066cc';
        } else if (value === 'gvisor') {
            hint.textContent = _('gvisor: userspace stack, usually most compatible across routers.');
            hint.style.borderLeftColor = '#28a745';
        } else {
            hint.textContent = _('mixed: hybrid stack mode supported by some Mihomo builds.');
            hint.style.borderLeftColor = '#ff9900';
        }
    }

    const effectiveStack = ['system', 'gvisor', 'mixed'].includes(currentTunStack) ? currentTunStack : 'system';
    setTimeout(() => {
        select.value = effectiveStack;
        updateHint();
    }, 0);
    select.addEventListener('change', updateHint);

    container.appendChild(E('div', { 'style': 'margin: 10px 0;' }, [select, hint]));
    return container;
}

function createAutoDetectOptions(currentMode, autoDetectLan, autoDetectWan) {
    const container = E('div', {
        'id': 'auto-detect-container',
        'class': 'cbi-section'
    });

    container.appendChild(E('h3', _('Automatic Interface Detection')));

    const optionsContainer = E('div', { 'style': 'display: grid; gap: 10px;' });

    const lanContainer = E('div', {
        'id': 'auto-detect-lan-container',
        'style': currentMode === 'exclude' ? 'display: none;' : 'display: block;'
    });

    const autoDetectLanCheckbox = E('input', {
        'type': 'checkbox',
        'id': 'auto_detect_lan'
    });

    const autoDetectLanLabel = E('label', {
        'for': 'auto_detect_lan',
        'style': 'display: flex; align-items: center; gap: 8px; padding: 10px; border: 1px solid ' + PANEL_BORDER + '; border-radius: 4px; background: ' + PANEL_CARD_BG + '; color: ' + PANEL_TEXT + '; cursor: pointer;'
    }, [
        autoDetectLanCheckbox,
        E('span', '🔍 ' + _('Automatically detect LAN bridge interface'))
    ]);

    lanContainer.appendChild(autoDetectLanLabel);
    lanContainer.appendChild(E('div', { 'class': 'cbi-section-descr', 'style': 'margin-top: 5px; font-size: 12px;' },
        _('When enabled, automatically finds the main LAN bridge. Disable to manually select specific interfaces.')));

    const wanContainer = E('div', {
        'id': 'auto-detect-wan-container',
        'style': currentMode === 'explicit' ? 'display: none;' : 'display: block;'
    });

    const autoDetectWanCheckbox = E('input', {
        'type': 'checkbox',
        'id': 'auto_detect_wan'
    });

    const autoDetectWanLabel = E('label', {
        'for': 'auto_detect_wan',
        'style': 'display: flex; align-items: center; gap: 8px; padding: 10px; border: 1px solid ' + PANEL_BORDER + '; border-radius: 4px; background: ' + PANEL_CARD_BG + '; color: ' + PANEL_TEXT + '; cursor: pointer;'
    }, [
        autoDetectWanCheckbox,
        E('span', '🔍 ' + _('Automatically detect WAN interface'))
    ]);

    wanContainer.appendChild(autoDetectWanLabel);
    wanContainer.appendChild(E('div', { 'class': 'cbi-section-descr', 'style': 'margin-top: 5px; font-size: 12px;' },
        _('When enabled, automatically detects and excludes WAN interface. Disable to manually select interfaces to exclude.')));

    optionsContainer.appendChild(lanContainer);
    optionsContainer.appendChild(wanContainer);
    container.appendChild(optionsContainer);

    setTimeout(() => {
        autoDetectLanCheckbox.checked = autoDetectLan;
        autoDetectWanCheckbox.checked = autoDetectWan;
    }, 0);

    async function handleAutoDetectChange(isChecked, type) {
        if (isChecked) return;

        try {
            const settings = await loadSettings();
            const detectedInterfaceName = (type === 'lan') ? settings.detectedLan : settings.detectedWan;

            if (detectedInterfaceName) {
                const checkbox = document.getElementById('iface_' + detectedInterfaceName);
                if (checkbox && checkbox.checked) {
                    checkbox.checked = false;
                    const label = checkbox.nextElementSibling;
                    label.style.borderColor = PANEL_BORDER_ITEM;
                    label.style.backgroundColor = PANEL_ITEM_BG;
                    label.style.color = PANEL_TEXT;

                    const autoIndicator = label.querySelector('.auto-indicator');
                    if (autoIndicator) {
                        autoIndicator.remove();
                    }
                }
            }
        } catch (e) {
            console.error(`Failed to uncheck detected ${type} interface:`, e);
        }
    }

    autoDetectLanCheckbox.addEventListener('change', function() {
        handleAutoDetectChange(this.checked, 'lan');
    });

    autoDetectWanCheckbox.addEventListener('change', function() {
        handleAutoDetectChange(this.checked, 'wan');
    });

    return container;
}

function createInterfaceSelector(interfaces, selectedInterfaces, currentMode) {
    const container = E('div', {
        'id': 'interface-selector',
        'class': 'cbi-section'
    });

    const title = currentMode === 'explicit'
        ? _('Select interfaces to process')
        : _('Select interfaces to exclude');

    const description = currentMode === 'explicit'
        ? _('Traffic from these interfaces will be processed by the proxy.')
        : _('Traffic from these interfaces will bypass the proxy (direct routing).');

    container.appendChild(E('h3', title));
    container.appendChild(E('div', { 'class': 'cbi-section-descr' }, description));

    const groupedInterfaces = {};
    const categoryNames = {
        'wan': _('WAN Interfaces'),
        'ethernet': _('Ethernet Interfaces'),
        'wifi': _('WiFi Interfaces'),
        'usb': _('USB Interfaces'),
        'vpn': _('VPN Interfaces'),
        'virtual': _('Virtual Interfaces'),
        'other': _('Other Interfaces')
    };

    interfaces.forEach(function(iface) {
        if (!groupedInterfaces[iface.category]) {
            groupedInterfaces[iface.category] = [];
        }
        groupedInterfaces[iface.category].push(iface);
    });

    const mainContainer = E('div', { 'style': 'margin: 15px 0;' });

    function updateLabelStyle(checkbox, label, ifaceName, detectedInterface) {
        const isAutoDetected = ifaceName === detectedInterface;
        if (isAutoDetected) {
            label.style.borderColor = '#28a745';
            label.style.backgroundColor = PANEL_AUTO_BG;
            label.style.color = PANEL_TEXT;
        } else if (checkbox.checked) {
            label.style.borderColor = '#0066cc';
            label.style.backgroundColor = PANEL_CHK_BG;
            label.style.color = PANEL_TEXT;
        } else {
            label.style.borderColor = PANEL_BORDER_ITEM;
            label.style.backgroundColor = PANEL_ITEM_BG;
            label.style.color = PANEL_TEXT;
        }
    }

    loadSettings().then(function(settings) {
        const autoDetectEnabled = currentMode === 'explicit' ? settings.autoDetectLan : settings.autoDetectWan;
        const detectedInterface = autoDetectEnabled
            ? (currentMode === 'explicit' ? settings.detectedLan : settings.detectedWan)
            : null;

        Object.keys(groupedInterfaces).forEach(function(category) {
            if (groupedInterfaces[category].length === 0) return;

            const groupContainer = E('div', {
                'class': 'cbi-section',
                'style': 'margin-bottom: 5px; border: 1px solid ' + PANEL_BORDER + '; border-radius: 4px; padding: 0 8px 8px 8px; background-color: ' + PANEL_CARD_BG + '; color: ' + PANEL_TEXT + ';'
            });

            const groupTitle = E('h4', {
                'style': 'color: ' + PANEL_TEXT + '; font-size: 13px;'
            }, categoryNames[category] || category);

            groupContainer.appendChild(groupTitle);

            const interfaceGrid = E('div', {
                'style': 'display: grid; grid-template-columns: repeat(auto-fill, minmax(160px, 1fr)); gap: 6px;'
            });
            groupedInterfaces[category].forEach(function(iface) {
                const isChecked = selectedInterfaces.includes(iface.name);

                const checkbox = E('input', {
                    'type': 'checkbox',
                    'id': 'iface_' + iface.name,
                    'value': iface.name,
                    'style': 'position: absolute; left: 6px; top: 50%; transform: translateY(-50%); z-index: 2; margin: 0; vertical-align: middle;'
                });

                const label = E('label', {
                    'for': 'iface_' + iface.name,
                    'style': 'display: flex; align-items: center; padding: 6px 6px 6px 24px; border: 1px solid ' + PANEL_BORDER_ITEM + '; border-radius: 3px; cursor: pointer; background-color: ' + PANEL_ITEM_BG + '; color: ' + PANEL_TEXT + '; transition: all 0.15s ease; font-size: 13px; min-height: 32px; position: relative; line-height: 1.2;'
                }, [
                    E('span', { 'style': 'margin-right: 6px; font-size: 14px; flex-shrink: 0;' }, iface.icon),
                    E('span', { 'style': 'font-weight: 500; flex-grow: 1;' }, iface.description)
                ]);

                const wrapper = E('div', { 'style': 'position: relative;' }, [checkbox, label]);

                checkbox.checked = isChecked;
                updateLabelStyle(checkbox, label, iface.name, detectedInterface);

                if (iface.name === detectedInterface) {
                    const autoIndicator = E('span', {
                        'class': 'auto-indicator',
                        'style': 'margin-left: 4px; font-size: 10px; color: #28a745; font-weight: bold;'
                    }, '● ' + _('AUTO'));
                    label.appendChild(autoIndicator);
                }

                checkbox.addEventListener('change', function() {
                    updateLabelStyle(this, label, iface.name, detectedInterface);
                });

                label.addEventListener('mouseover', function() {
                    if (iface.name === detectedInterface) {
                        this.style.backgroundColor = PANEL_AUTO_BG;
                    } else if (!checkbox.checked) {
                        this.style.borderColor = '#0066cc';
                        this.style.backgroundColor = PANEL_SEL_BG;
                    }
                });

                label.addEventListener('mouseout', function() {
                    updateLabelStyle(checkbox, label, iface.name, detectedInterface);
                });

                interfaceGrid.appendChild(wrapper);
            });

            groupContainer.appendChild(interfaceGrid);
            mainContainer.appendChild(groupContainer);
        });
    });

    container.appendChild(mainContainer);
    return container;
}

function createAdditionalSettings(blockQuic, forceDnsRedirect, useTmpfsRules, showSmartWeights, enableHwid, hwidUserAgent, hwidDeviceOS) {
    const container = E('div', { 'class': 'cbi-section' });

    container.appendChild(E('h3', _('Additional Settings')));

    const settingsContainer = E('div', {
        'style': 'display: grid; grid-template-columns: repeat(auto-fit, minmax(320px, 1fr)); gap: 10px 14px; margin: 15px 0;'
    });

    const cardStyle = 'display: flex; flex-direction: column; gap: 6px; padding: 10px 12px; border: 1px solid ' + PANEL_BORDER + '; border-radius: 4px; background: ' + PANEL_CARD_BG + '; color: ' + PANEL_TEXT + '; cursor: pointer;';
    const cardHeaderStyle = 'display: flex; align-items: center; gap: 8px;';
    const cardDescStyle = 'font-size: 11px; color: ' + PANEL_MUTED_TEXT + '; line-height: 1.35;';

    const blockQuicCheckbox = E('input', {
        'type': 'checkbox',
        'id': 'block_quic'
    });

    const blockQuicLabel = E('label', {
        'for': 'block_quic',
        'style': cardStyle
    }, [
        E('span', { 'style': cardHeaderStyle }, [
            blockQuicCheckbox,
            E('span', '🚫 ' + _('Block QUIC traffic (UDP port 443)'))
        ]),
        E('span', { 'style': cardDescStyle },
            _('When enabled, blocks QUIC traffic on UDP port 443. This can improve proxy effectiveness for some services like YouTube.'))
    ]);

    const forceDnsCheckbox = E('input', {
        'type': 'checkbox',
        'id': 'force_dns_redirect'
    });
    const forceDnsLabel = E('label', {
        'for': 'force_dns_redirect',
        'style': cardStyle + ' grid-column: 1 / -1;'
    }, [
        E('span', { 'style': cardHeaderStyle }, [
            forceDnsCheckbox,
            E('span', '🔒 ' + _('Force client DNS through the router (TCP/UDP 53)'))
        ]),
        E('span', { 'style': cardDescStyle },
            _('Redirects client DNS from ASClash-processed interfaces to the router resolver (dnsmasq must listen on port 53). Router-originated requests, WAN ingress and excluded interfaces are not intercepted. In Explicit mode with Fake-IP whitelist/rule, SRC-IP-CIDR DIRECT sources are exempt from this redirect. Devices already using router DNS via DHCP still use dnsmasq shared upstream; per-client DNS upstreams are not configured. New port-53 flows take precedence over later firewall redirects. DoT/DoH are not blocked.'))
    ]);
    settingsContainer.appendChild(forceDnsLabel);
    settingsContainer.appendChild(blockQuicLabel);

    const tmpfsCheckbox = E('input', {
        'type': 'checkbox',
        'id': 'use_tmpfs_rules'
    });

    const tmpfsLabel = E('label', {
        'for': 'use_tmpfs_rules',
        'style': cardStyle
    }, [
        E('span', { 'style': cardHeaderStyle }, [
            tmpfsCheckbox,
            E('span', '💾 ' + _('Store rules and proxy providers in RAM (tmpfs)'))
        ]),
        E('span', { 'style': cardDescStyle },
            _('When enabled, rulesets and proxy-providers directories are placed on tmpfs to extend the lifespan of the NAND chip (at the cost of using RAM). Disable to keep them on persistent storage.'))
    ]);

    settingsContainer.appendChild(tmpfsLabel);

    const smartWeightsCheckbox = E('input', {
        'type': 'checkbox',
        'id': 'show_smart_weights'
    });
    const smartWeightsLabel = E('label', {
        'for': 'show_smart_weights',
        'style': cardStyle
    }, [
        E('span', { 'style': cardHeaderStyle }, [
            smartWeightsCheckbox,
            E('span', '📊 ' + _('Show Smart group weights'))
        ]),
        E('span', { 'style': cardDescStyle },
            _('The core must support proxy groups with type: smart. If unsupported, this widget will be hidden on the Status page.'))
    ]);
    settingsContainer.appendChild(smartWeightsLabel);

    setTimeout(() => {
        blockQuicCheckbox.checked = blockQuic;
        forceDnsCheckbox.checked = forceDnsRedirect;
        tmpfsCheckbox.checked = useTmpfsRules;
        smartWeightsCheckbox.checked = showSmartWeights;
    }, 0);

    const hwidCheckbox = E('input', {
        'type': 'checkbox',
        'id': 'enable_hwid'
    });

    const hwidLabel = E('label', {
        'for': 'enable_hwid',
        'style': cardStyle
    }, [
        E('span', { 'style': cardHeaderStyle }, [
            hwidCheckbox,
            E('span', '🔑 ' + _('Add HWID headers to subscriptions'))
        ]),
        E('span', { 'style': cardDescStyle },
            _('Automatically adds HWID headers to proxy-providers for device tracking (Remnawave compatibility).'))
    ]);

    settingsContainer.appendChild(hwidLabel);

    const hwidAdvancedContainer = E('div', {
        'id': 'hwid_advanced',
        'style': 'display: none; padding: 10px 12px; border: 1px solid ' + PANEL_BORDER + '; border-radius: 4px; background: ' + PANEL_ITEM_BG + '; color: ' + PANEL_TEXT + '; margin-top: 10px;'
    });

    const hwidFieldsGrid = E('div', {
        'style': 'display: grid; grid-template-columns: repeat(auto-fit, minmax(220px, 1fr)); gap: 10px 14px;'
    }, [
        E('div', {}, [
            E('label', {
                'for': 'hwid_user_agent',
                'style': 'display: block; font-weight: 600; font-size: 12px; margin-bottom: 3px;'
            }, _('User-Agent')),
            E('input', {
                'type': 'text',
                'id': 'hwid_user_agent',
                'class': 'cbi-input-text',
                'value': hwidUserAgent || 'ASClash',
                'placeholder': 'ASClash',
                'style': PANEL_INPUT_STYLE
            })
        ]),
        E('div', {}, [
            E('label', {
                'for': 'hwid_device_os',
                'style': 'display: block; font-weight: 600; font-size: 12px; margin-bottom: 3px;'
            }, _('Device OS')),
            E('input', {
                'type': 'text',
                'id': 'hwid_device_os',
                'class': 'cbi-input-text',
                'value': hwidDeviceOS || 'OpenWrt',
                'placeholder': 'OpenWrt',
                'style': PANEL_INPUT_STYLE
            })
        ])
    ]);

    const hwidHint = E('div', {
        'style': 'font-size: 11px; color: ' + PANEL_MUTED_TEXT + '; margin-top: 8px;'
    }, _('Values sent in HTTP headers of proxy-provider requests (User-Agent / x-device-os).'));

    hwidAdvancedContainer.appendChild(hwidFieldsGrid);
    hwidAdvancedContainer.appendChild(hwidHint);

    setTimeout(() => {
        hwidCheckbox.checked = enableHwid;
        if (enableHwid) {
            hwidAdvancedContainer.style.display = 'block';
        }
    }, 0);

    hwidCheckbox.addEventListener('change', function() {
        if (this.checked) {
            hwidAdvancedContainer.style.display = 'block';
        } else {
            hwidAdvancedContainer.style.display = 'none';
        }
    });

    container.appendChild(settingsContainer);
    container.appendChild(hwidAdvancedContainer);
    return container;
}

async function updateInterfaceCheckboxes(newMode) {
    try {
        const settings = await loadSettings();
        const detectedInterface = newMode === 'explicit' ? settings.detectedLan : settings.detectedWan;
        const autoDetectEnabled = newMode === 'explicit' ? settings.autoDetectLan : settings.autoDetectWan;

        const selectedInterfaces = await loadInterfacesByMode(newMode);
        const checkboxes = document.querySelectorAll('#interface-selector input[type="checkbox"]');

        checkboxes.forEach(function(cb) {
            cb.checked = false;
            const label = cb.nextElementSibling;
            label.style.borderColor = PANEL_BORDER_ITEM;
            label.style.backgroundColor = PANEL_ITEM_BG;
            label.style.color = PANEL_TEXT;

            const autoIndicator = label.querySelector('.auto-indicator');
            if (autoIndicator) {
                autoIndicator.remove();
            }
        });

        selectedInterfaces.forEach(function(ifaceName) {
            const checkbox = document.getElementById('iface_' + ifaceName);
            if (checkbox) {
                checkbox.checked = true;
                const label = checkbox.nextElementSibling;

                if (autoDetectEnabled && ifaceName === detectedInterface) {
                    label.style.borderColor = '#28a745';
                    label.style.backgroundColor = PANEL_AUTO_BG;
                    label.style.color = PANEL_TEXT;

                    const autoIndicator = E('span', {
                        'class': 'auto-indicator',
                        'style': 'margin-left: 4px; font-size: 10px; color: #28a745; font-weight: bold;'
                    }, '● ' + _('AUTO'));
                    label.appendChild(autoIndicator);
                } else {
                    label.style.borderColor = '#0066cc';
                    label.style.backgroundColor = PANEL_CHK_BG;
                    label.style.color = PANEL_TEXT;
                }
            }
        });

        return selectedInterfaces;
    } catch (e) {
        console.error(_('Failed to update interface checkboxes:'), e);
        return [];
    }
}

async function updateAutoDetectSettings(newMode) {
    try {
        const settings = await loadSettings();

        const lanCheckbox = document.getElementById('auto_detect_lan');
        const wanCheckbox = document.getElementById('auto_detect_wan');
        const quicCheckbox = document.getElementById('block_quic');

        if (lanCheckbox) lanCheckbox.checked = settings.autoDetectLan;
        if (wanCheckbox) wanCheckbox.checked = settings.autoDetectWan;
        if (quicCheckbox) quicCheckbox.checked = settings.blockQuic;

        return settings;
    } catch (e) {
        console.error(_('Failed to update auto detect settings:'), e);
        return { autoDetectLan: true, autoDetectWan: true, blockQuic: true };
    }
}

function getManualInterfaces(allInterfaces, detectedInterface) {
    if (!detectedInterface) return allInterfaces;
    return allInterfaces.filter(iface => iface !== detectedInterface);
}

return view.extend({
    load: function() {
        return Promise.all([
            getNetworkInterfaces(),
            loadSettings()
        ]);
    },

    render: async function(data) {
        const [interfaces, settings] = data;

        if (!view_asclash_utils.isLightTheme()) {
            PANEL_TEXT = 'inherit';
            PANEL_MUTED_TEXT = 'rgba(255,255,255,0.55)';
            PANEL_INPUT_STYLE = 'color: inherit; border-color: rgba(255,255,255,0.25);';
            PANEL_CARD_BG = 'rgba(255,255,255,0.05)';
            PANEL_ITEM_BG = 'rgba(255,255,255,0.04)';
            PANEL_SEL_BG = 'rgba(0,102,204,0.2)';
            PANEL_AUTO_BG = 'rgba(40,167,69,0.15)';
            PANEL_CHK_BG = 'rgba(0,102,204,0.25)';
            PANEL_BORDER = 'rgba(255,255,255,0.15)';
            PANEL_BORDER_ITEM = 'rgba(255,255,255,0.1)';
            PANEL_STATUS_BG = 'rgba(0,102,204,0.08)';
            PANEL_STATUS_GREEN = 'rgba(40,167,69,0.1)';
            PANEL_STATUS_WARN = 'rgba(255,193,7,0.12)';
            PANEL_STATUS_TEXT_GREEN = '#75b798';
            PANEL_STATUS_TEXT_WARN = '#ffc107';
        }

        const selectedInterfaces = await loadInterfacesByMode(settings.mode);

        let detectedLanBridge = null;
        let detectedWanInterface = null;

        try {
            detectedLanBridge = await detectLanBridge();
            detectedWanInterface = await detectWanInterface();
        } catch (e) {
            console.error(_('Failed to detect interfaces:'), e);
        }

        const modeSelector = createModeSelector(settings.mode);

        const currentProxyMode = settings.proxyMode || await detectCurrentProxyMode();
        const proxyModeSection = createProxyModeSection(currentProxyMode);
        const tunStackSection = createTunStackSection(settings.tunStack || 'system');
        tunStackSection.style.display = (currentProxyMode === 'tun' || currentProxyMode === 'mixed') ? 'block' : 'none';

        const proxyModeSelectForTun = proxyModeSection.querySelector('#proxy-mode-select');

        function updateTunStackVisibility() {
            const mode = proxyModeSelectForTun ? proxyModeSelectForTun.value : 'tproxy';
            tunStackSection.style.display = (mode === 'tun' || mode === 'mixed') ? 'block' : 'none';
        }
        if (proxyModeSelectForTun) {
            proxyModeSelectForTun.addEventListener('change', updateTunStackVisibility);
        }

        const autoDetectOptions = createAutoDetectOptions(settings.mode, settings.autoDetectLan, settings.autoDetectWan);
        const interfaceSelector = createInterfaceSelector(interfaces, selectedInterfaces, settings.mode);
        const additionalSettings = createAdditionalSettings(
            settings.blockQuic,
            settings.forceDnsRedirect,
            settings.useTmpfsRules,
            settings.showSmartWeights,
            settings.enableHwid,
            settings.hwidUserAgent,
            settings.hwidDeviceOS
        );
        let dhcpDevices = [];
        let dhcpReservationsAvailable = true;
        try {
            dhcpDevices = await getPermanentDhcpDevices();
        } catch (e) {
            dhcpReservationsAvailable = false;
            console.warn('Failed to read static DHCP reservations:', e.message || e);
        }
        const currentConfig = await L.resolveDefault(fs.read('/opt/clash/config.yaml'), '');
        const deviceDirectSection = createDeviceDirectSection(
            dhcpDevices,
            getManagedDirectIPs(currentConfig),
            dhcpReservationsAvailable
        );
        // Kernel management is rendered on the Status page.

        const downloadButton = E('button', {
            'id': 'download-kernel-btn',
            'class': 'btn',
            'click': async function() {
                this.disabled = true;
                this.textContent = _('Downloading...');

                try {
                    const arch = await detectSystemArchitecture();
                    const downloadArch = getDownloadArch(arch);
                    const release = await getLatestMihomoRelease(activeMihomoReleaseRepo);

                    if (!release) throw new Error(_('Failed to get release information'));

                    const asset = findMihomoReleaseAsset(release, downloadArch);

                    if (!asset) throw new Error(_('No compatible .gz binary found for architecture %s in %s').format(downloadArch, release.repo));

                    const success = await downloadMihomoKernel(asset.browser_download_url, release.version, downloadArch);

                    if (success && updateKernelStatusFn) {
                        updateKernelStatusFn();
                    }
                } catch (e) {
                    ui.addNotification(null, E('p', _('Download failed: %s').format(e.message)), 'error');
                } finally {
                    this.disabled = false;
                    this.textContent = _('Download Latest Kernel');
                }
            }
        }, _('Download Latest Kernel'));

        const refreshButton = E('button', {
            'class': 'btn',
            'style': 'margin-left: 10px;',
            'click': function() {
                if (updateKernelStatusFn) {
                    updateKernelStatusFn();
                }
            }
        }, _('Refresh Status'));

        const kernelButtonContainer = E('div', { 'style': 'margin: 20px 0; text-align: center;' }, [
            downloadButton, refreshButton
        ]);

        const kernelInfoSection = E('div', {
            'style': 'margin: 10px 0 20px 0; padding: 8px 12px; background: ' + PANEL_STATUS_WARN + '; border-left: 4px solid #ffc107; border-radius: 4px; font-size: 12px;'
        }, [
            E('span', { 'style': 'color: ' + PANEL_STATUS_TEXT_WARN + '; font-weight: bold;' }, '⚠️ ' + _('Restart Clash service after installing or updating the kernel'))
        ]);

        const modeRadios = modeSelector.querySelectorAll('input[name="interface_mode"]');
        modeRadios.forEach(radio => {
            radio.addEventListener('change', async function() {
                const newMode = this.value;
                const lanContainer = document.getElementById('auto-detect-lan-container');
                const wanContainer = document.getElementById('auto-detect-wan-container');
                const interfaceSelector = document.getElementById('interface-selector');

                if (newMode === 'explicit') {
                    lanContainer.style.display = 'block';
                    wanContainer.style.display = 'none';

                    const title = interfaceSelector.querySelector('h3');
                    const desc = interfaceSelector.querySelector('.cbi-section-descr');
                    title.textContent = _('Select interfaces to process');
                    desc.textContent = _('Traffic from these interfaces will be processed by the proxy.');
                } else {
                    lanContainer.style.display = 'none';
                    wanContainer.style.display = 'block';

                    const title = interfaceSelector.querySelector('h3');
                    const desc = interfaceSelector.querySelector('.cbi-section-descr');
                    title.textContent = _('Select interfaces to exclude');
                    desc.textContent = _('Traffic from these interfaces will bypass the proxy (direct routing).');
                }

                const newSelectedInterfaces = await updateInterfaceCheckboxes(newMode);
                const updatedSettings = await updateAutoDetectSettings(newMode);

                updateCurrentStatus(newMode, updatedSettings.autoDetectLan, updatedSettings.autoDetectWan, newSelectedInterfaces, detectedLanBridge, detectedWanInterface);
            });
        });

        const saveButton = E('button', {
            'class': 'btn',
            'click': async function() {
                const mode = modeSelector.querySelector('input[name="interface_mode"]:checked').value;
                const proxyModeSelect = document.getElementById('proxy-mode-select');
                const savedProxyMode = proxyModeSelect ? proxyModeSelect.value : 'tproxy';
                const tunStackSelect = document.getElementById('tun-stack-select');
                const savedTunStack = tunStackSelect ? tunStackSelect.value : 'system';
                const autoDetectLan = autoDetectOptions.querySelector('#auto_detect_lan').checked;
                const autoDetectWan = autoDetectOptions.querySelector('#auto_detect_wan').checked;
                const blockQuic = additionalSettings.querySelector('#block_quic').checked;
                const forceDnsRedirect = additionalSettings.querySelector('#force_dns_redirect').checked;
                const useTmpfsRules = additionalSettings.querySelector('#use_tmpfs_rules')?.checked ?? true;
                const showSmartWeights = additionalSettings.querySelector('#show_smart_weights')?.checked ?? true;
                const enableHwid = additionalSettings.querySelector('#enable_hwid')?.checked || false;
                const hwidUserAgent = additionalSettings.querySelector('#hwid_user_agent')?.value || 'ASClash';
                const hwidDeviceOS = additionalSettings.querySelector('#hwid_device_os')?.value || 'OpenWrt';
                const selectedDirectDevices = deviceDirectSection.getSelectedDevices();
                let managedDirectIPs = null;
                if (Array.isArray(selectedDirectDevices)) {
                    try {
                        const currentReservations = await getPermanentDhcpDevices();
                        const currentByIP = new Map(currentReservations.map(device => [device.ip, device]));
                        const reservationChanged = selectedDirectDevices.some(device => {
                            const current = currentByIP.get(device.ip);
                            if (!current) return true;
                            const originalMacs = device.macs.slice().sort().join(',');
                            const currentMacs = current.macs.slice().sort().join(',');
                            return originalMacs !== currentMacs;
                        });
                        if (reservationChanged) {
                            ui.addNotification(null, E('p', _('DHCP reservations changed while this page was open. Reload the page and select the device again.')), 'error');
                            return;
                        }
                        managedDirectIPs = selectedDirectDevices.map(device => device.ip);
                    } catch (e) {
                        ui.addNotification(null, E('p', _('Could not re-check DHCP reservations; settings were not saved.')), 'error');
                        return;
                    }
                }

                const selected = [];
                const checkboxes = interfaceSelector.querySelectorAll('input[type="checkbox"]:checked');
                checkboxes.forEach(function(cb) {
                    selected.push(cb.value);
                });

                const success = await saveSettings(
                    mode,
                    savedProxyMode,
                    savedTunStack,
                    autoDetectLan,
                    autoDetectWan,
                    blockQuic,
                    forceDnsRedirect,
                    useTmpfsRules,
                    showSmartWeights,
                    selected,
                    enableHwid,
                    hwidUserAgent,
                    hwidDeviceOS,
                    settings.mihomoReleaseRepo,
                    managedDirectIPs
                );

                if (success) {
                    updateCurrentStatus(mode, autoDetectLan, autoDetectWan, selected, detectedLanBridge, detectedWanInterface);
                }
            }
        }, _('Save Settings'));

        const clearButton = E('button', {
            'class': 'btn',
            'style': 'margin-left: 10px;',
            'click': function() {
                const checkboxes = interfaceSelector.querySelectorAll('input[type="checkbox"]');
                checkboxes.forEach(function(cb) {
                    cb.checked = false;
                    const label = cb.nextElementSibling;
                    label.style.borderColor = PANEL_BORDER_ITEM;
                    label.style.backgroundColor = PANEL_ITEM_BG;
                    label.style.color = PANEL_TEXT;
                });
            }
        }, _('Clear All Interfaces'));

        const restartButton = E('button', {
            'class': 'btn',
            'click': async function() {
                restartButton.disabled = true;
                try {
                    const progressBefore = await view_asclash_utils.getListProgress();
                    try {
                        await view_asclash_utils.execDetached('/etc/init.d/clash restart');
                    } catch (e) {}

                    ui.addNotification(null, E('p', _('Clash is restarting; firewall lists will be rebuilt and applied.')), 'info');
                    watchListProgress(progressBefore);

                    const [serviceRunning, progress] = await Promise.all([
                        view_asclash_utils.waitForServiceStatus(view_asclash_utils.getClashRunning, true),
                        view_asclash_utils.waitForListProgress(progressBefore, 90000)
                    ]);
                    if (!serviceRunning) {
                        ui.addNotification(null, E('p',
                            _('Service is still restarting — it may take longer on a slow connection. Reload the page in a moment to check its status.')
                        ), 'warning');
                        return;
                    }

                    if (!progress) {
                        ui.addNotification(null, E('p', _('The service restarted, but list application could not be confirmed yet. Check Diagnostics and the system log.')), 'warning');
                        return;
                    }
                    if (progress.phase === 'failed') return;

                    ui.addNotification(null, E('p', _('Clash service restarted successfully.')), 'info');
                    const currentMode = modeSelector.querySelector('input[name="interface_mode"]:checked').value;
                    const currentAutoDetectLan = autoDetectOptions.querySelector('#auto_detect_lan').checked;
                    const currentAutoDetectWan = autoDetectOptions.querySelector('#auto_detect_wan').checked;

                    const savedInterfaces = await loadInterfacesByMode(currentMode);

                    const checkboxes = interfaceSelector.querySelectorAll('input[type="checkbox"]');
                    checkboxes.forEach(function(cb) {
                        cb.checked = savedInterfaces.includes(cb.value);
                        const label = cb.nextElementSibling;
                        if (cb.checked) {
                            label.style.borderColor = '#0066cc';
                            label.style.backgroundColor = PANEL_CHK_BG;
                            label.style.color = PANEL_TEXT;
                        } else {
                            label.style.borderColor = PANEL_BORDER_ITEM;
                            label.style.backgroundColor = PANEL_ITEM_BG;
                            label.style.color = PANEL_TEXT;
                        }
                    });

                    const autoDetectEnabled = currentMode === 'explicit' ? currentAutoDetectLan : currentAutoDetectWan;

                    try {
                        const settings = await loadSettings();
                        const detectedInterface = currentMode === 'explicit' ? settings.detectedLan : settings.detectedWan;

                        if (detectedInterface && autoDetectEnabled) {
                            const detectedCheckbox = document.getElementById('iface_' + detectedInterface);
                            if (detectedCheckbox) {
                                const detectedLabel = detectedCheckbox.nextElementSibling;
                                detectedLabel.style.borderColor = '#28a745';
                                detectedLabel.style.backgroundColor = PANEL_AUTO_BG;
                                detectedLabel.style.color = PANEL_TEXT;

                                const existingIndicator = detectedLabel.querySelector('.auto-indicator');
                                if (!existingIndicator) {
                                    const autoIndicator = E('span', {
                                        'class': 'auto-indicator',
                                        'style': 'margin-left: 4px; font-size: 10px; color: #28a745; font-weight: bold;'
                                    }, '● ' + _('AUTO'));
                                    detectedLabel.appendChild(autoIndicator);
                                }
                            }
                        } else if (detectedInterface && !autoDetectEnabled) {
                            const detectedCheckbox = document.getElementById('iface_' + detectedInterface);
                            if (detectedCheckbox) {
                                const detectedLabel = detectedCheckbox.nextElementSibling;
                                const existingIndicator = detectedLabel.querySelector('.auto-indicator');
                                if (existingIndicator) {
                                    existingIndicator.remove();
                                }
                                if (detectedCheckbox.checked) {
                                    detectedLabel.style.borderColor = '#0066cc';
                                    detectedLabel.style.backgroundColor = PANEL_CHK_BG;
                                    detectedLabel.style.color = PANEL_TEXT;
                                } else {
                                    detectedLabel.style.borderColor = PANEL_BORDER_ITEM;
                                    detectedLabel.style.backgroundColor = PANEL_ITEM_BG;
                                    detectedLabel.style.color = PANEL_TEXT;
                                }
                            }
                        }
                    } catch (e) {
                        console.error('Failed to reapply auto-detected styles:', e);
                    }

                    try {
                        detectedLanBridge = await detectLanBridge();
                        detectedWanInterface = await detectWanInterface();
                    } catch (e) {
                        console.error(_('Failed to re-detect interfaces:'), e);
                    }

                    updateCurrentStatus(currentMode, currentAutoDetectLan, currentAutoDetectWan, savedInterfaces, detectedLanBridge, detectedWanInterface);
                } catch (e) {
                    ui.addNotification(null, E('p', _('Failed to restart Clash service: %s').format(e.message)), 'error');
                } finally {
                    restartButton.disabled = false;
                }
            },
            'style': 'margin-left: 10px;'
        }, _('Restart Service'));

        const buttonContainer = E('div', { 'style': 'margin: 20px 0; text-align: center;' }, [
            saveButton, clearButton, restartButton
        ]);

        function updateCurrentStatus(mode, autoDetectLan, autoDetectWan, manualInterfaces, detectedLan, detectedWan) {
            const statusElement = document.getElementById('current-status');
            const detectionInfoElement = document.getElementById('detection-info');

            if (statusElement) {
                let statusLines = [];

                if (mode === 'explicit') {
                    statusLines.push(_('Mode: Explicit (process only selected)'));

                    if (autoDetectLan && detectedLan) {
                        statusLines.push(_('Auto-detected LAN: %s ✓').format(detectedLan));
                    }

                    const manualOnly = manualInterfaces.filter(iface => iface !== detectedLan);
                    if (manualOnly.length > 0) {
                        statusLines.push(_('Manual selection: %s').format(manualOnly.join(', ')));
                    }

                    if (!autoDetectLan && manualInterfaces.length === 0) {
                        statusLines.push(_('No interfaces configured'));
                    }
                } else {
                    statusLines.push(_('Mode: Exclude (process all except selected)'));

                    if (autoDetectWan && detectedWan) {
                        statusLines.push(_('Auto-detected WAN: %s ✓').format(detectedWan));
                    }

                    const manualOnly = manualInterfaces.filter(iface => iface !== detectedWan);
                    if (manualOnly.length > 0) {
                        statusLines.push(_('Manual exclusions: %s').format(manualOnly.join(', ')));
                    }
                    if (!autoDetectWan && manualInterfaces.length === 0) {
                        statusLines.push(_('No exclusions configured'));
                    }
                }

                statusElement.innerHTML = '';
                statusLines.forEach((line, index) => {
                    if (index > 0) {
                        statusElement.appendChild(E('br'));
                    }
                    statusElement.appendChild(document.createTextNode(line));
                });
            }

            if (detectionInfoElement) {
                let infoText = '';
                if (mode === 'explicit') {
                    infoText = detectedLan
                        ? '💡 ' + _('Available LAN bridge: %s').format(detectedLan)
                        : '💡 ' + _('No LAN bridge detected');
                } else {
                    infoText = detectedWan
                        ? '💡 ' + _('Available WAN interface: %s').format(detectedWan)
                        : '💡 ' + _('No WAN interface detected');
                }
                detectionInfoElement.textContent = infoText;
            }
        }

        const statusSection = E('div', {
            'class': 'cbi-section',
            'style': 'margin: 20px 0; padding: 0; border: 1px solid ' + PANEL_BORDER + '; border-radius: 6px; overflow: hidden; font-size: 12px;'
        }, [
            E('div', {
                'style': 'padding: 8px 12px; background: ' + PANEL_STATUS_BG + '; border-left: 4px solid #0066cc;'
            }, [
                E('span', { 'style': 'color: #0066cc;' }, '📋 '),
                E('span', {
                    'id': 'current-status',
                    'style': 'color: #0066cc; font-weight: bold;'
                })
            ]),
            E('div', {
                'style': 'padding: 8px 12px; background: ' + PANEL_STATUS_GREEN + '; border-left: 4px solid #28a745; border-top: 1px solid ' + PANEL_BORDER + ';'
            }, [
                E('span', {
                    'id': 'detection-info',
                    'style': 'color: ' + PANEL_STATUS_TEXT_GREEN + ';'
                })
            ]),
            E('div', {
                'style': 'padding: 8px 12px; background: ' + PANEL_STATUS_WARN + '; border-left: 4px solid #ffc107; border-top: 1px solid ' + PANEL_BORDER + ';'
            }, [
                E('span', { 'style': 'color: ' + PANEL_STATUS_TEXT_WARN + '; font-weight: bold;' }, '⚠️ ' + _('Restart Clash service after saving changes'))
            ])
        ]);

        setTimeout(() => {
            updateCurrentStatus(settings.mode, settings.autoDetectLan, settings.autoDetectWan, selectedInterfaces, detectedLanBridge, detectedWanInterface);
        }, 100);

        const view = E([
            modeSelector,
            proxyModeSection,
            tunStackSection,
            autoDetectOptions,
            interfaceSelector,
            statusSection,
            additionalSettings,
            deviceDirectSection.element,
            buttonContainer
        ]);

        return view;
    },

    handleSave: null,
    handleSaveApply: null,
    handleReset: null
});
