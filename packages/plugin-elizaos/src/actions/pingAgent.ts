import type { Action, ActionResult, IAgentRuntime } from '@elizaos/core';
import { nip19 } from 'nostr-tools';
import { SERVICE_TYPES } from '../constants';
import type { ElisymService } from '../services/ElisymService';
import { getState, hasState } from '../state';

function decodePubkey(value: string): string {
  if (/^[0-9a-f]{64}$/i.test(value)) {
    return value.toLowerCase();
  }
  if (value.startsWith('npub')) {
    const decoded = nip19.decode(value);
    if (decoded.type === 'npub') {
      return decoded.data;
    }
  }
  throw new Error(`Invalid Nostr public key: ${value.slice(0, 16)}...`);
}

export const pingAgentAction: Action = {
  name: 'ELISYM_PING_AGENT',
  similes: ['CHECK_AGENT_ONLINE'],
  description: 'Check whether a specific elisym provider is currently online.',
  validate: async (runtime: IAgentRuntime): Promise<boolean> => hasState(runtime),
  handler: async (runtime, _message, _state, options, callback): Promise<ActionResult> => {
    const pubkeyRaw = typeof options?.pubkey === 'string' ? options.pubkey : undefined;
    const npub = typeof options?.npub === 'string' ? options.npub : undefined;
    let pubkey = pubkeyRaw ?? npub;
    if (!pubkey) {
      const first = getState(runtime).lastDiscovery?.candidates[0]?.pubkey;
      if (!first) {
        throw new Error(
          'No target for ping. Pass options.pubkey / options.npub or run DISCOVER first.',
        );
      }
      pubkey = first;
    }
    const decoded = decodePubkey(pubkey);

    const elisym = runtime.getService<ElisymService>(SERVICE_TYPES.ELISYM);
    if (!elisym) {
      throw new Error('ElisymService is not running');
    }
    const result = await elisym.getClient().ping.pingAgent(decoded);
    const text = result.online
      ? `Provider ${decoded.slice(0, 8)} is online.`
      : `Provider ${decoded.slice(0, 8)} is offline or unreachable.`;
    await callback?.({ text, source: 'elisym' });
    return { success: true, data: { online: result.online, pubkey: decoded } };
  },
  examples: [
    [
      { name: '{{user}}', content: { text: 'Is that elisym agent still online?' } },
      {
        name: '{{agent}}',
        content: { text: 'Pinging...', actions: ['ELISYM_PING_AGENT'] },
      },
    ],
  ],
};
