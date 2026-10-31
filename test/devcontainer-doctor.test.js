import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { parseJsonc, JsoncError } from '../src/jsonc.js';
import { validate, findConfigs, workspaceRootFor, scriptRefs } from '../src/rules.js';

const root = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const cli = path.join(root, 'bin', 'devcontainer-doctor.js');

function workspace(config, files = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'dcdoctor-'));
  fs.mkdirSync(path.join(dir, '.devcontainer'), { recursive: true });
  const file = path.join(dir, '.devcontainer', 'devcontainer.json');
  fs.writeFileSync(file, typeof config === 'string' ? config : JSON.stringify(config, null, 2));
  for (const [name, content] of Object.entries(files)) {
    fs.mkdirSync(path.dirname(path.join(dir, name)), { recursive: true });
    fs.writeFileSync(path.join(dir, name), content);
  }
  return { dir, file };
}

function ids(config, files) {
  const { file } = workspace(config, files);
  return validate(file, { env: {} }).findings.map((f) => f.ruleId);
}

test('parseJsonc handles comments, trailing commas and records lines', () => {
  const { value, lines } = parseJsonc('// c\n{\n  /* x */ "a": 1,\n  "b": { "c": [1, 2,], },\n  "u": "\\u0041//not-a-comment",\n}\n');
  assert.deepEqual(value, { a: 1, b: { c: [1, 2] }, u: 'A//not-a-comment' });
  assert.equal(lines.get('a'), 3);
  assert.equal(lines.get('b/c'), 4);
});

test('parseJsonc reports syntax errors with line and column', () => {
  assert.throws(() => parseJsonc('{\n  "a": 1\n  "b": 2\n}'), (err) => err instanceof JsoncError && err.line === 3);
  assert.throws(() => parseJsonc('{ "a": }'), JsoncError);
  assert.throws(() => parseJsonc('{ "a": 1 } x'), JsoncError);
});

test('duplicate keys are reported', () => {
  assert.ok(ids('{ "image": "node:22", "image": "node:20" }').includes('DC007'));
});

test('minimal image config is clean', () => {
  assert.deepEqual(ids({ image: 'mcr.microsoft.com/devcontainers/base:ubuntu' }), []);
});

test('container source rules', () => {
  assert.deepEqual(ids({ name: 'x' }), ['DC002']);
  assert.ok(ids({ image: 'node:22', build: { dockerfile: 'Dockerfile' } }, { '.devcontainer/Dockerfile': 'FROM node:22' }).includes('DC003'));
  assert.ok(ids({ image: 'ubuntu' }).includes('DC012'));
  assert.ok(ids({ build: { dockerfile: 'nope' } }).includes('DC010'));
  assert.ok(ids({ build: { dockerfile: 'Dockerfile', target: 'prod' } }, { '.devcontainer/Dockerfile': 'FROM node:22 AS dev\n' }).includes('DC011'));
  assert.deepEqual(ids({ build: { dockerfile: '../Dockerfile', context: '..', target: 'dev' } }, { Dockerfile: 'FROM node:22 as dev\n' }), []);
});

test('unknown properties, types, enums and deprecations', () => {
  const found = ids({ image: 'node:22', postCreateComand: 'x', forwardPorts: 3000, waitFor: 'never', settings: {}, dockerFile: 'D' });
  for (const id of ['DC004', 'DC005', 'DC006']) assert.ok(found.includes(id), id);
  const { file } = workspace({ image: 'node:22', postCreateComand: 'x' });
  assert.equal(validate(file).findings[0].fix, 'did you mean "postCreateCommand"?');
});

test('docker compose configs', () => {
  const found = ids(
    { dockerComposeFile: ['../compose.yaml', 'missing.yaml'], service: 'web', runServices: ['db', 'cache'] },
    { 'compose.yaml': 'services:\n  app: { image: node:22 }\n  db: { image: postgres:16 }\n' },
  );
  for (const id of ['DC020', 'DC021', 'DC022']) assert.ok(found.includes(id), id);
  assert.deepEqual(
    ids({ dockerComposeFile: '../compose.yaml', service: 'app', workspaceFolder: '/workspace' }, { 'compose.yaml': 'services:\n  app: { image: node:22 }\n' }),
    [],
  );
  assert.ok(ids({ image: 'node:22', workspaceMount: 'source=x,target=/w,type=bind' }).includes('DC023'));
});

test('feature references', () => {
  const found = ids(
    {
      image: 'node:22',
      features: { 'ghcr.io/devcontainers/features/node': {}, 'docker-in-docker': {}, './missing': {}, 'bad id': {}, 'https://x.dev/f.zip': {}, 'ghcr.io/devcontainers/features/git:1': {} },
      overrideFeatureInstallOrder: ['ghcr.io/devcontainers/features/git', 'ghcr.io/devcontainers/features/python'],
    },
  );
  assert.deepEqual([...new Set(found)].sort(), ['DC030', 'DC031', 'DC032', 'DC033', 'DC034']);
  assert.deepEqual(ids({ image: 'node:22', features: { './f': {} } }, { '.devcontainer/f/devcontainer-feature.json': '{}' }), []);
});

