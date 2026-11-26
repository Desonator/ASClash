'use strict';

const fs = require('fs');
const path = require('path');

const sourcePath = path.join(__dirname, '..', 'luci-app-asclash', 'rootfs', 'www', 'luci-static', 'resources', 'view', 'asclash', 'kernel.js');
const source = fs.readFileSync(sourcePath, 'utf8');
const start = source.indexOf('async function installKernel(url) {');
const end = source.indexOf('\nasync function readRepository', start);
if (start < 0 || end < 0) throw new Error('Could not locate installKernel');
const factory = new Function('fs', 'L', 'ui', 'E', '_', 'view_asclash_utils', `${source.slice(start, end)}\nreturn installKernel;`);

async function runInstall(verifyFails) {
	const files = new Map([['/opt/clash/bin/clash', 'old-kernel']]);
	let running = true;
	const calls = [];
	const fsMock = {
		stat: async file => files.has(file) ? { size: files.get(file).length } : null,
		exec: async (command, args) => {
			calls.push([command, ...args]);
			if (command === 'curl') return { code: 0, stderr: '' };
			if (command === 'gzip') { files.set(args[1].replace(/\.gz$/, ''), 'new-kernel'); return { code: 0, stderr: '' }; }
			if (command === '/bin/mkdir') {
				if (files.has(args[0])) return { code: 1, stderr: 'lock exists' };
				files.set(args[0], 'lock');
				return { code: 0, stderr: '' };
			}
			if (command === 'chmod') return { code: 0, stderr: '' };
			if (command === '/etc/init.d/clash' && args[0] === 'stop') { running = false; return { code: 0, stderr: '' }; }
			if (command === '/bin/mv') {
				const [src, dst] = args.slice(1);
				if (!files.has(src)) return { code: 1, stderr: 'missing source' };
				files.set(dst, files.get(src)); files.delete(src);
				return { code: 0, stderr: '' };
			}
			if (command === '/bin/rm') { for (const file of args.slice(1)) files.delete(file); return { code: 0, stderr: '' }; }
			if (command === '/opt/clash/bin/clash' && args[0] === '-v')
				return { code: verifyFails ? 1 : 0, stderr: verifyFails ? 'bad kernel' : '' };
			return { code: 0, stderr: '' };
		}
	};
	const utils = {
		getClashRunning: async () => running,
		waitForServiceStatus: async (_fn, target) => running === target,
		execDetached: async command => { calls.push(['detached', command]); if (command.endsWith('clash start')) running = true; return { code: 0 }; }
	};
	const notices = [];
	const installKernel = factory(fsMock, { resolveDefault: async (value, fallback) => value || fallback }, { addNotification: (...args) => notices.push(args) }, (...args) => args, value => value, utils);
	let error = null;
	try { await installKernel('https://example.invalid/core.gz'); }
	catch (e) { error = e; }
	return { files, running, calls, notices, error };
}

(async () => {
	const success = await runInstall(false);
	if (success.error || success.files.get('/opt/clash/bin/clash') !== 'new-kernel' || success.running)
		throw new Error(`Successful kernel installation had unexpected state: error=${success.error && success.error.message}, binary=${success.files.get('/opt/clash/bin/clash')}, running=${success.running}`);
	if (success.files.has('/tmp/mihomo-kernel-install.lock'))
		throw new Error('Successful kernel installation left its concurrency lock behind');
	if ([...success.files.keys()].some(file => file.includes('.backup-')))
		throw new Error('Successful kernel installation left the old binary backup behind');

	const failed = await runInstall(true);
	if (!failed.error || failed.files.get('/opt/clash/bin/clash') !== 'old-kernel' || !failed.running)
		throw new Error('Failed verification did not restore the previous binary and running service');
	if (failed.files.has('/tmp/mihomo-kernel-install.lock'))
		throw new Error('Failed kernel installation left its concurrency lock behind');
	if ([...failed.files.keys()].some(file => file.includes('.backup-')))
		throw new Error('Rollback left a stale backup despite a successful restore');

	console.log('Kernel install rollback tests passed.');
})().catch(e => { console.error(e); process.exitCode = 1; });
