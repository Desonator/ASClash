'use strict';

const fs = require('fs');
const path = require('path');

const configPath = path.join(__dirname, '..', 'luci-app-asclash', 'rootfs', 'www', 'luci-static', 'resources', 'view', 'asclash', 'config.js');
const utilsPath = path.join(__dirname, '..', 'luci-app-asclash', 'rootfs', 'www', 'luci-static', 'resources', 'view', 'asclash', 'utils.js');
const config = fs.readFileSync(configPath, 'utf8');
const utils = fs.readFileSync(utilsPath, 'utf8');

for (const operation of ['saveAndRestartCore', 'saveAndReloadConfig']) {
    const start = config.indexOf(`const ${operation} = async function()`);
    if (start < 0) throw new Error(`Missing ${operation}`);
    const next = config.indexOf('\n        const ', start + 1);
    const body = config.slice(start, next < 0 ? config.length : next);
    if (!body.includes('if (configApplyInProgress) return;'))
        throw new Error(`${operation} does not reject concurrent apply attempts`);
    if (!body.includes('configApplyInProgress = false;'))
        throw new Error(`${operation} does not release the apply lock`);
    if (!body.includes('configApplyButtons.forEach(button => { if (button) button.disabled = true; })'))
        throw new Error(`${operation} does not disable both apply controls`);
}

if (!utils.includes("let phase = 'writing temporary config';") ||
    !utils.includes("phase = 'running core config test';") ||
    !utils.includes('detail: phase +'))
    throw new Error('Staging errors do not identify whether writing or core validation failed');

console.log('Config apply concurrency guard and stage diagnostics passed');
