import { execFileSync, spawn } from 'node:child_process';
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createServer } from 'node:net';
import { createHmac, randomBytes } from 'node:crypto';

const repository = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const temporary = mkdtempSync(join(tmpdir(), 'zenchron-agent-runtime-'));
const children = [];
let sessionCookie = '';

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
  const response = await fetch(`${base}${path}`, {
    ...options,
    headers: { ...options?.headers, Cookie: sessionCookie },
  });
  const body = await response.text();
  if (!response.ok) throw new Error(`${options?.method ?? 'GET'} ${path}: HTTP ${response.status}: ${body}`);
  return body ? JSON.parse(body) : undefined;
}

try {
  const apiPort = await freePort();
  const apiURL = `http://127.0.0.1:${apiPort}`;
  const workerToken = randomBytes(32).toString('hex');
  const sessionSecret = randomBytes(32).toString('hex');
  const session = Buffer.from(JSON.stringify({
    login: 'process-e2e', avatar_url: '', expires_at: Math.floor(Date.now() / 1000) + 3600,
  })).toString('base64url');
  const signature = createHmac('sha256', sessionSecret).update(session).digest('base64url');
  sessionCookie = `zenchron_session=${session}.${signature}`;
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
  for (const name of ['ZENCHRON_GITHUB_TOKEN', 'ZENCHRON_GITHUB_APP_ID', 'ZENCHRON_GITHUB_INSTALLATION_ID',
    'ZENCHRON_GITHUB_APP_PRIVATE_KEY_PATH']) delete baseEnv[name];
  const api = start('control plane', apiBinary, [], {
    ...baseEnv, ZENCHRON_LISTEN_ADDR: `127.0.0.1:${apiPort}`,
    ZENCHRON_DATA_DIR: join(temporary, 'state'),
    ZENCHRON_GITHUB_CLIENT_ID: 'process-e2e-client', ZENCHRON_GITHUB_CLIENT_SECRET: 'process-e2e-secret',
    ZENCHRON_SESSION_SECRET: sessionSecret, ZENCHRON_WORKER_TOKEN: workerToken,
    ZENCHRON_GITHUB_ALLOWED_USERS: 'process-e2e', ZENCHRON_PUBLIC_URL: apiURL,
  });
  await waitFor(`${apiURL}/healthz`, api);
  const anonymousAPI = await fetch(`${apiURL}/api/v1/projects`);
  if (anonymousAPI.status !== 401) throw new Error(`unauthenticated API returned HTTP ${anonymousAPI.status}`);
  const unauthorizedWorker = await fetch(`${apiURL}/api/v1/workers/ffffffffffffffffffffffffffffffff/heartbeat`, {
    method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ name: 'unauthorized' }),
  });
  if (unauthorizedWorker.status !== 401) throw new Error(`worker request without token returned HTTP ${unauthorizedWorker.status}`);
  const invalidWorkerToken = await fetch(`${apiURL}/api/v1/workers/ffffffffffffffffffffffffffffffff/heartbeat`, {
    method: 'PUT', headers: { 'Content-Type': 'application/json', Authorization: 'Bearer invalid-worker-token' },
    body: JSON.stringify({ name: 'unauthorized' }),
  });
  if (invalidWorkerToken.status !== 401) throw new Error(`worker request with wrong token returned HTTP ${invalidWorkerToken.status}`);
  const worker = start('worker', workerBinary, [], {
    ...baseEnv, ZENCHRON_CONTROL_PLANE_URL: apiURL, ZENCHRON_WORKER_NAME: 'process-e2e-worker',
    ZENCHRON_PROJECTS_ROOT: join(temporary, 'projects'), ZENCHRON_WORKTREES_ROOT: worktrees,
    ZENCHRON_WORKER_TOKEN: workerToken,
    // The worker finds `codex` here first: a deterministic fake CLI, so the run uses the real CLI process path.
    PATH: `${join(repository, 'dashboard/e2e/fake-cli')}:${process.env.PATH ?? ''}`,
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

  const createProfile = (name, tools) => request(apiURL, '/api/v1/agents', {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ name, description: 'Exercise the worker boundary.',
      provider: 'codex-cli', model: 'default', system_prompt: 'Use only allowed tools.',
      goal_prompt: 'Create agent-output.md.', tools }),
  });
  // Queues a run and waits for the worker to finish it through the fake Codex CLI.
  const finishRun = async (agent, prompt) => {
    const queued = await request(apiURL, '/api/v1/agent-runs', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ agent_id: agent.id, project_id: checkout.id, prompt }),
    });
    const runDeadline = Date.now() + 30_000;
    while (Date.now() < runDeadline) {
      const runs = await request(apiURL, '/api/v1/agent-runs');
      const current = runs.find((item) => item.id === queued.id);
      if (current?.status === 'succeeded' || current?.status === 'failed') return current;
      if (worker.exitCode !== null) throw new Error(`worker exited during run: ${worker.output}`);
      await new Promise((resolveDelay) => setTimeout(resolveDelay, 100));
    }
    throw new Error(`agent run ${queued.id} did not finish`);
  };
  const profile = await createProfile('Process E2E agent', ['code.write']);
  const completed = await finishRun(profile, 'Create agent-output.md.');
  const run = completed;
  if (completed.status !== 'succeeded') throw new Error(`agent run did not succeed: ${JSON.stringify(completed)}`);
  const events = await request(apiURL, `/api/v1/agent-runs/${run.id}/events`);
  for (const expected of ['codex-cli codex-cli 0.0.0-e2e started', '$ cat README.md', 'changed 1 file(s)',
    'E2E model completed the requested task.', '120 input tokens, 30 output tokens']) {
    if (!events.some((event) => event.message === expected)) {
      throw new Error(`run events lack "${expected}": ${JSON.stringify(events)}`);
    }
  }
  const failed = await finishRun(profile, 'Fail this run.');
  if (failed.status !== 'failed' || failed.termination_reason !== 'provider_exit' || failed.commit_sha) {
    throw new Error(`a failing provider did not fail the run: ${JSON.stringify(failed)}`);
  }
  const readOnly = await finishRun(await createProfile('Process E2E reader', []), 'Create agent-output.md.');
  if (readOnly.status !== 'succeeded' || readOnly.commit_sha) {
    throw new Error(`a profile without code.write changed the branch: ${JSON.stringify(readOnly)}`);
  }
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
  console.log(`PASS: allowlisted dashboard session and authenticated worker ran ${profile.provider} on ${checkout.name}, committed ${completed.branch}, returned its diff and events, failed a failing provider, and kept a read-only profile from writing.`);
} catch (error) {
  console.error(error);
  for (const { name, child } of children) if (child.output) console.error(`${name} log:\n${child.output}`);
  process.exitCode = 1;
} finally {
  for (const { child } of children.reverse()) await stop(child);
  rmSync(temporary, { recursive: true, force: true });
}
