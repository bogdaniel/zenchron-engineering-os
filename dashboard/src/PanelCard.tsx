import { Card } from '@mantine/core';
import type { CardProps } from '@mantine/core';

export function PanelCard({ className, id, ...props }: CardProps & { id?: string }) {
  return <Card {...props} id={id} className={`shared-panel-surface${className ? ` ${className}` : ''}`} />;
}
