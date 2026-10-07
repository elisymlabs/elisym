/**
 * The Docker image runs the node under Bun: this checks that `signWebhook` on
 * Bun's WebCrypto gives the same bytes as `node:crypto` `createHmac` (the golden
 * vectors), and that `verifyWebhook` accepts what it signs. A plain script (no
 * `bun:test`), run by `test:bun`.
 */
import { createHmac } from 'node:crypto';
import { signWebhook, verifyWebhook } from '@elisym/commerce/webhook';

const TIMESTAMP = 1_791_100_000;
const VECTORS = [
  {
    secret: 'x'.repeat(32),
    body: '{"a":1}',
    expected: 'v1=3c8a1c2fe10d3b2f9f419de45b1a81e4ef90265bcf45dd734dc99989fde5ac99',
  },
  {
    secret: 'é'.repeat(16),
    body: '{"note":"€ 🎉 \uD800"}',
    expected: 'v1=c48a492c1e01c179c02f25597d1011fa2cad17e38e94994ccd2927d985bccbc3',
  },
];
const TEST_BODY = JSON.stringify({ event: 'test', eventId: 'c'.repeat(64), store: 'a'.repeat(64) });

for (const { secret, body, expected } of VECTORS) {
  const signed = await signWebhook({ secret, timestamp: TIMESTAMP, body });
  const oracle = `v1=${createHmac('sha256', Buffer.from(secret, 'utf8')).update(`${TIMESTAMP}.${body}`, 'utf8').digest('hex')}`;
  if (signed !== expected || oracle !== expected) {
    console.error(
      `webhook signature under Bun: expected ${expected}, got ${signed} (createHmac ${oracle})`,
    );
    process.exit(1);
  }
  const testSignature = await signWebhook({ secret, timestamp: TIMESTAMP, body: TEST_BODY });
  const result = await verifyWebhook({
    secret,
    body: TEST_BODY,
    headers: { 'x-elisym-signature': testSignature, 'x-elisym-timestamp': String(TIMESTAMP) },
    now: TIMESTAMP,
  });
  if (!result.ok) {
    console.error(`webhook verify under Bun: expected ok, got ${result.reason}`);
    process.exit(1);
  }
}
console.log('webhook sign and verify under Bun: ok');
