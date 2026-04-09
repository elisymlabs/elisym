import { describe, it, expect, vi, afterEach } from 'vitest';
import { formatSol, timeAgo, truncateKey } from '../src/primitives/format';

describe('formatSol', () => {
  it('formats zero', () => {
    expect(formatSol(0)).toBe('0 SOL');
  });

  it('formats 1 lamport', () => {
    expect(formatSol(1)).toBe('0.000000001 SOL');
  });

  it('formats sub-SOL amounts', () => {
    expect(formatSol(100_000_000)).toBe('0.1 SOL');
    expect(formatSol(500_000_000)).toBe('0.5 SOL');
    expect(formatSol(140_000_000)).toBe('0.14 SOL');
  });

  it('formats 1 SOL', () => {
    expect(formatSol(1_000_000_000)).toBe('1 SOL');
  });

  it('formats with k suffix', () => {
    expect(formatSol(10_000_000_000_000)).toBe('10k SOL');
    expect(formatSol(50_000_000_000_000)).toBe('50k SOL');
  });

  it('formats with m suffix', () => {
    expect(formatSol(1_000_000_000_000_000)).toBe('1m SOL');
  });

  it('trims trailing zeros', () => {
    expect(formatSol(100_000_000)).toBe('0.1 SOL');
    expect(formatSol(10_000_000)).toBe('0.01 SOL');
  });
});

describe('timeAgo', () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it('shows seconds', () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-01-01T00:00:30Z'));
    const unix = Math.floor(new Date('2026-01-01T00:00:00Z').getTime() / 1000);
    expect(timeAgo(unix)).toBe('30s ago');
  });

  it('shows minutes', () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-01-01T00:05:00Z'));
    const unix = Math.floor(new Date('2026-01-01T00:00:00Z').getTime() / 1000);
    expect(timeAgo(unix)).toBe('5m ago');
  });

  it('shows hours', () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-01-01T03:00:00Z'));
    const unix = Math.floor(new Date('2026-01-01T00:00:00Z').getTime() / 1000);
    expect(timeAgo(unix)).toBe('3h ago');
  });

  it('shows days', () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-01-03T00:00:00Z'));
    const unix = Math.floor(new Date('2026-01-01T00:00:00Z').getTime() / 1000);
    expect(timeAgo(unix)).toBe('2d ago');
  });

  it('clamps negative to 0s', () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-01-01T00:00:00Z'));
    const futureUnix = Math.floor(new Date('2026-01-01T00:01:00Z').getTime() / 1000);
    expect(timeAgo(futureUnix)).toBe('0s ago');
  });
});

describe('truncateKey', () => {
  it('does not truncate short keys', () => {
    expect(truncateKey('abcdef')).toBe('abcdef');
    expect(truncateKey('abcdefabcdef')).toBe('abcdefabcdef');
  });

  it('truncates long keys', () => {
    const hex = 'a'.repeat(64);
    expect(truncateKey(hex)).toBe('aaaaaa...aaaaaa');
  });

  it('respects custom char count', () => {
    const hex = 'a'.repeat(64);
    expect(truncateKey(hex, 4)).toBe('aaaa...aaaa');
  });
});
