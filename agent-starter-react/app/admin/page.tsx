import type { Metadata } from 'next';
import { type CallRecord, type CostBreakdown, PRICING, estimateCost } from '@/lib/pricing';
import { redis } from '@/lib/redis';

export const dynamic = 'force-dynamic';
export const metadata: Metadata = { title: 'Usage dashboard' };

const RECENT_CALLS = 200;

const PROVIDERS: { key: Exclude<keyof CostBreakdown, 'total'>; label: string }[] = [
  { key: 'avatar', label: 'Avatar (Simli / Anam)' },
  { key: 'claude', label: 'Claude (conversation, files, memory)' },
  { key: 'webSearch', label: 'Claude web search' },
  { key: 'livekit', label: 'LiveKit Cloud (agent)' },
  { key: 'cartesia', label: 'Cartesia (voice)' },
  { key: 'deepgram', label: 'Deepgram (speech-to-text)' },
];

const LANGUAGE_LABELS: Record<string, string> = {
  en: 'English',
  hi: 'Hindi',
  ta: 'Tamil',
  ml: 'Malayalam',
};

const usd = (value: number) =>
  value.toLocaleString('en-US', {
    style: 'currency',
    currency: 'USD',
    minimumFractionDigits: value < 1 ? 3 : 2,
    maximumFractionDigits: value < 1 ? 3 : 2,
  });

const minutes = (seconds: number) => `${(seconds / 60).toFixed(1)} min`;

async function loadCalls(): Promise<CallRecord[] | null> {
  if (!redis) {
    return null;
  }
  // @upstash/redis parses JSON values automatically.
  return redis.lrange<CallRecord>('calls', 0, RECENT_CALLS - 1);
}

function StatTile({ label, value, note }: { label: string; value: string; note?: string }) {
  return (
    <div className="rounded-xl border p-4">
      <p className="text-muted-foreground text-xs font-medium">{label}</p>
      <p className="text-foreground mt-1 text-2xl font-semibold tabular-nums">{value}</p>
      {note && <p className="text-muted-foreground mt-1 text-xs">{note}</p>}
    </div>
  );
}

