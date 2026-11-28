'use strict';
'require fs';
'require rpc';
'require ui';

const RPC_TIMEOUT_SEC = 60;
const SERVICE_POLL_TIMEOUT_MS = 60000;
const SERVICE_POLL_INTERVAL_MS = 500;
const WRITE_CHUNK_SIZE = 8000;
const WRITE_INLINE_MAX = 32768;
const MAX_CLASH_TEST_ERROR_LEN = 8000;
const LIST_PROGRESS_PATH = '/tmp/clash/asclash-list-progress';

function unescapeLogString(s) {
    return String(s)
        .replace(/\\n/g, '\n')
        .replace(/\\r/g, '\r')
        .replace(/\\t/g, '\t')
        .replace(/\\"/g, '"')
        .replace(/\\\\/g, '\\');
}

function stripClashLogPrefix(line) {
    return String(line)
        .replace(/^time="[^"]+"\s+level=\w+\s+/, '')
        .replace(/^ERRO\[[^\]]+\]\s*/, '')
        .replace(/^WARN\[[^\]]+\]\s*/, '')
        .trim();
}

function formatClashTestError(stdout, stderr) {
    const raw = [stderr, stdout]
        .filter(function(s) { return s && String(s).trim(); })
        .join('\n')
        .trim();
    if (!raw) return '';

    const lines = [];
    const seen = new Set();

    function addLine(line) {
        if (line == null) return;
        line = String(line).replace(/\r/g, '').trim();
        if (!line || seen.has(line)) return;
        seen.add(line);
        lines.push(line);
    }

    function addBlock(text) {
        unescapeLogString(text).split('\n').forEach(function(l) {
            l = l.trim();
            if (l) addLine(l);
        });
    }

    let m;
    const msgRe = /msg="((?:\\.|[^"\\])*)"/g;
    while ((m = msgRe.exec(raw)) !== null) {
        addBlock(m[1]);
    }

    raw.split('\n').forEach(function(line) {
        const t = line.trim();
        if (!t || /level=(info|debug)\b/i.test(t)) return;

        const erro = t.match(/^ERRO\[[^\]]+\]\s*(.+)$/);
        if (erro) {
            addLine(erro[1]);
            return;
        }

        if (/^time="[^"]+"\s+level=(fatal|error)\b/i.test(t) && !/msg="/.test(t)) {
            addLine(stripClashLogPrefix(t));
            return;
        }

        if (/^(Error:|Parse config error:|panic:)/i.test(t)) {
            addLine(t);
            return;
        }
        if (/^Profile Check Failed/i.test(t)) {
            addLine(t);
            return;
        }
        if (/^yaml:/i.test(t) || /^line \d+:/i.test(t)) {
            addLine(t);
            return;
        }
        if (/configuration file .+ test failed/i.test(t)) {
            addLine(t);
            return;
        }
    });

    let out = lines.join('\n');
    if (!out) {
        out = raw.split('\n')
            .map(stripClashLogPrefix)
            .filter(function(l) { return l && !/level=(info|debug)\b/i.test(l); })
            .join('\n');
    }

    if (out.length > MAX_CLASH_TEST_ERROR_LEN) {
        out = out.slice(0, MAX_CLASH_TEST_ERROR_LEN) + '\n…';
    }
    return out;
}

function formatClashLogMessage(raw) {
    if (raw == null) return '';
    const m = String(raw).trim();
    if (!m) return '';

    const nested = m.match(/^time="[^"]+"\s+level=\w+\s+msg="((?:\\.|[^"\\])*)"$/);
    if (nested) {
        return unescapeLogString(nested[1]);
    }

    const msgOnly = m.match(/^msg="((?:\\.|[^"\\])*)"$/);
    if (msgOnly) {
        return unescapeLogString(msgOnly[1]);
    }

    return m;
}

const callServiceList = rpc.declare({
    object: 'service',
    method: 'list',
    params: ['name'],
    expect: { '': {} }
});

function bumpRpcTimeout() {
    try {
        if (typeof L !== 'undefined' && L.env &&
            (!(L.env.rpctimeout > 0) || L.env.rpctimeout < RPC_TIMEOUT_SEC)) {
            L.env.rpctimeout = RPC_TIMEOUT_SEC;
        }
    } catch (e) {}
}

