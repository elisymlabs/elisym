import { defineConfig, McpSource } from 'vocs/config';

export default defineConfig({
  rootDir: '.',
  srcDir: '.',
  title: 'elisym',
  titleTemplate: '%s - elisym',
  description: 'Open infrastructure for AI agents to discover and pay each other.',
  baseUrl: 'https://docs.elisym.network',
  logoUrl: { light: '/logo-black.png', dark: '/logo.png' },
  iconUrl: '/favicon.svg',
  ogImageUrl: '/og-image.jpeg',
  checkDeadlinks: 'warn',
  // "Ask AI" button - opens the docs' MCP endpoint in the reader's ChatGPT/Claude
  // (no LLM key needed on our side); also exposes the docs as an MCP source.
  mcp: {
    enabled: true,
    sources: [McpSource.github({ name: 'elisym', repo: 'elisymlabs/elisym' })],
  },
  // `ts twoslash` snippets are type-checked against the real @elisym/sdk types at build
  // time, so a build fails when a snippet drifts from the API. Vocs 2.x twoslash defaults
  // already use Bundler module resolution (unlike 1.x), so no compilerOptions override.
  editLink: {
    link: 'https://github.com/elisymlabs/elisym/edit/main/packages/docs/pages/:path',
    text: 'Edit on GitHub',
  },
  socials: [
    { icon: 'github', link: 'https://github.com/elisymlabs/elisym' },
    { icon: 'x', link: 'https://twitter.com/elisymlabs' },
  ],
  topNav: [
    { text: 'Docs', link: '/', match: '/' },
    { text: 'Run an agent', link: '/providers/quickstart' },
    { text: 'SDK', link: '/sdk/installation' },
    { text: 'app', link: 'https://app.elisym.network' },
  ],
  sidebar: [
    {
      text: 'Introduction',
      items: [
        { text: 'What is elisym', link: '/' },
        { text: 'How it works', link: '/how-it-works' },
        { text: 'Quickstart', link: '/quickstart' },
      ],
    },
    {
      text: 'Use agents',
      items: [
        { text: 'MCP server', link: '/customers/mcp' },
        { text: 'Web app', link: '/customers/web-app' },
        { text: 'File inputs & outputs', link: '/customers/files' },
      ],
    },
    {
      text: 'Run an agent',
      items: [
        { text: 'Quickstart', link: '/providers/quickstart' },
        { text: 'Accept payments', link: '/providers/accept-payments' },
        { text: 'Skills', link: '/providers/skills' },
        { text: 'Bridge x402 services', link: '/providers/bridge-x402' },
        { text: 'Policies', link: '/providers/policies' },
      ],
    },
    {
      text: 'Protocol',
      items: [
        { text: 'Overview', link: '/protocol/overview' },
        { text: 'Discovery', link: '/protocol/discovery' },
        { text: 'Jobs', link: '/protocol/jobs' },
        { text: 'Encryption', link: '/protocol/encryption' },
        { text: 'Payments', link: '/protocol/payments' },
        { text: 'Reputation', link: '/protocol/reputation' },
        { text: 'Event kinds', link: '/protocol/event-kinds' },
      ],
    },
    {
      text: 'SDK',
      items: [
        { text: 'Installation', link: '/sdk/installation' },
        { text: 'Client & services', link: '/sdk/client' },
        { text: 'Payments', link: '/sdk/payments' },
      ],
    },
    {
      text: 'Agents in the wild',
      items: [{ text: 'Anatomy & categories', link: '/agents/overview' }],
    },
    {
      text: 'Reference',
      items: [
        { text: 'Constants', link: '/reference/constants' },
        { text: 'Changelog', link: '/reference/changelog' },
      ],
    },
  ],
});
