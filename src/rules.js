import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { parse as parseYaml } from 'yaml';
import { parseJsonc, lineOf, escapeKey } from './jsonc.js';

export const RULES = {
  DC001: { name: 'jsonc-syntax', severity: 'error', description: 'devcontainer.json is not valid JSON with comments.' },
  DC002: { name: 'no-container-source', severity: 'error', description: 'One of "image", "build.dockerfile" or "dockerComposeFile" is required.' },
  DC003: { name: 'conflicting-container-source', severity: 'warning', description: 'More than one of image / build / dockerComposeFile is set; only one is used.' },
  DC004: { name: 'unknown-property', severity: 'warning', description: 'Unknown property, usually a typo; it is silently ignored.' },
  DC005: { name: 'invalid-type', severity: 'error', description: 'A property has the wrong type or an invalid value.' },
  DC006: { name: 'deprecated-property', severity: 'warning', description: 'A deprecated property is used.' },
  DC007: { name: 'duplicate-property', severity: 'warning', description: 'A property is defined twice; the last one wins.' },
  DC010: { name: 'dockerfile-missing', severity: 'error', description: 'The Dockerfile or build context does not exist.' },
  DC011: { name: 'build-target-missing', severity: 'error', description: 'build.target names a stage that is not in the Dockerfile.' },
  DC012: { name: 'image-latest-tag', severity: 'warning', description: 'The image uses the implicit or explicit "latest" tag.' },
  DC020: { name: 'compose-file-missing', severity: 'error', description: 'A file in dockerComposeFile does not exist.' },
  DC021: { name: 'compose-service-missing', severity: 'error', description: '"service" is missing or not defined in the Compose files.' },
  DC022: { name: 'compose-workspace-folder', severity: 'warning', description: 'Compose-based configs should set workspaceFolder (it defaults to "/").' },
  DC023: { name: 'workspace-mount-without-folder', severity: 'error', description: 'workspaceMount requires workspaceFolder.' },
  DC030: { name: 'feature-invalid-reference', severity: 'error', description: 'A feature id is not a valid OCI reference, local path or tarball URL.' },
  DC031: { name: 'feature-local-missing', severity: 'error', description: 'A local feature folder or its devcontainer-feature.json does not exist.' },
  DC032: { name: 'feature-unpinned', severity: 'warning', description: 'A feature has no version tag, so it floats to the latest release.' },
  DC033: { name: 'feature-legacy-id', severity: 'warning', description: 'A legacy short feature id is used.' },
  DC034: { name: 'feature-install-order', severity: 'warning', description: 'overrideFeatureInstallOrder lists a feature that is not installed.' },
  DC040: { name: 'lifecycle-script-missing', severity: 'error', description: 'A lifecycle command references a script that does not exist.' },
  DC041: { name: 'lifecycle-script-crlf', severity: 'error', description: 'A shell script has Windows (CRLF) line endings and fails with "bad interpreter" in Linux.' },
  DC042: { name: 'lifecycle-script-not-executable', severity: 'warning', description: 'A script that is executed directly is not marked executable in git.' },
  DC043: { name: 'lifecycle-script-no-shebang', severity: 'warning', description: 'A script that is executed directly has no #! line.' },
  DC044: { name: 'shell-scripts-not-lf', severity: 'info', description: 'No .gitattributes rule forces LF endings for shell scripts.' },
  DC050: { name: 'invalid-port', severity: 'error', description: 'forwardPorts / appPort entries must be 1-65535 or "host:port".' },
  DC051: { name: 'duplicate-port', severity: 'warning', description: 'A port is forwarded more than once.' },
  DC052: { name: 'ports-attributes-unused', severity: 'info', description: 'portsAttributes configures a port that is not forwarded.' },
  DC060: { name: 'invalid-mount', severity: 'error', description: 'A mount is missing type/target or uses an unknown type.' },
  DC061: { name: 'mount-source-missing', severity: 'warning', description: 'A bind mount source on the host does not exist.' },
  DC070: { name: 'unknown-variable', severity: 'warning', description: 'Unknown ${...} variable; it will not be substituted.' },
  DC071: { name: 'local-env-unset', severity: 'info', description: '${localEnv:VAR} is not set on this machine and has no default.' },
  DC080: { name: 'invalid-extension-id', severity: 'warning', description: 'A VS Code extension id must be "publisher.name".' },
  DC081: { name: 'root-user', severity: 'info', description: 'The container runs as root.' },
};

