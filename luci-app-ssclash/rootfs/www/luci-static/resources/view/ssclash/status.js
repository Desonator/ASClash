'use strict';
'require view';
'require fs';
'require view.ssclash.utils';
'require view.ssclash.kernel';

const rulesetPath = '/opt/clash/lst/';
const FAKEIP_WHITELIST_SUMMARY_FILENAME = 'fakeip-whitelist-summary.txt';
const FAKEIP_WHITELIST_FILENAME = 'fakeip-whitelist-ipcidr.txt';
const GROUPED_FAKEIP_SUMMARY_FILENAME = 'fakeip-port-summary.txt';

function readTopLevelYamlValue(configContent, key) {
    const line = String(configContent || '').split(/\r?\n/).find(row =>
        new RegExp('^' + key.replace(/[.*+?^${}()|[\]\\]/g, '\\$&') + ':[\\t ]*').test(row)
    );
    if (!line) return '';
    let value = line.replace(new RegExp('^' + key.replace(/[.*+?^${}()|[\]\\]/g, '\\$&') + ':[\\t ]*'), '').trim();
    if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'")))
        value = value.slice(1, -1);
    else
        value = value.replace(/\s+#.*$/, '').trim();
    return value;
}

function getSmartApiBaseUrl(configContent) {
    let address = readTopLevelYamlValue(configContent, 'external-controller');
    if (!address) throw new Error(_('Smart API controller is not configured.'));
    if (/^https?:\/\//i.test(address)) return address.replace(/\/$/, '');
    if (address.startsWith('0.0.0.0:')) address = '127.0.0.1:' + address.slice('0.0.0.0:'.length);
    else if (address.startsWith(':')) address = '127.0.0.1' + address;
    else if (address.startsWith('[::]:')) address = '[::1]:' + address.slice('[::]:'.length);
    return 'http://' + address;
}

function yamlScalar(value) {
    const text = String(value || '').trim().replace(/\s+#.*$/, '').replace(/,$/, '').trim();
    if ((text.startsWith('"') && text.endsWith('"')) || (text.startsWith("'") && text.endsWith("'")))
        return text.slice(1, -1);
    return text;
}

function extractSmartGroupNames(configContent) {
    const lines = String(configContent || '').split(/\r?\n/);
    const smartAnchors = new Set();

    for (let i = 0; i < lines.length; i++) {
        const anchor = lines[i].match(/&([A-Za-z0-9_-]+)/);
        if (!anchor) continue;
        let isSmart = /\btype\s*:\s*["']?smart\b/i.test(lines[i]);
        const baseIndent = (lines[i].match(/^\s*/) || [''])[0].length;
        for (let j = i + 1; !isSmart && j < lines.length; j++) {
            const next = lines[j];
            if (!next.trim() || /^\s*#/.test(next)) continue;
            const indent = (next.match(/^\s*/) || [''])[0].length;
            if (indent <= baseIndent) break;
            if (/\btype\s*:\s*["']?smart\b/i.test(next)) isSmart = true;
        }
        if (isSmart) smartAnchors.add(anchor[1]);
    }

    const names = new Set();
    let inGroups = false;
    let groupIndent = null;
    let current = null;

    function finishGroup() {
        if (current && current.smart && current.name) names.add(current.name);
        current = null;
    }

    function inspectGroupFields(text) {
        if (!current) return;
        const nameMatch = text.match(/(?:^|[,{])\s*name\s*:\s*("[^"]*"|'[^']*'|[^,}#]+)/i);
        if (nameMatch && !current.name) current.name = yamlScalar(nameMatch[1]);
        if (/\btype\s*:\s*["']?smart\b/i.test(text)) current.smart = true;
        const aliases = text.matchAll(/\*([A-Za-z0-9_-]+)/g);
        for (const alias of aliases) {
            if (smartAnchors.has(alias[1])) current.smart = true;
        }
    }

    for (const line of lines) {
        if (/^proxy-groups\s*:\s*(?:#.*)?$/.test(line)) {
            inGroups = true;
            groupIndent = null;
            continue;
        }
        if (inGroups && /^[^\s#][^:]*:\s*(?:#.*)?$/.test(line)) {
            finishGroup();
            inGroups = false;
            continue;
        }
        if (!inGroups || /^\s*#/.test(line) || !line.trim()) continue;

        const item = line.match(/^(\s*)-\s*(.*)$/);
        if (item) {
            const indent = item[1].length;
            if (groupIndent == null) groupIndent = indent;
            if (indent === groupIndent) {
                finishGroup();
                current = { name: '', smart: false };
                inspectGroupFields(item[2]);
                continue;
            }
        }
        if (current) inspectGroupFields(line.trim());
    }
    finishGroup();
    return Array.from(names);
}

async function requestSmartGroupWeights(groupName, configContent) {
	const baseUrl = getSmartApiBaseUrl(configContent);
	const secret = readTopLevelYamlValue(configContent, 'secret');
	const args = [ '-fsS', '--connect-timeout', '2', '--max-time', '6', '-w', '\n%{http_code}' ];
	if (secret) args.push('-H', `Authorization: Bearer ${secret}`);
	args.push(`${baseUrl}/group/${encodeURIComponent(groupName)}/weights`);
	const result = await fs.exec('curl', args);
    const output = String(result.stdout || '');
    const statusMatch = output.match(/\n(\d{3})\s*$/);
    const httpStatus = statusMatch ? Number(statusMatch[1]) : 0;
    const responseBody = statusMatch ? output.slice(0, statusMatch.index) : output;
    if (result.code !== 0) {
        const error = new Error((result.stderr || '').trim() || _('Smart weights API request failed.'));
        error.unsupported = httpStatus === 404 || httpStatus === 501;
        throw error;
    }
    try {
        return JSON.parse(responseBody || '{}');
    } catch (e) {
        throw new Error(_('Smart weights API returned invalid JSON.'));
    }
}

function uniqueSmartWeightRows(payload) {
    let rows = payload && payload.weights;
    if (!Array.isArray(rows) && rows && typeof rows === 'object') {
        rows = Object.entries(rows).map(([name, value]) =>
            value && typeof value === 'object' ? { Name: name, ...value } : { Name: name, Weight: value }
        );
    }
    if (!Array.isArray(rows)) rows = [];

    const unique = new Map();
    for (const row of rows) {
        const name = String((row && (row.Name || row.name || row.Proxy || row.proxy)) || '').trim();
        if (!name) continue;
        const weight = row.Weight != null ? row.Weight : row.weight;
        const previous = unique.get(name);
        if (!previous || (Number(weight) > Number(previous.weight))) {
            unique.set(name, {
                name,
                rank: String(row.Rank || row.rank || ''),
                weight: weight == null ? '' : String(weight)
            });
        }
    }
    return Array.from(unique.values()).sort((a, b) => {
        const weightA = Number(a.weight);
        const weightB = Number(b.weight);
        const validA = Number.isFinite(weightA);
        const validB = Number.isFinite(weightB);

        // Keep rows with an unknown weight at the bottom; otherwise sort by
        // the current numeric weight from highest to lowest.
        if (validA !== validB) return validA ? -1 : 1;
        if (validA && weightA !== weightB) return weightB - weightA;
        return a.name.localeCompare(b.name);
    });
}

const ISO_3166_ALPHA2 = new Set(('AD AE AF AG AI AL AM AO AQ AR AS AT AU AW AX AZ BA BB BD BE BF BG BH BI BJ BL BM BN BO BQ BR BS BT BV BW BY BZ CA CC CD CF CG CH CI CK CL CM CN CO CR CU CV CW CX CY CZ DE DJ DK DM DO DZ EC EE EG EH ER ES ET FI FJ FK FM FO FR GA GB GD GE GF GG GH GI GL GM GN GP GQ GR GS GT GU GW GY HK HM HN HR HT HU ID IE IL IM IN IO IQ IR IS IT JE JM JO JP KE KG KH KI KM KN KP KR KW KY KZ LA LB LC LI LK LR LS LT LU LV LY MA MC MD ME MF MG MH MK ML MM MN MO MP MQ MR MS MT MU MV MW MX MY MZ NA NC NE NF NG NI NL NO NP NR NU NZ OM PA PE PF PG PH PK PL PM PN PR PS PT PW PY QA RE RO RS RU RW SA SB SC SD SE SG SH SI SJ SK SL SM SN SO SR SS ST SV SX SY SZ TC TD TF TG TH TJ TK TL TM TN TO TR TT TV TW TZ UA UG UM US UY UZ VA VC VE VG VI VN VU WF WS YE YT ZA ZM ZW').split(' '));

function formatSmartServerName(value) {
    const name = String(value || '').trim();
    if (!name) return name;
    const match = name.match(/^([A-Za-z]{2})(?=\s|$)/);
    if (!match) return name;
    const country = match[1].toUpperCase();
    if (!ISO_3166_ALPHA2.has(country)) return name;
    const flagBase = String.fromCodePoint(...Array.from(country, letter => 0x1F1E6 + letter.charCodeAt(0) - 65));
    const flag = `${flagBase}\uFE0F`;
    const remainder = name.slice(match[1].length).split(flagBase).join('').replace(/\s{2,}/g, ' ').trim();
    return remainder ? `${flag} ${remainder}` : flag;
}

function getSmartWeightColor(value) {
    if (value == null || value === '' || !Number.isFinite(Number(value))) return '#8a8a8a';
    const weight = Math.max(0, Math.min(100, Number(value)));
    const red = [220, 53, 69];
    const yellow = [255, 193, 7];
    const green = [40, 167, 69];
    const start = weight <= 50 ? red : yellow;
    const end = weight <= 50 ? yellow : green;
    const ratio = weight <= 50 ? weight / 50 : (weight - 50) / 50;
    const rgb = start.map((channel, index) => Math.round(channel + (end[index] - channel) * ratio));
    return `rgb(${rgb.join(', ')})`;
}

function formatSmartWeight(value) {
    if (value == null || value === '') return '—';
    const weight = Number(value);
    if (!Number.isFinite(weight)) return '—';
    return String(Number(weight.toFixed(2)));
}

function getWhitelistSummaryData(summary, whitelistFile) {
    const summaryCount = Number(((summary || '').match(/^entries\|(\d+)$/m) || [ '', '0' ])[1]) || 0;
    let providers = (summary || '').split('\n')
        .filter(line => line.startsWith('provider|'))
        .map(line => {
            const [, provider, count] = line.split('|');
            return { provider: provider || '', count: count || '0' };
        })
        .filter(row => row.provider);

    let inAutoBlock = false;
    let autoCount = 0;
    let sourceNames = [];
    for (const line of String(whitelistFile || '').split(/\r?\n/)) {
        if (/^#[\s]*AUTO-BEGIN/.test(line)) { inAutoBlock = true; continue; }
        if (/^#[\s]*AUTO-END/.test(line)) { inAutoBlock = false; continue; }
        if (!inAutoBlock) continue;
        const sourceMatch = line.match(/^#[\s]*Sources\s*\([^)]*\):\s*(.+)$/i);
        if (sourceMatch && !/\(none/i.test(sourceMatch[1]))
            sourceNames = sourceMatch[1].trim().split(/[\s,]+/).filter(Boolean);
        const value = line.trim();
        if (/^(?:\d{1,3}\.){3}\d{1,3}(?:\/(?:\d|[12]\d|3[0-2]))?$/.test(value))
            autoCount++;
    }

    const hasAutoBlock = /^#[\s]*AUTO-BEGIN/m.test(String(whitelistFile || '')) && /^#[\s]*AUTO-END/m.test(String(whitelistFile || ''));
    const fallback = hasAutoBlock && autoCount !== summaryCount;
    if (fallback)
        providers = sourceNames.map(provider => ({ provider, count: '—' }));
    else if (providers.length === 0 && sourceNames.length > 0)
        providers = sourceNames.map(provider => ({ provider, count: '—' }));

    return { total: fallback ? autoCount : summaryCount, providers, fallback };
}

function createSmartWeightsSection(smartGroupNames, configContent, isRussian, showSmartWeights = true) {
    const isLight = view_ssclash_utils.isLightTheme();
    const sectionStyle = isLight
        ? 'padding:10px 15px;border:1px solid #cbd5e1;border-radius:5px;background:#f5f7fa;margin:15px 0;'
        : 'padding:10px 15px;border:1px solid rgba(148,163,184,.34);border-radius:5px;background:rgba(148,163,184,.055);margin:15px 0;';
    const neutralAccent = isLight ? '#64748b' : '#aab6c5';
    const section = E('div', { 'style': sectionStyle });
    const body = E('div', { 'style': 'margin-top: 4px;' });
    const refreshButton = E('button', {
        'class': 'btn',
        'style': 'margin-left: auto;'
    }, _('Refresh Smart weights'));

    section.appendChild(E('div', { 'style': 'display: flex; align-items: center; gap: 6px; flex-wrap: wrap;' }, [
        E('span', {
            'style': 'display: inline-block; background: #64748b; color: white; padding: 2px 8px; border-radius: 3px; font-size: 14px; line-height: 18px; font-weight: bold; white-space: nowrap;'
        }, 'SMART'),
        E('h3', { 'style': `margin:0;color:${neutralAccent};font-size:14px;line-height:18px;` }, _('Smart group weights')),
        refreshButton
    ]));
    section.appendChild(body);

    if (!showSmartWeights) {
        section.style.display = 'none';
        return section;
    }

    if (smartGroupNames === null) {
        refreshButton.disabled = true;
        body.appendChild(E('p', { 'class': 'cbi-section-descr' }, _('Could not read the configuration to detect Smart groups.')));
        return section;
    }

    if (smartGroupNames.length === 0) {
        section.style.display = 'none';
        refreshButton.disabled = true;
        body.appendChild(E('div', {
            'class': 'cbi-section-descr',
            'style': 'padding: 10px 12px; border: 1px dashed rgba(127,127,127,0.45); border-radius: 4px; text-align: center;'
        }, isRussian
            ? 'Smart-группа отключена в конфигурации: в proxy-groups не найдено type: smart.'
            : _('Smart group is disabled in the configuration: no proxy group with type: smart was found.')));
        return section;
    }

    let refreshInProgress = false;
    let hasLoaded = false;
    let lastResults = [];
    let pollTimer = null;
    const groupPanelStyle = isLight
        ? 'margin:10px 0;padding:10px 12px;background:rgba(255,255,255,.72);border:1px solid rgba(80,100,125,.22);border-left:3px solid #94a3b8;border-radius:5px;'
        : 'margin:10px 0;padding:10px 12px;background:rgba(10,14,20,.22);border:1px solid rgba(160,180,205,.18);border-left:3px solid #94a3b8;border-radius:5px;';

    function renderResults(results) {
        body.replaceChildren();
        for (const result of results) {
            const groupBlock = E('div', { 'style': groupPanelStyle });
            groupBlock.appendChild(E('h4', {
                'style': 'margin:0 0 8px;padding:0 0 7px;color:inherit;font-size:14px;line-height:18px;border-bottom:1px solid rgba(127,127,127,.22);'
            }, _('Smart group: %s').format(result.groupName)));

            if (result.error) {
                groupBlock.appendChild(E('p', { 'class': 'cbi-section-descr' }, _('Could not load Smart weights: %s').format(result.error)));
            } else if (result.rows.length === 0) {
                groupBlock.appendChild(E('p', { 'class': 'cbi-section-descr' }, _('No Smart weight data is available for this group yet.')));
            } else {
                const rows = result.rows.map(row => {
                    const color = getSmartWeightColor(row.weight);
                    return E('div', {
                        'style': `display:flex;align-items:center;justify-content:space-between;gap:8px;margin:1px 0;padding:7px 10px;min-height:36px;font-size:12px;line-height:16px;background:rgba(255,255,255,0.045);border:1px solid ${color};border-left:4px solid ${color};border-radius:4px;`
                    }, [
                        E('span', { 'style': 'font-weight:600;min-width:0;overflow-wrap:anywhere;font-family:system-ui, -apple-system, "Segoe UI", "Apple Color Emoji", "Segoe UI Emoji", "Noto Color Emoji", sans-serif;font-variant-emoji:emoji;' }, formatSmartServerName(row.name)),
                        E('strong', { 'style': `flex:none;color:${color};font-size:12px;font-variant-numeric:tabular-nums;` }, formatSmartWeight(row.weight))
                    ]);
                });
                groupBlock.appendChild(E('div', { 'class': 'ssclash-smart-nodes' }, rows));
            }
            body.appendChild(groupBlock);
        }
    }

    async function refresh(manual = false) {
        if (refreshInProgress || !section.isConnected) return;
        refreshInProgress = true;
        if (manual) {
            refreshButton.disabled = true;
            refreshButton.textContent = _('Loading...');
        }
        if (!hasLoaded) body.replaceChildren(E('p', { 'class': 'cbi-section-descr' }, _('Loading Smart weights...')));

        const results = [];
        for (const groupName of smartGroupNames) {
            try {
                const payload = await requestSmartGroupWeights(groupName, configContent);
                results.push({ groupName, rows: uniqueSmartWeightRows(payload), error: '' });
            } catch (e) {
                const previous = lastResults.find(result => result.groupName === groupName);
                results.push(previous && !previous.error
                    ? previous
                    : { groupName, rows: [], error: e.message || _('Smart weights API request failed.'), unsupported: !!e.unsupported });
            }
        }

        if (results.length && results.every(result => result.unsupported)) {
            section.style.display = 'none';
            if (pollTimer) clearInterval(pollTimer);
            refreshInProgress = false;
            return;
        }

        lastResults = results;
        renderResults(results);
        hasLoaded = true;

        if (manual) {
            refreshButton.textContent = _('Refresh Smart weights');
            refreshButton.disabled = false;
        }
        refreshInProgress = false;
    }

    refreshButton.addEventListener('click', () => refresh(true));
    setTimeout(() => refresh(), 100);
    pollTimer = setInterval(() => {
        if (!section.isConnected) {
            clearInterval(pollTimer);
            return;
        }
        if (!document.hidden) refresh();
    }, 30000);
    return section;
}

async function detectFakeIpWhitelistMode() {
    try {
        const configContent = await L.resolveDefault(fs.read('/opt/clash/config.yaml'), '');
        if (!configContent) return false;

        let inDns = false;
        let dnsEnabled = false;
        let isEnhancedFakeIp = false;
        let filterMode = 'blacklist';

        for (const line of configContent.split('\n')) {
            const trimmed = line.trim();
            if (trimmed.match(/^dns:\s*$/)) { inDns = true; continue; }
            if (inDns && trimmed.length > 0 && !line.match(/^[\s]/)) { inDns = false; }
            if (!inDns) continue;
            if (trimmed.match(/^enable:\s*true/)) dnsEnabled = true;
            if (trimmed.match(/^enhanced-mode:\s*fake-ip/)) isEnhancedFakeIp = true;
            const modeMatch = trimmed.match(/^fake-ip-filter-mode:\s*(\S+)/);
            if (modeMatch) filterMode = modeMatch[1].toLowerCase().replace(/['"]/g, '');
        }

        return dnsEnabled && isEnhancedFakeIp && (filterMode === 'whitelist' || filterMode === 'rule');
    } catch (e) {
        console.error('Failed to detect fake-ip-filter-mode:', e);
        return false;
    }
}

return view.extend({
    load: async function() {
        const [isWhitelistMode, whitelistSummary, groupedSummary, configContent, whitelistFile, whitelistSourceDigest, groupedSourceDigest, settingsContent] = await Promise.all([
            detectFakeIpWhitelistMode(),
            L.resolveDefault(fs.read(`${rulesetPath}${FAKEIP_WHITELIST_SUMMARY_FILENAME}`), ''),
            L.resolveDefault(fs.read(`${rulesetPath}${GROUPED_FAKEIP_SUMMARY_FILENAME}`), ''),
            L.resolveDefault(fs.read('/opt/clash/config.yaml'), ''),
            L.resolveDefault(fs.read(`${rulesetPath}${FAKEIP_WHITELIST_FILENAME}`), ''),
            L.resolveDefault(fs.read('/opt/clash/lst/mrs_cache/.whitelist_src_digest'), ''),
            L.resolveDefault(fs.read('/tmp/clash/fakeip_port_groups.digest'), ''),
            L.resolveDefault(fs.read('/opt/clash/settings'), '')
        ]);
        return {
            isWhitelistMode,
            whitelistSummary,
            groupedSummary,
            configContent,
            whitelistFile,
            whitelistSourceDigest,
            groupedSourceDigest,
            showSmartWeights: !/^SHOW_SMART_WEIGHTS=false\s*$/mi.test(settingsContent),
            smartGroupNames: configContent ? extractSmartGroupNames(configContent) : null
        };
    },

    render: function(data) {
        const { isWhitelistMode, whitelistSummary, groupedSummary, configContent, whitelistFile, smartGroupNames, showSmartWeights = true,
            whitelistSourceDigest = '', groupedSourceDigest = '' } = data || {
            isWhitelistMode: false, whitelistSummary: '', groupedSummary: '', configContent: '', whitelistFile: '', smartGroupNames: null, showSmartWeights: true,
            whitelistSourceDigest: '', groupedSourceDigest: ''
        };
        const currentLang = String((L.env && L.env.lang) || document.documentElement.lang || navigator.language || '').toLowerCase();
        const isRussian = currentLang.startsWith('ru');

        const _light = view_ssclash_utils.isLightTheme();
        const whitelistCardStyle = _light
            ? 'padding: 10px 15px; border: 2px solid #0066cc; border-radius: 5px; background-color: #f0f8ff; margin: 15px 0;'
            : 'padding: 10px 15px; border: 2px solid #0066cc; border-radius: 5px; background-color: rgba(0,102,204,0.1); margin: 15px 0;';

        const innerPanelStyle = _light
            ? 'background:#fff;border:1px solid #d6dce5;border-radius:5px;padding:8px 12px;margin-top:8px;'
            : 'background:rgba(15,18,23,0.42);border:1px solid rgba(190,205,225,0.16);border-radius:5px;padding:8px 12px;margin-top:8px;';

        const style = E('style', {}, `
            .ssclash-smart-nodes { display:grid; grid-template-columns:repeat(3,minmax(0,1fr)); gap:3px; }
            @media (max-width:640px) { .ssclash-smart-nodes { grid-template-columns:repeat(2,minmax(0,1fr)); } }
            @media (max-width:340px) { .ssclash-smart-nodes { grid-template-columns:minmax(0,1fr); } }
            .cbi-section-title::before { content: '▶'; display: inline-block; margin-right: 10px; font-size: 0.8em; transition: transform 0.2s ease-in-out; }
            .cbi-section-title.active::before { transform: rotate(90deg); }
            .ssclash-firewall-card { display:block; }
            .ssclash-card-heading { display:flex; align-items:center; gap:6px; flex:1 1 auto; min-width:0; margin:0 !important; }
            .ssclash-faq { margin:0 0 8px; }
            .ssclash-faq summary { display:flex; align-items:center; gap:8px; cursor:pointer; list-style:none; }
            .ssclash-faq summary::-webkit-details-marker { display:none; }
            .ssclash-faq summary::before { content:'+'; display:inline-grid; place-items:center; width:15px; height:15px; border-radius:50%; background:rgba(0,102,204,.16); font-size:14px; line-height:1; }
            .ssclash-faq[open] summary::before { content:'−'; }
            .ssclash-faq-label { display:inline-flex; align-items:center; gap:7px; margin-left:auto; padding:5px 10px; border:1px solid rgba(0,102,204,.45); border-radius:4px; background:rgba(0,102,204,.08); color:#1684e8; font-weight:600; white-space:nowrap; }
            .ssclash-faq summary::before { display:none; }
            .ssclash-faq-label::before { content:'+'; font-weight:bold; }
            .ssclash-faq[open] .ssclash-faq-label::before { content:'−'; }
            .ssclash-faq-content { margin-top:8px; padding:10px 12px; border-left:3px solid #1684e8; border-radius:3px; background:rgba(127,127,127,.09); }
            .ssclash-metric { display:flex; align-items:center; justify-content:space-between; gap:12px; padding:7px 10px; border-radius:4px; background:rgba(127,127,127,.10); }
            .ssclash-metric > span:last-child { margin-left:auto; font-size:1.1em; font-weight:700; font-variant-numeric:tabular-nums; }
            .ssclash-table-wrap { max-height:280px; overflow:auto; border-radius:4px; }
            .ssclash-data-table { width:100%; table-layout:fixed; margin:0; }
            .ssclash-data-table thead th { position:sticky; top:0; z-index:1; background:var(--background-color, #252a31); }
            .ssclash-data-table th, .ssclash-data-table td { padding:4px 7px; border-bottom:1px solid rgba(127,127,127,.18); }
            .ssclash-data-table tbody tr:last-child td { border-bottom:0; }
            .ssclash-grouped-mobile { display:none; }
            @media (max-width:640px) {
                .ssclash-card-heading h3 { font-size:1em; }
                .ssclash-table-wrap { max-height:none; overflow:visible; padding:6px !important; }
                table.ssclash-data-table { display:block !important; width:100% !important; min-width:0 !important; table-layout:auto !important; }
                table.ssclash-data-table thead { display:none !important; }
                table.ssclash-data-table tbody { display:grid !important; gap:6px; }
                table.ssclash-data-table tbody tr { display:grid !important; grid-template-columns:minmax(0,1fr) auto; gap:5px 10px; padding:8px; border:1px solid rgba(127,127,127,.25); border-radius:4px; background:rgba(127,127,127,.08); }
                table.ssclash-data-table tbody td { display:block !important; min-width:0; padding:0 !important; border:0 !important; text-align:left !important; overflow-wrap:anywhere; }
                table.ssclash-data-table tbody td::before { content:attr(data-label); display:block; margin-bottom:2px; font-size:10px; line-height:12px; opacity:.7; }
                table.ssclash-data-table:not(.ssclash-grouped-table) tbody td:nth-child(1) { grid-column:1; grid-row:1; }
                table.ssclash-data-table:not(.ssclash-grouped-table) tbody td:nth-child(2) { grid-column:2; grid-row:1; text-align:right !important; }
                table.ssclash-data-table.ssclash-grouped-table tbody td:nth-child(1) { grid-column:1; grid-row:1; }
                table.ssclash-data-table.ssclash-grouped-table tbody td:nth-child(4) { grid-column:2; grid-row:1; text-align:right !important; }
                table.ssclash-data-table.ssclash-grouped-table tbody td:nth-child(2) { grid-column:1 / -1; grid-row:2; }
                table.ssclash-data-table.ssclash-grouped-table tbody td:nth-child(3) { grid-column:1 / -1; grid-row:3; }
                table.ssclash-grouped-table { display:none !important; }
                .ssclash-grouped-mobile { display:grid; gap:6px; }
                .ssclash-grouped-provider { padding:8px; border:1px solid rgba(127,127,127,.25); border-radius:4px; background:rgba(127,127,127,.08); }
                .ssclash-grouped-provider-heading { display:flex; justify-content:space-between; align-items:center; gap:12px; margin-bottom:5px; font-weight:600; }
                .ssclash-grouped-condition { display:grid; grid-template-columns:54px minmax(0,1fr); gap:8px; padding:3px 0; border-top:1px solid rgba(127,127,127,.14); }
                .ssclash-grouped-condition-network { font-weight:600; text-transform:uppercase; }
                .ssclash-grouped-condition-ports { overflow-wrap:anywhere; }
                .ssclash-faq summary { flex-wrap:wrap; }
            }
        `);

        function combineFaqWithHeading(card) {
            const heading = card.querySelector('.ssclash-card-heading');
            const faq = card.querySelector('.ssclash-faq');
            const summary = faq && faq.querySelector('summary');
            if (!heading || !faq || !summary) return;

            summary.replaceChildren(heading, E('span', { 'class': 'ssclash-faq-label' }, _('FAQ')));
            card.insertBefore(faq, card.firstChild);
        }

        const whitelistSections = [];
        if (isWhitelistMode) {
            const whitelistStats = getWhitelistSummaryData(whitelistSummary, whitelistFile);
            const whitelistRows = whitelistStats.providers.map(row => {
                return E('tr', {}, [
                    E('td', { 'data-label': isRussian ? 'Провайдер' : _('Provider') }, row.provider),
                    E('td', { 'data-label': isRussian ? 'CIDR записей' : _('CIDR entries'), 'style': 'text-align: right;' }, row.count)
                ]);
            });

            const whitelistBlock = E('div', {
                'class': 'ssclash-firewall-card',
                'style': whitelistCardStyle
            }, [
                E('div', { 'class': 'ssclash-card-heading', 'style': 'display: flex; align-items: center; margin-bottom: 8px;' }, [
                    E('span', {
                        'style': 'display: inline-block; background: #0066cc; color: white; padding: 2px 8px; border-radius: 3px; font-size: 11px; font-weight: bold; margin-right: 10px; white-space: nowrap;'
                    }, _('FIREWALL')),
                    E('h3', { 'style': 'margin: 0; color: #0066cc;' },
                        isRussian ? 'Список IP-CIDR без условий' : _('IP-CIDR list without conditions'))
                ]),
                E('details', { 'class': 'ssclash-faq' }, [
                    E('summary', {}, _('FAQ')),
                    E('div', { 'class': 'ssclash-faq-content' }, [
                        E('p', { 'class': 'cbi-section-descr', 'style': 'margin-bottom: 10px;' },
                            isRussian ? 'Этот список используется файрволом (nftables/iptables) для маркировки трафика к указанным подсетям при fake-ip-filter-mode "whitelist" или "rule". Сохранение применяется без перезапуска Mihomo.' : _('This list is used by the firewall (nftables/iptables) to mark traffic to the listed subnets when fake-ip-filter-mode is set to "whitelist" or "rule". Saving applies changes immediately without restarting Mihomo.')
                        ),
                        E('p', { 'class': 'cbi-section-descr', 'style': 'margin-bottom: 10px;' },
                            isRussian ? 'Блок формируется автоматически из IP-CIDR записей provider-ов, на которые ссылаются правила не DIRECT. Он обновляется при старте службы и каждом clash-rules update (раз в 30 минут) только при изменениях в конфигурации или данных provider-ов.' : _('This block is generated automatically from IP-CIDR entries in providers referenced by non-DIRECT rules. It is refreshed on service start and every clash-rules update (every 30 minutes) only when the configuration or provider data changes.')
                        )
                    ])
                ]),
                E('div', { 'class': 'ssclash-metric', 'style': innerPanelStyle }, [
                    E('strong', {}, isRussian ? 'Всего IP-CIDR записей' : _('Total IP-CIDR entries')),
                    E('span', {}, String(whitelistStats.total))
                ]),
                ...(whitelistStats.fallback ? [E('p', { 'class': 'cbi-section-descr ssclash-card-warning', 'style': 'color: #d9822b;' },
                    isRussian ? 'Статистика summary-файла устарела; общее число восстановлено по AUTO-блоку списка.' : _('Summary statistics were stale; total was recovered from the generated AUTO block.'))] : []),
                E('div', { 'class': 'ssclash-table-wrap', 'style': innerPanelStyle }, [E('table', { 'class': 'table ssclash-data-table' }, [
                    E('colgroup', {}, [E('col', { 'style': 'width: 70%;' }), E('col', { 'style': 'width: 30%;' })]),
                    E('thead', {}, [E('tr', {}, [E('th', { 'style': 'text-align: left;' }, isRussian ? 'Провайдер' : _('Provider')), E('th', { 'style': 'text-align: right;' }, isRussian ? 'CIDR записей' : _('CIDR entries'))])]),
                    E('tbody', {}, whitelistRows.length ? whitelistRows : [E('tr', {}, [E('td', { 'colspan': 2 }, whitelistStats.total > 0
                        ? (isRussian ? 'Есть записи IP-CIDR, но нет статистики по provider-ам.' : _('IP-CIDR entries exist, but provider statistics are unavailable.'))
                        : (isRussian ? 'Нет данных.' : _('No data available.')))])])
                ])])
            ]);

            combineFaqWithHeading(whitelistBlock);

            whitelistSections.push(whitelistBlock);

            const groupedSummaryData = (groupedSummary || '').split('\n').filter(Boolean).reduce((data, line) => {
                const [providerValue, networkValue, portsValue, providerCountValue, setValue, setCountValue] = line.split('|');
                const providerCount = parseInt(providerCountValue, 10) || 0;
                const setCount = parseInt(setCountValue, 10) || parseInt(providerCountValue, 10) || 0;
                const setKey = setValue || `${providerValue}|${networkValue}|${portsValue}`;
                if (!data.setTotals.has(setKey))
                    data.setTotals.set(setKey, setCount);
                const providers = String(providerValue || '').split(/\s*&\s*|,\s*/).map(name => name.trim()).filter(Boolean);
                providers.forEach(provider => {
                    if (!data.providers.has(provider))
                        data.providers.set(provider, { conditions: new Map(), count: 0 });
                    const row = data.providers.get(provider);
                    row.count = Math.max(row.count, providerCount);
                    const network = String(networkValue || '*').trim().toLowerCase();
                    let ports = String(portsValue || '').trim();
                    const networkPrefix = new RegExp('^' + network.replace(/[.*+?^${}()|[\]\\]/g, '\\$&') + ':\\s*', 'i');
                    ports = ports.replace(networkPrefix, '');
                    const conditionKey = `${network}|${ports}`;
                    row.conditions.set(conditionKey, { network, ports });
                });
                return data;
            }, { providers: new Map(), setTotals: new Map() });
            const groupedProviderData = Array.from(groupedSummaryData.providers.entries()).sort((a, b) => a[0].localeCompare(b[0])).map(([provider, row]) => ({
                provider,
                count: row.count,
                conditions: Array.from(row.conditions.values()).sort((a, b) => a.network.localeCompare(b.network) || a.ports.localeCompare(b.ports))
            }));
            const groupedRows = [];
            groupedProviderData.forEach(({ provider, count, conditions }) => {
                const networkCounts = new Map();
                conditions.forEach(condition => networkCounts.set(condition.network, (networkCounts.get(condition.network) || 0) + 1));
                const seenNetworks = new Set();
                conditions.forEach((condition, index) => {
                    const cells = [];
                    if (index === 0)
                        cells.push(E('td', { 'rowspan': String(conditions.length), 'data-label': isRussian ? 'Провайдер' : _('Provider'), 'style': 'text-align:left;vertical-align:middle;word-break:break-word;' }, provider));
                    if (!seenNetworks.has(condition.network)) {
                        cells.push(E('td', { 'rowspan': String(networkCounts.get(condition.network)), 'data-label': isRussian ? 'Сеть' : _('Network'), 'style': 'text-align:left;vertical-align:middle;font-weight:600;text-transform:uppercase;' }, condition.network));
                        seenNetworks.add(condition.network);
                    }
                    cells.push(E('td', { 'data-label': isRussian ? 'Порты назначения' : _('Destination ports'), 'style': 'text-align:left;word-break:break-word;' }, condition.ports));
                    if (index === 0)
                        cells.push(E('td', { 'rowspan': String(conditions.length), 'data-label': isRussian ? 'CIDR записей' : _('CIDR entries'), 'style': 'text-align:right;vertical-align:middle;' }, String(count)));
                    groupedRows.push(E('tr', {}, cells));
                });
            });
            const groupedMobileRows = groupedProviderData.length ? groupedProviderData.map(({ provider, count, conditions }) => E('div', { 'class': 'ssclash-grouped-provider' }, [
                E('div', { 'class': 'ssclash-grouped-provider-heading' }, [
                    E('span', { 'style': 'min-width:0;overflow-wrap:anywhere;' }, provider),
                    E('span', { 'style': 'flex:none;font-variant-numeric:tabular-nums;' }, String(count))
                ]),
                ...conditions.map(condition => E('div', { 'class': 'ssclash-grouped-condition' }, [
                    E('span', { 'class': 'ssclash-grouped-condition-network' }, condition.network),
                    E('span', { 'class': 'ssclash-grouped-condition-ports' }, condition.ports)
                ]))
            ])) : [E('div', {}, _('No grouped rules found.'))];
            const groupedTotal = Array.from(groupedSummaryData.setTotals.values()).reduce((sum, value) => sum + value, 0);
            const groupedBlock = E('div', { 'class': 'ssclash-firewall-card', 'style': whitelistCardStyle }, [
                E('div', { 'class': 'ssclash-card-heading', 'style': 'display: flex; align-items: center; margin-bottom: 8px;' }, [
                    E('span', { 'style': 'display: inline-block; background: #0066cc; color: white; padding: 2px 8px; border-radius: 3px; font-size: 11px; font-weight: bold; margin-right: 10px;' }, _('FIREWALL')),
                    E('h3', { 'style': 'margin: 0; color: #0066cc;' }, isRussian ? 'Список IP-CIDR с AND-условиями' : _('IP-CIDR list with AND conditions'))
                ]),
                E('details', { 'class': 'ssclash-faq' }, [
                    E('summary', {}, _('FAQ')),
                    E('div', { 'class': 'ssclash-faq-content' }, [
                        E('p', { 'class': 'cbi-section-descr' }, isRussian ? 'Этот список используется файрволом (nftables) для маркировки трафика к подсетям с условиями при fake-ip-filter-mode "whitelist" или "rule". Сохранение применяется без перезапуска Mihomo.' : _('This list is used by nftables to mark traffic to subnets matching the conditions when fake-ip-filter-mode is set to "whitelist" or "rule". Saving applies changes immediately without restarting Mihomo.')),
                        E('p', { 'class': 'cbi-section-descr' }, isRussian ? 'Блок формируется автоматически из IP-CIDR, указанных в AND-правилах напрямую или через provider-ы, на которые ссылаются правила не DIRECT. Записи загружаются в отдельные IPv4-наборы nftables; диапазоны портов и транспорт сохраняются, без разворачивания в пары IP/порт. Блок обновляется при старте службы и каждом clash-rules update (раз в 30 минут) только при изменениях в конфигурации, rules или данных provider-ов.' : _('This block is generated from IP-CIDR entries in AND rules, specified directly or through providers referenced by non-DIRECT rules. Entries are loaded into separate nftables IPv4 sets; port ranges and transport are preserved instead of expanding into IP/port pairs. It is refreshed on service start and every clash-rules update (every 30 minutes) only when the configuration, rules or provider data changes.'))
                    ])
                ]),
                E('div', { 'class': 'ssclash-metric', 'style': innerPanelStyle }, [
                    E('strong', {}, isRussian ? 'Всего IP-CIDR записей' : _('Total IP-CIDR entries')),
                    E('span', {}, String(groupedTotal))
                ]),
                E('div', { 'class': 'ssclash-table-wrap', 'style': innerPanelStyle }, [E('table', { 'class': 'table ssclash-data-table ssclash-grouped-table' }, [
                    E('colgroup', {}, [E('col', { 'style': 'width: 24%;' }), E('col', { 'style': 'width: 12%;' }), E('col', { 'style': 'width: 44%;' }), E('col', { 'style': 'width: 20%;' })]),
                    E('thead', {}, [E('tr', {}, [E('th', { 'style': 'text-align: left;' }, isRussian ? 'Провайдер' : _('Provider')), E('th', { 'style': 'text-align: left;' }, isRussian ? 'Сеть' : _('Network')), E('th', { 'style': 'text-align: left;' }, isRussian ? 'Порты назначения' : _('Destination ports')), E('th', { 'style': 'text-align: right;' }, isRussian ? 'CIDR записей' : _('CIDR entries'))])]),
                    E('tbody', {}, groupedRows.length ? groupedRows : [E('tr', {}, [E('td', { 'colspan': 4 }, _('No grouped rules found.'))])])
                ])]),
                E('div', { 'class': 'ssclash-grouped-mobile' }, groupedMobileRows)
            ]);
            combineFaqWithHeading(groupedBlock);
            whitelistSections.push(groupedBlock);

        }

        const root = E('div', {}, [
            style,
            createSmartWeightsSection(smartGroupNames, configContent, isRussian, showSmartWeights),
            view_ssclash_kernel.createKernelManagementSection(),
            ...whitelistSections
        ]);

        // Provider-derived summaries can be regenerated shortly after Mihomo
        // starts because rule-provider files live in tmpfs. Refresh this view
        // when their persisted summaries/digests or config actually change.
        let snapshot = JSON.stringify([configContent, whitelistSummary, groupedSummary,
            whitelistSourceDigest, groupedSourceDigest]);
        let statusRefreshRunning = false;
        let statusRefreshTimer;
        statusRefreshTimer = setInterval(async function() {
            if (!root.isConnected) {
                clearInterval(statusRefreshTimer);
                return;
            }
            if (document.hidden || statusRefreshRunning) return;
            statusRefreshRunning = true;
            try {
                const current = await Promise.all([
                    L.resolveDefault(fs.read('/opt/clash/config.yaml'), ''),
                    L.resolveDefault(fs.read(`${rulesetPath}${FAKEIP_WHITELIST_SUMMARY_FILENAME}`), ''),
                    L.resolveDefault(fs.read(`${rulesetPath}${GROUPED_FAKEIP_SUMMARY_FILENAME}`), ''),
                    L.resolveDefault(fs.read('/opt/clash/lst/mrs_cache/.whitelist_src_digest'), ''),
                    L.resolveDefault(fs.read('/tmp/clash/fakeip_port_groups.digest'), '')
                ]);
                const nextSnapshot = JSON.stringify(current);
                if (nextSnapshot !== snapshot) {
                    clearInterval(statusRefreshTimer);
                    window.location.reload();
                    return;
                }
            } finally {
                statusRefreshRunning = false;
            }
        }, 15000);

        return root;
    },

    handleSaveApply: null,
    handleSave: null,
    handleReset: null
});
