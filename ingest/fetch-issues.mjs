#!/usr/bin/env node
// Mirrors GitHub issues into Supabase Postgres.
//
//   node --env-file=.env ingest/fetch-issues.mjs --repo supabase/supabase
//
// Incremental by default: it asks Postgres for the newest updated_at it already
// has and passes that to GitHub as `since`, so a re-run costs one page instead
// of two hundred. Pass --full to ignore the cursor.

import { createClient } from '@supabase/supabase-js';

const GITHUB_API = 'https://api.github.com';
const PAGE_SIZE = 100;
const CHUNK = 500; // rows per upsert request

function parseArgs(argv) {
  const args = {
    repo: 'supabase/supabase',
    maxPages: 10,
    full: false,
    since: null,
    includePrs: false,
  };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === '--repo') args.repo = argv[++i];
    else if (arg === '--max-pages') args.maxPages = Number(argv[++i]);
    else if (arg === '--since') args.since = argv[++i];
    else if (arg === '--full') args.full = true;
    else if (arg === '--include-prs') args.includePrs = true;
    else if (arg === '--help' || arg === '-h') args.help = true;
    else throw new Error(`unknown flag: ${arg}`);
  }
  if (!/^[\w.-]+\/[\w.-]+$/.test(args.repo)) {
    throw new Error(`--repo must look like owner/name, got: ${args.repo}`);
  }
  if (!Number.isInteger(args.maxPages) || args.maxPages < 1) {
    throw new Error('--max-pages must be a positive integer');
  }
  return args;
}

const USAGE = `
Usage: node --env-file=.env ingest/fetch-issues.mjs [options]

  --repo owner/name   repository to mirror      (default: supabase/supabase)
  --max-pages N       stop after N pages of 100 (default: 10)
  --since ISO8601     override the saved cursor
  --full              ignore the cursor, walk from the start
  --include-prs       store pull requests too  (default: issues only)

Environment:
  SUPABASE_URL                 project URL
  SUPABASE_SERVICE_ROLE_KEY    service role key (writes bypass RLS)
  GITHUB_TOKEN                 optional; raises the rate limit from 60 to 5000/hour
`;

