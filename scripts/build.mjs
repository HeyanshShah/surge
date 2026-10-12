import { build } from 'esbuild';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { basename } from 'node:path';
import { pathToFileURL } from 'node:url';

mkdirSync('dist', { recursive: true });
await build({ entryPoints: ['src/cli.ts'], bundle: true, platform: 'node', format: 'esm', target: 'node20', outfile: 'dist/cli.js', logLevel: 'warning', banner: { js: '#!/usr/bin/env node' } });

// `node scripts/build.mjs` builds the Houston console with the Harvey replay.
// `node scripts/build.mjs --city data/austin.json` builds a live-only console for another city: dist/surge-austin.html.
const ci = process.argv.indexOf('--city');
const cityPath = ci > 0 ? process.argv[ci + 1] : 'data/houston.json';
const isHouston = cityPath.endsWith('houston.json');
const outName = isHouston ? 'surge.html' : `surge-${basename(cityPath, '.json')}.html`;
const cityJson = readFileSync(cityPath, 'utf8');

// The Houston console opens on a precomputed Harvey storm so it is moving the moment it loads.
const SEED = 2017;
let replay = null;
if (isHouston) {
  await build({ entryPoints: ['scripts/replay-entry.ts'], bundle: true, platform: 'node', format: 'esm', outfile: 'dist/.replay.mjs', logLevel: 'warning' });
  const { makeReplay } = await import(pathToFileURL('dist/.replay.mjs').href);
  const t0 = Date.now();
  replay = makeReplay(cityJson, SEED);
  console.log(`storm ${SEED}: ${replay.policies.map((p) => `${p.name} ${p.metrics.deaths.toFixed(1)} deaths`).join(', ')} (${((Date.now() - t0) / 1000).toFixed(0)} s)`);
}
const bench = isHouston && existsSync('data/bench.json') ? JSON.parse(readFileSync('data/bench.json', 'utf8')) : null;

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
if (isHouston) writeFileSync('dist/artifact.html', fragment);
writeFileSync(`dist/${outName}`, `<!doctype html>\n<html lang="en">\n<head>\n<meta charset="utf-8">\n<meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover">\n</head>\n<body>\n${fragment}\n</body>\n</html>\n`);
console.log(`built dist/cli.js and dist/${outName} (${(fragment.length / 1024 / 1024).toFixed(1)} MB)`);
