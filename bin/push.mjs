#!/usr/bin/env node
import { spawn } from 'node:child_process';
import path from 'node:path';

const enginePath = path.join(import.meta.dirname, '..', 'lib', 'engine.mjs');
const child = spawn('node', [enginePath, ...process.argv.slice(2)], {
	stdio: 'inherit',
	windowsHide: true,
});

child.on('close', (code) => {
	process.exit(code ?? 0);
});
