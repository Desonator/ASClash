'use strict';
'require view';
'require fs';
'require view.asclash.utils';

const FILES = {
	config: '/opt/clash/config.yaml',
	settings: '/opt/clash/settings',
	whitelist: '/opt/clash/lst/fakeip-whitelist-summary.txt',
	grouped: '/opt/clash/lst/fakeip-port-summary.txt',
	parserDiagnostics: '/tmp/clash/fakeip_port_parser_diagnostics.txt',
	listProgress: '/tmp/clash/asclash-list-progress',
	groupedSourceDigest: '/tmp/clash/fakeip_port_groups.digest',
	groupedAppliedDigest: '/tmp/clash/fakeip_port_groups.applied.digest',
	listDiagnostics: '/tmp/clash/asclash-list-diagnostics.txt'
};

async function read(path) {
	return L.resolveDefault(fs.read(path), '');
}

async function command(path, args) {
	try {
		const result = await fs.exec(path, args);
		return { ok: result.code === 0, code: result.code, output: String(result.stdout || '').trim(), error: String(result.stderr || '').trim() };
	} catch (e) {
		return { ok: false, code: null, output: '', error: e.message || String(e) };
	}
}

async function checkKernelRunning() {
	const script = 'for exe in /proc/[0-9]*/exe; do [ "$(readlink "$exe" 2>/dev/null)" = "/opt/clash/bin/clash" ] && exit 0; done; exit 1';
	return command('/bin/sh', ['-c', script]);
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

function readYamlScalar(text, key) {
	const escaped = key.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
	const match = String(text || '').match(new RegExp('^' + escaped + ':\\s*(.*?)\\s*$', 'm'));
	if (!match) return '';
	let value = match[1].replace(/\s+#.*$/, '').trim();
	if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'")))
		value = value.slice(1, -1);
	return value;
}

function getLocalMihomoApiUrl(config) {
	// Diagnostics makes an unauthenticated, read-only request only to loopback;
	// it never forwards the configured API secret or contacts a remote controller.
	const plainAddress = readYamlScalar(config, 'external-controller');
	const tlsAddress = readYamlScalar(config, 'external-controller-tls');
	const raw = plainAddress || tlsAddress;
	if (!raw) return { error: _('API controller is not configured.') };
	try {
		let address = raw;
		if (!/^https?:\/\//i.test(address)) {
			if (address.startsWith(':')) address = '127.0.0.1' + address;
			else if (address.startsWith('0.0.0.0:')) address = '127.0.0.1:' + address.slice(8);
			else if (address.startsWith('[::]:')) address = '[::1]:' + address.slice(5);
			address = (raw === tlsAddress && !plainAddress ? 'https://' : 'http://') + address;
		}
		const url = new URL(address);
		if (url.hostname === '0.0.0.0') url.hostname = '127.0.0.1';
		if (url.hostname === '::' || url.hostname === '[::]') url.hostname = '[::1]';
		if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password || !['localhost', '127.0.0.1', '::1', '[::1]'].includes(url.hostname))
			return { error: _('API check skipped: controller is not bound to loopback.') };
		url.pathname = url.pathname.replace(/\/$/, '') + '/version';
		url.search = '';
		url.hash = '';
		return { url: url.toString() };
	} catch (_e) {
		return { error: _('API controller address is invalid or unsupported.') };
	}
}

async function checkMihomoApi(config) {
	const api = getLocalMihomoApiUrl(config);
	if (api.error) return { state: 'unknown', detail: api.error };
	const result = await command('curl', ['-sS', '--noproxy', '*', '--connect-timeout', '2', '--max-time', '4', '-w', '\\n%{http_code}', api.url]);
	const output = result.output || '';
	const statusMatch = output.match(/\n(\d{3})\s*$/);
	const httpStatus = statusMatch ? Number(statusMatch[1]) : 0;
	const body = statusMatch ? output.slice(0, statusMatch.index) : output;
	if (httpStatus === 401 || httpStatus === 403)
		return { state: 'warning', detail: _('Mihomo API is reachable but requires authentication (HTTP %d).').format(httpStatus) };
	if (!result.ok || httpStatus < 200 || httpStatus >= 300)
		return { state: 'error', detail: httpStatus ? _('API returned HTTP %d.').format(httpStatus) : _('Mihomo API did not respond.') };
	try {
		const payload = JSON.parse(body || '{}');
		const version = String(payload.version || payload.Version || '').trim();
		return { state: 'ok', detail: version ? _('Mihomo API version: %s').format(version) : _('Mihomo API responded; version was not reported.') };
	} catch (_e) {
		return { state: 'warning', detail: _('API returned an unexpected response (HTTP %d).').format(httpStatus) };
	}
}

function formatGroupedSkipReason(reason) {
	const labels = {
		'malformed-rule-or-missing-action': _('Malformed AND syntax or the action field is missing; check parentheses, commas and the rule target.'),
		'missing-action': _('The rule has no target/action after the closing AND expression.'),
		'no-supported-ip-cidr-operand': _('No supported IP-CIDR or RULE-SET operand was found inside the AND expression.'),
		'unsupported-or-multiple-network': _('NETWORK is unsupported or specified more than once; use one TCP or UDP condition.'),
		'missing-or-multiple-dst-port': _('DST-PORT is missing or repeated; provide exactly one destination-port condition.'),
		'empty-dst-port': _('DST-PORT has no usable port values; specify ports or ranges.')
	};
	if (labels[reason]) return labels[reason];
	if (reason.startsWith('excluded-action-')) return _('Intentionally ignored terminal action %s (for example DIRECT/REJECT); it is not a parser failure.').format(reason.slice('excluded-action-'.length));
	return reason;
}

function parseListDiagnostics(text) {
	const report = {
		cycle: { phase: 'unknown', time: 0, trigger: 'unknown' },
		fakeip: { state: 'unknown', fallback: false, issues: [] },
		grouped: { state: 'unknown', fallback: false, issues: [] }
	};
	for (const line of String(text || '').split(/\r?\n/).filter(Boolean)) {
		const [kind, a, b, c, d] = line.split('|');
		if (kind === 'cycle') report.cycle = { phase: a || 'unknown', time: Number(b) || 0, trigger: c || 'unknown' };
		else if (kind === 'fakeip') report.fakeip = { ...report.fakeip, state: a || 'unknown', fallback: b === 'true' };
		else if (kind === 'grouped') report.grouped = { ...report.grouped, state: a || 'unknown', fallback: b === 'true' };
		else if (kind === 'fakeip_issue') report.fakeip.issues.push({ provider: a || '', path: b || '', reason: c || '' });
		else if (kind === 'grouped_issue') report.grouped.issues.push({ provider: a || '', path: b || '', reason: c || '' });
	}
	for (const section of [report.fakeip, report.grouped]) {
		const seen = new Set();
		section.issues = section.issues.filter(issue => {
			const key = `${issue.provider}|${issue.path}|${issue.reason}`;
			if (seen.has(key)) return false;
			seen.add(key);
			return true;
		});
	}
	return report;
}

function providerIssueNote(state, issues) {
	if (!issues.length || !['fallback', 'partial', 'error'].includes(state)) return null;
	const title = state === 'fallback'
		? _('Provider files are unavailable; the previous list was retained.')
		: state === 'error' ? _('The list update failed; check these provider sources.')
			: _('Some sources were not included in the generated list.');
	const entries = issues.map(issue => E('li', {}, [
		E('strong', {}, issue.provider || _('Unknown provider')),
		issue.path ? ` — ${issue.path}` : '',
		issue.reason === 'missing' ? ` (${_('file not found')})` :
		issue.reason === 'undefined' ? ` (${_('Provider is not defined')})` :
			issue.reason === 'parse-error' ? ` (${_('Provider could not be parsed')})` :
			issue.reason === 'providers-unavailable' ? ` (${_('rule-provider definitions are unavailable')})` : ''
	]));
	return E('div', { 'class': 'alert-message warning', 'style': 'margin-top:6px;padding:6px 8px;' }, [
		E('span', {}, [title, ' ', _('Affected providers: %d').format(issues.length)]),
		E('details', { 'style': 'margin-top:4px;' }, [E('summary', { 'style': 'cursor:pointer;' }, _('Show provider files')), E('ul', { 'style': 'margin:4px 0 0;padding-left:20px;' }, entries)])
	]);
}

function statePill(state, label) {
	const colors = { ok: '#198754', warning: '#b7791f', error: '#b42336', unknown: '#667085' };
	const labels = { ok: _('OK'), warning: _('Needs attention'), error: _('Problem'), unknown: _('Not checked') };
	return E('span', { 'style': `display:inline-block;padding:3px 8px;border-radius:12px;background:${colors[state] || colors.unknown};color:#fff;font-size:12px;font-weight:600;white-space:nowrap;` }, label || labels[state] || labels.unknown);
}

function formatDiagnosticLogLine(line) {
	const text = String(line || '');
	const marker = text.indexOf(': Auto fakeip whitelist:');
	if (marker < 0) return text;

	const prefix = text.slice(0, marker + 2);
	const message = text.slice(marker + 2);
	let match = message.match(/^Auto fakeip whitelist: provider '([^']+)' file not found: (.+) \(skipped\)$/);
	if (match)
		return prefix + _('Fake-IP whitelist provider "%s": file not found: %s (skipped)').format(match[1], match[2]);

	match = message.match(/^Auto fakeip whitelist: provider '([^']+)' is referenced but not defined \(skipped\)$/);
	if (match)
		return prefix + _('Fake-IP whitelist provider "%s" is referenced but not defined (skipped)').format(match[1]);

	match = message.match(/^Auto fakeip whitelist: provider '([^']+)' could not be parsed: (.+) \(skipped\)$/);
	if (match)
		return prefix + _('Fake-IP whitelist provider "%s" could not be parsed: %s (skipped)').format(match[1], match[2]);

	if (message === 'Auto fakeip whitelist: rule-providers are referenced but none could be parsed')
		return prefix + _('Auto fake-IP whitelist: referenced rule-providers could not be parsed.');

	return text;
}

