import { Badge, Button, Progress } from '@mantine/core';
import { IconCheck, IconCircle, IconCircleDashed, IconPlayerPlay, IconUserCheck } from '@tabler/icons-react';
import { PanelCard } from './PanelCard';
import { PanelHeading } from './PanelHeading';
import './workflow-mobile-preview.css';

const tasks = [
  ['Plan & Approve', 'Completed · 2m', 'complete'],
  ['Agent Implementation', 'Completed · 4m', 'complete'],
  ['Tests & Validation', 'In Progress · 1m', 'active'],
  ['Review & Updates', 'Pending', 'pending'],
  ['Merge to trusted-main', 'Pending', 'pending'],
] as const;

export function WorkflowMobileRunPreview() {
  return <div className="workflow-mobile-run-preview" aria-label="Sample workflow run">
    <PanelCard className="workflow-mobile-run-summary">
      <PanelHeading icon={<IconPlayerPlay size={15} />} title="Run Status"
        description="Run #8821 · Started 8m ago" actions={<Badge className="workflow-mobile-running">● Running</Badge>} />
      <div className="workflow-mobile-run-progress"><Progress value={78} /><b>78%</b></div>
    </PanelCard>

    <PanelCard className="workflow-mobile-run-tasks">
      <PanelHeading icon={<IconCircleDashed size={15} />} title="Task Progress" actions={<span>4 of 5 completed</span>} />
      <div className="workflow-mobile-run-task-list">
        {tasks.map(([label, status, state]) => <div className={`workflow-mobile-run-task ${state}`} key={label}>
          {state === 'complete' ? <IconCheck size={14} /> : state === 'active' ? <IconCircleDashed size={14} /> : <IconCircle size={14} />}
          <b>{label}</b><small>{status}</small>
        </div>)}
      </div>
    </PanelCard>

    <PanelCard className="workflow-mobile-run-approvals">
      <PanelHeading icon={<IconUserCheck size={15} />} title="Approvals" actions={<span>1 of 2 approved</span>} />
      <div className="workflow-mobile-approval-row approved"><IconCheck size={14} /><b>Code Reviewer</b><small>Approved · 6m ago</small></div>
      <div className="workflow-mobile-approval-row"><IconCircle size={14} /><b>Platform Lead</b><small>Awaiting approval</small><Button disabled size="xs">Review</Button></div>
    </PanelCard>
  </div>;
}
