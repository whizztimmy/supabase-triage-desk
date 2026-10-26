-- Proves the schema actually works, without waiting for an ingest run: inserts a
-- handful of rows, exercises the views and the search function, then leaves.
--
--   node --env-file=.env scripts/run-sql.mjs --dry-run supabase/queries/smoke_test.sql
--
-- Run it with --dry-run (the default way to use it): the runner wraps the file
-- in a transaction and rolls back, so these rows never reach the real table.

set search_path = public;

insert into authors (login, html_url, association) values
  ('ada',   'https://github.com/ada',   'NONE'),
  ('grace', 'https://github.com/grace', 'MEMBER'),
  ('linus', 'https://github.com/linus', 'CONTRIBUTOR');

insert into labels (name, color, description) values
  ('bug',         'd73a4a', 'Something is broken'),
  ('rls',         '006b75', 'Row level security'),
  ('performance', 'b60205', 'Too slow');

insert into issues (
  id, repo, number, title, body, state, author_login,
  comment_count, reaction_count, is_pull_request, html_url, created_at, updated_at
) values
  (1, 'supabase/supabase', 101,
   'RLS policy causes a connection pool timeout under load',
   'Our select times out once concurrency passes 50. The policy calls auth.uid() per row.',
   'open', 'ada', 12, 30, false, 'https://example.invalid/101',
   now() - interval '5 days', now() - interval '1 day'),
  (2, 'supabase/supabase', 102,
   'Storage upload returns an empty array',
   'No error, just [] back from the client. Works with the service role key.',
   'open', 'grace', 3, 1, false, 'https://example.invalid/102',
   now() - interval '10 hours', now() - interval '2 hours'),
  (3, 'supabase/supabase', 103,
   'chore: bump dependencies',
   'Routine bump.',
   'open', 'linus', 0, 0, true, 'https://example.invalid/103',
   now() - interval '2 days', now() - interval '2 days');

insert into issue_labels (issue_id, label_name) values
  (1, 'bug'), (1, 'rls'), (1, 'performance'), (2, 'bug');

-- 1. The queue view: labels aggregated, age computed, PR excluded.
--    Expect 2 rows (not 3 — #103 is a pull request), both needing triage.
select number, age_hours > 0 as has_age, label_names, needs_triage
from issue_queue
order by number;

-- 2. The generated tsvector and the search function, including the snippet.
--    Expect #101 only: "pool timeout" matches it and not the storage issue.
select number, rank > 0 as ranked, snippet like '%<b>%' as has_highlight
from search_issues('pool timeout');

-- 3. websearch_to_tsquery syntax, not just bare words.
--    Expect #102, since #101 does not mention storage.
select number from search_issues('storage upload');

-- 4. The weekly rollup runs and aggregates by label.
select label_name, issue_count from label_volume_weekly order by label_name;

-- 5. The partial index is the one the queue's default query uses.
--    Look for "Index Scan using issues_open_recent_idx" in the plan.
explain (costs off)
select id, number, title
from issues
where state = 'open' and is_pull_request = false
order by created_at desc
limit 50;
