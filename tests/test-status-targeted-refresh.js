const fs = require('fs');
const path = require('path');
const assert = require('assert');

const root = path.resolve(__dirname, '..');
const kernel = fs.readFileSync(path.join(root, 'luci-app-asclash/rootfs/www/luci-static/resources/view/asclash/kernel.js'), 'utf8');
const status = fs.readFileSync(path.join(root, 'luci-app-asclash/rootfs/www/luci-static/resources/view/asclash/status.js'), 'utf8');

const kernelSection = kernel.slice(kernel.indexOf('function createKernelManagementSection()'));
assert(!kernelSection.includes('window.location.reload()'), 'Kernel runtime badge polling must not reload the page');
assert(kernelSection.includes('await updateRuntimeBadges(serviceBadge, kernelBadge)'), 'Kernel runtime badges must refresh independently');

assert(status.includes('firewallContainer.replaceChildren(...buildFirewallSections())'), 'Firewall summaries must refresh their cards in place');
assert(status.includes('if (current[0] !== configContent)'), 'Full reload should be reserved for actual config changes');
assert(status.includes('}, 30000);'), 'Firewall status polling should use a modest 30-second interval');

console.log('Status page targeted refresh tests passed.');