const KNOWN = new Set(
  `$schema name image build dockerFile context dockerComposeFile service runServices workspaceFolder workspaceMount shutdownAction
  overrideCommand forwardPorts portsAttributes otherPortsAttributes appPort containerEnv remoteEnv containerUser remoteUser
  updateRemoteUserUID userEnvProbe mounts runArgs initializeCommand onCreateCommand updateContentCommand postCreateCommand
  postStartCommand postAttachCommand waitFor features overrideFeatureInstallOrder customizations hostRequirements privileged init
  capAdd securityOpt secrets extensions settings devPort`.split(/\s+/),
);
const BUILD_KEYS = new Set(['dockerfile', 'context', 'args', 'target', 'cacheFrom', 'options']);
const LIFECYCLE = ['initializeCommand', 'onCreateCommand', 'updateContentCommand', 'postCreateCommand', 'postStartCommand', 'postAttachCommand'];
const ENUMS = {
  shutdownAction: ['none', 'stopContainer', 'stopCompose'],
  waitFor: LIFECYCLE,
  userEnvProbe: ['none', 'interactiveShell', 'loginShell', 'loginInteractiveShell'],
};
const TYPES = {
  name: 'string', image: 'string', service: 'string', workspaceFolder: 'string', workspaceMount: 'string', containerUser: 'string', remoteUser: 'string',
  forwardPorts: 'array', runArgs: 'array', mounts: 'array', runServices: 'array', capAdd: 'array', securityOpt: 'array', overrideFeatureInstallOrder: 'array',
  features: 'object', containerEnv: 'object', remoteEnv: 'object', customizations: 'object', portsAttributes: 'object', hostRequirements: 'object',
  privileged: 'boolean', init: 'boolean', overrideCommand: 'boolean', updateRemoteUserUID: 'boolean',
};
const LEGACY_FEATURES = new Set(['common', 'docker-in-docker', 'docker-from-docker', 'kubectl-helm-minikube', 'terraform', 'git', 'git-lfs', 'github-cli', 'azure-cli', 'sshd', 'rust', 'go', 'dotnet', 'jupyterlab', 'conda', 'hugo', 'node', 'python', 'php', 'ruby', 'java', 'powershell', 'desktop-lite', 'homebrew', 'fish', 'gradle', 'maven']);
const VARIABLES = /^(localEnv|containerEnv|env):[A-Za-z_][\w]*(:.*)?$|^(localWorkspaceFolder|containerWorkspaceFolder|localWorkspaceFolderBasename|containerWorkspaceFolderBasename|devcontainerId)$/;

function typeOf(v) {
  return Array.isArray(v) ? 'array' : v === null ? 'null' : typeof v;
}

function closest(word, candidates) {
  let best = null;
  let score = Infinity;
  for (const c of candidates) {
    const d = levenshtein(word.toLowerCase(), c.toLowerCase());
    if (d < score) {
      score = d;
      best = c;
    }
  }
  return score <= Math.max(2, Math.floor(word.length / 4)) ? best : null;
}

function levenshtein(a, b) {
  const prev = Array.from({ length: b.length + 1 }, (_, j) => j);
  for (let i = 1; i <= a.length; i++) {
    let last = prev[0];
    prev[0] = i;
    for (let j = 1; j <= b.length; j++) {
      const tmp = prev[j];
      prev[j] = Math.min(prev[j] + 1, prev[j - 1] + 1, last + (a[i - 1] === b[j - 1] ? 0 : 1));
      last = tmp;
    }
  }
  return prev[b.length];
}

/** Locate devcontainer.json files below a workspace root, in the order VS Code offers them. */
export function findConfigs(root) {
  const out = [];
  const main = path.join(root, '.devcontainer', 'devcontainer.json');
  if (fs.existsSync(main)) out.push(main);
  const rootFile = path.join(root, '.devcontainer.json');
  if (fs.existsSync(rootFile)) out.push(rootFile);
  const dir = path.join(root, '.devcontainer');
  if (fs.existsSync(dir) && fs.statSync(dir).isDirectory()) {
    for (const sub of fs.readdirSync(dir, { withFileTypes: true })) {
      const f = path.join(dir, sub.name, 'devcontainer.json');
      if (sub.isDirectory() && fs.existsSync(f)) out.push(f);
    }
  }
  return out;
}

