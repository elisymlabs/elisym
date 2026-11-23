/**
 * The PayCore server's entry: with no arguments it serves (`startServer`;
 * the boot order and the shutdown are in `server.ts`); with a subcommand it
 * runs the operator CLI (`cli.ts`) on the same database and exits with its code.
 *
 * Shutdown order (SIGTERM / SIGINT), each awaited before the next:
 * 1. `pump.stop()` - no new round; the round in progress and the drains the
 *    rounds started are done.
 * 2. `holder.idle()` - every kicked drain, suspension round and offer check
 *    still running is done (control tasks on the stores' queues).
 * 3. `supervisor.shutdown()` - every node stopped, the leases released.
 * The supervisor last: a drain or a tick still running after it would find
 * its stores gone (`NotServed`) halfway through a request. Before them HTTP
 * stops accepting and the lease loop stops (a round in progress is awaited);
 * after them the relay pools and the database close.
 */
import { migratesFirst, runCli } from './cli';
import { configFromEnv } from './config';
import { KeyVault } from './db/keys';
import { migrate } from './db/migrations';
import { createPgDb } from './db/pg';
import { newestOnRelays } from './relay/newest';
import { startServer } from './server';

function log(message: string): void {
  console.error(message);
}

async function main(argv: readonly string[]): Promise<number> {
  // Checked before anything starts: a bad setting stops the process here.
  const config = configFromEnv(process.env);
  if (argv.length === 0) {
    const server = await startServer(config, { log });
    await server.stopped;
    return 0;
  }
  const db = createPgDb(config.databaseUrl, log);
  try {
    if (migratesFirst(argv)) {
      await migrate(db);
    }
    return await runCli(argv, {
      db,
      vault: new KeyVault(config.masterKeyHex),
      config,
      stdout: (text) => console.log(text),
      stderr: log,
      readRelays: newestOnRelays,
      env: process.env,
    });
  } finally {
    await db.close();
  }
}

main(process.argv.slice(2)).then(
  (code) => process.exit(code),
  (error: unknown) => {
    log(error instanceof Error ? error.message : String(error));
    process.exit(1);
  },
);
