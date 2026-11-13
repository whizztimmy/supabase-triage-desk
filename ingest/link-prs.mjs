// Links open pull requests to the open issues they address, so the queue can
// show which old issues are one review away from closed.
//
// GitHub records a cross-reference on an issue only when a PR's body names it.
// The common case runs the other way: a contributor comments "opened #123 for
// this" on the issue, and GitHub files that against the PR. Checked against
// nine hand-triaged issues, cross-references alone found one of the expected
// PRs; reading both directions found all of them, plus fifteen open PRs on one
// issue that the hand triage had missed. So both directions are read here, and
// every link records which one found it.
//
// The table is rebuilt in one transaction on every run. Links are cheap to
// recompute, and a PR that merged or closed since the last run simply drops out.

import pg from 'pg';

const GRAPHQL = 'https://api.github.com/graphql';

function parseArgs(argv) {
  const args = { repo: 'supabase/supabase', dryRun: false, issue: null };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === '--repo') args.repo = argv[++i];
    else if (arg === '--dry-run') args.dryRun = true;
    else if (arg === '--issue') args.issue = Number(argv[++i]);
    else if (arg === '--help' || arg === '-h') args.help = true;
    else throw new Error(`unknown flag: ${arg}`);
  }
  if (!/^[\w.-]+\/[\w.-]+$/.test(args.repo)) {
    throw new Error(`--repo must look like owner/name, got: ${args.repo}`);
  }
  if (args.issue !== null && !Number.isInteger(args.issue)) {
    throw new Error('--issue must be an issue number');
  }
  return args;
}

const USAGE = `
Usage: node --env-file=.env ingest/link-prs.mjs [options]

  --repo owner/name   repository to link       (default: supabase/supabase)
  --dry-run           compute the links and report them, write nothing
  --issue N           with --dry-run, list the links for one issue

Environment:
  GITHUB_TOKEN    required; GitHub's GraphQL API does not accept anonymous calls
  DATABASE_URL    Postgres connection string (not needed for --dry-run)
`;

