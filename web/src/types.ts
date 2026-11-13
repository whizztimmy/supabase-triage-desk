export type TriageCategory =
  | 'bug'
  | 'how-to'
  | 'docs-gap'
  | 'feature-request'
  | 'billing'
  | 'needs-repro'
  | 'upstream-postgres'
  | 'not-an-issue';

export type TriageSeverity = 'blocker' | 'high' | 'normal' | 'low';

export const CATEGORIES: TriageCategory[] = [
  'bug',
  'how-to',
  'docs-gap',
  'feature-request',
  'billing',
  'needs-repro',
  'upstream-postgres',
  'not-an-issue',
];

export const SEVERITIES: TriageSeverity[] = ['blocker', 'high', 'normal', 'low'];

/** One row of the `issue_queue` view. */
export interface QueueRow {
  id: number;
  repo: string;
  number: number;
  title: string;
  state: 'open' | 'closed';
  html_url: string;
  author_login: string | null;
  author_association: string | null;
  comment_count: number;
  reaction_count: number;
  created_at: string;
  updated_at: string;
  age_hours: number;
  label_names: string[];
  triage_category: TriageCategory | null;
  triage_severity: TriageSeverity | null;
  triage_note: string | null;
  triaged_at: string | null;
  needs_triage: boolean;
  open_prs: LinkedPr[];
  /** True when at least one open PR names this issue in its own title or body. */
  fix_waiting: boolean;
}

/**
 * An open pull request linked to an issue. `source` says how the link was found:
 * the PR names the issue (`pr_text`), only the issue's thread names the PR
 * (`thread`, which is looser), or each names the other (`both`).
 */
export interface LinkedPr {
  number: number;
  title: string;
  url: string;
  author: string | null;
  draft: boolean;
  source: 'pr_text' | 'thread' | 'both';
}

/** One row returned by the `search_issues` function. */
export interface SearchRow {
  id: number;
  repo: string;
  number: number;
  title: string;
  state: 'open' | 'closed';
  html_url: string;
  created_at: string;
  comment_count: number;
  rank: number;
  snippet: string;
}

export interface Filters {
  onlyOpen: boolean;
  onlyUntriaged: boolean;
  onlyFixWaiting: boolean;
  label: string;
  sort: 'newest' | 'oldest' | 'most-commented' | 'recently-updated';
}
