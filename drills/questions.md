# PostgreSQL drills for a Supabase support screen

Thirty questions against the `drill` schema from [00_seed.sql](00_seed.sql). Worked
solutions are in [answers.sql](answers.sql) — write yours first, then compare, because
the screen will ask you to *explain* the query, not just produce it.

Setup:

```bash
psql "$DATABASE_URL" -f drills/00_seed.sql
```

Then `set search_path = drill, public;` for the session.

How to practise this: do one tier per sitting, out loud. For every answer, be ready
to say which index it would use and what you would change if the table had 50 million
rows instead of 6,000. That second half is what separates a support engineer from
someone who can write SQL.

---

## Tier 1 — joins, filters, aggregates (the warm-up)

1. How many issues are open, and how many are closed? One row, two columns.
2. List the 10 orgs with the most projects. Include orgs with zero projects.
3. For each plan, the number of orgs and their median project count.
4. Which labels have never been applied to a single issue?
5. Total paid revenue per region, highest first. `failed` and `open` invoices do not count.
6. How many issues have no labels at all? Write it two ways — `not exists` and a
   `left join ... is null` — then say which you would prefer and why.
7. Every org whose most recent invoice is `failed`. (Careful: "has a failed invoice"
   is a different question.)
8. For each author association, the share of their issues that are still open,
   as a percentage rounded to one decimal.
9. Issues created in the last 30 days, bucketed by day, including days with zero.
10. The 5 largest projects per region. Exactly five, even on ties.

## Tier 2 — CTEs, window functions, time series

11. Time to first triage per issue, in hours. Then its p50, p90 and p99.
12. Week-over-week open-issue volume with the previous week and the delta.
13. For each engineer in `triage_notes`, their running total of triaged issues over
    time, ordered by date.
14. The top 3 labels by issue count *per month*, for the last 6 months.
15. Rank orgs by lifetime paid revenue; show rank, dense rank and row number
    side by side and explain where they differ.
16. The longest gap between consecutive issues filed by the same author.
17. A 7-day moving average of issues created per day.
18. First and last issue filed by each author, in one row per author, without
    self-joining the table twice.
19. Every issue whose comment count is above the 95th percentile for its label set.
20. Monthly churn signal: orgs whose paid invoice count dropped to zero after
    having at least three.

## Tier 3 — JSONB, arrays, text search

21. Count issues by `payload->>'client'`. Which client reports the most?
22. All self-hosted reports (`payload->'self_hosted'`) running Postgres 14.x.
23. Issues whose `payload.reactions.plus_one` is above 50, ordered by it. Then say
    which index would serve this and write it.
24. Issues mentioning both "RLS" and "timeout" in the title or body, using full
    text search rather than `ILIKE`. Explain the difference in cost.
25. Aggregate each issue's labels into a single text array column, then find the
    issues whose label set contains both `rls` and `performance`.
26. Rewrite `where body ilike '%service role%'` so it can use an index. Give the
    index too.

## Tier 4 — performance and EXPLAIN (the part that gets you hired)

27. `select * from issues where lower(title) like 'rls%'` is slow. Explain why no
    plain B-tree on `title` helps, and give two fixes.
28. Run `explain (analyze, buffers)` on question 11's query. Identify the most
    expensive node and say what you would add. Then add it and show the improvement.
29. A customer says "my query got slow after I restored a backup, same data, same
    query." Give three candidate causes in the order you would check them, and the
    SQL you would ask them to run for each.
30. Explain the difference between these two, and when each is wrong:
    ```sql
    select count(*) from issues;
    select reltuples::bigint from pg_class where relname = 'issues';
    ```

---

## Supabase-specific: row level security

These are not generic SQL, and they are the questions most likely to decide the
interview, because they are what the support inbox is actually full of.

31. A user reports: "My `insert` works with the service role key but returns
    `new row violates row-level security policy` from the browser." Walk through
    your diagnosis.
32. A user's policy is
    ```sql
    create policy "team members can read" on documents for select
      using (
        exists (select 1 from documents d where d.team_id = team_id)
      );
    ```
    and queries now fail with `42P17 infinite recursion detected in policy`.
    Explain the bug and fix it.
33. Why is `using (auth.uid() = user_id)` fast while
    `using (user_id in (select id from profiles where org_id = (select org_id from profiles where id = auth.uid())))`
    is slow on a large table? Rewrite the second one so the subquery runs once.
34. When is `security definer` the right answer for a function a policy calls, and
    what must you always set on such a function?
35. A user says `select` returns `[]` from supabase-js but the same query returns
    rows in the SQL editor. Give the three most likely causes in order.

---

## Scoring yourself

- Tier 1 fluent, no reaching for docs → you clear the SQL bar for most support roles.
- Tier 2 fluent → you clear it for this one.
- Tier 3 and 4 → you can answer the tickets nobody else on the team wants.
- RLS section fluent → you can answer them *on day one*, which is the actual pitch.
