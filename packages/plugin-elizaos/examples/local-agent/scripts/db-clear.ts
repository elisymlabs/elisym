import { existsSync } from 'node:fs';
import { resolve } from 'node:path';
import { PGlite } from '@electric-sql/pglite';

const dbPath = resolve(process.cwd(), '.eliza/.elizadb');
if (!existsSync(dbPath)) {
  console.log(`Nothing to clear - no DB at ${dbPath}.`);
  process.exit(0);
}

const db = new PGlite(dbPath);
const result = await db.query(
  `DELETE FROM memories WHERE type IN ('elisym_identity', 'elisym_wallet') RETURNING type`,
);
console.log(`Deleted ${result.affectedRows ?? result.rows.length} elisym_* memory rows.`);
await db.close();
