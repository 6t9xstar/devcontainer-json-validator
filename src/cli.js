import fs from 'node:fs';
import path from 'node:path';
import { parseArgs } from 'node:util';
import { createRequire } from 'node:module';
import { findConfigs, validate, workspaceRootFor, RULES } from './rules.js';
import { checkEnvironment, buildContainer } from './diagnose.js';
import * as R from './reporters.js';

const require = createRequire(import.meta.url);
const pkg = require('../package.json');
const TOOL = { name: 'DevContainer Doctor', version: pkg.version, uri: 'https://github.com/6t9xstar/devcontainer-json-validator' };

const HELP = `DevContainer Doctor ${pkg.version} - devcontainer.json validator and Dev Containers troubleshooter

Usage
  devcontainer-doctor scan [path]       Validate devcontainer.json files (default command)
  devcontainer-doctor diagnose [path]   Validate + check Docker, Compose, Dev Container CLI and git line endings
  devcontainer-doctor diagnose --build  ...and build the container with the Dev Container CLI
  devcontainer-doctor rules             List all rules

[path] is a workspace folder (default: .) or a devcontainer.json file.

Options
  -f, --format <fmt>      text | json | sarif | markdown | github   (default: text)
  -o, --output <file>     Write the report to a file
      --fail-on <level>   error | warning | info | none             (default: error)
      --ignore <ids>      Comma-separated rule ids to skip, e.g. DC032,DC081
      --build             (diagnose) run "devcontainer build" as a final test
      --no-color          Disable colors
  -h, --help / -v, --version

Exit codes: 0 = ok, 1 = findings at or above --fail-on (or a failed environment check), 2 = usage error

Docs: ${TOOL.uri}`;

export async function main(argv) {
  let parsed;
  try {
    parsed = parseArgs({
      args: argv,
      allowPositionals: true,
      options: {
        format: { type: 'string', short: 'f', default: 'text' },
        output: { type: 'string', short: 'o' },
        'fail-on': { type: 'string', default: 'error' },
        ignore: { type: 'string', default: '' },
        build: { type: 'boolean' },
        'no-color': { type: 'boolean' },
        help: { type: 'boolean', short: 'h' },
        version: { type: 'boolean', short: 'v' },
      },
    });
  } catch (err) {
    return usage(err.message);
  }
  const { values: opts, positionals } = parsed;
  if (opts.version) return print(pkg.version), 0;
  if (opts.help) return print(HELP), 0;
  const command = ['scan', 'diagnose', 'rules'].includes(positionals[0]) ? positionals.shift() : 'scan';
  if (!R.FORMATS.includes(opts.format)) return usage(`Unknown format "${opts.format}"`);
  if (!['error', 'warning', 'info', 'none'].includes(opts['fail-on'])) return usage(`Unknown --fail-on level "${opts['fail-on']}"`);
  const c = R.colors(R.shouldUseColor(opts['no-color'] ? false : undefined));

  if (command === 'rules') {
    for (const [id, r] of Object.entries(RULES)) print(`${c.bold(id)} ${r.name} ${c.gray(`(${r.severity})`)}\n    ${r.description}`);
    return 0;
  }

  const target = path.resolve(positionals[0] || '.');
  if (!fs.existsSync(target)) return usage(`Path not found: ${positionals[0]}`);
  let configs;
  let root;
  if (fs.statSync(target).isFile()) {
    configs = [target];
    root = workspaceRootFor(target);
  } else {
    root = target;
    configs = findConfigs(root);
    if (!configs.length) return usage(`No .devcontainer/devcontainer.json or .devcontainer.json found in ${target}`);
  }

  const ignore = new Set(opts.ignore.split(',').map((s) => s.trim().toUpperCase()).filter(Boolean));
  const results = configs.map((f) => ({ file: f, ...validate(f, { root, ignore }) }));
  const findings = results.flatMap((r) => r.findings);
  let failed = findings.some((f) => opts['fail-on'] !== 'none' && R.atLeast(f.severity, opts['fail-on']));

  let checks = null;
  if (command === 'diagnose') {
    checks = checkEnvironment({ root, config: results[0].config });
    if (checks.some((ch) => ch.status === 'fail')) failed = true;
  }

  const out = render(findings, configs, checks, opts.format, c);
  if (opts.output) fs.writeFileSync(opts.output, out + '\n');
  else print(out);

  if (command === 'diagnose' && opts.build) {
    const hasErrors = findings.some((f) => f.severity === 'error');
    if (hasErrors) {
      print(c.yellow('\nSkipping the build: fix the errors above first.'));
      return 1;
    }
    if (checks.some((ch) => ch.status !== 'ok' && ['docker-cli', 'docker-daemon', 'devcontainer-cli'].includes(ch.id))) {
      print(c.yellow('\nSkipping the build: Docker and the Dev Container CLI must be available.'));
      return 1;
    }
    print(c.bold(`\nBuilding ${path.relative(process.cwd(), configs[0]) || configs[0]} ...`));
    const code = await buildContainer({ root, configFile: configs[0], onOutput: (s) => process.stdout.write(c.gray(s)) });
    print(code === 0 ? c.green('✔ Container built successfully.') : c.red(`✖ Build failed (exit code ${code}).`));
    if (code !== 0) failed = true;
  }
  return failed ? 1 : 0;
}

function render(findings, configs, checks, format, c) {
  const files = configs.map((f) => path.relative(process.cwd(), f).split(path.sep).join('/'));
  switch (format) {
    case 'json':
      return R.renderJson(findings, { tool: TOOL, extra: { files, environment: checks || undefined } });
    case 'sarif':
      return R.renderSarif(findings, { tool: TOOL, rules: RULES });
    case 'markdown': {
      let md = R.renderMarkdown(findings, { tool: TOOL, title: 'DevContainer Doctor Report' });
      if (checks) md += '\n\n### Environment\n\n' + checks.map((ch) => `- ${ch.status === 'ok' ? ':white_check_mark:' : ch.status === 'warn' ? ':warning:' : ':x:'} ${ch.title}${ch.fix ? ` — ${ch.fix}` : ''}`).join('\n');
      return md;
    }
    case 'github':
      return R.renderGithub(findings) || '::notice title=DevContainer Doctor::devcontainer.json is valid';
  }
  const lines = [c.bold('DEVCONTAINER DOCTOR'), c.gray(files.join(', ')), ''];
  for (const f of R.sortFindings(findings)) {
    lines.push(`${R.severityLabel(f.severity, c)} ${f.message}`);
    lines.push(c.gray(`          ${f.ruleId} ${f.file}:${f.line}`) + (f.fix ? `  ${c.cyan('Fix:')} ${f.fix}` : ''));
  }
  const s = R.countBySeverity(findings);
  lines.push('', findings.length ? `${findings.length} findings (${s.error} errors, ${s.warning} warnings, ${s.info} info).` : c.green('✔ Configuration is valid.'));
  if (checks) {
    lines.push('', c.bold('ENVIRONMENT'));
    for (const ch of checks) {
      const icon = ch.status === 'ok' ? c.green('✔') : ch.status === 'warn' ? c.yellow('!') : c.red('✖');
      lines.push(`${icon} ${ch.title}`);
      if (ch.detail) lines.push(c.gray(`    ${ch.detail}`));
      if (ch.fix) lines.push(`    ${c.cyan('Fix:')} ${ch.fix}`);
    }
  }
  return lines.join('\n');
}

function usage(message) {
  console.error(`devcontainer-doctor: ${message}\nRun "devcontainer-doctor --help" for usage.`);
  return 2;
}

function print(s) {
  process.stdout.write(s + '\n');
}
