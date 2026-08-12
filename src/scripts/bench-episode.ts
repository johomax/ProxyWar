/**
 * Episode-time benchmark for the in-process league engine.
 *
 * Runs a Coworld-shaped episode (same GameConfig, same runner options, same
 * step-locked loop as coworld-adapter/src/no-docker-coworld-episode.ts) with
 * deterministic in-process brains instead of websocket seats, so the wall clock
 * measures engine cost only. Prints one JSON line of timings.
 *
 * Usage:
 *   tsx src/scripts/bench-episode.ts --seats=16 --steps=200 \
 *     --turns-per-step=100 --brain=starter --label=head
 */
import { createHash } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import winston from "winston";

import { GameEnv } from "../core/configuration/Config";
import {
  Difficulty,
  GameMapSize,
  GameMapType,
  GameMode,
  GameType,
  UnitType,
} from "../core/game/Game";
import { GameMapLoader, MapData } from "../core/game/GameMapLoader";
import { loadTerrainMap, MapManifest } from "../core/game/TerrainMapLoader";
import { GameConfig } from "../core/Schemas";
import {
  AgentLeagueMatchRunner,
  AgentSpec,
  buildSpawnCandidates,
  createAgentParticipants,
} from "../server/agents/AgentLeagueMatch";
import { AgentLocalGameMirror } from "../server/agents/AgentLocalGameMirror";
import {
  AgentObservationBuilder,
  BuildAgentObservationInput,
} from "../server/agents/AgentObservationBuilder";
import { runAgentStepLockedLeague } from "../server/agents/AgentStepLockedLeague";
import { AgentBrain, AgentDecisionRecord } from "../server/agents/AgentTypes";
import { RuleAgentBrain } from "../server/agents/RuleAgentBrain";
import {
  chooseStarterAction,
  StarterBotAgentBrain,
} from "../server/agents/StarterBotAgentBrain";
import { GameServer } from "../server/GameServer";

const args = process.argv.slice(2);

function intArg(flag: string, fallback: number): number {
  const raw = args
    .find((arg) => arg.startsWith(`${flag}=`))
    ?.slice(flag.length + 1);
  if (raw === undefined) {
    return fallback;
  }
  const value = Number(raw);
  if (!Number.isSafeInteger(value) || value <= 0) {
    throw new Error(`${flag} must be a positive integer`);
  }
  return value;
}

function stringArg(flag: string, fallback: string): string {
  return (
    args.find((arg) => arg.startsWith(`${flag}=`))?.slice(flag.length + 1) ??
    fallback
  );
}

const seats = intArg("--seats", 16);
const steps = intArg("--steps", 200);
const turnsPerStep = intArg("--turns-per-step", 100);
const brainMode = stringArg("--brain", "starter");
const mapName = stringArg("--map", "Pangaea");
const mapSizeName = stringArg("--map-size", "Compact");
const gameID = stringArg("--game-id", "PWSAAAAB");
const label = stringArg("--label", "run");
// --brain=communicating only: take a communication action every Nth decision.
const commsEvery = intArg("--comms-every", 3);

/** Counts and times every observation build the episode performs. */
class InstrumentedObservationBuilder extends AgentObservationBuilder {
  builds = 0;
  buildNs = 0n;

  override build(input: BuildAgentObservationInput) {
    const startedAt = process.hrtime.bigint();
    const observation = super.build(input);
    this.buildNs += process.hrtime.bigint() - startedAt;
    this.builds += 1;
    return observation;
  }
}

class StaticMapLoader implements GameMapLoader {
  private readonly maps = new Map<GameMapType, MapData>();
  private readonly rootDir: string;

  constructor() {
    const currentFile = fileURLToPath(import.meta.url);
    this.rootDir = path.resolve(
      path.dirname(currentFile),
      "../../resources/maps",
    );
  }

