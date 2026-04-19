/**
 * Opt-in relay diagnostics. Resolves each relay hostname via DNS and
 * opens a TCP probe to the relay port. Activated by `ELISYM_NET_DIAG=1`
 * so operators can separately diagnose "WSS fails but everything else
 * looks fine" scenarios common on WSL, Docker, or corporate firewalls.
 *
 * Never called on a hot path - one-shot at startup.
 */
import { lookup } from 'node:dns/promises';
import { Socket } from 'node:net';
import type { Logger } from 'pino';

const TCP_PROBE_TIMEOUT_MS = 3_000;

export interface RelayProbeResult {
  url: string;
  host: string;
  port: number;
  ips: string[];
  tcpOpenMs?: number;
  error?: string;
}

function parseRelayUrl(url: string): { host: string; port: number } | null {
  try {
    const parsed = new URL(url);
    const isSecure = parsed.protocol === 'wss:' || parsed.protocol === 'https:';
    const defaultPort = isSecure ? 443 : 80;
    const port = parsed.port.length > 0 ? parseInt(parsed.port, 10) : defaultPort;
    if (!Number.isFinite(port)) {
      return null;
    }
    return { host: parsed.hostname, port };
  } catch {
    return null;
  }
}

async function tcpProbe(
  host: string,
  port: number,
  timeoutMs: number,
): Promise<{ openMs: number } | { error: string }> {
  return new Promise((resolve) => {
    const started = Date.now();
    const socket = new Socket();
    let settled = false;

    const finish = (result: { openMs: number } | { error: string }): void => {
      if (settled) {
        return;
      }
      settled = true;
      socket.destroy();
      resolve(result);
    };

    const timer = setTimeout(() => finish({ error: 'timeout' }), timeoutMs);

    socket.once('connect', () => {
      clearTimeout(timer);
      finish({ openMs: Date.now() - started });
    });
    socket.once('error', (err) => {
      clearTimeout(timer);
      finish({ error: err.message });
    });

    socket.connect(port, host);
  });
}

export async function probeRelays(
  relays: string[],
  logger: Logger,
  timeoutMs: number = TCP_PROBE_TIMEOUT_MS,
): Promise<RelayProbeResult[]> {
  const results: RelayProbeResult[] = [];
  for (const url of relays) {
    const parsed = parseRelayUrl(url);
    if (!parsed) {
      logger.debug({ event: 'net_diag_parse_failed', url }, 'unparseable relay URL');
      results.push({ url, host: '', port: 0, ips: [], error: 'invalid URL' });
      continue;
    }
    const { host, port } = parsed;
    let ips: string[] = [];
    try {
      const resolved = await lookup(host, { all: true });
      ips = resolved.map((entry) => entry.address);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      logger.debug(
        { event: 'net_diag_dns_failed', url, host, error: message },
        'DNS lookup failed',
      );
      results.push({ url, host, port, ips: [], error: `dns: ${message}` });
      continue;
    }

    const probe = await tcpProbe(host, port, timeoutMs);
    if ('openMs' in probe) {
      logger.debug(
        { event: 'net_diag_tcp_open', url, host, port, ips, tcpOpenMs: probe.openMs },
        'TCP open',
      );
      results.push({ url, host, port, ips, tcpOpenMs: probe.openMs });
    } else {
      logger.debug(
        { event: 'net_diag_tcp_failed', url, host, port, ips, error: probe.error },
        'TCP probe failed',
      );
      results.push({ url, host, port, ips, error: `tcp: ${probe.error}` });
    }
  }
  return results;
}
