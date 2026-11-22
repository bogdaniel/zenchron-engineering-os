import { expect, test } from '@playwright/test';

test('Live connected journey: persona and CLI profile configure an executable objective workflow', async ({ page }) => {
  test.setTimeout(90_000);
  await page.setViewportSize({ width: 1672, height: 941 });
  await page.route('**/api/v1/auth/session', (route) => route.fulfill({
    status: 200, contentType: 'application/json',
    body: JSON.stringify({ authenticated: true, local: true, login: 'Local workspace' }),
  }));
  await page.goto('/?mode=live#agents');
  const personaName = `Builder persona ${Date.now()}`;
  await page.getByRole('button', { name: 'Personas', exact: true }).click();
  const personas = page.getByRole('dialog', { name: 'Agent personas' });
  await personas.getByRole('button', { name: 'Create persona' }).click();
  const personaEditor = page.getByRole('dialog', { name: 'Create persona' });
  await personaEditor.getByLabel('Persona name').fill(personaName);
  await personaEditor.getByLabel('Role').fill('Implement the assigned change');
  await personaEditor.getByLabel('Instructions').fill('Preserve existing behavior.');
  const personaResponse = page.waitForResponse((response) => response.request().method() === 'POST' &&
    new URL(response.url()).pathname === '/api/v1/personas');
  await personaEditor.getByRole('button', { name: 'Create persona' }).click();
  const personaCreated = await personaResponse;
  expect(personaCreated.status()).toBe(201);
  const savedPersona = await personaCreated.json();
  await expect(personaEditor).toHaveCount(0);

  await page.getByRole('button', { name: 'Create Agent' }).click();
  const profileEditor = page.getByRole('dialog', { name: 'Create agent profile' });
  await profileEditor.getByLabel('Profile name').fill('Builder producer');
  await profileEditor.getByLabel('Description').fill('Implements the assigned change.');
  await profileEditor.getByLabel('Provider identifier').fill('codex-cli');
  await profileEditor.getByLabel('Model identifier').fill('default');
  await profileEditor.getByRole('combobox', { name: 'Linked persona' }).click();
  await page.getByRole('option', { name: `${personaName} · v1`, exact: true }).click();
  await profileEditor.getByLabel('Write files in isolated branch').check();
  const profileResponse = page.waitForResponse((response) => response.request().method() === 'POST' &&
    new URL(response.url()).pathname === '/api/v1/agents');
  await profileEditor.getByRole('button', { name: 'Create profile' }).click();
  const profileCreated = await profileResponse;
  expect(profileCreated.status()).toBe(201);
  const savedProfile = await profileCreated.json();
  await expect(page.getByRole('heading', { name: 'Builder producer' })).toBeVisible();
  await expect(page.locator('.agents-profile-summary')).toContainText(`${personaName} · v1 · active`);

  const configured = await page.evaluate(async ({ personaID, profileID }) => {
    const projects: { id: string; name: string; worker_status: string }[] =
      await fetch('/api/v1/projects').then((response) => response.json());
    const project = projects.find((item) => item.worker_status === 'online');
    if (!project) throw new Error('No online checkout is available for the workflow plan test');
    const response = await fetch('/api/v1/products', { method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name: 'Builder plan product', description: '', repository_ids: [project.id] }) });
    if (response.status !== 201) throw new Error(`Product creation failed (${response.status})`);
    return { projectName: project.name, personaID, profileID };
  }, { personaID: savedPersona.id as string, profileID: savedProfile.id as string });

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

  const task = page.getByRole('group', { name: 'Implement objective', exact: true });
  await expect(task).toBeVisible();
  await task.click();
  await page.getByRole('textbox', { name: 'Node Name' }).fill('Configured producer');
  await page.getByRole('textbox', { name: 'Description' }).fill('Implement the selected objective.');
  await page.getByRole('combobox', { name: 'Assigned CLI agent profile' }).click();
  await page.getByRole('option', { name: 'Builder producer · codex-cli · default', exact: true }).click();
  await page.getByRole('combobox', { name: 'Required persona' }).click();
  await page.getByRole('option', { name: `${personaName} · v1`, exact: true }).click();
  const acceptance = ['The compiled plan retains this criterion.', 'It also keeps the second line.'];
  const acceptanceField = page.getByRole('textbox', { name: 'Acceptance criteria (one per line)' });
  await acceptanceField.fill(acceptance[0]);
  await acceptanceField.press('Enter');
  await expect(acceptanceField).toHaveValue(`${acceptance[0]}\n`);
  await acceptanceField.pressSequentially(acceptance[1]);
  await expect(acceptanceField).toHaveValue(acceptance.join('\n'));

  const saveResponse = page.waitForResponse((response) => response.request().method() === 'PUT' &&
    new URL(response.url()).pathname === `/api/v1/workflows/${workflow.id}`);
  await page.getByRole('button', { name: 'Save', exact: true }).click();
  const savedWorkflow = await (await saveResponse).json();
  expect(savedWorkflow.version).toBe(2);
  expect(savedWorkflow.nodes.find((node: { type: string }) => node.type === 'agent-task').data)
    .toMatchObject({ agent_id: configured.profileID, persona_id: configured.personaID, acceptance });
  await page.getByRole('button', { name: 'Validate', exact: true }).click();
  await expect(page.locator('.workflow-status')).toContainText(
    'Executable workflow configuration validated · saved identity v2');

  await page.goto('/?mode=live#workspace');
  await page.getByRole('region', { name: 'Product Workspace' })
    .getByRole('button', { name: /^Builder plan product \d+ linked repositories/ }).click();
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
  for (const criterion of acceptance) await expect(revision).toContainText(criterion);

  const plans = await page.evaluate(async (id: string) => fetch(`/api/v1/objectives/${id}/plans`).then((r) => r.json()),
    objective.id);
  const producer = plans[0].units.find((unit: { kind: string }) => unit.kind === 'produce');
  expect(plans[0]).toMatchObject({ workflow_id: workflow.id, workflow_version: 2 });
  expect(producer).toMatchObject({ agent_id: configured.profileID, persona_id: configured.personaID,
    acceptance });
});

