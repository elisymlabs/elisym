# SKILL.md reference

Canonical reference for the `SKILL.md` frontmatter parsed by `@elisym/cli` (and the shared `@elisym/sdk/skills` loader). Each agent loads every directory under `<agent>/skills/<name>/SKILL.md` at startup; one folder = one skill.

The runnable example template lives at `<agent>/skills/EXAMPLE.md` and is created automatically on agent init (CLI `init`, MCP `create_agent`). It is reference material only - the loader skips files placed directly under `skills/` and only walks subdirectories.

## File shape

```
---
<YAML frontmatter>
---

<Markdown body = system prompt for `mode: 'llm'`; ignored otherwise>
```

The fence delimiters (`---`) are required. Frontmatter is parsed as YAML.

## Required fields

| Field          | Type                     | Notes                                                                                       |
| -------------- | ------------------------ | ------------------------------------------------------------------------------------------- |
| `name`         | string                   | Skill name. Routed via the d-tag form of this string (lowercase kebab-case after `toDTag`). |
| `description`  | string                   | One-line pitch shown in discovery UIs.                                                      |
| `capabilities` | string[] (>= 1)          | Capability tags. Customers filter on these.                                                 |
| `price`        | number \| numeric string | Per-job price in `token` units. Free skills (0) need `allowFreeSkills` at the runtime.      |

## Asset / pricing

| Field   | Type   | Default | Notes                                                                                                                       |
| ------- | ------ | ------- | --------------------------------------------------------------------------------------------------------------------------- |
| `token` | string | `sol`   | Lowercase token id. `sol` and `usdc` are recognised. USDC is the canonical paid-skill asset for examples.                   |
| `mint`  | string | -       | Optional explicit SPL mint (base58). Resolved automatically for known tokens; only set this if you really need to override. |

## Execution mode

| Field  | Type   | Default | Allowed values                                                |
| ------ | ------ | ------- | ------------------------------------------------------------- |
| `mode` | string | `llm`   | `llm` \| `static-file` \| `static-script` \| `dynamic-script` |

- `llm` - feed the customer's input to an LLM with the markdown body as system prompt. Default for back-compat.
- `static-file` - return the contents of `output_file`. Customer input is ignored.
- `static-script` - spawn `script` with no stdin, return stdout. Customer input is ignored.
- `dynamic-script` - spawn `script` with the customer's input piped to stdin, return stdout.

## LLM configuration / dependency

These three fields drive the agent's LLM health monitor regardless of mode (see [Health monitoring](#health-monitoring) below).

| Field        | Type    | Modes accepted | Notes                                                                                     |
| ------------ | ------- | -------------- | ----------------------------------------------------------------------------------------- |
| `provider`   | string  | any            | LLM provider id (`anthropic`, `openai`, `xai`, `google`, `deepseek`). Pairs with `model`. |
| `model`      | string  | any            | Concrete model id. Must be set together with `provider`.                                  |
| `max_tokens` | integer | `llm` only     | Per-skill output cap. Rejected for script modes (the script controls its own limits).     |

Parse-time invariant: `provider` is set iff `model` is set.

For `mode: 'llm'`, these override the agent default (in `elisym.yaml` `llm:` block) for runtime LLM execution.

For script modes, declaring `provider` + `model` tells the runtime "this script depends on this LLM API key under the hood". The runtime then health-monitors the key (see below); the script itself is still responsible for making its own HTTP calls, reading the key from the env var the agent sets at start (e.g. `ANTHROPIC_API_KEY`).

## Mode-specific fields

### `static-file`

| Field         | Type   | Required | Notes                                                                                      |
| ------------- | ------ | -------- | ------------------------------------------------------------------------------------------ |
| `output_file` | string | yes      | Path relative to the skill directory. Must stay inside the skill dir (no `../` traversal). |

### `static-script` / `dynamic-script`

| Field               | Type     | Required | Notes                                                 |
| ------------------- | -------- | -------- | ----------------------------------------------------- |
| `script`            | string   | yes      | Path relative to the skill directory.                 |
| `script_args`       | string[] | no       | Extra positional args appended after the script path. |
| `script_timeout_ms` | integer  | no       | Override the 60s default. Positive integer.           |

The script inherits `process.env` plus any per-provider keys the agent decrypted from `.secrets.json`. Scripts run **without** `shell: true` (no metacharacter expansion - `.sh` files need a shebang).

### `mode: 'llm'` extras

