/**
 * `askr products` (5.2): a JSON or CSV file published through server K
 * (source `admin` only), dry run first, then the real call and its sync,
 * all within the command deadline. A re-run of the same line is idempotent.
 */
import type { CatalogItemInput, StoreConfig, SyncDiff } from '@elisym/askr';
import {
  ABSENT_WARNING_BPS,
  ABSENT_WARNING_COUNT,
  MAX_CATALOG_BODY_BYTES,
  MAX_ISSUES,
  MIN_REAL_CALL_MS,
  NOT_AUTHORIZED_MESSAGE,
  NOT_AUTHORIZED_RETRY_MS,
  SAMPLE_SIZE,
  SYNC_POLL_MS,
} from './constants';
import { AskrExit, EXIT, type CommandOutcome } from './errors';
import { fileSize, readFlagFile } from './files';
import { readListings, readSigned } from './read';
import type { ApiRefusal, ApiResult, Session } from './session';
import { inactiveExit, readView, refusalExit, upgradeOf, useOwnerKey } from './store';
import type { StoreView } from './types';

export interface ProductsOptions {
  file: string;
  replace?: boolean;
  allowHide?: boolean;
  dryRun?: boolean;
}

const BPS_WHOLE = 10_000;

type FileProducts = { format: 'json'; items: CatalogItemInput[] } | { format: 'csv'; text: string };

function invalidFile(hint: string, fields: Record<string, unknown> = {}): AskrExit {
  return new AskrExit(EXIT.BAD_INPUT, 'invalid_file', { hint, fields });
}

function itemsOfJson(parsed: unknown): unknown[] | undefined {
  if (Array.isArray(parsed)) {
    return parsed;
  }
  if (typeof parsed === 'object' && parsed !== null && 'items' in parsed) {
    const items = parsed.items;
    return Array.isArray(items) ? items : undefined;
  }
  return undefined;
}

/** Everything about the file that needs no store, checked before the key or any call. */
async function readProductsFile(session: Session, path: string): Promise<FileProducts> {
  const { askr } = session;
  const lower = path.toLowerCase();
  const isCsv = lower.endsWith('.csv');
  if (!isCsv && !lower.endsWith('.json')) {
    // Checked after the file exists, so a missing file is always `file_not_found`.
    await fileSize(path, '--file');
    throw invalidFile('--file: a .json or .csv file');
  }
  const size = await fileSize(path, '--file');
  if (isCsv) {
    const tooLarge = askr.csvSizeProblem(size);
    if (tooLarge !== undefined) {
      throw invalidFile(tooLarge);
    }
  } else if (size > MAX_CATALOG_BODY_BYTES) {
    throw invalidFile(
      'the file is larger than 8 MB: split it and publish it in parts without --replace',
    );
  }
  const text = await readFlagFile(path, '--file', session.deps.home);
  if (isCsv) {
    const parsed = askr.parseCsv(text);
    if (parsed.unclosedQuoteLine !== undefined) {
      throw invalidFile(`a quoted field opened on line ${parsed.unclosedQuoteLine} never closes`);
    }
    if (parsed.rows.length < 2) {
      throw invalidFile('the CSV needs a header row and at least one product row');
    }
    return { format: 'csv', text };
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    throw invalidFile('the file is not valid JSON');
  }
  const values = itemsOfJson(parsed);
  if (values === undefined) {
    throw invalidFile('the JSON must be an array of products or { "items": [...] }');
  }
  const items: CatalogItemInput[] = [];
  const issues: { index: number; path: string; message: string }[] = [];
  values.forEach((value, index) => {
    const checked = askr.CatalogItemInputSchema.safeParse(value);
    if (checked.success) {
      items.push(checked.data);
      return;
    }
    for (const issue of checked.error.issues) {
      issues.push({ index, path: issue.path.join('.'), message: issue.message });
    }
  });
  if (issues.length > 0) {
    throw invalidFile('fix these products and run again', { issues: issues.slice(0, MAX_ISSUES) });
  }
  const repeated = repeatedIds(items);
  if (repeated.length > 0) {
    throw invalidFile('each product needs its own d: these ids are used more than once', {
      repeated: repeated.slice(0, MAX_ISSUES),
    });
  }
  return { format: 'json', items };
}

