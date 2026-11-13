import { Fragment, useState } from 'react';
import type { LinkedPr, QueueRow } from '../types';
import TriageForm from './TriageForm';

interface Props {
  rows: QueueRow[];
  loading: boolean;
  canTriage: boolean;
  userId: string | null;
  onTriaged: () => void;
}

function formatAge(hours: number): string {
  if (hours < 24) return `${Math.round(hours)}h`;
  const days = Math.round(hours / 24);
  if (days < 14) return `${days}d`;
  return `${Math.round(days / 7)}w`;
}

/** Anything open, untouched and older than two days is the queue's real problem. */
function isAtRisk(row: QueueRow): boolean {
  return row.state === 'open' && row.needs_triage && row.age_hours > 48;
}

/** How many waiting PRs to list before folding the rest into a count. */
const PRS_SHOWN = 4;

/**
 * Open pull requests linked to an issue. A PR that names the issue counts as
 * waiting; one only mentioned in the issue's thread is listed apart, because
 * "see #123" is not the same claim as "fixes #123".
 */
function LinkedPrs({ prs }: { prs: LinkedPr[] }) {
  if (prs.length === 0) return null;
  const waiting = prs.filter((pr) => pr.source !== 'thread');
  const mentioned = prs.filter((pr) => pr.source === 'thread');

  return (
    <div className="prs">
      {waiting.length > 0 && (
        <span className="pill pr-waiting">
          {waiting.length === 1 ? '1 PR waiting' : `${waiting.length} PRs waiting`}
        </span>
      )}
      {waiting.slice(0, PRS_SHOWN).map((pr) => (
        <a key={pr.number} href={pr.url} target="_blank" rel="noreferrer" title={pr.title}>
          #{pr.number}
          {pr.draft && ' (draft)'}
        </a>
      ))}
      {waiting.length > PRS_SHOWN && (
        <span className="muted">+{waiting.length - PRS_SHOWN} more</span>
      )}
      {mentioned.length > 0 && (
        <span className="muted">
          mentioned:{' '}
          {mentioned.map((pr) => (
            <a key={pr.number} href={pr.url} target="_blank" rel="noreferrer" title={pr.title}>
              #{pr.number}
            </a>
          ))}
        </span>
      )}
    </div>
  );
}

export default function QueueTable({ rows, loading, canTriage, userId, onTriaged }: Props) {
  const [expanded, setExpanded] = useState<number | null>(null);

  if (loading) return <p className="muted">Loading queue…</p>;
  if (rows.length === 0) return <p className="muted">Nothing matches those filters.</p>;

  return (
    <table className="queue">
      <thead>
        <tr>
          <th>Age</th>
          <th>Issue</th>
          <th>Reporter</th>
          <th>Labels</th>
          <th>Activity</th>
          <th>Triage</th>
        </tr>
      </thead>
      <tbody>
        {rows.map((row) => (
          <Fragment key={row.id}>
            <tr className={isAtRisk(row) ? 'at-risk' : undefined}>
              <td className="age">{formatAge(row.age_hours)}</td>
              <td>
                <a href={row.html_url} target="_blank" rel="noreferrer">
                  #{row.number} {row.title}
                </a>
                <span className={`pill ${row.state}`}>{row.state}</span>
                <LinkedPrs prs={row.open_prs ?? []} />
              </td>
              <td className="reporter">
                {row.author_login ?? 'unknown'}
                {row.author_association && row.author_association !== 'NONE' && (
                  <span className="pill assoc">{row.author_association.toLowerCase()}</span>
                )}
              </td>
              <td className="labels">
                {row.label_names.length === 0 ? (
                  <span className="muted">-</span>
                ) : (
                  row.label_names.map((label) => (
                    <span className="label" key={label}>
                      {label}
                    </span>
                  ))
                )}
              </td>
              <td className="activity">
                {row.comment_count} 💬 {row.reaction_count > 0 && `${row.reaction_count} 👍`}
              </td>
              <td>
                {row.triage_category ? (
                  <span className={`pill sev-${row.triage_severity}`}>
                    {row.triage_category} / {row.triage_severity}
                  </span>
                ) : (
                  <span className="muted">untriaged</span>
                )}
                {canTriage && (
                  <button
                    type="button"
                    className="ghost"
                    onClick={() => setExpanded(expanded === row.id ? null : row.id)}
                  >
                    {expanded === row.id ? 'Cancel' : 'Triage'}
                  </button>
                )}
              </td>
            </tr>

            {expanded === row.id && userId && (
              <tr className="form-row">
                <td colSpan={6}>
                  <TriageForm
                    issueId={row.id}
                    userId={userId}
                    onSaved={() => {
                      setExpanded(null);
                      onTriaged();
                    }}
                  />
                  {row.triage_note && <p className="muted">Last note: {row.triage_note}</p>}
                </td>
              </tr>
            )}
          </Fragment>
        ))}
      </tbody>
    </table>
  );
}
