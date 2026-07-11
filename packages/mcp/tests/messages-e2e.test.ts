/**
 * Cross-package e2e: a customer sends a DM through the raw SDK
 * (`MessagesService` + real NIP-59 crypto), and the agent reads it through
 * the actual MCP tool handlers over a shared in-memory relay - then replies
 * through `send_message` and the customer decrypts it back through the SDK.
 * No real relays; real encryption end to end.
 */
import { mkdtemp, mkdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ElisymIdentity, MessagesService, type NostrPool, type SubCloser } from '@elisym/sdk';
import type { Event, Filter } from 'nostr-tools';
import { describe, it, expect } from 'vitest';
import { AgentContext, type AgentInstance } from '../src/context.js';
import { readReadCursors } from '../src/storage/read-cursors.js';
import { messagesTools } from '../src/tools/messages.js';

function matchesFilter(event: Event, filter: Filter): boolean {
  if (filter.kinds && !filter.kinds.includes(event.kind)) return false;
  if (filter.since !== undefined && event.created_at < filter.since) return false;
  if (filter.authors && !filter.authors.includes(event.pubkey)) return false;
  for (const [key, values] of Object.entries(filter)) {
    if (key.startsWith('#') && Array.isArray(values)) {
      const tagName = key.slice(1);
      const eventTagValues = event.tags.filter((tag) => tag[0] === tagName).map((tag) => tag[1]);
      if (!values.some((value: string) => eventTagValues.includes(value))) return false;
    }
  }
  return true;
}

/** Minimal shared relay: just the pool surface MessagesService touches. */
class RelaySimulator {
  events: Event[] = [];

  async publishAll(event: Event): Promise<void> {
    this.events.push(event);
  }

  async publish(event: Event): Promise<void> {
    this.events.push(event);
  }

  async querySync(filter: Filter): Promise<Event[]> {
    return this.events.filter((event) => matchesFilter(event, filter));
  }

  subscribe(_filter: Filter, _onEvent: (event: Event) => void): SubCloser {
    return { close: () => {} };
  }

  getRelays(): string[] {
    return ['wss://sim.local'];
  }
}

function findTool(name: string) {
  const tool = messagesTools.find((candidate) => candidate.name === name);
  if (!tool) throw new Error(`tool ${name} not found`);
  return tool;
}

describe('DM cross-package e2e (SDK send -> MCP tools -> SDK read)', () => {
  it('round-trips an encrypted conversation through the real tool handlers', async () => {
    const relay = new RelaySimulator();
    const pool = relay as unknown as NostrPool;

    const customer = ElisymIdentity.generate();
    const agentIdentity = ElisymIdentity.generate();
    const customerMessages = new MessagesService(pool);
    const agentMessages = new MessagesService(pool);

    const root = await mkdtemp(join(tmpdir(), 'elisym-dm-e2e-'));
    const agentDir = join(root, 'agent');
    await mkdir(agentDir, { recursive: true });

    const agent: AgentInstance = {
      client: { messages: agentMessages } as never,
      identity: agentIdentity,
      name: 'e2e-agent',
      network: 'devnet',
      security: {},
      agentDir,
    };
    const ctx = new AgentContext();
    ctx.register(agent);

    // Customer -> agent through the raw SDK (real NIP-59 wrap).
    const { id: inboundId } = await customerMessages.send(
      customer,
      agentIdentity.publicKey,
      'hello agent, are you available for a job?',
    );
    expect(relay.events.filter((event) => event.kind === 1059)).toHaveLength(2);

    // Agent lists conversations through the actual MCP tool: one unread.
    const listTool = findTool('list_conversations');
    const listBefore = await listTool.handler(ctx, listTool.schema.parse({}));
    const listBeforeText = listBefore.content[0]?.text ?? '';
    expect(listBeforeText).toContain('"unread_count": 1');
    expect(listBeforeText).toContain('"known_contact": false');

    // Agent reads the conversation: decrypted content, sanitize-framed, marks read.
    const getTool = findTool('get_messages');
    const read = await getTool.handler(
      ctx,
      getTool.schema.parse({ counterpart: customer.publicKey }),
    );
    const readText = read.content[0]?.text ?? '';
    expect(readText).toContain('hello agent, are you available for a job?');
    expect(readText).toContain('UNTRUSTED');
    expect((await readReadCursors(agentDir))[customer.publicKey]).toBeGreaterThan(0);

    const listAfter = await listTool.handler(ctx, listTool.schema.parse({}));
    expect(listAfter.content[0]?.text ?? '').toContain('"unread_count": 0');

    // Agent replies through the MCP tool; the customer decrypts via the SDK.
    const sendTool = findTool('send_message');
    const sent = await sendTool.handler(
      ctx,
      sendTool.schema.parse({ recipient: customer.publicKey, message: 'yes - send the job' }),
    );
    expect(sent.isError).toBeFalsy();

    const customerInbox = await customerMessages.fetchHistory(customer);
    const reply = customerInbox.find((message) => !message.isMine);
    expect(reply?.content).toBe('yes - send the job');
    expect(reply?.senderPubkey).toBe(agentIdentity.publicKey);
    // The customer's own message is there too, via its self-copy.
    expect(customerInbox.some((message) => message.id === inboundId && message.isMine)).toBe(true);
  });
});
