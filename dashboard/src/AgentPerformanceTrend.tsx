import { BarChart } from '@mantine/charts';
import { PanelCard } from './PanelCard';
import { PanelHeading } from './PanelHeading';
import { THIRTY_DAYS_MS } from './runMetrics';

type RunOutcome = { created_at: string; status: string };

function runTrend(runs: RunOutcome[], now = Date.now()) {
  const dayMs = 24 * 60 * 60 * 1000;
  const start = now - THIRTY_DAYS_MS;
  const days = Array.from({ length: Math.ceil(THIRTY_DAYS_MS / dayMs) }, (_, index) => ({
    day: new Date(start + index * dayMs).toLocaleDateString(undefined, { month: 'short', day: 'numeric' }),
    succeeded: 0,
    failed: 0,
    other: 0,
  }));
  for (const run of runs) {
    const createdAt = Date.parse(run.created_at);
    if (!Number.isFinite(createdAt) || createdAt < start || createdAt > now) continue;
    const bucket = days[Math.min(days.length - 1, Math.floor((createdAt - start) / dayMs))];
    if (run.status === 'succeeded') bucket.succeeded++;
    else if (run.status === 'failed') bucket.failed++;
    else bucket.other++;
  }
  return days;
}

export function AgentPerformanceTrend({ runs, isLoading, isError }: {
  runs: RunOutcome[];
  isLoading: boolean;
  isError: boolean;
}) {
  const trend = runTrend(runs);
  const totals = trend.reduce((sum, day) => ({
    succeeded: sum.succeeded + day.succeeded,
    failed: sum.failed + day.failed,
    other: sum.other + day.other,
  }), { succeeded: 0, failed: 0, other: 0 });
  const chartLabel = `${totals.succeeded} successful, ${totals.failed} failed, and ${totals.other} other agent runs`
    + ' in the last 30 days';

  return <PanelCard className="agents-trend-panel" withBorder>
    <PanelHeading className="agents-panel-heading agents-trend-heading" title="Performance trends"
      description="Run outcomes · last 30 days" />
    {isLoading ? <div className="agents-trend-empty">Loading performance data…</div>
      : isError ? <div className="agents-trend-empty">Performance data is unavailable.</div>
        : runs.length ? <>
          <div className="agents-trend-summary" aria-label="Recorded run outcomes">
            {totals.succeeded} succeeded · {totals.failed} failed · {totals.other} other
          </div>
          <BarChart
            className="agents-trend-chart"
            h={82}
            data={trend}
            dataKey="day"
            type="stacked"
            series={[
              { name: 'succeeded', label: 'Succeeded', color: 'teal.5' },
              { name: 'failed', label: 'Failed', color: 'red.5' },
              { name: 'other', label: 'Other', color: 'violet.5' },
            ]}
            xAxisProps={{ interval: 5 }}
            withYAxis={false}
            withLegend={false}
            aria-label={chartLabel}
          />
        </> : <div className="agents-trend-empty">No runs recorded for this profile in the last 30 days.</div>}
  </PanelCard>;
}
