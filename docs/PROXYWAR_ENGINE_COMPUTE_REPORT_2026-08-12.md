# ProxyWar Engine Compute Report: where large-map episode time goes

Date: 2026-08-12

Status: measured locally on the hosted episode code path; hardware differs from
the hosted pod, so treat absolute seconds as this machine's and the shares and
ratios as the result.

## Decision

Engine compute is not a minor line item on large maps — with zero-latency
policies it is **99.9%** of a 12-seat World episode's wall clock, and on this
hardware it alone would exhaust the variant's 3,600 s episode timeout before
the configured 500 decision steps.

It is **not** the simulation. The simulation is 1.1%. **98.4%** of the episode
is `AgentObservationBuilder.build`, and inside it two searches:
`findBuildTarget` → `Player.canBuild` → `validStructureSpawnTiles` (~49% of
process CPU) and `boatOptions` → `neutralIslandTransportTiles` →
`canBuildTransportShip` (~23%).

A/B'd against `main` (664fe47) on identical configs, the spectator-snapshot
build skipping on this branch saves a measured **0.50 s of snapshot build time
per 80-step episode (0.07%)**, and a projected **0.2–0.6%** of a full hosted
round. Total wall clock came out 1.4% lower on the branch, but that gap sits
inside this machine's run-to-run spread. It is a real saving and it is not a
round-time lever; it remains what it was built as, a memory/OOM fix.

## How this was measured

`[PERF]` telemetry now sits alongside the existing `[MEM]` telemetry in the
Coworld episode runner. `AgentStepLockedLeague` reports a per-step wall-clock
split through the new optional `onStepTiming` hook, and the runner accumulates
it (`coworld-adapter/src/coworld-episode-perf.ts`) into one stderr line:

```
[PERF] episode-complete steps=80 turns=8400 wallSec=664.4 engineSec=663.5 (99.9%) \
  simSec=0.1 mirrorSec=7.1 decisionEngineSec=653.8 snapshotSec=1.2 setupSec=1.2 \
  brainWaitSec=0.8 otherSec=0.1 snapshotBuilds=65/81 meanBuildMs=18.4 skipSavedSecEst=0.3
```

Phase definitions:

| Phase            | What it covers                                                                |
| ---------------- | ----------------------------------------------------------------------------- |
| `setup`          | Map load, spawn-candidate scan, spawn phase (everything before frame 1)       |
| `sim`            | `GameServer.advanceTurnsForTesting` — intent relay only, it does not simulate |
| `mirror`         | The simulation: the local mirror executing those turns                        |
| `decisionEngine` | `runDecisionTurn` minus the slowest seat's brain latency                      |
| `brainWait`      | The slowest seat's brain latency per step (seats decide in parallel)          |
| `snapshot`       | `buildAgentSpectatorSnapshot` calls                                           |
| `other`          | Residual: effect audits, artifact writes, GC, jitter                          |

Runs used the real hosted episode entrypoint
(`coworld-adapter/src/no-docker-coworld-episode.ts`) with the shipped manifest
variants and the local starter policies, which answer over a loopback socket in
under a millisecond. Zero brain latency is deliberate: it isolates the engine.

Repro (the 12P World run, capped at 80 steps so it finishes in ~11 minutes):

```sh
# config.json = coworld_manifest.json variant tournament-12p-world's game_config
# with max_decision_steps lowered and a token per seat
GAME_ENV=dev PROXYWAR_REPO=$PWD COGAME_CONFIG_URI=file://$PWD/config.json \
  COGAME_HOST=127.0.0.1 COGAME_PORT=18934 PROXYWAR_SKIP_ROUTE_CHECKS=1 \
  PROXYWAR_PERF_TELEMETRY_EVERY=5 \
  node --import tsx/esm coworld-adapter/src/no-docker-coworld-episode.ts
```

Hardware: 4 vCPU Intel Xeon @ 2.10GHz, 16 GB, Node v22.22.2, default heap (the
hosted pod runs `--max-old-space-size=640`, which this run did not impose).

## Result 1: the episode is engine compute

`tournament-12p-world` (World Normal, 12 seats, 100 turns/step), capped at 80
of its 500 decision steps:

