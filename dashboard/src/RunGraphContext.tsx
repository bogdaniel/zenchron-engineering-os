import type { AgentRun } from './agentsData';
import { useLiveOrchestration } from './orchestration';
import { GraphMessages, StateBadge } from './WorkGraphView';

/**
 * Says which objective and work unit a run belongs to. For the integration run it shows the review verdicts and
 * findings of the whole graph beside the combined diff. Runs started directly render nothing.
 */
export function RunGraphContext({ run }: { run: AgentRun }) {
  const source = useLiveOrchestration(Boolean(run.graph_id));
  if (!run.graph_id) return null;
  const graph = source.graphs.find((item) => item.id === run.graph_id);
  if (!graph) return <p className="run-graph-context" role="status">
    {source.failed ? 'The work graph of this run could not be loaded.' : 'Loading the work graph of this run…'}</p>;
  const reviews = graph.units.filter((unit) => unit.kind === 'review');
  const evidence = graph.messages.filter((message) => message.type === 'finding'
    || (message.type === 'state_update' && reviews.some((unit) => unit.key === message.from)));
  return <section className="run-graph-context" aria-label="Objective context of this run">
    <b>{run.merge?.length ? `Integrated candidate of "${graph.objective_title}"` : `Unit ${run.unit_key} of "${graph.objective_title}"`}</b>
    <StateBadge state={graph.status} />
    {run.merge?.length ? <>
      <p>Combines {run.merge.map((input) => input.commit.slice(0, 7)).join(' + ')}.
        {reviews.length ? ` Reviews: ${reviews.map((unit) => `${unit.key} ${unit.verdict || unit.state}`).join(', ')}.` : ' No review unit in this plan.'}</p>
      <GraphMessages messages={evidence} />
    </> : null}
  </section>;
}
