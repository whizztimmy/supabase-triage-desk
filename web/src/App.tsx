import { useCallback, useEffect, useState } from 'react';
import type { Session } from '@supabase/supabase-js';
import { supabase } from './supabase';
import type { Filters, QueueRow, SearchRow } from './types';
import FilterBar from './components/FilterBar';
import QueueTable from './components/QueueTable';
import SearchPanel from './components/SearchPanel';
import SignIn from './components/SignIn';
import StatsBar from './components/StatsBar';

const PAGE_SIZE = 50;

const SORTS: Record<Filters['sort'], { column: string; ascending: boolean }> = {
  newest: { column: 'created_at', ascending: false },
  oldest: { column: 'created_at', ascending: true },
  'most-commented': { column: 'comment_count', ascending: false },
  'recently-updated': { column: 'updated_at', ascending: false },
};

export interface Stats {
  open: number;
  untriaged: number;
  triagedThisWeek: number;
}

export default function App() {
  const [session, setSession] = useState<Session | null>(null);
  const [filters, setFilters] = useState<Filters>({
    onlyOpen: true,
    onlyUntriaged: false,
    label: '',
    sort: 'newest',
  });
  const [labels, setLabels] = useState<string[]>([]);
  const [rows, setRows] = useState<QueueRow[]>([]);
  const [stats, setStats] = useState<Stats | null>(null);
  const [searchResults, setSearchResults] = useState<SearchRow[] | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    supabase.auth.getSession().then(({ data }) => setSession(data.session));
    const { data } = supabase.auth.onAuthStateChange((_event, next) => setSession(next));
    return () => data.subscription.unsubscribe();
  }, []);

  useEffect(() => {
    supabase
      .from('labels')
      .select('name')
      .order('name')
      .limit(300)
      .then(({ data }) => setLabels((data ?? []).map((row) => row.name as string)));
  }, []);

  const loadQueue = useCallback(async () => {
    setLoading(true);
    setError(null);

    let query = supabase.from('issue_queue').select('*');

    if (filters.onlyOpen) query = query.eq('state', 'open');
    if (filters.onlyUntriaged) query = query.eq('needs_triage', true);
    // `contains` on a text[] column becomes `label_names @> {name}` server side.
    if (filters.label) query = query.contains('label_names', [filters.label]);

    const sort = SORTS[filters.sort];
    const { data, error: queryError } = await query
      .order(sort.column, { ascending: sort.ascending })
      .limit(PAGE_SIZE);

    if (queryError) {
      setError(queryError.message);
      setRows([]);
    } else {
      setRows((data ?? []) as QueueRow[]);
    }
    setLoading(false);
  }, [filters]);

  useEffect(() => {
    void loadQueue();
  }, [loadQueue]);

  const loadStats = useCallback(async () => {
    const weekAgo = new Date(Date.now() - 7 * 24 * 3600 * 1000).toISOString();

    // head: true asks PostgREST for the count only — no rows cross the wire.
    const [open, untriaged, triaged] = await Promise.all([
      supabase
        .from('issue_queue')
        .select('id', { count: 'exact', head: true })
        .eq('state', 'open'),
      supabase
        .from('issue_queue')
        .select('id', { count: 'exact', head: true })
        .eq('state', 'open')
        .eq('needs_triage', true),
      supabase
        .from('triage_notes')
        .select('id', { count: 'exact', head: true })
        .gte('created_at', weekAgo),
    ]);

    setStats({
      open: open.count ?? 0,
      untriaged: untriaged.count ?? 0,
      triagedThisWeek: triaged.count ?? 0,
    });
  }, []);

  useEffect(() => {
    void loadStats();
  }, [loadStats]);

  const handleSearch = useCallback(
    async (term: string) => {
      if (!term.trim()) {
        setSearchResults(null);
        return;
      }
      const { data, error: rpcError } = await supabase.rpc('search_issues', {
        q: term,
        only_open: filters.onlyOpen,
        max_rows: 25,
      });
      if (rpcError) {
        setError(rpcError.message);
        setSearchResults([]);
        return;
      }
      setSearchResults((data ?? []) as SearchRow[]);
    },
    [filters.onlyOpen],
  );

  const handleTriaged = useCallback(() => {
    void loadQueue();
    void loadStats();
  }, [loadQueue, loadStats]);

  return (
    <div className="app">
      <header className="app-header">
        <div>
          <h1>Triage Desk</h1>
          <p className="subtitle">
            Public GitHub issue activity, mirrored into Postgres and queued for a first response.
          </p>
        </div>
        <SignIn session={session} />
      </header>

      <StatsBar stats={stats} />

      <SearchPanel onSearch={handleSearch} results={searchResults} />

      <FilterBar
        filters={filters}
        labels={labels}
        onChange={setFilters}
        onRefresh={() => {
          void loadQueue();
          void loadStats();
        }}
      />

      {error && <p className="error">{error}</p>}

      <QueueTable
        rows={rows}
        loading={loading}
        canTriage={Boolean(session)}
        userId={session?.user.id ?? null}
        onTriaged={handleTriaged}
      />
    </div>
  );
}
