/**
 * Run a `.gitignore` migration ahead of a private write, and never let it fail
 * that write.
 *
 * The migration exists so an agent created by an older build gets the widened
 * entries before a random-suffixed temporary can exist. That is worth doing on
 * every write and worth nothing at all if it can stop the write: the customer
 * history is updated between a payment that has ALREADY been sent and the
 * confirmation that tells the provider about it, so an `EACCES` on a read-only
 * `.gitignore` there left the money on-chain and the provider scanning for it
 * by reference instead of being told. Before this branch that store ran no
 * migration, so the same directory simply worked.
 *
 * Warned, not thrown - the choice `writeSecrets` already makes for the keys
 * themselves, which are a worse thing to leave uncovered than a contact list.
 */
import { logger } from '../logger.js';

export async function migrateGitignoreBestEffort(
  store: string,
  migrate: () => Promise<void>,
): Promise<void> {
  try {
    await migrate();
  } catch (error) {
    logger.warn(
      {
        event: 'gitignore_migration_failed',
        store,
        err: error instanceof Error ? error.message : String(error),
      },
      'could not widen .gitignore before a private write; writing anyway',
    );
  }
}
