/**
 * One `askr` command's run (5.0): the loaded `@elisym/askr`, the API and relay
 * it talks to, the profile, and the one 85-second deadline every request,
 * relay read, poll and retry draws from.
 */
import { homedir } from 'node:os';
import type * as AskrModule from '@elisym/askr';
import type { Filter, NostrEvent } from 'nostr-tools';
import { finalizeEvent } from 'nostr-tools/pure';
import {
  ADMIN_URL,
  API_OVERRIDE_ENV,
  ASKR_COMMAND,
  DEADLINE_MS,
  DEFAULT_PROFILE,
  LOCAL_HOSTS,
  RELAY_OVERRIDE_ENV,
  UNSAFE_OVERRIDE_ENV,
} from './constants';
import { AskrExit, EXIT, type AskrExitOptions } from './errors';
import type { KeyFileOps } from './owner-key';

export type Askr = typeof AskrModule;

/** A relay connection the run reads from; `connectSyncClient` gives one. */
export interface RelayHandle {
  query(relays: readonly string[], filter: Filter): Promise<NostrEvent[]>;
  close(): void;
}

/** Everything a run touches outside itself: replaced in tests. */
export interface AskrDeps {
  fetch: typeof fetch;
  connectRelay: (url: string) => Promise<RelayHandle>;
  /** Unix ms. */
  now: () => number;
  home: string;
  env: Readonly<Record<string, string | undefined>>;
  /** A line for stderr: only the test-override notice. */
  notice: (line: string) => void;
  /** Key file creation's file operations; tests replace them to race another run. */
  keyFileOps?: KeyFileOps;
}

export function defaultDeps(askr: Askr): AskrDeps {
  return {
    fetch: (input, init) => globalThis.fetch(input, init),
    connectRelay: (url) => askr.connectSyncClient(url),
    now: () => Date.now(),
    home: process.env.HOME ?? homedir(),
    env: process.env,
    notice: (line) => process.stderr.write(`${line}\n`),
  };
}

export interface SessionInput {
  askr: Askr;
  deps: AskrDeps;
  profile: string;
  /** The command and its arguments as typed after `askr`: the `resume` of a re-run of the same line. */
  args: readonly string[];
}

/** The API answer: the JSON of a 2xx, or the refusal's `error` code and its fields. */
export type ApiResult<T> =
  | { ok: true; status: number; body: T }
  | { ok: false; status: number; code: string; detail: Record<string, unknown> };

export type ApiRefusal = Extract<ApiResult<unknown>, { ok: false }>;

export interface CallOptions {
  /** A bound below the deadline; `onTimeout` says what reaching it means. */
  timeoutMs?: number;
  onTimeout?: () => AskrExit;
  headers?: Record<string, string>;
  /** Unsigned (the gateway's public routes). */
  unsigned?: boolean;
}

const SHELL_SAFE_RE = /^[A-Za-z0-9_@%+=:,./-]+$/;

