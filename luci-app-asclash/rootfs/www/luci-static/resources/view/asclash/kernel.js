'use strict';
'require view';
'require fs';
'require ui';
'require view.asclash.utils';

const OFFICIAL_REPO = 'MetaCubeX/mihomo';
const PRIZRAK_REPO = 'legiz-ru/Prizrak-Core';
const REPO_PATTERN = /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/;

function isRussianUi() {
	const lang = String((L.env && L.env.lang) || document.documentElement.lang || navigator.language || '').toLowerCase();
	return lang.startsWith('ru') || _('Mihomo Kernel Management') === 'Управление ядром Mihomo';
}

function localized(english, russian) {
	return isRussianUi() ? russian : _(english);
}

async function detectArchitecture() {
	try {
		const release = await L.resolveDefault(fs.read('/etc/openwrt_release'), '');
		const match = release.match(/^DISTRIB_ARCH='([^']*)'/m);
		const arch = match ? match[1] : '';
		if (arch.startsWith('aarch64_')) return 'arm64';
		if (arch === 'x86_64') return 'amd64';
		if (arch.startsWith('i386_')) return '386';
		if (arch.startsWith('riscv64_')) return 'riscv64';
		if (arch.startsWith('loongarch64_')) return 'loong64';
		if (arch.startsWith('arm_') && arch.includes('cortex-a')) return 'armv7';
		if (arch.includes('_neon-vfp')) return 'armv7';
		if (arch.includes('_neon') || arch.includes('_vfp')) return 'armv6';
		if (arch.startsWith('arm_')) return 'armv5';
		if (arch.startsWith('mips64el_')) return 'mips64le';
		if (arch.startsWith('mips64_')) return 'mips64';
		if (arch.startsWith('mipsel_')) return arch.includes('hardfloat') ? 'mipsle-hardfloat' : 'mipsle-softfloat';
		if (arch.startsWith('mips_')) return arch.includes('hardfloat') ? 'mips-hardfloat' : 'mips-softfloat';
	} catch (e) {
		console.error('Failed to detect system architecture:', e);
	}
	ui.addNotification(null, E('p', _('Could not determine system architecture; falling back to amd64.')), 'warning');
	return 'amd64';
}

function downloadArchitecture(arch) {
	return arch === 'amd64' ? 'amd64-compatible' : arch;
}

async function latestRelease(repo) {
	if (!REPO_PATTERN.test(repo)) throw new Error(_('Invalid GitHub repository. Use owner/repository format.'));
	const response = await fetch(`https://api.github.com/repos/${repo}/releases/latest`, {
		headers: { 'Accept': 'application/vnd.github+json' }
	});
	if (!response.ok) throw new Error(_('HTTP %d: %s').format(response.status, response.statusText));
	const data = await response.json();
	if (data.prerelease) throw new Error(_('Latest release is a pre-release'));
	return { version: data.tag_name, assets: data.assets || [], repo };
}

function findAsset(release, arch) {
	if (!release || !Array.isArray(release.assets)) return null;
	if (release.repo.toLowerCase() === OFFICIAL_REPO.toLowerCase()) {
		const name = `mihomo-linux-${arch}-${release.version}.gz`;
		return release.assets.find(asset => asset.name === name) || null;
	}
	const candidates = ({
		'amd64-compatible': ['amd64-v1', 'amd64-compatible'], amd64: ['amd64-v1', 'amd64-compatible'],
		arm64: ['arm64'], armv7: ['armv7'], armv6: ['armv6'], armv5: ['armv5'],
		'mips-softfloat': ['mips-softfloat'], 'mips-hardfloat': ['mips-hardfloat'],
		'mipsle-softfloat': ['mipsle-softfloat'], 'mipsle-hardfloat': ['mipsle-hardfloat'],
		mips64: ['mips64'], mips64le: ['mips64le'], riscv64: ['riscv64'], loong64: ['loong64']
	})[arch] || [arch];
	const project = release.repo.split('/')[1].toLowerCase();
	for (const candidate of candidates) {
		const names = [`${project}-linux-${candidate}-${release.version}.gz`, `mihomo-linux-${candidate}-${release.version}.gz`];
		const exact = release.assets.find(asset => names.includes(asset.name));
		if (exact) return exact;
		const suffix = `-linux-${candidate}-${release.version}.gz`;
		const matches = release.assets.filter(asset => asset.name.endsWith(suffix) && !asset.name.toLowerCase().includes('compressed'));
		if (matches.length === 1) return matches[0];
	}
	return null;
}

