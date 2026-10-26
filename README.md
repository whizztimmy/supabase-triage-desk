# Triage Desk

**Live demo — [supabase-triage-desk-hhsu.vercel.app](https://supabase-triage-desk-hhsu.vercel.app)**
The queue, the filters and the prior-art search are readable without an
account; signing in with a magic link is only needed to write a triage note.

A support engineer's working tool, built on Supabase. It mirrors a public
repository's GitHub issues into Postgres, then puts a queue in front of them:
what is open, what nobody has answered yet, what has been waiting too long, and
whether the thing in front of you has already been reported.

I built it because the hardest part of developer support isn't answering the
question — it's knowing which of two hundred open threads to answer first, and
finding the one from four months ago that already has the answer.

## What it does

**A triage queue.** Every open issue with its age, labels, reporter, activity,
and whether anyone has triaged it. Anything open, untouched and older than 48
hours is flagged, because that's the row that turns into a complaint.

**Prior-art search.** Ranked full-text search over every mirrored title and body,
with highlighted snippets. This is the "has anyone reported this before?"
question, which is the one a support engineer asks most and the one a plain
`ILIKE` filter answers slowest.

**Triage notes.** Categorise an issue (bug, how-to, docs gap, needs repro,
upstream Postgres…), set a severity, leave a note. Notes are private per
engineer, enforced by row level security rather than by the client.

**Queue analytics.** Time to first triage as a distribution rather than an
average, label volume week over week, repeat reporters whose issues never get
closed, and issues triaged as a docs gap that nobody labelled as one — each row
there is a documentation page that should exist.

## How it's put together

```
ingest/fetch-issues.mjs     GitHub REST -> Postgres. Incremental: it reads the
                            newest updated_at it already has and passes that to
                            GitHub as `since`, so a re-run costs one page.

supabase/migrations/        Schema, indexes, views, RLS policies, and a ranked
                            search function.

supabase/queries/           The analytical queries, as a file you can read —
                            the questions, not just the answers.

web/                        React + TypeScript + Vite dashboard on supabase-js.

drills/                     A PostgreSQL practice set (see below).
```

Three decisions worth pointing at:

- **GitHub's own issue id is the primary key**, so re-ingesting is an upsert
  rather than a pile of duplicates.
- **The queue is a view, not a client-side join.** `issue_queue` assembles labels,
  the latest triage note and the row's age in one place, so the dashboard makes
  one request instead of N+1 label lookups. It's declared
  `security_invoker = true`, so RLS still applies to whoever is asking.
- **A partial index** (`where state = 'open' and is_pull_request = false`) serves
  the default view, because that's the query the dashboard runs every time and
  it's a fraction of the table.

## Running it

You need a Supabase project (the free tier is enough) and Node 20.6+.

**1. Create the schema.** Either paste `supabase/migrations/0001_schema.sql`
and then `0002_search.sql` into the Supabase SQL editor, or set `DATABASE_URL`
in `.env` (Project settings -> Database -> Connection string -> **Session
pooler**, port 5432) and run them from here:

```bash
npm install
npm run db:migrate     # 0001 then 0002
npm run db:reset       # drop everything first, then re-run both
```

`scripts/run-sql.mjs` sends each file as a single simple query, the way `psql -f`
does, because the files contain dollar-quoted function bodies that splitting on
`;` would cut through. When the server rejects something it maps the error
position back to `file:line:column` and prints the offending line.

**2. Fill in the ingest credentials.**

```bash
cp .env.example .env   # SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY, GITHUB_TOKEN
npm install
```

The service role key bypasses RLS, which is what you want for a server-side
writer and never what you want in a browser. `GITHUB_TOKEN` is optional but
raises the rate limit from 60 requests an hour to 5,000.

**3. Mirror some issues.**

```bash
npm run ingest -- --repo supabase/supabase --max-pages 5
```

Re-run it any time; it picks up where it left off. `npm run ingest:full` walks
from the beginning.

**4. Start the dashboard.**

```bash
cd web
cp .env.example .env   # VITE_SUPABASE_URL, VITE_SUPABASE_ANON_KEY
npm install
npm run dev
```

Reading the queue needs no account. Writing a triage note does — sign in with a
magic link, because RLS ties every note to the engineer who wrote it.

**5. Try the analytics.** Paste anything from
`supabase/queries/triage_queries.sql` into the SQL editor.

## Deploying the dashboard

`web/` builds to a static bundle — no server, no API routes, no service role key
in the browser — so any static host will serve it. `vercel.json` has the build
wired up, so there is nothing to configure in the dashboard:

```bash
npx vercel          # or import the repo at vercel.com/new
```

Leave **Root Directory** empty when importing. `vercel.json` lives at the
repository root and its paths resolve from there; setting the root to `web`
makes `--prefix web` resolve to `web/web` and the install fails.

It installs and builds inside `web/` and publishes `web/dist`. Note that
`web/package.json` runs `tsc --noEmit` before `vite build`, so a type error
fails the deploy rather than shipping a broken bundle.

Set the two client variables in the Vercel project (Settings -> Environment
Variables) — the same pair `web/.env` holds locally:

| Variable | Where it comes from |
| --- | --- |
| `VITE_SUPABASE_URL` | `https://<project-ref>.supabase.co` |
| `VITE_SUPABASE_ANON_KEY` | Project settings -> API -> `anon` `public` |

Vite inlines every `VITE_`-prefixed variable into the bundle at build time, so
both are readable by anyone who views source. That is correct for these two and
only these two: the anon key is a public identifier, and RLS is what actually
decides what it can read — the property `scripts/rls-report.mjs` verifies. The
service role key in the root `.env` must never be set here, because it bypasses
RLS entirely.

**Point Supabase Auth at the deployed URL before sharing the link.** Sign-in
uses `signInWithOtp`, and Supabase builds that email link from Authentication ->
URL Configuration -> **Site URL**. Left at `http://localhost:5173`, every magic
link sent to a real visitor redirects to their own machine and fails. Set Site
URL to the deployed origin, and add both it and `http://localhost:5173` to
**Redirect URLs** so local development keeps working.

Two more things worth knowing before the link goes anywhere:

- **Free-tier projects pause after about a week of inactivity**, and a paused
  project answers with a connection error. A link that worked when you sent it
  can be dead when someone opens it.
- **The built-in email sender is rate limited** to a handful of messages an
  hour. That does not block a visitor, because the `public read` policies in
  `0001_schema.sql` leave the queue, the filters and the search readable by
  `anon` — the interesting half of the app needs no account at all. Only
  writing a triage note does.

`ingest/`, `scripts/` and `drills/` are not part of the deployment. They run
locally against `DATABASE_URL` and the service role key, and the hosted project
needs the migrations applied and some rows mirrored before the dashboard has
anything to show.

### Netlify instead

The same bundle, configured in the UI rather than in the repo:

| Setting | Value |
| --- | --- |
| Base directory | `web` |
| Build command | `npm run build` |
| Publish directory | `dist` (relative to the base directory) |

Everything above about the environment variables and the Auth Site URL applies
unchanged.

## The drills

`drills/` is a separate thing: a PostgreSQL practice set in a self-contained
`drill` schema, with no dependency on the app or on Supabase's `auth` tables, so
it runs on any Postgres 14+.

```bash
npm run drills                  # seed, then every worked answer
# or, with a psql client:
psql "$DATABASE_URL" -f drills/00_seed.sql
```

That builds ~6,000 issues, 500 orgs, 4,000 invoices and a deliberately sparse set
of indexes. Then [drills/questions.md](drills/questions.md) has 35 questions in
four tiers plus a row-level-security section, and
[drills/answers.sql](drills/answers.sql) has worked solutions with the reasoning
written out — which index serves it, and what breaks at 50 million rows.

## Status

Everything below was run against a real Supabase project (Postgres 17.11, free
tier), not just reviewed:

| What | Result |
| --- | --- |
| `0001_schema.sql`, `0002_search.sql` | apply clean, 30 and 4 statements |
| `drills/00_seed.sql` | 500 orgs, 1,400 projects, 4,000 invoices, 6,000 issues, 12,682 label rows, 3,649 triage notes |
| `drills/answers.sql` | 39 statements, clean |
| `supabase/queries/triage_queries.sql` | 9 statements, clean |
| `supabase/queries/smoke_test.sql` | views and search behave as documented |
| `supabase/queries/index_check.sql` | partial index confirmed at 40k rows |
| `ingest/fetch-issues.mjs` | mirrored 400 real rows from `supabase/supabase` |
| `scripts/rls-report.mjs` | 7 policy checks, all passing |
| `web/` dashboard | loaded against the live project, no console errors |

The two check files run inside a transaction the runner rolls back, so they
prove the schema works without leaving rows behind:

```bash
node --env-file=.env scripts/run-sql.mjs --dry-run supabase/queries/smoke_test.sql
node --env-file=.env scripts/run-sql.mjs --dry-run supabase/queries/index_check.sql
```

`index_check.sql` is the one worth reading. At 40,000 rows the queue's default
query plans as:

```
Limit  ->  Index Scan using issues_open_recent_idx on issues
           Buffers: shared hit=97      Execution Time: 0.247 ms
```

while the same question phrased as `where lower(state) = 'open'`, which the
partial index cannot serve, falls back to:

```
Limit  ->  Sort  ->  Seq Scan on issues
           Buffers: shared hit=4104    Execution Time: 57.482 ms
```

Forty-two times the buffer reads for the same fifty rows. That contrast is the
argument for the index, and it is reproducible rather than asserted.

**Three bugs the database caught**, now fixed:

- Drill 19 called `round(double precision, int)`, which does not exist in
  Postgres — `percentile_cont` over an integer column returns double precision
  and needs an explicit `::numeric`.
- Drill 32's example function referenced a customer's own table. Postgres
  validates a SQL function body at creation time, so it failed; it is written
  out as commented SQL now, like the rest of that section.
- Drill 30 looked up `pg_class where relname = 'issues'` without qualifying the
  schema and quietly returned two rows, one per schema. The fix is in the file,
  and the mistake is now part of the lesson.

**The policies are checked from the roles that matter.** `scripts/rls-report.mjs`
creates two engineers and a note for each inside a rolled-back transaction, then
asks what each role can see:

```
PASS  anon: issues in queue           67   owner sees 67
PASS  anon: labels readable           24   public read policy
PASS  anon: search hits               13   security invoker function
PASS  anon: triage notes               0   2 exist, 0 visible
PASS  ada: triage notes                1   sees only her own of 2
PASS  grace: triage notes              1   sees only her own of 2
PASS  ada: writing as grace      blocked   with check clause
```

The seeding matters. With an empty table, "anon sees 0 notes" passes while
proving nothing — so the script inserts two notes under different users first.
Checking a policy from the owner account, which bypasses RLS entirely, is the
most common false positive in Supabase support: it is exactly the "works in the
SQL editor, returns `[]` in the app" report, seen from the other side.

**The dashboard runs against the live project.** With 67 mirrored issues (18 of
them open), the queue renders, `label_names` arrives as a real array rather than
a string, the label filter narrows 18 rows to 4, every at-risk row is flagged,
and the console is clean.

**A fourth bug, which only the browser could have found.** Searching
"self hosted password" returned two results, one of them with no highlighting.
The index is built from `title || body`, but `ts_headline` was being given the
body alone — so a row matching on its *title* came back with no highlight and a
snippet of whatever its body happened to open with. Every database-side check
passed, because the row was correctly found; only looking at the page showed the
snippet was useless. `ts_headline` now reads the same text the index does.

The lesson generalises: `ts_rank` and `ts_headline` must be fed identical text,
or search silently returns correct rows with misleading context.
