# Engine performance audit: why large-map episodes take an hour

Date: 2026-08-12. Follow-up to the quarantine of World / Britannia / NorthAmerica
from the Competition rotations (`b13b15f`), which measured ~15 s per 100-turn
decision cycle on NorthAmerica (1.24M land tiles) vs ~5 s on Oceania (195k).
This audit answers: where does that time actually go, and what engine work
re-admits the big maps?

## TL;DR

The core simulation is NOT the bottleneck. Measured headless on GiantWorldMap
(4108×1948 = 8.0M raster tiles, 2.33M land — larger than any quarantined map),
the full sim tick loop costs **~0.5 ms/tick early game to ~2.6 ms/tick** with
eight players owning up to 576k tiles and fighting. A 36,000-turn episode is
**~1–2 minutes of pure sim compute**.

The wall-clock hour is the **per-decision agent layer**, dominated by
`AgentObservationBuilder.build()`: measured **0.6–1.3 s per seat** on the same
late-game state. A 16-seat cycle ≈ 15 s — which reproduces the `b13b15f`
NorthAmerica number almost exactly. 500 decision steps × ~15 s ≈ 2 h; the
"typical" 36–52 min episodes are the same cost with fewer live seats/steps.

Fixing the top three observation-builder items should cut large-map episode
wall-clock by roughly an order of magnitude. Core-sim fixes are worth doing
after, mostly for constant factors, GC pressure and the bot/nation modes.

## Measurements (this audit)

Headless GameRunner drive loop (mimics `AgentLocalGameMirror`), GiantWorldMap
Normal, 8 seats, no bots/nations (tournament config), expansion + PvP attacks:

| Metric | Value |
| --- | --- |
| Sim init (map parse + game construction) | ~0.3 s |
| Spawn phase (300 turns) | ~60 ms total |
| Sim tick, early game (≤10k tiles/player) | 0.5–1.2 ms |
| Sim tick, late game (100k–576k tiles/player) | 1.5–2.6 ms |
| 15,000 turns of sim, wall clock | 22 s |
| `AgentObservationBuilder.build()` per seat, late game | 0.6–1.3 s |
| Observation builds, one 7-seat decision cycle | 6.6 s (vs 0.15 s for its 100 sim turns) |

CPU profile of the sim loop (drive loop only, no observations): ~40%
`AttackExecution` (border spread), ~21% `PlayerExecution`
cluster recompute, ~12% `GameImpl` tile primitives, ~4% GC. None of it
O(map) per tick — per-tick cost scales with active borders, as designed.

CPU profile of `AgentObservationBuilder.build()` itself (10 rounds × 7 seats,
~58 s of build time):

| Share | Where |
| --- | --- |
| ~30% | build-target search: `canBuild` → `PlayerImpl.validStructureSpawnTiles` per candidate tile (radius-15 BFS + Set + sort each), plus its closures |
| ~25% | `neutralIslandTransportTiles` whole-raster `forEachTile` + `nearestManhattanDistance` per surviving tile |
| ~15% | boat reachability: `SpatialQuery.bfsNearest` / `GameMap.bfs` / `closestShore` / bounded water A* |
| ~5–8% | `buildSearchTiles` territory copy + manhattan sort (`PlayerImpl.tiles()` copies) |
| ~3% | GC (allocation churn from all of the above) |

## P0 — the decision-cycle layer (the actual hour)

### 1. `neutralIslandTransportTiles` scans the whole raster per seat per decision

`src/server/agents/AgentObservationBuilder.ts:1364` runs
`gameState.forEachTile(...)` — all width×height refs (8.0M on GiantWorldMap,
2M on World) — for every seat, every decision step, plus a
`nearestManhattanDistance` against up to 48 sampled shores for surviving
tiles. The comment at :1396 already records the prior 77%-of-CPU incident in
this function; the per-neighbor copy was fixed, the whole-map scan stayed.
Gate (:1000–1006) only skips it when TransportShip is disabled or the seat is
at `boatMaxNumber` — i.e. it runs on nearly every decision of every episode.
16 seats × 500 steps ⇒ **8,000–16,000 full-map scans per episode**.

Fixes, in increasing order of ambition:
- Cache per step: candidate islands don't differ meaningfully between seats;
  compute unowned-shore tiles once per decision step, then filter per seat
  (`touchesOwnedTerritory`, distance) on that small set. ~16× fewer scans.
- Cache across steps: unowned shore tiles change only when someone conquers a
  shore tile; maintain the set incrementally off `recordTileUpdate`/conquer
  events instead of rescanning.
- Precompute island IDs once at map load (connected components of land);
  "neutral island reachable by boat" is then a per-island ownership check, no
  tile scan at all.

