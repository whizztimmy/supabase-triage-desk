-- Drill sandbox: a self-contained `drill` schema with enough rows that EXPLAIN
-- tells the truth. No auth.* dependency, so this runs on the Supabase SQL
-- editor, a local `psql`, or any Postgres 14+ container.
--
--   psql "$DATABASE_URL" -f drills/00_seed.sql
--
-- Deterministic: setseed makes every run produce the same data, so an
-- answer's row counts are reproducible.

begin;

drop schema if exists drill cascade;
create schema drill;
set search_path = drill, public;

select setseed(0.42);

-- ---------------------------------------------------------------------------
-- Support side: orgs, their projects, their invoices
-- ---------------------------------------------------------------------------

create table orgs (
  id         int primary key,
  name       text        not null,
  plan       text        not null check (plan in ('free', 'pro', 'team', 'enterprise')),
  region     text        not null,
  created_at timestamptz not null
);

insert into orgs (id, name, plan, region, created_at)
select
  g,
  'org-' || lpad(g::text, 4, '0'),
  (array['free', 'free', 'free', 'pro', 'pro', 'team', 'enterprise'])[1 + floor(random() * 7)],
  (array['eu-west-1', 'eu-central-1', 'us-east-1', 'ap-south-1'])[1 + floor(random() * 4)],
  now() - (random() * 900)::int * interval '1 day'
from generate_series(1, 500) g;

create table projects (
  id         int primary key,
  org_id     int         not null references orgs (id) on delete cascade,
  ref        text        not null unique,
  db_size_mb numeric(10, 1) not null,
  paused     boolean     not null default false,
  created_at timestamptz not null
);

insert into projects (id, org_id, ref, db_size_mb, paused, created_at)
select
  g,
  1 + floor(random() * 500),
  'proj' || lpad(g::text, 5, '0'),
  round((random() ^ 3 * 40000)::numeric, 1), -- skewed: most are small, a few are huge
  random() < 0.12,
  now() - (random() * 800)::int * interval '1 day'
from generate_series(1, 1400) g;

create table invoices (
  id          int primary key,
  org_id      int         not null references orgs (id) on delete cascade,
  period      date        not null,
  amount_usd  numeric(10, 2) not null,
  status      text        not null check (status in ('paid', 'open', 'void', 'failed')),
  paid_at     timestamptz
);

insert into invoices (id, org_id, period, amount_usd, status, paid_at)
select
  g,
  1 + floor(random() * 500),
  (date_trunc('month', now()) - (1 + floor(random() * 14)) * interval '1 month')::date,
  round((random() * 1800 + 10)::numeric, 2),
  s.status,
  case when s.status = 'paid' then now() - (random() * 400)::int * interval '1 day' end
from generate_series(1, 4000) g
cross join lateral (
  select (array['paid', 'paid', 'paid', 'paid', 'open', 'failed', 'void'])[1 + floor(random() * 7)] as status
) s;

-- ---------------------------------------------------------------------------
-- Community side: the same shape as the live mirror, minus auth
-- ---------------------------------------------------------------------------

create table authors (
  login       text primary key,
  association text not null
);

insert into authors (login, association)
select
  'user' || lpad(g::text, 4, '0'),
  (array['NONE', 'NONE', 'NONE', 'NONE', 'CONTRIBUTOR', 'MEMBER', 'COLLABORATOR'])[1 + floor(random() * 7)]
from generate_series(1, 700) g;

create table labels (
  name  text primary key,
  color text
);

insert into labels (name, color) values
  ('bug', 'd73a4a'),
  ('documentation', '0075ca'),
  ('auth', '5319e7'),
  ('database', '0e8a16'),
  ('storage', 'fbca04'),
  ('realtime', '1d76db'),
  ('edge-functions', 'c5def5'),
  ('needs-repro', 'e4e669'),
  ('good first issue', '7057ff'),
  ('performance', 'b60205'),
  ('rls', '006b75'),
  ('billing', 'bfdadc');

create table issues (
  id              bigint primary key,
  number          int         not null unique,
  title           text        not null,
  body            text,
  state           text        not null check (state in ('open', 'closed')),
  author_login    text        references authors (login),
  comment_count   int         not null default 0,
  is_pull_request boolean     not null default false,
  created_at      timestamptz not null,
  closed_at       timestamptz,
  payload         jsonb       not null default '{}'::jsonb
);

