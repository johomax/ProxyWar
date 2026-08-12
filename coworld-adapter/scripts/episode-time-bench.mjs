#!/usr/bin/env node
// Episode wall-clock benchmark for the Coworld game image.
//
// Runs the EXACT hosted episode code path (no-docker standalone mode of
// coworld-adapter/src/no-docker-coworld-episode.ts) on a shipped manifest
// variant and reports how long the episode itself took. Modelled on
// scripts/memory-gate.mjs, which uses the same spawn recipe.
//
// The reported number is the runner's own startedAt -> completedAt bracket
// (map load + spawn phase + every decision step), read back from the Proxy
// War match-summary.json the episode writes. Process wall clock is reported
// too so harness overhead stays visible.
//
// Each run also reports the final per-seat tile counts and scores. Two builds
// that produce the SAME fingerprint played the same simulation, so a time
// difference between them is a speed difference and nothing else.
//
// Env knobs:
//   BENCH_REPO=<dir>         checkout to measure (default: this one). Point it
//                            at a worktree of an older commit to A/B builds.
//   BENCH_MANIFEST=<file>    manifest (default coworld_manifest_ffa16p.json)
//   BENCH_VARIANT=<id>       variant id (default sixteen-player-ffa-pangaea)
//   BENCH_STEPS=<n>          decision steps (default 200)
//   BENCH_REPEATS=<n>        episodes per invocation (default 1)
//   BENCH_HEAP_MB=<n>        --max-old-space-size (default 640, hosted posture)
//   BENCH_SEED=<n>           Coworld episode seed, 0..11881375 (default 812026)
//   BENCH_TIMEOUT_MS=<n>     per-episode hard timeout (default 10,800,000)
//   BENCH_LABEL=<s>          label stamped into the JSON report
//   BENCH_OUT=<file>         report path (default artifacts/episode-time-bench/<ts>.json)

import { spawn } from "node:child_process";
import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

// BENCH_REPO points the run at a DIFFERENT checkout of this repo (e.g. a
// worktree at an older commit) so the same harness can A/B two builds.
const repoRoot =
  process.env.BENCH_REPO ??
  path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");
const adapterRoot = path.join(repoRoot, "coworld-adapter");

const MANIFEST =
  process.env.BENCH_MANIFEST ?? "coworld/coworld_manifest_ffa16p.json";
const VARIANT_ID = process.env.BENCH_VARIANT ?? "sixteen-player-ffa-pangaea";
const STEPS = Number(process.env.BENCH_STEPS ?? 200);
const REPEATS = Number(process.env.BENCH_REPEATS ?? 1);
const HEAP_MB = Number(process.env.BENCH_HEAP_MB ?? 640);
const TIMEOUT_MS = Number(process.env.BENCH_TIMEOUT_MS ?? 10_800_000);
const LABEL = process.env.BENCH_LABEL ?? "unlabeled";

const manifestPath = path.join(adapterRoot, MANIFEST);
const manifest = JSON.parse(readFileSync(manifestPath, "utf8"));
const variant = (manifest.variants ?? []).find((v) => v?.id === VARIANT_ID);
if (variant?.game_config === undefined) {
  console.error(
    `[bench] variant "${VARIANT_ID}" with a game_config was not found in ${manifestPath}`,
  );
  process.exit(1);
}

const gameConfig = structuredClone(variant.game_config);
gameConfig.max_decision_steps = STEPS;
const seatCount = gameConfig.players?.length ?? 0;
gameConfig.tokens = Array.from(
  { length: seatCount },
  (_, i) => `episode-time-bench-token-${i + 1}`,
);
// Fix the simulation identity so every run under comparison plays the same
// game: GameRunner seeds from simpleHash(gameID) and the adapter derives the
// gameID from this seed (coworld-seed.ts).
gameConfig.seed = Number(process.env.BENCH_SEED ?? 812026);

const workDir = mkdtempSync(path.join(tmpdir(), "proxywar-episode-bench-"));
const configPath = path.join(workDir, "config.json");
writeFileSync(configPath, `${JSON.stringify(gameConfig, null, 2)}\n`);

const runnableEnv = manifest.game?.runnable?.env ?? {};
const turnsPerStep = Number(gameConfig.turns_per_decision_step ?? 100);
console.error(
  `[bench] label=${LABEL} variant=${VARIANT_ID} map=${gameConfig.map}/${gameConfig.map_size} ` +
    `seats=${seatCount} steps=${STEPS} (~${STEPS * turnsPerStep} turns) ` +
    `heap=${HEAP_MB}MB repeats=${REPEATS}`,
);