async function saveRepository(repo) {
	if (!REPO_PATTERN.test(repo)) throw new Error(_('Invalid GitHub repository. Use owner/repository format.'));
	const current = await L.resolveDefault(fs.read('/opt/clash/settings'), '');
	const lines = current.split(/\r?\n/).filter(line => !/^MIHOMO_RELEASE_REPO=/.test(line));
	lines.push(`MIHOMO_RELEASE_REPO=${repo}`);
	await fs.write('/opt/clash/settings', lines.filter((line, index, all) => line || index < all.length - 1).join('\n') + '\n');
}

function normalizeVersion(value) {
	const match = String(value || '').trim().match(/v?(\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?)/);
	return match ? match[1] : String(value || '').trim().replace(/^v/i, '');
}

async function installedStatus() {
	const path = '/opt/clash/bin/clash';
	const stat = await L.resolveDefault(fs.stat(path), null);
	if (!stat) return { installed: false, version: null };
	try {
		const result = await fs.exec(path, ['-v']);
		const output = (result.stdout || result.stderr || '').trim();
		const match = output.match(/v?\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?/i);
		if (match) return { installed: true, version: match[0] };
		if (output.toLowerCase().includes('mihomo')) return { installed: true, version: output.split('\n')[0].slice(0, 90) };
	} catch (e) {}
	return { installed: true, version: _('Installed (%dMB)').format(Math.round(stat.size / 1024 / 1024)) };
}

async function updateRuntimeBadgesLegacy(serviceBadge, kernelBadge) {
	const badgeStyle = 'display:inline-block;padding:4px 10px;border-radius:3px;font-size:12px;font-weight:bold;text-transform:uppercase;color:#fff;margin:0;';
	serviceBadge.textContent = localized('Checking...', 'Проверка...');
	kernelBadge.textContent = localized('Checking...', 'Проверка...');
	serviceBadge.style.cssText = badgeStyle + 'background-color:#777;';
	kernelBadge.style.cssText = badgeStyle + 'background-color:#777;';
	const kernelExecutable = '/opt/clash/bin/clash';
	const findKernelProcess = `for exe in /proc/[0-9]*/exe; do [ "$(readlink "$exe" 2>/dev/null)" = "${kernelExecutable}" ] && exit 0; done; exit 1`;
	const [serviceRunning, kernelResult] = await Promise.all([
		view_asclash_utils.getClashRunning(),
		fs.exec('/bin/sh', ['-c', findKernelProcess]).catch(() => ({ code: 1 }))
	]);
	serviceBadge.textContent = serviceRunning ? localized('Service is running', 'Служба запущена') : localized('Service is stopped', 'Служба остановлена');
	serviceBadge.style.backgroundColor = serviceRunning ? '#5cb85c' : '#d9534f';
	const kernelRunning = kernelResult.code === 0;
	kernelBadge.textContent = kernelRunning ? localized('Kernel process is running', 'Ядро запущено') : localized('Kernel process is stopped', 'Ядро остановлено');
	kernelBadge.style.backgroundColor = kernelRunning ? '#5cb85c' : '#d9534f';
	return { serviceRunning: !!serviceRunning, kernelRunning };
}

