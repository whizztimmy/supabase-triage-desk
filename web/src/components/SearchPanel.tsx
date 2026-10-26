import { useState } from 'react';
import type { SearchRow } from '../types';

interface Props {
  onSearch: (term: string) => Promise<void>;
  results: SearchRow[] | null;
}

/**
 * "Has anyone reported this before?" — ranked full text search against the
 * mirror, so a duplicate gets a link to the existing thread instead of a new one.
 */
export default function SearchPanel({ onSearch, results }: Props) {
  const [term, setTerm] = useState('');
  const [busy, setBusy] = useState(false);

  const run = async () => {
    setBusy(true);
    await onSearch(term);
    setBusy(false);
  };

  return (
    <section className="search" aria-label="Prior art search">
      <form
        className="search-form"
        onSubmit={(event) => {
          event.preventDefault();
          void run();
        }}
      >
        <input
          type="search"
          value={term}
          placeholder='Prior art: "connection pool timeout", "rls policy recursion"…'
          onChange={(event) => setTerm(event.target.value)}
        />
        <button type="submit" disabled={busy}>
          {busy ? 'Searching…' : 'Search'}
        </button>
        {results && (
          <button
            type="button"
            className="ghost"
            onClick={() => {
              setTerm('');
              void onSearch('');
            }}
          >
            Clear
          </button>
        )}
      </form>

      {results && (
        <div className="search-results">
          {results.length === 0 ? (
            <p className="muted">No prior thread matches that.</p>
          ) : (
            <ol>
              {results.map((row) => (
                <li key={row.id}>
                  <a href={row.html_url} target="_blank" rel="noreferrer">
                    #{row.number} {row.title}
                  </a>
                  <span className={`pill ${row.state}`}>{row.state}</span>
                  <span className="muted"> · {row.comment_count} comments</span>
                  {/* ts_headline returns <b>-wrapped matches; the function is the only writer. */}
                  <p className="snippet" dangerouslySetInnerHTML={{ __html: row.snippet }} />
                </li>
              ))}
            </ol>
          )}
        </div>
      )}
    </section>
  );
}
