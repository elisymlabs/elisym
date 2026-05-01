/**
 * Render a fresh `elisym.yaml` as a string with descriptive header comments
 * over each top-level field. Optional fields that are not set in the input
 * are emitted as commented-out examples so a new operator can see what else
 * is configurable without leaving the file.
 *
 * Used only at agent-creation time (CLI `init`, MCP `create_agent`). On
 * subsequent writes via `writeYaml`, the document is re-serialized without
 * comments - this template is a one-shot scaffold, not a round-tripping
 * format.
 */

import YAML from 'yaml';
import { RELAYS } from '../constants';
import type { ElisymYaml } from './schema';

const PLACEHOLDER_DISPLAY_NAME = 'My Agent';
const PLACEHOLDER_PICTURE = './avatar.png';
const PLACEHOLDER_BANNER = './banner.png';
const PLACEHOLDER_PAYMENTS = [
  { chain: 'solana', network: 'devnet', address: '<your-solana-address>' },
];
const PLACEHOLDER_LLM = {
  provider: 'anthropic',
  model: 'claude-sonnet-4-6',
  max_tokens: 4096,
};
const DEFAULT_SECURITY = { withdrawals_enabled: false, agent_switch_enabled: false };

interface FieldBlock {
  description: string;
  key: keyof ElisymYaml;
  value: unknown;
  placeholder: unknown;
}

function commentLines(text: string): string {
  return text
    .split('\n')
    .map((line) => (line.length > 0 ? `# ${line}` : '#'))
    .join('\n');
}

function isUnset(value: unknown): boolean {
  if (value === undefined) {
    return true;
  }
  if (Array.isArray(value) && value.length === 0) {
    return true;
  }
  return false;
}

function renderBlock(block: FieldBlock): string {
  const header = commentLines(block.description);
  const unset = isUnset(block.value);
  const renderValue = unset ? block.placeholder : block.value;
  const yamlBody = YAML.stringify({ [block.key]: renderValue }).trimEnd();
  const body = unset ? commentLines(yamlBody) : yamlBody;
  return `${header}\n${body}`;
}

export function renderInitialYaml(yaml: ElisymYaml): string {
  const security = {
    withdrawals_enabled: yaml.security.withdrawals_enabled ?? DEFAULT_SECURITY.withdrawals_enabled,
    agent_switch_enabled:
      yaml.security.agent_switch_enabled ?? DEFAULT_SECURITY.agent_switch_enabled,
  };

  const blocks: FieldBlock[] = [
    {
      description: 'Human-readable name shown in UI. Falls back to the folder name when omitted.',
      key: 'display_name',
      value: yaml.display_name,
      placeholder: PLACEHOLDER_DISPLAY_NAME,
    },
    {
      description: 'Public description shown in discovery results.',
      key: 'description',
      value: yaml.description,
      placeholder: '',
    },
    {
      description: 'Avatar - relative path (to this YAML) or absolute URL.',
      key: 'picture',
      value: yaml.picture,
      placeholder: PLACEHOLDER_PICTURE,
    },
    {
      description: 'Banner - relative path (to this YAML) or absolute URL.',
      key: 'banner',
      value: yaml.banner,
      placeholder: PLACEHOLDER_BANNER,
    },
    {
      description: 'Nostr relays this agent connects to.',
      key: 'relays',
      value: yaml.relays,
      placeholder: [...RELAYS],
    },
    {
      description:
        'Payment wallets per chain. Each entry receives every asset on that chain ' +
        '(SOL directly; SPL tokens via the ATA derived from this address).',
      key: 'payments',
      value: yaml.payments,
      placeholder: PLACEHOLDER_PAYMENTS,
    },
    {
      description:
        'LLM configuration. Omit (or comment out) to run as a non-LLM agent ' +
        '(static-file or script skills only).',
      key: 'llm',
      value: yaml.llm,
      placeholder: PLACEHOLDER_LLM,
    },
    {
      description: 'Capability gates. Both default to false; flip to true to enable.',
      key: 'security',
      value: security,
      placeholder: DEFAULT_SECURITY,
    },
  ];

  return blocks.map(renderBlock).join('\n\n') + '\n';
}