| Phase          |   Seconds | Share |
| -------------- | --------: | ----: |
| decisionEngine |     653.8 | 98.4% |
| mirror (sim)   |       7.1 |  1.1% |
| snapshot       |       1.2 |  0.2% |
| setup          |       1.2 |  0.2% |
| brainWait      |       0.8 |  0.1% |
| sim (relay)    |       0.1 |  0.0% |
| **wall**       | **664.4** |       |

Per-step cost rises with territory and then flattens near 8.5–9.7 s/step:

| Step | Turns | Wall (s) | Marginal s/step | Mean snapshot build (ms) |
| ---: | ----: | -------: | --------------: | -----------------------: |
|    5 |   900 |     15.5 |               — |                      0.9 |
|   20 | 2,400 |    118.4 |            7.68 |                      7.5 |
|   40 | 4,400 |    304.1 |            8.70 |                     13.7 |
|   60 | 6,400 |    481.0 |            9.66 |                     17.5 |
|   80 | 8,400 |    664.4 |            8.50 |                     18.4 |

## Result 2: it is a large-map effect

`tournament-4p-pangaea` (Pangaea Compact, 4 seats), same 100 turns/step, run to
its natural finish at step 69:

| Variant                  | Turns | Wall (s) | s/step | decisionEngine share |
| ------------------------ | ----: | -------: | -----: | -------------------: |
| Pangaea Compact, 4 seats | 7,300 |    150.7 |   2.18 |                98.3% |
| World Normal, 12 seats   | 8,400 |    664.4 |   8.30 |                98.4% |

At a comparable turn count (World turn 7,400 = 575.6 s vs Pangaea turn 7,300 =
150.7 s) the large map costs **3.8x** the wall clock. The composition does not
change with map size — the decision-turn engine dominates both — the magnitude
does, because the per-seat searches scan territory and every seat pays.

## Result 3: what inside the decision turn

CPU profile (`node --cpu-prof`) of a 20-step World 12P run, inclusive self-time
as a share of process CPU:

| Frame                                                                                                                                         | Share |
| --------------------------------------------------------------------------------------------------------------------------------------------- | ----: |
| `runAgentStepLockedLeague`                                                                                                                    | 93.3% |
| └ `AgentLeagueMatchRunner.runDecisionTurn`                                                                                                    | 93.1% |
| &nbsp;&nbsp;└ `AgentObservationBuilder.build`                                                                                                 | 92.9% |
| &nbsp;&nbsp;&nbsp;&nbsp;└ `nonCombatState`                                                                                                    | 92.6% |
| &nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;├ `buildOptions` → `findBuildTarget`                                                                      | 67.5% |
| &nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;│ &nbsp;└ `Player.canBuild` → `canSpawnUnitType` → `landBasedStructureSpawn` → `validStructureSpawnTiles` | 49.3% |
| &nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;└ `boatOptions` → `boatTargetTiles` → `neutralIslandTransportTiles`                                       | 23.4% |
| &nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;└ `canBuildTransportShip`                                                                     | 19.8% |
| `AgentLocalGameMirror.executePendingTurns` (the simulation)                                                                                   |  1.6% |
| `LegalActionBuilder.build`                                                                                                                    |  0.0% |
| `buildAgentSpectatorSnapshot`                                                                                                                 |  0.1% |

Supporting hot leaves by self-time: `validStructureSpawnTiles` and its inner
closures 46.5%, `bfsNearest` (`SpatialQuery`) 6.6%, `GameMap.bfs` 5.7%,
`closestShore` 3.0%. Note `LegalActionBuilder.build` at 0.02% — the expensive
half of a decision turn is the observation, not the action enumeration.

Read plainly: every decision step re-derives, for every living seat, where that
seat could put a structure and where it could land a boat, by searching the
map. That search — not the game — is the episode.

## Result 4: what the snapshot change buys (A/B vs main)

`CoworldSnapshotRetention` decides before building whether a step's spectator
frame will be retained, so unretained steps skip an O(all-owned-tiles) build.
Skip ratio grows with episode length:

