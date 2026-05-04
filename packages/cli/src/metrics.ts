/**
 * Prometheus metrics exporter for the provider runtime.
 *
 * Off by default. Activated via `elisym start <name> --metrics-port <n>`.
 * The exporter is a small node:http server returning text/plain prom-client
 * output at GET /metrics. Anything else returns 404. Bind address is loopback
 * unless the operator overrides via ELISYM_METRICS_HOST.
 *
 * The intended use is local capacity testing (see packages/perf). The exporter
 * adds no overhead and changes no behaviour when the flag is absent.
 */
import { createServer, type Server } from 'node:http';
import type { LlmHealthMonitor } from '@elisym/sdk/llm-health';
import { Counter, Gauge, Histogram, Registry, collectDefaultMetrics } from 'prom-client';
import type { AgentRuntime, RuntimeCallbacks } from './runtime.js';

const NAMESPACE = 'elisym';

export interface MetricsContext {
  registry: Registry;
  jobsReceived: Counter<'capability'>;
  jobsCompleted: Counter<'capability' | 'result'>;
  jobsInFlight: Gauge;
  jobsPending: Gauge;
  jobDurationSeconds: Histogram<'capability' | 'result'>;
  paymentsReceived: Counter;
  paymentAmountLamports: Histogram;
  healthGate: Gauge<'provider' | 'model' | 'status'>;
}

export function createMetricsContext(): MetricsContext {
  const registry = new Registry();
  registry.setDefaultLabels({ service: 'elisym-cli' });
  collectDefaultMetrics({ register: registry, prefix: `${NAMESPACE}_process_` });

  const jobsReceived = new Counter({
    name: `${NAMESPACE}_jobs_received_total`,
    help: 'Total job requests received by the provider runtime, by skill capability.',
    labelNames: ['capability'],
    registers: [registry],
  });

  const jobsCompleted = new Counter({
    name: `${NAMESPACE}_jobs_completed_total`,
    help: 'Total jobs that left the runtime, by capability and outcome (ok|error).',
    labelNames: ['capability', 'result'],
    registers: [registry],
  });

  const jobsInFlight = new Gauge({
    name: `${NAMESPACE}_jobs_in_flight`,
    help: 'Jobs currently held by the runtime (executing + queued past p-limit).',
    registers: [registry],
  });

  const jobsPending = new Gauge({
    name: `${NAMESPACE}_jobs_pending`,
    help: 'Jobs queued past the p-limit concurrency gate.',
    registers: [registry],
  });

  const jobDurationSeconds = new Histogram({
    name: `${NAMESPACE}_job_duration_seconds`,
    help: 'Wall-clock seconds from job receipt to completion (or error).',
    labelNames: ['capability', 'result'],
    buckets: [0.1, 0.25, 0.5, 1, 2, 5, 10, 30, 60, 120, 300],
    registers: [registry],
  });

  const paymentsReceived = new Counter({
    name: `${NAMESPACE}_payments_received_total`,
    help: 'Total payments confirmed for jobs.',
    registers: [registry],
  });

  const paymentAmountLamports = new Histogram({
    name: `${NAMESPACE}_payment_amount_lamports`,
    help: 'Net payment amount per job in lamports (or token base units).',
    buckets: [
      1_000, 10_000, 100_000, 1_000_000, 10_000_000, 100_000_000, 1_000_000_000, 10_000_000_000,
    ],
    registers: [registry],
  });

  const healthGate = new Gauge({
    name: `${NAMESPACE}_health_gate_state`,
    help: 'LLM health-gate state per (provider, model). 1 if status matches the label, else 0.',
    labelNames: ['provider', 'model', 'status'],
    registers: [registry],
  });

  return {
    registry,
    jobsReceived,
    jobsCompleted,
    jobsInFlight,
    jobsPending,
    jobDurationSeconds,
    paymentsReceived,
    paymentAmountLamports,
    healthGate,
  };
}

/**
 * Wrap an existing RuntimeCallbacks set to fan out to prom-client metrics
 * before delegating. The wrapper is non-throwing: instrumentation errors are
 * swallowed so they cannot poison the job loop.
 */
