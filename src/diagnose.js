import fs from 'node:fs';
import path from 'node:path';
import { spawnSync, spawn } from 'node:child_process';

const isWin = process.platform === 'win32';

// On Windows, npm-installed CLIs are .cmd shims that need a shell. Passing a
// single pre-quoted command string avoids Node's unescaped-args deprecation.
const quote = (a) => (/[\s"&|<>^]/.test(a) ? `"${a.replace(/"/g, '\\"')}"` : a);
const command = (cmd, args) => (isWin ? [[cmd, ...args].map(quote).join(' '), [], { shell: true }] : [cmd, args, {}]);

function run(cmd, args, timeout = 20000) {
  const [file, argv, extra] = command(cmd, args);
  const r = spawnSync(file, argv, { encoding: 'utf8', timeout, ...extra });
  return { ok: r.status === 0, out: `${r.stdout || ''}${r.stderr || ''}`.trim() };
}

/**
 * Check the host: Docker CLI and daemon, Compose plugin, Dev Container CLI and git line endings.
 * @returns {{id, status: 'ok'|'warn'|'fail'|'skip', title, detail?, fix?}[]}
 */
export function checkEnvironment({ root, config }) {
  const checks = [];
  const docker = run('docker', ['--version']);
  if (!docker.ok) {
    checks.push({ id: 'docker-cli', status: 'fail', title: 'Docker CLI not found', fix: 'install Docker Desktop, Docker Engine, Podman (with docker alias) or Rancher Desktop' });
  } else {
    checks.push({ id: 'docker-cli', status: 'ok', title: docker.out.split('\n')[0] });
    const info = run('docker', ['info', '--format', '{{.ServerVersion}} {{.OSType}}/{{.Architecture}}'], 30000);
    checks.push(info.ok
      ? { id: 'docker-daemon', status: 'ok', title: `Docker daemon running (${info.out.split('\n')[0]})` }
      : { id: 'docker-daemon', status: 'fail', title: 'Docker daemon is not reachable', detail: info.out.split('\n').slice(-1)[0], fix: 'start Docker Desktop / the docker service' });
    if (config?.dockerComposeFile) {
      const compose = run('docker', ['compose', 'version']);
      checks.push(compose.ok
        ? { id: 'docker-compose', status: 'ok', title: compose.out.split('\n')[0] }
        : { id: 'docker-compose', status: 'fail', title: 'Docker Compose v2 plugin not found', fix: 'install the docker compose plugin' });
    }
  }

  const cli = run('devcontainer', ['--version']);
  checks.push(cli.ok
    ? { id: 'devcontainer-cli', status: 'ok', title: `Dev Container CLI ${cli.out.split('\n')[0]}` }
    : { id: 'devcontainer-cli', status: 'warn', title: 'Dev Container CLI not installed (needed for --build)', fix: 'npm install -g @devcontainers/cli' });

  const git = run('git', ['config', '--get', 'core.autocrlf']);
  const ga = path.join(root, '.gitattributes');
  const lfForced = fs.existsSync(ga) && /eol=lf/.test(fs.readFileSync(ga, 'utf8'));
  if (git.ok && git.out === 'true' && !lfForced) {
    checks.push({ id: 'git-autocrlf', status: 'warn', title: 'git core.autocrlf=true and no eol=lf in .gitattributes', detail: 'shell scripts are checked out with CRLF and break inside Linux containers', fix: 'add "* text=auto eol=lf" to .gitattributes' });
  } else {
    checks.push({ id: 'git-autocrlf', status: 'ok', title: `git line endings safe (core.autocrlf=${git.out || 'unset'}${lfForced ? ', eol=lf enforced' : ''})` });
  }
  return checks;
}

/** Build the container using the Dev Container CLI; streams output. Resolves to the exit code. */
export function buildContainer({ root, configFile, onOutput }) {
  return new Promise((resolve) => {
    const args = ['build', '--workspace-folder', root, '--config', configFile];
    const [file, argv, extra] = command('devcontainer', args);
    const child = spawn(file, argv, { cwd: root, ...extra });
    child.stdout.on('data', (d) => onOutput?.(d.toString()));
    child.stderr.on('data', (d) => onOutput?.(d.toString()));
    child.on('error', () => resolve(127));
    child.on('close', (code) => resolve(code ?? 1));
  });
}
