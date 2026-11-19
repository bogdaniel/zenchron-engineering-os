import { Button } from '@mantine/core';
import { useLiveOrchestration } from './orchestration';
import { useMockOrchestration } from './orchestration-preview-data';
import { WorkGraphView } from './WorkGraphView';
import { livePageHref } from './livePageHref';
import type { AgentRun } from './agentsData';

function providerUsage(graphID: string, runIDs: string[], runs: AgentRun[] | undefined, loading: boolean, failed: boolean) {
  const runIDSet = new Set(runIDs);
  if (!runIDSet.size) return 'No agent runs have reported provider usage.';
  if (failed) return 'Provider usage could not be loaded.';
  if (loading) return 'Loading provider usage…';
  const linkedRuns = (runs ?? []).filter((run) => run.graph_id === graphID && runIDSet.has(run.id));
  const recorded = linkedRuns.flatMap((run) => run.usage ? [run.usage] : []);
  if (!recorded.length) return 'Provider-reported usage is unavailable for these runs.';
  const input = recorded.reduce((sum, usage) => sum + usage.input_tokens, 0);
  const output = recorded.reduce((sum, usage) => sum + usage.output_tokens, 0);
  const costs = recorded.flatMap((usage) => usage.cost_usd === undefined ? [] : [usage.cost_usd]);
  const coverage = `${recorded.length} of ${runIDSet.size} runs`;
  const reportedCost = costs.reduce((sum, value) => sum + value, 0).toFixed(2);
  const cost = costs.length ? ` · $${reportedCost} provider-reported cost for ${costs.length} run${costs.length === 1 ? '' : 's'}`
    : ' · provider cost not reported';
  return `Provider-reported usage (${coverage}): ${input.toLocaleString()} input / ${output.toLocaleString()} output tokens${cost}`;
}

/** The work graphs of a product's objectives. Mock shows the one sample graph. */
export function WorkspaceExecution({ objectiveIDs, objectivesLoading, objectivesError, sampleData, agentRuns,
  agentRunsLoading = false, agentRunsError = false }: {
  objectiveIDs: string[] | undefined; objectivesLoading: boolean; objectivesError: boolean; sampleData: boolean;
  agentRuns?: AgentRun[]; agentRunsLoading?: boolean; agentRunsError?: boolean;
}) {
  const mock = useMockOrchestration();
  const live = useLiveOrchestration(!sampleData);
  const source = sampleData ? mock : live;
  const graphs = sampleData ? source.graphs : source.graphs.filter((graph) => objectiveIDs?.includes(graph.objective_id));
  if (source.loading) return <p className="workspace-mock-empty" role="status">Loading work graphs…</p>;
  if (source.failed) return <p className="workspace-mock-empty" role="alert">Work graphs could not be loaded.
    <Button size="compact-xs" variant="subtle" onClick={source.retry}>Retry</Button></p>;
  if (!sampleData && !objectiveIDs) return objectivesError
    ? <p className="workspace-mock-empty" role="alert">Product objectives could not be loaded. WorkGraph scope is unknown.</p>
    : objectivesLoading
      ? <p className="workspace-mock-empty" role="status">Loading product objectives…</p>
      : <p className="workspace-mock-empty" role="status">Product objective scope is unavailable.</p>;
  if (!graphs.length) return <p className="workspace-mock-empty">
    No objective of this product has an approved plan. Propose one under Objectives → Plan.</p>;
  return <div className="workspace-execution">
    {source.readOnlyReason && <p className="work-unit-reason">{source.readOnlyReason}</p>}
    {graphs.map((graph) => <div key={graph.id}>
      <h3>{sampleData ? graph.objective_title : <a href={livePageHref('objectives', { objective: graph.objective_id, tab: 'plan' })}>
        {graph.objective_title}</a>}</h3>
      {!sampleData && <div aria-label={`Execution configuration for ${graph.objective_title}`}>
        {graph.workflow_id && <p>Workflow <a href={livePageHref('workflows', { workflow: graph.workflow_id })}>
          {graph.workflow_id}</a> · executed version {graph.workflow_version ?? 'unknown'}</p>}
        <ul>{graph.units.filter((unit) => unit.agent_id).map((unit) => {
          const profile = source.options.agents.find((agent) => agent.id === unit.agent_id);
          return <li key={unit.key}><a href={livePageHref('agents', { profile: unit.agent_id })}>
            {unit.agent_name || unit.agent_id}</a> · recorded profile v{unit.profile_version ?? 'unknown'}
            {unit.persona_id && <> · persona {unit.persona_id} v{unit.persona_version ?? 'unknown'}</>}
            {profile && <> · current configuration: {profile.provider} / {profile.model} · {profile.status}</>}
          </li>;
        })}</ul>
        <p className="work-unit-reason" role="status" aria-label={`Provider usage for ${graph.objective_title}`}>
          {providerUsage(graph.id, graph.units.flatMap((unit) => unit.run_ids), agentRuns, agentRunsLoading, agentRunsError)}
        </p>
      </div>}
      <WorkGraphView graph={graph} source={source} showRunLinks={!sampleData} />
    </div>)}
  </div>;
}
