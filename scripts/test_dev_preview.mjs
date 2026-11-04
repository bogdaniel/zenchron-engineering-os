import { spawn } from 'node:child_process';
import { createServer } from 'node:http';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const repository = resolve(dirname(fileURLToPath(import.meta.url)), '..');
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