  getMapData(map: GameMapType): MapData {
    const cached = this.maps.get(map);
    if (cached !== undefined) {
      return cached;
    }
    const mapDir = path.join(this.rootDir, this.mapDirectoryName(map));
    const mapData = {
      mapBin: () => fs.promises.readFile(path.join(mapDir, "map.bin")),
      map4xBin: () => fs.promises.readFile(path.join(mapDir, "map4x.bin")),
      map16xBin: () => fs.promises.readFile(path.join(mapDir, "map16x.bin")),
      manifest: () =>
        fs.promises
          .readFile(path.join(mapDir, "manifest.json"), "utf8")
          .then((text) => JSON.parse(text) as MapManifest),
      webpPath: path.join(mapDir, "thumbnail.webp"),
    } satisfies MapData;
    this.maps.set(map, mapData);
    return mapData;
  }

  private mapDirectoryName(map: GameMapType): string {
    const enumKey = Object.keys(GameMapType).find(
      (key) => GameMapType[key as keyof typeof GameMapType] === map,
    );
    if (enumKey === undefined) {
      throw new Error(`Unknown map: ${map}`);
    }
    return enumKey.toLowerCase();
  }
}

function enumValue<T extends Record<string, string>>(
  values: T,
  raw: string,
): T[keyof T] {
  const match = Object.values(values).find((value) => value === raw);
  if (match === undefined) {
    throw new Error(`Unknown value ${raw}`);
  }
  return match as T[keyof T];
}

// Deterministic seat identity: the same episode must be replayable across
// builds, so nothing here may come from randomUUID()/generateID().
function seatSpecs(count: number): AgentSpec[] {
  return Array.from({ length: count }, (_, index) => ({
    username: `Coworld FFA ${index + 1}`,
    profile: "opportunistic" as const,
    clientID: createHash("sha256")
      .update(`bench-episode\0${gameID}\0client\0${index}`)
      .digest("hex")
      .slice(0, 8),
    persistentID: createHash("sha256")
      .update(`bench-episode\0${gameID}\0persistent\0${index}`)
      .digest("hex")
      .slice(0, 32),
  }));
}

const COMMUNICATION_KINDS = [
  "quick_chat",
  "alliance_request",
  "emoji",
  "target_player",
] as const;

/**
 * Starter policy with a diplomacy dial: every Nth decision takes a
 * communication action when one is offered, rotating through the four
 * communication kinds. Deterministic, and the stand-in for league policies
 * that actually use the diplomacy channel — the starter and rule brains never
 * do, so on their own they never exercise the recent-communications path.
 */
class CommunicatingBrain implements AgentBrain {
  readonly brainType = "rule";
  private decisions = 0;

  constructor(private readonly every: number) {}

  decide(input: Parameters<AgentBrain["decide"]>[0]) {
    this.decisions += 1;
    if (this.decisions % this.every === 0) {
      const rotation = Math.floor(this.decisions / this.every);
      const preferred =
        COMMUNICATION_KINDS[rotation % COMMUNICATION_KINDS.length];
      const action =
        input.legalActions.find((candidate) => candidate.kind === preferred) ??
        input.legalActions.find((candidate) =>
          (COMMUNICATION_KINDS as readonly string[]).includes(candidate.kind),
        );
      if (action !== undefined) {
        return { actionID: action.id, reason: `communicate: ${action.kind}` };
      }
    }
    const action = chooseStarterAction(input.legalActions);
    return { actionID: action.id, reason: `starter: ${action.kind}` };
  }
}

function brainFor(): AgentBrain {
  if (brainMode === "starter") {
    return new StarterBotAgentBrain();
  }
  if (brainMode === "rule") {
    return new RuleAgentBrain("opportunistic");
  }
  if (brainMode === "communicating") {
    return new CommunicatingBrain(commsEvery);
  }
  throw new Error(
    `--brain must be starter, rule, or communicating (got ${brainMode})`,
  );
}

function communicationCount(records: AgentDecisionRecord[]): number {
  return records.filter(
    (record) =>
      record.result.accepted &&
      (record.chosenActionKind === "quick_chat" ||
        record.chosenActionKind === "emoji" ||
        record.chosenActionKind === "target_player" ||
        record.chosenActionKind === "alliance_request"),
  ).length;
}

