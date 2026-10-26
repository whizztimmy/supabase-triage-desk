# Triage Desk

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

The web app builds clean (`tsc --noEmit && vite build`). The SQL has not been
executed yet — there's no Postgres on the machine it was written on, so the
migrations, queries and drills are reviewed but unrun. First thing to do is paste
`0001_schema.sql` into a real project and fix whatever it complains about.
