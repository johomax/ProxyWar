/**
 * The per-step timing payload from AgentStepLockedLeague
 * (`AgentStepLockedStepTiming`). Local mirror for the same reason
 * `SnapshotStepInput` is one: a type-only import of the real type drags the
 * main repo's client-side type graph into this standalone tsconfig.
 */
export type StepTimingInput = {
  step: number;
  turnNumber: number;
  decisionMs: number;
  brainWaitMs: number;
  simMs: number;
  mirrorMs: number;
};

/**
 * Wall-clock attribution for a Coworld episode, reported as `[PERF]` stderr
 * lines next to the existing `[MEM]` telemetry.
 *
 * The question it answers: how much of an episode's wall clock is the engine
 * computing, and how much is the harness waiting on the policies' brains? Per
 * decision step the engine simulates 100 turns in the mirror, builds an
 * observation and a legal-action set per living seat, and may build an
 * O(all-owned-tiles) spectator frame — none of which is visible in the
 * per-decision latency the decision log already records.
 *
 * Pure accumulator: the caller reads the clocks, so unit tests need no fakes.
 */
export interface CoworldEpisodePerfSummary {
  steps: number;
  turns: number;
  wallMs: number;
  /** Map load, spawn candidates, and the spawn phase (up to the first frame). */
  setupMs: number;
  /**
   * Authoritative turn emission (`advanceTurnsForTesting`). The GameServer
   * relays intents and does not simulate, so this is near-zero by design.
   */
  simMs: number;
  /** The simulation itself: the local mirror executing those turns. */
  mirrorMs: number;
  /** Observation/legal-action/validation work around the brain calls. */
  decisionEngineMs: number;
  /** Time the steps spent blocked on the slowest brain of each step. */
  brainWaitMs: number;
  /** Spectator frame builds. */
  snapshotMs: number;
  /** Everything the phases above did not cover (artifact writes, GC, jitter). */
  otherMs: number;
  /** setup + sim + mirror + decisionEngine + snapshot. */
  engineMs: number;
  /** engineMs / wallMs, 0..1. */
  engineShare: number;
  snapshotSteps: number;
  snapshotBuilds: number;
  snapshotSkipped: number;
  snapshotMeanBuildMs: number;
  /**
   * Estimate, not a measurement: skipped builds x the mean cost of the builds
   * that did run. Retained steps are evenly spaced, so their mean tracks the
   * episode mean; an A/B against build-every-step is the exact number.
   */
  snapshotSkipSavedMsEst: number;
}

export class CoworldEpisodePerf {
  private steps = 0;
  private setupMs = 0;
  private simMs = 0;
  private mirrorMs = 0;
  private decisionMs = 0;
  private brainWaitMs = 0;
  private snapshotMs = 0;
  private snapshotSteps = 0;
  private snapshotBuilds = 0;

  noteSetup(ms: number): void {
    this.setupMs = ms;
  }

  noteStep(timing: StepTimingInput): void {
    this.steps += 1;
    this.simMs += timing.simMs;
    this.mirrorMs += timing.mirrorMs;
    this.decisionMs += timing.decisionMs;
    this.brainWaitMs += timing.brainWaitMs;
  }

  /** One decision step's snapshot callback, built or skipped. */
  noteSnapshotStep(): void {
    this.snapshotSteps += 1;
  }

  noteSnapshotBuild(ms: number): void {
    this.snapshotBuilds += 1;
    this.snapshotMs += ms;
  }

  summary(input: { wallMs: number; turns: number }): CoworldEpisodePerfSummary {
    // A brain slower than the engine overlaps nothing: the step is strictly
    // serial (decide, then advance), so the engine's share of the decision
    // call is whatever the call did NOT spend waiting.
    const decisionEngineMs = Math.max(0, this.decisionMs - this.brainWaitMs);
    const engineMs =
      this.setupMs +
      this.simMs +
      this.mirrorMs +
      decisionEngineMs +
      this.snapshotMs;
    const snapshotSkipped = Math.max(
      0,
      this.snapshotSteps - this.snapshotBuilds,
    );
    const snapshotMeanBuildMs =
      this.snapshotBuilds === 0 ? 0 : this.snapshotMs / this.snapshotBuilds;
    return {
      steps: this.steps,
      turns: input.turns,
      wallMs: input.wallMs,
      setupMs: this.setupMs,
      simMs: this.simMs,
      mirrorMs: this.mirrorMs,
      decisionEngineMs,
      brainWaitMs: this.brainWaitMs,
      snapshotMs: this.snapshotMs,
      otherMs: Math.max(0, input.wallMs - engineMs - this.brainWaitMs),
      engineMs,
      engineShare: input.wallMs <= 0 ? 0 : engineMs / input.wallMs,
      snapshotSteps: this.snapshotSteps,
      snapshotBuilds: this.snapshotBuilds,
      snapshotSkipped,
      snapshotMeanBuildMs,
      snapshotSkipSavedMsEst: snapshotSkipped * snapshotMeanBuildMs,
    };
  }
}

export function coworldEpisodePerfLine(
  label: string,
  summary: CoworldEpisodePerfSummary,
): string {
  const sec = (ms: number) => (ms / 1000).toFixed(1);
  const pct = (share: number) => `${(share * 100).toFixed(1)}%`;
  return (
    `[PERF] ${label} steps=${summary.steps} turns=${summary.turns} ` +
    `wallSec=${sec(summary.wallMs)} engineSec=${sec(summary.engineMs)} ` +
    `(${pct(summary.engineShare)}) simSec=${sec(summary.simMs)} ` +
    `mirrorSec=${sec(summary.mirrorMs)} decisionEngineSec=${sec(summary.decisionEngineMs)} ` +
    `snapshotSec=${sec(summary.snapshotMs)} setupSec=${sec(summary.setupMs)} ` +
    `brainWaitSec=${sec(summary.brainWaitMs)} otherSec=${sec(summary.otherMs)} ` +
    `snapshotBuilds=${summary.snapshotBuilds}/${summary.snapshotSteps} ` +
    `meanBuildMs=${summary.snapshotMeanBuildMs.toFixed(1)} ` +
    `skipSavedSecEst=${sec(summary.snapshotSkipSavedMsEst)}`
  );
}
