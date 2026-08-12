/**
 * A/B harness: 16-seat / N-decision-step Coworld-shaped episode, timed.
 *
 * Reproduces the hosted `proxywar-ffa-16p` episode shape from
 * coworld-adapter/src/no-docker-coworld-episode.ts (16 seats, uniform
 * "opportunistic" profile, Pangaea Compact Easy, warships disabled,
 * retainTacticalAffordances:false, mirror catch-up on) but drives the seats
 * with the in-repo RuleAgentBrain instead of external websocket policies, so
 * wall clock is pure engine work (simulation + observation build + legal-action
 * build + mirror) with no network/LLM latency.
 *
 * Point the module root at any checkout with PROXYWAR_REPO so the same script
 * measures two commits.
 */
import fs from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";

const repo = process.env.PROXYWAR_REPO ?? "/home/user/ProxyWar";
const STEPS = Number(process.env.BENCH_STEPS ?? "200");
const TURNS_PER_STEP = Number(process.env.BENCH_TURNS_PER_STEP ?? "100");
const SEATS = Number(process.env.BENCH_SEATS ?? "16");
const GAME_ID = process.env.BENCH_GAME_ID ?? "BENCH161";
const OUT = process.env.BENCH_OUT ?? "/dev/stdout";

const imp = (rel: string): Promise<Record<string, any>> =>
  import(pathToFileURL(path.join(repo, rel)).href);

const [configMod, gameMod, terrainMod, serverMod, leagueMod, mirrorMod, stepMod] =
  await Promise.all([
    imp("src/core/configuration/Config.ts"),
    imp("src/core/game/Game.ts"),
    imp("src/core/game/TerrainMapLoader.ts"),
    imp("src/server/GameServer.ts"),
    imp("src/server/agents/AgentLeagueMatch.ts"),
    imp("src/server/agents/AgentLocalGameMirror.ts"),
    imp("src/server/agents/AgentStepLockedLeague.ts"),
  ]);
const obsMod = await imp("src/server/agents/AgentObservationBuilder.ts");
const winston = (await import("winston")).default;

const {
  GameMapType,
  GameMapSize,
  GameMode,
  GameType,
  Difficulty,
  UnitType,
} = { ...gameMod, ...configMod } as any;
const { loadTerrainMap } = terrainMod as any;
const { GameServer, GameEnv } = { ...serverMod, ...configMod } as any;
const { AgentLeagueMatchRunner, createAgentParticipants, buildSpawnCandidates } =
  leagueMod as any;
const { AgentLocalGameMirror } = mirrorMod as any;
const { runAgentStepLockedLeague } = stepMod as any;
const { AgentObservationBuilder } = obsMod as any;

/** Wraps build() so the episode reports how much of its wall clock is observation build. */
class TimedObservationBuilder extends AgentObservationBuilder {
  totalNs = 0n;
  calls = 0;
  build(input: unknown) {
    const t0 = process.hrtime.bigint();
    const result = super.build(input as never);
    this.totalNs += process.hrtime.bigint() - t0;
    this.calls += 1;
    return result;
  }
}

class StaticMapLoader {
  private readonly cache = new Map<string, unknown>();
  private readonly rootDir = path.join(repo, "resources/maps");
  getMapData(map: string) {
    const hit = this.cache.get(map);
    if (hit !== undefined) return hit;
    const key = Object.keys(GameMapType).find(
      (k) => (GameMapType as any)[k] === map,
    );
    if (key === undefined) throw new Error(`Unknown map: ${map}`);
    const dir = path.join(this.rootDir, key.toLowerCase());
    const data = {
      mapBin: () => fs.promises.readFile(path.join(dir, "map.bin")),
      map4xBin: () => fs.promises.readFile(path.join(dir, "map4x.bin")),
      map16xBin: () => fs.promises.readFile(path.join(dir, "map16x.bin")),
      manifest: () =>
        fs.promises
          .readFile(path.join(dir, "manifest.json"), "utf8")
          .then((t) => JSON.parse(t)),
      webpPath: path.join(dir, "thumbnail.webp"),
    };
    this.cache.set(map, data);
    return data;
  }
}

const log = winston.createLogger({
  level: "error",
  format: winston.format.simple(),
  transports: [new winston.transports.Console()],
});