function requireEnv(name) {
  const value = process.env[name];
  if (!value) {
    throw new Error(`${name} is not set. Copy .env.example to .env and fill it in.`);
  }
  return value;
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

async function graphql(token, query, variables) {
  for (let attempt = 1; attempt <= 4; attempt += 1) {
    const response = await fetch(GRAPHQL, {
      method: 'POST',
      headers: {
        authorization: `Bearer ${token}`,
        'content-type': 'application/json',
        'user-agent': 'triage-desk-link-prs',
      },
      body: JSON.stringify({ query, variables }),
    });

    // Pages of long PR bodies occasionally time out upstream. Those are worth a
    // retry; anything else is a real error.
    if (response.status >= 500 && attempt < 4) {
      await sleep(attempt * 2000);
      continue;
    }

    const body = await response.json();
    if (!response.ok || body.errors) {
      const detail = JSON.stringify(body.errors ?? body).slice(0, 300);
      throw new Error(`GitHub GraphQL ${response.status}: ${detail}`);
    }
    return body.data;
  }
  throw new Error('GitHub GraphQL kept failing');
}

/** Every open item of one kind, a page at a time. */
async function fetchOpen(token, repo, connection, fields, pageSize) {
  const [owner, name] = repo.split('/');
  const query = `query($owner: String!, $name: String!, $after: String) {
    repository(owner: $owner, name: $name) {
      ${connection}(states: OPEN, first: ${pageSize}, after: $after) {
        pageInfo { hasNextPage endCursor }
        nodes { ${fields} }
      }
    }
  }`;

  const items = [];
  let after = null;
  do {
    const data = await graphql(token, query, { owner, name, after });
    const page = data.repository[connection];
    items.push(...page.nodes);
    after = page.pageInfo.hasNextPage ? page.pageInfo.endCursor : null;
  } while (after);
  return items;
}

function escapeRegExp(text) {
  return text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/**
 * Every issue or PR number a piece of text points at in this repository: a bare
 * `#123`, or a full issues/ or pull/ URL. The character before `#` may not be a
 * word character, `&` or `/`, which keeps out HTML entities and URL fragments.
 */
function references(text, repo) {
  const found = new Set();
  if (!text) return found;
  for (const match of text.matchAll(/(?:^|[^\w&/])#(\d{2,6})\b/g)) found.add(Number(match[1]));
  const url = new RegExp(`github\\.com/${escapeRegExp(repo)}/(?:issues|pull)/(\\d+)`, 'g');
  for (const match of text.matchAll(url)) found.add(Number(match[1]));
  return found;
}

/** issue number -> (PR number -> how the link was found). */
function linkUp(prs, issues, repo) {
  const openIssues = new Set(issues.map((issue) => issue.number));
  const openPrs = new Set(prs.map((pr) => pr.number));
  const links = new Map();

  const record = (issueNumber, prNumber, source) => {
    if (!links.has(issueNumber)) links.set(issueNumber, new Map());
    const seen = links.get(issueNumber);
    const previous = seen.get(prNumber);
    seen.set(prNumber, previous && previous !== source ? 'both' : source);
  };

  for (const pr of prs) {
    for (const number of references(`${pr.title}\n${pr.body}`, repo)) {
      if (openIssues.has(number)) record(number, pr.number, 'pr_text');
    }
  }
  for (const issue of issues) {
    const texts = [issue.body, ...issue.comments.nodes.map((comment) => comment.body)];
    for (const text of texts) {
      for (const number of references(text, repo)) {
        if (openPrs.has(number) && number !== issue.number) record(issue.number, number, 'thread');
      }
    }
  }
  return links;
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  if (args.help) {
    console.log(USAGE.trim());
    return;
  }

  const token = requireEnv('GITHUB_TOKEN');
  console.log(`Linking open pull requests to open issues in ${args.repo}`);

  const prs = await fetchOpen(
    token,
    args.repo,
    'pullRequests',
    'number title body url isDraft updatedAt author { login }',
    100,
  );
  // The last 100 comments rather than the first: a PR announced in a thread is
  // usually recent, and the PR behind an old announcement has mostly closed.
  const issues = await fetchOpen(
    token,
    args.repo,
    'issues',
    'number body comments(last: 100) { nodes { body } }',
    40,
  );
  console.log(`  ${prs.length} open pull requests, ${issues.length} open issues`);

  const links = linkUp(prs, issues, args.repo);
  const prByNumber = new Map(prs.map((pr) => [pr.number, pr]));

  let linkCount = 0;
  let threadOnly = 0;
  let named = 0;
  for (const seen of links.values()) {
    linkCount += seen.size;
    for (const source of seen.values()) if (source === 'thread') threadOnly += 1;
    if ([...seen.values()].some((source) => source !== 'thread')) named += 1;
  }
  const summary =
    `${linkCount} links across ${links.size} issues; ${named} issues have a PR that names them, ` +
    `${threadOnly} links are thread mentions only`;

  if (args.dryRun) {
    console.log(`Dry run, nothing written: ${summary}.`);
    if (args.issue !== null) {
      const seen = links.get(args.issue);
      if (!seen) console.log(`  #${args.issue}: no open pull requests linked`);
      else {
        for (const [number, source] of [...seen].sort((a, b) => a[0] - b[0])) {
          console.log(`  #${args.issue} <- #${number} (${source}) ${prByNumber.get(number).title}`);
        }
      }
    }
    return;
  }

  const client = new pg.Client({ connectionString: requireEnv('DATABASE_URL') });
  await client.connect();
  try {
    const { rows } = await client.query(
      'select id, number from issues where repo = $1 and is_pull_request = false',
      [args.repo],
    );
    const idByNumber = new Map(rows.map((row) => [Number(row.number), row.id]));

    const columns = {
      issueId: [], prNumber: [], title: [], url: [], author: [], draft: [], source: [], updatedAt: [],
    };
    let unmirrored = 0;
    for (const [issueNumber, seen] of links) {
      const issueId = idByNumber.get(issueNumber);
      // An issue opened since the last ingest has no row to point at yet.
      if (issueId === undefined) {
        unmirrored += 1;
        continue;
      }
      for (const [prNumber, source] of seen) {
        const pr = prByNumber.get(prNumber);
        columns.issueId.push(issueId);
        columns.prNumber.push(prNumber);
        columns.title.push(pr.title);
        columns.url.push(pr.url);
        columns.author.push(pr.author?.login ?? null);
        columns.draft.push(pr.isDraft);
        columns.source.push(source);
        columns.updatedAt.push(pr.updatedAt);
      }
    }

    await client.query('begin');
    await client.query(
      'delete from issue_prs where issue_id in (select id from issues where repo = $1)',
      [args.repo],
    );
    await client.query(
      `insert into issue_prs
         (issue_id, pr_number, pr_title, pr_url, pr_author, is_draft, link_source, pr_updated_at)
       select * from unnest($1::bigint[], $2::int[], $3::text[], $4::text[], $5::text[],
                            $6::boolean[], $7::text[], $8::timestamptz[])`,
      [
        columns.issueId, columns.prNumber, columns.title, columns.url,
        columns.author, columns.draft, columns.source, columns.updatedAt,
      ],
    );
    await client.query('commit');

    console.log(
      `Stored ${columns.prNumber.length} links. ${summary}` +
        (unmirrored ? `; skipped ${unmirrored} issues not mirrored yet (run npm run ingest first).` : '.'),
    );
  } catch (error) {
    await client.query('rollback').catch(() => {});
    throw error;
  } finally {
    await client.end();
  }
}

main().catch((error) => {
  console.error(`\n${error.message}`);
  process.exitCode = 1;
});
