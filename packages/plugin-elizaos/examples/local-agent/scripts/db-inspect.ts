import { existsSync } from 'node:fs';
import { resolve } from 'node:path';
import { PGlite } from '@electric-sql/pglite';

const dbPath = resolve(process.cwd(), '.eliza/.elizadb');
if (!existsSync(dbPath)) {
  console.error(`No ElizaOS DB at ${dbPath}. Start the agent once to create it.`);
  process.exit(1);
}

const db = new PGlite(dbPath);
const result = await db.query<{
  type: string;
  secret: string;
  created_at: string;
}>(
  `SELECT type, content->>'secret' AS secret, "createdAt" AS created_at
     FROM memories
    WHERE type IN ('elisym_identity', 'elisym_wallet')
    ORDER BY type, "createdAt"`,
);
if (result.rows.length === 0) {
  console.log('(no elisym_* memories)');
} else {
  for (const row of result.rows) {
    console.log(`${row.type.padEnd(20)} ${row.created_at}  ${row.secret}`);
  }
}
await db.close();