function shellQuote(s) {
    return '\'' + String(s).replace(/'/g, "'\\''") + '\'';
}

function encodeBase64Utf8(str) {
    const bytes = new TextEncoder().encode(str);
    let binary = '';
    for (let i = 0; i < bytes.length; i++) {
        binary += String.fromCharCode(bytes[i]);
    }
    return btoa(binary);
}

async function writeFile(path, content) {
    if (content.length <= WRITE_INLINE_MAX) {
        return fs.write(path, content);
    }

    const tmpB64 = '/tmp/mihomo-write-' + Date.now() + '-' + Math.random().toString(36).slice(2) + '.b64';
    const b64 = encodeBase64Utf8(content);

    try {
        for (let offset = 0; offset < b64.length; offset += WRITE_CHUNK_SIZE) {
            const chunk = b64.slice(offset, offset + WRITE_CHUNK_SIZE);
            const op = offset === 0 ? '>' : '>>';
            const res = await fs.exec('/bin/sh', ['-c',
                'printf %s ' + shellQuote(chunk) + ' ' + op + ' ' + shellQuote(tmpB64)
            ]);
            if (res.code !== 0)
                throw new Error((res.stderr || res.stdout || '').trim() || 'chunk write failed');
        }

        const res = await fs.exec('/bin/sh', ['-c',
            'base64 -d ' + shellQuote(tmpB64) + ' > ' + shellQuote(path)
        ]);
        if (res.code !== 0)
            throw new Error((res.stderr || res.stdout || '').trim() || 'decode write failed');
    } finally {
        await removeFile(tmpB64);
    }
}

async function removeFile(path) {
    try {
        await fs.exec('/bin/rm', ['-f', path]);
    } catch (_e) {}
}

async function writeFileAtomic(path, content) {
    const tempPath = path + '.tmp-' + Date.now() + '-' + Math.random().toString(36).slice(2);
    try {
        await writeFile(tempPath, content);
        const result = await fs.exec('/bin/mv', ['-f', tempPath, path]);
        if (result.code !== 0)
            throw new Error((result.stderr || result.stdout || '').trim() || 'atomic rename failed');
    } catch (e) {
        await removeFile(tempPath);
        throw e;
    }
}

async function stageValidatedConfig(content) {
    const tempPath = '/opt/clash/config.yaml.tmp-' + Date.now() + '-' + Math.random().toString(36).slice(2);
    let phase = 'writing temporary config';
    try {
        await writeFile(tempPath, content);
        phase = 'running core config test';
        const result = await fs.exec('/opt/clash/bin/clash', ['-d', '/opt/clash', '-f', tempPath, '-t']);
        if (result.code !== 0) {
            const detail = formatClashTestError(result.stdout, result.stderr);
            await removeFile(tempPath);
            return { ok: false, detail: detail || _('unknown error') };
        }
        return { ok: true, path: tempPath };
    } catch (e) {
        await removeFile(tempPath);
        return { ok: false, detail: phase + ': ' + (e.message || String(e)) };
    }
}

async function commitStagedConfig(tempPath) {
    const result = await fs.exec('/bin/mv', ['-f', tempPath, '/opt/clash/config.yaml']);
    if (result.code !== 0) {
        await removeFile(tempPath);
        throw new Error((result.stderr || result.stdout || '').trim() || 'config rename failed');
    }
}

async function discardStagedConfig(tempPath) {
    if (tempPath) await removeFile(tempPath);
}

function execDetached(script) {
    const quoted = '\'' + script.replace(/'/g, "'\\''") + '\'';
    const wrapped = 'if command -v setsid >/dev/null 2>&1; then setsid /bin/sh -c ' + quoted +
        '; else /bin/sh -c ' + quoted + '; fi >/dev/null 2>&1 </dev/null &';
    return fs.exec('/bin/sh', ['-c', wrapped]);
}

async function getClashRunning() {
    try {
        const instances = (await callServiceList('clash'))['clash']?.instances;
        return Object.values(instances || {})[0]?.running || false;
    } catch (e) {
        return false;
    }
}

async function waitForServiceStatus(getStatusFn, targetStatus, timeoutMs) {
    const deadline = Date.now() + (timeoutMs || SERVICE_POLL_TIMEOUT_MS);
    while (Date.now() < deadline) {
        if (await getStatusFn() === targetStatus) {
            return true;
        }
        await new Promise(function(resolve) {
            setTimeout(resolve, SERVICE_POLL_INTERVAL_MS);
        });
    }
    return false;
}

async function getListProgress() {
    try {
        return String(await L.resolveDefault(fs.read(LIST_PROGRESS_PATH), '')).trim();
    } catch (_e) {
        return '';
    }
}

async function waitForListProgress(previous, timeoutMs) {
    const baseline = String(previous || '').trim();
    const deadline = Date.now() + (timeoutMs || 75000);
    while (Date.now() < deadline) {
        const current = await getListProgress();
        if (current && current !== baseline) {
            const fields = current.split('|');
            const phase = fields[1] || '';
            if (phase === 'applied' || phase === 'failed' || phase === 'deferred')
                return { operation: fields[0] || '', phase };
        }
        await new Promise(resolve => setTimeout(resolve, 750));
    }
    return null;
}

async function watchListProgress(previous, onProgress, timeoutMs) {
    const deadline = Date.now() + (timeoutMs || 120000);
    const baseline = String(previous || '').trim();
    let last = baseline;
    let lastOperation = '';
    let lastPhase = '';
    let quietUntil = 0;

    while (Date.now() < deadline) {
        const current = await getListProgress();
        if (current && current !== last && current !== baseline) {
            const fields = current.split('|');
            const operation = fields[0] || '';
            const phase = fields[1] || '';
            if (operation !== lastOperation || phase !== lastPhase) {
                lastOperation = operation;
                lastPhase = phase;
                if (typeof onProgress === 'function') onProgress({ operation, phase });
            }
            quietUntil = phase === 'applied' || phase === 'failed' || phase === 'deferred' ? Date.now() + 70000 : 0;
            last = current;
        }

        // A service-started callback may refresh provider-derived lists several
        // seconds after the core is running. Keep watching briefly after a
        // completed phase so LuCI can report that follow-up operation too.
        if (quietUntil && Date.now() >= quietUntil) break;
        await new Promise(resolve => setTimeout(resolve, 1000));
    }

    return last;
}

function notifyListProgress(progress) {
    if (!progress) return;
    if (progress.phase === 'building' || progress.phase === 'applying') return;

    if (progress.phase === 'applied' && String(progress.operation || '').startsWith('start-'))
        return;

    const message = progress.phase === 'failed'
        ? _('List generation or firewall application failed. Check Diagnostics and the system log.')
        : progress.phase === 'deferred'
            ? _('Firewall is not active; provider-derived firewall lists will be refreshed when Clash starts.')
        : progress.phase === 'applied' && String(progress.operation || '').startsWith('post-start-')
            ? _('Post-start provider refresh completed: firewall lists were updated after the core started. The earlier cached-list application was part of the same startup.')
            : progress.phase === 'applied' ? _('Generated lists and firewall rules were applied successfully.') : null;
    if (message)
        ui.addNotification(null, E('p', message), progress.phase === 'failed' ? 'error' : progress.phase === 'applied' ? 'success' : 'info');
}

function monitorListProgress(previous) {
    return watchListProgress(previous, notifyListProgress, 120000)
        .catch(e => console.warn('Failed to monitor list progress:', e));
}

return L.Class.extend({
    bumpRpcTimeout: bumpRpcTimeout,
    execDetached: execDetached,
    writeFile: writeFile,
    writeFileAtomic: writeFileAtomic,
    stageValidatedConfig: stageValidatedConfig,
    commitStagedConfig: commitStagedConfig,
    discardStagedConfig: discardStagedConfig,
    formatClashTestError: formatClashTestError,
    formatClashLogMessage: formatClashLogMessage,
    getClashRunning: getClashRunning,
    waitForServiceStatus: waitForServiceStatus,
    getListProgress: getListProgress,
    waitForListProgress: waitForListProgress,
    watchListProgress: watchListProgress,
    monitorListProgress: monitorListProgress,
    SERVICE_POLL_TIMEOUT_MS: SERVICE_POLL_TIMEOUT_MS,

    isLightTheme: function() {
        if (document.documentElement.dataset.bsTheme === 'dark') return false;
        if (document.documentElement.dataset.bsTheme === 'light') return true;
        const bg = window.getComputedStyle(document.body).backgroundColor;
        const m = bg.match(/\d+/g);
        if (m && m.length >= 3)
            return (0.299 * +m[0] + 0.587 * +m[1] + 0.114 * +m[2]) / 255 > 0.5;
        return true;
    }
});
