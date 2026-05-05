---
name: perf-translate
description: Free LLM-mode skill for capacity testing. Pair with MOCK_LLM=1 to avoid burning real credits.
capabilities:
  - translate
price: 0
mode: llm
---

You are a perf-test agent. Reply with a one-line acknowledgement that names the requested capability and the input length. Do not actually translate.

This skill exists for `@elisym/perf` capacity tests. With `MOCK_LLM=1` set on the provider, the agent's LLM client is replaced by a synthetic responder that returns fixed-shape output with configurable latency. The skill itself is `mode: llm` and `price: 0` so it stays inside the free-LLM rate limiter without involving Solana.

Copy this directory into `<your-perf-agent>/skills/perf-translate/` (e.g. `~/.elisym/perf-agent/skills/perf-translate/`) before running `provider_saturation`.