function statusPill(ok, yes, no) {
	const color = ok ? '#198754' : '#b42336';
	return E('span', { 'style': `display:inline-block;padding:3px 8px;border-radius:12px;background:${color};color:#fff;font-size:12px;font-weight:600;` }, ok ? yes : no);
}

function card(title, content, extraStyle) {
	return E('section', { 'class': 'cbi-section', 'style': `margin:10px 0;padding:12px;border:1px solid rgba(127,127,127,.35);border-radius:6px;text-align:left;min-height:0;box-sizing:border-box;${extraStyle || ''}` }, [
		E('h3', { 'style': 'margin:0 0 6px;text-align:left;font-size:16px;line-height:20px;font-weight:600;' }, title), content
	]);
}

function compactDate(timestamp) {
	return timestamp ? new Intl.DateTimeFormat(undefined, {
		day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit', second: '2-digit'
	}).format(new Date(timestamp * 1000)) : '';
}

function listSection(title, state, statusText, metrics, note) {
	const stateColor = state === 'ok' ? '#198754' : state === 'error' ? '#b42336' : state === 'warning' ? '#b7791f' : '#667085';
	const children = [
		E('div', { 'style': 'display:flex;align-items:center;justify-content:space-between;gap:10px;flex-wrap:wrap;' }, [
		E('h4', { 'style': 'margin:0;text-align:left;font-size:14px;line-height:18px;font-weight:600;' }, title),
			E('span', { 'style': `display:inline-block;padding:3px 8px;border-radius:12px;background:${stateColor};color:#fff;font-size:12px;line-height:14px;font-weight:600;` }, statusText)
		]),
		E('div', { 'style': 'margin-top:7px;' }, metrics)
	];
	if (note)
		children.push(E('div', { 'style': 'margin:6px 0 0;' }, note));
	return E('div', { 'style': 'padding:8px 10px;border:1px solid rgba(127,127,127,.25);border-radius:5px;text-align:left;' }, children);
}

