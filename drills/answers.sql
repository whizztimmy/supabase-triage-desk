-- Worked answers to drills/questions.md.
-- Run 00_seed.sql first, then: set search_path = drill, public;
--
-- Where a question asks for reasoning rather than SQL, the reasoning is in the
-- comment. Say it out loud before you read it — the screen asks you to explain.

set search_path = drill, public;

-- ===========================================================================
-- Tier 1 — joins, filters, aggregates
-- ===========================================================================

-- 1. Open vs closed, one row.
--    filter is clearer than sum(case when ...) and does the same single pass.
select
  count(*) filter (where state = 'open')   as open,
  count(*) filter (where state = 'closed') as closed
from issues;

-- 2. Top 10 orgs by project count, including orgs with none.
--    The left join is the whole point: count(p.id) counts non-null rows, so a
--    project-less org scores 0 rather than disappearing.
select o.id, o.name, o.plan, count(p.id) as projects
from orgs o
left join projects p on p.org_id = o.id
group by o.id, o.name, o.plan
order by projects desc, o.id
limit 10;

-- 3. Orgs per plan and their median project count.
with per_org as (
  select o.id, o.plan, count(p.id) as projects
  from orgs o
  left join projects p on p.org_id = o.id
  group by o.id, o.plan
)
select
  plan,
  count(*)                                                        as orgs,
  percentile_cont(0.5) within group (order by projects)           as median_projects
from per_org
group by plan
order by orgs desc;

-- 4. Labels never applied.
select l.name
from labels l
where not exists (select 1 from issue_labels il where il.label_name = l.name)
order by l.name;

-- 5. Paid revenue per region.
--    Join through orgs because invoices carry no region of their own.
select o.region, round(sum(i.amount_usd), 2) as paid_usd, count(*) as invoices
from invoices i
join orgs o on o.id = i.org_id
where i.status = 'paid'
group by o.region
order by paid_usd desc;

-- 6. Issues with no labels, two ways.
--    (a) not exists — stops at the first match, and the planner turns it into an
--        anti-join. This is the one to reach for.
select count(*)
from issues i
where not exists (select 1 from issue_labels il where il.issue_id = i.id);

--    (b) left join ... is null — same result, but it has to materialise the join
--        first. Equivalent on small tables, worse when a row has many labels.
select count(*)
from issues i
left join issue_labels il on il.issue_id = i.id
where il.issue_id is null;

-- 7. Orgs whose MOST RECENT invoice failed.
--    distinct on is the Postgres-specific trick worth knowing: it keeps the first
--    row per group in the order you give it, which is cheaper than a window
--    function when you only want row 1.
with latest as (
  select distinct on (org_id) org_id, period, status, amount_usd
  from invoices
  order by org_id, period desc, id desc
)
select o.id, o.name, o.plan, l.period, l.amount_usd
from latest l
join orgs o on o.id = l.org_id
where l.status = 'failed'
order by l.period desc;

-- 8. Share still open, per author association.
--    nullif guards the divide-by-zero that will eventually bite you in prod.
select
  a.association,
  count(*)                                   as issues,
  count(*) filter (where i.state = 'open')   as still_open,
  round(
    100.0 * count(*) filter (where i.state = 'open') / nullif(count(*), 0),
    1
  )                                          as pct_open
from issues i
join authors a on a.login = i.author_login
group by a.association
order by pct_open desc;

-- 9. Issues per day for 30 days, including empty days.
--    generate_series supplies the calendar; the left join fills it in. Without
--    this, a zero day is simply absent and every chart built on it lies.
select
  d.day::date,
  count(i.id) as issues
from generate_series(
       date_trunc('day', now()) - interval '29 days',
       date_trunc('day', now()),
       interval '1 day'
     ) as d(day)
left join issues i
  on i.created_at >= d.day
 and i.created_at <  d.day + interval '1 day'
group by d.day
order by d.day;

