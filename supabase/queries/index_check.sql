-- Proves the partial index actually serves the queue's default query, which a
-- three-row smoke test cannot: at that size the planner is right to ignore
-- every index. This loads 40,000 rows, analyzes, and asks for the plan.
--
--   node --env-file=.env scripts/run-sql.mjs --dry-run supabase/queries/index_check.sql
--
-- Always with --dry-run: the rows exist only inside the rolled-back transaction.

set search_path = public;

insert into authors (login, html_url, association)
values ('loadtest', 'https://example.invalid/loadtest', 'NONE')
on conflict (login) do nothing;

-- 40k issues, a quarter of them open, a fifth of them pull requests, so the
-- partial index covers roughly a fifth of the table — the shape that makes a
-- partial index worth having in the first place.
insert into issues (
  id, repo, number, title, body, state, author_login,
  comment_count, reaction_count, is_pull_request, html_url, created_at, updated_at
)
select
  900000 + g,
  'supabase/supabase',
  900000 + g,
  'Synthetic issue ' || g,
  'Body for synthetic issue ' || g,
  case when g % 4 = 0 then 'open' else 'closed' end,
  'loadtest',
  g % 30,
  g % 7,
  g % 5 = 0,
  'https://example.invalid/' || g,
  now() - (g % 900) * interval '1 hour',
  now() - (g % 400) * interval '1 hour'
from generate_series(1, 40000) g;

analyze issues;

-- The queue's default query. Expect:
--   Index Scan using issues_open_recent_idx on issues
-- and NOT a Seq Scan or a Sort node.
explain (analyze, buffers, costs off)
select id, number, title
from issues
where state = 'open' and is_pull_request = false
order by created_at desc
limit 50;

-- The same question phrased so the partial index cannot be matched, for
-- contrast: lower(state) is not the indexed expression.
explain (analyze, buffers, costs off)
select id, number, title
from issues
where lower(state) = 'open'
order by created_at desc
limit 50;

-- And the full text index, which needs the rows to be worth using too.
explain (analyze, buffers, costs off)
select id, number
from issues
where search_tsv @@ websearch_to_tsquery('english', 'synthetic 12345');
