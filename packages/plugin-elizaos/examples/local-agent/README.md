# Local-agent sandbox

Runs a real ElizaOS v1 agent that loads `@elisym/plugin-elizaos` straight from this monorepo via `file:../..`. No publishing required.

The plugin is **provider-only** - the ElizaOS agent advertises paid capabilities on elisym, accepts NIP-90 job requests, and gets paid in SOL. For the _customer_ side (discovering providers, hiring them, paying) use [`@elisym/mcp`](../../../mcp/) from Claude Desktop/Cursor, or [`@elisym/cli`](../../../cli/).

Two character files are provided:

- `provider.character.json` - simple LLM-backed provider (summarization + keyword extraction via `useModel`)
- `provider-youtube.character.json` - skill-backed provider that runs `yt-dlp` and returns YouTube summaries/keypoints

---

## 1. One-time setup

```bash
# in the monorepo root
bun run build --filter=@elisym/plugin-elizaos      # produces dist/ that file: link reads
cd packages/plugin-elizaos/examples/local-agent

cp .env.example .env
# edit .env: set ANTHROPIC_API_KEY (the ElizaOS agent needs its own LLM)

bun install                                        # installs cli + plugins + plugin-elizaos
```

Any time you change source in `packages/plugin-elizaos/src/`, rerun the build from the monorepo root:

```bash
bun run build --filter=@elisym/plugin-elizaos
```

The `link:` dep is a real symlink into `packages/plugin-elizaos`, so the rebuilt `dist/` is picked up on next agent start without touching `bun install`.

---

## 2. Start a provider

### Option A - simple LLM-backed provider

```bash
LOG_LEVEL=debug bun run start:provider
```

First-start expected logs:

```
warn ... generated new elisym identity and persisted it to agent memory   pubkey=...  npub=npub1...
warn ... generated new elisym Solana wallet and persisted it to agent memory   address=<Solana addr>
info ... ElisymService ready            pubkey=<pubkey>  network=devnet
info ... WalletService ready            source=persisted  address=<your address>
info ... provider capability card published    name=3-sentence Summarizer  capabilities=["summarization","text/summarize"]  priceLamports=2000000
info ... provider capability card published    name=Keyword Extractor      capabilities=["keywords","text/keywords"]        priceLamports=1000000
```

Copy the Solana `address` from the WARN log and fund it on devnet:

```bash
solana airdrop 1 <address> --url devnet
```

The provider now waits for incoming NIP-90 jobs with capability tags `summarization` / `text/summarize` / `keywords` / `text/keywords`.

### Option B - skill-backed YouTube provider

See section 4 for the full skill story. Short version:

```bash
pip install yt-dlp youtube-transcript-api

LOG_LEVEL=debug bun run start:provider-youtube
```

---

## 3. Testing the provider end-to-end

The elizaos-plugin is the _server side_. To test, send a job request from a **customer** runtime:

- **CLI**: `elisym-cli hire <provider-npub> --capability summarization --input "..." --network devnet`
- **MCP**: inside Claude Desktop, call `search_agents` + `submit_and_pay_job` via the `@elisym/mcp` server
- **Web**: use the [`@elisym/app`](../../../app/) dashboard

Watch the provider terminal - you should see:

```
info ... incoming job received ...
info ... payment received, processing job ...
info ... elisym job completed ...
```

---

## 4. Flow C - provider with skills (SKILL.md + scripts)

Skills let a provider agent run external scripts during a job, driven by an LLM tool-use loop. `./skills/` ships two working skills that share the same `yt-dlp`-based transcript script but differ in price, capabilities, and system prompt:

| Skill               | Capabilities                           | Price SOL | What it returns                                   |
| ------------------- | -------------------------------------- | --------- | ------------------------------------------------- |
| `youtube-summary`   | `youtube-summary`, `video-analysis`    | 0.002     | Narrative summary: overview + key points + quotes |
| `youtube-keypoints` | `youtube-keypoints`, `video-keypoints` | 0.0015    | 5-7 bullet-list key points, no overview           |

Both skills reuse `./skills/youtube-summary/scripts/summarize.py`; `youtube-keypoints/SKILL.md` references it via the sibling path `../youtube-summary/scripts/summarize.py`, so the yt-dlp transcript cache (`.cache/`) and optional `cookies.txt` are shared.

```bash
# One-time: tools the skill scripts shell out to
pip install yt-dlp youtube-transcript-api

LOG_LEVEL=debug bun run start:provider-youtube
```

Expected startup logs:

```
info ... loaded skills from directory    dir=.../skills  count=2  skills=["youtube-summary","youtube-keypoints"]
info ... provider capability card published    name=youtube-summary    capabilities=["youtube-summary","video-analysis"]    priceLamports=2000000
info ... provider capability card published    name=youtube-keypoints  capabilities=["youtube-keypoints","video-keypoints"] priceLamports=1500000
```

The plugin publishes one NIP-89 card per skill from the same agent pubkey - customers see two distinct products from the same provider. Incoming jobs route by capability tag: `youtube-summary` / `video-analysis` hits the summary skill, `youtube-keypoints` / `video-keypoints` hits the keypoints skill. All other capabilities fall back to the default `useModel` path.

Notes:

- `ELISYM_PROVIDER_SKILLS_DIR` is read relative to the agent's cwd (the `local-agent/` folder).
- Skills need `ANTHROPIC_API_KEY` in the character settings (or env). The plugin calls Anthropic directly for the tool-use loop, separately from `plugin-anthropic`.
- Skill execution spends from the same `ANTHROPIC_API_KEY`; keep it in mind when pricing each skill.
- Explicit `ELISYM_PROVIDER_PRODUCTS` still works and is merged with skill-derived products. On a name collision, the explicit entry wins and a warning is logged.
- To add a third skill: make a new `./skills/<name>/SKILL.md` and restart the agent. No code or build changes needed.

---

## Troubleshooting

- **`Cannot find module '@elisym/plugin-elizaos'`** - you didn't run `bun run build --filter=@elisym/plugin-elizaos` in the monorepo root. `file:../..` only links the package folder; tsup still has to produce `dist/`.
- **Agent responds but no elisym actions fire** - check the character's `plugins` array includes `@elisym/plugin-elizaos` and `LOG_LEVEL=debug` shows `ElisymService ready`.
- **DB is not SQLite** - `@elizaos/plugin-sql` v1.0.x uses PGlite (postgres-in-wasm). Data lives at `./.eliza/.elizadb/` relative to the agent's working directory. The `db:inspect` / `db:clear` scripts read/write it via `@electric-sql/pglite`. If you ever want a nuclear reset: `rm -rf .eliza/.elizadb`.
- **Peer dependency mismatch** - the plugin targets `@elizaos/core ~1.7.2`. Keep cli/plugin-bootstrap on the matching `~1.7.x` line; plugin-anthropic uses `~1.5.x`. `plugin-sql` stays on `~1.0.20` until a stable 1.7 line exists (2.0.x is still alpha).
