'use strict';
'require view';
'require fs';
'require ui';

const FILES = {
	config: '/opt/clash/config.yaml',
	settings: '/opt/clash/settings',
	whitelist: '/opt/clash/lst/fakeip-whitelist-summary.txt',
	grouped: '/opt/clash/lst/fakeip-port-summary.txt',
	groupedStats: '/tmp/clash/fakeip_port_groups.stats',
	parserDiagnostics: '/tmp/clash/fakeip_port_parser_diagnostics.txt',
	groupedDigest: '/tmp/clash/fakeip_port_groups.digest',
	batchDigest: '/tmp/clash/fakeip_port_groups.nft.digest'
};

async function read(path) {
	return L.resolveDefault(fs.read(path), '');
}

async function command(path, args) {
	try {
		const result = await fs.exec(path, args);
		return { ok: result.code === 0, output: String(result.stdout || '').trim(), error: String(result.stderr || '').trim() };
	} catch (e) {
		return { ok: false, output: '', error: e.message || String(e) };
	}
}

function parseGroupedSummary(text) {
	const rows = String(text || '').split(/\r?\n/).filter(Boolean).map(line => {
		const [providers, network, ports, providerCount, setName, setCount] = line.split('|');
		return {
			providers: String(providers || '').split(/\s*&\s*|,\s*/).map(s => s.trim()).filter(Boolean),
			network: String(network || '*').toUpperCase(),
			ports: ports || '',
			cidrs: Number(providerCount) || 0,
			set: setName || `${providers}|${network}|${ports}`,
			setCidrs: Number(setCount) || Number(providerCount) || 0
		};
	});
	const sets = new Map();
	const providers = new Map();
	for (const row of rows) {
		if (!sets.has(row.set)) sets.set(row.set, row.setCidrs);
		for (const provider of row.providers) {
			if (!providers.has(provider)) providers.set(provider, { cidrs: 0, conditions: new Set() });
			const item = providers.get(provider);
			item.cidrs = Math.max(item.cidrs, row.cidrs);
			item.conditions.add(`${row.network} · ${row.ports}`);
		}
	}
	return { rows, sets, providers, total: [...sets.values()].reduce((a, b) => a + b, 0) };
}

function parseWhitelistSummary(text) {
	const providers = String(text || '').split(/\r?\n/).filter(line => line.startsWith('provider|')).map(line => {
		const [, name, count] = line.split('|');
		return { name, count: Number(count) || 0 };
	});
	const match = String(text || '').match(/^entries\|(\d+)$/m);
	return { providers, total: match ? Number(match[1]) : providers.reduce((sum, row) => sum + row.count, 0) };
}

function formatSkipReason(reason) {
	const labels = {
		'malformed-rule-or-missing-action': _('Malformed rule or missing action'),
		'missing-action': _('Missing action'),
		'no-supported-ip-cidr-operand': _('No supported IP-CIDR or RULE-SET operand'),
		'unsupported-or-multiple-network': _('Unsupported or multiple NETWORK conditions'),
		'missing-or-multiple-dst-port': _('Missing or multiple DST-PORT conditions'),
		'empty-dst-port': _('Empty DST-PORT condition')
	};
	if (labels[reason]) return labels[reason];
	if (reason.startsWith('excluded-action-')) return _('Ignored action: %s').format(reason.slice('excluded-action-'.length));
	return reason;
}

function statusPill(ok, yes, no) {
	const color = ok ? '#198754' : '#b42336';
	return E('span', { 'style': `display:inline-block;padding:3px 8px;border-radius:12px;background:${color};color:#fff;font-size:12px;font-weight:600;` }, ok ? yes : no);
}

function card(title, content) {
	return E('section', { 'class': 'cbi-section', 'style': 'margin:12px 0;padding:14px;border:1px solid rgba(127,127,127,.35);border-radius:6px;' }, [
		E('h3', { 'style': 'margin:0 0 10px;' }, title), content
	]);
}