Related, same code path (~15% of build time measured): the boat-target
reachability checks (`SpatialQuery.bfsNearest`, `closestShore`, bounded water
A*) construct fresh pathfinder stacks and typed-array buffers per call
(`TransportShipUtils.ts:29`, `SpatialQuery.ts:103`); memoize the stacks per
game and reuse buffers.

### 2. `findBuildTarget` runs a BFS-and-sort per candidate tile — up to ~2,000 times per seat per decision

`AgentObservationBuilder.ts:704` tries up to `buildCandidateLimit(unit)`
candidates (400 for DefensePost, 240 for City/Factory/SAM/Silo, 120 default)
for each of 9 unit types, calling `player.canBuild(unit, tile)` on each.
For land structures that lands in `PlayerImpl.validStructureSpawnTiles`
(`src/core/game/PlayerImpl.ts:1342`): a radius-15 BFS (~700 tiles into a
`Set`), an O(tiles × nearbyUnits) spacing rejection, `Array.from`, and a
distance sort — after which `landBasedStructureSpawn` (:1331) reads **only
element `[0]`**. Measured ~30% of build time, and it is core-engine code, so
bot/nation structure placement pays it too.

Fixes:
- Return the first valid tile from an outward-ordered BFS (no Set, no sort,
  early exit) — `canBuild` and `landBasedStructureSpawn` only need one tile.
- Skip unit types the player cannot afford before candidate iteration.
- Overlapping candidates recompute nearly identical disks; a per-decision
  valid-placement mask per unit type would collapse the whole loop to O(disk).

### 3. `buildSearchTiles` copies + sorts the full territory 9× per seat per decision

`src/server/agents/AgentObservationBuilder.ts:741` does
`Array.from(player.tiles())` — and `PlayerImpl.tiles()`
(`src/core/game/PlayerImpl.ts:321`) itself returns `new Set(...)`, a full
O(T) copy — then sorts O(T log T) with `manhattanDist` (2 div/mod per
comparison) at :755. `buildOptions()` (:622) runs this for **9 unit types**,
before any affordability check. For a 168k-tile player that is ~18 full
territory copies plus ~5 large sorts per decision.

Fixes:
- Check `player.gold() >= cost` per unit type *before* computing candidates.
- Compute `tiles`/sorted-candidate pools once per build() and share across the
  9 unit types (only DefensePost/Port/nuke branches differ, and they filter).
- Only the nearest `buildCandidateLimit(unit)` tiles are ever used (:704):
  select top-K by distance (O(T) with a bounded heap) instead of a full sort.
- Make `PlayerImpl.tiles()` return the live ReadonlySet instead of a copy
  (callers must not mutate; the two mutating callers can use a private
  accessor). This also fixes `AgentSpectatorReplay.ts:190` (2 more full
  copies per player per snapshot) and `SpawnExecution.ts:59`.

### 4. The whole observation is built twice per seat once comms exist

`src/server/agents/AgentLeagueMatch.ts:397–409`: `build()` runs, then
`recentCommunicationSignalsFor(...)` is computed, and if non-empty the entire
observation is **rebuilt** just to include it. After the first accepted
communication of a match this doubles items 1–2 for the rest of the episode.
Fix: build once with communications passed in (compute signals first), or
attach comms to the finished observation object. Also
`recentCommunicationSignalsFor` filters *all* accumulated records each time
(`AgentLeagueMatch.ts:1121`) → O(decisions²) over an episode; keep a
per-participant rolling window instead.

### 5. `visiblePlayers` does O(seats²) full border scans per decision

`AgentObservationBuilder.ts:313` calls `player.sharesBorderWith(other)` for
every pair; `PlayerImpl.ts:306` scans the caller's entire border ring × 8
neighbors and only early-exits on a *hit*, so non-bordering pairs (the common
case) pay the full O(B) scan — 240 scans/step at 16 seats. Fix: maintain a
per-player neighbor-set incrementally (update on conquer/relinquish when
`ownerID` of an adjacent tile changes), making `sharesBorderWith` O(1).

### 6. Per-turn mirror waste (matters at 36k–50k turns/episode)

- `InProcessAgentSocket.send` (`src/server/agents/AgentRunner.ts:62`) runs
  `JSON.parse` + full Zod `ServerMessageSchema.safeParse` for every seat on
  every turn, then throws the result away for 15 of 16 seats
  (`retainTurnMessagesPrimaryOnly` skips only the *push*, not the parse).
  ~800k parse+validate per 16p/50k-turn episode. Fix: check
  `retainTurnMessages`/message type *before* parsing (the type is available on
  the pre-stringify object or via a cheap sniff), or hand the object across
  in-process without the stringify→parse→validate round trip.
