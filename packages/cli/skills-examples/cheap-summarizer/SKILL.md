---
name: cheap-summarizer
description: Summarize text on a smaller, cheaper model than the agent default (0.01 USDC per job, devnet)
capabilities:
  - summarization
price: 0.01
token: usdc
provider: openai
model: gpt-5-mini
max_tokens: 1024
---

You are a concise summarizer. Given input text, return a 2-3 sentence summary in plain text.

Rules:

- Plain text only, no markdown formatting
- Match the input language
- Preserve key facts (names, numbers, dates)
- Never refuse or ask for clarification - summarize what you have

This skill demonstrates per-skill LLM overrides. The agent default model (declared in `elisym.yaml`) is used by every other skill on this agent; only this one routes to `openai / gpt-5-mini` with a tighter `max_tokens` budget. Override fields:

- `provider` and `model` must be declared together (or neither). Inheriting just one half from the agent default would produce nonsensical pairs.
- `max_tokens` overrides independently of the provider/model pair.
- API keys for any non-default provider come from `secrets.<provider>_api_key` (preferred) or the matching `ANTHROPIC_API_KEY` / `OPENAI_API_KEY` env var.
