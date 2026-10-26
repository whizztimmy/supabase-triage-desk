-- Development reset: drops everything 0001 and 0002 create, so the migrations
-- can be re-run from clean while iterating. Never run this against a database
-- that holds triage notes you want to keep.

begin;

drop view if exists label_volume_weekly;
drop view if exists issue_queue;

drop function if exists search_issues(text, boolean, integer);

drop table if exists triage_notes;
drop table if exists issue_labels;
drop table if exists issues;
drop table if exists labels;
drop table if exists authors;

drop type if exists triage_severity;
drop type if exists triage_category;

commit;
