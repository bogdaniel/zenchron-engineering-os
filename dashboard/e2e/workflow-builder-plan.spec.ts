import { expect, test } from '@playwright/test';

test('workflow builder assignments compile into the selected objective plan', async ({ page }) => {
  test.setTimeout(90_000);
  await page.setViewportSize({ width: 1672, height: 941 });
  await page.route('**/api/v1/auth/session', (route) => route.fulfill({
    status: 200, contentType: 'application/json',
    body: JSON.stringify({ authenticated: true, local: true, login: 'Local workspace' }),
  }));
  await page.goto('/?mode=live#agents');
  const configured = await page.evaluate(async () => {
    const post = async (path: string, body: unknown) => {
      const response = await fetch(path, { method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body) });
      return { status: response.status, body: await response.json() };
    };
    const projects: { id: string; name: string; worker_status: string }[] =
      await fetch('/api/v1/projects').then((r) => r.json());
    const project = projects.find((item) => item.worker_status === 'online');
    if (!project) throw new Error('No online checkout is available for the workflow plan test');
    const persona = await post('/api/v1/personas', { name: 'Builder persona', role: 'Implement the assigned change',
      instructions: 'Preserve existing behavior.', status: 'active' });
    const profile = await post('/api/v1/agents', { name: 'Builder producer', provider: 'codex-cli', model: 'default',
      tools: ['code.write'], persona_id: persona.body.id });
    const product = await post('/api/v1/products', { name: 'Builder plan product', description: '',
      repository_ids: [project.id] });
    if (persona.status !== 201 || profile.status !== 201 || product.status !== 201) {
      throw new Error(JSON.stringify({ persona: persona.status, profile: profile.status, product: product.status }));
    }
    return { projectName: project.name, personaID: persona.body.id as string, profileID: profile.body.id as string };
  });

  await page.goto('/?mode=live#workflows');
  await page.getByRole('button', { name: 'Workflow menu' }).click();
  await page.getByRole('menuitem', { name: 'New workflow…' }).click();
  const dialog = page.getByRole('dialog', { name: 'New Workflow' });
  await dialog.getByLabel('Workflow name').fill('Builder compiled plan');
  await dialog.getByLabel('Description').fill('Prove visual assignments reach the objective plan.');
  const createResponse = page.waitForResponse((response) => response.request().method() === 'POST' &&
    new URL(response.url()).pathname === '/api/v1/workflows');
  await dialog.getByRole('button', { name: 'Create workflow' }).click();
  const workflow = await (await createResponse).json();
  await expect(page.getByRole('heading', { name: 'Workflow Builder — Builder compiled plan' })).toBeVisible();

  const task = page.locator('.workflow-canvas .workflow-node.agent-task');
  await expect(task).toBeVisible();
  await task.click();
  await page.getByRole('textbox', { name: 'Node Name' }).fill('Configured producer');
  await page.getByRole('textbox', { name: 'Description' }).fill('Implement the selected objective.');
  await page.getByRole('combobox', { name: 'Assigned CLI agent profile' }).click();
  await page.getByRole('option', { name: 'Builder producer · codex-cli · default', exact: true }).click();
  await page.getByRole('combobox', { name: 'Required persona' }).click();
  await page.getByRole('option', { name: 'Builder persona · v1', exact: true }).click();
  const acceptance = 'The compiled plan retains this workflow acceptance criterion.';
  await page.getByRole('textbox', { name: 'Acceptance criteria (one per line)' }).fill(acceptance);

  const saveResponse = page.waitForResponse((response) => response.request().method() === 'PUT' &&
    new URL(response.url()).pathname === `/api/v1/workflows/${workflow.id}`);
  await page.getByRole('button', { name: 'Save', exact: true }).click();
  const savedWorkflow = await (await saveResponse).json();
  expect(savedWorkflow.version).toBe(2);
  expect(savedWorkflow.nodes.find((node: { type: string }) => node.type === 'agent-task').data)
    .toMatchObject({ agent_id: configured.profileID, persona_id: configured.personaID, acceptance: [acceptance] });
  await page.getByRole('button', { name: 'Validate', exact: true }).click();
  await expect(page.locator('.workflow-status')).toContainText(
    'Executable workflow configuration validated · saved identity v2');

  await page.goto('/?mode=live#workspace');
  await page.locator('.workspace-mock-product').filter({ hasText: 'Builder plan product' }).click();
  await page.getByRole('combobox', { name: 'Objective repository' }).click();
  await page.getByRole('option').filter({ hasText: configured.projectName }).first().click();
  await page.getByRole('combobox', { name: 'Objective workflow' }).click();
  await page.getByRole('option', { name: 'Builder compiled plan · v2', exact: true }).click();
  await page.getByRole('link', { name: 'Create objective for Builder plan product' }).click();
  const objectiveDialog = page.getByRole('dialog');
  await objectiveDialog.getByLabel('Objective title').fill('Compile builder configuration');
  await objectiveDialog.getByLabel('Description').fill('Compile the visual workflow into WorkUnits.');
  const objectiveResponse = page.waitForResponse((response) => response.request().method() === 'POST' &&
    new URL(response.url()).pathname === '/api/v1/objectives');
  await objectiveDialog.getByRole('button', { name: 'Create objective' }).click();
  const objective = await (await objectiveResponse).json();
  await expect(page).toHaveURL(new RegExp(`workflow=${workflow.id}`));
  await page.getByRole('tab', { name: 'Plan', exact: true }).click();

  const planForm = page.getByRole('form', { name: 'Propose a plan' });
  await expect(planForm.getByRole('combobox', { name: 'Executable workflow' }))
    .toHaveValue('Builder compiled plan · v2');
  await planForm.getByRole('button', { name: 'Propose plan' }).click();
  const revision = page.getByRole('list', { name: 'Units of revision 1' });
  await expect(page.getByRole('tabpanel')).toContainText(`Compiled from workflow ${workflow.id} · version 2`);
  await expect(revision).toContainText('Configured producer');
  await expect(revision).toContainText(`Planned persona ${configured.personaID} · v1`);
  await expect(revision).toContainText(acceptance);

  const plans = await page.evaluate(async (id: string) => fetch(`/api/v1/objectives/${id}/plans`).then((r) => r.json()),
    objective.id);
  const producer = plans[0].units.find((unit: { kind: string }) => unit.kind === 'produce');
  expect(plans[0]).toMatchObject({ workflow_id: workflow.id, workflow_version: 2 });
  expect(producer).toMatchObject({ agent_id: configured.profileID, persona_id: configured.personaID,
    acceptance: [acceptance] });
});