insert into issues (
  id, number, title, body, state, author_login,
  comment_count, is_pull_request, created_at, closed_at, payload
)
select
  1000000 + g,
  g,
  s.topic || ' ' || s.symptom,
  'Reproduction: ' || s.topic || ' fails when ' || s.symptom ||
    '. Postgres version 15.6. Client: supabase-js.',
  case when random() < 0.32 then 'open' else 'closed' end,
  'user' || lpad((1 + floor(random() * 700))::text, 4, '0'),
  floor(random() ^ 2 * 40)::int,
  random() < 0.25,
  created.at,
  case when random() < 0.68 then created.at + (random() * 60 + 0.2)::int * interval '1 day' end,
  jsonb_build_object(
    'client', (array['supabase-js', 'python', 'flutter', 'psql', 'prisma'])[1 + floor(random() * 5)],
    'pg_version', (array['14.9', '15.1', '15.6', '16.2'])[1 + floor(random() * 4)],
    'self_hosted', random() < 0.2,
    'reactions', jsonb_build_object('plus_one', floor(random() ^ 3 * 90)::int)
  )
from generate_series(1, 6000) g
cross join lateral (
  select now() - (random() * 700)::int * interval '1 day' as at
) created
cross join lateral (
  select
    (array[
      'RLS policy', 'Connection pool', 'Realtime subscription', 'Storage upload',
      'Edge function', 'Auth magic link', 'Database migration', 'Vector index'
    ])[1 + floor(random() * 8)] as topic,
    (array[
      'times out under load', 'returns an empty array', 'throws 42P17',
      'drops rows after a restart', 'ignores the service role key',
      'is slower after a restore', 'rejects a valid JWT'
    ])[1 + floor(random() * 7)] as symptom
) s;

-- Some issues have no labels at all; that is the point of several drills.
create table issue_labels (
  issue_id   bigint not null references issues (id) on delete cascade,
  label_name text   not null references labels (name) on delete cascade,
  primary key (issue_id, label_name)
);

insert into issue_labels (issue_id, label_name)
select distinct
  i.id,
  (array[
    'bug', 'documentation', 'auth', 'database', 'storage', 'realtime',
    'edge-functions', 'needs-repro', 'good first issue', 'performance', 'rls', 'billing'
  ])[1 + floor(random() * 12)]
from issues i
cross join generate_series(1, 3) -- up to 3 labels each, deduped by distinct
where random() < 0.75;

create table triage_notes (
  id         bigserial primary key,
  issue_id   bigint      not null references issues (id) on delete cascade,
  triaged_by text        not null,
  category   text        not null,
  severity   text        not null check (severity in ('blocker', 'high', 'normal', 'low')),
  created_at timestamptz not null
);

insert into triage_notes (issue_id, triaged_by, category, severity, created_at)
select
  i.id,
  'engineer' || (1 + floor(random() * 6))::int,
  (array['bug', 'how-to', 'docs-gap', 'feature-request', 'needs-repro', 'billing'])[1 + floor(random() * 6)],
  (array['blocker', 'high', 'normal', 'normal', 'normal', 'low'])[1 + floor(random() * 6)],
  -- Most issues get a first touch within a day; a long tail does not.
  i.created_at + (random() ^ 4 * 400 + 0.5)::int * interval '1 hour'
from issues i
where random() < 0.6;

-- Indexes are deliberately sparse: adding the right one is a drill.
create index issues_created_at_idx on issues (created_at desc);
create index triage_notes_issue_idx on triage_notes (issue_id);

-- Scoped to the drill tables: a bare `analyze` also walks the system catalogs,
-- which a non-superuser cannot read, producing a wall of permission notices.
analyze orgs, projects, invoices, authors, labels, issues, issue_labels, triage_notes;

commit;

-- Sanity check
select
  (select count(*) from drill.orgs)         as orgs,
  (select count(*) from drill.projects)     as projects,
  (select count(*) from drill.invoices)     as invoices,
  (select count(*) from drill.issues)       as issues,
  (select count(*) from drill.issue_labels) as issue_labels,
  (select count(*) from drill.triage_notes) as triage_notes;