/** The workspace root for a config file (the folder that contains .devcontainer). */
export function workspaceRootFor(configFile) {
  const dir = path.dirname(configFile);
  if (path.basename(configFile) === '.devcontainer.json') return dir;
  let d = dir;
  while (path.basename(d) !== '.devcontainer' && path.dirname(d) !== d) d = path.dirname(d);
  return path.basename(d) === '.devcontainer' ? path.dirname(d) : dir;
}

function gitMode(root, file) {
  const r = spawnSync('git', ['ls-files', '-s', '--', path.relative(root, file)], { cwd: root, encoding: 'utf8' });
  if (r.status !== 0 || !r.stdout) return null;
  return r.stdout.split(/\s+/)[0];
}

/**
 * Validate one devcontainer.json file.
 * @returns {{findings: object[], config: object|null}}
 */
export function validate(configFile, options = {}) {
  const ignore = options.ignore || new Set();
  const env = options.env || process.env;
  const root = options.root || workspaceRootFor(configFile);
  const configDir = path.dirname(configFile);
  const rel = (f) => path.relative(process.cwd(), f).split(path.sep).join('/') || f;
  const file = rel(configFile);
  const findings = [];
  const text = fs.readFileSync(configFile, 'utf8');

  let parsed;
  try {
    parsed = parseJsonc(text);
  } catch (err) {
    return { findings: [{ ruleId: 'DC001', severity: 'error', message: err.message, file, line: err.line || 1 }], config: null };
  }
  const { value: cfg, lines, duplicates } = parsed;
  const add = (ruleId, at, message, extra = {}) => {
    if (ignore.has(ruleId)) return;
    findings.push({ ruleId, severity: extra.severity || RULES[ruleId].severity, message, fix: extra.fix, file: extra.file || file, line: extra.line || lineOf(lines, at), context: extra.context });
  };
  if (typeOf(cfg) !== 'object') {
    add('DC001', '', 'The top level of devcontainer.json must be an object.');
    return { findings, config: null };
  }

  for (const d of duplicates) add('DC007', d.path, `"${d.path.replace(/~1/g, '/').replace(/~0/g, '~')}" is defined more than once; the last value wins.`, { line: d.line });

  // Properties and types --------------------------------------------------
  for (const key of Object.keys(cfg)) {
    if (!KNOWN.has(key)) {
      const hint = closest(key, KNOWN);
      add('DC004', escapeKey(key), `Unknown property "${key}".`, { fix: hint ? `did you mean "${hint}"?` : 'move tool-specific settings under "customizations"' });
    } else if (TYPES[key] && typeOf(cfg[key]) !== TYPES[key]) {
      add('DC005', key, `"${key}" must be ${TYPES[key] === 'array' ? 'an array' : `a ${TYPES[key]}`}, got ${typeOf(cfg[key])}.`);
    }
  }
  for (const [key, allowed] of Object.entries(ENUMS)) {
    if (cfg[key] !== undefined && !allowed.includes(cfg[key])) add('DC005', key, `Invalid ${key} "${cfg[key]}".`, { fix: `one of: ${allowed.join(', ')}` });
  }
  if (cfg.extensions) add('DC006', 'extensions', 'Top-level "extensions" is deprecated.', { fix: 'move it to customizations.vscode.extensions' });
  if (cfg.settings) add('DC006', 'settings', 'Top-level "settings" is deprecated.', { fix: 'move it to customizations.vscode.settings' });
  if (cfg.devPort !== undefined) add('DC006', 'devPort', '"devPort" is deprecated and ignored.');
  if (cfg.dockerFile !== undefined) add('DC006', 'dockerFile', 'Top-level "dockerFile" is deprecated.', { severity: 'info', fix: 'use "build": { "dockerfile": ... }' });
  if (cfg.context !== undefined) add('DC006', 'context', 'Top-level "context" is deprecated.', { severity: 'info', fix: 'use "build": { "context": ... }' });

  // Container source -----------------------------------------------------
  const build = typeOf(cfg.build) === 'object' ? cfg.build : null;
  if (cfg.build !== undefined && !build) add('DC005', 'build', '"build" must be an object.');
  const dockerfile = build?.dockerfile ?? cfg.dockerFile;
  const sources = [cfg.image && 'image', dockerfile && 'build', cfg.dockerComposeFile && 'dockerComposeFile'].filter(Boolean);
  if (sources.length === 0) add('DC002', '', 'No container source: set "image", "build.dockerfile" or "dockerComposeFile".');
  if (sources.length > 1) add('DC003', sources[1] === 'build' ? 'build' : sources[1], `Both ${sources.join(' and ')} are set; the tools use only one of them.`);
  if (build) {
    for (const k of Object.keys(build)) if (!BUILD_KEYS.has(k)) add('DC004', `build/${escapeKey(k)}`, `Unknown build property "${k}".`, { fix: closest(k, BUILD_KEYS) ? `did you mean "${closest(k, BUILD_KEYS)}"?` : undefined });
  }

  if (typeof cfg.image === 'string' && !cfg.dockerComposeFile) {
    const img = cfg.image;
    const tag = img.split('/').pop().split(':')[1];
    if (!img.includes('@') && (!tag || tag === 'latest')) add('DC012', 'image', `Image "${img}" ${tag ? 'uses "latest"' : 'has no tag'}; rebuilds can silently pick up breaking changes.`, { fix: `pin a version, e.g. ${img.split(':')[0]}:<version>` });
  }

  if (dockerfile) {
    const contextDir = path.resolve(configDir, String(build?.context ?? cfg.context ?? '.'));
    const dfPath = path.resolve(configDir, String(dockerfile));
    const at = build?.dockerfile !== undefined ? 'build/dockerfile' : 'dockerFile';
    if (!fs.existsSync(dfPath)) add('DC010', at, `Dockerfile "${dockerfile}" not found (resolved to ${rel(dfPath)}; paths are relative to devcontainer.json).`);
    if (!fs.existsSync(contextDir)) add('DC010', build?.context !== undefined ? 'build/context' : 'context', `Build context "${build?.context ?? cfg.context}" not found (resolved to ${rel(contextDir)}).`);
    if (build?.target && fs.existsSync(dfPath)) {
      const stages = [...fs.readFileSync(dfPath, 'utf8').matchAll(/^\s*FROM\s+\S+(?:\s+AS\s+(\S+))?/gim)].map((m) => m[1]?.toLowerCase()).filter(Boolean);
      if (!stages.includes(String(build.target).toLowerCase())) add('DC011', 'build/target', `build.target "${build.target}" is not a stage in ${dockerfile}${stages.length ? ` (stages: ${stages.join(', ')})` : ''}.`);
    }
  }

  // Docker Compose ---------------------------------------------------------
  if (cfg.dockerComposeFile) {
    const composeFiles = Array.isArray(cfg.dockerComposeFile) ? cfg.dockerComposeFile : [cfg.dockerComposeFile];
    const services = new Set();
    composeFiles.forEach((f, idx) => {
      const abs = path.resolve(configDir, String(f));
      const at = Array.isArray(cfg.dockerComposeFile) ? `dockerComposeFile/${idx}` : 'dockerComposeFile';
      if (!fs.existsSync(abs)) {
        add('DC020', at, `Compose file "${f}" not found (resolved to ${rel(abs)}).`);
        return;
      }
      try {
        const doc = parseYaml(fs.readFileSync(abs, 'utf8')) || {};
        Object.keys(doc.services || {}).forEach((s) => services.add(s));
      } catch (err) {
        add('DC020', at, `Compose file "${f}" is not valid YAML: ${err.message.split('\n')[0]}`);
      }
    });
    if (!cfg.service) add('DC021', 'dockerComposeFile', '"service" is required with dockerComposeFile.', { fix: services.size ? `"service": "${[...services][0]}"` : undefined });
    else if (services.size && !services.has(cfg.service)) add('DC021', 'service', `Service "${cfg.service}" is not defined in the Compose files (found: ${[...services].join(', ')}).`);
    (Array.isArray(cfg.runServices) ? cfg.runServices : []).forEach((s, idx) => {
      if (services.size && !services.has(s)) add('DC021', `runServices/${idx}`, `runServices entry "${s}" is not a Compose service.`);
    });
    if (!cfg.workspaceFolder) add('DC022', 'dockerComposeFile', 'workspaceFolder is not set, so VS Code opens "/" inside the container.', { fix: '"workspaceFolder": "/workspaces/${localWorkspaceFolderBasename}"' });
  }
  if (cfg.workspaceMount && !cfg.workspaceFolder) add('DC023', 'workspaceMount', 'workspaceMount is set without workspaceFolder.');

  // Features ---------------------------------------------------------------
  if (typeOf(cfg.features) === 'object') {
    for (const id of Object.keys(cfg.features)) {
      const at = `features/${escapeKey(id)}`;
      if (/^\.{1,2}\//.test(id)) {
        const dir = path.resolve(configDir, id);
        if (!fs.existsSync(path.join(dir, 'devcontainer-feature.json'))) add('DC031', at, `Local feature "${id}" not found: ${rel(path.join(dir, 'devcontainer-feature.json'))} does not exist.`, { fix: 'local features must live inside the .devcontainer folder' });
      } else if (/^https?:\/\//.test(id)) {
        if (!/\.(tgz|tar\.gz)$/.test(id)) add('DC030', at, `Feature URL "${id}" must point to a .tgz tarball.`);
      } else if (LEGACY_FEATURES.has(id)) {
        add('DC033', at, `"${id}" is a legacy short feature id.`, { fix: `"ghcr.io/devcontainers/features/${id === 'common' ? 'common-utils' : id}:1"` });
      } else if (!/^[a-z0-9][a-z0-9.-]*(:\d+)?\/[a-z0-9][a-z0-9._/-]*(:[\w.-]+|@sha256:[a-f0-9]{64})?$/i.test(id)) {
        add('DC030', at, `"${id}" is not a valid feature reference.`, { fix: 'use an OCI reference like ghcr.io/devcontainers/features/node:1' });
      } else if (!/:[\w.-]+$|@sha256:/.test(id.split('/').pop())) {
        add('DC032', at, `Feature "${id}" is not pinned to a version.`, { fix: `"${id}:1"` });
      }
      const v = cfg.features[id];
      if (!['object', 'string', 'boolean'].includes(typeOf(v))) add('DC005', at, `Options for feature "${id}" must be an object.`);
    }
  }
  if (Array.isArray(cfg.overrideFeatureInstallOrder)) {
    const bare = Object.keys(cfg.features || {}).map((f) => f.replace(/(@sha256:[a-f0-9]+|:[\w.-]+)$/, ''));
    cfg.overrideFeatureInstallOrder.forEach((f, idx) => {
      const b = String(f).replace(/(@sha256:[a-f0-9]+|:[\w.-]+)$/, '');
      if (!bare.includes(b)) add('DC034', `overrideFeatureInstallOrder/${idx}`, `"${f}" is not in "features".`);
    });
  }

  // Lifecycle commands -----------------------------------------------------
  const scripts = [];
  for (const hook of LIFECYCLE) {
    const value = cfg[hook];
    if (value === undefined) continue;
    const variants = typeOf(value) === 'object' ? Object.entries(value).map(([k, v]) => [`${hook}/${escapeKey(k)}`, v]) : [[hook, value]];
    for (const [at, cmd] of variants) {
      if (!['string', 'array'].includes(typeOf(cmd))) {
        add('DC005', at, `${hook} must be a string, an array or an object of commands.`);
        continue;
      }
      for (const ref of scriptRefs(cmd)) scripts.push({ ...ref, at, hook });
    }
  }
  const seenScripts = new Set();
  for (const s of scripts) {
    const abs = path.resolve(root, s.path.replace(/^\$\{containerWorkspaceFolder\}\/?|^\$\{localWorkspaceFolder\}\/?/, ''));
    if (!fs.existsSync(abs)) {
      add('DC040', s.at, `${s.hook} runs "${s.path}" but ${rel(abs)} does not exist (paths are relative to the workspace root).`);
      continue;
    }
    if (seenScripts.has(abs) || fs.statSync(abs).isDirectory()) continue;
    seenScripts.add(abs);
    const content = fs.readFileSync(abs, 'utf8');
    if (/\.(sh|bash)$/.test(abs) || content.startsWith('#!')) {
      if (content.includes('\r\n')) add('DC041', s.at, `${rel(abs)} has CRLF line endings; Linux fails with "/bin/bash^M: bad interpreter".`, { fix: 'convert to LF and add "*.sh text eol=lf" to .gitattributes' });
    }
    if (s.direct) {
      if (!content.startsWith('#!')) add('DC043', s.at, `${rel(abs)} is executed directly but has no shebang line.`, { fix: 'add #!/usr/bin/env bash as the first line, or run it with bash <script>' });
      const mode = gitMode(root, abs);
      if (mode && mode !== '100755') add('DC042', s.at, `${rel(abs)} is executed directly but is not executable in git (mode ${mode}); it fails with "Permission denied".`, { fix: `git update-index --chmod=+x ${path.relative(root, abs).split(path.sep).join('/')}` });
    }
  }
  if (scripts.some((s) => /\.(sh|bash)$/.test(s.path))) {
    const ga = path.join(root, '.gitattributes');
    const content = fs.existsSync(ga) ? fs.readFileSync(ga, 'utf8') : '';
    if (!/^\s*(\*|\*\.sh|\*\*\/\*\.sh|\S*\.sh)\s+.*eol=lf/m.test(content)) {
      add('DC044', LIFECYCLE.find((h) => cfg[h] !== undefined), 'Shell scripts are not forced to LF; Windows users with core.autocrlf=true will check them out with CRLF.', { fix: 'add "*.sh text eol=lf" to .gitattributes' });
    }
  }

  // Ports ------------------------------------------------------------------
  const forwarded = new Set();
  for (const key of ['forwardPorts', 'appPort']) {
    const list = cfg[key] === undefined ? [] : Array.isArray(cfg[key]) ? cfg[key] : [cfg[key]];
    list.forEach((p, idx) => {
      const at = Array.isArray(cfg[key]) ? `${key}/${idx}` : key;
      const valid = (typeof p === 'number' && Number.isInteger(p) && p >= 1 && p <= 65535) || (typeof p === 'string' && /^([\w.-]+:)?\d{1,5}(:\d{1,5})?$/.test(p) && p.split(':').every((x) => !/^\d+$/.test(x) || (Number(x) >= 1 && Number(x) <= 65535)));
      if (!valid) add('DC050', at, `Invalid port ${JSON.stringify(p)}.`, { fix: 'use a number (3000) or "host:port" ("db:5432")' });
      const keyStr = String(p);
      if (forwarded.has(keyStr)) add('DC051', at, `Port ${keyStr} is forwarded more than once.`);
      forwarded.add(keyStr);
    });
  }
  if (typeOf(cfg.portsAttributes) === 'object') {
    for (const k of Object.keys(cfg.portsAttributes)) {
      if (/^\d+$/.test(k) && !forwarded.has(k) && ![...forwarded].some((f) => f.endsWith(`:${k}`))) {
        add('DC052', `portsAttributes/${escapeKey(k)}`, `portsAttributes has settings for port ${k}, which is not in forwardPorts (they apply only if the port is auto-detected).`);
      }
    }
  }

  // Mounts -----------------------------------------------------------------
  (Array.isArray(cfg.mounts) ? cfg.mounts : []).forEach((m, idx) => {
    const at = `mounts/${idx}`;
    const mount = typeof m === 'string' ? Object.fromEntries(m.split(',').map((kv) => {
      const eq = kv.indexOf('=');
      return eq === -1 ? [kv.trim(), true] : [kv.slice(0, eq).trim(), kv.slice(eq + 1).trim()];
    })) : m;
    if (typeOf(mount) !== 'object') return add('DC060', at, 'A mount must be a string or an object.');
    const target = mount.target ?? mount.destination ?? mount.dst;
    const source = mount.source ?? mount.src;
    if (!mount.type) add('DC060', at, 'Mount is missing "type" (bind, volume or tmpfs).');
    else if (!['bind', 'volume', 'tmpfs'].includes(mount.type)) add('DC060', at, `Unknown mount type "${mount.type}".`);
    if (!target) add('DC060', at, 'Mount is missing "target".');
    if (mount.type === 'bind' && typeof source === 'string') {
      const local = source.replace(/\$\{localWorkspaceFolder\}/g, root).replace(/\$\{localEnv:(HOME|USERPROFILE)\}/g, () => env.HOME || env.USERPROFILE || '');
      if (!local.includes('${') && local && !fs.existsSync(path.resolve(root, local))) add('DC061', at, `Bind mount source "${source}" does not exist on this machine; container creation fails.`);
    }
  });

  // Variables --------------------------------------------------------------
  walkStrings(cfg, '', (str, at) => {
    for (const m of str.matchAll(/\$\{([^}]*)\}/g)) {
      const expr = m[1];
      if (!VARIABLES.test(expr)) {
        add('DC070', at, `Unknown variable "\${${expr}}".`, { fix: 'use ${localEnv:VAR}, ${containerEnv:VAR}, ${localWorkspaceFolder}, ${containerWorkspaceFolder} or ${devcontainerId}' });
        continue;
      }
      const le = expr.match(/^(?:localEnv|env):([A-Za-z_]\w*)(:.*)?$/);
      if (le && !le[2] && env[le[1]] === undefined) add('DC071', at, `\${${expr}} is not set on this machine and has no default; it becomes an empty string.`, { fix: `\${localEnv:${le[1]}:default}` });
    }
  });

  // Customizations ---------------------------------------------------------
  const exts = cfg.customizations?.vscode?.extensions ?? cfg.extensions;
  if (Array.isArray(exts)) {
    const base = cfg.customizations?.vscode?.extensions ? 'customizations/vscode/extensions' : 'extensions';
    exts.forEach((e, idx) => {
      if (typeof e !== 'string' || !/^-?[a-z0-9][\w-]*\.[a-z0-9][\w.-]*(@[\w.-]+)?$/i.test(e)) add('DC080', `${base}/${idx}`, `"${e}" is not a valid extension id.`, { fix: 'use "publisher.extension", e.g. "dbaeumer.vscode-eslint"' });
    });
  }
  if (cfg.remoteUser === 'root' || (cfg.containerUser === 'root' && !cfg.remoteUser)) add('DC081', cfg.remoteUser ? 'remoteUser' : 'containerUser', 'The dev container runs as root; files created in the workspace will be owned by root on Linux hosts.', { fix: 'use a non-root user such as "vscode" or "node"' });

  return { findings, config: cfg };
}

