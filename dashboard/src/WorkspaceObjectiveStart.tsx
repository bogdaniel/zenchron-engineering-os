import { useEffect, useState } from 'react';
import { Select } from '@mantine/core';
import { useQuery } from '@tanstack/react-query';
import { loadWorkflows } from './workflowModel';
import type { Project } from './projects';
import { livePageHref } from './livePageHref';

/** Carries product configuration into the existing objective and plan flow. */
export function WorkspaceObjectiveStart({ productID, productName, projects, defaultWorkflowID }: {
  productID: string; productName: string; projects: Project[]; defaultWorkflowID?: string;
}) {
  const workflows = useQuery({ queryKey: ['workflows'], queryFn: loadWorkflows });
  const [projectID, setProjectID] = useState<string | null>(null);
  const [workflowID, setWorkflowID] = useState<string | null>(defaultWorkflowID ?? null);
  useEffect(() => setWorkflowID(defaultWorkflowID ?? null), [defaultWorkflowID]);
  const parameters = new URLSearchParams({ create: '1', product_id: productID });
  if (projectID && projects.some((project) => project.id === projectID)) parameters.set('project', projectID);
  if (workflowID && workflows.data?.some((workflow) => workflow.id === workflowID)) parameters.set('workflow', workflowID);
  return <div>
    <Select label="Objective repository" placeholder="Choose a linked online checkout" clearable
      data={projects.filter((project) => project.worker_status === 'online').map((project) => ({ value: project.id,
        label: `${project.name} · ${project.branch}` }))} value={projectID} onChange={setProjectID} />
    <Select label="Objective workflow" placeholder="Choose a saved workflow" clearable
      data={workflows.data?.map((workflow) => ({ value: workflow.id, label: `${workflow.name} · v${workflow.version}` })) ?? []}
      value={workflowID} onChange={setWorkflowID} disabled={workflows.isLoading || workflows.isError} />
    {workflows.isError && <p role="alert">Workflow definitions could not be loaded.</p>}
    <a className="workspace-mock-card-action workspace-mock-objective-create"
      href={livePageHref('objectives', parameters)} aria-label={`Create objective for ${productName}`}>＋ Create objective</a>
  </div>;
}
