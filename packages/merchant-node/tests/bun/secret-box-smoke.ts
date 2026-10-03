/**
 * The Docker image runs the node under Bun, the unit tests under Node: this
 * checks that Bun's scrypt (N=2^17, the sdk's maxmem) and AES-GCM open a value
 * `@elisym/sdk` sealed. A plain script (no `bun:test`), run by `test:bun`.
 */
import { decryptSecret } from '../../src/secret-box';

const SDK_VECTOR =
  'encrypted:v1:khaJXctOhVsFGD4jI7WfaPqIM/YHYN7wtJvoGpOoh9Ye+vFMAMyi1bgkgFceYv9EKQsdncRG+POnDP45eMIOfD7yiDvYv/zorC509507mT3Dug==';
const EXPECTED = 'elisym merchant-node secret-box vector';

const opened = decryptSecret(SDK_VECTOR, 'correct horse battery staple');
if (opened !== EXPECTED) {
  console.error(`secret-box under Bun: expected "${EXPECTED}", got "${opened}"`);
  process.exit(1);
}
console.log('secret-box under Bun: ok');
