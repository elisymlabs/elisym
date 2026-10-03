import { afterEach } from 'vitest';

// Sealing keys runs scrypt synchronously for seconds at a time. A file of such
// tests never gives the worker's event loop a turn, so on a slow runner the
// worker's own report to vitest times out (60 s) though every test passes.
// One turn after each test lets that report through.
afterEach(() => new Promise<void>((resolve) => setImmediate(resolve)));
