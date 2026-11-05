import type { ReactNode } from 'react';
import { IconChartBar } from '@tabler/icons-react';
import { PanelCard } from './PanelCard';
import { PanelHeading } from './PanelHeading';

export function ChartLegend({ items }: { items: { tone: string; label: string }[] }) {
  return <div className="reports-chart-legend" role="group" aria-label="Chart legend">
    {items.map(({ tone, label }) => <span key={label}><i className={`reports-legend-dot ${tone}`} />{label}</span>)}
  </div>;
}

export function ReportOutcomeLegend({ items }: { items: { name: string; value: number; color: string }[] }) {
  return <div className="report-outcome-legend" role="group" aria-label="Pull request outcomes legend">
    {items.map(({ name, value, color }) => <div key={name}>
      <i className="report-outcome-dot" style={{ backgroundColor: color }} />
      <span>{name}</span><b>{value}</b>
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