export default async function AdminPage() {
  const calls = await loadCalls();

  if (calls === null) {
    return (
      <main className="mx-auto max-w-5xl px-4 py-24">
        <h1 className="text-foreground text-xl font-semibold">Usage dashboard</h1>
        <p className="text-muted-foreground mt-2">
          No database is configured. Connect Upstash Redis to this Vercel project to start recording
          calls.
        </p>
      </main>
    );
  }

  const completed = calls.filter((call) => call.status === 'ok');
  const busy = calls.length - completed.length;
  const costs = completed.map(estimateCost);
  const totalSeconds = completed.reduce((sum, call) => sum + call.duration_s, 0);
  const totalCost = costs.reduce((sum, cost) => sum + cost.total, 0);
  const visitors = new Set(calls.map((call) => call.visitor_id || call.name)).size;
  const byProvider = PROVIDERS.map((provider) => ({
    ...provider,
    cost: costs.reduce((sum, cost) => sum + cost[provider.key], 0),
  })).sort((a, b) => b.cost - a.cost);
  const maxProviderCost = Math.max(...byProvider.map((p) => p.cost), 0);

  return (
    <main className="mx-auto max-w-5xl px-4 pt-24 pb-16">
      <h1 className="text-foreground text-xl font-semibold">Usage dashboard</h1>
      <p className="text-muted-foreground mt-1 text-sm">
        Last {calls.length} call{calls.length === 1 ? '' : 's'}. Costs are estimates at list prices
        (see <code>lib/pricing.ts</code>) and don&apos;t subtract free-tier allowances.
      </p>

      <section aria-label="Totals" className="mt-6 grid grid-cols-2 gap-3 md:grid-cols-5">
        <StatTile label="Calls" value={completed.length.toLocaleString()} />
        <StatTile label="Talk time" value={minutes(totalSeconds)} />
        <StatTile
          label="Estimated cost"
          value={usd(totalCost)}
          note={completed.length ? `${usd(totalCost / completed.length)} per call` : undefined}
        />
        <StatTile label="Visitors" value={visitors.toLocaleString()} />
        <StatTile label="Busy rejections" value={busy.toLocaleString()} note="Avatar plan limit" />
      </section>

      <section aria-labelledby="by-provider" className="mt-10">
        <h2 id="by-provider" className="text-foreground text-sm font-semibold">
          Estimated cost by provider
        </h2>
        <table className="mt-3 w-full text-sm">
          <tbody>
            {byProvider.map((provider) => (
              <tr key={provider.key} className="border-b last:border-b-0">
                <th scope="row" className="text-foreground w-1/3 py-2 pr-4 text-left font-normal">
                  {provider.label}
                </th>
                <td className="w-1/2 py-2 pr-4" aria-hidden>
                  <div
                    className="bg-primary h-2 rounded-r"
                    style={{
                      width: `${maxProviderCost ? (provider.cost / maxProviderCost) * 100 : 0}%`,
                      minWidth: provider.cost > 0 ? 2 : 0,
                    }}
                  />
                </td>
                <td className="text-foreground py-2 text-right tabular-nums">
                  {usd(provider.cost)}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
        <p className="text-muted-foreground mt-2 text-xs">
          Rates: Simli ${PRICING.simliPerMinute}/min, Anam ${PRICING.anamPerMinute}/min, LiveKit $
          {PRICING.livekitPerMinute}/min, Deepgram ${PRICING.deepgramPerMinute}/min, web search $
          {PRICING.webSearchPerRequest}
          /search.
        </p>
      </section>

      <section aria-labelledby="recent-calls" className="mt-10">
        <h2 id="recent-calls" className="text-foreground text-sm font-semibold">
          Recent calls
        </h2>
        <div className="mt-3 overflow-x-auto rounded-xl border">
          <table className="w-full min-w-[640px] text-sm">
            <thead className="text-muted-foreground text-left text-xs">
              <tr className="border-b">
                <th className="px-3 py-2 font-medium">Started</th>
                <th className="px-3 py-2 font-medium">Name</th>
                <th className="px-3 py-2 font-medium">Language</th>
                <th className="px-3 py-2 text-right font-medium">Duration</th>
                <th className="px-3 py-2 text-right font-medium">Searches</th>
                <th className="px-3 py-2 text-right font-medium">Files</th>
                <th className="px-3 py-2 text-right font-medium">Est. cost</th>
                <th className="px-3 py-2 font-medium">Ended</th>
              </tr>
            </thead>
            <tbody className="text-foreground">
              {calls.length === 0 && (
                <tr>
                  <td colSpan={8} className="text-muted-foreground px-3 py-6 text-center">
                    No calls recorded yet.
                  </td>
                </tr>
              )}
              {calls.map((call) => (
                <tr key={call.id} className="border-b last:border-b-0">
                  <td className="px-3 py-2 whitespace-nowrap tabular-nums">
                    {new Date(call.started_at).toLocaleString('en-IN', {
                      dateStyle: 'medium',
                      timeStyle: 'short',
                      timeZone: 'Asia/Kolkata',
                    })}
                  </td>
                  <td className="px-3 py-2">{call.name || '—'}</td>
                  <td className="px-3 py-2">{LANGUAGE_LABELS[call.language] ?? call.language}</td>
                  {call.status === 'busy' ? (
                    <td colSpan={4} className="text-muted-foreground px-3 py-2 text-right">
                      Rejected: avatar busy
                    </td>
                  ) : (
                    <>
                      <td className="px-3 py-2 text-right tabular-nums">
                        {minutes(call.duration_s)}
                      </td>
                      <td className="px-3 py-2 text-right tabular-nums">{call.searches ?? 0}</td>
                      <td className="px-3 py-2 text-right tabular-nums">{call.files ?? 0}</td>
                      <td className="px-3 py-2 text-right tabular-nums">
                        {usd(estimateCost(call).total)}
                      </td>
                    </>
                  )}
                  <td
                    className={`px-3 py-2 text-xs ${call.status === 'error' ? 'text-destructive' : 'text-muted-foreground'}`}
                    // Hover for the call's timeline.
                    title={(call.events ?? [])
                      .map((e) => {
                        const { t, event, ...info } = e;
                        const details = Object.values(info).join(', ');
                        return `${t}s ${event}${details ? `: ${details}` : ''}`;
                      })
                      .join('\n')}
                  >
                    {call.ended_by ?? '—'}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </section>
    </main>
  );
}
