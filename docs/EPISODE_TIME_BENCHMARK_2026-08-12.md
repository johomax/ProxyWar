# Episode-time measurement: "Stop copying player territory on every read"

Measured effect of `42ce1ac` ("Stop copying player territory on every read") on
a **16-seat, 200-decision-step** episode.

**Result: no measurable improvement — 0.13%, an order of magnitude below the
run-to-run noise of the benchmark.** The commit is still worth keeping (it
drops a needless allocation and makes `tiles()` consistent with
`borderTiles()`), but it does not move episode time.

## Method

`coworld-adapter/scripts/episode-time-bench.mjs` drives the hosted episode path
(`no-docker-coworld-episode.ts` standalone mode) on the shipped
`proxywar-ffa-16p` variant `sixteen-player-ffa-pangaea`: 16 seats,
Pangaea/Compact, Easy, 100 turns per decision step, bundled starter policy per
seat, hosted `--max-old-space-size=640` posture, seed 812026. Only
`max_decision_steps` is overridden.

The reported number is the runner's own `startedAt -> completedAt` bracket (map
load + spawn phase + every decision step), read back from `match-summary.json`.

The baseline arm is a git worktree at `664fe47` (`42ce1ac^`) sharing one
`node_modules` and one machine (4 cores). Arms were run **alternating** so
machine drift cancels instead of loading one side.

## Numbers

Episode time in seconds, n=3 per arm at 200 steps, n=2 at 20 steps:

| steps | arm              | runs                | mean  | within-arm spread |
| ----- | ---------------- | ------------------- | ----- | ----------------- |
| 200   | `42ce1ac` after  | 849.9, 834.7, 820.8 | 835.1 | 3.5%              |
| 200   | `664fe47` before | 834.4, 853.0, 821.3 | 836.2 | 3.8%              |
| 20    | `42ce1ac` after  | 157.8, 152.1        | 155.0 | 3.7%              |
| 20    | `664fe47` before | 152.3, 150.7        | 151.5 | 1.1%              |

At 200 steps `before/after = 1.0013`. The 3.5-3.8% spread **within** each arm
swamps the 0.13% difference **between** them; at 20 steps the baseline even
comes out nominally faster. Both depths are null.

Every run ended byte-identical — same 20,400 turns, same 1,185 decisions, same
final per-seat tiles `[0,0,0,0,0,29705,0,0,0,0,0,69722,0,0,0,275]` — so the
arms played the same simulation and the comparison is speed alone.

> An earlier unpaired probe read 1.25x in favour of the fix. It was
> contaminated: other work shared the machine, and the baseline sample
> (189.9s) is a clear outlier against the two clean ones (150.7s, 152.3s).
> Alternating repeats replaced it.

## Why the effect is nil

CPU profile of a 20-step episode on the **baseline** build, where the copy
still exists (`--cpu-prof`, self time as share of non-idle CPU):

| frame                                                    | share of busy CPU |
| -------------------------------------------------------- | ----------------- |
| `validStructureSpawnTiles` callback (anon, `PlayerImpl`) | 26.3%             |
| `validStructureSpawnTiles`                               | 21.4%             |
| `bfsNearest` (`SpatialQuery`)                            | 9.8%              |
| `bfs` (`GameMap`)                                        | 9.5%              |
| `closestShore` (`SpatialQuery`)                          | 4.4%              |
| `landBasedStructureSpawn`                                | 4.1%              |
| **`PlayerImpl.tiles()`**                                 | **0.43%**         |

`tiles()` is 0.43% of busy CPU **before** the fix, so removing its copy can
save at most that — and it saves less, because callers still call `tiles()` and
three of the five call sites still wrap it in `Array.from`. A ceiling of 0.4%
cannot be resolved against 3.5% noise, which is exactly what the A/B shows.

Two things drive episode time instead:

1. **Build-affordance evaluation, ~48% of busy CPU.** The hot chain is
   `canBuild -> canSpawnUnitType -> landBasedStructureSpawn -> validStructureSpawnTiles -> (callback)`.
   That is where a real episode-time win is available.
2. **Pathfinding, ~24%** (`bfsNearest`, `bfs`, `closestShore`).

## Shape of a 200-step episode

A 200-step episode is only briefly a 16-seat game: 13 of the 16 seats are
eliminated before it ends, and decision density falls from 0.140 decisions/turn
at 20 steps to 0.058 at 200. The agent-observation work that reads `tiles()`
scales with _living seats x decisions_, so it shrinks as the field is
eliminated while ~18,000 turns of two-empire simulation dominate the tail.

## Caveats

- Measured with the bundled **starter** policy on every seat, the shipped
  certification player. Real policies do not change the game-side CPU per
  decision, but seats surviving longer would raise the agent-side share
  somewhat. The 0.43% ceiling still bounds it.
- One map (Pangaea/Compact) and one seed. The removed copy is `O(tiles owned)`,
  so a map that keeps more seats alive on larger territory would weight it
  more heavily than this one does.
- 4-core machine; the 16 starter-policy processes and the episode share it.

## Reproduce

```bash
git worktree add /tmp/baseline 42ce1ac^
ln -s "$PWD/node_modules" /tmp/baseline/node_modules
BENCH_LABEL=after node coworld-adapter/scripts/episode-time-bench.mjs
BENCH_LABEL=before BENCH_REPO=/tmp/baseline \
  node coworld-adapter/scripts/episode-time-bench.mjs
```
