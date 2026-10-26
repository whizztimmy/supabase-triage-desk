-- Checks the policies from the role the browser actually uses, rather than from
-- the owner account that bypasses them. This is the difference between "it
-- works in the SQL editor" and "it works in the app" — the single most common
-- false positive in Supabase support.
--
--   node --env-file=.env scripts/run-sql.mjs --dry-run supabase/queries/rls_check.sql
--
-- Needs --dry-run: `set local role` only lasts for the transaction.

set search_path = public;

-- What the owner sees, as a baseline to compare against.
select 'owner' as role, count(*) as visible_issues from issue_queue;

-- PostgREST runs an unauthenticated request as `anon`. The mirrored GitHub data
-- is public, so this must match the baseline above — if it returns 0, the
-- dashboard shows an empty table and the cause is a missing grant or policy.
set local role anon;
select 'anon' as role, count(*) as visible_issues from issue_queue;

-- ...but triage notes are internal. auth.uid() is null for an anonymous request,
-- so `auth.uid() = triaged_by` is null, not true, and this must return 0.
select 'anon' as role, count(*) as visible_notes from triage_notes;

-- A signed-in user with no notes of their own must also see none: the policy is
-- per-engineer, not merely "logged in".
set local role authenticated;
select 'authenticated' as role, count(*) as visible_notes from triage_notes;

reset role;

-- And the search function, which is `security invoker`: it must run as the
-- caller, so an anonymous visitor can search public issues.
set local role anon;
select 'anon' as role, count(*) as search_hits from search_issues('auth', false, 25);

reset role;
