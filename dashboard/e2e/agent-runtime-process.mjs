import { execFileSync, spawn } from 'node:child_process';
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createServer } from 'node:net';

const repository = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const temporary = mkdtempSync(join(tmpdir(), 'zenchron-agent-runtime-'));
const children = [];

function freePort() {
  return new Promise((resolvePort, reject) => {
    const listener = createServer();
    listener.once('error', reject);
    listener.listen(0, '127.0.0.1', () => {
      const { port } = listener.address();
      listener.close((error) => error ? reject(error) : resolvePort(port));
    });
  });
}

function start(name, command, args, env) {
  const child = spawn(command, args, { cwd: repository, env, stdio: ['ignore', 'pipe', 'pipe'] });
  child.output = '';
  for (const stream of [child.stdout, child.stderr]) stream.on('data', (chunk) => { child.output += chunk; });
  children.push({ name, child });
  return child;
}

async function stop(child) {
  if (child.exitCode !== null) return;
  child.kill('SIGTERM');
  await new Promise((resolveExit) => {
    const timeout = setTimeout(() => {
      child.kill('SIGKILL');
      resolveExit();
    }, 5_000);
    child.once('exit', () => {
      clearTimeout(timeout);
      resolveExit();
    });
  });
}

async function waitFor(url, child) {
  const deadline = Date.now() + 15_000;
  while (Date.now() < deadline) {
    if (child.exitCode !== null) throw new Error(`service exited before ready: ${child.output}`);
    try {
      const response = await fetch(url);
      if (response.ok) return;
    } catch {}
    await new Promise((resolveDelay) => setTimeout(resolveDelay, 100));
  }
  throw new Error(`service did not become ready: ${url}\n${child.output}`);
}

async function request(base, path, options) {
  const response = await fetch(`${base}${path}`, options);
  const body = await response.text();
  if (!response.ok) throw new Error(`${options?.method ?? 'GET'} ${path}: HTTP ${response.status}: ${body}`);
  return body ? JSON.parse(body) : undefined;
}

