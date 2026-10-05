/**
 * The Docker image runs the node under Bun, whose fetch quotes the full URL in
 * a refused redirect's error: this checks that the reason kept in the ledger
 * and logged holds no part of a token in the webhook URL. A plain script (no
 * `bun:test`), run by `test:bun`.
 */
import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import { sendWebhook } from '../../src/webhook';

const server = createServer((_request, response) => {
  response.writeHead(302, { Location: '/elsewhere' }).end();
});
await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
const { port } = server.address() as AddressInfo;
try {
  const result = await sendWebhook(
    { url: `http://127.0.0.1:${port}/hook?token=TOPSECRET`, secret: 'x'.repeat(32) },
    { name: 'test', eventId: 'e', body: '{}' },
    { now: () => 1_791_100_000, userAgent: 'smoke' },
  );
  if (result.ok || result.error !== 'redirect refused') {
    console.error(
      `webhook redirect under Bun: expected "redirect refused", got ${JSON.stringify(result)}`,
    );
    process.exit(1);
  }
  console.log('webhook redirect under Bun: ok');
} finally {
  server.close();
}