function walkStrings(value, at, fn) {
  if (typeof value === 'string') fn(value, at);
  else if (Array.isArray(value)) value.forEach((v, i) => walkStrings(v, at ? `${at}/${i}` : String(i), fn));
  else if (value && typeof value === 'object') for (const [k, v] of Object.entries(value)) walkStrings(v, at ? `${at}/${escapeKey(k)}` : escapeKey(k), fn);
}

const INTERPRETERS = new Set(['bash', 'sh', 'zsh', 'python', 'python3', 'node', 'pwsh', 'powershell', 'ruby', 'perl', 'source', '.']);
const SCRIPT_EXT = /\.(sh|bash|zsh|py|js|mjs|cjs|ts|rb|pl|ps1)$/;

/** Find workspace files referenced by a lifecycle command. */
export function scriptRefs(cmd) {
  const refs = [];
  const commands = Array.isArray(cmd) ? [cmd.map(String)] : String(cmd).split(/&&|\|\||;|\|/).map((s) => s.trim().split(/\s+/).filter(Boolean));
  for (const words of commands) {
    if (!words.length) continue;
    let i = 0;
    while (i < words.length && /^[A-Za-z_]\w*=/.test(words[i])) i++;
    if (words[i] === 'sudo') i++;
    const first = words[i];
    if (!first) continue;
    const clean = (w) => w.replace(/^["']|["']$/g, '');
    if (INTERPRETERS.has(first)) {
      const arg = words.slice(i + 1).find((w) => !w.startsWith('-'));
      if (arg && isWorkspacePath(clean(arg))) refs.push({ path: clean(arg), direct: false });
    } else if (isWorkspacePath(clean(first)) && (clean(first).includes('/') || SCRIPT_EXT.test(clean(first)))) {
      refs.push({ path: clean(first), direct: true });
    }
  }
  return refs;
}

function isWorkspacePath(p) {
  if (!p || p.startsWith('/') || p.startsWith('~') || p.startsWith('-') || /^[a-z]+:\/\//i.test(p)) return false;
  if (p.startsWith('${containerWorkspaceFolder}') || p.startsWith('${localWorkspaceFolder}')) return true;
  if (p.includes('$')) return false;
  return p.startsWith('./') || p.startsWith('../') || p.startsWith('.devcontainer/') || SCRIPT_EXT.test(p);
}
