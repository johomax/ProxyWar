# ProxyWar league: container commissioner → platform commissioner

Container (Docker) commissioners are deprecated on the Softmax platform. This document is the
ProxyWar league's cutover package: the target platform ladder configuration, the mapping from
every container knob to its platform equivalent, and the behavior changes the cutover accepts.

The operator procedure itself (pause → drain → seed flip → settings → enable → prove one cycle)
is the platform's own runbook — `docs/ai/onboarding/services/coworlds/migrate-to-platform-commissioner.md`
in the Metta-AI/metta repo. This file supplies the ProxyWar-specific inputs to that procedure.

## Target configuration

[`platform-ladder.settings.json`](platform-ladder.settings.json) is the body for
`POST /v2/leagues/{league_id}/settings`, with `ladder.enabled: false` for the review step.
Before posting:

- Replace the `division_id` placeholder with the live Competition division id
  (`GET /v2/divisions?league_id=...`).
- `GET` the current settings first and merge — POST replaces the whole document, and any
  sibling fields (`counterfactual_eval`, ...) must be preserved.

League inventory (verify against prod before touching anything):

| Field               | Value                                                                                |
| ------------------- | ------------------------------------------------------------------------------------ |
| League              | `league_cb60d526-ecfd-4836-ab3a-81fc6cf7dc42` (the id the league mirror defaults to) |
| Coworld / seed name | `proxywar`                                                                           |
| Divisions           | Qualifiers (staging, level -99) + Competition (level 1)                              |
| Manifest seat range | `num_agents` 2–12; declared rungs 2p / 4p / 8p / 12p                                 |

## Knob mapping

Container sources: `configs/proxywar.yaml` (ruleset_strategy config) and `proxywar_app.py`
(the two custom overrides). `proxywar_app.py`'s docstring says the ladder-routing override
exists "only because the platform has no config knob" for seat-count routing — the platform
has since grown exactly that knob (`scaling_roster` + `variant_rotation_by_seat_count`), which
is what unblocks this migration.

| Container behavior                                                                                 | Platform equivalent                                                                                                                                                                                           |
| -------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `COMPETITION_LADDER` seat-count routing (largest declared rung the champion count fills)           | `scheduler.strategy: scaling_roster` with `seat_rungs: [2, 4, 8, 12]`                                                                                                                                         |
| Rolling-window seating when champions exceed the rung                                              | `roster_overflow: partition` — above 12 champions the roster splits into balanced tables; below that the whole roster seats at one table                                                                      |
| Per-rung map pools rotated by round number (12p Europe quarantined)                                | `variant_rotation_by_seat_count` with the same pools, Europe still omitted; the round seed picks the map each round instead of sequential rotation                                                            |
| `fill_seats: strict` (never fires — rung ≤ champions by construction)                              | `insufficient_players: multiple_seats` — the platform seats the whole roster at the smallest rung that holds it, so padding duplicates (filler-marked, never credited) are now a normal case                  |
| `stage.episodes: 4` per Competition round                                                          | `episodes_per_round: 4` (also the per-table count when partitioned)                                                                                                                                           |
| `schedule_interval_minutes: 30`                                                                    | top-level `settings.round_interval_minutes: 30` (sibling of `ladder`, not inside it)                                                                                                                          |
| `dispatch_throttle` (max 3 in flight)                                                              | not needed — episode dispatch is owned by the platform job runner; `fulfillment.allowed_failures: 0.25` lets one of four episodes fail without aborting the round, `retry_times: 2` bounds replacement rounds |
| `round_score: win` + `leaderboard: ewma`, 24-round half-life, ×100 scale, 5-round provisional gate | `ranking: {algorithm: score, round_scoring_rule: mean, standing_aggregation: ewma, half_life_hours: 12}` — 24 rounds at the 30-minute cadence ≈ 12 wall-clock hours                                           |
| Qualifiers division: self-play crash check, promote on any completed episode                       | Archive the Qualifiers division at cutover (Crewrift pattern); placed submissions enter Competition directly. Optional day-2 gate below                                                                       |

## Behavior changes this cutover accepts

- **Fresh standings.** The container EWMA board does not carry over. The new board is the
  0–1 mean-round-win-rate EWMA with a 12-hour wall-clock half-life — no ×100 display scale
  and no 5-round provisional gate.
- **Whole-roster tables instead of rolling windows.** Container: 7 champions → a 4-seat rung
  windowed across episodes. Platform: 7 champions → one 8-seat table (7 real seats + 1
  uncredited duplicate). Every champion seats every episode of the round.
- **Seeded map choice, not sequential rotation.** Each round's map is drawn from the rung's
  pool by the deterministic round seed, so a season sweeps the pool statistically rather than
  in fixed order.
- **No `episodeIndex` spawn-slot rotation.** The platform planner does not stamp the
  round-derived `episodeIndex` the container commissioner added (`_with_episode_index`);
  episodes fall back to the schema default of 0 with per-episode seeds. If spawn-slot
  fairness across repeated same-map/same-roster episodes turns out to matter on the live
  board, that is a platform feature request — not a reason to keep the container.
- **Champion-only seating.** Benched competing policy versions never seat; each player
  contributes exactly one champion per round (already effectively true for this league).

## Optional day-2 qualification gate

The container Qualifiers crash check can be reproduced platform-side once the base cutover
has soaked. It is deliberately **not** in the initial settings document: a misconfigured
qualification experience holds new memberships in `qualifying`, which is a worse failure
than admitting an occasional crasher whose seats just play fallback decisions.

```json
"qualification": {
  "experience": { "kind": "self_play", "num_episodes": 1, "seat_count": 2 },
  "gate": {
    "op": "pred",
    "pred": { "key": "result.accepted_decision_count", "operator": "gte", "value": 1 }
  },
  "max_attempts": 2,
  "attempt_timeout_minutes": 60
}
```

Before enabling it, verify the league's canonical variant resolves the self-play experience
to a cheap 2-seat episode (the container used the 5-decision-step `qualifier` variant).

## What stays in this repo

The commissioner image, its config, and the manifest's `commissioner` runnable entry all stay
until the platform deletes the container path entirely (its deprecation phase 3): other
environments and tools may still reference the runnable, and league ownership is the seed
override — never the presence or absence of a container image. Rollback (seed override back
to `"commissioner_key": "container"`, ladder disabled) regenerates the container config from
the seed template and resumes this image.
