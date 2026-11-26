'use strict';

const fs = require('fs');
const path = require('path');

const root = path.join(__dirname, '..');
const views = path.join(root, 'luci-app-asclash', 'rootfs', 'www', 'luci-static', 'resources', 'view', 'asclash');
function listViewSources(directory) {
	return fs.readdirSync(directory, { withFileTypes: true }).flatMap(entry => {
		const fullPath = path.join(directory, entry.name);
		if (entry.isDirectory())
			return entry.name === 'ace' ? [] : listViewSources(fullPath);
		return entry.isFile() && entry.name.endsWith('.js') ? [fullPath] : [];
	});
}
const files = listViewSources(views);

function unescapeLiteral(value) {
	return value.replace(/\\([\\'"`])/g, '$1').replace(/\\n/g, '\n').replace(/\\t/g, '\t');
}

function readCatalog(language) {
	const file = path.join(root, 'luci-app-asclash', 'rootfs', 'po', language, 'asclash.po');
	const messages = new Set();
	for (const line of fs.readFileSync(file, 'utf8').split(/\r?\n/)) {
		const match = line.match(/^msgid "(.*)"$/);
		if (match && match[1]) messages.add(match[1].replace(/\\"/g, '"').replace(/\\\\/g, '\\'));
	}
	return messages;
}

const sourceKeys = new Set();
const callPatterns = [
	/(?:_|localized)\(\s*'((?:\\.|[^'\\])*)'/g,
	/(?:_|localized)\(\s*"((?:\\.|[^"\\])*)"/g
];
for (const file of files) {
	const source = fs.readFileSync(file, 'utf8');
	for (const pattern of callPatterns) {
		for (const match of source.matchAll(pattern)) {
			const key = unescapeLiteral(match[1]);
			if (key) sourceKeys.add(key);
		}
	}
}

const catalogs = { ru: readCatalog('ru'), 'zh-cn': readCatalog('zh-cn') };
let failed = false;
for (const [language, messages] of Object.entries(catalogs)) {
	const missing = [...sourceKeys].filter(key => !messages.has(key)).sort();
	if (missing.length) {
		failed = true;
		console.error(`Missing ${language} translations (${missing.length}):`);
		for (const key of missing) console.error(`  ${key}`);
	}
}

const onlyInRussian = [...catalogs.ru].filter(key => !catalogs['zh-cn'].has(key)).sort();
const onlyInChinese = [...catalogs['zh-cn']].filter(key => !catalogs.ru.has(key)).sort();
if (onlyInRussian.length || onlyInChinese.length) {
	failed = true;
	if (onlyInRussian.length) console.error(`Message IDs missing in zh-cn (${onlyInRussian.length}):\n  ${onlyInRussian.join('\n  ')}`);
	if (onlyInChinese.length) console.error(`Message IDs missing in ru (${onlyInChinese.length}):\n  ${onlyInChinese.join('\n  ')}`);
}

if (failed) process.exit(1);
console.log(`Localization parity passed (${sourceKeys.size} UI keys, ru/zh-cn catalogs aligned).`);