async function main(): Promise<void> {
  const log = winston.createLogger({
    level: "error",
    format: winston.format.simple(),
    transports: [new winston.transports.Console()],
  });

  // Mirrors no-docker-coworld-episode.ts exactly, except maxPlayers comes from
  // the seat count instead of the token list.
  const selectedGameConfig: GameConfig = {
    gameMap: enumValue(GameMapType, mapName),
    gameMapSize: enumValue(GameMapSize, mapSizeName),
    gameMode: GameMode.FFA,
    gameType: GameType.Private,
    difficulty: enumValue(Difficulty, "Easy"),
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
    maxPlayers: seats,
  } as unknown as GameConfig;

  const game = new GameServer(
    gameID,
    log,
    Date.parse("2026-01-01T00:00:00Z"),
    {
      turnIntervalMs: () => 60 * 60 * 1000,
      env: () => GameEnv.Dev,
    } as never,
    selectedGameConfig,
  );

  const mapLoader = new StaticMapLoader();
  const terrain = await loadTerrainMap(
    selectedGameConfig.gameMap,
    selectedGameConfig.gameMapSize,
    mapLoader,
    { cache: false },
  );
  const spawnCandidates = buildSpawnCandidates(terrain.gameMap, {
    maxCandidates: 1000,
    stride: 2,
  });
  const participants = createAgentParticipants(seatSpecs(seats), log, {
    brainFactory: () => brainFor(),
    retainTurnMessagesPrimaryOnly: true,
  });
  const mirror = new AgentLocalGameMirror(mapLoader, log, terrain);
  const observationBuilder = new InstrumentedObservationBuilder();
  const league = new AgentLeagueMatchRunner({
    game,
    participants,
    spawnCandidates,
    log,
    observationBuilder,
    retainTacticalAffordances: false,
  });

  const startedAt = process.hrtime.bigint();
  const elapsedMs = () => Number(process.hrtime.bigint() - startedAt) / 1e6;
  let result;
  try {
    league.attachAgents();
    league.startGame();
    result = await runAgentStepLockedLeague({
      league,
      game,
      mirror,
      messages: () => participants[0]?.runner.serverMessages() ?? [],
      config: {
        maxSteps: steps,
        turnsPerDecisionStep: turnsPerStep,
        maxDecisionMs: 60_000,
        requireWinner: false,
        waitForMirrorCatchup: true,
      },
      // Per-step series to stderr: the same episode on two builds can be
      // compared step by step, not just on the final total.
      onSnapshot: (snapshot) => {
        console.error(
          JSON.stringify({
            step: snapshot.label,
            turn: snapshot.turnNumber,
            elapsedMs: Math.round(elapsedMs()),
            builds: observationBuilder.builds,
            buildMs: Math.round(Number(observationBuilder.buildNs) / 1e6),
            seatsPolled: snapshot.records.length,
            comms: communicationCount(snapshot.records),
          }),
        );
      },
      log,
    });
  } finally {
    await game.end({ archive: false });
  }
  const episodeMs = Number(process.hrtime.bigint() - startedAt) / 1e6;

  const records = league.decisionRecords();
  console.log(
    JSON.stringify({
      label,
      brain: brainMode,
      commsEvery: brainMode === "communicating" ? commsEvery : null,
      seats,
      steps,
      turnsPerStep,
      map: mapName,
      mapSize: mapSizeName,
      episodeMs: Math.round(episodeMs),
      observationBuilds: observationBuilder.builds,
      observationBuildMs: Math.round(Number(observationBuilder.buildNs) / 1e6),
      stepsCompleted: result.stepsCompleted,
      turnCount: mirror.turnCount(),
      tick: result.finalGameState.ticks(),
      decisions: records.length,
      postSpawnDecisions: result.postSpawnRecords.length,
      acceptedCommunications: communicationCount(records),
      // On the pre-optimization build every seat-step that sees a
      // communication builds its observation twice, so this is the count of
      // redundant builds that build performs and the new one does not.
      extraBuilds: observationBuilder.builds - records.length,
      actionKindCounts: records.reduce<Record<string, number>>(
        (counts, record) => {
          const kind = record.chosenActionKind ?? "none";
          counts[kind] = (counts[kind] ?? 0) + 1;
          return counts;
        },
        {},
      ),
      heapUsedMB: Math.round(process.memoryUsage().heapUsed / (1024 * 1024)),
      rssMB: Math.round(process.memoryUsage().rss / (1024 * 1024)),
    }),
  );
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
