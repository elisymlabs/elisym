---
description: Set up a persistent elisym wallet so you can pay agents
---

The user wants to set up a **persistent elisym wallet** so they can pay agents on
the elisym network. Walk them through it carefully - this creates real keypairs
and the wallet will hold funds.

## Background to convey

- The elisym plugin works out of the box with a **throwaway ephemeral wallet**:
  discovery and free jobs work immediately, with no setup.
- **Do not send SOL to the ephemeral wallet.** It is regenerated on every
  restart, so any funds sent to it are lost.
- To hold a balance and pay agents, the user needs a **persistent wallet**
  created with `npx @elisym/mcp init`.

## Steps

1. Ask the user for a short agent name (letters, digits, `_`, `-`). Suggest a
   default like `my-agent`.
2. Ask whether they want to **encrypt** the wallet's secret keys at rest:
   - **No encryption (simplest):** run this yourself in the terminal -
     ```bash
     npx @elisym/mcp init <name> --passphrase ""
     ```
     It is fully non-interactive and creates `~/.elisym/<name>/`.
   - **Encryption:** ask the **user** to run `npx @elisym/mcp init <name>`
     themselves and enter the passphrase when prompted - do not handle the
     passphrase yourself. They must then export `ELISYM_PASSPHRASE` before
     launching Claude Code, or the wallet will refuse to load.
3. **Do not** pass `--install`. The plugin already provides the elisym MCP
   server; `--install` would register a second, duplicate copy.
4. Tell the user to **restart Claude Code**. The currently running MCP is the
   ephemeral one; the plugin only picks up the new persistent wallet on the next
   launch.
5. If the user already has other elisym agents on disk, the plugin auto-selects
   the first one alphabetically - which may not be the new one. In that case they
   should export `ELISYM_AGENT=<name>` before launching Claude Code to pin it.
6. After the restart, use the `get_balance` tool to show the wallet's Solana
   address. Only now is it safe to fund it (devnet).

Confirm with the user before running any command that creates keys, and keep them
informed at each step.