try {
  const [apiPort, modelPort] = await Promise.all([freePort(), freePort()]);
  const apiURL = `http://127.0.0.1:${apiPort}`;
  const modelURL = `http://127.0.0.1:${modelPort}`;
  const project = join(temporary, 'projects', 'sample');
  const worktrees = join(temporary, 'worktrees');
  mkdirSync(project, { recursive: true });
  execFileSync('git', ['init', '-b', 'main'], { cwd: project, stdio: 'ignore' });
  execFileSync('git', ['config', 'user.name', 'Zenchron E2E'], { cwd: project });
  execFileSync('git', ['config', 'user.email', 'zenchron-e2e@example.invalid'], { cwd: project });
  writeFileSync(join(project, 'README.md'), 'Original checkout stays unchanged.\n');
  execFileSync('git', ['add', 'README.md'], { cwd: project });
  execFileSync('git', ['commit', '-m', 'Initialize process E2E repository'], { cwd: project, stdio: 'ignore' });
  const sourceHead = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: project, encoding: 'utf8' }).trim();

  const apiBinary = join(temporary, 'zenchron');
  const workerBinary = join(temporary, 'zenchron-worker');
  execFileSync('go', ['build', '-o', apiBinary, './cmd/zenchron'], { cwd: repository, stdio: 'inherit' });
  execFileSync('go', ['build', '-o', workerBinary, './cmd/zenchron-worker'], { cwd: repository, stdio: 'inherit' });

  const baseEnv = { ...process.env };
  const model = start('model', 'node', ['dashboard/e2e/mock-llm.mjs'], {
    ...baseEnv, MOCK_LLM_PORT: String(modelPort),
  });
  await waitFor(`${modelURL}/healthz`, model);
  const api = start('control plane', apiBinary, [], {
    ...baseEnv, ZENCHRON_LISTEN_ADDR: `127.0.0.1:${apiPort}`,
    ZENCHRON_DATA_DIR: join(temporary, 'state'),
  });
  await waitFor(`${apiURL}/healthz`, api);
  const worker = start('worker', workerBinary, [], {
    ...baseEnv, ZENCHRON_CONTROL_PLANE_URL: apiURL, ZENCHRON_WORKER_NAME: 'process-e2e-worker',
    ZENCHRON_PROJECTS_ROOT: join(temporary, 'projects'), ZENCHRON_WORKTREES_ROOT: worktrees,
    ZENCHRON_LLM_BASE_URL: `${modelURL}/v1`, ZENCHRON_LLM_API_KEY: 'e2e-test-key',
  });

  const deadline = Date.now() + 15_000;
  let projects = [];
  while (Date.now() < deadline) {
    projects = await request(apiURL, '/api/v1/projects');
    if (projects.some((item) => item.name === 'sample')) break;
    if (worker.exitCode !== null) throw new Error(`worker exited: ${worker.output}`);
    await new Promise((resolveDelay) => setTimeout(resolveDelay, 100));
  }
  const checkout = projects.find((item) => item.name === 'sample');
  if (!checkout) throw new Error(`worker did not report the fixture checkout: ${worker.output}`);

  const profile = await request(apiURL, '/api/v1/agents', {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ name: 'Process E2E agent', description: 'Exercise the worker boundary.',
      provider: 'custom', model: 'mock-model', system_prompt: 'Use only allowed tools.',
      goal_prompt: 'Create agent-output.md.', tools: ['code.write'] }),
  });
  const run = await request(apiURL, '/api/v1/agent-runs', {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ agent_id: profile.id, project_id: checkout.id, prompt: 'Create agent-output.md.' }),
  });

  let completed;
  const runDeadline = Date.now() + 30_000;
  while (Date.now() < runDeadline) {
    const runs = await request(apiURL, '/api/v1/agent-runs');
    completed = runs.find((item) => item.id === run.id);
    if (completed?.status === 'succeeded' || completed?.status === 'failed') break;
    if (worker.exitCode !== null) throw new Error(`worker exited during run: ${worker.output}`);
    await new Promise((resolveDelay) => setTimeout(resolveDelay, 100));
  }
  if (completed?.status !== 'succeeded') throw new Error(`agent run did not succeed: ${JSON.stringify(completed)}`);
  const diff = await request(apiURL, `/api/v1/agent-runs/${run.id}/diff`);
  if (!diff.diff.includes('agent-output.md') || !diff.diff.includes('Created by the E2E model.')) {
    throw new Error(`completed run did not return the model-written diff: ${diff.diff}`);
  }
  const runWorktree = join(worktrees, checkout.id, run.id);
  const sourceState = execFileSync('git', ['status', '--porcelain'], { cwd: project, encoding: 'utf8' }).trim();
  const sourceBranch = execFileSync('git', ['branch', '--show-current'], { cwd: project, encoding: 'utf8' }).trim();
  const finalSourceHead = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: project, encoding: 'utf8' }).trim();
  const runHead = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: runWorktree, encoding: 'utf8' }).trim();
  const writtenFile = readFileSync(join(runWorktree, 'agent-output.md'), 'utf8');
  const runBranch = execFileSync('git', ['branch', '--show-current'], { cwd: runWorktree, encoding: 'utf8' }).trim();
  if (sourceState || sourceBranch !== 'main' || sourceHead !== finalSourceHead || !completed.commit_sha ||
      completed.branch === 'main' || runBranch !== completed.branch || runHead !== completed.commit_sha ||
      writtenFile !== 'Created by the E2E model.\n') {
    throw new Error('agent output escaped its isolated branch or was not committed');
  }
  console.log(`PASS: worker ${completed.worker_name} ran model ${profile.model} on ${checkout.name}, committed ${completed.branch}, and returned its diff.`);
} catch (error) {
  console.error(error);
  for (const { name, child } of children) if (child.output) console.error(`${name} log:\n${child.output}`);
  process.exitCode = 1;
} finally {
  for (const { child } of children.reverse()) await stop(child);
  rmSync(temporary, { recursive: true, force: true });
}
