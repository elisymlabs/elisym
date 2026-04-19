import { afterEach, describe, expect, it } from 'vitest';
import {
  getCounter,
  getHistogram,
  incrementCounter,
  observeHistogram,
  registerDefaultMetrics,
  renderPrometheus,
  resetMetrics,
  METRIC_JOBS_TOTAL,
  METRIC_PAYMENT_LATENCY_SECONDS,
  METRIC_RPC_ERRORS_TOTAL,
} from '../../src/lib/metrics';

afterEach(() => {
  resetMetrics();
});

describe('metrics primitives', () => {
  it('emits zero-valued counter when no observations have been made', () => {
    getCounter('elisym_test_counter', 'help text');
    const output = renderPrometheus();
    expect(output).toContain('# HELP elisym_test_counter help text');
    expect(output).toContain('# TYPE elisym_test_counter counter');
    expect(output).toContain('elisym_test_counter 0');
  });

  it('aggregates increments by sorted label set', () => {
    getCounter('elisym_test_counter', 'help');
    incrementCounter('elisym_test_counter', { side: 'provider', state: 'paid' });
    incrementCounter('elisym_test_counter', { state: 'paid', side: 'provider' });
    incrementCounter('elisym_test_counter', { side: 'customer', state: 'failed' });
    const output = renderPrometheus();
    expect(output).toContain('elisym_test_counter{side="provider",state="paid"} 2');
    expect(output).toContain('elisym_test_counter{side="customer",state="failed"} 1');
  });

  it('escapes special characters in label values', () => {
    getCounter('elisym_test_counter', 'help');
    incrementCounter('elisym_test_counter', { reason: 'a "quoted"\nvalue' });
    const output = renderPrometheus();
    expect(output).toContain('reason="a \\"quoted\\"\\nvalue"');
  });

  it('writes histogram bucket / sum / count rows', () => {
    getHistogram('elisym_test_hist', 'help', [1, 5, 10]);
    observeHistogram('elisym_test_hist', 0.5);
    observeHistogram('elisym_test_hist', 4);
    observeHistogram('elisym_test_hist', 12);
    const output = renderPrometheus();
    expect(output).toContain('elisym_test_hist_bucket{le="1"} 1');
    expect(output).toContain('elisym_test_hist_bucket{le="5"} 2');
    expect(output).toContain('elisym_test_hist_bucket{le="10"} 2');
    expect(output).toContain('elisym_test_hist_bucket{le="+Inf"} 3');
    expect(output).toContain('elisym_test_hist_sum 16.5');
    expect(output).toContain('elisym_test_hist_count 3');
  });

  it('registerDefaultMetrics declares the well-known elisym counters', () => {
    registerDefaultMetrics();
    const output = renderPrometheus();
    expect(output).toContain(METRIC_JOBS_TOTAL);
    expect(output).toContain(METRIC_PAYMENT_LATENCY_SECONDS);
    expect(output).toContain(METRIC_RPC_ERRORS_TOTAL);
  });

  it('does not increment unknown counter names', () => {
    incrementCounter('does_not_exist', { foo: 'bar' });
    expect(renderPrometheus()).not.toContain('does_not_exist');
  });
});
