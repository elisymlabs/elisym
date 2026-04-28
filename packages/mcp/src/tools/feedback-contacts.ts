/**
 * MCP tools for post-job rating and the local contacts list.
 *
 * `submit_feedback` publishes a NIP-90 kind 7000 event with rating='1'|'0'
 * (mirroring the web app's 👍/👎 UI). `add_contact`, `remove_contact`, and
 * `list_contacts` manage `.contacts.json` per agent. Auto-add on like is
 * deliberately NOT done - the user prefers the explicit add_contact flow.
 */

import { nip19 } from 'nostr-tools';
import { z } from 'zod';
import { sanitizeField, sanitizeUntrusted } from '../sanitize.js';
import { readContacts, removeContact, upsertContact } from '../storage/contacts.js';
import {
  findCustomerJob,
  findCustomerJobsByProvider,
  updateCustomerJob,
} from '../storage/customer-history.js';
import { MAX_EVENT_ID_LEN, MAX_NPUB_LEN, checkLen, decodeNpub } from '../utils.js';
import { defineTool, errorResult, textResult } from './types.js';
import type { ToolDefinition } from './types.js';

const SubmitFeedbackSchema = z.object({
  job_event_id: z
    .string()
    .min(1)
    .max(128)
    .describe('Event ID returned by submit_and_pay_job, buy_capability, or create_job.'),
  rating: z.enum(['positive', 'negative']),
  provider_npub: z
    .string()
    .optional()
    .describe(
      'Provider npub. Optional when the job is in local history (.customer-history.json); ' +
        'required when feedback is submitted for a job submitted from outside this MCP.',
    ),
});

const AddContactSchema = z.object({
  npub: z.string().min(1).max(MAX_NPUB_LEN),
  name: z.string().max(200).optional(),
  note: z.string().max(500).optional(),
});

const RemoveContactSchema = z.object({
  npub: z.string().min(1).max(MAX_NPUB_LEN),
});

const ListContactsSchema = z.object({
  limit: z.number().int().min(1).max(200).default(50),
});

function npubFromHex(pubkey: string): string {
  return nip19.npubEncode(pubkey);
}