async function updateRuntimeBadges(serviceBadge, kernelBadge) {
	const badgeStyle = 'display:inline-block;padding:4px 10px;border-radius:3px;font-size:12px;font-weight:bold;text-transform:uppercase;color:#fff;margin:0;';
	if (!serviceBadge.dataset.initialized) {
		serviceBadge.textContent = localized('Checking...', 'Проверка...');
		kernelBadge.textContent = localized('Checking...', 'Проверка...');
		serviceBadge.style.cssText = badgeStyle + 'background-color:#777;';
		kernelBadge.style.cssText = badgeStyle + 'background-color:#777;';
	}
	const kernelExecutable = '/opt/clash/bin/clash';
	const findKernelProcess = `for exe in /proc/[0-9]*/exe; do [ "$(readlink "$exe" 2>/dev/null)" = "${kernelExecutable}" ] && exit 0; done; exit 1`;
	const [serviceRunning, kernelResult] = await Promise.all([
		view_asclash_utils.getClashRunning(),
		fs.exec('/bin/sh', ['-c', findKernelProcess]).catch(() => ({ code: 1 }))
	]);
	const kernelRunning = kernelResult.code === 0;
	const serviceText = serviceRunning ? localized('Service is running', 'Служба запущена') : localized('Service is stopped', 'Служба остановлена');
	const kernelText = kernelRunning ? localized('Kernel process is running', 'Ядро запущено') : localized('Kernel process is stopped', 'Ядро остановлено');
	if (serviceBadge.textContent !== serviceText) serviceBadge.textContent = serviceText;
	if (kernelBadge.textContent !== kernelText) kernelBadge.textContent = kernelText;
	serviceBadge.style.backgroundColor = serviceRunning ? '#5cb85c' : '#d9534f';
	kernelBadge.style.backgroundColor = kernelRunning ? '#5cb85c' : '#d9534f';
	serviceBadge.dataset.initialized = 'true';
	kernelBadge.dataset.initialized = 'true';
	return { serviceRunning: !!serviceRunning, kernelRunning };
}

async function installKernel(url) {
	const token = Date.now() + '-' + Math.random().toString(36).slice(2);
	const path = '/tmp/mihomo-kernel-' + token + '.gz';
	const extracted = '/tmp/mihomo-kernel-' + token;
	const installLock = '/tmp/mihomo-kernel-install.lock';
	const target = '/opt/clash/bin/clash';
	const backup = target + '.backup-' + token;
	const lockResult = await fs.exec('/bin/mkdir', [installLock]);
	if (lockResult.code !== 0) throw new Error(_('Another kernel installation is already running.'));
	let hadPreviousBinary = false;
	let serviceWasRunning = false;
	let backupCreated = false;
	let newBinaryInstalled = false;
	try {
		hadPreviousBinary = !!await L.resolveDefault(fs.stat(target), null);
		serviceWasRunning = await view_asclash_utils.getClashRunning();
		ui.addNotification(null, E('p', _('Downloading Mihomo kernel...')), 'info');
		const curl = await fs.exec('curl', ['-fL', '--retry', '2', '--connect-timeout', '15', '--max-time', '300', url, '-o', path]);
		if (curl.code !== 0) throw new Error((curl.stderr || '').trim() || _('Download failed'));
		const extract = await fs.exec('gzip', ['-df', path]);
		if (extract.code !== 0) throw new Error((extract.stderr || '').trim() || _('Extraction failed'));
		const chmodStaged = await fs.exec('chmod', ['0755', extracted]);
		if (chmodStaged.code !== 0) throw new Error((chmodStaged.stderr || '').trim() || _('Failed to set executable permissions'));

		const stop = await fs.exec('/etc/init.d/clash', ['stop']);
		if (stop.code !== 0) throw new Error((stop.stderr || '').trim() || _('Failed to stop Clash before replacing the kernel.'));
		if (!(await view_asclash_utils.waitForServiceStatus(view_asclash_utils.getClashRunning, false, 30000)))
			throw new Error(_('Could not confirm that the Clash service stopped; the kernel was not replaced.'));

		if (hadPreviousBinary) {
			const moveOld = await fs.exec('/bin/mv', ['-f', target, backup]);
			if (moveOld.code !== 0) throw new Error((moveOld.stderr || '').trim() || _('Failed to preserve the previous kernel binary'));
			backupCreated = true;
		}

		const moveNew = await fs.exec('/bin/mv', ['-f', extracted, target]);
		if (moveNew.code !== 0) throw new Error((moveNew.stderr || '').trim() || _('Failed to install new binary'));
		newBinaryInstalled = true;
		const verify = await fs.exec(target, ['-v']);
		if (verify.code !== 0) throw new Error(_('Installed binary failed its version check'));

		if (backupCreated) {
			const removeBackup = await fs.exec('/bin/rm', ['-f', backup]);
			if (removeBackup.code === 0) backupCreated = false;
			else ui.addNotification(null, E('p', _('Kernel was installed, but the previous binary backup could not be removed: %s').format(backup)), 'warning');
		}
		ui.addNotification(null, E('p', _('Kernel installed. The Clash service was stopped; restart it to activate the new version.')), 'info');
	} catch (e) {
		const recoveryErrors = [];
		if (newBinaryInstalled) {
			const removeNew = await fs.exec('/bin/rm', ['-f', target]);
			if (removeNew.code !== 0) recoveryErrors.push(_('Could not remove the failed kernel binary.'));
		} else if (!hadPreviousBinary && !backupCreated) {
			// A cross-filesystem mv may fail after creating a partial destination.
			await fs.exec('/bin/rm', ['-f', target]);
		}
		if (backupCreated) {
			const restoreOld = await fs.exec('/bin/mv', ['-f', backup, target]);
			if (restoreOld.code === 0) backupCreated = false;
			else recoveryErrors.push(_('Could not restore the previous kernel binary; backup remains at %s.').format(backup));
		}
		if (serviceWasRunning && !await view_asclash_utils.getClashRunning() && (!hadPreviousBinary || !backupCreated)) {
			try {
				await view_asclash_utils.execDetached('/etc/init.d/clash start');
				if (!(await view_asclash_utils.waitForServiceStatus(view_asclash_utils.getClashRunning, true, 30000)))
					recoveryErrors.push(_('Previous Clash service could not be restarted.'));
			} catch (restartError) {
				recoveryErrors.push(_('Previous Clash service could not be restarted: %s').format(restartError.message || String(restartError)));
			}
		}
		if (recoveryErrors.length) e.message = (e.message || String(e)) + ' ' + recoveryErrors.join(' ');
		throw e;
	} finally {
		try { await fs.exec('/bin/rm', ['-f', path, extracted]); } catch (_e) {}
		try {
			const unlock = await fs.exec('/bin/rm', ['-rf', installLock]);
			if (unlock.code !== 0)
				ui.addNotification(null, E('p', _('Could not release the kernel installation lock; remove %s before retrying.').format(installLock)), 'warning');
		} catch (_e) {
			ui.addNotification(null, E('p', _('Could not release the kernel installation lock; remove %s before retrying.').format(installLock)), 'warning');
		}
	}
}

