'use strict';

const fs = require('fs');
const path = require('path');
const sourcePath = path.join(__dirname, '..', 'luci-app-asclash', 'rootfs', 'www', 'luci-static', 'resources', 'view', 'asclash', 'settings.js');
const source = fs.readFileSync(sourcePath, 'utf8');
const start = source.indexOf('function normalizeDhcpIPv4(');
const end = source.indexOf('\nasync function loadInterfacesByMode', start);
if (start < 0 || end < 0) throw new Error('Could not locate device-direct helpers');

const mockUci = {
	load: async () => {},
	sections: () => [
		{ ip: '192.168.1.110', mac: 'AA:BB:CC:DD:EE:FF', name: 'phone' },
		{ ip: '192.168.1.111', mac: 'AA:BB:CC:DD:EE:00', name: 'disabled', ignore: '1' },
		{ ip: '999.1.1.1', mac: 'AA:BB:CC:DD:EE:01', name: 'invalid' }
	]
};
const helpers = new Function('_', 'uci', `${source.slice(start, end)}\nreturn { applyManagedDirectRules, getPermanentDhcpDevices };`)(value => value, mockUci);
const config = [
	'mode: rule',
	'rules:',
	'  - RULE-SET,malware,REJECT',
	'  - IP-CIDR,203.0.113.5/32,REJECT,no-resolve',
	'  - RULE-SET,tracker,REJECT-DROP',
	'  - DOMAIN-SUFFIX,example.org,Proxy',
	'  - MATCH,Proxy',
	''
].join('\n');

const first = helpers.applyManagedDirectRules(config, ['192.168.1.110']);
const lines = first.split('\n');
const malwareIndex = lines.findIndex(line => line.includes('RULE-SET,malware'));
const cidrRejectIndex = lines.findIndex(line => line.includes('203.0.113.5/32,REJECT'));
const trackerIndex = lines.findIndex(line => line.includes('RULE-SET,tracker'));
const managedIndex = lines.findIndex(line => line.includes('SRC-IP-CIDR,192.168.1.110/32,DIRECT'));
const domainIndex = lines.findIndex(line => line.includes('DOMAIN-SUFFIX,example.org'));
if (!(malwareIndex < cidrRejectIndex && cidrRejectIndex < trackerIndex && trackerIndex < managedIndex && managedIndex < domainIndex))
	throw new Error('Managed DIRECT rule was not placed after rejects and before regular routing rules');

const replaced = helpers.applyManagedDirectRules(first, ['192.168.1.111']);
if (replaced.includes('192.168.1.110/32') || (replaced.match(/ASCLASH:DEVICE-DIRECT-BEGIN/g) || []).length !== 1)
	throw new Error('Updating selected devices left an old or duplicate generated block');

const removed = helpers.applyManagedDirectRules(replaced, []);
if (removed.includes('ASCLASH:DEVICE-DIRECT'))
	throw new Error('Clearing the selection did not remove the generated block');

const unsafeOrder = ['rules:', '  - DOMAIN-SUFFIX,example.org,Proxy', '  - RULE-SET,malware,REJECT', ''].join('\n');
let rejectedUnsafeOrder = false;
try { helpers.applyManagedDirectRules(unsafeOrder, ['192.168.1.110']); }
catch (e) { rejectedUnsafeOrder = /Move all REJECT/.test(e.message); }
if (!rejectedUnsafeOrder)
	throw new Error('A later REJECT rule was not protected from being shadowed');

(async () => {
	const devices = await helpers.getPermanentDhcpDevices();
	if (devices.length !== 1 || devices[0].ip !== '192.168.1.110')
		throw new Error('DHCP host parsing included an ignored or invalid reservation');
	console.log('Managed DIRECT rule editing and DHCP reservation tests passed.');
})().catch(e => { console.error(e); process.exitCode = 1; });