export const feedbackContactsTools: ToolDefinition[] = [
  defineTool({
    name: 'submit_feedback',
    description:
      'Rate a completed job (mirrors the web app 👍/👎 buttons). Publishes a NIP-90 ' +
      'kind 7000 feedback event with rating="1" (positive) or "0" (negative). Idempotent ' +
      'on (job_event_id, rating) - calling twice with the same rating is a no-op. ' +
      'After a positive rating, the response suggests calling add_contact to save the ' +
      'provider for future search_agents queries.',
    schema: SubmitFeedbackSchema,
    async handler(ctx, input) {
      ctx.toolRateLimiter.check();
      checkLen('job_event_id', input.job_event_id, MAX_EVENT_ID_LEN);
      if (input.provider_npub) {
        checkLen('provider_npub', input.provider_npub, MAX_NPUB_LEN);
      }

      const agent = ctx.active();

      const localEntry = agent.agentDir
        ? await findCustomerJob(agent.agentDir, input.job_event_id)
        : undefined;

      let providerPubkey: string | undefined = localEntry?.providerPubkey;
      if (!providerPubkey && input.provider_npub) {
        try {
          providerPubkey = decodeNpub(input.provider_npub);
        } catch (e) {
          return errorResult(
            `Invalid provider_npub: ${e instanceof Error ? e.message : String(e)}`,
          );
        }
      }
      if (!providerPubkey) {
        return errorResult(
          `Job "${input.job_event_id}" not found in local history. ` +
            `Pass provider_npub explicitly to rate a job submitted from outside this MCP.`,
        );
      }

      // Idempotency: short-circuit when the same rating is already on file.
      if (localEntry?.customerFeedback === input.rating) {
        return textResult(`Already rated as ${input.rating}.`);
      }

      const capability = localEntry?.capability;
      const positive = input.rating === 'positive';

      try {
        await agent.client.marketplace.submitFeedback(
          agent.identity,
          input.job_event_id,
          providerPubkey,
          positive,
          capability,
        );
      } catch (e) {
        return errorResult(
          `Failed to publish feedback: ${e instanceof Error ? e.message : String(e)}`,
        );
      }

      if (agent.agentDir && localEntry) {
        await updateCustomerJob(agent.agentDir, input.job_event_id, {
          customerFeedback: input.rating,
        }).catch(() => {
          /* best-effort - do not mask the success of the on-relay publish */
        });
      }

      const npubForTip = input.provider_npub ?? npubFromHex(providerPubkey);
      if (positive) {
        return textResult(
          `Feedback recorded (rating=positive). Save this provider for future searches? ` +
            `Use add_contact (npub="${npubForTip}").`,
        );
      }
      return textResult('Feedback recorded (rating=negative).');
    },
  }),

  defineTool({
    name: 'add_contact',
    description:
      "Add a provider to the active agent's contacts list (.contacts.json). When the " +
      'provider has prior jobs in the local history, the contact is enriched with ' +
      'jobCount, lastJobAt, and lastCapability. Idempotent: re-calling with the same ' +
      'npub updates name/note in place without duplicating the entry.',
    schema: AddContactSchema,
    async handler(ctx, input) {
      ctx.toolRateLimiter.check();
      checkLen('npub', input.npub, MAX_NPUB_LEN);

      const agent = ctx.active();
      if (!agent.agentDir) {
        return errorResult(
          'Cannot save contacts: the active agent is ephemeral (no on-disk directory). ' +
            'Create a persistent agent first with create_agent.',
        );
      }

      let pubkey: string;
      try {
        pubkey = decodeNpub(input.npub);
      } catch (e) {
        return errorResult(`Invalid npub: ${e instanceof Error ? e.message : String(e)}`);
      }

      const history = await findCustomerJobsByProvider(agent.agentDir, pubkey);
      const last = history[0];
      const cleanName = input.name !== undefined ? sanitizeField(input.name, 200) : undefined;
      const cleanNote = input.note !== undefined ? sanitizeField(input.note, 500) : undefined;
      // `last?.providerName` originated from a discovery event (untrusted external
      // data) - sanitize before storing so list_contacts reads, the response
      // string below, and any future consumer all see safe content.
      const fallbackProviderName =
        last?.providerName !== undefined ? sanitizeField(last.providerName, 200) : undefined;

      const contact = await upsertContact(agent.agentDir, {
        pubkey,
        npub: input.npub,
        name: cleanName ?? fallbackProviderName,
        note: cleanNote,
        lastJobAt: last?.completedAt,
        lastCapability: last?.capability,
        jobCount: history.length,
      });

      const lines = [
        `Saved contact ${contact.npub}.`,
        contact.name ? `  name: ${contact.name}` : null,
        contact.lastCapability ? `  last capability: ${contact.lastCapability}` : null,
        contact.jobCount > 0 ? `  prior jobs: ${contact.jobCount}` : null,
      ].filter((line): line is string => line !== null);
      return textResult(lines.join('\n'));
    },
  }),

  defineTool({
    name: 'remove_contact',
    description: "Remove a provider from the active agent's contacts list.",
    schema: RemoveContactSchema,
    async handler(ctx, input) {
      ctx.toolRateLimiter.check();
      checkLen('npub', input.npub, MAX_NPUB_LEN);

      const agent = ctx.active();
      if (!agent.agentDir) {
        return errorResult('Active agent is ephemeral; nothing to remove.');
      }

      let pubkey: string;
      try {
        pubkey = decodeNpub(input.npub);
      } catch (e) {
        return errorResult(`Invalid npub: ${e instanceof Error ? e.message : String(e)}`);
      }

      const removed = await removeContact(agent.agentDir, pubkey);
      return removed
        ? textResult(`Removed contact ${input.npub}.`)
        : textResult(`No contact found for ${input.npub}.`);
    },
  }),

  defineTool({
    name: 'list_contacts',
    description:
      "List providers saved in the active agent's .contacts.json, newest activity " +
      'first. Use search_agents with contacts_only=true to combine this with online/' +
      'capability filters.',
    schema: ListContactsSchema,
    async handler(ctx, input) {
      ctx.toolRateLimiter.check();

      const agent = ctx.active();
      if (!agent.agentDir) {
        return textResult(
          'Active agent is ephemeral; no on-disk contacts. Create a persistent agent first.',
        );
      }

      const data = await readContacts(agent.agentDir);
      const sorted = [...data.contacts].sort((left, right) => {
        const leftKey = left.lastJobAt ?? left.addedAt;
        const rightKey = right.lastJobAt ?? right.addedAt;
        return rightKey - leftKey;
      });
      const limited = sorted.slice(0, input.limit).map((contact) => ({
        npub: contact.npub,
        name: contact.name !== undefined ? sanitizeField(contact.name, 200) : undefined,
        note: contact.note !== undefined ? sanitizeField(contact.note, 500) : undefined,
        added_at: contact.addedAt,
        last_job_at: contact.lastJobAt,
        last_capability:
          contact.lastCapability !== undefined
            ? sanitizeField(contact.lastCapability, 200)
            : undefined,
        job_count: contact.jobCount,
      }));

      const { text: wrapped } = sanitizeUntrusted(JSON.stringify(limited, null, 2), 'structured');
      return textResult(`${limited.length} contact(s):\n${wrapped}`);
    },
  }),
];