return view.extend({
	load: async function() {
		const paths = Object.values(FILES);
		const [fileValues, nft, rules, route100, route101, logread] = await Promise.all([
			Promise.all(paths.map(read)),
			command('/usr/sbin/nft', ['list', 'chains', 'inet', 'clash']),
			command('/sbin/ip', ['rule', 'show']),
			command('/sbin/ip', ['route', 'show', 'table', '100']),
			command('/sbin/ip', ['route', 'show', 'table', '101']),
			command('/sbin/logread', ['-e', 'clash-rules'])
		]);
		const files = Object.fromEntries(paths.map((path, index) => [path, fileValues[index]]));
		return { files, nft, rules, route100, route101, logread, checkedAt: new Date().toLocaleString() };
	},

	render: function(data) {
		const { files, nft, rules, route100, route101, logread, checkedAt } = data;
		const whitelist = parseWhitelistSummary(files[FILES.whitelist]);
		const grouped = parseGroupedSummary(files[FILES.grouped]);
		const groupedEnabled = !/^GROUPED_FAKEIP_PORT_RULES_ENABLED=false\s*$/mi.test(files[FILES.settings] || '');
		const parserReportAvailable = groupedEnabled && !!files[FILES.parserDiagnostics];
		const parserReport = parserReportAvailable ? String(files[FILES.parserDiagnostics]).split(/\r?\n/).filter(Boolean).map(line => line.split('|')) : [];
		const accepted = parserReportAvailable ? (Number((parserReport.find(row => row[0] === 'accepted') || [])[1]) || 0) : 0;
		const skipped = parserReportAvailable ? parserReport.filter(row => row[0] === 'skipped') : [];
		const stats = String(files[FILES.groupedStats] || '').trim().split('|');
		const nftOk = nft.ok && /chain\s+(mangle|CLASH_MARK|proxy|output)/i.test(nft.output);
		const tproxyRule = /fwmark\s+0x0*1\s+.*lookup\s+100/i.test(rules.output);
		const tunRule = /fwmark\s+0x0*3\s+.*lookup\s+101/i.test(rules.output);
		const modeMatch = String(files[FILES.settings] || '').match(/^PROXY_MODE=(\S+)/m);
		const mixedMode = !!(modeMatch && modeMatch[1].toLowerCase() === 'mixed');
		const route100Ok = /\bdefault\b/.test(route100.output);
		const route101Ok = /\bdefault\b/.test(route101.output);
		const routingOk = tproxyRule && route100Ok && (!mixedMode || (tunRule && route101Ok));
		const warnings = String(logread.output || '').split(/\r?\n/).filter(line => /skip|invalid|warning|error|failed|exceed|refus/i.test(line)).slice(-30);

		const summary = E('div', { 'class': 'table' }, [
			E('div', { 'style': 'display:flex;flex-wrap:wrap;gap:14px;align-items:center;' }, [
				E('span', {}, [E('strong', {}, _('Firewall table')), ' ', statusPill(nftOk, _('Present'), _('Missing / unreadable'))]),
				E('span', {}, [E('strong', {}, _('Policy routing')), ' ', statusPill(routingOk, _('Rules and routes found'), _('Expected rules or routes not found'))]),
				E('span', {}, [E('strong', {}, _('Grouped parser')), ' ', statusPill(groupedEnabled && files[FILES.groupedDigest] && files[FILES.batchDigest], _('Generated batch available'), _('No generated batch'))])
			]),
			E('p', { 'class': 'cbi-section-descr', 'style': 'margin:10px 0 0;' }, _('Read-only check. It does not restart the service or modify firewall and routing state. Last checked: %s').format(checkedAt))
		]);

		const fakeRows = whitelist.providers.map(row => E('tr', {}, [E('td', {}, row.name), E('td', { 'style': 'text-align:right;' }, String(row.count))]));
		const fakeTable = E('table', { 'class': 'table', 'style': 'width:100%;' }, [
			E('thead', {}, [E('tr', {}, [E('th', {}, _('Rule provider')), E('th', { 'style': 'text-align:right;' }, _('CIDR entries'))])]),
			E('tbody', {}, fakeRows.length ? fakeRows : [E('tr', {}, [E('td', { 'colspan': 2 }, _('No provider statistics available.'))])])
		]);
		const fakeCard = card(_('Fake-IP whitelist parser'), E('div', {}, [
			E('p', {}, [_('Generated entries: '), E('strong', {}, String(whitelist.total))]), fakeTable
		]));

		const groupedRows = [...grouped.providers.entries()].sort((a, b) => a[0].localeCompare(b[0])).map(([name, item]) => E('tr', {}, [
			E('td', {}, name), E('td', {}, [...item.conditions].join('; ')), E('td', { 'style': 'text-align:right;' }, String(item.cidrs))
		]));
		const groupedTable = E('table', { 'class': 'table', 'style': 'width:100%;' }, [
			E('thead', {}, [E('tr', {}, [E('th', {}, _('Rule provider')), E('th', {}, _('Matched conditions')), E('th', { 'style': 'text-align:right;' }, _('CIDR entries'))])]),
			E('tbody', {}, groupedRows.length ? groupedRows : [E('tr', {}, [E('td', { 'colspan': 3 }, _('No grouped rules generated.'))])])
		]);
		const groupedCard = card(_('Grouped AND rules'), E('div', {}, [
			E('p', {}, [_('Accepted by parser: '), E('strong', {}, parserReportAvailable ? String(accepted) : '—'), ' · ', _('Skipped by parser: '), E('strong', {}, parserReportAvailable ? String(skipped.reduce((sum, row) => sum + (Number(row[2]) || 0), 0)) : '—'), ' · ', _('Generated sets: '), E('strong', {}, String(grouped.sets.size)), ' · ', _('CIDR entries: '), E('strong', {}, String(grouped.total))]),
			...(skipped.length ? [E('table', { 'class': 'table', 'style': 'width:100%;' }, [
				E('thead', {}, [E('tr', {}, [E('th', {}, _('Skip reason')), E('th', { 'style': 'text-align:right;' }, _('Count')), E('th', {}, _('Example rule'))])]),
				E('tbody', {}, skipped.map(row => E('tr', {}, [E('td', {}, formatSkipReason(row[1])), E('td', { 'style': 'text-align:right;' }, row[2]), E('td', { 'style': 'overflow-wrap:anywhere;' }, row.slice(3).join('|'))])))
			])] : [E('p', { 'class': 'cbi-section-descr' }, _('No AND rules were skipped by the parser, or parser diagnostics are not available yet.'))]),
			E('p', { 'class': 'cbi-section-descr' }, [_('Generated sets: '), E('strong', {}, stats[0] || '0'), ' · ', _('Generated CIDRs: '), E('strong', {}, stats[1] || '0')]),
			groupedTable,
			E('p', { 'class': 'cbi-section-descr' }, _('Counts are per provider and generated set; overlapping addresses across different providers are intentionally not deduplicated.'))
		]));

		const routes = E('div', {}, [
			E('h4', {}, _('ip rule')), E('pre', { 'style': 'white-space:pre-wrap;overflow-wrap:anywhere;max-height:180px;overflow:auto;' }, rules.output || rules.error || _('No output')),
			E('h4', {}, _('Routing table 100')), E('pre', { 'style': 'white-space:pre-wrap;overflow-wrap:anywhere;' }, route100.output || route100.error || _('Empty')),
			E('h4', {}, _('Routing table 101')), E('pre', { 'style': 'white-space:pre-wrap;overflow-wrap:anywhere;' }, route101.output || route101.error || _('Empty'))
		]);
		const networkCard = card(_('Firewall chains and policy routing'), E('div', {}, [
			E('pre', { 'style': 'white-space:pre-wrap;overflow-wrap:anywhere;max-height:240px;overflow:auto;' }, nft.output || nft.error || _('No output')),
			routes
		]));

		const warningContent = warnings.length
			? E('pre', { 'style': 'white-space:pre-wrap;overflow-wrap:anywhere;max-height:300px;overflow:auto;' }, warnings.join('\n'))
			: E('p', { 'class': 'cbi-section-descr' }, _('No parser or firewall warnings found in the current system log buffer.'));
		const warningCard = card(_('Parser and firewall messages'), E('div', {}, [
			E('p', { 'class': 'cbi-section-descr' }, _('Recent matching log lines are shown for troubleshooting. This is not a complete history; the system log buffer may rotate.')),
			warningContent
		]));

		const refresh = E('button', { 'class': 'btn', 'click': () => window.location.reload() }, _('Refresh diagnostics'));
		return E('div', { 'style': 'max-width:1100px;margin:0 auto;' }, [
			E('div', { 'style': 'display:flex;align-items:center;justify-content:space-between;gap:12px;flex-wrap:wrap;' }, [
				E('h2', { 'style': 'margin:0;' }, _('Diagnostics')), refresh
			]),
			E('p', { 'class': 'cbi-section-descr' }, _('Read-only overview of parser output and active network state.')),
			card(_('Overall status'), summary),
			fakeCard,
			groupedCard,
			networkCard,
			warningCard
		]);
	},

	handleSaveApply: null,
	handleSave: null,
	handleReset: null
});
