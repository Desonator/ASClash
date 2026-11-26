'use strict';

const fs = require('fs');
const path = require('path');

const root = path.join(__dirname, '..');
const acl = JSON.parse(fs.readFileSync(path.join(root, 'luci-app-asclash', 'rootfs', 'usr', 'share', 'rpcd', 'acl.d', 'luci-app-asclash.json'), 'utf8'))['luci-app-asclash'];
const readFiles = acl.read.file || {};
const writeFiles = acl.write.file || {};
const apiSource = fs.readFileSync(path.join(root, 'luci-app-asclash', 'rootfs', 'opt', 'clash', 'bin', 'asclash-api'), 'utf8');
const makefile = fs.readFileSync(path.join(root, 'luci-app-asclash', 'Makefile'), 'utf8');

if (!readFiles['/opt/clash/bin/asclash-api']?.includes('exec'))
	throw new Error('Read-only API helper is not executable for diagnostics');
if (readFiles['/opt/clash/bin/asclash-reload'])
	throw new Error('Mutating reload helper is exposed to the read ACL');
if (!writeFiles['/opt/clash/bin/asclash-reload']?.includes('exec'))
	throw new Error('Config reload helper is not restricted to the write ACL');
if (!makefile.includes('./rootfs/opt/clash/bin/asclash-reload'))
	throw new Error('Config reload helper is not included in the package');
if (/reload-config|update-(?:proxy|rule)-provider|providers-(?:proxies|rules)/.test(apiSource))
	throw new Error('Read-scope API helper contains a mutating endpoint');

console.log('API helper ACL separation tests passed.');
