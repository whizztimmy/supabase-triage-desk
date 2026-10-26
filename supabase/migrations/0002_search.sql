-- "Has anyone reported this before?" is the question a support engineer asks most,
-- so it gets its own ranked endpoint rather than a client-side filter.

begin;

create or replace function search_issues(
  q          text,
  only_open  boolean default false,
  max_rows   integer default 25
)
returns table (
  id            bigint,
  repo          text,
  number        integer,
  title         text,
  state         text,
  html_url      text,
  created_at    timestamptz,
  comment_count integer,
  rank          real,
  snippet       text
)
language sql
stable
security invoker
set search_path = public, pg_catalog
as $$
  with query as (
    select websearch_to_tsquery('english', q) as tsq
  )
  select
    i.id,
    i.repo,
    i.number,
    i.title,
    i.state,
    i.html_url,
    i.created_at,
    i.comment_count,
    ts_rank(i.search_tsv, query.tsq) as rank,
    -- ts_headline must be given exactly the text search_tsv was built from:
    -- title AND body, same 20000-char window. Highlighting the body alone looks
    -- fine until a row matches on its title only — then the row comes back with
    -- no highlight and a snippet of whatever the body happens to open with.
    ts_headline(
      'english',
      coalesce(i.title, '') || ' — ' || coalesce(left(i.body, 20000), ''),
      query.tsq,
      'MaxWords=40, MinWords=20, ShortWord=3, MaxFragments=2'
    ) as snippet
  from issues i
  cross join query
  where i.search_tsv @@ query.tsq
    and i.is_pull_request = false
    and (not only_open or i.state = 'open')
  order by rank desc, i.comment_count desc
  limit least(greatest(max_rows, 1), 100);
$$;

comment on function search_issues is
  'Ranked full-text search over mirrored issue titles and bodies, with highlighted snippets.';

commit;
