import type { Filters } from '../types';

interface Props {
  filters: Filters;
  labels: string[];
  onChange: (filters: Filters) => void;
  onRefresh: () => void;
}

export default function FilterBar({ filters, labels, onChange, onRefresh }: Props) {
  return (
    <section className="filters" aria-label="Queue filters">
      <label className="check">
        <input
          type="checkbox"
          checked={filters.onlyOpen}
          onChange={(event) => onChange({ ...filters, onlyOpen: event.target.checked })}
        />
        Open only
      </label>

      <label className="check">
        <input
          type="checkbox"
          checked={filters.onlyUntriaged}
          onChange={(event) => onChange({ ...filters, onlyUntriaged: event.target.checked })}
        />
        Needs triage
      </label>

      <label className="field">
        Label
        <select
          value={filters.label}
          onChange={(event) => onChange({ ...filters, label: event.target.value })}
        >
          <option value="">any</option>
          {labels.map((label) => (
            <option key={label} value={label}>
              {label}
            </option>
          ))}
        </select>
      </label>

      <label className="field">
        Sort
        <select
          value={filters.sort}
          onChange={(event) =>
            onChange({ ...filters, sort: event.target.value as Filters['sort'] })
          }
        >
          <option value="newest">newest</option>
          <option value="oldest">oldest (most at risk)</option>
          <option value="most-commented">most commented</option>
          <option value="recently-updated">recently updated</option>
        </select>
      </label>

      <button type="button" className="ghost" onClick={onRefresh}>
        Refresh
      </button>
    </section>
  );
}
