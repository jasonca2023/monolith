/**
 * Boots the shell against the Vite dev server.
 *
 * Run `npm run dev:renderer` in another terminal first. Setting the env var
 * through Node keeps the script working on Windows, where inline `VAR=value`
 * prefixes are not valid shell syntax.
 */

import { spawn } from 'node:child_process';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const electron = require('electron');

const child = spawn(electron, ['.'], {
  stdio: 'inherit',
  env: { ...process.env, MONOLITH_RENDERER_URL: 'http://localhost:5173' },
});

child.on('close', (code) => process.exit(code ?? 0));
