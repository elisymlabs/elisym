import { DEFAULT_FETCH_MAX_BYTES } from '../constants';

export class SsrfError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'SsrfError';
  }
}

export class PayloadTooLargeError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'PayloadTooLargeError';
  }
}

export interface SafeFetchOptions {
  maxBytes?: number;
  timeoutMs?: number;
  allowedHosts?: readonly string[];
}

function isBlockedIpv4(octets: readonly number[]): boolean {
  const [a, b, c, d] = octets;
  if (a === undefined || b === undefined || c === undefined || d === undefined) {
    return true;
  }
  if (a === 10) {
    return true;
  }
  if (a === 127) {
    return true;
  }
  if (a === 172 && b >= 16 && b <= 31) {
    return true;
  }
  if (a === 192 && b === 168) {
    return true;
  }
  if (a === 169 && b === 254) {
    return true;
  }
  if (a === 0) {
    return true;
  }
  if (a >= 224) {
    return true;
  }
  return false;
}

function parseIpv4(hostname: string): number[] | null {
  const parts = hostname.split('.');
  if (parts.length !== 4) {
    return null;
  }
  const octets: number[] = [];
  for (const part of parts) {
    if (!/^\d+$/.test(part)) {
      return null;
    }
    const value = Number(part);
    if (!Number.isInteger(value) || value < 0 || value > 255) {
      return null;
    }
    octets.push(value);
  }
  return octets;
}

function isBlockedIpv6(hostname: string): boolean {
  const normalized = hostname.toLowerCase().replace(/^\[|\]$/g, '');
  if (
    normalized === '::1' ||
    normalized === '::' ||
    normalized.startsWith('fc') ||
    normalized.startsWith('fd')
  ) {
    return true;
  }
  if (normalized.startsWith('fe80')) {
    return true;
  }
  // URL parsing normalizes `::ffff:127.0.0.1` to `::ffff:7f00:1`, so match the prefix too.
  if (normalized.startsWith('::ffff:')) {
    return true;
  }
  const mappedMatch = /^::ffff:([0-9.]+)$/.exec(normalized);
  if (mappedMatch) {
    const v4 = parseIpv4(mappedMatch[1] ?? '');
    if (!v4) {
      return true;
    }
    return isBlockedIpv4(v4);
  }
  return false;
}

export function assertHostAllowed(urlText: string, allowedHosts?: readonly string[]): void {
  const url = new URL(urlText);
  if (url.protocol !== 'http:' && url.protocol !== 'https:') {
    throw new SsrfError(`Unsupported protocol: ${url.protocol}`);
  }
  const host = url.hostname.toLowerCase();
  if (host === 'localhost') {
    throw new SsrfError('Localhost is not allowed');
  }
  const ipv4 = parseIpv4(host);
  if (ipv4 && isBlockedIpv4(ipv4)) {
    throw new SsrfError(`Blocked IPv4 address: ${host}`);
  }
  if (host.includes(':') && isBlockedIpv6(host)) {
    throw new SsrfError(`Blocked IPv6 address: ${host}`);
  }
  if (allowedHosts && allowedHosts.length > 0 && !allowedHosts.includes(host)) {
    throw new SsrfError(`Host ${host} is not in the allowlist`);
  }
}

export async function safeFetchText(url: string, options: SafeFetchOptions = {}): Promise<string> {
  assertHostAllowed(url, options.allowedHosts);
  const maxBytes = options.maxBytes ?? DEFAULT_FETCH_MAX_BYTES;
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), options.timeoutMs ?? 15_000);

  try {
    const response = await fetch(url, { redirect: 'error', signal: controller.signal });
    if (!response.ok) {
      throw new SsrfError(`Upstream responded with ${response.status}`);
    }
    const body = response.body;
    if (!body) {
      return '';
    }
    const reader = body.getReader();
    const decoder = new TextDecoder();
    let received = 0;
    let text = '';
    for (;;) {
      const { value, done } = await reader.read();
      if (done) {
        break;
      }
      received += value.byteLength;
      if (received > maxBytes) {
        await reader.cancel();
        throw new PayloadTooLargeError(`Response exceeded ${maxBytes} bytes`);
      }
      text += decoder.decode(value, { stream: true });
    }
    text += decoder.decode();
    return text;
  } finally {
    clearTimeout(timeout);
  }
}