/** The product ids a file gives more than once, in file order (the server refuses them too). */
function repeatedIds(items: readonly CatalogItemInput[]): string[] {
  const seen = new Set<string>();
  const repeated = new Set<string>();
  for (const item of items) {
    if (seen.has(item.d)) {
      repeated.add(item.d);
    }
    seen.add(item.d);
  }
  return [...repeated];
}

function itemsOfCsv(session: Session, text: string, currency: string): CatalogItemInput[] {
  const imported = session.askr.productsFromCsv(text, currency);
  if (imported.fileErrors.length > 0) {
    throw invalidFile('the CSV cannot be read: fix the problems listed and run again', {
      fileErrors: imported.fileErrors,
    });
  }
  if (imported.errors.length > 0) {
    throw new AskrExit(EXIT.BAD_INPUT, 'invalid_rows', {
      hint: 'fix these CSV lines and run again',
      fields: { errors: imported.errors.slice(0, MAX_ISSUES) },
    });
  }
  return imported.items;
}

function sourceGate(config: StoreConfig): void {
  if (config.source.kind === 'admin') {
    return;
  }
  throw new AskrExit(EXIT.REFUSED, 'wrong_source', {
    hint:
      config.source.kind === 'connector'
        ? 'products come from your connector'
        : 'manage this store in the admin',
  });
}

/** Product links the chat would not show: not on the store's origins or link origins. */
function urlWarnings(
  items: readonly CatalogItemInput[],
  config: StoreConfig,
): { d: string; url: string }[] {
  const allowed = new Set([...config.origins, ...config.linkOrigins]);
  return items.flatMap((item) => {
    if (item.url === undefined) {
      return [];
    }
    let origin: string | undefined;
    try {
      origin = new URL(item.url).origin;
    } catch {
      origin = undefined;
    }
    return origin !== undefined && allowed.has(origin) ? [] : [{ d: item.d, url: item.url }];
  });
}

function isNotAuthorized(result: ApiRefusal): boolean {
  return result.code === 'sync_refused' && result.detail.message === NOT_AUTHORIZED_MESSAGE;
}

export async function runProducts(
  session: Session,
  options: ProductsOptions,
): Promise<CommandOutcome> {
  const file = await readProductsFile(session, options.file);
  const key = await useOwnerKey(session);
  const view = await readView(session);
  // A pending store's file is checked here, without the server: nothing is published until it is active.
  const localDryRun = options.dryRun === true && view.status === 'pending';
  if (view.status !== 'active' && !localDryRun) {
    throw inactiveExit(view);
  }
  const { config } = await readSigned(session, key.owner, key.secretKey);
  if (config === undefined) {
    throw new AskrExit(EXIT.BAD_INPUT, 'no_settings', { hint: 'run askr init first' });
  }
  sourceGate(config);
  const items =
    file.format === 'csv' ? itemsOfCsv(session, file.text, config.currency) : file.items;
  const mode = options.replace === true ? 'replace' : 'upsert';
  const bodyOf = (dryRun: boolean) => ({ mode, items, dryRun });
  if (Buffer.byteLength(JSON.stringify(bodyOf(false)), 'utf8') > MAX_CATALOG_BODY_BYTES) {
    throw new AskrExit(EXIT.BAD_INPUT, 'body_too_large', {
      hint: 'split the file and publish it in parts without --replace',
    });
  }
  const flow = new CatalogFlow(session, view, bodyOf, options.dryRun === true);
  const summary = {
    ok: true,
    storeId: key.storeId,
    mode,
    dryRun: options.dryRun === true,
    inFile: items.length,
    visibleInFile: items.filter((item) => item.visibility !== 'hidden').length,
  };
  const extra: Record<string, unknown> = {};
  const linkWarnings = urlWarnings(items, config);
  if (linkWarnings.length > 0) {
    extra.urlWarnings = linkWarnings.slice(0, SAMPLE_SIZE);
  }
  if (localDryRun) {
    const local = await localDiff(session, view.catalogKey, items, mode);
    return { exitCode: EXIT.OK, output: { ...summary, ...local, ...extra } };
  }
  for (;;) {
    const diff = await flow.dryRun();
    if (mode === 'upsert' && extra.warning === undefined) {
      const warning = await absentWarning(session, view.catalogKey, items);
      if (warning !== undefined) {
        extra.warning = warning;
      }
    }
    const counts = countsOf(diff);
    if (options.dryRun === true) {
      return { exitCode: EXIT.OK, output: { ...summary, ...counts, ...extra } };
    }
    if (mode === 'replace' && diff.hidden.length > 0 && options.allowHide !== true) {
      throw new AskrExit(EXIT.BAD_INPUT, 'would_hide', {
        hint: 'this would hide listed products missing from the file: confirm with the human, then add --allow-hide',
        fields: { ...counts, wouldHide: diff.hidden },
      });
    }
    if (diff.created.length + diff.updated.length + diff.hidden.length === 0) {
      return { exitCode: EXIT.OK, output: { ...summary, ...counts, sync: 'done', ...extra } };
    }
    if (session.remaining() < MIN_REAL_CALL_MS) {
      throw session.notDone('deadline', {
        hint: 'too little time left to publish in this run: run the resume command',
      });
    }
    const started = await flow.publish();
    if (started === undefined) {
      continue;
    }
    const sync = await flow.waitSync();
    return {
      exitCode: EXIT.OK,
      output: {
        ...summary,
        ...countsOf(started),
        sync,
        ...(sync === 'running' ? { next: 'askr status' } : {}),
        ...extra,
      },
    };
  }
}