return view.extend({
	load: async function() {
		const paths = Object.values(FILES);
		const [fileValues, nft, rules, route100, route101, tunLink, logread, serviceRunning, kernelProcess, whitelistSet, markChain] = await Promise.all([
			Promise.all(paths.map(read)),
			command('/usr/sbin/nft', ['list', 'chains', 'inet']),
			command('/sbin/ip', ['rule', 'show']),
			command('/sbin/ip', ['route', 'show', 'table', '100']),
			command('/sbin/ip', ['route', 'show', 'table', '101']),
			command('/sbin/ip', ['link', 'show', 'clash-tun']),
			command('/sbin/logread', ['-e', 'clash-rules']),
			view_asclash_utils.getClashRunning().catch(() => null),
			checkKernelRunning(),
			command('/usr/sbin/nft', ['list', 'set', 'inet', 'clash', 'fakeip_whitelist']),
			command('/usr/sbin/nft', ['list', 'chain', 'inet', 'clash', 'CLASH_MARK'])
		]);
		const files = Object.fromEntries(paths.map((path, index) => [path, fileValues[index]]));
		const api = await checkMihomoApi(files[FILES.config]);
		return { files, nft, rules, route100, route101, tunLink, logread, serviceRunning, kernelRunning: kernelProcess.ok, whitelistSet, markChain, api, checkedAt: new Date().toLocaleString() };
	},

	render: function(data) {
		const { files, nft, rules, route100, route101, tunLink, logread, serviceRunning, kernelRunning, whitelistSet, markChain, api, checkedAt } = data;
		const whitelist = parseWhitelistSummary(files[FILES.whitelist]);
		const grouped = parseGroupedSummary(files[FILES.grouped]);
		const progressFields = String(files[FILES.listProgress] || '').trim().split('|');
		const progressPhase = progressFields[1] || 'unknown';
		const progressTime = Number(progressFields[2]) || 0;
		const groupedSourceDigest = String(files[FILES.groupedSourceDigest] || '').trim();
		const groupedAppliedDigest = String(files[FILES.groupedAppliedDigest] || '').trim();
		const groupedEnabled = !/^GROUPED_FAKEIP_PORT_RULES_ENABLED=false\s*$/mi.test(files[FILES.settings] || '');
		const parserReportAvailable = groupedEnabled && !!files[FILES.parserDiagnostics];
		const parserReport = parserReportAvailable ? String(files[FILES.parserDiagnostics]).split(/\r?\n/).filter(Boolean).map(line => line.split('|')) : [];
		const accepted = parserReportAvailable ? (Number((parserReport.find(row => row[0] === 'accepted') || [])[1]) || 0) : 0;
		const skipped = parserReportAvailable ? parserReport.filter(row => row[0] === 'skipped') : [];
		const modeMatch = String(files[FILES.settings] || '').match(/^PROXY_MODE=(\S+)/m);
		const proxyMode = modeMatch ? modeMatch[1].toLowerCase() : 'unknown';
		const hasClashTable = nft.ok && /table\s+inet\s+clash\b/i.test(nft.output);
		const nftOk = hasClashTable && /chain\s+mangle\b/i.test(nft.output) && /chain\s+proxy\b/i.test(nft.output) && /chain\s+CLASH_MARK\b/i.test(nft.output);
		const tproxyRule = /fwmark\s+0x0*1\s+.*lookup\s+100/i.test(rules.output);
		const tunRule = /fwmark\s+0x0*3\s+.*lookup\s+101/i.test(rules.output);
		const localRoute100 = /\blocal\s+default\b.*\bdev\s+lo\b/i.test(route100.output);
		const tunRoute100 = /\bdefault\b.*\bdev\s+clash-tun\b/i.test(route100.output);
		const tunRoute101 = /\bdefault\b.*\bdev\s+clash-tun\b/i.test(route101.output);
		const tunInterface = tunLink.ok;
		const routingChecks = {
			tproxy: tproxyRule && localRoute100,
			tun: tproxyRule && tunInterface && tunRoute100,
			mixed: tproxyRule && localRoute100 && tunRule && tunInterface && tunRoute101
		};
		const routingOk = !!routingChecks[proxyMode] && nftOk;
		const skippedCounts = new Map();
		for (const row of skipped) {
			if (String(row[1] || '').startsWith('excluded-action-')) continue;
			const reason = formatGroupedSkipReason(row[1] || '');
			skippedCounts.set(reason, (skippedCounts.get(reason) || 0) + (Number(row[2]) || 0));
		}
		const skippedSummary = [...skippedCounts.entries()].map(([reason, count]) => `${reason} (${count})`);
		const listDiagnostics = parseListDiagnostics(files[FILES.listDiagnostics]);
		const warnings = String(logread.output || '').split(/\r?\n/).filter(line => /skip|invalid|warning|error|failed|exceed|refus/i.test(line)).slice(-30).map(formatDiagnosticLogLine);

		const summary = E('div', { 'class': 'table', 'style': 'text-align:left;line-height:16px;' }, [
			E('div', { 'style': 'display:flex;flex-wrap:wrap;gap:14px;align-items:center;' }, [
				E('span', {}, [E('strong', {}, _('Clash service')), ' ', serviceRunning == null ? statePill('unknown') : statusPill(serviceRunning, serviceRunning ? _('Running') : _('Stopped'))]),
				E('span', {}, [E('strong', {}, _('Mihomo API')), ' ', statePill(api.state)]),
				E('span', {}, [E('strong', {}, _('nftables integration')), ' ', statusPill(nftOk, _('Present'), _('Missing / unreadable'))]),
				E('span', {}, [E('strong', {}, _('Network mode')), ' ', statusPill(routingOk, routingOk ? _('Consistent') : _('Mismatch'))])
			]),
			E('p', { 'class': 'cbi-section-descr', 'style': 'text-align:left;line-height:16px;margin:6px 0 0;' }, [_('Read-only check. It does not restart the service or modify firewall and routing state. Last checked: %s').format(checkedAt), ' ', api.detail])
		]);

		const whitelistActive = whitelist.total === 0 || whitelistSet.ok;
		const groupedActive = grouped.total === 0 || (!!groupedSourceDigest && groupedSourceDigest === groupedAppliedDigest && markChain.ok && /@fp_[a-f0-9]+/.test(markChain.output));
		const fakeState = listDiagnostics.fakeip.state;
		const groupedState = listDiagnostics.grouped.state;
		const listCycle = listDiagnostics.cycle.phase;
		const listHasError = fakeState === 'error' || groupedState === 'error' || (listCycle === 'complete' && (!whitelistActive || !groupedActive));
		const listHasWarning = ['timeout', 'partial', 'fallback', 'generated', 'not-applied'].includes(fakeState) || ['timeout', 'partial', 'fallback', 'generated', 'not-applied'].includes(groupedState) || listCycle === 'timeout' || skippedSummary.length > 0;
		const listsState = listCycle === 'failed' || listHasError || (listCycle === 'waiting' && (progressPhase === 'failed' || serviceRunning === false)) ? 'error'
			: ['waiting', 'checking', 'timeout'].includes(listCycle) ? 'warning'
			: listCycle === 'complete' && !listHasWarning ? 'ok' : listHasWarning ? 'warning' : 'unknown';
		const listsStatus = listCycle === 'waiting' && serviceRunning === false ? _('Mihomo is not running; provider check has not started')
			: listCycle === 'waiting' ? _('Waiting for provider files')
			: listCycle === 'checking' ? _('Checking provider files')
			: listCycle === 'timeout' ? _('Provider wait timed out')
			: listCycle === 'failed' ? _('List update failed')
			: listsState === 'ok' ? _('OK') : listsState === 'error' ? _('Problem')
			: listCycle === 'complete' ? _('Completed with warnings') : _('Not checked');
		const fakeStatus = fakeState === 'waiting' || fakeState === 'checking' ? _('Waiting for providers')
			: fakeState === 'fallback' ? _('Previous list retained')
			: fakeState === 'partial' ? _('Partially applied')
			: fakeState === 'error' ? _('Update failed')
			: fakeState === 'disabled' ? _('Disabled')
			: fakeState === 'empty' ? _('No entries')
			: fakeState === 'applied-manual' ? _('Manual list applied')
			: fakeState === 'applied' ? (whitelistActive ? _('Set is present') : _('Set is missing'))
			: whitelist.total === 0 ? _('No entries') : _('Not checked');
		const fakeSectionState = ['waiting', 'checking', 'fallback', 'partial'].includes(fakeState) ? 'warning' : fakeState === 'error' || (fakeState === 'applied' && !whitelistActive) ? 'error' : fakeState.startsWith('applied') ? 'ok' : 'unknown';
		const fakeNote = providerIssueNote(fakeState, listDiagnostics.fakeip.issues);
		const groupedStatus = groupedState === 'waiting' || groupedState === 'checking' ? _('Waiting for providers')
			: groupedState === 'fallback' ? _('Previous list retained')
			: groupedState === 'partial' ? _('Partially applied')
			: groupedState === 'error' ? _('Update failed')
			: groupedState === 'disabled' ? _('Disabled')
			: groupedState === 'empty' ? _('No entries')
			: groupedState === 'not-applied' || groupedState === 'generated' ? _('Generated, not applied')
			: groupedState === 'applied' ? (groupedActive ? _('Rules are active') : _('Not confirmed active'))
			: !groupedEnabled ? _('Disabled') : grouped.total === 0 ? _('No entries') : _('Not checked');
		const groupedSectionState = ['waiting', 'checking', 'fallback', 'partial', 'generated', 'not-applied'].includes(groupedState) ? 'warning'
			: groupedState === 'error' || (groupedState === 'applied' && !groupedActive) ? 'error'
			: groupedState === 'applied' || groupedState === 'empty' || groupedState === 'disabled' ? 'ok' : 'unknown';
		const groupedIssueNote = providerIssueNote(groupedState, listDiagnostics.grouped.issues);
		const groupedNotes = [];
		if (groupedIssueNote) groupedNotes.push(groupedIssueNote);
		if (skippedSummary.length) groupedNotes.push(E('p', { 'class': 'alert-message warning', 'style': 'margin:6px 0 0;padding:6px 8px;' }, [_('Parser notes: '), skippedSummary.join('; ')]));
		const groupedNote = groupedNotes.length ? E('div', {}, groupedNotes) : null;
		const groupedMetrics = parserReportAvailable
			? _('Accepted: %d · Skipped: %d · nft sets: %d · CIDR entries: %d').format(accepted, skipped.reduce((sum, row) => sum + (Number(row[2]) || 0), 0), grouped.sets.size, grouped.total)
			: _('Accepted: — · Skipped: — · nft sets: %d · CIDR entries: %d').format(grouped.sets.size, grouped.total);
		const listsCard = E('section', { 'class': 'cbi-section', 'style': 'margin:10px 0;padding:12px;border:1px solid rgba(127,127,127,.35);border-radius:6px;text-align:left;' }, [
			E('div', { 'style': 'display:grid;grid-template-columns:minmax(0,1fr) auto;align-items:center;column-gap:10px;row-gap:3px;margin-bottom:5px;' }, [
				E('h3', { 'style': 'margin:0;text-align:left;min-width:0;font-size:16px;line-height:20px;font-weight:600;' }, _('Rule-list generation and application')),
				E('div', { 'style': 'display:flex;align-items:center;justify-content:flex-end;gap:6px;white-space:nowrap;line-height:18px;' }, [
					statePill(listsState, listsStatus),
					E('span', { 'class': 'cbi-section-descr', 'style': 'margin:0;font-size:12px;line-height:18px;' }, compactDate(listDiagnostics.cycle.time || progressTime))
				])
			]),
			E('div', { 'style': 'display:grid;gap:8px;' }, [
				listSection(_('IP-CIDR list without conditions'), fakeSectionState, fakeStatus,
					_('CIDR entries: %d · Providers: %d').format(whitelist.total, whitelist.providers.length), fakeNote),
				listSection(_('IP-CIDR list with AND conditions'), groupedSectionState, groupedStatus, groupedMetrics, groupedNote)
			])
		]);

		const modeLabel = proxyMode === 'mixed' ? 'MIXED' : proxyMode === 'tun' ? 'TUN' : proxyMode === 'tproxy' ? 'TPROXY' : _('Unknown');
		const modeChecks = proxyMode === 'mixed'
			? [[_('Firewall chains'), nftOk], [_('TPROXY rule and local route'), tproxyRule && localRoute100], [_('TUN rule, interface and route'), tunRule && tunInterface && tunRoute101]]
			: proxyMode === 'tun'
				? [[_('Firewall chains'), nftOk], [_('Policy rule'), tproxyRule], [_('TUN interface and route'), tunInterface && tunRoute100]]
				: proxyMode === 'tproxy'
					? [[_('Firewall chains'), nftOk], [_('TPROXY rule'), tproxyRule], [_('Local route in table 100'), localRoute100]]
					: [[_('Configured network mode'), false]];
		const missingModeChecks = modeChecks.filter(([, ok]) => !ok).map(([label]) => label);
		const modeCard = card(_('Network mode consistency'), E('div', {}, [
			E('p', { 'style': 'margin:0 0 8px;' }, [_('Configured mode: '), E('strong', {}, modeLabel), ' ', statusPill(routingOk, routingOk ? _('Consistent') : _('Mismatch'))]),
			E('div', { 'style': 'display:flex;flex-wrap:wrap;column-gap:18px;row-gap:4px;' }, modeChecks.map(([label, ok]) => E('div', { 'style': 'display:flex;align-items:center;gap:6px;padding:3px 0;' }, [E('span', {}, label), statusPill(ok, _('Present'), _('Missing'))]))),
			!routingOk ? E('p', { 'class': 'alert-message warning', 'style': 'margin:10px 0 0;' }, [_('Missing or inconsistent components: %s. Compare the configured mode with the active nftables chains, ip rules, routes and TUN interface; after changing network-mode settings, restart the Clash service.').format(missingModeChecks.join(', '))]) : null,
			E('details', { 'style': 'margin-top:10px;' }, [
				E('summary', { 'style': 'cursor:pointer;' }, _('Raw network details')),
				E('h4', {}, _('nftables chains')), E('pre', { 'style': 'text-align:left;white-space:pre-wrap;overflow-wrap:anywhere;max-height:180px;overflow:auto;' }, nft.output || nft.error || _('No output')),
				E('h4', {}, _('ip rule')), E('pre', { 'style': 'text-align:left;white-space:pre-wrap;overflow-wrap:anywhere;max-height:180px;overflow:auto;' }, rules.output || rules.error || _('No output')),
				E('h4', {}, _('Routing table 100')), E('pre', { 'style': 'text-align:left;white-space:pre-wrap;overflow-wrap:anywhere;' }, route100.output || route100.error || _('Empty')),
				E('h4', {}, _('Routing table 101')), E('pre', { 'style': 'text-align:left;white-space:pre-wrap;overflow-wrap:anywhere;' }, route101.output || route101.error || _('Empty')),
				E('h4', {}, _('TUN interface')), E('pre', { 'style': 'text-align:left;white-space:pre-wrap;overflow-wrap:anywhere;' }, tunLink.output || tunLink.error || _('Not present')),
				(proxyMode === 'tun' || proxyMode === 'mixed' ? E('p', { 'class': 'cbi-section-descr' }, _('On a virtual TUN interface, state UNKNOWN alone is not an error. Check the UP flag and active route as well.')) : null)
			].filter(Boolean))
		].filter(Boolean)));

		const warningContent = warnings.length
			? E('pre', { 'style': 'white-space:pre-wrap;overflow-wrap:anywhere;max-height:300px;overflow:auto;' }, warnings.join('\n'))
			: E('p', { 'class': 'cbi-section-descr' }, _('No parser or firewall warnings found in the current system log buffer.'));
		const warningCard = card(_('Recent parser and firewall messages'), E('details', {}, [
			E('summary', { 'style': 'cursor:pointer;' }, _('Historical log messages (not used for current list status)')),
			E('p', { 'class': 'cbi-section-descr' }, _('Recent matching log lines are shown for troubleshooting. This is not a complete history; the system log buffer may rotate.')),
			warningContent
		]));

		const refresh = E('button', { 'class': 'btn', 'click': () => window.location.reload() }, _('Refresh diagnostics'));
		const root = E('div', { 'style': 'max-width:1100px;margin:0 auto;' }, [
			E('div', { 'style': 'display:flex;align-items:center;justify-content:space-between;gap:12px;flex-wrap:wrap;' }, [
				E('h2', { 'style': 'margin:0;' }, _('Diagnostics')), refresh
			]),
			E('p', { 'class': 'cbi-section-descr' }, _('Read-only overview of parser output, Mihomo API and active network mode.')),
			card(_('Overall status'), summary, 'padding-bottom:5px;'),
			modeCard,
			listsCard,
			warningCard
		]);

		let polling = false;
		let lastReport = String(files[FILES.listDiagnostics] || '');
		let lastPhase = listDiagnostics.cycle.phase;
		let lastRuntime = serviceRunning == null ? null : `${serviceRunning ? 1 : 0}:${kernelRunning ? 1 : 0}`;
		let candidateRuntime = null;
		let candidateSamples = 0;
		const refreshTimer = setInterval(async () => {
			if (!root.isConnected) {
				clearInterval(refreshTimer);
				return;
			}
			if (document.hidden || polling) return;
			polling = true;
			let reload = false;
			try {
				const [currentService, currentKernel, currentReport] = await Promise.all([
					view_asclash_utils.getClashRunning().catch(() => null),
					checkKernelRunning(),
					read(FILES.listDiagnostics)
				]);
				const reportText = String(currentReport || '');
				if (reportText !== lastReport) {
					const nextPhase = parseListDiagnostics(reportText).cycle.phase;
					if (['complete', 'timeout', 'failed'].includes(nextPhase) || (nextPhase === 'waiting' && !['waiting', 'checking'].includes(lastPhase)))
						reload = true;
					lastReport = reportText;
					lastPhase = nextPhase;
				}

				if (currentService != null) {
					const runtime = `${currentService ? 1 : 0}:${currentKernel.ok ? 1 : 0}`;
					if (lastRuntime == null) {
						lastRuntime = runtime;
					} else if (runtime === lastRuntime) {
						candidateRuntime = null;
						candidateSamples = 0;
					} else {
						if (candidateRuntime !== runtime) {
							candidateRuntime = runtime;
							candidateSamples = 1;
						} else {
							candidateSamples++;
						}
						if (candidateSamples >= 2) {
							const [serviceWasRunning, kernelWasRunning] = lastRuntime.split(':').map(value => value === '1');
							const serviceNowRunning = currentService;
							const kernelNowRunning = currentKernel.ok;
							lastRuntime = runtime;
							candidateRuntime = null;
							candidateSamples = 0;
							const becameStopped = (serviceWasRunning && !serviceNowRunning) || (kernelWasRunning && !kernelNowRunning);
							const reportPending = ['waiting', 'checking'].includes(lastPhase);
							if (becameStopped || !reportPending) reload = true;
						}
					}
				}
			} finally {
				polling = false;
			}
			if (reload && root.isConnected) {
				clearInterval(refreshTimer);
				window.location.reload();
			}
		}, 5000);

		return root;
	},

	handleSaveApply: null,
	handleSave: null,
	handleReset: null
});
