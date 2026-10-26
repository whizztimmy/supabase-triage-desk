-- Queries a support engineer actually runs against the mirror.
-- Each one answers a question someone asked in a standup, not a textbook exercise.

-- ---------------------------------------------------------------------------
-- 1. What is at risk right now?
--    Open, nobody has triaged it, and it has been sitting longer than 48 hours.
-- ---------------------------------------------------------------------------

select
  number,
  left(title, 70) as title,
  author_login,
  age_hours,
  comment_count,
  label_names
from issue_queue
where state = 'open'
  and needs_triage
  and age_hours > 48
order by age_hours desc
limit 25;

-- ---------------------------------------------------------------------------
-- 2. Time to first triage, as a distribution rather than an average.
--    Averages hide the tail, and the tail is what users complain about.
-- ---------------------------------------------------------------------------

with first_touch as (
  select
    i.id,
    i.created_at,
    min(t.created_at) as triaged_at
  from issues i
  join triage_notes t on t.issue_id = i.id
  where i.is_pull_request = false
  group by i.id, i.created_at
)
select
  count(*) as triaged_issues,
  round(percentile_cont(0.50) within group (
    order by extract(epoch from (triaged_at - created_at)) / 3600
  )::numeric, 1) as p50_hours,
  round(percentile_cont(0.90) within group (
    order by extract(epoch from (triaged_at - created_at)) / 3600
  )::numeric, 1) as p90_hours,
  round(max(extract(epoch from (triaged_at - created_at)) / 3600)::numeric, 1) as worst_hours
from first_touch;

-- ---------------------------------------------------------------------------
-- 3. Which labels are growing? Week over week, with the direction of travel.
-- ---------------------------------------------------------------------------

select week, label_name, issue_count, prev_week_count, delta
from label_volume_weekly
where week >= date_trunc('week', now()) - interval '8 weeks'
  and delta is not null
order by delta desc nulls last
limit 20;

-- ---------------------------------------------------------------------------
-- 4. Repeat reporters: who files a lot, and how much of it is still open?
--    A reporter whose issues all stay open usually means we are failing to
--    reproduce something, not that they are noisy.
-- ---------------------------------------------------------------------------

select
  a.login,
  a.association,
  count(*)                                              as filed,
  count(*) filter (where i.state = 'open')              as still_open,
  round(
    100.0 * count(*) filter (where i.state = 'open') / count(*),
    1
  )                                                     as pct_open,
  max(i.created_at)::date                               as last_filed
from issues i
join authors a on a.login = i.author_login
where i.is_pull_request = false
group by a.login, a.association
having count(*) >= 3
order by filed desc
limit 20;

-- ---------------------------------------------------------------------------
-- 5. Where the categories and the labels disagree.
--    Issues we triaged as a docs gap that nobody labelled "documentation" —
--    each row is a docs page that should exist.
-- ---------------------------------------------------------------------------

select
  q.number,
  left(q.title, 70) as title,
  q.triage_category,
  q.label_names
from issue_queue q
where q.triage_category = 'docs-gap'
  and not exists (
    select 1
    from unnest(q.label_names) as label(name)
    where label.name ilike '%doc%'
  )
order by q.created_at desc;

-- ---------------------------------------------------------------------------
-- 6. Which issues close themselves?
--    Closed with no triage note and few comments: either a duplicate the
--    reporter found, or something we never needed to touch. Worth knowing the
--    ratio before adding headcount to the queue.
-- ---------------------------------------------------------------------------

select
  date_trunc('month', closed_at)::date as month,
  count(*)                                                  as closed,
  count(*) filter (where comment_count = 0)                 as closed_silently,
  round(
    100.0 * count(*) filter (where comment_count = 0) / nullif(count(*), 0),
    1
  )                                                         as pct_silent
from issues
where state = 'closed'
  and is_pull_request = false
  and closed_at >= now() - interval '12 months'
group by 1
order by 1 desc;

-- ---------------------------------------------------------------------------
-- 7. Prior art for the issue in front of you, by label overlap.
--    Lateral join so each candidate is scored against one specific issue.
-- ---------------------------------------------------------------------------

with target as (
  select id, label_names
  from issue_queue
  where number = 12345  -- the issue you are answering
),
candidates as (
  select
    q.number,
    q.title,
    q.state,
    q.html_url,
    cardinality(
      array(select unnest(q.label_names) intersect select unnest(t.label_names))
    ) as shared_labels
  from issue_queue q
  cross join target t
  where q.id <> t.id
)
select *
from candidates
where shared_labels > 0
order by shared_labels desc, state
limit 10;

-- ---------------------------------------------------------------------------
-- 8. Proving the index earns its keep.
--    Run both and compare: the partial index turns a sequential scan over every
--    row into an index scan over just the open ones.
-- ---------------------------------------------------------------------------

explain (analyze, buffers)
select id, number, title
from issues
where state = 'open' and is_pull_request = false
order by created_at desc
limit 50;

-- The same question asked in a way the partial index cannot serve, for contrast:
explain (analyze, buffers)
select id, number, title
from issues
where lower(state) = 'open'
order by created_at desc
limit 50;
