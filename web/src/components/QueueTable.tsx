import { Fragment, useState } from 'react';
import type { QueueRow } from '../types';
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
              </td>
              <td className="reporter">
                {row.author_login ?? 'unknown'}
                {row.author_association && row.author_association !== 'NONE' && (
                  <span className="pill assoc">{row.author_association.toLowerCase()}</span>
                )}
              </td>
              <td className="labels">
                {row.label_names.length === 0 ? (
                  <span className="muted">—</span>
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
