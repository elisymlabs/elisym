/**
 * `askr policy` (5.3): one policy page, signed by server K as a 30495.
 * Removing one is done in the admin.
 */
import { NOT_AUTHORIZED_MESSAGE, NOT_AUTHORIZED_RETRY_MS, POLICY_SLUG_RE } from './constants';
import { AskrExit, EXIT, type CommandOutcome } from './errors';
import { invalidFlag, readFlagFile } from './files';
import { readSigned } from './read';
import type { Session } from './session';
import { inactiveExit, readView, refusalExit, useOwnerKey } from './store';

export interface PolicyOptions {
  slug: string;
  title: string;
  file: string;
}

export async function runPolicy(session: Session, options: PolicyOptions): Promise<CommandOutcome> {
  const { LIMITS } = session.askr;
  if (!POLICY_SLUG_RE.test(options.slug)) {
    throw invalidFlag('--slug', 'up to 64 lowercase letters, digits or hyphens, like returns');
  }
  const title = options.title.trim();
  if (title === '' || title.length > LIMITS.TITLE_CHARS) {
    throw invalidFlag('--title', `1 to ${LIMITS.TITLE_CHARS} characters`);
  }
  const body = await readFlagFile(options.file, '--file', session.deps.home);
  if (body.trim() === '' || body.length > LIMITS.POLICY_CONTENT_CHARS) {
    throw invalidFlag('--file', `1 to ${LIMITS.POLICY_CONTENT_CHARS} characters of Markdown`);
  }
  const key = await useOwnerKey(session);
  const view = await readView(session);
  if (view.status !== 'active') {
    throw inactiveExit(view);
  }
  const { config } = await readSigned(session, key.owner, key.secretKey);
  if (config === undefined) {
    throw new AskrExit(EXIT.BAD_INPUT, 'no_settings', { hint: 'run askr init first' });
  }
  if (config.policyKey !== view.catalogKey) {
    throw new AskrExit(EXIT.REFUSED, 'wrong_source', {
      hint: "this store's policies are signed by another key: manage them where that key is",
    });
  }
  let wait = NOT_AUTHORIZED_RETRY_MS;
  for (;;) {
    const result = await session.call<{ id: string }>(
      'PUT',
      `/v1/admin/policies/${encodeURIComponent(options.slug)}`,
      { title, body },
    );
    if (result.ok) {
      return {
        exitCode: EXIT.OK,
        output: { ok: true, storeId: key.storeId, slug: options.slug, id: result.body.id },
      };
    }
    const message = typeof result.detail.message === 'string' ? result.detail.message : undefined;
    if (result.code === 'publish_refused' && message === NOT_AUTHORIZED_MESSAGE) {
      if (session.remaining() <= wait) {
        throw session.notDone('not_authorized_yet', {
          hint: "the store's catalog key is not on the relay yet: run the resume command in about a minute",
        });
      }
      await session.sleep(wait);
      wait *= 2;
      continue;
    }
    switch (result.code) {
      case 'publish_refused':
        throw session.notDone('publish_refused', {
          hint: 'the relay did not take the policy: run the resume command in about a minute',
          ...(message === undefined ? {} : { message }),
        });
      case 'policy_imported':
        throw new AskrExit(EXIT.REFUSED, 'policy_imported', {
          hint: 'your Shopify connector imports this policy: change it in Shopify',
        });
      case 'too_many_policies':
        throw new AskrExit(EXIT.REFUSED, 'too_many_policies', {
          hint: 'a store has at most 50 policies: remove one in the admin',
        });
      case 'inactive':
        throw inactiveExit(view);
      case 'bad_request':
        throw new AskrExit(EXIT.BAD_INPUT, 'bad_request');
      default:
        throw refusalExit(session, result);
    }
  }
}