-- 10. Five largest projects per region, ties broken deterministically.
--     row_number, not rank: rank would return six rows on a tie.
select region, ref, db_size_mb
from (
  select
    o.region,
    p.ref,
    p.db_size_mb,
    row_number() over (partition by o.region order by p.db_size_mb desc, p.id) as rn
  from projects p
  join orgs o on o.id = p.org_id
) ranked
where rn <= 5
order by region, db_size_mb desc;

-- ===========================================================================
-- Tier 2 — CTEs and window functions
-- ===========================================================================

-- 11. Time to first triage, and its percentiles.
with first_touch as (
  select
    i.id,
    extract(epoch from (min(t.created_at) - i.created_at)) / 3600 as hours
  from issues i
  join triage_notes t on t.issue_id = i.id
  group by i.id, i.created_at
)
select
  count(*)                                                              as triaged,
  round(percentile_cont(0.50) within group (order by hours)::numeric, 1) as p50_hours,
  round(percentile_cont(0.90) within group (order by hours)::numeric, 1) as p90_hours,
  round(percentile_cont(0.99) within group (order by hours)::numeric, 1) as p99_hours
from first_touch;

-- 12. Week over week, with the delta.
with weekly as (
  select date_trunc('week', created_at)::date as week, count(*) as issues
  from issues
  group by 1
)
select
  week,
  issues,
  lag(issues) over (order by week)            as prev_week,
  issues - lag(issues) over (order by week)   as delta
from weekly
order by week desc
limit 12;

-- 13. Running total per engineer.
--     The frame is implicit here (unbounded preceding to current row) because the
--     window has an ORDER BY. Be ready to say that; it is a common follow-up.
select
  triaged_by,
  created_at::date as day,
  count(*)                                                     as triaged_that_day,
  sum(count(*)) over (partition by triaged_by order by created_at::date) as running_total
from triage_notes
group by triaged_by, created_at::date
order by triaged_by, day;

-- 14. Top 3 labels per month, last 6 months.
with monthly as (
  select
    date_trunc('month', i.created_at)::date as month,
    il.label_name,
    count(*)                                as issues
  from issues i
  join issue_labels il on il.issue_id = i.id
  where i.created_at >= date_trunc('month', now()) - interval '5 months'
  group by 1, 2
),
ranked as (
  select *, row_number() over (partition by month order by issues desc, label_name) as rn
  from monthly
)
select month, label_name, issues
from ranked
where rn <= 3
order by month desc, issues desc;

-- 15. rank vs dense_rank vs row_number.
--     rank leaves gaps after a tie (1,2,2,4); dense_rank does not (1,2,2,3);
--     row_number never ties, so it is the only one that gives exactly N rows.
with revenue as (
  select org_id, sum(amount_usd) as paid
  from invoices
  where status = 'paid'
  group by org_id
)
select
  org_id,
  paid,
  rank()       over (order by paid desc) as rank,
  dense_rank() over (order by paid desc) as dense_rank,
  row_number() over (order by paid desc) as row_number
from revenue
order by paid desc
limit 20;

-- 16. Longest gap between consecutive issues by the same author.
with gaps as (
  select
    author_login,
    created_at,
    created_at - lag(created_at) over (partition by author_login order by created_at) as gap
  from issues
)
select author_login, max(gap) as longest_gap
from gaps
where gap is not null
group by author_login
order by longest_gap desc
limit 10;

-- 17. Seven-day moving average.
--     A range frame on the date, not `rows 6 preceding`: rows would silently
--     skip days with no issues and compute the wrong window.
with daily as (
  select created_at::date as day, count(*) as issues
  from issues
  group by 1
)
select
  day,
  issues,
  round(avg(issues) over (
    -- cast to timestamp so the interval offset is unambiguously addable to the
    -- ordering column; a bare date column is fussier about RANGE offsets.
    order by day::timestamp
    range between interval '6 days' preceding and current row
  ), 1) as avg_7d
from daily
order by day desc
limit 30;

