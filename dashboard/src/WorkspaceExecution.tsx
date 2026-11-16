import { Button } from '@mantine/core';
import { useLiveOrchestration } from './orchestration';
import { useMockOrchestration } from './orchestration-preview-data';
import { WorkGraphView } from './WorkGraphView';

/** The work graphs of a product's objectives. Mock shows the one sample graph. */
export function WorkspaceExecution({ objectiveIDs, sampleData }: { objectiveIDs: string[]; sampleData: boolean }) {
  const mock = useMockOrchestration();
  const live = useLiveOrchestration(!sampleData);
  const source = sampleData ? mock : live;
  const graphs = sampleData ? source.graphs : source.graphs.filter((graph) => objectiveIDs.includes(graph.objective_id));
  if (source.loading) return <p className="workspace-mock-empty" role="status">Loading work graphs…</p>;
  if (source.failed) return <p className="workspace-mock-empty" role="alert">Work graphs could not be loaded.
    <Button size="compact-xs" variant="subtle" onClick={source.retry}>Retry</Button></p>;
  if (!graphs.length) return <p className="workspace-mock-empty">
    No objective of this product has an approved plan. Propose one under Objectives → Plan.</p>;
  return <div className="workspace-execution">
    {source.readOnlyReason && <p className="work-unit-reason">{source.readOnlyReason}</p>}
    {graphs.map((graph) => <div key={graph.id}>
      <h3>{sampleData ? graph.objective_title : <a href={`?objective=${encodeURIComponent(graph.objective_id)}&tab=plan#objectives`}>
        {graph.objective_title}</a>}</h3>
      {!sampleData && <div aria-label={`Execution configuration for ${graph.objective_title}`}>
        {graph.workflow_id && <p>Workflow <a href={`?workflow=${encodeURIComponent(graph.workflow_id)}#workflows`}>
          {graph.workflow_id}</a> · executed version {graph.workflow_version ?? 'unknown'}</p>}
        <ul>{graph.units.filter((unit) => unit.agent_id).map((unit) => {
          const profile = source.options.agents.find((agent) => agent.id === unit.agent_id);
          return <li key={unit.key}><a href={`?profile=${encodeURIComponent(unit.agent_id)}#agents`}>
            {unit.agent_name || unit.agent_id}</a> · recorded profile v{unit.profile_version ?? 'unknown'}
            {unit.persona_id && <> · persona {unit.persona_id} v{unit.persona_version ?? 'unknown'}</>}
            {profile && <> · current configuration: {profile.provider} / {profile.model} · {profile.status}</>}
          </li>;
        })}</ul>
      </div>}
      <WorkGraphView graph={graph} source={source} />
    </div>)}
  </div>;
}