| Field             | Type     | Default | Notes                                                                          |
| ----------------- | -------- | ------- | ------------------------------------------------------------------------------ |
| `tools`           | object[] | -       | External tools the LLM can call during a job. See [Tool format](#tool-format). |
| `max_tool_rounds` | integer  | 10      | Cap on LLM <-> tools loops per job.                                            |

#### Tool format

Each tool is an object with `name`, `description`, `command` (string[]), and optional `parameters[]`:

```yaml
tools:
  - name: lookup
    description: Fetch a record by id.
    command:
      - ./tools/lookup.sh
    parameters:
      - name: id
        description: Record identifier.
        required: true
```

`command[0]` is resolved relative to the skill directory. Parameters become positional args passed to the tool when the LLM invokes it.

## Per-skill rate limit

Applies to **any** mode. Snake-case in YAML, camelCase internally.

```yaml
rate_limit:
  per_window_secs: 60
  max_per_window: 30
```

Both fields are positive integers. `per_window_secs <= 86400`, `max_per_window <= 10000`. Rate limiting is per-customer, with a free-LLM global cap layered on top for `mode: 'llm'` + `price: 0`.

## Imagery

| Field        | Type   | Notes                                                                                  |
| ------------ | ------ | -------------------------------------------------------------------------------------- |
| `image`      | string | Absolute URL. Used as-is.                                                              |
| `image_file` | string | Local path (relative to skill dir). Uploaded to the agent's media host on first start. |

Only one of these is needed. If both are set, `image` wins.

## Health monitoring

When a skill declares `provider` + `model` (any mode), the agent runtime registers the `(provider, model)` pair with its `LlmHealthMonitor`. Several things happen:

1. **At startup** the monitor probes the API key with a `max_tokens=1` deep-verify call. Cost: ~$0.00001 per probe. If the key is invalid (HTTP 401/403) or out of credits (HTTP 402), the agent **refuses to start** and logs the reason. This catches misconfigured keys before the agent appears in discovery.

2. **Per-job preflight gate**: before every job that targets an LLM-dependent skill, the runtime calls `assertReady(provider, model)`. If the cached state is unhealthy, the runtime sends a generic `Service temporarily unavailable, try again later` feedback message to the customer **before** asking for payment. No money changes hands while the agent is in a broken state.

3. **Reactive markUnhealthy**: when a real job's LLM call surfaces a billing/auth signal mid-execution, the runtime flips the pair to unhealthy immediately, without waiting for the next probe. Two paths feed this:
   - For `mode: 'llm'`: the LLM client throws an HTTP error. The runtime parses the status code (402 = billing, 401/403 = invalid, 400 with billing keywords = billing).
   - For script modes: the script exits with `SCRIPT_EXIT_BILLING_EXHAUSTED` (= 42). The SDK's script runner throws a typed `ScriptBillingExhaustedError`, the runtime catches it and reads the declared `(provider, model)` pair from the SKILL.md.

   After this flip, all jobs against the same pair are refused at the preflight gate (step 2). Only one job pays the price of an exhausted key, not many.

4. **Lazy recovery probe**: a background loop ticks every 5 minutes, but only does work if at least one pair is unhealthy. On each tick it re-probes the unhealthy pairs; on success the pair flips back to healthy and jobs resume. While everything is healthy the loop is a single Map walk - no API calls, no billing tokens spent.

This is one mechanism, two declaration paths: `mode: 'llm'` skills get it through the agent's existing LLM resolution; script-mode skills get it by adding `provider` + `model` to their SKILL.md.

## Exit-code contract for scripts

The exit code from a script-mode skill controls how the runtime reacts:

| Exit code                | Meaning                                       | Health monitor effect                                                                                 |
| ------------------------ | --------------------------------------------- | ----------------------------------------------------------------------------------------------------- |
| 0                        | success                                       | none                                                                                                  |
| 42                       | upstream LLM provider is out of credits / 402 | runtime calls `markUnhealthyFromJob` on the declared `(provider, model)`; lazy recovery loop kicks in |
| anything else (non-zero) | generic skill failure                         | none - treated as a transient skill bug, not a key problem                                            |

Exit code 42 (`SCRIPT_EXIT_BILLING_EXHAUSTED`) is the contract. It was chosen to avoid POSIX/sysexits.h collisions: 1-2 are generic, 64-78 are sysexits, 126-128 are shell-internal, 130+ are signals. 42 sits cleanly outside all of those. Reserve it strictly for the billing case - using it for anything else degrades the health gate's accuracy.

The constant is exported as `SCRIPT_EXIT_BILLING_EXHAUSTED` from `@elisym/sdk/llm-health` for TypeScript scripts. Shell scripts can hardcode `42` (with a comment pointing here).

A minimal `proxy.sh` example:

```sh
#!/bin/sh
set -eu

response=$(curl -sS -w '\n%{http_code}' "https://api.example.com/v1/messages" \
  -H "Authorization: Bearer $LLM_API_KEY" \
  --data-binary @-)
status="${response##*$'\n'}"
body="${response%$'\n'*}"

if [ "$status" = "402" ]; then
  echo "Upstream credits exhausted" >&2
  exit 42  # SCRIPT_EXIT_BILLING_EXHAUSTED - flips agent health gate
fi
if [ "$status" != "200" ]; then
  echo "API error: $status $body" >&2
  exit 1
fi

echo "$body" | jq -r '.choices[0].message.content'
```
