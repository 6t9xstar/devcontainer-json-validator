# DevContainer Doctor: devcontainer.json validator and Dev Containers troubleshooter

**Validate `devcontainer.json` and find the setup errors that break VS Code Dev Containers and GitHub Codespaces before you wait for a rebuild: missing Dockerfiles, wrong Compose services, broken features, CRLF scripts, bad ports and mounts.**

[![CI](https://github.com/6t9xstar/devcontainer-json-validator/actions/workflows/ci.yml/badge.svg)](https://github.com/6t9xstar/devcontainer-json-validator/actions/workflows/ci.yml)
[![License: MIT](https://img.shields.io/badge/license-MIT-blue.svg)](LICENSE)
![Node.js](https://img.shields.io/badge/node-%3E%3D18.17-brightgreen)

"An error occurred setting up the container." Then you scroll through a 2,000-line build log to find out that `postCreateCommand` points at a script with Windows line endings (`/bin/bash^M: bad interpreter`), or that `service` names a Compose service that doesn't exist.
**DevContainer Doctor** reads your configuration the way the Dev Containers tooling does and explains every problem with a line number and a fix, in less than a second.

```bash
npx github:6t9xstar/devcontainer-json-validator
```

## Example

```text
DEVCONTAINER DOCTOR
.devcontainer/devcontainer.json

[WARNING] Both image and build are set; the tools use only one of them.
          DC003 .devcontainer/devcontainer.json:5
[ERROR]   Dockerfile "Dockerfile" not found (resolved to .devcontainer/Dockerfile; paths are relative to devcontainer.json).
          DC010 .devcontainer/devcontainer.json:6
[WARNING] Feature "ghcr.io/devcontainers/features/github-cli" is not pinned to a version.
          DC032 .devcontainer/devcontainer.json:10  Fix: "ghcr.io/devcontainers/features/github-cli:1"
[WARNING] "node" is a legacy short feature id.
          DC033 .devcontainer/devcontainer.json:11  Fix: "ghcr.io/devcontainers/features/node:1"
[ERROR]   Invalid port 70000.
          DC050 .devcontainer/devcontainer.json:16
[ERROR]   postCreateCommand runs ".devcontainer/scripts/missing.sh" but .devcontainer/scripts/missing.sh does not exist.
          DC040 .devcontainer/devcontainer.json:23
[ERROR]   .devcontainer/scripts/start.sh has CRLF line endings; Linux fails with "/bin/bash^M: bad interpreter".
          DC041 .devcontainer/devcontainer.json:24  Fix: convert to LF and add "*.sh text eol=lf" to .gitattributes
[ERROR]   Invalid shutdownAction "stopEverything".
          DC005 .devcontainer/devcontainer.json:25  Fix: one of: none, stopContainer, stopCompose
[WARNING] Unknown property "forwardport".
          DC004 .devcontainer/devcontainer.json:28  Fix: did you mean "forwardPorts"?

23 findings (8 errors, 11 warnings, 4 info).
```

Abridged output for [`fixtures/broken`](fixtures/broken/.devcontainer/devcontainer.json).

## What it checks

- **JSONC syntax**, including comments and trailing commas, with exact line and column. Also catches duplicate keys.
- **Container source**: `image`, `build.dockerfile` / `build.context` (resolved relative to `devcontainer.json`), and `build.target` against the stages in your Dockerfile.
- **Docker Compose**: `dockerComposeFile` paths, `service` and `runServices` against the services actually defined, and `workspaceFolder`.
- **Features**: OCI references, local `./features` (with `devcontainer-feature.json`), tarball URLs, unpinned versions, legacy short ids, and `overrideFeatureInstallOrder`.
- **Lifecycle commands** (`initializeCommand` … `postAttachCommand`, string/array/object forms): referenced scripts must exist, must not have CRLF endings, need a shebang and the git executable bit when run directly, and `.gitattributes` should force LF.
- **Ports**: `forwardPorts` / `appPort` ranges and `host:port` syntax, duplicates, unused `portsAttributes`.
- **Mounts**: string and object syntax, `type`/`target`, and bind sources that don't exist on your machine.
- **Variables**: unknown `${...}` variables and `${localEnv:VAR}` that are unset without a default.
- **Typos and deprecations**: unknown properties with "did you mean", top-level `extensions` / `settings`, `dockerFile`, invalid enums, wrong types, invalid VS Code extension ids, and running as root.

### `diagnose`: check the machine too

Example on a machine with Docker installed:

```text
$ devcontainer-doctor diagnose
...
ENVIRONMENT
✔ Docker version 28.4.0, build d8eb465
✔ Docker daemon running (28.4.0 linux/x86_64)
! Dev Container CLI not installed (needed for --build)
    Fix: npm install -g @devcontainers/cli
! git core.autocrlf=true and no eol=lf in .gitattributes
    shell scripts are checked out with CRLF and break inside Linux containers
    Fix: add "* text=auto eol=lf" to .gitattributes
```

`devcontainer-doctor diagnose --build` then builds the container with the official [Dev Container CLI](https://github.com/devcontainers/cli) as a final end-to-end test.

## Install

**Requirements**

- Node.js 18.17 or newer
- git (to install straight from GitHub)
- Windows, macOS or Linux
- Docker is only needed for `diagnose` and `diagnose --build`.

```bash
npx github:6t9xstar/devcontainer-json-validator              # run once
npm install -g github:6t9xstar/devcontainer-json-validator   # installs devcontainer-doctor
```

## Usage

```bash
devcontainer-doctor                                    # finds .devcontainer/devcontainer.json, .devcontainer.json, .devcontainer/*/devcontainer.json
devcontainer-doctor scan path/to/repo
devcontainer-doctor scan .devcontainer/python/devcontainer.json
devcontainer-doctor diagnose                           # + Docker, Compose, CLI and git checks
devcontainer-doctor diagnose --build                   # + real container build
devcontainer-doctor rules
```

| Option | Description |
| --- | --- |
| `-f, --format` | `text`, `json`, `sarif`, `markdown`, `github` |
| `-o, --output <file>` | Write the report to a file |
| `--fail-on <level>` | `error` (default), `warning`, `info`, `none` |
| `--ignore <ids>` | Skip rules, e.g. `--ignore DC032,DC081` |
| `--build` | With `diagnose`: run `devcontainer build` |

## GitHub Action

```yaml
name: Dev Container
on:
  pull_request:
    paths: ['.devcontainer/**', '.devcontainer.json']
jobs:
  validate:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v7
      - uses: 6t9xstar/devcontainer-json-validator@v1
        with:
          path: .
          fail-on: error
```

## Rules

| Rule | Severity | Description |
| --- | --- | --- |
| DC001 | error | Invalid JSONC |
| DC002 | error | No `image`, `build.dockerfile` or `dockerComposeFile` |
| DC003 | warning | More than one container source |
| DC004 | warning | Unknown property (typo) |
| DC005 | error | Wrong type or invalid enum value |
| DC006 | warning / info | Deprecated property |
| DC007 | warning | Duplicate property |
| DC010 | error | Dockerfile or build context missing |
| DC011 | error | `build.target` not a stage in the Dockerfile |
| DC012 | warning | Image uses `latest` or no tag |
| DC020 | error | Compose file missing or invalid |
| DC021 | error | `service` / `runServices` not defined in Compose |
| DC022 | warning | Compose config without `workspaceFolder` |
| DC023 | error | `workspaceMount` without `workspaceFolder` |
| DC030 | error | Invalid feature reference |
| DC031 | error | Local feature folder or `devcontainer-feature.json` missing |
| DC032 | warning | Feature not pinned to a version |
| DC033 | warning | Legacy short feature id |
| DC034 | warning | `overrideFeatureInstallOrder` entry not installed |
| DC040 | error | Lifecycle script does not exist |
| DC041 | error | Shell script with CRLF line endings |
| DC042 | warning | Script executed directly but not executable in git |
| DC043 | warning | Script executed directly without a shebang |
| DC044 | info | No `.gitattributes` rule forcing LF for shell scripts |
| DC050 | error | Invalid port |
| DC051 | warning | Port forwarded twice |
| DC052 | info | `portsAttributes` for a port that is not forwarded |
| DC060 | error | Mount missing `type`/`target` or unknown type |
| DC061 | warning | Bind mount source missing on this machine |
| DC070 | warning | Unknown `${...}` variable |
| DC071 | info | `${localEnv:VAR}` unset and without default |
| DC080 | warning | Invalid VS Code extension id |
| DC081 | info | Container runs as root |

## FAQ

### How do I validate devcontainer.json?

Run `npx github:6t9xstar/devcontainer-json-validator` in your repository. It understands JSONC (comments and trailing commas), so you don't need to strip anything first.

### How do I fix "/bin/bash^M: bad interpreter" in a dev container?

The script was checked out with Windows (CRLF) line endings. Convert it to LF and add `*.sh text eol=lf` to `.gitattributes` so git keeps it that way on every machine. DevContainer Doctor reports this as DC041 and DC044.

### Why is my postCreateCommand failing with "Permission denied"?

A script run as `./script.sh` must be executable. On Windows the executable bit is easy to lose; fix it with `git update-index --chmod=+x script.sh`, or run it with `bash script.sh` (DC042).

### Does this replace the Dev Container CLI?

No, it complements it. The [Dev Container CLI](https://github.com/devcontainers/cli) builds and runs containers. DevContainer Doctor explains configuration problems in seconds without Docker, and `diagnose --build` calls the CLI for the end-to-end check.

## More developer tools

- [WorkflowTriggerDoctor](https://github.com/6t9xstar/workflow-trigger-doctor): why a GitHub Actions workflow did not run
- [PackageProof](https://github.com/6t9xstar/packageproof): detect hallucinated and non-existent npm and PyPI packages
- [PaginationProbe](https://github.com/6t9xstar/pagination-probe): REST API pagination tester
- [GitHookDoctor](https://github.com/6t9xstar/git-hook-doctor): Git hooks, Husky, Lefthook and pre-commit troubleshooter
- [NpmTarballAudit](https://github.com/6t9xstar/npm-tarball-audit): npm package contents and secrets auditor
- [CachePilot](https://github.com/6t9xstar/github-actions-cache-optimizer): GitHub Actions cache analyzer and optimizer
- [ComposeDoctor](https://github.com/6t9xstar/docker-compose-doctor): Docker Compose validator and troubleshooter
- [DevContainer Doctor](https://github.com/6t9xstar/devcontainer-json-validator): devcontainer.json validator
- [OwnerScope](https://github.com/6t9xstar/codeowners-coverage-checker): CODEOWNERS validator and coverage checker
- [ScriptPort](https://github.com/6t9xstar/npm-scripts-cross-platform-checker): cross-platform npm scripts checker

## License

[MIT](LICENSE)
