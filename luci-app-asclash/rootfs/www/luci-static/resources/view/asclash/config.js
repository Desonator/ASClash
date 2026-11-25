'use strict';
'require view';
'require fs';
'require ui';
'require view.asclash.utils';

let startStopButton = null;
let restartButton = null;
let editor = null;

view_asclash_utils.bumpRpcTimeout();

const getServiceStatus = function() {
    return view_asclash_utils.getClashRunning();
};

async function dispatchServiceActions(actions) {
    const script = actions.map(function(action) {
        return '/etc/init.d/clash ' + action;
    }).join('; ');
    try {
        await view_asclash_utils.execDetached(script);
    } catch (e) {
        console.warn('Failed to dispatch clash service action:', e.message);
    }
}

function notifyRestartPending() {
    ui.addNotification(null, E('p',
        _('Service is still restarting — it may take longer on a slow connection. Reload the page in a moment to check its status.')
    ), 'warning');
}

function watchListProgress(previous) {
	view_asclash_utils.monitorListProgress(previous);
}

async function toggleService() {
    if (startStopButton) startStopButton.disabled = true;
    try {
        const running = await getServiceStatus();
        const target = !running;
        const progressBefore = target ? await view_asclash_utils.getListProgress() : '';
        if (running) {
            await dispatchServiceActions(['stop', 'disable']);
        } else {
            await dispatchServiceActions(['start', 'enable']);
            ui.addNotification(null, E('p', _('Clash is starting; firewall lists will be rebuilt and applied.')), 'info');
            watchListProgress(progressBefore);
        }

        if (await view_asclash_utils.waitForServiceStatus(getServiceStatus, target)) {
            if (target) {
                const progress = await view_asclash_utils.waitForListProgress(progressBefore, 90000);
                if (!progress)
                    ui.addNotification(null, E('p', _('The service started, but list application could not be confirmed yet. Check Diagnostics and the system log.')), 'warning');
                if (startStopButton) startStopButton.textContent = _('Stop Service');
            } else {
                window.location.reload();
            }
        } else {
            notifyRestartPending();
        }
    } finally {
        if (startStopButton) startStopButton.disabled = false;
    }
}

async function restartService() {
    if (restartButton) restartButton.disabled = true;
    if (startStopButton) startStopButton.disabled = true;
    try {
        const wasRunning = await getServiceStatus();
        const progressBefore = await view_asclash_utils.getListProgress();
        await view_asclash_utils.execDetached('/etc/init.d/clash restart');
        ui.addNotification(null, E('p', _('Clash is restarting; firewall lists will be rebuilt and applied.')), 'info');
        watchListProgress(progressBefore);

        if (wasRunning && !await view_asclash_utils.waitForServiceStatus(getServiceStatus, false, 15000)) {
            notifyRestartPending();
            return;
        }
        const running = await view_asclash_utils.waitForServiceStatus(getServiceStatus, true, 90000);
        if (!running) {
            notifyRestartPending();
            return;
        }

        if (startStopButton) startStopButton.textContent = _('Stop Service');
        ui.addNotification(null, E('p', _('Clash service restarted successfully.')), 'info');
    } catch (e) {
        ui.addNotification(null, E('p', _('Failed to restart Clash service: %s').format(e.message)), 'error');
    } finally {
        if (restartButton) restartButton.disabled = false;
        if (startStopButton) startStopButton.disabled = false;
    }
}

function parseYamlValue(yaml, key) {
    const escapedKey = key.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    const re = new RegExp(`^\\s*${escapedKey}\\s*:\\s*(["\']?)([^#\\r\\n]+?)\\1\\s*(?:#.*)?$`, 'm');
    const m = yaml.match(re);
    return m ? m[2].trim() : null;
}

