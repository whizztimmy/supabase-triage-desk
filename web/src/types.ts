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
  label: string;
  sort: 'newest' | 'oldest' | 'most-commented' | 'recently-updated';
}