const gameConfig = {
  gameMap: GameMapType.Pangaea,
  gameMapSize: GameMapSize.Compact,
  gameMode: GameMode.FFA,
  gameType: GameType.Private,
  difficulty: Difficulty.Easy,
  nations: "disabled",
  donateGold: true,
  donateTroops: true,
  bots: 0,
  infiniteGold: false,
  infiniteTroops: false,
  instantBuild: false,
  randomSpawn: false,
  disabledUnits: [UnitType.Warship],
  maxTimerValue: 60,
  startingGold: 200000,
  maxPlayers: SEATS,
};

const mapLoader = new StaticMapLoader();
const terrain = await loadTerrainMap(
  gameConfig.gameMap,
  gameConfig.gameMapSize,
  mapLoader,
  { cache: false },
);
const spawnCandidates = buildSpawnCandidates(terrain.gameMap, {
  maxCandidates: 1000,
  stride: 2,
});

// Fixed persistent IDs: the episode must be byte-identical across arms.
const specs = Array.from({ length: SEATS }, (_, i) => ({
  username: `Coworld FFA ${i + 1}`,
  profile: "opportunistic",
  persistentID: `bench-seat-${String(i + 1).padStart(2, "0")}`,
}));
const participants = createAgentParticipants(specs, log, {
  retainTurnMessagesPrimaryOnly: true,
});

const game = new GameServer(
  GAME_ID,
  log,
  1_700_000_000_000,
  { turnIntervalMs: () => 60 * 60 * 1000, env: () => GameEnv.Dev },
  gameConfig,
);
const observationBuilder = new TimedObservationBuilder();
const league = new AgentLeagueMatchRunner({
  game,
  participants,
  spawnCandidates,
  log,
  retainTacticalAffordances: false,
  observationBuilder,
});
const mirror = new AgentLocalGameMirror(mapLoader, log, terrain);

const steps: Array<{
  step: number;
  turn: number;
  wallMs: number;
  obsMs: number;
  tiles: number;
}> = [];
let lastStepEnd = 0n;
let lastObsNs = 0n;

league.attachAgents();
league.startGame();

const episodeStart = process.hrtime.bigint();
lastStepEnd = episodeStart;
const result = await runAgentStepLockedLeague({
  league,
  game,
  mirror,
  messages: () => participants[0]?.runner.serverMessages() ?? [],
  config: {
    maxSteps: STEPS,
    turnsPerDecisionStep: TURNS_PER_STEP,
    maxDecisionMs: 60_000,
    requireWinner: false,
    waitForMirrorCatchup: true,
  },
  onSnapshot: (snapshot: any) => {
    const now = process.hrtime.bigint();
    steps.push({
      step: steps.length,
      turn: snapshot.turnNumber,
      wallMs: Number(now - lastStepEnd) / 1e6,
      obsMs: Number(observationBuilder.totalNs - lastObsNs) / 1e6,
      tiles: snapshot.gameState
        .players()
        .reduce((sum: number, p: any) => sum + p.numTilesOwned(), 0),
    });
    lastStepEnd = now;
    lastObsNs = observationBuilder.totalNs;
  },
  log,
});
const episodeNs = process.hrtime.bigint() - episodeStart;

// Trajectory fingerprint: proves both arms simulated the identical episode, so
// the wall-clock delta is the code change and nothing else.
const allRecords = [...result.openingRecords, ...result.postSpawnRecords];
const fingerprintSource = allRecords
  .map((r: any) => `${r.username}|${r.chosenActionID}`)
  .join("\n");
const { createHash } = await import("node:crypto");
const finalTiles = result.finalGameState
  .players()
  .map((p: any) => `${p.name()}:${p.numTilesOwned()}`)
  .sort()
  .join(",");

const report = {
  repo,
  seats: SEATS,
  steps: STEPS,
  turnsPerStep: TURNS_PER_STEP,
  stepsCompleted: result.stepsCompleted,
  finalTurn: mirror.turnCount(),
  episodeMs: Number(episodeNs) / 1e6,
  observationBuildMs: Number(observationBuilder.totalNs) / 1e6,
  observationBuildCalls: observationBuilder.calls,
  decisionRecords: allRecords.length,
  winner: result.finalGameState.getWinner() !== null,
  decisionFingerprint: createHash("sha256")
    .update(fingerprintSource)
    .digest("hex"),
  finalTilesFingerprint: createHash("sha256").update(finalTiles).digest("hex"),
  perStep: steps,
};
fs.writeFileSync(OUT, JSON.stringify(report, null, 2));
await game.end({ archive: false });
process.exit(0);
