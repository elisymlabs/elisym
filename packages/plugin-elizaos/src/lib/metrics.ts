/**
 * Tiny in-process metrics primitives. We deliberately avoid pulling in
 * `prom-client` (~150 KB) because the plugin only needs counters and a
 * single histogram for a handful of well-known event names.
 *
 * Output format follows Prometheus text exposition v0.0.4. Labels are
 * escaped per spec.
 */

type LabelMap = Record<string, string | number>;

interface CounterEntry {
  labels: LabelMap;
  value: number;
}

interface HistogramEntry {
  labels: LabelMap;
  buckets: number[];
  count: number;
  sum: number;
}

interface Counter {
  kind: 'counter';
  name: string;
  help: string;
  values: Map<string, CounterEntry>;
}

interface Histogram {
  kind: 'histogram';
  name: string;
  help: string;
  bucketUpperBounds: readonly number[];
  values: Map<string, HistogramEntry>;
}

const counters = new Map<string, Counter>();
const histograms = new Map<string, Histogram>();

function compareKeys(left: [string, unknown], right: [string, unknown]): number {
  if (left[0] < right[0]) {
    return -1;
  }
  if (left[0] > right[0]) {
    return 1;
  }
  return 0;
}

function labelKey(labels: LabelMap): string {
  const entries = Object.entries(labels).sort(compareKeys);
  return entries.map(([key, value]) => `${key}=${String(value)}`).join('|');
}

export function getCounter(name: string, help: string): Counter {
  const existing = counters.get(name);
  if (existing) {
    return existing;
  }
  const created: Counter = { kind: 'counter', name, help, values: new Map() };
  counters.set(name, created);
  return created;
}

export function incrementCounter(name: string, labels: LabelMap = {}, delta = 1): void {
  const counter = counters.get(name);
  if (!counter) {
    return;
  }
  const key = labelKey(labels);
  const existing = counter.values.get(key);
  if (existing) {
    existing.value += delta;
    return;
  }
  counter.values.set(key, { labels: { ...labels }, value: delta });
}

export function getHistogram(
  name: string,
  help: string,
  bucketUpperBounds: readonly number[],
): Histogram {
  const existing = histograms.get(name);
  if (existing) {
    return existing;
  }
  const created: Histogram = {
    kind: 'histogram',
    name,
    help,
    bucketUpperBounds,
    values: new Map(),
  };
  histograms.set(name, created);
  return created;
}

export function observeHistogram(name: string, value: number, labels: LabelMap = {}): void {
  const histogram = histograms.get(name);
  if (!histogram) {
    return;
  }
  const key = labelKey(labels);
  let entry = histogram.values.get(key);
  if (!entry) {
    entry = {
      labels: { ...labels },
      buckets: histogram.bucketUpperBounds.map(() => 0),
      count: 0,
      sum: 0,
    };
    histogram.values.set(key, entry);
  }
  entry.count += 1;
  entry.sum += value;
  for (let i = 0; i < histogram.bucketUpperBounds.length; i++) {
    if (value <= histogram.bucketUpperBounds[i]!) {
      entry.buckets[i]! += 1;
    }
  }
}

function escapeLabelValue(value: string | number): string {
  return String(value).replace(/\\/g, '\\\\').replace(/\n/g, '\\n').replace(/"/g, '\\"');
}

function formatLabels(labels: LabelMap): string {
  const entries = Object.entries(labels);
  if (entries.length === 0) {
    return '';
  }
  const formatted = entries.map(([key, value]) => `${key}="${escapeLabelValue(value)}"`).join(',');
  return `{${formatted}}`;
}

export function renderPrometheus(): string {
  const lines: string[] = [];
  for (const counter of counters.values()) {
    lines.push(`# HELP ${counter.name} ${counter.help}`);
    lines.push(`# TYPE ${counter.name} counter`);
    if (counter.values.size === 0) {
      lines.push(`${counter.name} 0`);
      continue;
    }
    for (const entry of counter.values.values()) {
      lines.push(`${counter.name}${formatLabels(entry.labels)} ${entry.value}`);
    }
  }
  for (const histogram of histograms.values()) {
    lines.push(`# HELP ${histogram.name} ${histogram.help}`);
    lines.push(`# TYPE ${histogram.name} histogram`);
    for (const entry of histogram.values.values()) {
      for (let i = 0; i < histogram.bucketUpperBounds.length; i++) {
        const bound = histogram.bucketUpperBounds[i]!;
        const labels = { ...entry.labels, le: bound.toString() };
        lines.push(`${histogram.name}_bucket${formatLabels(labels)} ${entry.buckets[i]}`);
      }
      const infLabels = { ...entry.labels, le: '+Inf' };
      lines.push(`${histogram.name}_bucket${formatLabels(infLabels)} ${entry.count}`);
      lines.push(`${histogram.name}_sum${formatLabels(entry.labels)} ${entry.sum}`);
      lines.push(`${histogram.name}_count${formatLabels(entry.labels)} ${entry.count}`);
    }
  }
  lines.push('');
  return lines.join('\n');
}

export function resetMetrics(): void {
  counters.clear();
  histograms.clear();
}

// --- Well-known counters / histograms ---

export const METRIC_JOBS_TOTAL = 'elisym_jobs_total';
export const METRIC_PAYMENT_LATENCY_SECONDS = 'elisym_payment_latency_seconds';
export const METRIC_RPC_ERRORS_TOTAL = 'elisym_rpc_errors_total';
export const METRIC_RELAY_POOL_RESET_TOTAL = 'elisym_relay_pool_reset_total';
export const METRIC_PING_PONG_ROUNDTRIP_MS = 'elisym_ping_pong_roundtrip_ms';

export function registerDefaultMetrics(): void {
  getCounter(METRIC_JOBS_TOTAL, 'Total elisym jobs by side and state');
  getCounter(METRIC_RPC_ERRORS_TOTAL, 'Total Solana RPC errors observed by the plugin');
  getCounter(METRIC_RELAY_POOL_RESET_TOTAL, 'Total times the watchdog reset the Nostr relay pool');
  getHistogram(
    METRIC_PAYMENT_LATENCY_SECONDS,
    'Time from payment build to confirmation in seconds',
    [0.5, 1, 2.5, 5, 10, 20, 60],
  );
  getHistogram(
    METRIC_PING_PONG_ROUNDTRIP_MS,
    'Ping/pong probe round-trip latency in milliseconds',
    [50, 100, 250, 500, 1000, 2500, 5000],
  );
}
