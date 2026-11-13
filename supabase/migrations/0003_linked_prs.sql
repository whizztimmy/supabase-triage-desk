-- Open pull requests linked to open issues: the "PR waiting" signal.
--
-- A link is recorded in either direction. GitHub's own cross-reference events
-- only appear on an issue when a PR's body names it, which misses the common
-- case of a contributor commenting "opened #123 for this" on the issue itself.
-- Tested against nine hand-triaged issues, cross-references alone found one of
-- the expected PRs; reading both directions found all of them.
--
-- link_source keeps the two apart, because they are not equally reliable:
--   pr_text  the PR's own title or body names the issue
--   thread   only the issue's body or comments name the PR ("see #123" counts)
--   both     each names the other
-- Thread-only links are shown as mentions, and fix_waiting ignores them.

begin;

create table issue_prs (
  issue_id      bigint      not null references issues (id) on delete cascade,
  pr_number     integer     not null,
  pr_title      text        not null,
  pr_url        text        not null,
  pr_author     text,
  is_draft      boolean     not null default false,
  link_source   text        not null check (link_source in ('pr_text', 'thread', 'both')),
  pr_updated_at timestamptz,
  linked_at     timestamptz not null default now(),
  primary key (issue_id, pr_number)
);

alter table issue_prs enable row level security;
create policy "public read" on issue_prs for select using (true);

-- create or replace may only append columns, so the original list is repeated
-- unchanged and the two new ones go on the end.
create or replace view issue_queue
with (security_invoker = true) as
select
  i.id,
  i.repo,
  i.number,
  i.title,
  i.state,
  i.html_url,
  i.author_login,
  a.association            as author_association,
  i.comment_count,
  i.reaction_count,
  i.created_at,
  i.updated_at,
  round(extract(epoch from (now() - i.created_at)) / 3600.0, 1) as age_hours,
  coalesce(l.label_names, array[]::text[])                      as label_names,
  t.category               as triage_category,
  t.severity               as triage_severity,
  t.note                   as triage_note,
  t.created_at             as triaged_at,
  (t.id is null)           as needs_triage,
  coalesce(p.open_prs, '[]'::jsonb)                             as open_prs,
  coalesce(p.fix_waiting, false)                                as fix_waiting
from issues i
left join authors a on a.login = i.author_login
left join lateral (
  select array_agg(il.label_name order by il.label_name) as label_names
  from issue_labels il
  where il.issue_id = i.id
) l on true
-- Most recent note per issue: distinct-on beats a window function here because
-- we only ever want row 1.
left join lateral (
  select tn.id, tn.category, tn.severity, tn.note, tn.created_at
  from triage_notes tn
  where tn.issue_id = i.id
  order by tn.created_at desc
  limit 1
) t on true
left join lateral (
  select
    jsonb_agg(
      jsonb_build_object(
        'number', ip.pr_number,
        'title',  ip.pr_title,
        'url',    ip.pr_url,
        'author', ip.pr_author,
        'draft',  ip.is_draft,
        'source', ip.link_source
      )
      order by ip.pr_number
    ) as open_prs,
    bool_or(ip.link_source <> 'thread') as fix_waiting
  from issue_prs ip
  where ip.issue_id = i.id
) p on true
where i.is_pull_request = false;

commit;
