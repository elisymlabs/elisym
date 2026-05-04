import { afterEach, describe, expect, it } from 'vitest';
import {
  createMetricsContext,
  instrumentCallbacks,
  parseMetricsPort,
  serveMetrics,
  startGaugePolling,
  type MetricsServer,
} from '../src/metrics.js';
import type { IncomingJob } from '../src/transport/nostr.js';

const fakeJob = (jobId: string, capability: string): IncomingJob =>
  ({
    jobId,
    tags: [capability, 'elisym'],
    input: 'unused',
    customerPubkey: 'pk',
    encrypted: false,
  }) as unknown as IncomingJob;

describe('parseMetricsPort', () => {
  it('returns undefined for missing input', () => {
    expect(parseMetricsPort(undefined)).toBeUndefined();
    expect(parseMetricsPort('')).toBeUndefined();
  });

  it('parses a valid port', () => {
    expect(parseMetricsPort('9464')).toBe(9464);
  });

  it('rejects non-numeric / out-of-range', () => {
    expect(() => parseMetricsPort('zero')).toThrow(/integer 1\.\.65535/);
    expect(() => parseMetricsPort('0')).toThrow(/integer 1\.\.65535/);
    expect(() => parseMetricsPort('70000')).toThrow(/integer 1\.\.65535/);
  });
});

describe('instrumentCallbacks', () => {
  it('increments jobs_received and jobs_completed counters', async () => {
    const ctx = createMetricsContext();
    const wrapped = instrumentCallbacks(ctx);

    wrapped.onJobReceived?.(fakeJob('job-1', 'translate'));
    wrapped.onJobReceived?.(fakeJob('job-2', 'translate'));
    wrapped.onJobCompleted?.('job-1', 'ok');
    wrapped.onJobError?.('job-2', 'boom');

    const text = await ctx.registry.metrics();
    expect(text).toMatch(/elisym_jobs_received_total\{[^}]*capability="translate"[^}]*\}\s+2/);
    expect(text).toMatch(
      /elisym_jobs_completed_total\{[^}]*capability="translate"[^}]*result="ok"[^}]*\}\s+1/,
    );
    expect(text).toMatch(
      /elisym_jobs_completed_total\{[^}]*capability="translate"[^}]*result="error"[^}]*\}\s+1/,
    );
  });

  it('forwards callbacks to the inner handler', () => {
    const ctx = createMetricsContext();
    const calls: string[] = [];
    const wrapped = instrumentCallbacks(ctx, {
      onJobReceived: (job) => calls.push(`recv:${job.jobId}`),
      onJobCompleted: (id) => calls.push(`done:${id}`),
      onPaymentReceived: (id, amt) => calls.push(`pay:${id}:${amt}`),
    });

    wrapped.onJobReceived?.(fakeJob('a', 'x'));
    wrapped.onJobCompleted?.('a', 'ok');
    wrapped.onPaymentReceived?.('a', 1234);

    expect(calls).toEqual(['recv:a', 'done:a', 'pay:a:1234']);
  });

  it('records job duration histograms with capability label', async () => {
    const ctx = createMetricsContext();
    const wrapped = instrumentCallbacks(ctx);

    wrapped.onJobReceived?.(fakeJob('dur-1', 'summarize'));
    await new Promise((resolve) => setTimeout(resolve, 25));
    wrapped.onJobCompleted?.('dur-1', 'ok');

    const text = await ctx.registry.metrics();
    expect(text).toMatch(/elisym_job_duration_seconds_count\{[^}]*capability="summarize"/);
  });
});

describe('startGaugePolling', () => {
  it('reads inFlight and pending counts from the runtime', async () => {
    const ctx = createMetricsContext();
    const fakeRuntime = {
      getInFlightCount: () => 4,
      getPendingCount: () => 7,
    } as { getInFlightCount: () => number; getPendingCount: () => number };
    // @ts-expect-error - structural shim is enough for the gauge polling
    const stop = startGaugePolling(ctx, fakeRuntime, undefined, 50);
    await new Promise((r) => setTimeout(r, 80));
    stop();

    const text = await ctx.registry.metrics();
    expect(text).toMatch(/elisym_jobs_in_flight\{[^}]*\}\s+4/);
    expect(text).toMatch(/elisym_jobs_pending\{[^}]*\}\s+7/);
  });
});

describe('serveMetrics', () => {
  let handle: MetricsServer | undefined;

  afterEach(async () => {
    if (handle) {
      await handle.close();
      handle = undefined;
    }
  });

  it('responds to GET /metrics with prom-client text', async () => {
    const ctx = createMetricsContext();
    handle = await serveMetrics(ctx, 0); // ephemeral port
    // serveMetrics returns the configured port in url; with port=0 the actual
    // port comes from the OS, so skip url assertion and probe via the bound
    // address. node:http listen on 0 uses an OS-assigned port; recover it
    // by re-resolving the url fragment.
    // Workaround: bind a known port instead, retrying if busy.
    await handle.close();

    const port = 19464 + Math.floor(Math.random() * 1000);
    handle = await serveMetrics(ctx, port);
    const res = await fetch(handle.url);
    expect(res.status).toBe(200);
    expect(res.headers.get('content-type') ?? '').toMatch(/text\/plain/);
    const body = await res.text();
    expect(body).toMatch(/^# HELP elisym_/m);

    const health = await fetch(`http://127.0.0.1:${port}/healthz`);
    expect(health.status).toBe(200);
    expect(await health.text()).toBe('ok');

    const missing = await fetch(`http://127.0.0.1:${port}/nope`);
    expect(missing.status).toBe(404);
  });
});