test('scriptRefs finds scripts in lifecycle commands', () => {
  assert.deepEqual(scriptRefs('bash .devcontainer/setup.sh && npm ci'), [{ path: '.devcontainer/setup.sh', direct: false }]);
  assert.deepEqual(scriptRefs('./scripts/init.sh'), [{ path: './scripts/init.sh', direct: true }]);
  assert.deepEqual(scriptRefs(['python3', 'tools/bootstrap.py']), [{ path: 'tools/bootstrap.py', direct: false }]);
  assert.deepEqual(scriptRefs('sudo /usr/local/bin/x.sh; pip install -r requirements.txt'), []);
  assert.deepEqual(scriptRefs('bash ${containerWorkspaceFolder}/s.sh'), [{ path: '${containerWorkspaceFolder}/s.sh', direct: false }]);
});

test('lifecycle scripts: missing, CRLF, shebang and gitattributes', () => {
  const found = ids(
    { image: 'node:22', onCreateCommand: { a: 'bash missing.sh', b: './run.sh' }, postStartCommand: 'bash crlf.sh' },
    { 'run.sh': 'echo no shebang\n', 'crlf.sh': '#!/bin/bash\r\necho x\r\n' },
  );
  for (const id of ['DC040', 'DC041', 'DC043', 'DC044']) assert.ok(found.includes(id), id);
  assert.deepEqual(ids({ image: 'node:22', postCreateCommand: 'bash s.sh' }, { 's.sh': '#!/bin/bash\n', '.gitattributes': '*.sh text eol=lf\n' }), []);
});

test('lifecycle script not executable in git', (t) => {
  const { dir, file } = workspace({ image: 'node:22', postCreateCommand: './init.sh' }, { 'init.sh': '#!/bin/sh\necho\n', '.gitattributes': '*.sh text eol=lf\n' });
  const git = (...args) => spawnSync('git', args, { cwd: dir, encoding: 'utf8' });
  if (git('init', '-q').status !== 0) return t.skip('git not available');
  git('add', 'init.sh');
  const found = validate(file, { env: {} }).findings.map((f) => f.ruleId);
  assert.ok(found.includes('DC042'));
  git('update-index', '--chmod=+x', 'init.sh');
  assert.ok(!validate(file, { env: {} }).findings.some((f) => f.ruleId === 'DC042'));
});

test('ports, mounts, variables, extensions and users', () => {
  const found = ids({
    image: 'node:22',
    forwardPorts: [3000, 3000, 0, 'db:5432', 'nope'],
    portsAttributes: { 4000: {} },
    mounts: ['type=bind,source=${localWorkspaceFolder}/missing,target=/x', { type: 'nfs', target: '/y' }, 'source=v,type=volume'],
    containerEnv: { A: '${localEnv:SURELY_UNSET}', B: '${localEnv:SURELY_UNSET:default}', C: '${bogus}' },
    customizations: { vscode: { extensions: ['ms-python.python', 'oops'] } },
    remoteUser: 'root',
  });
  for (const id of ['DC050', 'DC051', 'DC052', 'DC060', 'DC061', 'DC070', 'DC071', 'DC080', 'DC081']) assert.ok(found.includes(id), id);
  assert.equal(found.filter((id) => id === 'DC071').length, 1);
});

test('findConfigs and workspaceRootFor', () => {
  const { dir } = workspace({ image: 'node:22' }, { '.devcontainer/python/devcontainer.json': '{"image":"python:3"}', '.devcontainer.json': '{}' });
  assert.equal(findConfigs(dir).length, 3);
  assert.equal(workspaceRootFor(path.join(dir, '.devcontainer', 'python', 'devcontainer.json')), dir);
  assert.equal(workspaceRootFor(path.join(dir, '.devcontainer.json')), dir);
});

function run(args) {
  return spawnSync(process.execPath, [cli, ...args], { encoding: 'utf8', cwd: root, env: { ...process.env, NO_COLOR: '1' } });
}

test('CLI: scan, formats and exit codes', () => {
  const broken = run(['scan', 'fixtures/broken']);
  assert.equal(broken.status, 1);
  assert.match(broken.stdout, /DEVCONTAINER DOCTOR/);
  assert.equal(run(['fixtures/clean']).status, 0);
  assert.equal(run(['fixtures/clean/.devcontainer/devcontainer.json']).status, 0);
  assert.equal(run(['fixtures/broken', '--fail-on', 'none']).status, 0);

  const json = JSON.parse(run(['fixtures/broken', '-f', 'json']).stdout);
  assert.ok(json.summary.error >= 5);
  const sarif = JSON.parse(run(['fixtures/broken', '-f', 'sarif']).stdout);
  assert.equal(sarif.runs[0].tool.driver.name, 'DevContainer Doctor');
  assert.match(run(['fixtures/broken', '-f', 'github']).stdout, /^::error file=fixtures\/broken\/.devcontainer\/devcontainer.json,line=\d+/m);
  assert.equal(run(['does-not-exist']).status, 2);
  assert.equal(run([os.tmpdir()]).status, 2);
});

test('CLI: diagnose reports environment checks', () => {
  const r = run(['diagnose', 'fixtures/clean', '-f', 'json']);
  const json = JSON.parse(r.stdout);
  assert.ok(Array.isArray(json.environment));
  assert.ok(json.environment.some((c) => c.id === 'docker-cli'));
  assert.ok(!/DEP0190/.test(r.stderr), r.stderr);
});
