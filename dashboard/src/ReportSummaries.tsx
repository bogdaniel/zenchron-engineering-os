import { IconFolders, IconStack } from '@tabler/icons-react';
import { Table } from '@mantine/core';
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

function show(value: number | undefined, unit = '') {
  return value === undefined ? 'Unavailable' : `${value.toLocaleString(undefined, { maximumFractionDigits: 1 })}${unit}`;
}

export function ProductSummaryPanel({ rows, loading, error, checkoutCount }: {
  rows: ProductDeliverySummary[];
  loading: boolean;
  error: boolean;
  checkoutCount: number | undefined;
}) {
  return <PanelCard className="reports-panel product-summary-panel" withBorder>
    <PanelHeading className="reports-panel-heading" icon={<IconFolders size={15} />} title="Product summary"
      description="Delivery metrics for the selected report scope" />
    {loading ? <div className="reports-empty">Loading product summaries…</div>
      : error ? <div className="reports-empty">Product data unavailable.</div>
        : rows.length ? <div className="report-summary-table-wrap">
          <Table className="report-summary-table" aria-label="Product delivery summary">
            <Table.Thead><Table.Tr>
              <Table.Th>Product</Table.Th><Table.Th>Velocity</Table.Th><Table.Th>Cycle time</Table.Th>
              <Table.Th>CI duration</Table.Th><Table.Th>Accept rate</Table.Th><Table.Th>Auto. comp.</Table.Th>
            </Table.Tr></Table.Thead>
            <Table.Tbody>{rows.map((row) => <Table.Tr key={row.id}>
              <Table.Td>{row.name}</Table.Td>
              <Table.Td>{show(row.deliveryVelocity, ' / wk')}</Table.Td>
              <Table.Td>{show(row.cycleTime, ' h')}</Table.Td>
              <Table.Td>{show(row.ciDuration, ' min')}</Table.Td>
              <Table.Td>{show(row.acceptanceRate, '%')}</Table.Td>
              <Table.Td title="Agent runs do not record autonomous-completion evidence.">
                {show(row.autonomousCompletion, '%')}
              </Table.Td>
            </Table.Tr>)}</Table.Tbody>
          </Table>
        </div> : <div className="reports-empty">No products are configured. {checkoutCount ?? 0} local
          {checkoutCount === 1 ? ' checkout is' : ' checkouts are'} available to group.</div>}
  </PanelCard>;
}

export function WorkspaceSummaryPanel({ workItems, metrics }: {
  workItems: number | undefined;
  metrics: DeliveryMetrics;
}) {
  return <PanelCard className="reports-panel inventory-panel" withBorder>
    <PanelHeading className="reports-panel-heading" icon={<IconStack size={15} />} title="Workspace summary"
      description="Objectives and delivery in the selected scope" />
    <div className="report-summary-table-wrap">
      <Table className="report-summary-table" aria-label="Workspace delivery summary">
        <Table.Thead><Table.Tr>
          <Table.Th>Workspace</Table.Th><Table.Th>Work items</Table.Th><Table.Th>Velocity</Table.Th>
          <Table.Th>Cycle time</Table.Th><Table.Th>Accept rate</Table.Th><Table.Th>Auto. comp.</Table.Th>
        </Table.Tr></Table.Thead>
        <Table.Tbody><Table.Tr>
          <Table.Td>Local workspace</Table.Td><Table.Td>{workItems ?? 'Unavailable'}</Table.Td>
          <Table.Td>{show(metrics.deliveryVelocity, ' / wk')}</Table.Td>
          <Table.Td>{show(metrics.cycleTime, ' h')}</Table.Td>
          <Table.Td>{show(metrics.acceptanceRate, '%')}</Table.Td>
          <Table.Td title="Agent runs do not record autonomous-completion evidence.">
            {show(metrics.autonomousCompletion, '%')}
          </Table.Td>
        </Table.Tr></Table.Tbody>
      </Table>
    </div>
    <p className="inventory-footnote">Work items count objectives. Delivery metrics use GitHub history; autonomy requires
      run evidence.</p>
  </PanelCard>;
}
