// node --test .github/scripts/
import assert from 'node:assert/strict';
import { test } from 'node:test';

import {
  PARTS,
  bumpFromLabels,
  bumpFromMessages,
  bumpVersion,
  changedFiles,
  compareVersions,
  effectiveKind,
} from './version-bump.mjs';

test('compareVersions ordena core e pré-release', () => {
  assert.ok(compareVersions('0.6.1', '0.6.0') > 0);
  assert.ok(compareVersions('0.10.0', '0.9.9') > 0);
  assert.ok(compareVersions('0.7.0-rc.1', '0.7.0') < 0);
  assert.ok(compareVersions('0.7.0-rc.1', '0.6.9') > 0);
  assert.equal(compareVersions('1.2.3', '1.2.3'), 0);
});

test('bumpVersion', () => {
  assert.equal(bumpVersion('0.6.1', 'patch'), '0.6.2');
  assert.equal(bumpVersion('0.6.1', 'minor'), '0.7.0');
  assert.equal(bumpVersion('0.6.1', 'major'), '1.0.0');
  assert.equal(bumpVersion('0.7.0-rc.1', 'patch'), '0.7.0');
});

test('bumpFromMessages segue Conventional Commits', () => {
  assert.equal(bumpFromMessages(['fix(firmware): x', 'docs: y']), 'patch');
  assert.equal(bumpFromMessages(['fix: x', 'feat(ota): y']), 'minor');
  assert.equal(bumpFromMessages(['feat(ws)!: muda contrato']), 'major');
  assert.equal(bumpFromMessages(['refactor: x\n\nBREAKING CHANGE: some campo']), 'major');
  assert.equal(bumpFromMessages(['Satélites: device_info e OTA']), 'patch');
  assert.equal(bumpFromMessages([]), 'patch');
});

test('effectiveKind: incompatível em 0.x sobe o minor', () => {
  assert.equal(effectiveKind('major', '0.6.1'), 'minor');
  assert.equal(effectiveKind('major', '1.2.0'), 'major');
  assert.equal(effectiveKind('patch', '0.6.1'), 'patch');
});

test('bumpFromLabels', () => {
  assert.equal(bumpFromLabels([]), null);
  assert.equal(bumpFromLabels(['bug', 'bump:minor']), 'minor');
  assert.equal(bumpFromLabels(['bump:patch', 'bump:major']), 'major');
  assert.equal(bumpFromLabels(['bump:skip']), 'skip');
  assert.equal(bumpFromLabels(['bump:skip', 'bump:patch']), 'patch');
});

const fw = PARTS.find((p) => p.name === 'firmware');
const server = PARTS.find((p) => p.name === 'server');

test('changedFiles ignora a linha de versão e Markdown', () => {
  const diff = [
    'diff --git a/luna-firmware/platformio.ini b/luna-firmware/platformio.ini',
    'index 1..2 100644',
    '--- a/luna-firmware/platformio.ini',
    '+++ b/luna-firmware/platformio.ini',
    '@@ -29 +29 @@',
    '-custom_fw_version = 0.6.0',
    '+custom_fw_version = 0.6.1',
    'diff --git a/luna-firmware/README.md b/luna-firmware/README.md',
    '--- a/luna-firmware/README.md',
    '+++ b/luna-firmware/README.md',
    '@@ -1 +1 @@',
    '-a',
    '+b',
  ].join('\n');
  const opts = { ignoreFile: (f) => f.endsWith('.md'), ignoreLine: fw.isVersionLine };
  assert.deepEqual(changedFiles(diff, opts), []);

  const withCode = `${diff}\ndiff --git a/luna-firmware/src/main.cpp b/luna-firmware/src/main.cpp\n--- a/x\n+++ b/x\n@@ -1 +1 @@\n-int a;\n+int b;`;
  assert.deepEqual(changedFiles(withCode, opts), ['luna-firmware/src/main.cpp']);
});

test('changedFiles: outra linha do platformio.ini conta', () => {
  const diff = [
    'diff --git a/luna-firmware/platformio.ini b/luna-firmware/platformio.ini',
    '--- a/luna-firmware/platformio.ini',
    '+++ b/luna-firmware/platformio.ini',
    '@@ -29 +29,2 @@',
    '-custom_fw_version = 0.6.0',
    '+custom_fw_version = 0.6.1',
    '+lib_deps = foo',
  ].join('\n');
  assert.deepEqual(changedFiles(diff, { ignoreLine: fw.isVersionLine }), ['luna-firmware/platformio.ini']);
});

test('changedFiles: comentário do platformio.ini não conta', () => {
  const diff = [
    'diff --git a/luna-firmware/platformio.ini b/luna-firmware/platformio.ini',
    '--- a/luna-firmware/platformio.ini',
    '+++ b/luna-firmware/platformio.ini',
    '@@ -25,2 +25,3 @@',
    '-; Subir a cada release.',
    '+; Sobe sozinha na PR.',
    '+',
  ].join('\n');
  assert.deepEqual(changedFiles(diff, { ignoreLine: fw.isVersionLine }), []);
});

test('changedFiles: package.json só com version não conta; dependência conta', () => {
  const onlyVersion = [
    'diff --git a/luna-server/package.json b/luna-server/package.json',
    '--- a/luna-server/package.json',
    '+++ b/luna-server/package.json',
    '@@ -3 +3 @@',
    '-  "version": "0.1.0",',
    '+  "version": "0.1.1",',
  ].join('\n');
  assert.deepEqual(changedFiles(onlyVersion, { ignoreLine: server.isVersionLine }), []);
  const dep = `${onlyVersion}\n@@ -20 +20 @@\n-    "ws": "^8.17.0"\n+    "ws": "^8.18.0"`;
  assert.deepEqual(changedFiles(dep, { ignoreLine: server.isVersionLine }), ['luna-server/package.json']);
});

test('changedFiles: binário ou rename sem linhas conta', () => {
  const diff = [
    'diff --git a/luna-firmware/models/x.tflite b/luna-firmware/models/x.tflite',
    'index 1..2 100644',
    'Binary files a/luna-firmware/models/x.tflite and b/luna-firmware/models/x.tflite differ',
  ].join('\n');
  assert.deepEqual(changedFiles(diff), ['luna-firmware/models/x.tflite']);
});