- `GameRunner.executeNextTick` (`src/core/GameRunner.ts:167–196`) computes
  `placeName()` (client-side name-box placement: bbox scan + grid + largest
  inscribed rectangle) for every player every 30 ticks, packs
  `drainPackedTileUpdates()` into a fresh `Uint32Array` every tick, and builds
  `player.toUpdate()` for every player every tick
  (`GameImpl.ts:445` → ~10 allocations each, including per-tick filter+sort
  of never-pruned emoji/target histories in `PlayerImpl.ts:672–710`) — all
  delivered to the mirror's `() => undefined` callback
  (`AgentLocalGameMirror.ts:88–89`). Fix: a headless flag on
  GameRunner/GameImpl that skips view-data production (names, packed tiles,
  motion plans, per-player updates) when there is no consumer.
- `AgentRunner.serverMessages()` returns `[...this.sentMessages]` (full array
  copy) and is called from every `waitForMirrorState` poll and
  `advanceUntil` iteration; `submitIntent` copies the history twice more
  (`AgentRunner.ts:246,259`). Fix: expose length/tail accessors.

### 7. Episode-shape levers (no engine change)

- `turns_per_decision_step` schedule already exists
  (`--turns-per-decision-schedule`, `AgentStepLockedLeague.ts:228`): spending
  fewer decisions on the long mid-game directly divides the P0 costs.
- `GameMapSize.Compact` (map4x) is a 4× cut to every O(map) cost; the
  quarantined maps could return as Compact variants while Normal is gated on
  the fixes above.
