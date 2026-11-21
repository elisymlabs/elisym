import { type RunSummary, summaryOfRun } from './connector-run';
/**
 * `askr connector` (5.4): preview the connector, enable it only on an `ok`
 * preview, then wait for the first scheduled run newer than the one before.
 * Pausing or removing a connector is done in the admin.
 */
import { PREVIEW_TIMEOUT_MS, SYNC_POLL_MS, UPGRADE } from './constants';
import { AskrExit, EXIT, type CommandOutcome } from './errors';
import type { ApiResult, Session } from './session';
import { inactiveExit, readView, refusalExit, useOwnerKey } from './store';
import type { ConnectorView, StoreView } from './types';

const META_HINT =
  'add <meta name="askr-verification" content="<Store ID>"> to the head of your home page (askr embed prints it), deploy, then run askr connector again';
const BOT_CHECK_HINT =
  'the shop refused to be read: it may block automated readers (a bot check, a password or maintenance page); make the products public or allow the reader, then run askr connector again';
const SLOW_SHOP_HINT =
  "the shop is slow to read; run the resume command in 90 seconds. A shop that is always this slow: use the admin's Connector tab, whose preview waits the full 2 minutes";

/** A preview's or a run's result as an exit, or undefined for `ok`. */
function resultExit(summary: RunSummary, detail: Record<string, unknown>): AskrExit | undefined {
  if (summary.status === 'ok') {
    return undefined;
  }
  if (summary.status === 'verification_failed') {
    return new AskrExit(EXIT.BAD_INPUT, 'verification_failed', {
      hint: META_HINT,
      fields: detail,
    });
  }
  if (summary.reason === 'too_many_products') {
    return new AskrExit(EXIT.LIMIT, 'too_many_products', {
      hint: "the shop has more products than the store's plan allows",
      fields: { count: summary.count, max: summary.max, upgrade: UPGRADE },
    });
  }
  if (summary.status === 'source_closed') {
    return new AskrExit(EXIT.REFUSED, 'source_closed', {
      hint: BOT_CHECK_HINT,
      fields: { httpStatus: summary.httpStatus ?? null },
    });
  }
  return new AskrExit(EXIT.REFUSED, summary.status === 'error' ? 'error' : summary.status, {
    hint: 'the connector could not read the shop: check the shop address, or open the Connector tab in the admin',
    fields: detail,
  });
}

function failuresOf(result: unknown): Record<string, unknown> {
  if (typeof result !== 'object' || result === null) {
    return {};
  }
  const detail: Record<string, unknown> = {};
  if ('failures' in result && Array.isArray(result.failures)) {
    detail.failures = result.failures;
  }
  if ('message' in result && typeof result.message === 'string') {
    detail.message = result.message;
  }
  return detail;
}

function busyExit(session: Session, connector: ConnectorView): AskrExit {
  if (!connector.enabled) {
    // An earlier preview still runs server-side.
    return session.notDone('sync_running', {
      hint: 'an earlier preview is still running: run the resume command in 150 seconds',
      fields: { retryAfterSeconds: 150 },
    });
  }
  if (summaryOfRun(connector.lastStatus)?.reason === 'sync_busy') {
    return session.notDone('sync_running', {
      hint: 'the last run found another sync running: run the resume command in 150 seconds',
      fields: { retryAfterSeconds: 150 },
    });
  }
  return session.notDone('sync_running', {
    hint: 'a sync of the connector is running: follow it with askr status',
    resume: session.resumeWith('status'),
  });
}

function noConnectorExit(): AskrExit {
  return new AskrExit(EXIT.BAD_INPUT, 'no_connector', {
    hint: 'set the connector up first: askr init --source connector --platform ...',
  });
}

function actionRefusal(session: Session, view: StoreView, result: ApiResult<unknown>): AskrExit {
  if (!result.ok && result.code === 'inactive') {
    return inactiveExit(view);
  }
  if (!result.ok && result.code === 'no_connector') {
    return noConnectorExit();
  }
  return refusalExit(session, result);
}

export async function runConnector(session: Session): Promise<CommandOutcome> {
  const key = await useOwnerKey(session);
  const view = await readView(session);
  if (view.status !== 'active' || view.tier === null) {
    throw inactiveExit(view);
  }
  const connector = view.connector;
  if (connector === null) {
    throw noConnectorExit();
  }
  const lastRunAtBefore = connector.lastRunAt;
  const preview = await session.call<{ result: unknown }>(
    'POST',
    '/v1/admin/connector/preview',
    undefined,
    {
      timeoutMs: PREVIEW_TIMEOUT_MS,
      onTimeout: () =>
        session.notDone('preview_timeout', {
          hint: SLOW_SHOP_HINT,
          resume: session.resumeWith('connector'),
          fields: { retryAfterSeconds: 90 },
        }),
    },
  );
  if (!preview.ok) {
    if (preview.code === 'sync_running') {
      throw busyExit(session, connector);
    }
    throw actionRefusal(session, view, preview);
  }
  const previewed = summaryOfRun(preview.body.result);
  if (previewed === null) {
    throw new AskrExit(EXIT.REFUSED, 'unexpected');
  }
  const previewExit = resultExit(previewed, failuresOf(preview.body.result));
  if (previewExit !== undefined) {
    throw previewExit;
  }
  const skipped =
    typeof preview.body.result === 'object' &&
    preview.body.result !== null &&
    'skipped' in preview.body.result &&
    Array.isArray(preview.body.result.skipped)
      ? preview.body.result.skipped.length
      : 0;
  const enabled = await session.call('POST', '/v1/admin/connector/enable');
  if (!enabled.ok) {
    throw actionRefusal(session, view, enabled);
  }
  for (;;) {
    if (session.remaining() <= SYNC_POLL_MS) {
      throw session.notDone('first_sync_pending', {
        hint: 'the first sync has not run yet: check that connector.lastRunAt is newer than lastRunAtBefore',
        resume: session.resumeWith('status'),
        fields: { enabled: true, lastRunAtBefore },
      });
    }
    await session.sleep(SYNC_POLL_MS);
    const current = (await readView(session)).connector;
    const lastRunAt = current?.lastRunAt ?? null;
    if (
      current === null ||
      lastRunAt === null ||
      (lastRunAtBefore !== null && lastRunAt <= lastRunAtBefore)
    ) {
      continue;
    }
    const run = summaryOfRun(current.lastStatus);
    if (run?.reason === 'sync_busy') {
      throw session.notDone('sync_busy', {
        hint: 'the first run found another sync running and did nothing: run the resume command in a minute',
        resume: session.resumeWith('connector'),
        fields: { retryAfterSeconds: 60 },
      });
    }
    const runExit = run === null ? undefined : resultExit(run, failuresOf(current.lastStatus));
    if (runExit !== undefined) {
      throw runExit;
    }
    return {
      exitCode: EXIT.OK,
      output: {
        ok: true,
        storeId: key.storeId,
        preview: {
          status: previewed.status,
          created: previewed.counts?.created ?? 0,
          updated: previewed.counts?.updated ?? 0,
          hidden: previewed.counts?.hidden ?? 0,
          skipped,
        },
        enabled: true,
        lastRun: {
          at: lastRunAt,
          status: run?.status ?? null,
          ...(run?.counts ?? {}),
        },
      },
    };
  }
}
