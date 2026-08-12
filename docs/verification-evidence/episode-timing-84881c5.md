# Episode timing: "Reuse sorted tiles for build searches" (84881c5)

Measured effect of 84881c5 on a 16-seat, 200-decision-step episode.

## Result

**−39.2s per episode (−10.1%), 387.1s → 348.0s.**

| Arm              | Episode wall clock          | Observation build           |
| ---------------- | --------------------------- | --------------------------- |
| before (664fe47) | 391.4s, 382.9s → **387.1s** | 377.5s, 369.7s → **373.6s** |
| after (84881c5)  | 346.2s, 349.7s → **348.0s** | 333.2s, 336.6s → **334.9s** |
| delta            | **−39.2s (−10.1%)**         | **−38.7s (−10.4%)**         |

Per observation build: 250.9ms → 224.9ms (−26.0ms). Per 16-seat decision step:
−294ms. Run-to-run spread within an arm is 3.5s (after) and 8.5s (before), far
below the 39.2s effect.

Both arms produced identical decision and final-tile fingerprints
(`579824b07867dcd7…`), identical step counts, and identical observation-build
counts — the refactor is behavior-preserving, so the delta is the code change
and nothing else.

## Where the time goes

Observation build is 96.5% of engine-side episode wall clock, and 84881c5 takes
10.4% off it. Savings per step are flat in absolute terms and rise as a share as
seats are eliminated:

| Steps   | Owned tiles | before ms/step | after ms/step | saved       |
| ------- | ----------- | -------------- | ------------- | ----------- |
| 0–32    | 83,934      | 3,828          | 3,552         | 276 (7.2%)  |
| 33–66   | 102,193     | 3,469          | 3,131         | 338 (9.8%)  |
| 67–99   | 102,211     | 2,382          | 2,078         | 303 (12.7%) |
| 100–133 | 102,211     | 1,889          | 1,638         | 251 (13.3%) |

`AgentLeagueMatch.runDecisionTurn` builds every active seat's observation
serially and synchronously _before_ any brain is called; only the brain calls
run under `Promise.all`. Observation build is therefore on the critical path and
is never overlapped with external policy latency, so these seconds come off
hosted episode wall clock the same way they come off the headless number.

## Why it is faster

`buildOptions` evaluates 9 candidate unit types. Before, each one called
`buildSearchTiles`, which re-ran `Array.from(player.tiles())` and re-sorted by
`manhattanDist` from the spawn tile: 9 full owned-tile copies and 6 sorts per
observation build, including 3 wasted copies on the nuke paths that discard the
result. After, the copy and sort happen once per build; `DefensePost` and `Port`
filter the already-sorted array, and the rest reuse it directly. The comparator
moved into a shared `buildSearchTileComparator`, which keeps the ordering
identical (`manhattanDist`, ties broken by tile ref).

## Reproducing

`src/scripts/ai-agent-episode-timing-bench.ts` reproduces the hosted
`proxywar-ffa-16p` episode shape from
`coworld-adapter/src/no-docker-coworld-episode.ts` — Pangaea Compact, Easy, 16
seats on the uniform `opportunistic` profile, warships disabled,
`retainTacticalAffordances: false`, mirror catch-up on. Seats use the in-repo
`RuleAgentBrain`, so wall clock is engine work only, with no network or LLM
latency in the number.

```bash
git worktree add /tmp/before --detach HEAD~1
ln -s "$PWD/node_modules" /tmp/before/node_modules

for arm in /home/user/ProxyWar /tmp/before; do
  BENCH_STEPS=200 PROXYWAR_REPO=$arm GAME_ENV=dev BENCH_OUT=/tmp/$(basename $arm).json \
    node --max-old-space-size=8192 --import tsx/esm \
    src/scripts/ai-agent-episode-timing-bench.ts
done
```

Four runs, arms interleaved (after, before, after, before), on a 4-core box.

## Caveat

The 200 in "200-step episode" is the decision-step budget, not the realized
length: with this seed and roster a seat reaches the 80% map-control win
condition at step 133 (turn 13,700) and the episode ends there. Both arms end at
the same step, so the comparison is unaffected, but the 39.2s figure is for a
133-step episode. Per-step savings (≈250–340ms) are the number to scale if an
episode runs to a different depth.
