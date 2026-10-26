-- Triage Desk schema
-- Mirrors public GitHub issue activity into Postgres so support can queue, search
-- and annotate it. Written to run top-to-bottom in the Supabase SQL editor.

begin;

-- ---------------------------------------------------------------------------
-- Enums
-- ---------------------------------------------------------------------------

create type triage_category as enum (
  'bug',
  'how-to',
  'docs-gap',
  'feature-request',
  'billing',
  'needs-repro',
  'upstream-postgres',
  'not-an-issue'
);

create type triage_severity as enum ('blocker', 'high', 'normal', 'low');

-- ---------------------------------------------------------------------------
-- Tables
-- ---------------------------------------------------------------------------

create table authors (
  login         text primary key,
  html_url      text not null,
  avatar_url    text,
  -- GitHub's author_association on the issue: OWNER / MEMBER / COLLABORATOR / NONE...
  association   text,
  first_seen_at timestamptz not null default now()
);

create table labels (
  name        text primary key,
  color       text,
  description text
);

create table issues (
  -- GitHub's own id, so re-ingesting is an upsert rather than a duplicate.
  id              bigint primary key,
  repo            text        not null,
  number          integer     not null,
  title           text        not null,
  body            text,
  state           text        not null check (state in ('open', 'closed')),
  state_reason    text,
  author_login    text        references authors (login) on delete set null,
  comment_count   integer     not null default 0,
  reaction_count  integer     not null default 0,
  is_pull_request boolean     not null default false,
  html_url        text        not null,
  created_at      timestamptz not null,
  updated_at      timestamptz not null,
  closed_at       timestamptz,
  ingested_at     timestamptz not null default now(),

  -- One tsvector over title + body keeps "has anyone reported this before?"
  -- a single index hit instead of two ILIKE scans.
  search_tsv tsvector generated always as (
    to_tsvector(
      'english',
      coalesce(title, '') || ' ' || coalesce(left(body, 20000), '')
    )
  ) stored,

  constraint issues_repo_number_key unique (repo, number),
  constraint issues_closed_after_created check (closed_at is null or closed_at >= created_at)
);

create table issue_labels (
  issue_id   bigint not null references issues (id) on delete cascade,
  label_name text   not null references labels (name) on delete cascade,
  primary key (issue_id, label_name)
);

create table triage_notes (
  id          uuid primary key default gen_random_uuid(),
  issue_id    bigint          not null references issues (id) on delete cascade,
  triaged_by  uuid            not null default auth.uid() references auth.users (id) on delete cascade,
  category    triage_category not null,
  severity    triage_severity not null default 'normal',
  note        text,
  -- Set when the engineer actually replied on the thread, not when the row was written.
  responded_at timestamptz,
  created_at  timestamptz     not null default now()
);

-- ---------------------------------------------------------------------------
-- Indexes
-- ---------------------------------------------------------------------------

-- The dashboard's default view: open, non-PR, newest first.
create index issues_open_recent_idx
  on issues (created_at desc)
  where state = 'open' and is_pull_request = false;

create index issues_updated_at_idx on issues (updated_at desc);
create index issues_author_idx      on issues (author_login);
create index issues_search_idx      on issues using gin (search_tsv);
create index issue_labels_label_idx on issue_labels (label_name);
create index triage_notes_issue_idx on triage_notes (issue_id, created_at desc);

-- ---------------------------------------------------------------------------
-- Views
-- ---------------------------------------------------------------------------

-- Everything the queue UI needs for one row, so the client makes one request
-- instead of N+1 label lookups.
create view issue_queue
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
  (t.id is null)           as needs_triage
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
where i.is_pull_request = false;

-- Week-over-week label volume, for spotting a regression before the tickets pile up.
create view label_volume_weekly
with (security_invoker = true) as
with weekly as (
  select
    date_trunc('week', i.created_at)::date as week,
    il.label_name,
    count(*)                               as issue_count
  from issues i
  join issue_labels il on il.issue_id = i.id
  where i.is_pull_request = false
  group by 1, 2
)
select
  week,
  label_name,
  issue_count,
  lag(issue_count) over (partition by label_name order by week) as prev_week_count,
  issue_count - lag(issue_count) over (partition by label_name order by week) as delta
from weekly
order by week desc, issue_count desc;

-- ---------------------------------------------------------------------------
-- Row level security
--
-- The mirrored GitHub data is already public, so it is readable by anyone who
-- can reach the project. Triage notes are internal: an engineer sees and edits
-- only their own.
-- ---------------------------------------------------------------------------

alter table authors      enable row level security;
alter table labels       enable row level security;
alter table issues       enable row level security;
alter table issue_labels enable row level security;
alter table triage_notes enable row level security;

create policy "public read" on authors      for select using (true);
create policy "public read" on labels       for select using (true);
create policy "public read" on issues       for select using (true);
create policy "public read" on issue_labels for select using (true);

create policy "own notes are readable" on triage_notes
  for select using (auth.uid() = triaged_by);

create policy "own notes are writable" on triage_notes
  for insert with check (auth.uid() = triaged_by);

create policy "own notes are editable" on triage_notes
  for update using (auth.uid() = triaged_by);

create policy "own notes are deletable" on triage_notes
  for delete using (auth.uid() = triaged_by);

commit;
