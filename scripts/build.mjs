import { build } from 'esbuild';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { pathToFileURL } from 'node:url';

mkdirSync('dist', { recursive: true });
await build({ entryPoints: ['src/cli.ts'], bundle: true, platform: 'node', format: 'esm', target: 'node20', outfile: 'dist/cli.js', logLevel: 'warning', banner: { js: '#!/usr/bin/env node' } });

// The web app opens on a precomputed storm so it is live the moment it loads.
const SEED = 2017;
await build({ entryPoints: ['scripts/replay-entry.ts'], bundle: true, platform: 'node', format: 'esm', outfile: 'dist/.replay.mjs', logLevel: 'warning' });
const { makeReplay } = await import(pathToFileURL('dist/.replay.mjs').href);
const cityJson = readFileSync('data/houston.json', 'utf8');
const t0 = Date.now();
const replay = makeReplay(cityJson, SEED);
console.log(`storm ${SEED}: ${replay.policies.map((p) => `${p.name} ${p.metrics.deaths.toFixed(1)} deaths`).join(', ')} (${((Date.now() - t0) / 1000).toFixed(0)} s)`);
const bench = existsSync('data/bench.json') ? JSON.parse(readFileSync('data/bench.json', 'utf8')) : null;

const worker = await build({ entryPoints: ['ui/worker.ts'], bundle: true, format: 'iife', target: 'es2020', minify: true, write: false, logLevel: 'warning' });
const ui = await build({
  entryPoints: ['ui/main.ts'],
  bundle: true,
  format: 'iife',
  target: 'es2020',
  minify: true,
  write: false,
  logLevel: 'warning',
  define: {
    __CITY__: JSON.stringify(cityJson),
    __REPLAY__: JSON.stringify(replay),
    __BENCH__: JSON.stringify(bench),
    __WORKER_SRC__: JSON.stringify(worker.outputFiles[0].text),
  },
});

// One self-contained file: no server, no API keys, works offline.
const fragment = readFileSync('ui/index.html', 'utf8')
  .replace('/*STYLE*/', () => readFileSync('ui/style.css', 'utf8'))
  .replace('/*SCRIPT*/', () => ui.outputFiles[0].text.replace(/<\/script/gi, '<\\/script'));
writeFileSync('dist/artifact.html', fragment);
writeFileSync('dist/surge.html', `<!doctype html>\n<html lang="en">\n<head>\n<meta charset="utf-8">\n<meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover">\n</head>\n<body>\n${fragment}\n</body>\n</html>\n`);
console.log(`built dist/cli.js and dist/surge.html (${(fragment.length / 1024 / 1024).toFixed(1)} MB)`);
