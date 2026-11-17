import { useState } from 'react';
import { Button, Select } from '@mantine/core';
import { graphOfObjective, useLiveOrchestration, workflowProvenance } from './orchestration';
import type { ObjectivePlan, OrchestrationSource } from './orchestration';
import { runReadiness } from './agentRunQueue';
import { useMockOrchestration } from './orchestration-preview-data';
import { StateBadge, UnitFacts, WorkGraphView } from './WorkGraphView';
import { ObjectiveDeliveryReport } from './ObjectiveDeliveryReport';

function profileReadiness(profile: OrchestrationSource['options']['agents'][number], source: OrchestrationSource,
  projectID: string) {
  if (source.options.workersLoading) return '';
  if (source.options.workersFailed) return 'Local CLI readiness could not be checked; runs may stay queued';
  const workerID = source.options.projectWorkerIDs[projectID];
  const worker = source.options.workers.find((item) => item.id === workerID);
  if (worker?.status !== 'online') return `${profile.name}: the repository worker is not online; its run will stay queued`;
  const readiness = runReadiness(profile.provider, worker);
  return readiness.ready ? '' : `${profile.name} (${readiness.label}): ${readiness.note.replace(/\.$/, '')}`;
}

function planReadinessProblems(plan: ObjectivePlan, source: OrchestrationSource) {
  const profiles = new Map(plan.units.map((unit) => source.options.agents.find((agent) => agent.id === unit.agent_id))
    .filter((agent): agent is OrchestrationSource['options']['agents'][number] => Boolean(agent))
    .map((agent) => [agent.id, agent]));
  return [...new Set([...profiles.values()].map((profile) => profileReadiness(profile, source, plan.project_id)))]
    .filter(Boolean);
}

function PlanRevision({ plan, latest, source }: { plan: ObjectivePlan; latest: boolean; source: OrchestrationSource }) {
  const [error, setError] = useState('');
  const [approving, setApproving] = useState(false);
  async function approve() {
    setApproving(true);
    setError('');
    try {
      await source.approve?.(plan.revision);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : 'Could not approve the plan.');
    } finally {
      setApproving(false);
    }
  }
  const readinessChecking = plan.units.length > 0 && (source.options.agentsLoading || source.options.workersLoading);
  const readinessProblems = planReadinessProblems(plan, source);
  return <li className="plan-revision">
    <div className="work-graph-head"><b>Revision {plan.revision}</b><StateBadge state={plan.status} />
      {plan.approved_by && <span>approved by {plan.approved_by}</span>}
      {latest && plan.status === 'proposed' && <Button size="compact-xs" color="violet" loading={approving}
        disabled={!source.approve} title={source.readOnlyReason || undefined} onClick={() => void approve()}>
        Approve plan and start</Button>}
    </div>
    {plan.status === 'planning' && <p className="work-unit-reason" role="status">
      A planning agent is reading the repository. The proposal appears here when it finishes.</p>}
    {plan.summary && <p>{plan.summary}</p>}
    {plan.workflow_id && <p className="work-unit-reason">{workflowProvenance(plan.workflow_mode, plan.workflow_id, plan.workflow_version)}</p>}
    {plan.problems.length > 0 && <ul className="plan-problems" aria-label={`Problems in revision ${plan.revision}`}>
      {plan.problems.map((problem) => <li key={problem}>{problem}</li>)}</ul>}
    {readinessChecking && <p className="work-unit-reason" role="status">Checking current CLI readiness for assigned profiles…</p>}
    {readinessProblems.length > 0 && <p className="work-unit-reason" role="status" aria-label={`CLI readiness for revision ${plan.revision}`}>
      Current CLI readiness: {readinessProblems.join('; ')}. The plan can be approved, but its runs wait until ready.
    </p>}
    {error && <p className="work-unit-failure" role="alert">{error}</p>}
    {plan.units.length > 0 && <ul className="work-units" aria-label={`Units of revision ${plan.revision}`}>
      {plan.units.map((unit) => <li className="work-unit" key={unit.key}>
        <UnitFacts unit={unit} agent={source.agentNames[unit.agent_id] ?? ''} />
        {unit.instructions && <p className="work-unit-reason">{unit.instructions}</p>}
        {unit.acceptance.length > 0 && <ul className="plan-acceptance" aria-label={`Acceptance of ${unit.key}`}>
          {unit.acceptance.map((criterion) => <li key={criterion}>{criterion}</li>)}</ul>}
      </li>)}</ul>}
  </li>;
}