/**
 * A dry run of a pending store, made here: the file was read and checked as the server checks
 * it, and it is compared with what is listed by product id only (the server, which compares the
 * contents and the plan's product limit, does it once the store is active).
 */
async function localDiff(
  session: Session,
  catalogKey: string,
  items: readonly CatalogItemInput[],
  mode: 'replace' | 'upsert',
): Promise<Record<string, unknown>> {
  const { listed } = await readListings(session, catalogKey);
  const inFile = new Set(items.map((item) => item.d));
  const listedIds = new Set(listed);
  const created = items.filter((item) => !listedIds.has(item.d)).map((item) => item.d);
  const hidden = mode === 'replace' ? listed.filter((d) => !inFile.has(d)) : [];
  return {
    checked: 'local',
    published: false,
    created: created.length,
    alreadyListed: items.length - created.length,
    hidden: hidden.length,
    sample: { created: created.slice(0, SAMPLE_SIZE), hidden: hidden.slice(0, SAMPLE_SIZE) },
    note: "the store is pending: the file is valid and nothing was published; once the plan is active, run this line again without --dry-run (the server then also checks the plan's product limit)",
  };
}

function countsOf(diff: SyncDiff): Record<string, unknown> {
  return {
    created: diff.created.length,
    updated: diff.updated.length,
    hidden: diff.hidden.length,
    unchanged: diff.unchanged.length,
    sample: {
      created: diff.created.slice(0, SAMPLE_SIZE),
      hidden: diff.hidden.slice(0, SAMPLE_SIZE),
    },
  };
}

/** An upsert that leaves many listed products out of the file: probably the whole catalog (5.2). */
async function absentWarning(
  session: Session,
  catalogKey: string,
  items: readonly CatalogItemInput[],
): Promise<string | undefined> {
  const { listed } = await readListings(session, catalogKey);
  if (listed.length === 0) {
    return undefined;
  }
  const inFile = new Set(items.map((item) => item.d));
  const absent = listed.filter((d) => !inFile.has(d)).length;
  const overShare = absent * BPS_WHOLE > ABSENT_WARNING_BPS * listed.length;
  if (!overShare && absent <= ABSENT_WARNING_COUNT) {
    return undefined;
  }
  return `${absent} listed products are not in this file; if the file is your whole catalog, run with --replace (dry run first)`;
}

/** The catalog calls of one run, with the waits and retries 5.2 describes. */
class CatalogFlow {
  private notAuthorizedWait = NOT_AUTHORIZED_RETRY_MS;

  constructor(
    private readonly session: Session,
    private readonly view: StoreView,
    private readonly bodyOf: (dryRun: boolean) => unknown,
    private readonly dryRunOnly: boolean,
  ) {}

