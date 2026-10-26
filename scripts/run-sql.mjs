#!/usr/bin/env node
// Runs .sql files against DATABASE_URL and reports what the server said.
//
//   node --env-file=.env scripts/run-sql.mjs supabase/migrations/0001_schema.sql
//   node --env-file=.env scripts/run-sql.mjs --dry-run drills/00_seed.sql
//
// Each file is sent as a single simple query, which is what psql -f does: the
// files contain dollar-quoted function bodies, and splitting on ';' would cut
// through them. The trade-off is that one syntax error fails the whole file, so
// when the server reports an error position we map it back to a line and column
// and print the offending line.

import { readFile } from 'node:fs/promises';
import { basename } from 'node:path';
import pg from 'pg';

function parseArgs(argv) {
  const args = { files: [], dryRun: false, quiet: false };
  for (const arg of argv) {
    if (arg === '--dry-run') args.dryRun = true;
    else if (arg === '--quiet') args.quiet = true;
    else if (arg === '--help' || arg === '-h') args.help = true;
    else if (arg.startsWith('-')) throw new Error(`unknown flag: ${arg}`);
    else args.files.push(arg);
  }
  return args;
}

const USAGE = `
Usage: node --env-file=.env scripts/run-sql.mjs [options] <file.sql...>

  --dry-run   run inside a transaction and roll back, so nothing is kept
  --quiet     only report failures and row counts, not per-statement results

Environment:
  DATABASE_URL   postgres://... (Supabase: Project settings -> Database ->
                 Connection string -> Session pooler)
`;

/** Turn a 1-based character offset into something a human can navigate to. */
function locate(sql, position) {
  const offset = Number(position);
  if (!Number.isFinite(offset) || offset < 1) return null;

  const before = sql.slice(0, offset - 1);
  const line = before.split('\n').length;
  const column = offset - (before.lastIndexOf('\n') + 1);
  const text = sql.split('\n')[line - 1] ?? '';
  return { line, column, text };
}

function describe(result) {
  if (!result) return 'no result';
  if (result.command === 'SELECT' || result.rows?.length) {
    return `${result.command ?? 'SELECT'} — ${result.rowCount} row(s)`;
  }
  if (typeof result.rowCount === 'number' && result.rowCount > 0) {
    return `${result.command} ${result.rowCount}`;
  }
  return result.command ?? 'ok';
}

/** Print the first few rows of the last SELECT, which is usually a sanity check. */
function printSample(results) {
  const selects = results.filter((r) => r?.rows?.length);
  const last = selects[selects.length - 1];
  if (!last) return;
  console.log(`    last result: ${JSON.stringify(last.rows.slice(0, 3))}`);
}

async function runFile(client, file, { dryRun, quiet }) {
  const sql = await readFile(file, 'utf8');
  const label = basename(file);

  console.log(`\n▶ ${label} (${sql.split('\n').length} lines)`);

  if (dryRun) await client.query('begin');

  try {
    const raw = await client.query(sql);
    const results = Array.isArray(raw) ? raw : [raw];

    if (!quiet) {
      for (const result of results) console.log(`    ${describe(result)}`);
    }
    printSample(results);
    console.log(`  ✓ ${label}: ${results.length} statement(s) ran`);

    if (dryRun) {
      await client.query('rollback');
      console.log('  (rolled back — dry run)');
    }
    return true;
  } catch (error) {
    // A failed statement aborts the surrounding transaction; clear it so the
    // next file still gets a usable session.
    await client.query('rollback').catch(() => {});

    console.error(`  ✗ ${label}: ${error.message}`);
    if (error.detail) console.error(`    detail: ${error.detail}`);
    if (error.hint) console.error(`    hint:   ${error.hint}`);

    const where = locate(sql, error.position);
    if (where) {
      console.error(`    at ${file}:${where.line}:${where.column}`);
      console.error(`    > ${where.text.trim()}`);
    } else if (error.where) {
      console.error(`    context: ${error.where.split('\n')[0]}`);
    }
    return false;
  }
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  if (args.help || args.files.length === 0) {
    console.log(USAGE.trim());
    return;
  }

  const connectionString = process.env.DATABASE_URL;
  if (!connectionString) {
    throw new Error('DATABASE_URL is not set. Add it to .env (see .env.example).');
  }

  const client = new pg.Client({
    connectionString,
    // Supabase terminates TLS at the pooler with its own CA. Verifying it
    // properly means downloading that CA and pointing PGSSLROOTCERT at it;
    // for a one-off schema verification run this is enough.
    ssl: { rejectUnauthorized: false },
    statement_timeout: 120_000,
  });

  client.on('notice', (notice) => console.log(`    NOTICE: ${notice.message}`));

  await client.connect();

  const { rows } = await client.query(
    'select current_database() as db, current_user as role, version() as version',
  );
  const info = rows[0];
  console.log(
    `Connected to ${info.db} as ${info.role}\n${info.version.split(',')[0]}`,
  );

  let failures = 0;
  for (const file of args.files) {
    const ok = await runFile(client, file, args);
    if (!ok) failures += 1;
  }

  await client.end();

  console.log(
    failures === 0
      ? `\nAll ${args.files.length} file(s) ran clean.`
      : `\n${failures} of ${args.files.length} file(s) failed.`,
  );
  if (failures > 0) process.exitCode = 1;
}

main().catch((error) => {
  console.error(`\n${error.message}`);
  process.exitCode = 1;
});
