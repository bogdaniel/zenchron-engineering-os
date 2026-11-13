import { IconChartBar } from '@tabler/icons-react';

export function ChartLegend({ items }: { items: { tone: string; label: string }[] }) {
  return <div className="reports-chart-legend" role="group" aria-label="Chart legend">
    {items.map(({ tone, label }) => <span key={label}><i className={`reports-legend-dot ${tone}`} />{label}</span>)}
  </div>;
}

export function ReportOutcomeLegend({ items, valueSuffix = '', label }: {
  items: { name: string; value: number; color: string }[];
  valueSuffix?: string;
  label: string;
}) {
  return <div className="report-outcome-legend" role="group" aria-label={label}>
    {items.map(({ name, value, color }) => <div key={name}>
      <i className="report-outcome-dot" style={{ backgroundColor: color }} />
      <span>{name}</span><b>{value}{valueSuffix}</b>
    </div>)}
  </div>;
}

/** The plot area of a chart that has nothing to draw, with the reason. */
export function UnavailableChart({ detail }: { detail: string }) {
  return (
    <div className="reports-empty-chart" role="status" aria-label={detail}>
      <div className="reports-empty-chart-grid" aria-hidden="true" />
      <span><IconChartBar size={15} />{detail}</span>
    </div>
  );
}
