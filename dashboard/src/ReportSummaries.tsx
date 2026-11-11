import { IconActivity, IconCode, IconDatabase, IconFolders, IconInfinity, IconPuzzle, IconStack } from '@tabler/icons-react';
import { Table } from '@mantine/core';
import type { ReactNode } from 'react';
import { PanelCard } from './PanelCard';
import { PanelHeading } from './PanelHeading';

export interface DeliveryMetrics {
  deliveryVelocity: number | undefined;
  cycleTime: number | undefined;
  ciDuration: number | undefined;
  acceptanceRate: number | undefined;
  autonomousCompletion: number | undefined;
}

export interface ProductDeliverySummary extends DeliveryMetrics {
  id: string;
  name: string;
  recordType: 'Product' | 'Unassigned repositories';
  repositories: number | undefined;
  objectives: number | undefined;
  runs: number | undefined;
}

interface WorkspaceDeliverySummary {
  name: string;
  workItems: number;
  deliveryVelocity: number | undefined;
  cycleTime: number | undefined;
  acceptanceRate: number | undefined;
  autonomousCompletion: number | undefined;
}

function show(value: number | undefined, unit = ''): ReactNode {
  return value === undefined
    ? <abbr className="report-unavailable" aria-label="Unavailable" title="Unavailable">N/A</abbr>
    : `${value.toLocaleString(undefined, { maximumFractionDigits: 1 })}${unit}`;
}

const previewRowIcons: Record<string, ReactNode> = {
  'Core Product': <IconStack className="reports-preview-row-icon violet" size={12} aria-hidden="true" />,
  'AI Platform': <IconInfinity className="reports-preview-row-icon teal" size={12} aria-hidden="true" />,
  'Developer Tools': <IconCode className="reports-preview-row-icon violet" size={12} aria-hidden="true" />,
  Integrations: <IconPuzzle className="reports-preview-row-icon gold" size={12} aria-hidden="true" />,
  Platform: <IconActivity className="reports-preview-row-icon violet" size={12} aria-hidden="true" />,
  Product: <IconStack className="reports-preview-row-icon violet" size={12} aria-hidden="true" />,
  Infrastructure: <IconCode className="reports-preview-row-icon teal" size={12} aria-hidden="true" />,
  Data: <IconDatabase className="reports-preview-row-icon violet" size={12} aria-hidden="true" />,
};

export function ProductSummaryPanel({ rows, loading, error, checkoutCount, designPreview = false }: {
  rows: ProductDeliverySummary[];
  loading: boolean;
  error: boolean;
  checkoutCount: number | undefined;
  designPreview?: boolean;
}) {
  return <PanelCard className="reports-panel product-summary-panel" withBorder>
    <PanelHeading className="reports-panel-heading" icon={<IconFolders size={15} />} title="Product Summary"
      description="Delivery metrics for the selected report scope" />
    {loading ? <div className="reports-empty">Loading product summaries…</div>
      : error ? <div className="reports-empty">Product data unavailable.</div>
        : rows.length ? <div className="report-summary-table-wrap" role="region"
          aria-label="Product delivery summary table" tabIndex={0}>
          <Table className="report-summary-table" aria-label="Product delivery summary">
            <Table.Thead><Table.Tr>
              <Table.Th>Product</Table.Th><Table.Th>Velocity</Table.Th><Table.Th>Cycle time</Table.Th>
              <Table.Th>CI duration</Table.Th><Table.Th>Accept rate</Table.Th><Table.Th>Auto. comp.</Table.Th>
            </Table.Tr></Table.Thead>
            <Table.Tbody>{rows.map((row) => <Table.Tr className={row.id === 'total' ? 'report-summary-total' : undefined} key={row.id}>
              <Table.Td><span className="reports-preview-row-label">{designPreview && previewRowIcons[row.name]}{row.name}</span></Table.Td>
              <Table.Td>{show(row.deliveryVelocity, ' / wk')}</Table.Td>
              <Table.Td>{show(row.cycleTime, ' h')}</Table.Td>
              <Table.Td>{show(row.ciDuration, ' min')}</Table.Td>
              <Table.Td>{show(row.acceptanceRate, '%')}</Table.Td>
              <Table.Td title={designPreview ? undefined : 'Agent runs do not record autonomous-completion evidence.'}>
                {show(row.autonomousCompletion, '%')}
              </Table.Td>
            </Table.Tr>)}</Table.Tbody>
          </Table>
        </div> : <div className="reports-empty">No products are configured. {checkoutCount ?? 0} local
          {checkoutCount === 1 ? ' checkout is' : ' checkouts are'} available to group.</div>}
  </PanelCard>;
}

export function WorkspaceSummaryPanel({ workItems, metrics, rows, designPreview = false }: {
  workItems: number | undefined;
  metrics: DeliveryMetrics;
  rows?: WorkspaceDeliverySummary[];
  designPreview?: boolean;
}) {
  return <PanelCard className="reports-panel inventory-panel" withBorder>
    <PanelHeading className="reports-panel-heading" icon={<IconStack size={15} />} title="Workspace Summary"
      description="Objectives and delivery in the selected scope" />
    <div className="report-summary-table-wrap" role="region"
      aria-label="Workspace delivery summary table" tabIndex={0}>
      <Table className="report-summary-table" aria-label="Workspace delivery summary">
        <Table.Thead><Table.Tr>
          <Table.Th>Workspace</Table.Th><Table.Th>Work items</Table.Th><Table.Th>Velocity</Table.Th>
          <Table.Th>Cycle time</Table.Th><Table.Th>Accept rate</Table.Th><Table.Th>Auto. comp.</Table.Th>
        </Table.Tr></Table.Thead>
        <Table.Tbody>{rows?.length ? rows.map((row) => <Table.Tr className={row.name === 'Total / Avg.' ? 'report-summary-total' : undefined} key={row.name}>
          <Table.Td><span className="reports-preview-row-label">{designPreview && previewRowIcons[row.name]}{row.name}</span></Table.Td><Table.Td>{row.workItems.toLocaleString()}</Table.Td>
          <Table.Td>{show(row.deliveryVelocity, ' / wk')}</Table.Td><Table.Td>{show(row.cycleTime, ' h')}</Table.Td>
          <Table.Td>{show(row.acceptanceRate, '%')}</Table.Td><Table.Td>{show(row.autonomousCompletion, '%')}</Table.Td>
        </Table.Tr>) : <Table.Tr>
          <Table.Td>Local workspace</Table.Td><Table.Td>{workItems ?? 'Unavailable'}</Table.Td>
          <Table.Td>{show(metrics.deliveryVelocity, ' / wk')}</Table.Td><Table.Td>{show(metrics.cycleTime, ' h')}</Table.Td>
          <Table.Td>{show(metrics.acceptanceRate, '%')}</Table.Td>
          <Table.Td title="Agent runs do not record autonomous-completion evidence.">{show(metrics.autonomousCompletion, '%')}</Table.Td>
        </Table.Tr>}</Table.Tbody>
      </Table>
    </div>
    {!designPreview && <p className="inventory-footnote">Work items count objectives. Delivery metrics use GitHub history; autonomy requires
      run evidence.</p>}
  </PanelCard>;
}