export function instrumentCallbacks(
  ctx: MetricsContext,
  inner: RuntimeCallbacks = {},
): RuntimeCallbacks {
  const startTimes = new Map<string, { startMs: number; capability: string }>();

  const capabilityOf = (job: { tags: string[] }): string => {
    for (const tag of job.tags) {
      if (typeof tag === 'string' && tag !== 'elisym') {
        return tag;
      }
    }
    return 'unknown';
  };

  return {
    onJobReceived(job) {
      try {
        const capability = capabilityOf(job);
        startTimes.set(job.jobId, { startMs: Date.now(), capability });
        ctx.jobsReceived.inc({ capability });
      } catch {
        // metrics must never throw; ignore.
      }
      inner.onJobReceived?.(job);
    },
    onJobCompleted(jobId, result) {
      try {
        const start = startTimes.get(jobId);
        startTimes.delete(jobId);
        const capability = start?.capability ?? 'unknown';
        const elapsedSeconds = start ? (Date.now() - start.startMs) / 1000 : 0;
        ctx.jobsCompleted.inc({ capability, result: 'ok' });
        ctx.jobDurationSeconds.observe({ capability, result: 'ok' }, elapsedSeconds);
      } catch {
        // ignore
      }
      inner.onJobCompleted?.(jobId, result);
    },
    onJobError(jobId, error) {
      try {
        const start = startTimes.get(jobId);
        startTimes.delete(jobId);
        const capability = start?.capability ?? 'unknown';
        const elapsedSeconds = start ? (Date.now() - start.startMs) / 1000 : 0;
        ctx.jobsCompleted.inc({ capability, result: 'error' });
        ctx.jobDurationSeconds.observe({ capability, result: 'error' }, elapsedSeconds);
      } catch {
        // ignore
      }
      inner.onJobError?.(jobId, error);
    },
    onPaymentReceived(jobId, netAmount) {
      try {
        ctx.paymentsReceived.inc();
        if (Number.isFinite(netAmount) && netAmount >= 0) {
          ctx.paymentAmountLamports.observe(netAmount);
        }
      } catch {
        // ignore
      }
      inner.onPaymentReceived?.(jobId, netAmount);
    },
    onLog: inner.onLog,
    onStop: inner.onStop,
  };
}

const HEALTH_STATUSES = ['unknown', 'healthy', 'invalid', 'billing', 'unavailable'] as const;

/**
 * Periodically poll runtime + health-monitor state into the gauge metrics.
 * Returns a stop function (idempotent).
 */
export function startGaugePolling(
  ctx: MetricsContext,
  runtime: AgentRuntime,
  healthMonitor: LlmHealthMonitor | undefined,
  intervalMs = 1000,
): () => void {
  const tick = () => {
    try {
      ctx.jobsInFlight.set(runtime.getInFlightCount());
      ctx.jobsPending.set(runtime.getPendingCount());
      if (healthMonitor) {
        const snapshot = healthMonitor.snapshot();
        for (const entry of snapshot) {
          for (const status of HEALTH_STATUSES) {
            ctx.healthGate.set(
              { provider: entry.provider, model: entry.model, status },
              entry.status === status ? 1 : 0,
            );
          }
        }
      }
    } catch {
      // ignore - metrics polling must not crash the process
    }
  };
  tick();
  const handle = setInterval(tick, intervalMs);
  return () => clearInterval(handle);
}

export interface MetricsServer {
  url: string;
  close: () => Promise<void>;
}

/**
 * Start a tiny HTTP server exposing GET /metrics. Idempotent stop.
 */
export function serveMetrics(
  ctx: MetricsContext,
  port: number,
  hostname?: string,
): Promise<MetricsServer> {
  const host = hostname ?? process.env.ELISYM_METRICS_HOST ?? '127.0.0.1';
  const server: Server = createServer((req, res) => {
    if (!req.url || req.method !== 'GET') {
      res.statusCode = 404;
      res.end();
      return;
    }
    const path = req.url.split('?', 1)[0];
    if (path === '/metrics') {
      ctx.registry
        .metrics()
        .then((body) => {
          res.statusCode = 200;
          res.setHeader('Content-Type', ctx.registry.contentType);
          res.end(body);
        })
        .catch((err) => {
          res.statusCode = 500;
          res.setHeader('Content-Type', 'text/plain; charset=utf-8');
          res.end(`metrics export failed: ${err instanceof Error ? err.message : String(err)}`);
        });
      return;
    }
    if (path === '/healthz') {
      res.statusCode = 200;
      res.setHeader('Content-Type', 'text/plain; charset=utf-8');
      res.end('ok');
      return;
    }
    res.statusCode = 404;
    res.end();
  });

  return new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(port, host, () => {
      const url = `http://${host}:${port}/metrics`;
      resolve({
        url,
        close: () =>
          new Promise<void>((res) => {
            server.close(() => res());
          }),
      });
    });
  });
}

export function parseMetricsPort(raw: unknown): number | undefined {
  if (raw === undefined || raw === null || raw === '') {
    return undefined;
  }
  const parsed = Number.parseInt(String(raw), 10);
  if (!Number.isFinite(parsed) || parsed <= 0 || parsed > 65535) {
    throw new Error(`--metrics-port must be an integer 1..65535 (got ${String(raw)})`);
  }
  return parsed;
}
