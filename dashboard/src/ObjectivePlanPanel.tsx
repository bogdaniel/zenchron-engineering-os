import { useEffect, useState } from 'react';
import { Button, Select } from '@mantine/core';
import { graphOfObjective, useLiveOrchestration } from './orchestration';
import type { ObjectivePlan, OrchestrationSource } from './orchestration';
import { runReadiness } from './agentRunQueue';
import { useMockOrchestration } from './orchestration-preview-data';
import { StateBadge, UnitFacts, WorkGraphView } from './WorkGraphView';
import { ObjectiveDeliveryReport } from './ObjectiveDeliveryReport';
import { livePageHref } from './livePageHref';

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

function planApprovalBlocker(plan: ObjectivePlan, source: OrchestrationSource) {
  if (source.options.workersLoading) return 'Checking the plan’s repository worker; approval is unavailable until this finishes.';
  if (source.options.workersFailed) return 'Worker availability could not be checked; retry before approving this plan.';
  const workerID = source.options.projectWorkerIDs[plan.project_id];
  const worker = source.options.workers.find((item) => item.id === workerID);
  return worker?.status === 'online' ? '' : 'The plan’s repository worker is offline; bring it online before approval.';
}

function PlanRevision({ plan, latest, source, live, requested }: {
  plan: ObjectivePlan; latest: boolean; source: OrchestrationSource; live: boolean; requested: boolean;
}) {
  const [error, setError] = useState('');
  const [approving, setApproving] = useState(false);
  async function approve() {
    setApproving(true);
    setError('');
    try {
      await source.approve?.(plan.revision);
      if (live && new URLSearchParams(window.location.search).has('graph_id')) {
        const url = new URL(window.location.href);
        url.searchParams.delete('graph_id');
        url.searchParams.delete('decision');
        window.history.replaceState(window.history.state, '', `${url.pathname}${url.search}${url.hash}`);
      }
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : 'Could not approve the plan.');
    } finally {
      setApproving(false);
    }
  }
  const readinessChecking = plan.units.length > 0 && (source.options.agentsLoading || source.options.workersLoading);
  const readinessProblems = planReadinessProblems(plan, source);
  const approvalBlocker = latest && plan.status === 'proposed' ? planApprovalBlocker(plan, source) : '';
  return <li id={`plan-revision-${plan.revision}`} className="plan-revision" tabIndex={requested ? -1 : undefined}
    aria-current={requested ? 'location' : undefined}>
    {requested && <p role="status">Opened from Action Required for this exact plan revision.
      {plan.status !== 'proposed' && ` This revision is no longer pending approval; its status is ${plan.status}.`}</p>}
    <div className="work-graph-head"><b>Revision {plan.revision}</b><StateBadge state={plan.status} />
      {plan.approved_by && <span>approved by {plan.approved_by}</span>}
      {latest && plan.status === 'proposed' && <Button size="compact-xs" color="violet" loading={approving}
        disabled={!source.approve || Boolean(approvalBlocker)}
        title={source.readOnlyReason || approvalBlocker || undefined} onClick={() => void approve()}>
        Approve plan and start</Button>}
    </div>
    {plan.status === 'planning' && <p className="work-unit-reason" role="status">
      A planning agent is reading the repository. The proposal appears here when it finishes.</p>}
    {plan.summary && <p>{plan.summary}</p>}
    {plan.workflow_id && <p className="work-unit-reason">{plan.workflow_mode === 'compiled' ? 'Compiled from workflow ' : plan.workflow_mode === 'guidance' ? 'Guided by workflow ' : 'Workflow execution mode unknown · workflow '}{live
      ? <a href={livePageHref('workflows', { workflow: plan.workflow_id })}>{plan.workflow_id}</a> : plan.workflow_id}
      {' · version '}{plan.workflow_version ?? 'unknown'}</p>}
    {plan.problems.length > 0 && <ul className="plan-problems" aria-label={`Problems in revision ${plan.revision}`}>
      {plan.problems.map((problem) => <li key={problem}>{problem}</li>)}</ul>}
    {readinessChecking && <p className="work-unit-reason" role="status">Checking current CLI readiness for assigned profiles…</p>}
    {readinessProblems.length > 0 && <p className="work-unit-reason" role="status" aria-label={`CLI readiness for revision ${plan.revision}`}>
      Current CLI readiness: {readinessProblems.join('; ')}. {approvalBlocker
        ? `Plan approval is unavailable: ${approvalBlocker}`
        : 'The plan can be approved, but its runs wait until ready.'}
    </p>}
    {approvalBlocker && readinessProblems.length === 0 &&
      <p className="work-unit-reason" role="status">Plan approval unavailable: {approvalBlocker}</p>}
    {error && <p className="work-unit-failure" role="alert">{error}</p>}
    {plan.units.length > 0 && <ul className="work-units" aria-label={`Units of revision ${plan.revision}`}>
      {plan.units.map((unit) => <li className="work-unit" key={unit.key}>
        <UnitFacts unit={unit} agent={source.agentNames[unit.agent_id] ?? ''} planned live={live} />
        {unit.instructions && <p className="work-unit-reason">{unit.instructions}</p>}
        {unit.acceptance.length > 0 && <ul className="plan-acceptance" aria-label={`Acceptance of ${unit.key}`}>
          {unit.acceptance.map((criterion) => <li key={criterion}>{criterion}</li>)}</ul>}
      </li>)}</ul>}
  </li>;
}