  private call(dryRun: boolean): Promise<ApiResult<{ diff: SyncDiff; started?: boolean }>> {
    return this.session.call('POST', '/v1/admin/catalog', this.bodyOf(dryRun));
  }

  /** Wait while the catalog's server K has no authorization on the relay yet. */
  private async waitAuthorized(): Promise<void> {
    if (this.session.remaining() <= this.notAuthorizedWait) {
      throw this.session.notDone('not_authorized_yet', {
        hint: "the store's catalog key is not on the relay yet: run the resume command in about a minute",
      });
    }
    await this.session.sleep(this.notAuthorizedWait);
    this.notAuthorizedWait *= 2;
  }

  /** Wait until no sync of this store runs, at least one poll (a dry run's guard never shows). */
  private async waitIdle(): Promise<void> {
    for (;;) {
      if (this.session.remaining() <= SYNC_POLL_MS) {
        throw this.session.notDone('sync_running', {
          hint: 'another catalog sync of this store is running: run the resume command in about a minute',
        });
      }
      await this.session.sleep(SYNC_POLL_MS);
      const view = await readView(this.session);
      if (view.catalogSync?.state !== 'running') {
        return;
      }
    }
  }

  private refusal(result: ApiRefusal): AskrExit {
    switch (result.code) {
      case 'too_many_products':
        return new AskrExit(EXIT.LIMIT, 'too_many_products', {
          hint: "more products than the store's plan allows",
          fields: {
            max: result.detail.max,
            upgrade: upgradeOf(this.view.billing, this.session.adminUrl),
          },
        });
      case 'invalid_items':
        return new AskrExit(EXIT.BAD_INPUT, 'invalid_items', {
          fields: {
            issues: Array.isArray(result.detail.issues)
              ? result.detail.issues.slice(0, MAX_ISSUES)
              : [],
          },
        });
      case 'inactive':
        return inactiveExit(this.view);
      case 'bad_request':
        return new AskrExit(EXIT.BAD_INPUT, 'bad_request', {
          ...(typeof result.detail.message === 'string' ? { message: result.detail.message } : {}),
        });
      case 'sync_refused':
        return this.session.notDone('sync_refused', {
          hint: 'the server could not check the catalog against the relay: run the resume command in about a minute',
          ...(typeof result.detail.message === 'string' ? { message: result.detail.message } : {}),
        });
      default:
        return refusalExit(this.session, result);
    }
  }

  async dryRun(): Promise<SyncDiff> {
    for (;;) {
      const result = await this.call(true);
      if (result.ok) {
        return result.body.diff;
      }
      if (result.code === 'sync_running') {
        if (this.dryRunOnly) {
          throw this.session.notDone('sync_running', {
            hint: 'another catalog sync of this store is running: run the resume command in about a minute',
          });
        }
        await this.waitIdle();
        continue;
      }
      if (isNotAuthorized(result)) {
        await this.waitAuthorized();
        continue;
      }
      throw this.refusal(result);
    }
  }

  /** The real call: its diff once accepted, or undefined to start over with a dry run. */
  async publish(): Promise<SyncDiff | undefined> {
    const result = await this.call(false);
    if (result.ok) {
      return result.body.diff;
    }
    if (result.code === 'sync_running') {
      await this.waitIdle();
      return undefined;
    }
    if (isNotAuthorized(result)) {
      await this.waitAuthorized();
      return undefined;
    }
    throw this.refusal(result);
  }

  /** Follow the accepted sync: `done`, `running` at the deadline, or exit 4 when it failed. */
  async waitSync(): Promise<'done' | 'running'> {
    for (;;) {
      const view = await readView(this.session);
      const sync = view.catalogSync;
      if (sync?.state === 'done') {
        return 'done';
      }
      if (sync?.state === 'failed') {
        throw this.session.notDone('sync_failed', {
          hint: 'the catalog sync failed: run the resume command once; it sends only what is still different',
          message: sync.error,
        });
      }
      if (this.session.remaining() <= SYNC_POLL_MS) {
        return 'running';
      }
      await this.session.sleep(SYNC_POLL_MS);
    }
  }
}