| Snapshot steps | Builds | Skipped | Skipped % |
| -------------: | -----: | ------: | --------: |
|             81 |     65 |      16 |     19.8% |
|            301 |    111 |     190 |     63.1% |
|            501 |    129 |     372 |     74.3% |

Direct A/B, `main` (664fe47, build-every-step-then-decimate) against this
branch, same config file, same game identity, `[PERF]` ported onto main so both
sides report the same split, runs interleaved MAIN / BRANCH / MAIN / BRANCH on
an otherwise idle box:

| Run      | Wall (s) | Snapshot builds | Snapshot time (s) | Mean build (ms) |
| -------- | -------: | --------------: | ----------------: | --------------: |
| MAIN     |    668.4 |           81/81 |               1.6 |            19.6 |
| BRANCH   |    668.0 |           65/81 |               1.1 |            17.6 |
| MAIN 2   |    680.6 |           81/81 |               1.6 |            19.9 |
| BRANCH 2 |    662.1 |           65/81 |               1.1 |            16.6 |

- **Snapshot build time: 1.6 s → 1.1 s, a 0.50 s saving, 0.07% of the
  episode.** Reproduced exactly on both pairs. This is the change's direct,
  resolvable effect.
- **Wall clock: main 674.5 s (668.4–680.6) vs branch 665.0 s (662.1–668.0), a
  9.5 s / 1.4% apparent gap.** Both main runs did land above every branch run
  (including a third branch run at 664.4 s), so the ordering is consistent —
  but the ranges overlap and n=5 cannot separate a 1.4% effect from this
  machine's ±1–2% run-to-run spread. Anything beyond the measured 0.50 s
  (allocation churn from 16 extra tile-set materializations) is unproven.

Projected to the full 500-step hosted round: 372 skipped builds at the ~20 ms
mean measured at depth 80 is ~7.4 s; even if builds triple to ~60 ms as
territory matures, ~22 s — **0.2–0.6% of an episode that is already at its
3,600 s cap.**

The A/B says nothing reliable about memory: these `[MEM]` samples are not
post-GC (`PROXYWAR_MEM_TELEMETRY_FORCE_GC` was off), so end-of-episode
`heapUsedMB` of 251 on one main run and 82 on the other is allocator sawtooth,
not live set. `npm run gate:memory` is the instrument for that claim.

## Result 5: the hosted round budget

`tournament-12p-world` ships 500 decision steps with
`episode_timeout_seconds: 3600`. Extrapolating the measured steady state
(~8.7 s/step, still rising at step 80):

- 500 steps ≈ **4,300 s of engine compute with zero brain latency** — past the
  1-hour cap.
- At the cap the episode reaches roughly step **417** on this hardware, before
  any policy has been waited on.

With real policies adding `L` seconds of brain wait per step, the engine's
share of the episode is `8.7 / (8.7 + L)`:

|   Brain wait per step | Engine share of wall |
| --------------------: | -------------------: |
|                   1 s |                  90% |
|                   2 s |                  81% |
|                   5 s |                  63% |
|                  10 s |                  47% |
| 15 s (the config cap) |                  37% |

So even in the worst case for the hypothesis — every seat pinned at the
15,000 ms decision cap every step — engine compute is over a third of the
round, and in the realistic band it is the majority.

## What this does not say

- Absolute seconds are this machine's. The hosted pod has different CPU and a
  640 MB heap cap; GC pressure there can only add time, not remove it.
- The starter policies do not exchange communications. Seats that do make
  `runDecisionTurn` build each observation twice (once to derive communication
  signals, once with them), so a talkative round is likely worse than measured
  here, not better. That doubling was not measured.
- Nothing here changes simulation, scores, winners, or decision telemetry. The
  measurement is read-only; the only shipped change is the `[PERF]` line.

## Where to look next

If round time is the goal, the target is `AgentObservationBuilder`'s build-site
and boat-target searches — roughly 72% of the episode between them — not the
simulation, not the snapshots, not the artifact writes. Both are recomputed
from scratch per seat per step over territory that changed by 100 turns' worth
of tiles. Changes there touch the agent-protocol files and need plan mode plus
the usual determinism and behavior-parity gates.