async function readRepository() {
	const settings = await L.resolveDefault(fs.read('/opt/clash/settings'), '');
	const match = settings.match(/^MIHOMO_RELEASE_REPO=(.+)$/m);
	return match && REPO_PATTERN.test(match[1].trim()) ? match[1].trim() : OFFICIAL_REPO;
}

function createKernelManagementSection() {
	const light = view_asclash_utils.isLightTheme();
	const text = light ? '#1f2937' : '#d1d5db';
	const muted = light ? '#4b5563' : '#9ca3af';
	const card = light ? '#f9f9f9' : 'rgba(255,255,255,0.04)';
	const border = light ? '#ddd' : '#444';
	const container = E('section', { 'class': 'cbi-section' });
	const serviceBadge = E('span', { 'aria-live': 'polite' }, localized('Checking...', 'Проверка...'));
	const kernelBadge = E('span', { 'aria-live': 'polite' }, localized('Checking...', 'Проверка...'));
	container.appendChild(E('div', { style: 'display:flex;align-items:center;gap:10px;flex-wrap:wrap;' }, [
		E('h2', { style: 'margin:0;' }, _('Mihomo Kernel Management')),
		serviceBadge,
		kernelBadge
	]));
	container.appendChild(E('div', { 'class': 'cbi-section-descr' }, _('Download and manage the Mihomo (Clash Meta) kernel binary.')));
	const sourceSelect = E('select', { 'class': 'cbi-input-select' }, [
		E('option', { value: 'official' }, localized('Official Mihomo', 'Официальный Mihomo')),
		E('option', { value: 'prizrak' }, _('Prizrak-Core')),
		E('option', { value: 'custom' }, localized('Custom GitHub release', 'Свой релиз GitHub'))
	]);
	const repoInput = E('input', { type: 'text', class: 'cbi-input-text', placeholder: 'owner/repository', style: 'min-width: 220px;' });
	const saveButton = E('button', { class: 'btn' }, localized('Save release source', 'Сохранить источник'));
	const status = E('div', { style: `margin: 15px 0; padding: 12px; border: 1px solid ${border}; border-radius: 4px; background: ${card}; color: ${text};` });
	const statusContent = E('div', {}, localized('Checking kernel status...', 'Проверка состояния ядра...'));
	const downloadButton = E('button', { class: 'btn' }, _('Download Latest Kernel'));
	const refreshButton = E('button', { class: 'btn', style: 'margin-left: 10px;' }, _('Refresh Status'));
	const restartButton = E('button', { class: 'btn', style: 'margin-left: 10px;' }, localized('Restart Service', 'Перезапустить службу'));
	const actions = E('div', { style: 'margin: 12px 0 20px; text-align: center;' }, [downloadButton, refreshButton, restartButton]);
	const notice = E('div', { style: `margin: 12px 0 6px; padding: 8px 12px; background: ${light ? '#fff3cd' : 'rgba(255,193,7,0.12)'}; border-left: 4px solid #ffc107; border-radius: 4px; font-size: 12px; color: ${light ? '#856404' : '#fcd34d'};` }, localized(
		'Restart Clash service after installing or updating the kernel',
		'Перезапустите службу Clash после установки или обновления ядра'
	));
	status.append(statusContent, notice);
	container.appendChild(E('div', { style: 'display:flex; align-items:center; gap:8px; flex-wrap:wrap; margin:12px 0;' }, [
		E('label', { class: 'cbi-value-title', style: 'width:auto;' }, localized('Release source', 'Источник релизов')), sourceSelect, repoInput, saveButton
	]));
	container.appendChild(status);
	container.appendChild(actions);

	let badgesUpdating = false;
	let previousRuntimeState = null;
	let candidateRuntimeState = null;
	let candidateRuntimeSamples = 0;
	async function refreshRuntimeState() {
		if (badgesUpdating || !container.isConnected) return;
		badgesUpdating = true;
		try {
			const current = await updateRuntimeBadges(serviceBadge, kernelBadge);
			const signature = `${current.serviceRunning ? 1 : 0}:${current.kernelRunning ? 1 : 0}`;
			if (previousRuntimeState === null) {
				previousRuntimeState = signature;
			} else if (signature === previousRuntimeState) {
				candidateRuntimeState = null;
				candidateRuntimeSamples = 0;
			} else {
				if (candidateRuntimeState !== signature) {
					candidateRuntimeState = signature;
					candidateRuntimeSamples = 1;
				} else {
					candidateRuntimeSamples++;
				}
				if (candidateRuntimeSamples >= 2) {
					const [oldService, oldKernel] = previousRuntimeState.split(':').map(value => value === '1');
					previousRuntimeState = signature;
					candidateRuntimeState = null;
					candidateRuntimeSamples = 0;
					if ((!oldService && current.serviceRunning) || (!oldKernel && current.kernelRunning))
						window.location.reload();
				}
			}
		} finally {
			badgesUpdating = false;
		}
	}
	refreshRuntimeState();
	const badgePollTimer = setInterval(() => {
		if (!container.isConnected) {
			clearInterval(badgePollTimer);
			return;
		}
		if (!document.hidden) refreshRuntimeState();
	}, 5000);

	let repo = OFFICIAL_REPO;
	async function refresh() {
		refreshRuntimeState();
		downloadButton.disabled = true;
		downloadButton.textContent = _('Checking...');
		try {
			const [installed, arch, release] = await Promise.all([installedStatus(), detectArchitecture(), latestRelease(repo)]);
			const rows = [];
			rows.push(E('div', {
				style: `color:${installed.installed ? '#28a745' : '#dc3545'};font-weight:bold`
			}, `${installed.installed ? '✅' : '❌'} ${_('Kernel Status')}: ${installed.installed ? _('Installed') : _('Not Installed')}`));
			if (installed.installed)
				rows.push(E('div', { style: 'margin-top:5px' }, `📦 ${_('Version')}: ${installed.version}`));
			rows.push(E('div', { style: 'margin-top:5px' }, `🏗️ ${_('System Architecture')}: ${arch}`));
			if (release) {
				rows.push(E('div', { style: 'margin-top:5px' }, `🚀 ${_('Latest Available')}: ${release.version}`));
				const upToDate = installed.installed && normalizeVersion(installed.version) === normalizeVersion(release.version);
				if (upToDate)
					rows.push(E('div', { style: 'margin-top:5px;color:#28a745' }, `✨ ${_('Kernel is up to date')}`));
				downloadButton.textContent = installed.installed ? (upToDate ? _('Reinstall Kernel') : _('Download Update')) : _('Download Latest Kernel');
				downloadButton.disabled = false;
			} else {
				rows.push(E('div', { style: 'margin-top:5px;color:#dc3545' }, `❌ ${_('Failed to check latest version')}`));
				downloadButton.textContent = installed.installed ? _('Reinstall Kernel') : _('Download Latest Kernel');
			}
			statusContent.replaceChildren(...rows);
		} catch (e) {
			statusContent.textContent = _('Failed to check kernel status: %s').format(e.message);
			downloadButton.textContent = _('Download Latest Kernel');
		} finally {
			if (!statusContent.textContent.includes(_('Failed to check kernel status'))) downloadButton.disabled = false;
		}
	}
	readRepository().then(value => {
		repo = value;
		const normalizedRepo = repo.toLowerCase();
		const source = normalizedRepo === OFFICIAL_REPO.toLowerCase() ? 'official'
			: normalizedRepo === PRIZRAK_REPO.toLowerCase() ? 'prizrak' : 'custom';
		sourceSelect.value = source;
		repoInput.value = source === 'custom' ? repo : '';
		repoInput.style.display = source === 'custom' ? '' : 'none';
		refresh();
	}).catch(refresh);
	sourceSelect.addEventListener('change', () => { repoInput.style.display = sourceSelect.value === 'custom' ? '' : 'none'; });
	saveButton.addEventListener('click', async () => {
		const nextRepo = sourceSelect.value === 'official' ? OFFICIAL_REPO
			: sourceSelect.value === 'prizrak' ? PRIZRAK_REPO : repoInput.value.trim();
		if (!REPO_PATTERN.test(nextRepo)) {
			ui.addNotification(null, E('p', _('Enter a GitHub repository as owner/repository.')), 'error');
			return;
		}
		saveButton.disabled = true;
		try {
			await saveRepository(nextRepo);
			repo = nextRepo;
			ui.addNotification(null, E('p', _('Release source saved: %s').format(repo)), 'success');
			await refresh();
		} catch (e) {
			ui.addNotification(null, E('p', _('Failed to save release source: %s').format(e.message)), 'error');
		} finally { saveButton.disabled = false; }
	});
	downloadButton.addEventListener('click', async () => {
		downloadButton.disabled = true;
		downloadButton.textContent = _('Downloading...');
		try {
			const arch = downloadArchitecture(await detectArchitecture());
			const release = await latestRelease(repo);
			const asset = findAsset(release, arch);
			if (!asset) throw new Error(_('No compatible binary found for architecture %s in %s').format(arch, repo));
			await installKernel(asset.browser_download_url);
			await refresh();
		} catch (e) {
			ui.addNotification(null, E('p', _('Download failed: %s').format(e.message)), 'error');
		} finally { downloadButton.disabled = false; }
	});
	refreshButton.addEventListener('click', () => refresh());
	restartButton.addEventListener('click', async function() {
		this.disabled = true;
		try {
			const progressBefore = await view_asclash_utils.getListProgress();
			await view_asclash_utils.execDetached('/etc/init.d/clash restart');
			ui.addNotification(null, E('p', _('Clash is restarting; firewall lists will be rebuilt and applied.')), 'info');
			view_asclash_utils.monitorListProgress(progressBefore);
			const [restarted, progress] = await Promise.all([
				view_asclash_utils.waitForServiceStatus(view_asclash_utils.getClashRunning, true),
				view_asclash_utils.waitForListProgress(progressBefore, 90000)
			]);
			if (!restarted) {
				ui.addNotification(null, E('p', localized(
					'Service is still restarting — it may take longer on a slow connection. Reload the page in a moment to check its status.',
					'Служба ещё перезапускается. Подождите немного и обновите страницу, чтобы проверить её состояние.'
				)), 'warning');
				return;
			}
			if (!progress) {
				ui.addNotification(null, E('p', _('The service restarted, but list application could not be confirmed yet. Check Diagnostics and the system log.')), 'warning');
				return;
			}
			if (progress.phase === 'failed') return;
			ui.addNotification(null, E('p', localized('Clash service restarted successfully.', 'Служба успешно перезапущена.')), 'info');
			await refresh();
		} catch (e) {
			ui.addNotification(null, E('p', _('Failed to restart Clash service: %s').format(e.message)), 'error');
		} finally {
			this.disabled = false;
		}
	});
	return container;
}

return L.Class.extend({ createKernelManagementSection: createKernelManagementSection });
