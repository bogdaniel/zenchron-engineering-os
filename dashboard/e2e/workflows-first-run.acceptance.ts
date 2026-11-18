import { expect, test } from '@playwright/test';

test('Live empty state creates, edits, and reloads a workflow through an empty control plane', async ({ page }) => {
  await page.addInitScript(() => {
    if (!crypto.randomUUID) Object.defineProperty(Crypto.prototype, 'randomUUID', {
      value: () => crypto.getRandomValues(new Uint32Array(4)).join('-'),
    });
  });
  await page.route('**/api/v1/auth/session', (route) => route.fulfill({
    status: 200, contentType: 'application/json',
    body: JSON.stringify({ authenticated: true, local: true, login: 'Local workspace' }),
  }));
  await page.route('**/api/v1/workflows**', (route) => {
    const apiURL = new URL(route.request().url());
    apiURL.port = '8083';
    return route.continue({ url: apiURL.toString() });
  });
  await page.setViewportSize({ width: 1672, height: 941 });
  const initialList = page.waitForResponse((response) => response.url().endsWith('/api/v1/workflows') &&
    response.request().method() === 'GET');
  await page.goto('/#workflows');
  const emptyList = await initialList;
  expect(emptyList.status()).toBe(200);
  expect(await emptyList.json()).toEqual([]);
  await expect(page.getByRole('heading', { name: 'No workflows available' })).toBeVisible();
  await page.getByRole('button', { name: 'Create first workflow' }).click();

  const workflowName = `First live workflow ${Date.now()}`;
  const createResponse = page.waitForResponse((response) => response.url().endsWith('/api/v1/workflows') &&
    response.request().method() === 'POST');
  const createDialog = page.getByRole('dialog', { name: 'New Workflow' });
  await createDialog.getByLabel('Workflow name').fill(workflowName);
  await createDialog.getByLabel('Description').fill('Created from the Live empty state.');
  await createDialog.getByRole('button', { name: 'Create workflow' }).click();
  const created = await createResponse;
  expect(created.status()).toBe(201);
  expect(created.request().postDataJSON()).toEqual({
    name: workflowName, description: 'Created from the Live empty state.',
  });
  const createdWorkflow = await created.json() as { id: string; name: string; nodes: { id: string }[] };
  expect(createdWorkflow).toMatchObject({ name: workflowName });
  expect(createdWorkflow.nodes).toHaveLength(3);
  await expect(page.getByRole('heading', { name: `Workflow Builder — ${workflowName}` })).toBeVisible();

  await page.locator('.workflow-canvas .workflow-node.trigger').click();
  await page.getByRole('textbox', { name: 'Node Name' }).fill('Objective started');
  const saveResponse = page.waitForResponse((response) => response.url().includes(`/api/v1/workflows/${createdWorkflow.id}`) &&
    response.request().method() === 'PUT');
  await page.getByRole('button', { name: 'Save', exact: true }).click();
  const saved = await saveResponse;
  expect(saved.status()).toBe(200);
  expect(saved.request().postDataJSON()).toMatchObject({
    name: workflowName,
    nodes: expect.arrayContaining([expect.objectContaining({
      id: 'trigger', data: expect.objectContaining({ label: 'Objective started' }),
    })]),
  });
  expect(await saved.json()).toMatchObject({
    id: createdWorkflow.id,
    version: 2,
    nodes: expect.arrayContaining([expect.objectContaining({
      id: 'trigger', data: expect.objectContaining({ label: 'Objective started' }),
    })]),
  });

  await page.reload();
  await page.getByRole('button', { name: 'Workflow menu' }).click();
  await page.getByRole('menuitem', { name: workflowName }).click();
  await expect(page.locator('.workflow-version')).toHaveText('v2 (Draft)');
  await page.locator('.workflow-canvas .workflow-node.trigger').click();
  await expect(page.getByRole('textbox', { name: 'Node Name' })).toHaveValue('Objective started');
});