async function getConfigValidatorInfo() {
    let selectedRepo = 'MetaCubeX/mihomo';
    let coreOutput = '';
    try {
        const settings = await L.resolveDefault(fs.read('/opt/clash/settings'), '');
        const match = settings.match(/^MIHOMO_RELEASE_REPO=([^\r\n]+)$/m);
        if (match && /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(match[1].trim()))
            selectedRepo = match[1].trim();
    } catch (_e) {}
    try {
        const result = await fs.exec('/opt/clash/bin/clash', ['-v']);
        coreOutput = `${result.stdout || ''}\n${result.stderr || ''}`.trim();
    } catch (_e) {}

    const isPrizrakBinary = /prizrak[- ]core/i.test(coreOutput);
    // Some Prizrak-Core builds report the upstream "Mihomo Meta" name from
    // -v. The saved release repository is therefore also an explicit source
    // marker for identifying the installed custom core, as requested.
    const isPrizrakSource = /prizrak-core/i.test(selectedRepo);
    const isPrizrak = isPrizrakSource || isPrizrakBinary;
    const versionMatch = coreOutput.match(/v\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?/i);
    const coreName = isPrizrakSource ? 'Prizrak-Core (configured source)' : (isPrizrakBinary ? 'Prizrak-Core' : 'Mihomo');
    const expectedPrizrak = isPrizrakSource;
    return {
        selectedRepo,
        installedName: coreName,
        installedVersion: versionMatch ? versionMatch[0] : '',
        isPrizrak,
        sourceMismatch: !expectedPrizrak && isPrizrakBinary,
        detected: !!coreOutput
    };
}

