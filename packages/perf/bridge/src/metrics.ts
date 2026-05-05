/**
 * Bridge-side prom-client metrics. Scraped by the perf-stack Prometheus.
 */
import { Counter, Histogram, Registry, collectDefaultMetrics } from 'prom-client';

const NAMESPACE = 'elisym_bridge';

export interface BridgeMetrics {
  registry: Registry;
  callsTotal: Counter<'route' | 'outcome'>;
  callDuration: Histogram<'route'>;
}

export function createBridgeMetrics(): BridgeMetrics {
  const registry = new Registry();
  registry.setDefaultLabels({ service: 'elisym-perf-bridge' });
  collectDefaultMetrics({ register: registry, prefix: `${NAMESPACE}_process_` });

  const callsTotal = new Counter({
    name: `${NAMESPACE}_calls_total`,
    help: 'Bridge HTTP calls by route and outcome (ok|error).',
    labelNames: ['route', 'outcome'],
    registers: [registry],
  });

  const callDuration = new Histogram({
    name: `${NAMESPACE}_call_duration_seconds`,
    help: 'Wall-clock seconds per bridge HTTP call.',
    labelNames: ['route'],
    buckets: [0.005, 0.01, 0.025, 0.05, 0.1, 0.25, 0.5, 1, 2, 5, 10, 30],
    registers: [registry],
  });

  return { registry, callsTotal, callDuration };
}