function requireEnv(name) {
  const value = process.env[name];
  if (!value) {
    throw new Error(`${name} is not set. Copy .env.example to .env and fill it in.`);
  }
  return value;
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

async function githubFetch(url, token) {
  const headers = {
    accept: 'application/vnd.github+json',
    'x-github-api-version': '2022-11-28',
    'user-agent': 'triage-desk-ingest',
  };
  if (token) headers.authorization = `Bearer ${token}`;

  for (let attempt = 1; attempt <= 4; attempt += 1) {
    const response = await fetch(url, { headers });

    if (response.ok) return response;

    // Secondary rate limits come back as 403/429 with a reset timestamp.
    const remaining = response.headers.get('x-ratelimit-remaining');
    const reset = Number(response.headers.get('x-ratelimit-reset'));
    const rateLimited =
      (response.status === 403 || response.status === 429) && remaining === '0';

    if (rateLimited && Number.isFinite(reset)) {
      const waitMs = Math.max(reset * 1000 - Date.now(), 0) + 1000;
      console.warn(
        `  rate limited; sleeping ${Math.round(waitMs / 1000)}s until the window resets`,
      );
      await sleep(waitMs);
      continue;
    }

    if (response.status >= 500 && attempt < 4) {
      await sleep(attempt * 2000);
      continue;
    }

    const body = await response.text();
    throw new Error(`GitHub ${response.status} for ${url}: ${body.slice(0, 300)}`);
  }
  throw new Error(`GitHub request kept failing: ${url}`);
}

/** Resolve the incremental cursor: explicit --since, else newest row, else nothing. */
async function resolveSince(db, args) {
  if (args.full) return null;
  if (args.since) return args.since;

  const { data, error } = await db
    .from('issues')
    .select('updated_at')
    .eq('repo', args.repo)
    .order('updated_at', { ascending: false })
    .limit(1)
    .maybeSingle();

  if (error) throw new Error(`cursor lookup failed: ${error.message}`);
  return data?.updated_at ?? null;
}

function reactionCount(issue) {
  return issue.reactions?.total_count ?? 0;
}

/** GitHub's issues endpoint returns pull requests too; they carry a `pull_request` key. */
function shape(issue, repo) {
  return {
    author: issue.user && {
      login: issue.user.login,
      html_url: issue.user.html_url,
      avatar_url: issue.user.avatar_url,
      association: issue.author_association ?? null,
    },
    labels: (issue.labels ?? [])
      .filter((label) => typeof label === 'object' && label.name)
      .map((label) => ({
        name: label.name,
        color: label.color ?? null,
        description: label.description ?? null,
      })),
    issue: {
      id: issue.id,
      repo,
      number: issue.number,
      title: issue.title,
      body: issue.body ?? null,
      state: issue.state,
      state_reason: issue.state_reason ?? null,
      author_login: issue.user?.login ?? null,
      comment_count: issue.comments ?? 0,
      reaction_count: reactionCount(issue),
      is_pull_request: Boolean(issue.pull_request),
      html_url: issue.html_url,
      created_at: issue.created_at,
      updated_at: issue.updated_at,
      closed_at: issue.closed_at ?? null,
    },
  };
}

async function upsertChunked(db, table, rows, onConflict) {
  for (let i = 0; i < rows.length; i += CHUNK) {
    const slice = rows.slice(i, i + CHUNK);
    const { error } = await db.from(table).upsert(slice, { onConflict });
    if (error) throw new Error(`upsert into ${table} failed: ${error.message}`);
  }
}

function dedupeBy(rows, key) {
  const seen = new Map();
  for (const row of rows) seen.set(row[key], row);
  return [...seen.values()];
}

/** One page's worth of rows, parents before children. */
async function storeBatch(db, { authors, labels, issues, issueLabels }) {
  await upsertChunked(db, 'authors', dedupeBy(authors, 'login'), 'login');
  await upsertChunked(db, 'labels', dedupeBy(labels, 'name'), 'name');
  await upsertChunked(db, 'issues', dedupeBy(issues, 'id'), 'id');

  // Labels get removed from issues too, so replace the set rather than merge it.
  const touched = [...new Set(issues.map((issue) => issue.id))];
  for (let i = 0; i < touched.length; i += CHUNK) {
    const { error } = await db
      .from('issue_labels')
      .delete()
      .in('issue_id', touched.slice(i, i + CHUNK));
    if (error) throw new Error(`clearing issue_labels failed: ${error.message}`);
  }
  await upsertChunked(db, 'issue_labels', issueLabels, 'issue_id,label_name');
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  if (args.help) {
    console.log(USAGE.trim());
    return;
  }

  const db = createClient(
    requireEnv('SUPABASE_URL'),
    requireEnv('SUPABASE_SERVICE_ROLE_KEY'),
    { auth: { persistSession: false } },
  );
  const token = process.env.GITHUB_TOKEN;
  if (!token) {
    console.warn('GITHUB_TOKEN is not set — unauthenticated requests are capped at 60/hour.');
  }

  const since = await resolveSince(db, args);
  console.log(
    `Mirroring ${args.repo}${since ? ` updated since ${since}` : ' from the beginning'}`,
  );

  const seenAuthors = new Set();
  const seenLabels = new Set();
  let storedIssues = 0;
  let skippedPrs = 0;
  let exhausted = false;

  // GitHub refuses offset pagination past 10,000 items, so the walk cannot
  // simply page deeper. When a window runs out of pages it slides instead:
  // `since` moves to the last row fetched and paging restarts at one. That is
  // what lets --full cover a history of any size in a single run.
  const WINDOW_PAGES = 99;
  let cursor = since;
  let page = 1;
  let pagesUsed = 0;

  while (pagesUsed < args.maxPages) {
    const url = new URL(`${GITHUB_API}/repos/${args.repo}/issues`);
    url.searchParams.set('state', 'all');
    url.searchParams.set('per_page', String(PAGE_SIZE));
    url.searchParams.set('page', String(page));
    url.searchParams.set('sort', 'updated');
    url.searchParams.set('direction', 'asc');
    if (cursor) url.searchParams.set('since', cursor);

    let response;
    try {
      response = await githubFetch(url, token);
    } catch (error) {
      if (/cursor based pagination/i.test(error.message)) {
        console.log(`  offset pagination refused at page ${page}; stopping`);
        exhausted = true;
        break;
      }
      throw error;
    }

    const batch = await response.json();
    if (!Array.isArray(batch) || batch.length === 0) {
      console.log('  empty page, stopping');
      break;
    }

    const authors = [];
    const labels = [];
    const issues = [];
    const issueLabels = [];

    for (const raw of batch) {
      // The endpoint returns pull requests mixed in with issues and offers no
      // way to ask for one and not the other. The queue hides them, and on
      // supabase/supabase they outnumber issues four to one, so storing them
      // is most of the database for none of the value.
      if (raw.pull_request && !args.includePrs) {
        skippedPrs += 1;
        continue;
      }
      const { author, labels: issueLabelRows, issue } = shape(raw, args.repo);
      if (author) authors.push(author);
      for (const label of issueLabelRows) {
        labels.push(label);
        issueLabels.push({ issue_id: issue.id, label_name: label.name });
      }
      issues.push(issue);
    }

    // Written a page at a time rather than once at the end. A long walk that
    // fails partway then keeps everything it already fetched.
    if (issues.length > 0) {
      await storeBatch(db, { authors, labels, issues, issueLabels });
      storedIssues += issues.length;
      for (const author of authors) seenAuthors.add(author.login);
      for (const label of labels) seenLabels.add(label.name);
    }

    pagesUsed += 1;
    console.log(`  page ${pagesUsed}: ${batch.length} fetched, ${issues.length} stored`);
    if (batch.length < PAGE_SIZE) break;

    if (page >= WINDOW_PAGES) {
      const last = batch[batch.length - 1].updated_at;
      // Identical timestamps across a whole window would otherwise spin here.
      if (last === cursor) {
        console.log('  window did not advance, stopping');
        break;
      }
      cursor = last;
      page = 1;
      console.log(`  window slid to ${cursor}`);
    } else {
      page += 1;
    }
  }

  if (storedIssues === 0) {
    console.log(
      skippedPrs > 0
        ? `Nothing new (skipped ${skippedPrs} pull requests).`
        : 'Nothing new.',
    );
  } else {
    console.log(
      `Stored ${storedIssues} issues, ${seenAuthors.size} authors, ` +
        `${seenLabels.size} labels` +
        (skippedPrs > 0 ? `, skipped ${skippedPrs} pull requests.` : '.'),
    );
  }

  if (exhausted) {
    console.log('Re-run to continue from the new cursor.');
  }
}

main().catch((error) => {
  console.error(`\n${error.message}`);
  process.exitCode = 1;
});
