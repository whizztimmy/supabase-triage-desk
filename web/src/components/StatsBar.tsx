import type { Stats } from '../App';

interface Props {
  stats: Stats | null;
}

export default function StatsBar({ stats }: Props) {
  const tiles = [
    { label: 'Open issues', value: stats?.open },
    { label: 'Awaiting first triage', value: stats?.untriaged },
    { label: 'Triaged this week', value: stats?.triagedThisWeek },
  ];

  return (
    <section className="stats" aria-label="Queue summary">
      {tiles.map((tile) => (
        <div className="stat" key={tile.label}>
          <span className="stat-value">{tile.value ?? '—'}</span>
          <span className="stat-label">{tile.label}</span>
        </div>
      ))}
    </section>
  );
}
