# Surge

**A 911 dispatch copilot for the night the phones never stop.**

On August 27, 2017, Hurricane Harvey put more than 56,000 calls into Houston's 911 system in 17 hours, against about 8,000 on a normal day. Callers waited on hold, hung up, and called again. Neighbors and relatives across the country called about the same family. Ambulances were sent down streets that were already under water.

Surge replays that night on the real city and asks what a dispatcher with a copilot could have done differently. It listens to each call, works out what is happening and exactly where, merges the duplicates, forecasts where the water is going from the terrain, and assigns every free crew to the incident where it saves the most lives, over roads that are actually still open.

**Result:** across 20 simulated storms it never saw during tuning, the copilot cut expected deaths by about **BENCH_VS_CAD%** against a standard dispatch system, and by **BENCH_VS_ROUTED%** against a standard system that is also given live flood-aware routing. Same storm, same calls, same call-takers, same 137 units.

**Live demo:** open `dist/surge.html` in any browser (one self-contained file, no server, works offline), or the hosted copy linked from the repo description.

![Surge console](docs/console.png)

## What is real

| | Source |
|---|---|
| Road network: 104,887 road segments, bridges and underpasses | Overture Maps (OpenStreetMap), release 2026-09-23.1 |
| 43 fire stations, 21 police stations, 34 emergency departments | Overture Maps places |
| 20,000 street addresses used to geocode callers | Overture Maps addresses |
| Terrain at 75 m resolution, 0.8 to 34.6 m above sea level | AWS Terrain Tiles (USGS 3DEP / SRTM) |
| Buffalo, Brays, White Oak, Sims, Keegans and Greens bayous and their tributaries | Overture Maps water |
| 911 call volume that night | Associated Press, August 28, 2017 |

The storm timing, the individual calls and their wording are simulated. `data/fetch.sh` downloads every input straight from the public S3 buckets and `data/build.py` turns them into `data/houston.json`.

## How it works

```
 caller's words ──▶ HEAR ──▶ MERGE ──▶ FORECAST ──▶ ASSIGN ──▶ unit on the flooded road network
                    triage    dedup     terrain      optimal
                                        flood model  assignment
```

**Hear** (`src/triage.ts`). A transcript becomes a structured incident in about 0.1 ms with no network and no model download: incident type from a weighted phrase lexicon with negation handling ("he is *not* bleeding"), the street address resolved against real address points (house numbers spoken digit by digit, abbreviations, one-letter typos, range interpolation for numbers it has never seen), head count, vulnerability (infants, elderly, wheelchair users, oxygen and dialysis patients), reported water depth, and whether this is a repeat caller. Street names are removed before classification so "Hazard Street" cannot vote for an emergency. Every conclusion carries the words that produced it, which the console highlights. On 4,000+ simulated calls it gets the type right 99.4% of the time; on a set of hand-written calls it never saw during development it gets all of them (`test/core.test.ts`).

**Merge** (`src/dispatch.ts`). Repeat callers (same phone number), neighbors (same address) and callers with no address inside the same phone location fix become one incident. Each repeat call updates it with the worst news: the water is at our chest now.

**Forecast** (`src/flood.ts`). A priority flood seeded at every bayou cell computes, for each 75 m terrain cell, the channel it drains to and the lowest water level that can reach it over the ridges in between. That is the HAND idea (height above nearest drainage, used by NOAA's National Water Model for inundation maps) with spill barriers, so a neighborhood behind a ridge stays dry until the water overtops it and then fills at once. From one stage curve it predicts when each address goes waist-deep and chest-deep, and when each road segment closes to cars (0.3 m), high-water engines (0.9 m) and boats (never). Bridges stay open; underpasses close first.

**Assign** (`src/dispatch.ts`, `src/hungarian.ts`). Every few minutes, the copilot builds a matrix of free units against waiting incidents. Each entry is the expected number of lives saved by sending that unit now rather than in two hours, from a risk model per incident type (cardiac arrest decays in minutes; rising water is harmless until it is suddenly not, and the forecast says when), minus the opportunity cost of the crew's drive time on the flooded network. The Kuhn-Munkres algorithm picks the optimal assignment. Dijkstra on a 41,000-node graph takes about 2 ms.

**Simulate** (`src/sim.ts`, `src/scenario.ts`). A discrete-time model of one 911 center: calls ring, wait on hold, hang up and redial, get answered by eight call-takers, and enter the dispatch queue. Units drive the real roads; medics transport to the nearest reachable emergency department. Ground truth decides who survives. A caller who has been rescued stops calling, so a slow dispatcher really does get more repeat calls.

## Benchmark

`npm run bench -- --seeds 20` runs every dispatcher on the same 20 storms (seeds 101 to 120, none used for tuning):

BENCH_TABLE

- **First come, first served** sends the closest free unit to each call in the order calls were answered.
- **Standard CAD** is what a modern computer-aided dispatch system does: protocol priority, closest unit by straight-line distance, duplicates merged on matching address or phone number. Its call-takers code every call correctly and always get the address right when the caller says it, which is generous.
- **CAD + flood routing** is the same, but picks units by drive time on the flooded network, so it knows which units can actually get there.
- **Surge, no flood forecast** is the copilot with the terrain model switched off, to show what the forecast is worth on its own.

Life-threat response time is from the first call to a unit arriving for trapped people, vehicles in water, cardiac arrests, fires and breathing emergencies. The copilot is not always faster to the median call: it deliberately reaches the people whose water is rising fastest first, which cuts the long tail and the deaths.

## Run it

```bash
npm install
npm test                 # 26 tests: assignment vs brute force, flood physics, routing, triage on unseen calls, simulation
npm run build            # dist/cli.js and dist/surge.html (precomputes the opening storm)
node dist/cli.js triage "we're in the attic with my mom she's 79, water is almost to the ceiling, 5607 pardee street"
node dist/cli.js calls --seed 3 --n 10
npm run bench -- --seeds 20
```

To rebuild the city from scratch (needs Python with pyarrow, shapely, numpy, pillow): `bash data/fetch.sh && npm run data`.

## Limitations

- The risk model is deliberately simple, and the copilot plans with the same model that scores outcomes. Read the benchmark as a comparison of dispatch strategies under a shared model of harm, not as a forecast of deaths.
- One global bayou stage curve drives the flood (tributaries rise half as much). Real flooding varies by watershed and by rainfall ponding away from channels.
- Roads are two-way, and traffic is a single storm slowdown factor.
- The triage lexicon is English-only and was developed against generated calls plus a hand-written test set. A production system would put a speech model and an LLM extractor in front of it, keeping this deterministic layer as the explainable fallback.
- This is a research prototype, not a medical or emergency tool.

## License

MIT. Map data © OpenStreetMap contributors (ODbL) via Overture Maps Foundation.
