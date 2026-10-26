// Checks the row level security policies from the roles that actually matter —
// anon, and a signed-in user — rather than from the owner account, which
// bypasses every policy. "It works in the SQL editor" is the most common false
// positive in Supabase support, and this is how you avoid it.
//
//   node --env-file=.env scripts/rls-report.mjs
//
// Everything runs inside a transaction that is rolled back, including the two
// users and two notes it creates to make the privacy test meaningful: with no
// notes in the table, "anon sees 0 notes" passes without proving anything.

import pg from 'pg';

const client = new pg.Client({
  connectionString: process.env.DATABASE_URL,
  ssl: { rejectUnauthorized: false },
});

const results = [];
const check = (label, value, ok, note) => {
  results.push({ label, value, ok, note });
};

await client.connect();
await client.query('begin');
await client.query('set search_path = public');

const one = async (sql, params) => (await client.query(sql, params)).rows[0];

/** Act as PostgREST does for a request carrying (or not carrying) a JWT. */
async function asRole(role, userId = null) {
  await client.query('reset role');
  await client.query(
    userId
      ? `set local request.jwt.claims = '${JSON.stringify({ sub: userId, role })}'`
      : `set local request.jwt.claims = ''`,
  );
  await client.query(`set local role ${role}`);
}

// --- baseline, as the owner --------------------------------------------------

const ownerIssues = (await one('select count(*)::int as n from issue_queue')).n;

// --- two engineers, one note each -------------------------------------------

let notesTested = false;
let ada = null;
let grace = null;
// A failed statement poisons the whole transaction, so anything that might
// fail — or is meant to — runs inside a savepoint we can roll back to.
await client.query('savepoint seed');
try {
  ada = (
    await one(
      `insert into auth.users (id, email) values (gen_random_uuid(), 'ada@example.invalid')
       returning id`,
    )
  ).id;
  grace = (
    await one(
      `insert into auth.users (id, email) values (gen_random_uuid(), 'grace@example.invalid')
       returning id`,
    )
  ).id;

  const issue = (await one('select id from issues limit 1')).id;
  await client.query(
    `insert into triage_notes (issue_id, triaged_by, category, severity, note) values
       ($1, $2, 'bug',    'high',   'ada looked at this'),
       ($1, $3, 'how-to', 'normal', 'grace looked at this')`,
    [issue, ada, grace],
  );
  notesTested = true;
} catch (error) {
  await client.query('rollback to savepoint seed');
  console.log(`(could not seed auth.users, so the notes test is skipped: ${error.message})`);
}

// --- what each role can see --------------------------------------------------

await asRole('anon');
const anonIssues = (await one('select count(*)::int as n from issue_queue')).n;
const anonLabels = (await one('select count(*)::int as n from labels')).n;
const anonSearch = (await one("select count(*)::int as n from search_issues('auth', false, 25)")).n;
const anonNotes = (await one('select count(*)::int as n from triage_notes')).n;

check('anon: issues in queue', anonIssues, anonIssues === ownerIssues, `owner sees ${ownerIssues}`);
check('anon: labels readable', anonLabels, anonLabels > 0, 'public read policy');
check('anon: search hits', anonSearch, anonSearch > 0, 'security invoker function');
check('anon: triage notes', anonNotes, anonNotes === 0, notesTested ? '2 exist, 0 visible' : 'none exist');

if (notesTested) {
  await asRole('authenticated', ada);
  const adaNotes = await client.query('select note from triage_notes');
  check(
    'ada: triage notes',
    adaNotes.rowCount,
    adaNotes.rowCount === 1 && adaNotes.rows[0].note.startsWith('ada'),
    'sees only her own of 2',
  );

  await asRole('authenticated', grace);
  const graceNotes = await client.query('select note from triage_notes');
  check(
    'grace: triage notes',
    graceNotes.rowCount,
    graceNotes.rowCount === 1 && graceNotes.rows[0].note.startsWith('grace'),
    'sees only her own of 2',
  );

  // A signed-in user must not be able to write a note attributed to someone else.
  await asRole('authenticated', ada);
  const targetIssue = (await one('select id from issues limit 1')).id;
  let blocked = false;
  await client.query('savepoint impersonation');
  try {
    await client.query(
      `insert into triage_notes (issue_id, triaged_by, category, severity)
       values ($1, $2, 'bug', 'low')`,
      [targetIssue, grace],
    );
  } catch (error) {
    // 42501 is what a violated WITH CHECK clause raises.
    blocked = error.code === '42501';
  }
  await client.query('rollback to savepoint impersonation');
  check('ada: writing as grace', blocked ? 'blocked' : 'ALLOWED', blocked, 'with check clause');
}

await client.query('reset role');
const sample = await client.query(`
  select number, left(title, 56) as title, author_login,
         round(age_hours / 24, 1) as age_days, coalesce(array_length(label_names, 1), 0) as labels
  from issue_queue
  where state = 'open'
  order by created_at desc
  limit 5
`);

await client.query('rollback');
await client.end();

console.log('\nRow level security, by role:\n');
for (const r of results) {
  console.log(
    `  ${r.ok ? 'PASS' : 'FAIL'}  ${r.label.padEnd(26)} ${String(r.value).padStart(7)}   ${r.note}`,
  );
}

console.log('\nTop of the live queue:\n');
for (const r of sample.rows) {
  console.log(
    `  #${String(r.number).padEnd(6)} ${String(r.age_days).padStart(5)}d  ` +
      `${(r.author_login ?? '?').padEnd(16)} ${r.labels} labels  ${r.title}`,
  );
}

const failed = results.filter((r) => !r.ok).length;
console.log(failed === 0 ? '\nAll policy checks passed.\n' : `\n${failed} check(s) FAILED.\n`);
process.exitCode = failed === 0 ? 0 : 1;
