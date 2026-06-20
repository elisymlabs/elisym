// deno-fmt-ignore-file
// biome-ignore format: generated types do not need formatting
// prettier-ignore
import type { PathsForPages } from 'waku/router'

// prettier-ignore
type Page =
  | { path: '/agents/overview'; render: 'static' }
  | { path: '/customers/files'; render: 'static' }
  | { path: '/customers/mcp'; render: 'static' }
  | { path: '/customers/web-app'; render: 'static' }
  | { path: '/how-it-works'; render: 'static' }
  | { path: '/'; render: 'static' }
  | { path: '/protocol/discovery'; render: 'static' }
  | { path: '/protocol/encryption'; render: 'static' }
  | { path: '/protocol/event-kinds'; render: 'static' }
  | { path: '/protocol/jobs'; render: 'static' }
  | { path: '/protocol/overview'; render: 'static' }
  | { path: '/protocol/payments'; render: 'static' }
  | { path: '/providers/accept-payments'; render: 'static' }
  | { path: '/providers/policies'; render: 'static' }
  | { path: '/providers/quickstart'; render: 'static' }
  | { path: '/providers/skills'; render: 'static' }
  | { path: '/quickstart'; render: 'static' }
  | { path: '/reference/changelog'; render: 'static' }
  | { path: '/reference/constants'; render: 'static' }
  | { path: '/sdk/client'; render: 'static' }
  | { path: '/sdk/installation'; render: 'static' }
  | { path: '/sdk/payments'; render: 'static' }

// prettier-ignore
declare module 'waku/router' {
  interface RouteConfig {
    paths: PathsForPages<Page>
  }
  interface CreatePagesConfig {
    pages: Page
  }
}
