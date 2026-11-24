import { Button } from '@mantine/core';
import { IconAlertTriangle } from '@tabler/icons-react';
import { useQuery } from '@tanstack/react-query';
import { z } from 'zod';
import { PanelCard } from './PanelCard';
import { PanelHeading } from './PanelHeading';
import { livePageHref } from './livePageHref';

const actionsSchema = z.array(z.object({
  id: z.string(), kind: z.enum(['plan_approval', 'work_graph_decision', 'publication_authorization']), objective_id: z.string(),
  objective_title: z.string(), plan_revision: z.number(), graph_id: z.string().optional(), unit_key: z.string().optional(),
  stage: z.string(), unit_title: z.string().optional(), run_id: z.string().optional(), subject: z.string(),
  reason: z.string(), options: z.array(z.string()).nullish().transform((items) => items ?? []),
  can_act: z.boolean(), action_blocker: z.string().optional(),
}));
type ActionRequiredItem = z.infer<typeof actionsSchema>[number];

async function loadActions() {
  const response = await fetch('/api/v1/action-required');
  if (!response.ok) throw new Error(`Human actions unavailable (${response.status})`);
  return actionsSchema.parse(await response.json());
}

function actionHref(action: ActionRequiredItem) {
  return livePageHref('objectives', {
    objective: action.objective_id, tab: 'plan',
    ...(action.graph_id ? { graph_id: action.graph_id } : {}),
    ...(action.kind === 'work_graph_decision' && action.graph_id ? { decision: action.id } : {}),
    ...(action.kind === 'publication_authorization' && action.graph_id
      ? { publication_graph: action.graph_id } : {}),
  });
}

/** The Live queue projects current plan approvals, typed decisions, and exact reviewed-candidate publication actions. */
export function ActionRequired() {
  const actions = useQuery({ queryKey: ['action-required'], queryFn: loadActions, retry: false, refetchInterval: 5_000 });
  const pending = actions.data ?? [];
  if (actions.isSuccess && pending.length === 0) return null;

  return <section className="action-required-region" aria-label="Action Required">
    <PanelCard className="panel action-required-panel" withBorder>
    <PanelHeading icon={<IconAlertTriangle size={16} aria-hidden="true" />} title="Action Required"
      description="Plan approvals, governed decisions, and reviewed candidates waiting on a person"
      actions={pending.length ? `${pending.length} waiting` : undefined} />
    {actions.isLoading ? <p role="status">Checking for human actions…</p>
      : actions.isError ? <div role="alert"><p>{actions.error.message}</p>
        <Button size="xs" variant="default" onClick={() => void actions.refetch()}>Retry</Button></div>
        : <ul className="action-required-list">{pending.map((action) => <li key={action.id}>
          <a href={actionHref(action)}>
            <b>{action.objective_title}</b>
            <span>Plan revision {action.plan_revision} · {action.stage}{action.unit_title ? `: ${action.unit_title}` : ''}</span>
            <span>{action.kind === 'plan_approval' ? 'Plan subject' : `Decision ${action.id}`} · {action.subject || 'Subject not recorded'}</span>
            <span>Waiting reason: {action.reason || 'Not recorded'}</span>
            {action.kind === 'plan_approval' && <span>{action.can_act
              ? 'Available action: review the plan and approve it in Objective Workspace'
              : `Action unavailable: ${action.action_blocker || 'Not authorized'}`}</span>}
            {action.kind === 'publication_authorization' && <span>{action.can_act
              ? 'Available action: authorize PR creation for this exact candidate'
              : `Action unavailable: ${action.action_blocker || 'Not authorized'}`}</span>}
            {action.kind === 'work_graph_decision' && <>
              <span>{action.options.length ? `Options: ${action.options.join(' · ')}` : 'Options not recorded'}</span>
              <span>{action.can_act ? 'Available action: resolve this decision in Objective Workspace'
                : `Action unavailable: ${action.action_blocker || 'Not authorized'}`}</span>
            </>}
            <span>WorkUnit {action.unit_key || (action.kind === 'plan_approval' ? 'not started' : 'not recorded')} ·
              {' '}Run {action.run_id || (action.kind === 'plan_approval' ? 'not started' : 'not recorded')}</span>
          </a>
        </li>)}</ul>}
    </PanelCard>
  </section>;
}
