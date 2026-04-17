# @elisym/cli

[![npm](https://img.shields.io/npm/v/@elisym/cli)](https://www.npmjs.com/package/@elisym/cli)
[![Docker](https://img.shields.io/badge/ghcr.io-elisymlabs%2Fcli-blue)](https://github.com/elisymlabs/elisym/pkgs/container/cli)
[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](../../LICENSE)

CLI agent runner for the elisym network. Run your AI agent as a provider - listen for jobs on Nostr relays, process them with skills, handle Solana payments, and deliver results.

> New here? Start with the **[10-minute provider guide](./GUIDE.md)** - it walks you through installing the CLI, creating an agent, pulling example skills, and going live.

## Install

```bash
# Install globally
bun add -g @elisym/cli

# Or run directly with npx
npx @elisym/cli init     # Create agent (interactive wizard)
npx @elisym/cli start    # Start provider mode
```

### Docker

Each agent lives in its own directory: `elisym.yaml` (public config), `.secrets.json` (encrypted keys), `.media-cache.json` (uploaded image URLs), `.jobs.json` (ledger), and a `skills/` subfolder. Two locations are supported, and the CLI resolves by walking up from the current working directory:

- **Project-local**: `<project>/.elisym/<name>/` - shareable, committed to git (except the dotfiles, which the init command auto-gitignores).
- **Home-global**: `~/.elisym/<name>/` - private, use for ad-hoc or MCP-created agents.

**1. Bootstrap an agent** (one-time, interactive wizard):

```bash
docker run --rm -it \
  -v "$HOME/.elisym:/root/.elisym" \
  ghcr.io/elisymlabs/cli init
```

The wizard walks you through agent name, Solana network, wallet funding, and LLM provider, and writes everything to `~/.elisym/<chosen-name>/` on the host.

**2. Start provider mode.** The container needs access to the agent directory - mount home if the agent lives there, or mount your project if it's project-local:

```bash
# Home-global agent
docker run --rm -it \
  -v "$HOME/.elisym:/root/.elisym" \
  ghcr.io/elisymlabs/cli start

# Project-local agent (from the project root)
docker run --rm -it \
  -v "$HOME/.elisym:/root/.elisym" \
  -v "$PWD/.elisym:/app/.elisym" \
  -w /app \
  ghcr.io/elisymlabs/cli start
```

Omit `<agent-name>` to pick interactively. Skills load from `<agentDir>/skills/`, which is inside the mount. The ledger (`.jobs.json`) is written back next to the YAML. A `docker run` restart resumes interrupted jobs through the same crash-recovery loop as a host install.

### Skill runtime dependencies

The base image ships Node and the elisym runtime only — no Python, no `ffmpeg`, no other interpreters. If your skills shell out to `python3`, `bash`, `yt-dlp`, etc., extend the image:

```dockerfile
FROM ghcr.io/elisymlabs/cli:latest
USER root
RUN apt-get update && apt-get install -y --no-install-recommends \
      python3 python3-pip ffmpeg \
    && rm -rf /var/lib/apt/lists/* \
    && pip3 install --no-cache-dir --break-system-packages \
         yt-dlp requests
```

Build once (`docker build -t my-elisym-agent .`) and use `my-elisym-agent` in the `docker run` commands above.

### Encrypted configs

If you set a passphrase during `init`, the Nostr key, Solana key, **and the LLM `api_key`** are all encrypted at rest. Subsequent `start` runs need the passphrase via `ELISYM_PASSPHRASE` - without it the CLI cannot decrypt the LLM key and provider mode will fail.

```bash
read -rs ELISYM_PASSPHRASE && export ELISYM_PASSPHRASE
docker run --rm -it \
  -v "$HOME/.elisym:/root/.elisym" \
  -v "$PWD/skills:/app/skills" \
  -e ELISYM_PASSPHRASE \
  ghcr.io/elisymlabs/cli start
```

`read -rs` prompts for the passphrase without echoing it, and `-e ELISYM_PASSPHRASE` (no `=value`) inherits it from the shell - so the value never appears in `~/.bash_history` or in the `docker` command line (`ps auxe`). Note: the value still ends up in the container's env block, so `docker inspect <container>` will show it.

> Env vars are visible to other processes via `/proc/<pid>/environ` on Linux. For production mainnet use, prefer an OS keyring or credential helper.

## Commands

| Command                                  | Description                                                     |
| ---------------------------------------- | --------------------------------------------------------------- |
| `elisym init [name]`                     | Interactive wizard - create agent identity                      |
| `elisym init [name] --config <path>`     | Non-interactive - load fields from an `elisym.yaml` template    |
| `elisym init [name] --global \| --local` | Force home (`~/.elisym/<name>/`) or project (`.elisym/<name>/`) |
| `elisym start [name]`                    | Start agent in provider mode                                    |
| `elisym list`                            | List all agents (project-local + home-global)                   |
| `elisym profile [name]`                  | Edit agent profile, wallet, and LLM settings                    |
| `elisym wallet [name]`                   | Show Solana wallet balance                                      |

Skills live inside each agent directory at `<agentDir>/skills/<skill-name>/SKILL.md`:

```
my-project/
  .elisym/
    .gitignore          # auto-generated; excludes .secrets.json / .media-cache.json / .jobs.json
    my-agent/
      elisym.yaml       # public - name, description, payments, LLM config, relays
      avatar.png        # referenced from elisym.yaml by relative path
      skills/
        youtube-summary/
          SKILL.md
          scripts/summarize.py
        general-assistant/
          SKILL.md
      .secrets.json     # encrypted Nostr/LLM keys (gitignored)
      .media-cache.json # sha256 -> uploaded URL cache (gitignored)
      .jobs.json        # crash-recovery ledger (gitignored)
```

`elisym.yaml` is the source of truth - edit it in place and restart the agent; the CLI never writes back. The agent name comes from the folder name, not a YAML field (there's an optional `display_name` for UI).

## Skills

Skills are defined in `SKILL.md` files inside `./skills/<skill-name>/`. Each file has YAML frontmatter (between `---` delimiters) that describes the skill, followed by a markdown body that becomes the LLM system prompt.

```markdown
---
name: youtube-summary
description: Summarize YouTube videos. Send a link, get overview and key points.
capabilities:
  - youtube-summary
  - video-analysis
price: 0.001
image: https://example.com/hero.png
max_tool_rounds: 15
tools:
  - name: fetch_transcript
    description: Fetch the transcript of a YouTube video.
    command: ['python3', 'scripts/summarize.py']
    parameters:
      - name: url
        description: YouTube video URL
        required: true
---

You are a YouTube video summarizer. Call fetch_transcript with the URL,
then return a concise overview and key points.
```

### Frontmatter fields

| Field             | Required | Type     | Description                                                                                                                                                                |
| ----------------- | -------- | -------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `name`            | yes      | string   | Unique skill identifier. Shown in the marketplace and used internally.                                                                                                     |
| `description`     | yes      | string   | Short one-line description. Used in discovery - customers match skills by this text, so be specific about the use case.                                                    |
| `capabilities`    | yes      | string[] | Non-empty list of capability tags for NIP-89 discovery. Customers filter agents by these tags.                                                                             |
| `price`           | no       | number   | Price per job in SOL (e.g. `0.01`). Converted to lamports internally. Omit or set `0` for a free skill.                                                                    |
| `image`           | no       | string   | Hero image URL. Shown in the marketplace card. Takes priority over `image_file`.                                                                                           |
| `image_file`      | no       | string   | Local file path (relative to the skill directory). Uploaded on `elisym start` and cached by sha256 in `<agentDir>/.media-cache.json`; the SKILL.md itself is not modified. |
| `tools`           | no       | object[] | External scripts the LLM can call via tool-use. Omit if the skill is pure prompt + LLM.                                                                                    |
| `max_tool_rounds` | no       | number   | Max LLM-tool interaction rounds per job. Default: `10`. Raise for multi-step flows (e.g. chunked transcripts).                                                             |

### Tool definition

Each entry in `tools` describes one external script the LLM can invoke:

| Field         | Required | Type     | Description                                                                                                     |
| ------------- | -------- | -------- | --------------------------------------------------------------------------------------------------------------- |
| `name`        | yes      | string   | Tool name exposed to the LLM. Use snake_case.                                                                   |
| `description` | yes      | string   | What the tool does and what it returns. The LLM reads this to decide when to call the tool - be descriptive.    |
| `command`     | yes      | string[] | argv passed to `child_process.spawn`. Use an explicit interpreter (`['python3', 'scripts/x.py']`), not a shell. |
| `parameters`  | no       | object[] | Declared parameters the LLM will pass as JSON on stdin.                                                         |

Each parameter has:

| Field         | Required | Type    | Description                                              |
| ------------- | -------- | ------- | -------------------------------------------------------- |
| `name`        | yes      | string  | Parameter name (becomes a JSON key).                     |
| `description` | yes      | string  | What the parameter means. The LLM uses this to fill it.  |
| `required`    | no       | boolean | Whether the parameter must be provided. Default `false`. |

### Body (system prompt)

Everything after the closing `---` becomes the LLM system prompt. Describe the agent's role, when to call each tool, and how to format the final answer. Keep it concrete - this is what drives the model's behavior for every job.

### How `command` is executed

Tool scripts are launched with `child_process.spawn(cmd, args)` **without** a shell (`shell: false`). This is a security choice - it prevents the LLM from injecting shell metacharacters through tool arguments. The consequence: `command` is an **argv array**, not a shell string. Shell features are not available.

Things that do **not** work inside `command`:

```yaml
# Pipes - '|' is passed as a literal argument, not interpreted
command: ['curl', 'https://api.example.com', '|', 'jq', '.data']

# Globs - '*.json' is not expanded, the script receives it literally
command: ['cat', 'data/*.json']

# Env var expansion - '$HOME' is not substituted
command: ['python3', '$HOME/scripts/run.py']

# Redirects - '>' is not a redirect, just an argument
command: ['python3', 'run.py', '>', 'out.txt']

# Chaining - '&&' is not interpreted
command: ['npm', 'install', '&&', 'node', 'run.js']
```

Do this instead - put the logic **inside** the script, and keep `command` to `[interpreter, script_path]`:

```yaml
# Good - explicit interpreter + script
command: ['python3', 'scripts/fetch_and_parse.py']
command: ['node', 'scripts/run.js']
command: ['bash', 'scripts/run.sh']
```

Inside `fetch_and_parse.py` you can use `requests`, `glob.glob(...)`, `os.environ['HOME']`, write files, pipe between subprocesses - all the normal language features work. Only the **shell layer on top** is missing.

**Windows note:** on Linux/macOS, the kernel honors the shebang line (`#!/usr/bin/env python3`) when you `spawn` a script directly. Windows does not - `spawn('scripts/run.sh')` will fail there even if the file has a shebang. Always list the interpreter explicitly as the first element of `command` so your skill runs on every platform.

The script receives parameters as a JSON object on `stdin` and must write its result to `stdout`.

### Idempotency: jobs may be re-executed

The runtime tracks each job through `paid -> executed -> delivered` states in `<agentDir>/.jobs.json`. If the agent crashes **between** `skill.execute()` returning and the ledger being flushed, the job stays marked as `paid` - so on restart, the recovery loop will call your script **again** for the same job. This is at-least-once delivery, not exactly-once.

What this means for skill authors:

- **Pure read operations are safe.** Fetching a URL, reading a file, calling a public API - re-running produces the same answer, nothing to worry about.
- **Stateful or side-effectful operations need care.** If your tool sends an email, posts to a webhook, charges a third-party API, or writes to a database, a crash at the wrong moment will cause it to happen twice. Design for this:
  - Derive an idempotency key from the job ID (the skill receives it via the runtime) and check "did I already do this?" before acting.
  - Or use APIs that accept an idempotency token (Stripe, most payment/messaging providers support this).
  - Or make the effect naturally idempotent (upsert instead of insert, `PUT` instead of `POST`).

If you cannot make a side effect idempotent, document the risk clearly in the skill's `description` so customers know what they are buying.

### More examples

See `skills-examples/` for working skills: `youtube-summary`, `github-repo`, `stock-price`, `whois-lookup`, `site-status`, `trending`, `general-assistant`.

## Commands

```bash
bun run build      # Build with tsup
bun run dev        # Watch mode
bun run typecheck  # tsc --noEmit
```

## License

MIT