- The rl-small-model-plan note ("AgentObservationBuilder blows up at high
  player counts") is the same defect as items 1–4, seen from seat count
  instead of map size: the per-seat cost is multiplied by live seats.

## P1 — core sim (constant factors; dominates only after P0)

From the sim-loop profile (~40% AttackExecution, ~21% PlayerExecution) plus
code audit:

1. **AttackExecution inner loop churn** (`src/core/execution/AttackExecution.ts`):
   per conquered tile: nested closure-based `forEachNeighbor` (≈16 lookups + 5
   closures), a `FlatBinaryHeap.dequeue()` that allocates a 2-element array
   per pop (`utils/FlatBinaryHeap.ts:47`), duplicate enqueues (tiles re-added
   once per adjacent conquest, filtered only after popping), and
   `attackLogic`'s `nearbyUnits(...)` spatial query per tile even when the
   defender owns zero DefensePosts (`DefaultConfig.ts:658`). Fixes: manual
   4-neighbor iteration (tile±1, tile±width) behind a bounds-safe fast path;
   `dequeue` into out-params/parallel arrays; skip the DefensePost query when
   the defender has none (cheap per-player unit-count check); optionally an
   in-frontier bitset to stop duplicate enqueues.
2. **`refreshToConquer()` then immediate `retreat()`**
   (`AttackExecution.ts:267–271`): a stalled attack rebuilds its whole O(B)
   frontier and then discards it one line later. Delete the refresh.
   Also `:117`: every non-boat attack init seeds from **all** owner border
   tiles — agents that re-issue attacks each decision step pay O(B) per
   intent; seeding from tiles bordering the *target* only is O(shared front).
3. **Cluster recompute on pure expansion**
   (`src/core/execution/PlayerExecution.ts:100–113`): `removeClusters()`
   (flood-fill over all border tiles + per-cluster `Set`s) runs every 20
   ticks whenever *any* tile changed — but expanding can't disconnect or
   surround your own territory; only tile *loss* can. Track lastTileLost
   (relinquish/loss path) and gate on that; use typed-array stacks instead of
   `Set` results. In the profiled run this was 21% of sim CPU with zero
   possible effect.
4. **`GameMap.ref()`/`isValidCoord` validation on the hottest accessor**
   (`src/core/game/GameMap.ts:125–167`): two `Number.isInteger` calls + range
   checks per neighbor lookup, ~2.5% of sim CPU on its own; add an unchecked
   internal path for the neighbor loops that already guarantee bounds.
5. **`decayRelations` O(P²)/tick** (`PlayerImpl.ts:640`) and per-tick
   captured-structure scan (`PlayerExecution.ts:44`) — negligible at 16
   seats, real in 100+ bot modes; make relations decay lazily on read, make
   capture event-driven from `conquer`.
6. **Unbounded histories** (`PlayerImpl.ts` `targets_`, `outgoingEmojis_`,
   `sentDonations`, `pastOutgoingAllianceRequests`) are filtered (and some
   sorted) every tick via `toUpdate()`; prune on read or index by tick.

## P2 — bot/nation modes only (not tournament episodes; nations=disabled, bots=0 there)

The nation/tribe AI re-scans borders with allocating APIs many times per
decision tick: `PlayerImpl.nearby()` (allocates a 4-element array per border
tile via `neighbors()`), `AiAttackBehavior.maybeAttack`'s
`Array.from(border).flatMap(neighbors)` (~5 allocations per border tile),
five separate uncached `Array.from(borderTiles()).filter(isShore)` sites,
`canBuildTransportShip` constructing a fresh pathfinder stack (0.5 MB–tens of
MB of typed arrays) per call inside up-to-500-iteration target loops
(`TransportShipUtils.ts:29`, `SpatialQuery.ts:103`, `AStar.Water.ts:43`),
`NationWarshipBehavior.trackShipsAndRetaliate` walking every unit in the game
every tick per nation (`NationExecution.ts:99`), and structure placement value
functions doing O(B log B) `closestTwoTiles` sorts per candidate tile
(`NationStructureBehavior.ts:905–1297`). These dominate bot-heavy demo/
training configurations and the spawn-phase `SpawnExecution` retry loop
(O(1000·P) per spawner); they are irrelevant to the current tournament
manifests but block "engine work" re-adds for any variant that turns bots or
nations back on.

## Structural (unlocks everything else)

`PlayerImpl._tiles`/`_borderTiles` as `Set<number>` is the root cost driver:
multi-million-entry hash sets with pointer-chasing iteration, copied wholesale
by `tiles()`. A per-tile owner array already exists (tile state); adding a
per-player dense tile list (Uint32Array free-list) and an incrementally
maintained border-neighbor index would turn most O(B)/O(T) scans above into
O(changed) updates. This is the long-pole change; everything in P0 is
achievable without it.

## Provenance: ProxyWar-specific vs inherited vs already fixed upstream

Compared against `openfrontio/openfrontio` HEAD (shallow clone, 2026-08-12).
Three buckets:

**ProxyWar-only (no upstream counterpart)** — the entire P0 layer lives in
fork code: `src/server/agents/*` (observation builder, legal actions, league
match, mirror, in-process socket), the coworld driver, and the headless use
of `GameRunner` with a no-op callback. Also fork-local:
`PlayerImpl.tiles()` returning a defensive `new Set(...)` copy — current
upstream returns the live set.

**Fixed in current upstream, still slow in our pinned engine** — targeted
backport candidates, they directly hit the profiled sim hot spots:
- `TileSet` (`src/core/game/TileSet.ts` upstream): typed-array open-addressing
  set replacing `Set<number>` for `_tiles`/`_borderTiles` (~12 vs ~30+
  bytes/entry) — this is the "Structural" item below, already built.
- `neighbors4(ref, out)` scratch-buffer API, used in the `AttackExecution`
  conquest loop and an allocation-free `sharesBorderWith`.
- `FlatBinaryHeap.dequeue()` returning a bare `TileRef` (no tuple per pop).
- `PlayerImpl.toUpdate(...)` returning `null` when unchanged plus packed
  stats quads — removes the per-player-per-tick update-object churn.
- `calculateClusters` returning `TileRef[][]` instead of per-cluster `Set`s.

**Present in current upstream too (both projects inherit)** —
`refreshToConquer()`-then-`retreat()`, `attackLogic`'s DefensePost
`nearbyUnits` per conquered tile, `validStructureSpawnTiles` BFS+sort with
`landBasedStructureSpawn` reading `[0]`, `placeName` every 30 ticks in
`GameRunner` (upstream needs it for rendering; only headless use makes it
waste), `decayRelations` every tick, `new SpatialQuery(...)` per
`canBuildTransportShip` call, `trackShipsAndRetaliate` every tick,
the `SpawnExecution` retry loop, `UnitGrid.nearbyUnits` result-object
allocation, and cluster recompute gated on any tile change rather than
tile loss.

Note the fork has its own engine perf work upstream lacks (`0c8aa2b`
arithmetic tile coords, `cefa354` columnar spawn scan, the cluster-traversal
gen-stamp buffer), so a wholesale engine sync is not free — but the five
backports above are self-contained.

## Suggested measurement guardrail

`coworld-adapter/scripts/memory-gate.mjs` already drives a real 80-step
`tournament-12p-world` episode under a 30-min timeout; extend it to record
wall-clock per decision step (observation build vs sim turns vs brain wait —
`decisionLatencyMs` exists, the other two need timers) and gate large-map
re-admission on "p95 cycle ≤ N s on NorthAmerica/Normal". `tickExecutionDuration`
is already measured per tick in `GameRunner.ts:149` and currently discarded.