-- 18. First and last issue per author, one pass.
select
  author_login,
  min(created_at) as first_issue,
  max(created_at) as last_issue,
  count(*)        as issues
from issues
group by author_login
order by issues desc
limit 10;

-- 19. Comment count above the 95th percentile for the issue's label set.
with labelled as (
  select i.id, i.number, i.title, i.comment_count, il.label_name
  from issues i
  join issue_labels il on il.issue_id = i.id
),
thresholds as (
  select
    label_name,
    percentile_cont(0.95) within group (order by comment_count) as p95
  from labelled
  group by label_name
)
select
  l.number,
  left(l.title, 60) as title,
  l.label_name,
  l.comment_count,
  -- percentile_cont over an integer column returns double precision, and
  -- round(double precision, int) does not exist in Postgres. Cast first.
  round(t.p95::numeric, 1) as p95
from labelled l
join thresholds t on t.label_name = l.label_name
where l.comment_count > t.p95
order by l.comment_count desc
limit 20;

-- 20. Churn signal: paid invoices stopped.
with monthly as (
  select
    org_id,
    date_trunc('month', period)::date as month,
    count(*) filter (where status = 'paid') as paid_invoices
  from invoices
  group by 1, 2
),
history as (
  select
    org_id,
    sum(paid_invoices)                                         as lifetime_paid,
    max(month) filter (where paid_invoices > 0)                as last_paid_month
  from monthly
  group by org_id
)
select o.id, o.name, o.plan, h.lifetime_paid, h.last_paid_month
from history h
join orgs o on o.id = h.org_id
where h.lifetime_paid >= 3
  and (h.last_paid_month is null or h.last_paid_month < date_trunc('month', now()) - interval '2 months')
order by h.lifetime_paid desc
limit 20;

-- ===========================================================================
-- Tier 3 — JSONB, arrays, text search
-- ===========================================================================

-- 21. Issues per client.
--     ->> extracts text, -> extracts jsonb. Mixing them up is the single most
--     common JSONB mistake in the support inbox.
select payload ->> 'client' as client, count(*) as issues
from issues
group by 1
order by issues desc;

-- 22. Self-hosted, Postgres 14.x.
--     @> on the jsonb is index-friendly (GIN); the version check is a prefix test.
select number, left(title, 60) as title, payload ->> 'pg_version' as pg_version
from issues
where payload @> '{"self_hosted": true}'
  and payload ->> 'pg_version' like '14.%'
order by created_at desc
limit 20;

-- 23. Reaction count above 50.
--     The cast matters: ->> gives text, and '9' > '50' as text.
select
  number,
  left(title, 60) as title,
  (payload -> 'reactions' ->> 'plus_one')::int as plus_one
from issues
where (payload -> 'reactions' ->> 'plus_one')::int > 50
order by plus_one desc
limit 20;

--     An expression index is what serves it, since the value is computed:
create index if not exists issues_plus_one_idx
  on issues (((payload -> 'reactions' ->> 'plus_one')::int));

--     A GIN index serves containment and key-existence instead, not > on a cast:
create index if not exists issues_payload_gin_idx on issues using gin (payload);

-- 24. "RLS" and "timeout" together, via full text search.
--     ILIKE '%...%' cannot use a B-tree at all — it is a sequential scan plus a
--     per-row regex. to_tsvector + GIN turns it into an index lookup on lexemes,
--     and gets stemming ("timeout"/"timeouts") for free.
create index if not exists issues_fts_idx
  on issues using gin (to_tsvector('english', title || ' ' || coalesce(body, '')));

select number, left(title, 70) as title
from issues
where to_tsvector('english', title || ' ' || coalesce(body, ''))
      @@ websearch_to_tsquery('english', 'RLS timeout')
limit 20;

-- 25. Labels as an array, then containment.
--     @> on an array is one operation; three joins would be three.
with issue_label_sets as (
  select i.id, i.number, i.title, array_agg(il.label_name order by il.label_name) as labels
  from issues i
  join issue_labels il on il.issue_id = i.id
  group by i.id, i.number, i.title
)
select number, left(title, 60) as title, labels
from issue_label_sets
where labels @> array['rls', 'performance']
order by number desc;

