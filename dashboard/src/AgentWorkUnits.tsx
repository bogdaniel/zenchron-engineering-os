import { useLiveOrchestration } from './orchestration';
import { useMockOrchestration } from './orchestration-preview-data';
import { StateBadge } from './WorkGraphView';

/** The work units of objective plans that are assigned to one agent profile, with their current state. */
export function AgentWorkUnits({ agentID, sampleData }: { agentID: string; sampleData: boolean }) {
  const mock = useMockOrchestration();
  const live = useLiveOrchestration(!sampleData);
  const source = sampleData ? mock : live;
  const assigned = source.graphs.flatMap((graph) => graph.units.filter((unit) => unit.agent_id === agentID)
    .map((unit) => ({ graph, unit })));
  return <section className="agent-work-units" aria-label="Assigned work units">
    <b>Assigned work units</b>
    {source.loading ? <p role="status">Loading work units…</p>
      : source.failed ? <p role="alert">Work units could not be loaded.</p>
        : assigned.length ? <ul>{assigned.map(({ graph, unit }) => <li key={`${graph.id}-${unit.key}`}>
          <span title={graph.objective_title}>{graph.objective_title}</span><b>{unit.key}</b><span>{unit.kind}</span>
          <StateBadge state={unit.state} /></li>)}</ul>
          : <p>No objective plan assigns work to this profile.</p>}
  </section>;
}
