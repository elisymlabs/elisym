/**
 * `askr plan free` (5.9): the owner's explicit choice of Free, the only
 * self-serve plan. The prompt runs it only when the human chose Free.
 */
import { UPGRADE } from './constants';
import { AskrExit, EXIT, type CommandOutcome } from './errors';
import type { Session } from './session';
import {
  CONTACT_HINT,
  INIT_FIRST_HINT,
  readView,
  refusalExit,
  tierOf,
  stoppedKinds,
  useOwnerKey,
  waitPublished,
} from './store';
import type { StoreView } from './types';

const FREE = 'free';

export async function runPlan(session: Session, plan: string): Promise<CommandOutcome> {
  if (plan !== FREE) {
    throw new AskrExit(EXIT.BAD_INPUT, 'paid_plan', {
      hint: 'paid plans: message us with your Store ID',
      fields: { upgrade: UPGRADE },
    });
  }
  const key = await useOwnerKey(session);
  const result = await session.call<StoreView & { activation: string }>(
    'POST',
    '/v1/admin/store/plan',
    { plan: FREE },
  );
  if (!result.ok) {
    switch (result.code) {
      case 'capacity_reached':
        throw new AskrExit(EXIT.LIMIT, 'capacity_reached', {
          hint: 'Free is full right now: message us with your Store ID, or try again tomorrow',
          fields: { upgrade: UPGRADE, resume: session.resumeSame() },
        });
      case 'free_unavailable':
        throw new AskrExit(EXIT.LIMIT, 'free_unavailable', {
          hint: 'Free cannot be started right now: message us with your Store ID',
          fields: { upgrade: UPGRADE },
        });
      case 'no_settings':
      case 'no_store':
        throw new AskrExit(EXIT.BAD_INPUT, result.code, { hint: INIT_FIRST_HINT });
      case 'not_pending':
        throw new AskrExit(EXIT.REFUSED, 'not_pending', {
          hint: `the store is suspended: ${CONTACT_HINT}`,
        });
      case 'operator_managed':
        throw new AskrExit(EXIT.REFUSED, 'operator_managed', {
          hint: `we manage this store's plan: ${CONTACT_HINT}`,
        });
      case 'read_failed':
        throw session.notDone('read_failed', {
          hint: 'the store changed meanwhile: run the resume command in about a minute',
        });
      default:
        throw refusalExit(session, result);
    }
  }
  const activation = result.body.activation;
  const waited = await waitPublished(
    session,
    await readView(session),
    (view) =>
      new AskrExit(EXIT.REFUSED, 'publish_stopped', {
        hint: 'run the same askr init line once (it stores the event again); if it stays stopped, report this to us with your Store ID',
        fields: { kinds: stoppedKinds(view) },
      }),
  );
  if (!waited.published) {
    throw session.notDone('publication_pending', {
      hint: 'the store is active; its settings are being published: run the resume command in about a minute',
      fields: { activation, published: false },
    });
  }
  return {
    exitCode: EXIT.OK,
    output: {
      ok: true,
      storeId: key.storeId,
      status: waited.view.status,
      tier: tierOf(waited.view),
      activation,
      published: true,
    },
  };
}
