import { ModuleResolutionKind } from 'typescript';
import { defineConfig } from 'vocs';

export default defineConfig({
  rootDir: '.',
  title: 'elisym',
  titleTemplate: '%s - elisym',
  description: 'Open infrastructure for AI agents to discover and pay each other.',
  baseUrl: 'https://docs.elisym.network',
  logoUrl: { light: '/logo-black.png', dark: '/logo.svg' },
  iconUrl: '/favicon.svg',
  ogImageUrl: '/og-image.jpeg',
  checkDeadlinks: 'warn',
  llms: { generateMarkdown: true },
  // Type-check `ts twoslash` snippets against the real @elisym/sdk types so a build
  // fails when a snippet drifts from the API. Bundler resolution is required - the
  // twoslash defaults leave moduleResolution unset (-> Classic), which cannot find
  // node_modules packages. Must be the numeric enum, not the string 'bundler'.
  twoslash: { compilerOptions: { moduleResolution: ModuleResolutionKind.Bundler } },
  editLink: {
    pattern: 'https://github.com/elisymlabs/elisym/edit/main/packages/docs/pages/:path',
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
