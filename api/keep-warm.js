// Keeps the free Supabase project from pausing, from Vercel rather than GitHub.
//
// The GitHub Actions workflow in .github/workflows/keep-warm.yml does the same
// job, but it only runs while the account's Actions are not locked, and from
// 5 November 2026 they were. This function is the second, independent path:
// vercel.json schedules it as a Vercel Cron Job.
//
// The Hobby plan allows a cron job to run once a day, at a time that can drift
// by up to an hour, so each run makes several different reads rather than one.
// Supabase's docs say "a few user requests to the database each day over the
// previous week" typically keeps a free project active.
//
// It reads with the public anon key, the same one shipped in the browser
// bundle, through the same public-read RLS policies the dashboard uses. It can
// only read what any visitor can, so the endpoint needs no secret.

const READS = [
  'issues?select=id&limit=1',
  'issue_queue?select=id&state=eq.open&limit=1',
  'labels?select=name&limit=1',
  'issue_prs?select=issue_id&limit=1',
];

export async function GET() {
  const url = process.env.VITE_SUPABASE_URL;
  const key = process.env.VITE_SUPABASE_ANON_KEY;
  if (!url || !key) {
    return Response.json(
      { ok: false, error: 'VITE_SUPABASE_URL or VITE_SUPABASE_ANON_KEY is not set for this deployment' },
      { status: 500 },
    );
  }

  const results = [];
  for (const path of READS) {
    try {
      const r = await fetch(`${url}/rest/v1/${path}`, { headers: { apikey: key } });
      results.push({ path, status: r.status });
    } catch (e) {
      // A paused project loses its DNS record, so the fetch itself throws.
      results.push({ path, status: 0, error: e.cause?.code || e.message });
    }
  }

  const ok = results.every((r) => r.status === 200);
  // 502 makes a failed run stand out in the Vercel logs and cron history.
  return Response.json({ ok, at: new Date().toISOString(), results }, { status: ok ? 200 : 502 });
}
