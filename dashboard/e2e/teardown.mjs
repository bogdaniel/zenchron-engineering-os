import { rmSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const repository = resolve(dirname(fileURLToPath(import.meta.url)), '../..');

export default async function globalTeardown() {
  rmSync(resolve(repository, '.playwright-state'), { recursive: true, force: true });
}
