import { spawn } from 'node:child_process';
import { createServer } from 'node:http';
import { chmod, copyFile, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';

const repository = resolve(dirname(fileURLToPath(import.meta.url)), '..');
async function freePort() {
  const listener = createServer();
  await new Promise((resolveListen) => listener.listen(0, '127.0.0.1', resolveListen));
  const address = listener.address();
  if (!address || typeof address === 'string') throw new Error('mock server did not bind a TCP port');
  await new Promise((resolveClose) => listener.close(resolveClose));
  return address.port;
}

const server = createServer((_, response) => response.end('{"status":"ok"}'));
await new Promise((resolveListen) => server.listen(0, '127.0.0.1', resolveListen));

try {
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('mock health server did not bind a TCP port');
  const listenAddress = `127.0.0.1:${address.port}`;
  const child = spawn('sh', ['./dev.sh'], {
    cwd: repository,
    stdio: ['ignore', 'pipe', 'pipe'],
    env: { ...process.env, ZENCHRON_LISTEN_ADDR: listenAddress },
  });
  let output = '';
  for (const stream of [child.stdout, child.stderr]) stream.on('data', (chunk) => { output += chunk; });
  const result = await new Promise((resolveExit, rejectExit) => {
    child.once('error', rejectExit);
    child.once('close', (status, signal) => resolveExit({ status, signal }));
  });
  const expected = `Control plane is already responding at http://${listenAddress}/healthz`;
  if (result.signal || result.status === 0 || !output.includes(expected) || output.includes('Zenchron is ready at')) {
    throw new Error(`preview did not reject the occupied API address:\n${output}`);
  }
  console.log('PASS: preview rejects an already responding control-plane address.');
} finally {
  await new Promise((resolveClose, rejectClose) => {
    server.close((error) => error ? rejectClose(error) : resolveClose());
  });
}

const envPreviewRoot = await mkdtemp(join(tmpdir(), 'zenchron-preview-env-test-'));
const envCheckServer = createServer((_, response) => response.end('{"status":"ok"}'));
await new Promise((resolveListen) => envCheckServer.listen(0, '127.0.0.1', resolveListen));
try {
  const address = envCheckServer.address();
  if (!address || typeof address === 'string') throw new Error('env-check server did not bind a TCP port');
  await copyFile(join(repository, 'dev.sh'), join(envPreviewRoot, 'dev.sh'));
  await writeFile(join(envPreviewRoot, '.env.local'), `ZENCHRON_LISTEN_ADDR=127.0.0.1:${address.port}\n`);
  const env = { ...process.env };
  delete env.ZENCHRON_LISTEN_ADDR;
  const child = spawn('sh', ['./dev.sh'], {
    cwd: envPreviewRoot,
    stdio: ['ignore', 'pipe', 'pipe'],
    env,
  });
  let output = '';
  for (const stream of [child.stdout, child.stderr]) stream.on('data', (chunk) => { output += chunk; });
  const result = await new Promise((resolveExit, rejectExit) => {
    child.once('error', rejectExit);
    child.once('close', (status, signal) => resolveExit({ status, signal }));
  });
  if (result.signal || result.status === 0 || !output.includes('Control plane is already responding at http://127.0.0.1:')) {
    throw new Error(`preview did not load .env.local before checking its configured API address:\n${output}`);
  }
  console.log('PASS: preview loads its ignored .env.local before starting services.');
} finally {
  await new Promise((resolveClose, rejectClose) => {
    envCheckServer.close((error) => error ? rejectClose(error) : resolveClose());
  });
  await rm(envPreviewRoot, { recursive: true, force: true });
}

const temporaryRoot = await mkdtemp(join(tmpdir(), 'zenchron-preview-test-'));
let child;
try {
  const fakeGo = join(temporaryRoot, 'go');
  await writeFile(fakeGo, '#!/bin/sh\nexit 1\n');
  await chmod(fakeGo, 0o755);
  const dashboardPort = await freePort();
  const listenPort = await freePort();
  child = spawn('sh', ['./dev.sh'], {
    cwd: repository,
    stdio: ['ignore', 'pipe', 'pipe'],
    env: {
      ...process.env,
      PATH: `${temporaryRoot}:${process.env.PATH}`,
      ZENCHRON_LISTEN_ADDR: `127.0.0.1:${listenPort}`,
      ZENCHRON_DASHBOARD_PORT: String(dashboardPort),
    },
  });
  let output = '';
  for (const stream of [child.stdout, child.stderr]) stream.on('data', (chunk) => { output += chunk; });
  await new Promise((resolveReady, rejectReady) => {
    const timeout = setTimeout(() => rejectReady(new Error(`dashboard did not survive API startup failure:\n${output}`)), 15_000);
    const check = setInterval(async () => {
      if (output.includes(`Zenchron dashboard is ready at http://127.0.0.1:${dashboardPort}`)) {
        clearTimeout(timeout);
        clearInterval(check);
        try {
          const response = await fetch(`http://127.0.0.1:${dashboardPort}`);
          if (!response.ok) throw new Error(`dashboard returned HTTP ${response.status}`);
          resolveReady();
        } catch (error) {
          rejectReady(error);
        }
      } else if (child.exitCode !== null) {
        clearTimeout(timeout);
        clearInterval(check);
        rejectReady(new Error(`preview exited before serving the dashboard:\n${output}`));
      }
    }, 100);
  });
  console.log('PASS: dashboard remains available when the control plane fails to start.');
} finally {
  if (child && child.exitCode === null) {
    child.kill('SIGINT');
    await new Promise((resolveExit) => child.once('close', resolveExit));
  }
  await rm(temporaryRoot, { recursive: true, force: true });
}
