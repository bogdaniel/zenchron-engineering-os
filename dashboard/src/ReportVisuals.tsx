import type { ReactNode } from 'react';
import { IconChartBar } from '@tabler/icons-react';
import type { AgentRun } from './agents';
import { PanelCard } from './PanelCard';
import { PanelHeading } from './PanelHeading';

export const runStatuses = [
  { value: 'succeeded', label: 'Succeeded', color: 'teal.5' },
  { value: 'running', label: 'Running', color: 'blue.5' },
  { value: 'queued', label: 'Queued', color: 'violet.5' },
  { value: 'failed', label: 'Failed', color: 'red.5' },
  { value: 'cancelled', label: 'Cancelled', color: 'gray.5' },
] as const;

export function ChartLegend({ items }: { items: { tone: string; label: string }[] }) {
  return <div className="reports-chart-legend" role="group" aria-label="Chart legend">
    {items.map(({ tone, label }) => <span key={label}><i className={`reports-legend-dot ${tone}`} />{label}</span>)}
  </div>;
}

export function RunOutcomeLegend({ runs }: { runs?: AgentRun[] }) {
  return <div className="run-outcome-legend" role="group" aria-label="Agent run outcomes legend">
    {runStatuses.map((status) => <div key={status.value}>
      <i className={`run-outcome-dot ${status.value}`} />
      <span>{status.label}</span><b>{runs === undefined ? '—' : runs.filter((run) => run.status === status.value).length}</b>
    </div>)}
  </div>;
}

export function UnavailableMetricsPanel({ className, title, icon, detail }: {
  className: string;
  title: string;
  icon: ReactNode;
  detail: string;
}) {
  return (
    <PanelCard className={`reports-panel ${className}`} withBorder>
      <PanelHeading className="reports-panel-heading" icon={icon} title={title} />
      <UnavailableChart detail="Connect a source to view this chart" />
      <p className="delivery-note">{detail}</p>
    </PanelCard>
  );
}

export function UnavailableChart({ detail }: { detail: string }) {
  return (
    <div className="reports-empty-chart" role="status" aria-label={detail}>
      <div className="reports-empty-chart-grid" aria-hidden="true" />
      <span><IconChartBar size={15} />{detail}</span>
    </div>
  );
}
