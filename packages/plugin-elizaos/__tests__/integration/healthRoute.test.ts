import type { RouteResponse } from '@elizaos/core';
import { afterEach, describe, expect, it } from 'vitest';
import {
  incrementCounter,
  registerDefaultMetrics,
  resetMetrics,
  METRIC_JOBS_TOTAL,
} from '../../src/lib/metrics';
import { healthRoute } from '../../src/routes/health';
import { metricsRoute } from '../../src/routes/metrics';
import { bootState, makeStubRuntime } from '../helpers/runtime';

interface Captured {
  status?: number;
  body?: unknown;
  headers: Record<string, string>;
}

function makeRes(): { res: RouteResponse; captured: Captured } {
  const captured: Captured = { headers: {} };
  const res: RouteResponse = {
    status(code: number) {
      captured.status = code;
      return res;
    },
    json(data: unknown) {
      captured.body = data;
      return res;
    },
    send(data: unknown) {
      captured.body = data;
      return res;
    },
    end() {
      return res;
    },
    setHeader(name: string, value: string | string[]) {
      captured.headers[name.toLowerCase()] = String(value);
      return res;
    },
  };
  return { res, captured };
}

afterEach(() => {
  resetMetrics();
});

describe('integration: /plugins/elisym/health', () => {
  it('returns 503 when the plugin has not initialized state yet', async () => {
    const runtime = makeStubRuntime();
    const { res, captured } = makeRes();
    await healthRoute.handler!({}, res, runtime);
    expect(captured.status).toBe(503);
    expect((captured.body as { status: string }).status).toBe('uninitialized');
  });

  it('returns ok with network when state is initialised', async () => {
    const runtime = makeStubRuntime();
    bootState(runtime, { network: 'devnet' });
    const { res, captured } = makeRes();
    await healthRoute.handler!({}, res, runtime);
    expect(captured.status).toBe(200);
    const body = captured.body as { status: string; agent: { network: string } };
    expect(body.status).toBe('ok');
    expect(body.agent.network).toBe('devnet');
  });

  it('downgrades status to degraded once shuttingDown is set', async () => {
    const runtime = makeStubRuntime();
    bootState(runtime);
    const { getState } = await import('../../src/state');
    getState(runtime).shuttingDown = true;
    const { res, captured } = makeRes();
    await healthRoute.handler!({}, res, runtime);
    expect((captured.body as { status: string }).status).toBe('degraded');
  });
});

describe('integration: /plugins/elisym/metrics', () => {
  it('renders Prometheus text and sets the right content type', async () => {
    registerDefaultMetrics();
    incrementCounter(METRIC_JOBS_TOTAL, { side: 'provider', state: 'delivered' });
    const runtime = makeStubRuntime();
    const { res, captured } = makeRes();
    await metricsRoute.handler!({}, res, runtime);
    expect(captured.status).toBe(200);
    expect(captured.headers['content-type']).toContain('text/plain');
    expect(captured.body).toContain('elisym_jobs_total{side="provider",state="delivered"} 1');
  });
});