function shellQuote(value: string): string {
  return SHELL_SAFE_RE.test(value) ? value : `'${value.replaceAll("'", `'\\''`)}'`;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** A refusal's JSON body, or an empty record when it has none. */
function recordOf(text: string | undefined): Record<string, unknown> {
  if (text === undefined) {
    return {};
  }
  try {
    const parsed: unknown = JSON.parse(text);
    return isRecord(parsed) ? parsed : {};
  } catch {
    return {};
  }
}

function withoutTrailingSlash(value: string): string {
  return value.replace(/\/+$/u, '');
}

/** A test override of a base URL: only a local host, unless explicitly unsafe (5.0). */
function overridden(deps: AskrDeps, name: string, fallback: string): string {
  const value = deps.env[name]?.trim();
  if (value === undefined || value === '') {
    return fallback;
  }
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new AskrExit(EXIT.BAD_INPUT, 'bad_override', { hint: `${name} is not a URL` });
  }
  if (!LOCAL_HOSTS.includes(url.hostname) && deps.env[UNSAFE_OVERRIDE_ENV] !== '1') {
    throw new AskrExit(EXIT.BAD_INPUT, 'bad_override', {
      hint: `${name} is for local tests only: it must name localhost or 127.0.0.1`,
    });
  }
  const base = withoutTrailingSlash(value);
  deps.notice(`askr: ${name} override in use: ${base}`);
  return base;
}

const EXPIRED = Symbol('expired');

export class Session {
  readonly askr: Askr;
  readonly deps: AskrDeps;
  readonly profile: string;
  readonly apiBase: string;
  readonly relayUrl: string;
  readonly adminUrl: string;
  private readonly args: readonly string[];
  private readonly deadline: number;
  private relay: RelayHandle | undefined;
  private signer: Uint8Array | undefined;

  constructor(input: SessionInput) {
    this.askr = input.askr;
    this.deps = input.deps;
    this.profile = input.profile;
    this.args = input.args;
    this.deadline = input.deps.now() + DEADLINE_MS;
    this.apiBase = overridden(input.deps, API_OVERRIDE_ENV, input.askr.ASKR_API_BASE);
    this.relayUrl = overridden(input.deps, RELAY_OVERRIDE_ENV, input.askr.ASKR_RELAYS[0] ?? '');
    this.adminUrl =
      this.apiBase === input.askr.ASKR_API_BASE ? ADMIN_URL : `${this.apiBase}/admin/`;
  }

  /** The owner key every admin call is signed with. */
  signAs(secretKey: Uint8Array): void {
    this.signer = secretKey;
  }

  remaining(): number {
    return Math.max(0, this.deadline - this.deps.now());
  }

  nowSecs(): number {
    return Math.floor(this.deps.now() / 1000);
  }

  /** `--profile <name>`, when not the default. */
  profileArgs(): string[] {
    return this.profile === DEFAULT_PROFILE ? [] : ['--profile', this.profile];
  }

  /** The exact line that ran: re-running it finishes the job. */
  resumeSame(): string {
    return [ASKR_COMMAND, ...this.args.map((arg) => shellQuote(arg))].join(' ');
  }

  /** Another command of the same profile. */
  resumeWith(command: string): string {
    return [ASKR_COMMAND, command, ...this.profileArgs()].join(' ');
  }

  /** Exit 4 with the line to resume with. */
  notDone(code: string, options: AskrExitOptions & { resume?: string } = {}): AskrExit {
    return new AskrExit(EXIT.NOT_DONE, code, {
      ...options,
      fields: { ...options.fields, resume: options.resume ?? this.resumeSame() },
    });
  }

  deadlineReached(): AskrExit {
    return this.notDone('deadline', {
      hint: "not done within this command's time: run the resume command in about a minute",
    });
  }

  /** Wait `ms`, or what is left of the deadline when less. */
  async sleep(ms: number): Promise<void> {
    const wait = Math.min(ms, this.remaining());
    await new Promise((resolve) => setTimeout(resolve, wait));
  }

  /** `work`, or EXPIRED when `ms` pass first; a late rejection of `work` is swallowed. */
  private async within<T>(work: Promise<T>, ms: number): Promise<T | typeof EXPIRED> {
    work.catch(() => undefined);
    let timer: ReturnType<typeof setTimeout> | undefined;
    const expiry = new Promise<typeof EXPIRED>((resolve) => {
      timer = setTimeout(() => resolve(EXPIRED), ms);
    });
    try {
      return await Promise.race([work, expiry]);
    } finally {
      clearTimeout(timer);
    }
  }

  private async authorization(url: string, method: string, body: string): Promise<string> {
    const secretKey = this.signer;
    if (secretKey === undefined) {
      throw new Error('no owner key to sign with');
    }
    // A fresh event per request: the server refuses a replayed one (5.0).
    return this.askr.nip98Header({
      signEvent: async (template) => finalizeEvent(template, secretKey),
      url,
      method,
      body,
      now: this.nowSecs(),
    });
  }

  /** One API call within the deadline, NIP-98 signed by O over the exact body. */
  async call<T>(
    method: string,
    path: string,
    payload?: unknown,
    options: CallOptions = {},
  ): Promise<ApiResult<T>> {
    const url = `${this.apiBase}${path}`;
    const body = payload === undefined ? '' : JSON.stringify(payload);
    const headers: Record<string, string> = { ...options.headers };
    if (options.unsigned !== true) {
      headers.authorization = await this.authorization(url, method, body);
    }
    if (body !== '') {
      headers['content-type'] = 'application/json';
    }
    const limit = Math.min(this.remaining(), options.timeoutMs ?? Number.POSITIVE_INFINITY);
    // Decided now: once the bound passed, less of the deadline is left than the bound was.
    const ownBound = limit < this.remaining() ? options.onTimeout : undefined;
    const timedOut = (): AskrExit => (ownBound === undefined ? this.deadlineReached() : ownBound());
    if (limit <= 0) {
      throw timedOut();
    }
    const controller = new AbortController();
    const request = this.deps.fetch(url, {
      method,
      headers,
      ...(body === '' ? {} : { body }),
      signal: controller.signal,
    });
    let response: Response | typeof EXPIRED;
    try {
      response = await this.within(request, limit);
    } catch {
      throw this.notDone('network', {
        hint: 'the Askr server could not be reached: check the connection and run the resume command',
      });
    }
    if (response === EXPIRED) {
      controller.abort();
      throw timedOut();
    }
    const text = await this.within(response.text(), this.remaining()).catch(() => undefined);
    if (text === EXPIRED) {
      throw this.deadlineReached();
    }
    if (response.ok && text !== undefined) {
      try {
        // The server's JSON in its documented shape (the server this CLI is released with).
        const body: T = JSON.parse(text);
        return { ok: true, status: response.status, body };
      } catch {
        return { ok: false, status: response.status, code: 'unexpected', detail: {} };
      }
    }
    const detail = recordOf(text);
    const code = typeof detail.error === 'string' ? detail.error : 'unexpected';
    return { ok: false, status: response.status, code, detail };
  }

  private async connection(): Promise<RelayHandle> {
    if (this.relay !== undefined) {
      return this.relay;
    }
    const connecting = this.deps.connectRelay(this.relayUrl);
    let relay: RelayHandle | typeof EXPIRED;
    try {
      relay = await this.within(connecting, this.remaining());
    } catch {
      throw this.notDone('relay_unavailable', {
        hint: 'the Askr relay could not be reached: run the resume command in about a minute',
      });
    }
    if (relay === EXPIRED) {
      // A connection that opens late is closed as soon as it does.
      connecting.then((late) => late.close()).catch(() => undefined);
      throw this.deadlineReached();
    }
    this.relay = relay;
    return relay;
  }

  /**
   * A whole relay read, raced against the deadline: a read takes no signal, so
   * on expiry the connection is closed, which ends the pending read.
   */
  async relayQuery(filter: Filter): Promise<NostrEvent[]> {
    const relay = await this.connection();
    let events: NostrEvent[] | typeof EXPIRED;
    try {
      events = await this.within(relay.query([this.relayUrl], filter), this.remaining());
    } catch {
      this.close();
      throw this.notDone('relay_unavailable', {
        hint: 'the Askr relay did not answer the whole read: run the resume command in about a minute',
      });
    }
    if (events === EXPIRED) {
      this.close();
      throw this.deadlineReached();
    }
    return events;
  }

  close(): void {
    this.relay?.close();
    this.relay = undefined;
  }
}