-- 26. Making a substring search indexable.
--     Two options, and the right answer depends on the query shape:
--       (a) full text search, when you are matching words (question 24).
--       (b) a trigram index, when you need true substring or fuzzy matching.
create extension if not exists pg_trgm;

create index if not exists issues_body_trgm_idx on issues using gin (body gin_trgm_ops);

--     Now this uses the index instead of scanning every row:
select number, left(title, 60) as title
from issues
where body ilike '%service role%'
limit 20;

-- ===========================================================================
-- Tier 4 — performance and EXPLAIN
-- ===========================================================================

-- 27. Why no plain B-tree on title helps `where lower(title) like 'rls%'`:
--     the index stores `title`, the predicate asks about `lower(title)` — a
--     different value, so the index cannot be matched. Two fixes:
--       (a) an expression index that stores exactly what the predicate computes:
create index if not exists issues_lower_title_idx on issues (lower(title) text_pattern_ops);
--         text_pattern_ops is needed for LIKE prefix matching on a non-C collation.
--       (b) a trigram index (question 26), which also handles '%rls%', not just 'rls%'.

-- 28. Profile question 11, then fix it.
explain (analyze, buffers)
with first_touch as (
  select
    i.id,
    extract(epoch from (min(t.created_at) - i.created_at)) / 3600 as hours
  from issues i
  join triage_notes t on t.issue_id = i.id
  group by i.id, i.created_at
)
select round(percentile_cont(0.90) within group (order by hours)::numeric, 1)
from first_touch;

--     Expect the aggregate over triage_notes to dominate. A covering index lets
--     the min() come from the index alone instead of visiting the heap:
create index if not exists triage_notes_issue_created_idx
  on triage_notes (issue_id, created_at);

analyze triage_notes;
--     Re-run the EXPLAIN and compare `shared read` in the buffers line — fewer
--     blocks read is the thing to point at, not just a smaller wall time, which
--     moves around with cache state.

-- 29. "Slow after a restore, same data, same query." In order:
--     (a) Statistics are gone. A restore does not carry planner stats, so the
--         planner is guessing. Check and fix:
--           select relname, last_analyze, last_autoanalyze from pg_stat_user_tables;
--           analyze;
--         This is the answer about nine times in ten.
--     (b) Indexes are missing or invalid. A pg_dump restore builds indexes last
--         and a failure leaves them behind:
--           select indexrelid::regclass, indisvalid from pg_index where not indisvalid;
--           select tablename, indexname from pg_indexes where schemaname = 'public';
--     (c) Cache is cold, or the plan actually changed. Compare plans directly:
--           explain (analyze, buffers) <their query>;
--         A high `shared read` with a low `shared hit` is a cold cache and it
--         warms up; a different node type than before is a real plan change.

-- 30. count(*) vs reltuples.
--     count(*) is exact and costs a full scan — on a large table that is seconds
--     to minutes, and it is MVCC-correct for your snapshot.
--     reltuples is an estimate maintained by ANALYZE and vacuum, free to read,
--     and stale between runs. Use it for "roughly how big is this?" and never
--     for anything a user sees as a number. It is also -1 on a table that has
--     never been analyzed.
select count(*) as exact_count from issues;

-- Note the schema qualification: `where relname = 'issues'` alone matches
-- BOTH drill.issues and public.issues and quietly returns two rows. A bare
-- relname lookup is a bug waiting to happen on any database with more than
-- one schema.
select reltuples::bigint as estimated_count
from pg_class
where relname = 'issues'
  and relnamespace = 'drill'::regnamespace;

-- ===========================================================================
-- Supabase-specific: row level security
--
-- These are answers to say out loud, so they are written as the explanation
-- you would give a customer, with the SQL you would ask them to run.
-- ===========================================================================