function ProposeForm({ source }: { source: OrchestrationSource }) {
  const [projectID, setProjectID] = useState<string | null>(null);
  const [plannerID, setPlannerID] = useState<string | null>(null);
  const [workflowID, setWorkflowID] = useState<string | null>(null);
  const [strategy, setStrategy] = useState<'workflow' | 'planner'>('workflow');
  const [error, setError] = useState('');
  const [sending, setSending] = useState(false);
  const { projects, planners, workflows } = source.options;
  const planner = source.options.agents.find((agent) => agent.id === plannerID);
  const plannerReadiness = strategy === 'planner' && planner && projectID
    ? profileReadiness(planner, source, projectID) : '';
  async function propose() {
    setSending(true);
    setError('');
    try {
      await source.propose?.({ project_id: projectID!,
        ...(strategy === 'planner' && plannerID ? { planner_agent_id: plannerID } : {}),
        ...(workflowID ? { workflow_id: workflowID } : {}) });
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : 'Could not propose a plan.');
    } finally {
      setSending(false);
    }
  }
  return <form className="plan-propose" aria-label="Propose a plan" onSubmit={(event) => { event.preventDefault(); void propose(); }}>
    <Select label="Repository checkout" placeholder={projects.length ? 'Choose a linked online checkout' : 'No linked online checkout'}
      data={projects} value={projectID} onChange={setProjectID} disabled={!projects.length} />
    {source.options.projectNotice && <p className="work-unit-reason" role="status">{source.options.projectNotice}</p>}
    <Select label="Planning strategy" data={[{ value: 'workflow', label: 'Compile a saved workflow' },
      { value: 'planner', label: 'Ask a read-only CLI agent to plan' }]} value={strategy}
    onChange={(value) => setStrategy(value === 'planner' ? 'planner' : 'workflow')} />
    {strategy === 'workflow' ? <Select label="Executable workflow" placeholder={workflows.length ? 'Choose a saved workflow' : 'No saved workflows'}
      data={workflows} value={workflowID} onChange={setWorkflowID} disabled={!workflows.length} /> : <>
      <Select label="Planning agent" placeholder={planners.length ? 'Choose an eligible profile' : 'No eligible read-only CLI profile'}
        data={planners} value={plannerID} onChange={setPlannerID} disabled={!planners.length} />
      <Select label="Workflow guidance (optional)" placeholder="None" data={workflows} value={workflowID}
        onChange={setWorkflowID} clearable disabled={!workflows.length} />
      {!planners.length && !source.readOnlyReason && <p className="work-unit-reason">
        Planning needs an active Codex or Claude CLI profile with read-only tools. Profiles with disabled personas are unavailable.</p>}
      {plannerReadiness && <p className="work-unit-reason" role="status">
        {plannerReadiness} The planning run will wait until the selected repository worker reports this CLI ready.</p>}
      {source.options.agents.some((agent) => agent.status === 'active' && !planners.some((option) => option.value === agent.id)) &&
        <p className="work-unit-reason">Unavailable planning profiles: {source.options.agents
          .filter((agent) => agent.status === 'active' && !planners.some((option) => option.value === agent.id))
          .map((agent) => {
            const persona = source.options.personas.find((item) => item.id === agent.persona_id);
            const reason = !['codex-cli', 'claude-code'].includes(agent.provider) ? 'no CLI adapter'
              : agent.tools.includes('code.write') ? 'profile may write code'
                : agent.persona_id && persona?.status !== 'active' ? 'linked persona unavailable' : 'not eligible';
            return `${agent.name}: ${reason}`;
          }).join('; ')}</p>}
    </>}
    {error && <p className="work-unit-failure" role="alert">{error}</p>}
    <Button type="submit" size="xs" color="violet" loading={sending} title={source.readOnlyReason || undefined}
      disabled={!source.propose || !projectID || (strategy === 'planner' ? !plannerID : !workflowID)}>Propose plan</Button>
  </form>;
}

/** The Plan tab of an objective: propose and approve a plan, then follow and steer the work it started. */
export function ObjectivePlanPanel({ objectiveID, productID, sampleData }: {
  objectiveID: string; productID?: string; sampleData: boolean;
}) {
  const mock = useMockOrchestration(objectiveID);
  const live = useLiveOrchestration(!sampleData, objectiveID, productID);
  const source = sampleData ? mock : live;
  const graph = graphOfObjective(source.graphs, objectiveID);
  if (source.loading || source.plansLoading) return <div className="work-panel" role="tabpanel"><p role="status">Loading the plan…</p></div>;
  if (source.failed || source.plansFailed) return <div className="work-panel" role="tabpanel">
    <p role="alert">Could not load the plan and its work graph.</p>
    <Button size="xs" variant="subtle" onClick={source.retry}>Retry loading the plan</Button></div>;
  return <div className="work-panel" role="tabpanel">
    {source.readOnlyReason && <p className="work-unit-reason">{source.readOnlyReason}</p>}
    {graph && <><WorkGraphView graph={graph} source={source} />
      {!sampleData && <ObjectiveDeliveryReport graphID={graph.id} />}</>}
    <h4>Plan revisions</h4>
    {source.plans.length ? <ul className="plan-revisions">{source.plans.map((plan, index) =>
      <PlanRevision key={plan.revision} plan={plan} latest={index === 0} source={source} />)}</ul>
      : <p className="work-empty">No plan yet. Propose one to turn this objective into reviewed, integrated work.</p>}
    <h4>{source.plans.length ? 'Propose a new revision' : 'Propose a plan'}</h4>
    <ProposeForm source={source} />
  </div>;
}