function normalizeHostPortFromAddr(addr, fallbackHost, fallbackPort) {
    if (!addr) return { host: fallbackHost, port: fallbackPort };
    const cleaned = addr.replace(/["']/g, '').trim();
    const hostPort = cleaned.replace(/^\[|\]$/g, '');
    const lastColon = hostPort.lastIndexOf(':');
    let host = fallbackHost, port = fallbackPort;
    if (lastColon !== -1) {
        host = hostPort.slice(0, lastColon);
        port = hostPort.slice(lastColon + 1);
    }
    if (host === '0.0.0.0' || host === '::' || host === '') {
        host = fallbackHost;
    }
    return { host, port };
}

function computeUiPath(externalUiName, externalUi) {
    if (externalUiName) {
        const name = externalUiName.replace(/(^\/+|\/+$)/g, '');
        return `/${name}/`;
    }
    if (externalUi && !/[\/\\\.]/.test(externalUi)) {
        const name = externalUi.trim();
        return `/${name}/`;
    }
    return '/ui/';
}

async function openDashboard() {
    try {
        if (!(await getServiceStatus())) {
            ui.addNotification(null, E('p', _('Service is not running.')), 'error');
            return;
        }

        const config = await fs.read('/opt/clash/config.yaml');
        const ec = parseYamlValue(config, 'external-controller');
        const ecTls = parseYamlValue(config, 'external-controller-tls');
        const secret = parseYamlValue(config, 'secret');
        const externalUi = parseYamlValue(config, 'external-ui');
        const externalUiName = parseYamlValue(config, 'external-ui-name');

        const baseHost = window.location.hostname;
        const basePort = '9090';
        const useTls = !!ecTls;

        const { host, port } = normalizeHostPortFromAddr(useTls ? ecTls : ec, baseHost, basePort);
        const scheme = useTls ? 'https:' : 'http:';
        const uiPath = computeUiPath(externalUiName, externalUi);

        const qp = new URLSearchParams();
        if (secret) qp.set('secret', secret);
        qp.set('hostname', host);
        qp.set('port', port);
        const url = `${scheme}//${host}:${port}${uiPath}?${qp.toString()}`;

        const newWindow = window.open(url, '_blank');
        if (!newWindow) {
            ui.addNotification(null, E('p', _('Popup was blocked. Please allow popups for this site.')), 'warning');
        }
    } catch (error) {
        console.error(_('Error opening dashboard:'), error);
        ui.addNotification(null, E('p', _('Failed to open dashboard: %s').format(error.message)), 'error');
    }
}

function loadScript(src) {
    return new Promise((resolve, reject) => {
        const script = document.createElement('script');
        script.src = src;
        script.onload = resolve;
        script.onerror = reject;
        document.head.appendChild(script);
    });
}

async function initializeAceEditor(content) {
    await loadScript('/luci-static/resources/view/asclash/ace/ace.js');
    ace.config.set('basePath', '/luci-static/resources/view/asclash/ace/');
    editor = ace.edit("editor");
    editor.setTheme("ace/theme/tomorrow_night_bright");
    editor.session.setMode("ace/mode/yaml");
    editor.setValue(content);
    editor.clearSelection();
    editor.setOptions({
        fontSize: "12px",
        showPrintMargin: false,
        wrap: true
    });
}

// =============================================================================
// SECTION: ASClash version / release update footer helpers
// =============================================================================

// Keep in sync with luci-app-asclash/Makefile PKG_VERSION
const ASCLASH_VERSION = '4.8.2.7';

const ASCLASH_REPO = 'Desonator/ASClash';
const ASCLASH_RELEASES_URL = 'https://github.com/' + ASCLASH_REPO + '/releases';
const ASCLASH_LATEST_API  = 'https://api.github.com/repos/' + ASCLASH_REPO + '/releases/latest';
const UPSTREAM_AUTHOR_URL  = 'https://zerolab.net';
const UPSTREAM_DONATE_URL  = 'https://zerolab.net/donate/';

function parseSemver(s) {
    const m = (s || '').match(/v?(\d+)\.(\d+)\.(\d+)(?:\.(\d+))?/);
    return m ? [+m[1], +m[2], +m[3], +(m[4] || 0)] : null;
}

function cmpSemver(a, b) {
    const pa = parseSemver(a), pb = parseSemver(b);
    if (!pa || !pb) return 0;
    for (let i = 0; i < 4; i++) if (pa[i] !== pb[i]) return pa[i] - pb[i];
    return 0;
}

async function getLatestASClashRelease() {
    try {
        const resp = await fetch(ASCLASH_LATEST_API);
        if (!resp.ok) return null;
        const d = await resp.json();
        if (d.prerelease) return null;
        return { version: d.tag_name, url: d.html_url || ASCLASH_RELEASES_URL };
    } catch (_e) {
        return null;
    }
}

return view.extend({
    load: function() {
        return L.resolveDefault(fs.read('/opt/clash/config.yaml'), '');
    },
    render: async function(config) {
        const running = await getServiceStatus();
        const validatorInfo = await getConfigValidatorInfo();
        const isRussianUI = String((L.env && L.env.lang) || document.documentElement.lang || navigator.language || '').toLowerCase().startsWith('ru');
        const validatorNoticeContent = [
            E('div', {}, [
                E('strong', {}, isRussianUI ? 'Проверяющее ядро: ' : 'Validator core: '),
                validatorInfo.detected
                    ? `${validatorInfo.installedName}${validatorInfo.installedVersion ? ' ' + validatorInfo.installedVersion : ''}`
                    : (isRussianUI ? 'не удалось определить' : 'could not detect')
            ]),
            E('div', { 'style': 'margin-top: 3px;' }, [
                E('strong', {}, isRussianUI ? 'Источник для следующей загрузки: ' : 'Source for the next download: '),
                validatorInfo.selectedRepo
            ]),
        ];
        if (validatorInfo.sourceMismatch) {
            validatorNoticeContent.push(E('div', { 'style': 'margin-top: 4px; color: #b07800; font-weight: 600;' },
                isRussianUI
                    ? (validatorInfo.isPrizrak
                        ? 'Выбран официальный Mihomo, но сейчас установлено Prizrak-Core. Валидатор всё равно использует установленный Prizrak-Core.'
                        : 'Выбран Prizrak-Core, но сейчас установлено не это ядро. Специальные параметры Prizrak-Core пройдут проверку только после установки Prizrak-Core.')
                    : (validatorInfo.isPrizrak
                        ? 'Official Mihomo is selected, but Prizrak-Core is installed. Validation still uses the installed Prizrak-Core binary.'
                        : 'Prizrak-Core is selected, but it is not installed. Prizrak-Core-only options can validate only after installing Prizrak-Core.')
            ));
        }
        const validatorNotice = E('div', {
            'class': 'cbi-section-descr',
            'style': 'margin: 8px 0 14px; padding: 9px 12px; border-left: 3px solid ' + (validatorInfo.sourceMismatch ? '#e0a800' : '#1684d6') + '; background: rgba(127,127,127,0.08);'
        }, validatorNoticeContent);

        const writeAndTestConfig = async function() {
            const value = editor.getValue().trim() + '\n';

            await view_asclash_utils.writeFile('/opt/clash/config.yaml', value);
            ui.addNotification(null, E('p', _('Configuration saved successfully.')), 'info');

            const testResult = await fs.exec('/opt/clash/bin/clash', ['-d', '/opt/clash', '-t']);
            if (testResult.code !== 0) {
                const detail = view_asclash_utils.formatClashTestError(
                    testResult.stdout, testResult.stderr
                );

                ui.addNotification(null, E('div', {}, [
                    E('p', _('Configuration test failed — service not reloaded. Please fix the errors below:')),
                    E('pre', {
                        'style': 'margin: 6px 0 0; padding: 0 0 0 10px; font-size: 11px; line-height: 1.45; font-family: monospace; white-space: pre-wrap; word-break: break-word; max-height: 280px; overflow: auto; background: none; border: 0; border-left: 2px solid rgba(0,0,0,0.18);'
                    }, detail || _('unknown error'))
                ]), 'error');
                return null;
            }

            return value;
        };

        const saveAndRestartCore = async function() {
            if (startStopButton) startStopButton.disabled = true;
            try {
                const value = await writeAndTestConfig();
                if (value === null) return;

                const progressBefore = await view_asclash_utils.getListProgress();

                try {
                    await view_asclash_utils.execDetached('/etc/init.d/clash reload');
                } catch (e) {}

                ui.addNotification(null, E('p', _('Clash is restarting; firewall lists will be rebuilt and applied.')), 'info');
                watchListProgress(progressBefore);

                const [serviceRunning, progress] = await Promise.all([
                    view_asclash_utils.waitForServiceStatus(getServiceStatus, true),
                    view_asclash_utils.waitForListProgress(progressBefore, 90000)
                ]);
                if (serviceRunning && progress && progress.phase === 'applied') {
                    ui.addNotification(null, E('p', _('Service reloaded successfully.')), 'info');
                    if (startStopButton) startStopButton.textContent = _('Stop Service');
                } else if (!serviceRunning) {
                    notifyRestartPending();
                } else {
                    ui.addNotification(null, E('p', _('The service restarted, but list application could not be confirmed yet. Check Diagnostics and the system log.')), 'warning');
                }
            } catch(e) {
                ui.addNotification(null, E('p', _('Unable to save contents: %s').format(e.message)), 'error');
            } finally {
                if (startStopButton) startStopButton.disabled = false;
            }
        };

        const saveAndReloadConfig = async function() {
            if (startStopButton) startStopButton.disabled = true;
            try {
                if (!(await getServiceStatus())) {
                    ui.addNotification(null, E('p',
                        _('Service is not running — config reload requires a running Mihomo instance. Use "Save & Restart core" instead.')
                    ), 'warning');
                    return;
                }

                const value = await writeAndTestConfig();
                if (value === null) return;

                const ec = parseYamlValue(value, 'external-controller');
                const ecTls = parseYamlValue(value, 'external-controller-tls');
                const secret = parseYamlValue(value, 'secret') || '';
                const useTls = !!ecTls;

                const { host, port } = normalizeHostPortFromAddr(
                    useTls ? ecTls : ec,
                    '127.0.0.1',
                    useTls ? '9443' : '9090'
                );
                const scheme = useTls ? 'https' : 'http';

                const curlArgs = [
                    '-sS', '-o', '/dev/null', '-w', '%{http_code}',
                    '-X', 'PUT',
                    '-H', 'Content-Type: application/json',
                    '-H', 'Authorization: Bearer ' + secret,
                    '--data', '{"path":"","payload":""}',
                    '--connect-timeout', '5',
                    '--max-time', '15'
                ];
                if (useTls) {
                    curlArgs.push('-k');
                }
                curlArgs.push(scheme + '://' + host + ':' + port + '/configs?force=true');

                const res = await fs.exec('curl', curlArgs);
                const httpCode = (res.stdout || '').trim();

                if (res.code !== 0 || (httpCode !== '204' && httpCode !== '200')) {
                    let detail = (res.stderr || '').trim();
                    if (useTls && /Protocol\s+"?https"?\s+not\s+supported/i.test(detail)) {
                        detail += ' ' + _('(Hint: the system curl has no HTTPS support. Install curl-ssl, or use plain external-controller for hot reload.)');
                    }
                    ui.addNotification(null, E('p',
                        _('Config reload failed (%s, HTTP %s). %s Try "Save & Restart core" for a full restart.')
                        .format(scheme, httpCode || 'n/a', detail ? detail : '')
                    ), 'error');
                    return;
                }

                const progressBefore = await view_asclash_utils.getListProgress();
                try {
                    await view_asclash_utils.execDetached('/opt/clash/bin/clash-rules update');
                    ui.addNotification(null, E('p', _('Config reloaded; checking and updating generated firewall lists…')), 'info');
                    watchListProgress(progressBefore);
                } catch (err) {
                    ui.addNotification(null, E('p',
                        _('Config reloaded, but updating subscription IP cache failed: %s').format((err && err.message) || String(err))
                    ), 'warning');
                }

                ui.addNotification(null, E('p',
                    _('Config reloaded via Mihomo API — active connections preserved.')
                ), 'info');

                await view_asclash_utils.waitForServiceStatus(
                    getServiceStatus, true, 5000
                );
            } catch(e) {
                ui.addNotification(null, E('p',
                    _('Config reload error: %s. Try "Save & Restart core" for a full restart.').format(e.message)
                ), 'error');
            } finally {
                if (startStopButton) startStopButton.disabled = false;
            }
        };

        const _light = view_asclash_utils.isLightTheme();
        const splitMenu = E('div', {
            'class': 'asclash-split-menu',
            'style': _light
                ? 'position: absolute; top: 100%; right: 0; display: none; min-width: 220px; margin-top: 3px; background: #fff; color: #333; border: 1px solid rgba(0,0,0,0.2); border-radius: 3px; box-shadow: 0 3px 8px rgba(0,0,0,0.2); z-index: 1000;'
                : 'position: absolute; top: 100%; right: 0; display: none; min-width: 220px; margin-top: 3px; background: #2b2b2b; color: #e0e0e0; border: 1px solid rgba(255,255,255,0.15); border-radius: 3px; box-shadow: 0 3px 8px rgba(0,0,0,0.5); z-index: 1000;'
        }, [
            E('button', {
                'class': 'btn',
                'click': function() { splitMenu.style.display = 'none'; saveAndRestartCore(); },
                'style': 'display: block; width: 100%; text-align: left; margin: 0; border: 0; border-radius: 0; background: transparent; padding: 8px 14px;' + (_light ? '' : ' color: #e0e0e0;'),
                'title': _('Full restart: stops and starts the Mihomo core, rebuilds firewall rules and refreshes subscription IPs. Active connections are dropped.')
            }, _('Save & Restart core'))
        ]);

        const splitContainer = E('div', {
            'class': 'asclash-split-btn',
            'style': 'display: inline-flex; align-items: stretch; position: relative;'
        }, [
            E('button', {
                'class': 'btn',
                'click': saveAndReloadConfig,
                'style': 'margin: 0; border-top-right-radius: 0; border-bottom-right-radius: 0; border-right: 0;',
                'title': _('Reload configuration via Mihomo API — active connections are preserved. Firewall rules are NOT rebuilt; use "Save & Restart core" when changing external-controller / tproxy-port / tun / fake-ip-filter-mode / proxy mode.')
            }, _('Save & Reload config')),
            E('button', {
                'class': 'btn',
                'style': 'margin: 0; border-top-left-radius: 0; border-bottom-left-radius: 0; padding-left: 10px; padding-right: 10px;',
                'aria-haspopup': 'true',
                'aria-label': _('More actions'),
                'click': function(ev) {
                    ev.stopPropagation();
                    splitMenu.style.display = (splitMenu.style.display === 'block') ? 'none' : 'block';
                }
            }, '\u25BE'),
            splitMenu
        ]);

        document.addEventListener('click', function(ev) {
            if (!splitContainer.contains(ev.target)) splitMenu.style.display = 'none';
        });

        const dot = () => E('span', { 'style': 'margin: 0 6px; opacity: 0.35;' }, '\u00B7');

        const versionFooter = E('div', {
            'id': 'asclash-version-footer',
            'style': 'margin-top: 20px; padding: 10px 0; border-top: 1px solid rgba(127,127,127,0.15); text-align: center; font-size: 11px; color: #999;'
        }, [
            E('span', {}, 'ASClash v' + ASCLASH_VERSION),
            dot(),
            E('span', {}, [
                'Modified by ',
                E('a', { 'href': 'https://github.com/Desonator/ASClash', 'target': '_blank', 'rel': 'noopener' }, 'Desonator')
            ]),
            dot(),
            E('span', {}, [
                'by ',
                E('a', { 'href': UPSTREAM_AUTHOR_URL, 'target': '_blank', 'rel': 'noopener' }, 'ZeroChaos')
            ]),
            dot(),
            E('a', { 'href': UPSTREAM_DONATE_URL, 'target': '_blank', 'rel': 'noopener' }, _('Donate')),
            dot(),
            E('span', { 'id': 'asclash-update-status' }, '\u2026')
        ]);

        const view = E([
            E('div', {
                'style': 'margin: 0 0 8px; display: flex; flex-wrap: wrap; align-items: center; gap: 8px 12px;'
            }, [
                E('h2', { 'style': 'margin:0;' }, _('Clash Configuration')),
                E('div', {
                    'style': 'margin-left:auto;display:flex;justify-content:flex-end;align-items:center;flex-wrap:wrap;gap:6px;'
                }, [
                    E('button', {
                    'class': 'btn',
                    'click': openDashboard,
                    'style': 'margin: 0;'
                    }, _('Open Dashboard')),
                    (restartButton = E('button', {
                        'class': 'btn',
                        'click': restartService,
                        'style': 'margin: 0;'
                    }, _('Restart Service'))),
                    (startStopButton = E('button', {
                        'class': 'btn',
                        'click': toggleService,
                        'style': 'margin: 0;'
                    }, running ? _('Stop Service') : _('Start Service')))
                ])
            ]),
            E('p', { 'class': 'cbi-section-descr' }, _('Your current Clash config. When applied, the changes will be saved and the service will be restarted.')),
            validatorNotice,
            E('div', {
                'id': 'editor',
                'style': 'width: 100%; height: 640px; margin-bottom: 15px;'
            }),
            E('div', { 'style': 'text-align: center; margin-top: 15px; margin-bottom: 20px;' }, [
                splitContainer
            ]),
            versionFooter
        ]);

        initializeAceEditor(config);

        (async function updateVersionFooter() {
            const status = view.querySelector('#asclash-update-status');
            if (!status) return;

            const latest = await getLatestASClashRelease();
            if (!latest) {
                status.textContent = _('Update check failed');
                return;
            }

            if (cmpSemver(latest.version, ASCLASH_VERSION) > 0) {
                status.textContent = '';
                status.appendChild(E('a', {
                    'href': latest.url,
                    'target': '_blank',
                    'rel': 'noopener'
                }, latest.version + ' \u2191'));
            } else {
                status.textContent = '\u2713';
            }
        })();

        return view;
    },
    handleSave: null,
    handleSaveApply: null,
    handleReset: null
});
