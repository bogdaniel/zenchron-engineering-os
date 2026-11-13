import { Badge, Button, Progress } from '@mantine/core';
import { IconCheck, IconCircle, IconCircleDashed, IconPlayerPlay, IconUserCheck } from '@tabler/icons-react';
import { PanelCard } from './PanelCard';
import { PanelHeading } from './PanelHeading';
import './workflow-mobile-preview.css';
import { workflowNodeIcons } from './workflowModel';
import type { RunPreviewView, WorkflowPhoneRun, WorkflowRunTimeline } from './workflowsView';

/** The builder's Run Preview body for one run. */
export function WorkflowRunPreview({ run, view }: { run: WorkflowRunTimeline; view: RunPreviewView }) {
  if (view !== 'Execution Graph') {
    const { label, title, lines } = run.outputs[view];
    return <div className="workflow-simulated-output" role="region" aria-label={label}>
      <b>{title}</b>{lines.map((line) => <code key={line}>{line}</code>)}
    </div>;
  }
  return <div className="workflow-preview-content workflow-simulated-run">
    <section className="workflow-simulated-timeline" aria-label="Simulated run timeline">
      <div className="workflow-simulated-heading"><b>{run.title}</b><span>{run.verdict}</span><small>{run.estimate}</small></div>
      <div className="workflow-simulated-axis"><span>Step</span><span>Status</span>
        <div>{run.axis.map((tick) => <span key={tick}>{tick}</span>)}</div></div>
      {run.steps.map(({ label, type, start, span, status, statusTone, state }) => {
        const Icon = workflowNodeIcons[type];
        return <div className={`workflow-simulated-row ${state}`} key={label}>
          <span className="workflow-simulated-row-step"><Icon size={9} aria-hidden="true" />{label}</span>
          <span className={`workflow-simulated-row-status ${statusTone}`}>{status}</span>
          <div><i style={{ left: `${start}%`, width: `${span}%` }} /></div>
        </div>;
      })}
    </section>
    <aside className="workflow-simulated-summary">
      <b>Run Summary (est.)</b>
      {run.summary.map(([label, value]) => <label key={label}>{label}<span>{value}</span></label>)}
      <strong>Success conditions</strong>{run.conditions.map((condition) => <span key={condition}>{condition}</span>)}
    </aside>
  </div>;
}

/** The phone's run status, task progress, and approvals. `onAction` is absent where approvals cannot be acted on. */
export function WorkflowPhoneRunCards({ run, onAction }: { run: WorkflowPhoneRun; onAction?: (action: string) => void }) {
  return <div className="workflow-mobile-run-preview" aria-label="Workflow run">
    <PanelCard id="workflow-mobile-run-summary" className="workflow-mobile-run-summary">
      <PanelHeading icon={<IconPlayerPlay size={15} />} title="Run Status" description={run.description}
        actions={<Badge className={run.isRunning ? 'workflow-mobile-running' : 'workflow-mobile-idle'}>{run.badge}</Badge>} />
      {run.progress !== undefined && <div className="workflow-mobile-run-progress"><Progress value={run.progress} /><b>{run.progress}%</b></div>}
    </PanelCard>

    <PanelCard id="workflow-mobile-run-tasks" className="workflow-mobile-run-tasks">
      <PanelHeading icon={<IconCircleDashed size={15} />} title="Task Progress" actions={<span>{run.tasksSummary}</span>} />
      <div className="workflow-mobile-run-task-list">
        {run.tasks.map(({ label, status, state }) => <div className={`workflow-mobile-run-task ${state}`} key={label}>
          {state === 'complete' ? <IconCheck size={14} /> : state === 'active' ? <IconCircleDashed size={14} /> : <IconCircle size={14} />}
          <b>{label}</b><small>{status}</small>
        </div>)}
      </div>
    </PanelCard>

    <PanelCard id="workflow-mobile-run-approvals" className="workflow-mobile-run-approvals">
      <PanelHeading icon={<IconUserCheck size={15} />} title="Approvals" actions={<span>{run.approvalsSummary}</span>} />
      {run.approvals.map(({ label, status, isApproved, action }) => (
        <div className={`workflow-mobile-approval-row${isApproved ? ' approved' : ''}`} key={label}>
          {isApproved ? <IconCheck size={14} /> : <IconCircle size={14} />}<b>{label}</b><small>{status}</small>
          {action && onAction && <Button size="xs" onClick={() => onAction(action)}>Review</Button>}
        </div>
      ))}
      {!run.approvals.length && <p className="workflow-mobile-run-empty">This workflow has no Human Approval component.</p>}
    </PanelCard>
  </div>;
}