function runEpisode(index) {
  return new Promise((resolve) => {
    const startedAt = Date.now();
    const child = spawn(
      process.execPath,
      [
        `--max-old-space-size=${HEAP_MB}`,
        "--import",
        "tsx/esm",
        path.join(adapterRoot, "src", "no-docker-coworld-episode.ts"),
      ],
      {
        cwd: repoRoot,
        env: {
          ...runnableEnv,
          ...process.env,
          GAME_ENV: "dev",
          PROXYWAR_REPO: repoRoot,
          COGAME_CONFIG_URI: pathToFileURL(configPath).href,
          // The app-shell/replay route checks need a built client bundle;
          // this benchmark measures episode time only.
          PROXYWAR_SKIP_ROUTE_CHECKS: "1",
        },
        stdio: ["ignore", "pipe", "pipe"],
      },
    );

    let stdout = "";
    let stderrTail = [];
    child.stdout.on("data", (chunk) => {
      stdout += chunk.toString();
    });
    child.stderr.on("data", (chunk) => {
      for (const line of chunk.toString().split("\n")) {
        if (line.length === 0) continue;
        stderrTail.push(line);
        if (stderrTail.length > 400) stderrTail = stderrTail.slice(-200);
        if (line.includes("[MEM]") || line.includes("decision step complete")) {
          process.stderr.write(`[bench ${LABEL} #${index}] ${line}\n`);
        }
      }
    });

    const timer = setTimeout(() => {
      child.kill("SIGKILL");
    }, TIMEOUT_MS);

    child.on("close", (code) => {
      clearTimeout(timer);
      const processWallMs = Date.now() - startedAt;
      resolve(
        summarize({
          index,
          code,
          stdout,
          stderrTail,
          processWallMs,
          startedAt,
        }),
      );
    });
  });
}

function summarize(input) {
  // The proof JSON is interleaved with `[player <pid>] ...` lines, so pull the
  // two paths out by field rather than parsing the whole stream.
  const field = (name) =>
    input.stdout.match(new RegExp(`"${name}":\\s*"([^"]+)"`))?.[1] ?? null;
  const artifactDir = field("proxyWarArtifactDir") ?? findLatestRunDir();
  const workspace = field("workspace");
  const readJson = (file) => {
    try {
      return JSON.parse(readFileSync(file, "utf8"));
    } catch {
      return null;
    }
  };
  const summary = readJson(path.join(artifactDir, "match-summary.json"));
  const results =
    workspace === null ? null : readJson(path.join(workspace, "results.json"));
  return {
    index: input.index,
    exitCode: input.code,
    ok: input.code === 0 && summary !== null,
    processWallMs: input.processWallMs,
    // The runner's own bracket: map load + spawn + every decision step.
    episodeMs: summary?.durationMs ?? null,
    decisionCount: summary?.decisionCount ?? null,
    averageDecisionLatencyMs: summary?.averageDecisionLatencyMs ?? null,
    turnCount: results?.turn_count ?? null,
    tick: results?.tick ?? null,
    winnerSlot: results?.winner_slot ?? null,
    // Trajectory fingerprint: identical across builds means both measured
    // the same simulation, so a time delta is a speed delta and nothing else.
    scores: results?.scores ?? null,
    tilesOwned: results?.players?.map((p) => p.tiles_owned) ?? null,
    artifactDir,
    stderrTail: input.code === 0 ? undefined : input.stderrTail.slice(-40),
  };
}

function findLatestRunDir() {
  const base = path.join(repoRoot, "artifacts", "ai-league-runs");
  try {
    const dirs = readdirSync(base)
      .filter((d) => d.startsWith("coworld-"))
      .sort();
    return path.join(base, dirs[dirs.length - 1]);
  } catch {
    return "";
  }
}

const runs = [];
for (let i = 0; i < REPEATS; i++) {
  const run = await runEpisode(i);
  runs.push(run);
  console.error(
    `[bench ${LABEL} #${i}] exit=${run.exitCode} episodeMs=${run.episodeMs} ` +
      `processWallMs=${run.processWallMs} turns=${run.turnCount} decisions=${run.decisionCount}`,
  );
}

const okRuns = runs.filter((r) => r.ok);
const episodeMsValues = okRuns.map((r) => r.episodeMs).sort((a, b) => a - b);
const report = {
  label: LABEL,
  manifest: MANIFEST,
  variant: VARIANT_ID,
  seats: seatCount,
  steps: STEPS,
  turnsPerStep,
  heapMB: HEAP_MB,
  seed: gameConfig.seed,
  node: process.version,
  runs,
  medianEpisodeMs:
    episodeMsValues.length > 0
      ? episodeMsValues[Math.floor((episodeMsValues.length - 1) / 2)]
      : null,
  minEpisodeMs: episodeMsValues[0] ?? null,
};

const outPath =
  process.env.BENCH_OUT ??
  path.join(
    repoRoot,
    "artifacts",
    "episode-time-bench",
    `${new Date().toISOString().replace(/[:.]/g, "-")}-${LABEL}.json`,
  );
mkdirSync(path.dirname(outPath), { recursive: true });
writeFileSync(outPath, `${JSON.stringify(report, null, 2)}\n`);
console.error(`[bench] report: ${outPath}`);
console.log(JSON.stringify(report, null, 2));
process.exit(okRuns.length === runs.length ? 0 : 1);
