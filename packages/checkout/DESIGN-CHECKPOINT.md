# PayCore V3 Modal — design checkpoint, 2026-11-03

Work in V3 Modal only. Font: locally bundled Manrope Variable.

## Approved direction
- Light and dark themes; temporary Light / Dark control on local host page.
- Light: jade #347d6b for stage progress and the large success icon. Dark: neon progress and success icon. Primary buttons remain lime with dark text.
- Loading icons: light gray in light theme, muted gray in dark; neon rotating arc, 3.6s per turn, no glow or animated dots.
- Shared final statuses: gray icons, one centered gray subtitle; 16px artwork-to-heading, 8px heading-to-subtitle, 24px subtitle-to-action. Inset gray guidance uses 16px after the heading. Single-sentence subtitles omit a closing period; multi-sentence subtitles retain punctuation.
- Secondary actions: gray surface and muted text, darker hover, no visible hover border.
- Purchase list: no cards, thin dividers, gray title hover with arrow next to title. Title left, compact CSV action right. No footer in history. Refund badge blue without outline.
- Purchase details: separate heading, amount + status hero, flat receipt rows and compact Copy receipt action.
- Receipts share the same flat layout on success and refund screens; shortened order ID with copy action.
- Failed payment: gray Error.svg, short subtitle, divider and centered Try again with. Clicking a wallet retries; no redundant Start over when wallets can retry.
- Sold out/cancelled/refused/refunded/blocked use common status layout; preserve meaningful payment safety information.
- Footer: Your purchases as gray secondary pill; 10px to the brand line.

## Local pages
- Real widget: http://localhost:5173/?theme=light (iframe on 5174).
- Component state gallery: http://127.0.0.1:5175/review.html?theme=light . Uses simulated state data only; screen selector for review, Play progress for motion.
- Real merchant node configs and RPC secrets live outside this repository in paycore-local. Never add them to git.
- Approved published V3 loader remains untouched; host chrome styling experiments are in scripts/dev.ts.

## Validation and follow-up
- Final TypeScript check passed: bun run typecheck in packages/checkout.
- Browser geometry audit checked seven status types in both themes: 16/8/24px, centered subtitles.
- Full automated suite has not been rerun after the final text/layout iterations. Existing tests may need updates for explicitly changed labels and actions.
- Before shipping: consolidate accumulated CSS overrides and review responsive layouts, clipboard fallback, motion and all alternative network/error states.
- Screenshots and initial gallery archive are outside git in ../paycore-design (relative to repository root); the original archive predates later design iterations.
