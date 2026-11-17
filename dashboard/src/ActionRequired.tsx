import { Button } from '@mantine/core';
import { IconAlertTriangle } from '@tabler/icons-react';
import { useQuery } from '@tanstack/react-query';
import { openDecisions, workGraphsSchema } from './orchestration';
import { PanelCard } from './PanelCard';
import { PanelHeading } from './PanelHeading';
import { livePageHref } from './livePageHref';

async function loadWorkGraphs() {
  const response = await fetch('/api/v1/work-graphs');
  if (!response.ok) throw new Error(`WorkGraph actions unavailable (${response.status})`);
  return workGraphsSchema.parse(await response.json());
}

/** A central queue of current typed human decisions, linked to their existing governed resolution action. */
export function ActionRequired() {
  const graphs = useQuery({ queryKey: ['work-graphs'], queryFn: loadWorkGraphs, retry: false, refetchInterval: 5_000 });
  const actions = (graphs.data ?? []).flatMap((graph) => graph.status === 'cancelled' ? [] : openDecisions(graph).map((decision) => ({
    id: decision.id,
    objective: graph.objective_title,
    unit: decision.from,
    href: livePageHref('objectives', { objective: graph.objective_id, tab: 'plan', graph_id: graph.id, decision: decision.id }),
  })));
  if (!graphs.isError && actions.length === 0) return null;

  return <section className="action-required-region" aria-label="Action Required">
    <PanelCard className="panel action-required-panel" withBorder>
    <PanelHeading icon={<IconAlertTriangle size={16} aria-hidden="true" />} title="Action Required"
      description="Governed decisions waiting on a person" actions={actions.length ? `${actions.length} waiting` : undefined} />
    {graphs.isLoading ? <p role="status">Checking for human decisions…</p>
      : graphs.isError ? <div role="alert"><p>{graphs.error.message}</p>
        <Button size="xs" variant="default" onClick={() => void graphs.refetch()}>Retry</Button></div>
        : <ul className="action-required-list">{actions.map((action) => <li key={action.id}>
          <a href={action.href}><b>{action.objective}</b><span>Decision requested by {action.unit}</span></a>
        </li>)}</ul>}
    </PanelCard>
  </section>;
}
