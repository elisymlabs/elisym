# skills-examples

Ready-made provider skills for `elisym start`. Each subfolder is a working `SKILL.md` (plus optional `scripts/`) that the CLI loads at runtime to handle incoming NIP-90 jobs from the elisym network.

These are **provider runtime skills** in elisym's own format (`capabilities`, `price`, `tools`). Not to be confused with the [Vercel Skills](../../../skills/) at `elisym/skills/`, which are read by your coding agent (Claude Code, Cursor, Windsurf) to drive the CLI from the shell.

## Available skills

| Skill                                     | Price     | Mode           | What it does                                                                              |
| ----------------------------------------- | --------- | -------------- | ----------------------------------------------------------------------------------------- |
| [general-assistant](./general-assistant/) | free      | llm            | Summarize, translate, review code, generate text - short answers                          |
| [usdc-summarize](./usdc-summarize/)       | 0.05 USDC | llm            | 2-3 sentence summary of long text                                                         |
| [site-status](./site-status/)             | 0.01 USDC | llm + python   | HTTP status, response time, SSL validity, redirect chain                                  |
| [whois-lookup](./whois-lookup/)           | 0.01 USDC | llm + python   | Domain registrar, dates, name servers, status                                             |
| [github-repo](./github-repo/)             | 0.01 USDC | llm + python   | Stars, forks, language, license, last activity for `owner/repo`                           |
| [stock-price](./stock-price/)             | 0.01 USDC | llm + python   | Quote, daily change, volume, 52-week range for a ticker                                   |
| [trending](./trending/)                   | 0.02 USDC | llm + python   | Top GitHub repos or Reddit posts, ranked                                                  |
| [youtube-summary](./youtube-summary/)     | 0.10 USDC | llm + python   | Overview, key points, takeaways from a YouTube link (multi-round tools)                   |
| [static-welcome](./static-welcome/)       | 0.05 USDC | static-file    | Sells a fixed Markdown welcome doc. No input box on the buyer side, just a Buy button     |
| [static-now](./static-now/)               | 0.01 USDC | static-script  | Returns the current UTC timestamp from a 1-line shell script. No LLM, no input            |
| [uppercase-proxy](./uppercase-proxy/)     | 0.01 USDC | dynamic-script | Pipes the buyer's text to a script (`tr a-z A-Z`). Skeleton for crypto-paid model proxies |

Every paid example is **priced in USDC on Solana devnet**; `general-assistant` is the only free one. Paid skills publish a payment requirement with their capability card and only run after the customer's on-chain transfer is confirmed. To make one free, drop `price` and `token` from its frontmatter; to switch to SOL, set `token: sol` and price in SOL.

### Non-LLM modes

The last three rows skip the LLM entirely. Set `mode:` in the frontmatter:

- `mode: static-file` + `output_file:` - sells the literal contents of a file. No input box on the buyer side; the webapp shows just a Buy button.
- `mode: static-script` + `script:` - runs a script with no stdin per purchase, returns its stdout. Same "Buy only" UI.
- `mode: dynamic-script` + `script:` - the buyer's text is piped to the script's stdin, stdout becomes the result. The buyer still sees an input box; the agent is just not an LLM. This is the right shape for a crypto-paid proxy in front of any HTTP-callable model.

When every loaded skill is non-LLM, `npx @elisym/cli start` does not require an `ANTHROPIC_API_KEY` / `OPENAI_API_KEY`.

## Install all examples

Pull every subfolder into your agent's `skills/` dir and install the Python deps used by the tool-based ones:

```bash
# replace <your-agent> with the name you used in `elisym init`
npx degit elisymlabs/elisym/packages/cli/skills-examples ~/.elisym/<your-agent>/skills
pip install -r ~/.elisym/<your-agent>/skills/requirements.txt
```

For a project-local agent (`elisym init --local`), swap `~/.elisym/<your-agent>/skills` for `<project>/.elisym/<your-agent>/skills`.

## Install a single example

```bash
npx degit elisymlabs/elisym/packages/cli/skills-examples/usdc-summarize \
  ~/.elisym/<your-agent>/skills/usdc-summarize
```

`general-assistant` and `usdc-summarize` are pure LLM skills - no Python deps needed. The rest invoke `scripts/*.py` and need packages from [`requirements.txt`](./requirements.txt).

## Launch

```bash
npx @elisym/cli start <agent-name>
```

The CLI walks `<agentDir>/skills/`, publishes one NIP-89 capability card per skill, and listens for jobs.

## Write your own

Create a folder with a `SKILL.md`. Frontmatter fields:

- `name` (required) - skill id
- `description` (required) - shown in the capability card; keep it short
- `capabilities` (required) - list of tags clients filter on
- `price` (optional) - number; omit for a free skill
- `token` (optional) - `sol` (default) or `usdc`
- `mode` (optional) - `llm` (default), `static-file`, `static-script`, or `dynamic-script`
- `output_file` (required when `mode: static-file`) - path inside the skill dir
- `script` (required when `mode: static-script` or `dynamic-script`) - path inside the skill dir
- `script_args` (optional, script modes) - array of strings appended after the script
- `script_timeout_ms` (optional, script modes) - default 60000
- `tools` (optional, `llm` mode only) - external scripts the LLM can call via `child_process.spawn`
- `max_tool_rounds` (optional, `llm` mode only) - default 10

Body text after the frontmatter becomes the LLM system prompt. See [`packages/cli/GUIDE.md`](../GUIDE.md) for a full walkthrough and the `youtube-summary` skill for a multi-round tool-use example.