-- 31. "Insert works with the service role key but not from the browser."
--     The service role key bypasses RLS entirely; the anon/authenticated key does
--     not. So the error is telling you the table has RLS on and no INSERT policy
--     the request satisfies. Diagnosis, in order:
--       1. Is there an INSERT policy at all? A SELECT policy does not grant insert.
--            select schemaname, tablename, policyname, cmd, qual, with_check
--            from pg_policies where tablename = 'documents';
--       2. INSERT policies are checked by WITH CHECK, not USING. A policy written
--          with only USING will never let an insert through.
--       3. Is the row's user_id actually auth.uid()? If the client omits the
--          column and there is no `default auth.uid()`, it inserts NULL and the
--          check fails. Fix at the table, not the policy:
--            alter table documents alter column user_id set default auth.uid();
--       4. Is the request authenticated? An expired or missing JWT makes
--          auth.uid() null, and `auth.uid() = user_id` is then null, not true.
--            select auth.uid(); -- run as the user, not in the SQL editor as owner

-- 32. 42P17 infinite recursion.
--     The policy on `documents` queries `documents`, so evaluating the policy
--     requires evaluating the policy. (The example also shadows `team_id`, which
--     makes the subquery trivially true — a second bug.) Two ways out:
--       (a) Do not self-reference. Compare against the row's own column, with
--           the membership lookup pushed into a function over a DIFFERENT table.
--           (Illustrative: `team_members` is the customer's table, not ours, so
--           this is written out rather than executed. Postgres validates a SQL
--           function body at creation time, so running it here would fail.)
--
--            create or replace function current_team_ids()
--            returns setof uuid
--            language sql
--            stable
--            security definer
--            set search_path = public  -- always pin this on a definer function
--            as $$
--              select team_id from team_members where user_id = auth.uid();
--            $$;
--
--          then:
--            create policy "team members can read" on documents for select
--              using (team_id in (select current_team_ids()));
--       (b) Keep the membership check in a separate table (`team_members`) whose
--           own policy does not reference `documents`. Recursion only happens
--           when the cycle closes.

-- 33. Why the second policy is slow, and the fix.
--     `auth.uid() = user_id` is a constant compared to a column: the planner can
--     use an index on user_id, and it evaluates auth.uid() once.
--     The nested `in (select ...)` version is re-evaluated per row, because the
--     planner treats it as correlated. Wrapping the subquery in a scalar
--     subselect — `(select ...)` — makes Postgres hoist it into an InitPlan that
--     runs exactly once:
--       using (
--         user_id in (
--           select id from profiles
--           where org_id = (select org_id from profiles where id = (select auth.uid()))
--         )
--       )
--     Note `(select auth.uid())` rather than bare `auth.uid()`: the same trick,
--     and it is the single highest-leverage RLS performance tip there is.
--     Then index what the policy filters on:
--       create index on profiles (org_id);

-- 34. When security definer is right.
--     When the policy needs to read a table the user is not allowed to read —
--     a membership or entitlement table. The function runs as its owner, so it
--     sees past RLS. Two things are mandatory:
--       - `set search_path = ...` on the function, or a caller can shadow a table
--         name and have your definer-privileged function read theirs instead.
--       - Keep it narrow and `stable`. It should answer one question and return
--         ids, never accept SQL or return whole rows.

-- 35. "supabase-js returns [] but the SQL editor returns rows."
--     In order of likelihood:
--       1. RLS. The SQL editor runs as a privileged role that bypasses policies;
--          the client does not. No matching SELECT policy returns an empty array
--          rather than an error, which is exactly why this is confusing.
--       2. Wrong schema or a stale API cache. A table in a non-exposed schema, or
--          added after the last schema reload, is not visible to PostgREST.
--       3. The filter. `.eq('id', uuid)` against a differently-typed column, or a
--          `.single()` that is silently returning nothing. Have them log the
--          generated query and compare it to what they ran by hand.