test('Live connected journey: workspace selections keep objective plan provenance', async ({ page }) => {
  test.setTimeout(90_000);
  await page.setViewportSize({ width: 1672, height: 941 });
  await page.route('**/api/v1/auth/session', (route) => route.fulfill({
    status: 200, contentType: 'application/json',
    body: JSON.stringify({ authenticated: true, local: true, login: 'Local workspace' }),
  }));
  await page.goto('/?mode=live#workspace');
  // The control plane keeps records across tests and retries, so every saved name is unique to this run.
  const run = Date.now().toString(36);
  const names = { product: `Provenance product ${run}`, workflow: `Provenance workflow ${run}`,
    producerPersona: `Provenance producer persona ${run}`, reviewerPersona: `Provenance reviewer persona ${run}`,
    producer: `Provenance producer ${run}`, reviewer: `Provenance reviewer ${run}` };
  const text = {
    summary: 'Produce, review independently, then integrate.',
    producerTitle: 'Implement the provenance change', producerInstructions: 'Change only the assigned files.',
    producerAcceptance: 'The producer result names the changed files.',
    reviewerTitle: 'Review the provenance change', reviewerInstructions: 'Judge the exact candidate commit.',
    integrateTitle: 'Integrate and publish the reviewed change',
  };
  const saved = await page.evaluate(async ({ names, text }) => {
    const send = async (method: string, path: string, body: unknown) => {
      const response = await fetch(path, { method, headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body) });
      if (!response.ok) throw new Error(`${method} ${path} returned HTTP ${response.status}: ${await response.text()}`);
      return response.json();
    };
    const projects: { id: string; name: string; branch: string; worker_status: string }[] =
      await fetch('/api/v1/projects').then((r) => r.json());
    const project = projects.find((item) => item.worker_status === 'online');
    if (!project) throw new Error('No online checkout is available for the plan provenance test');
    const producerPersona = await send('POST', '/api/v1/personas', { name: names.producerPersona,
      role: 'Implement the assigned change', instructions: 'Preserve existing behavior.', status: 'active' });
    const reviewerPersona = await send('POST', '/api/v1/personas', { name: names.reviewerPersona,
      role: 'Review one exact candidate', instructions: 'Report findings with file and line.', status: 'active' });
    const producer = await send('POST', '/api/v1/agents', { name: names.producer, provider: 'codex-cli',
      model: 'default', tools: ['code.write'], persona_id: producerPersona.id });
    const reviewer = await send('POST', '/api/v1/agents', { name: names.reviewer, provider: 'claude-code',
      model: 'default', tools: ['git.read'], persona_id: reviewerPersona.id });
    const product = await send('POST', '/api/v1/products', { name: names.product, description: '',
      repository_ids: [project.id] });
    const created = await send('POST', '/api/v1/workflows', { name: names.workflow, description: text.summary });
    const workflow = await send('PUT', `/api/v1/workflows/${created.id}`, {
      name: names.workflow, description: text.summary, status: 'draft',
      nodes: [
        { id: 'trigger', type: 'trigger', position: { x: 0, y: 0 }, data: { label: 'Trigger', description: '' } },
        { id: 'task', type: 'agent-task', position: { x: 240, y: 0 }, data: { label: text.producerTitle,
          description: text.producerInstructions, agent_id: producer.id, persona_id: producerPersona.id,
          acceptance: [text.producerAcceptance] } },
        { id: 'review', type: 'code-reviewer', position: { x: 480, y: 0 }, data: { label: text.reviewerTitle,
          description: text.reviewerInstructions, agent_id: reviewer.id, persona_id: reviewerPersona.id } },
        { id: 'integrate', type: 'integrate', position: { x: 720, y: 0 }, data: { label: text.integrateTitle,
          description: '' } },
      ],
      edges: [{ id: 'e-trigger-task', source: 'trigger', target: 'task' },
        { id: 'e-task-review', source: 'task', target: 'review' },
        { id: 'e-review-integrate', source: 'review', target: 'integrate' }],
    });
    return { project, product, workflow, createdVersion: created.version as number,
      producer, reviewer, producerPersona, reviewerPersona };
  }, { names, text });
  // Saving bumps the version, so the plan must pin the saved identity rather than the first draft.
  expect(saved.workflow.version).toBe(saved.createdVersion + 1);
  const checkoutLabel = `${saved.project.name} · ${saved.project.branch}`;
  const workflowLabel = `${names.workflow} · v${saved.workflow.version}`;

  await page.setViewportSize({ width: 390, height: 844 });
  await page.reload();
  await page.getByRole('button', { name: 'Product actions' }).click();
  await page.getByRole('menuitem', { name: names.product, exact: true }).click();
  expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBe(390);
  await page.setViewportSize({ width: 1672, height: 941 });
  const product = page.getByRole('complementary', { name: 'Product workspaces' })
    .getByRole('button', { name: names.product });
  await expect(product).toHaveAttribute('aria-pressed', 'true');
  await page.getByRole('combobox', { name: 'Objective repository' }).click();
  await page.getByRole('option', { name: checkoutLabel, exact: true }).click();
  await page.getByRole('combobox', { name: 'Objective workflow' }).click();
  await page.getByRole('option', { name: workflowLabel, exact: true }).click();
  await page.getByRole('link', { name: `Create objective for ${names.product}` }).click();

  const objectiveDialog = page.getByRole('dialog', { name: 'New objective' });
  await expect(objectiveDialog.getByRole('combobox', { name: 'Product' })).toHaveValue(names.product);
  await objectiveDialog.getByLabel('Objective title').fill('Trace plan provenance');
  await objectiveDialog.getByLabel('Description').fill('Keep the selected workflow identity in the plan.');
  const objectiveResponse = page.waitForResponse((response) => response.request().method() === 'POST' &&
    new URL(response.url()).pathname === '/api/v1/objectives');
  await objectiveDialog.getByRole('button', { name: 'Create objective' }).click();
  const objective = await (await objectiveResponse).json();
  expect(objective.product_id).toBe(saved.product.id);
  await expect(page).toHaveURL(new RegExp(`project=${saved.project.id}`));
  await expect(page).toHaveURL(new RegExp(`workflow=${saved.workflow.id}`));
  await page.getByRole('tab', { name: 'Plan', exact: true }).click();

  const planForm = page.getByRole('form', { name: 'Propose a plan' });
  await expect(planForm.getByRole('combobox', { name: 'Repository checkout' })).toHaveValue(checkoutLabel);
  await expect(planForm.getByRole('combobox', { name: 'Executable workflow' })).toHaveValue(workflowLabel);
  await planForm.getByRole('button', { name: 'Propose plan' }).click();

  const panel = page.getByRole('tabpanel');
  await expect(panel).toContainText(`Compiled from workflow ${saved.workflow.id} · version ${saved.workflow.version}`);
  await expect(panel.getByRole('link', { name: saved.workflow.id, exact: true }))
    .toHaveAttribute('href', `/?workflow=${saved.workflow.id}&mode=live#workflows`);
  await expect(panel).toContainText(text.summary);
  const units = page.getByRole('list', { name: 'Units of revision 1' });
  const unit = (key: string) => units.getByRole('listitem').filter({ has: page.getByText(key, { exact: true }) });

  const producerUnit = unit('step-1');
  await expect(producerUnit).toContainText(text.producerTitle);
  await expect(producerUnit).toContainText('produce');
  await expect(producerUnit.getByRole('link', { exact: true,
    name: `${names.producer} · codex-cli · default · ${names.producerPersona} v${saved.producerPersona.version}` }))
    .toHaveAttribute('href', `/?profile=${saved.producer.id}&mode=live#agents`);
  await expect(producerUnit).toContainText(`Planned profile v${saved.producer.version}`);
  await expect(producerUnit).toContainText(
    `Planned persona ${saved.producerPersona.id} · v${saved.producerPersona.version}`);
  await expect(producerUnit).toContainText(text.producerInstructions);
  await expect(page.getByRole('list', { name: 'Acceptance of step-1' }).getByRole('listitem'))
    .toHaveText([text.producerAcceptance]);
  await expect(producerUnit, 'the producer follows only the trigger').not.toContainText('after step-');

  const reviewerUnit = unit('step-2');
  await expect(reviewerUnit).toContainText(text.reviewerTitle);
  await expect(reviewerUnit).toContainText('review');
  await expect(reviewerUnit.getByRole('link', { exact: true,
    name: `${names.reviewer} · claude-code · default · ${names.reviewerPersona} v${saved.reviewerPersona.version}` }))
    .toHaveAttribute('href', `/?profile=${saved.reviewer.id}&mode=live#agents`);
  await expect(reviewerUnit).toContainText(`Planned profile v${saved.reviewer.version}`);
  await expect(reviewerUnit).toContainText(
    `Planned persona ${saved.reviewerPersona.id} · v${saved.reviewerPersona.version}`);
  await expect(reviewerUnit).toContainText('after step-1');
  await expect(reviewerUnit).not.toContainText('after step-2');

  const integrateUnit = unit('step-3');
  await expect(integrateUnit).toContainText(text.integrateTitle);
  await expect(integrateUnit).toContainText('integrate');
  await expect(integrateUnit).toContainText('Zenchron (deterministic merge)');
  await expect(integrateUnit).toContainText('after step-2');
  await expect(integrateUnit).not.toContainText('after step-1');
  await expect(integrateUnit.getByRole('link'), 'integration is assigned to no agent profile').toHaveCount(0);
  await expect(integrateUnit).not.toContainText('Planned profile');
  await expect(integrateUnit).not.toContainText('Planned persona');

  const plans = await page.evaluate(async (id: string) => fetch(`/api/v1/objectives/${id}/plans`).then((r) => r.json()),
    objective.id);
  expect(plans).toHaveLength(1);
  expect(plans[0]).toMatchObject({ objective_id: objective.id, revision: 1, status: 'proposed',
    project_id: saved.project.id, workflow_id: saved.workflow.id, workflow_version: saved.workflow.version,
    summary: text.summary });
  type RecordedUnit = { key: string; kind: string; title: string; depends_on: string[] | null; agent_id?: string;
    profile_version?: number; persona_id?: string; persona_version?: number };
  expect(plans[0].units.map((recorded: RecordedUnit) => ({ key: recorded.key, kind: recorded.kind,
    title: recorded.title, depends_on: recorded.depends_on ?? [], agent_id: recorded.agent_id,
    profile_version: recorded.profile_version, persona_id: recorded.persona_id,
    persona_version: recorded.persona_version }))).toEqual([
    { key: 'step-1', kind: 'produce', title: text.producerTitle, depends_on: [], agent_id: saved.producer.id,
      profile_version: saved.producer.version, persona_id: saved.producerPersona.id,
      persona_version: saved.producerPersona.version },
    { key: 'step-2', kind: 'review', title: text.reviewerTitle, depends_on: ['step-1'], agent_id: saved.reviewer.id,
      profile_version: saved.reviewer.version, persona_id: saved.reviewerPersona.id,
      persona_version: saved.reviewerPersona.version },
    { key: 'step-3', kind: 'integrate', title: text.integrateTitle, depends_on: ['step-2'], agent_id: undefined,
      profile_version: undefined, persona_id: undefined, persona_version: undefined },
  ]);
  expect(plans[0].units[0].acceptance).toEqual([text.producerAcceptance]);
  expect(plans[0]).not.toHaveProperty('profile_snapshots');
});
