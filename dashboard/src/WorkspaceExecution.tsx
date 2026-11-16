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
    {graphs.map((graph) => <div key={graph.id}><h3>{graph.objective_title}</h3><WorkGraphView graph={graph} source={source} /></div>)}
  </div>;
}
