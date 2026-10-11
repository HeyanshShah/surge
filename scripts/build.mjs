import { build } from 'esbuild';
import { mkdirSync } from 'node:fs';

mkdirSync('dist', { recursive: true });
await build({ entryPoints: ['src/cli.ts'], bundle: true, platform: 'node', format: 'esm', target: 'node20', outfile: 'dist/cli.js', logLevel: 'warning', banner: { js: '#!/usr/bin/env node' } });
console.log('built dist/cli.js');