function ProposeForm({ source }: { source: OrchestrationSource }) {
  const [projectID, setProjectID] = useState<string | null>(() => new URLSearchParams(window.location.search).get('project'));
  const [plannerID, setPlannerID] = useState<string | null>(null);
  const [workflowID, setWorkflowID] = useState<string | null>(() => new URLSearchParams(window.location.search).get('workflow'));
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
      disabled={!source.propose || !projects.some((project) => project.value === projectID)
        || (strategy === 'planner' ? !plannerID : !workflows.some((workflow) => workflow.value === workflowID))}>Propose plan</Button>
  </form>;
}

/** The Plan tab of an objective: propose and approve a plan, then follow and steer the work it started. */
export function ObjectivePlanPanel({ objectiveID, productID, sampleData }: {
  objectiveID: string; productID?: string; sampleData: boolean;
}) {
  const mock = useMockOrchestration(objectiveID);
  const live = useLiveOrchestration(!sampleData, objectiveID, productID);
  const source = sampleData ? mock : live;
  const [requestedGraphID] = useState(() => new URLSearchParams(window.location.search).get('graph_id'));
  const [requestedPlanLink] = useState(() => {
    const value = new URLSearchParams(window.location.search).get('plan_revision');
    if (value === null) return { revision: null, invalid: false };
    if (!/^[1-9]\d*$/.test(value)) return { revision: null, invalid: true };
    const revision = Number(value);
    return Number.isSafeInteger(revision) ? { revision, invalid: false } : { revision: null, invalid: true };
  });
  const requestedPlanRevision = requestedPlanLink.revision;
  const graph = source.graphs.find((item) => item.id === requestedGraphID && item.objective_id === objectiveID)
    ?? graphOfObjective(source.graphs, objectiveID);
  useEffect(() => {
    if (sampleData || requestedPlanRevision === null || source.plansLoading) return;
    const target = document.getElementById(`plan-revision-${requestedPlanRevision}`);
    target?.focus();
    target?.scrollIntoView({ block: 'center' });
  }, [sampleData, requestedPlanRevision, source.plans, source.plansLoading]);
  if (source.failed || source.plansFailed) return <div className="work-panel" role="tabpanel">
    <p role="alert">Could not load the plan and its work graph.</p>
    <Button size="xs" variant="subtle" onClick={source.retry}>Retry loading the plan</Button></div>;
  return <div className="work-panel" role="tabpanel">
    {source.readOnlyReason && <p className="work-unit-reason">{source.readOnlyReason}</p>}
    {(source.loading || source.plansLoading) && <p role="status">Loading existing work…</p>}
    {graph && <><WorkGraphView graph={graph} source={source} showRunLinks={!sampleData} />
      {!sampleData && <ObjectiveDeliveryReport graphID={graph.id} />}</>}
    <h4>Plan revisions</h4>
    {!sampleData && requestedPlanLink.invalid && <p role="alert">This plan revision link is invalid.</p>}
    {!sampleData && requestedPlanRevision !== null && !source.plansLoading &&
      !source.plans.some((plan) => plan.revision === requestedPlanRevision) &&
      <p role="alert">Plan revision {requestedPlanRevision} is no longer available. Check Action Required for current decisions.</p>}
    {source.plansLoading ? <p role="status">Loading plan revisions…</p> : source.plans.length
      ? <ul className="plan-revisions">{source.plans.map((plan, index) =>
        <PlanRevision key={plan.revision} plan={plan} latest={index === 0} source={source} live={!sampleData}
          requested={!sampleData && plan.revision === requestedPlanRevision} />)}</ul>
      : <p className="work-empty">No plan yet. Propose one to turn this objective into reviewed, integrated work.</p>}
    <h4>{source.plans.length ? 'Propose a new revision' : 'Propose a plan'}</h4>
    <ProposeForm source={source} />
  </div>;
}
