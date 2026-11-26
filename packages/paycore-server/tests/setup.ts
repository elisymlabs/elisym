import { afterEach } from 'vitest';
import { closeOpenClones } from './pglite-db';

afterEach(async () => {
  await closeOpenClones();
});
