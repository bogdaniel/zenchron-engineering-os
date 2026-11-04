import type { ReactNode } from 'react';
import { Card } from '@mantine/core';

export function MetricCard({ className, valueClassName, label, value, detail, icon, trend }: {
  className: string;
  valueClassName?: string;
  label: string;
  value: ReactNode;
  detail?: ReactNode;
  icon?: ReactNode;
  trend?: ReactNode;
}) {
  const valueClasses = [valueClassName, value === 'Unavailable' && 'metric-unavailable'].filter(Boolean).join(' ');
  return (
    <Card className={`shared-metric-card ${className}`} withBorder>
      <div className="metric-top"><span>{label}</span>{icon}</div>
      {trend ? <div className="metric-value-row"><strong className={valueClasses || undefined}>{value}</strong>{trend}</div>
        : <strong className={valueClasses || undefined}>{value}</strong>}
      {detail !== undefined && <small>{detail}</small>}
    </Card>
  );
}
