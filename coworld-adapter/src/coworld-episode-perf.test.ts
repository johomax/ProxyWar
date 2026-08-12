import { describe, expect, it } from "vitest";
import {
  CoworldEpisodePerf,
  coworldEpisodePerfLine,
  type StepTimingInput,
} from "./coworld-episode-perf.ts";

function timing(overrides: Partial<StepTimingInput> = {}): StepTimingInput {
  return {
    step: 1,
    turnNumber: 100,
    decisionMs: 0,
    brainWaitMs: 0,
    simMs: 0,
    mirrorMs: 0,
    ...overrides,
  };
}

describe("CoworldEpisodePerf", () => {
  it("splits a step's decision call into brain wait and engine work", () => {
    const perf = new CoworldEpisodePerf();
    perf.noteStep(timing({ decisionMs: 1_000, brainWaitMs: 800 }));
    perf.noteStep(timing({ step: 2, decisionMs: 1_000, brainWaitMs: 600 }));

    const summary = perf.summary({ wallMs: 2_000, turns: 200 });
    expect(summary.brainWaitMs).toBe(1_400);
    expect(summary.decisionEngineMs).toBe(600);
    expect(summary.engineMs).toBe(600);
    expect(summary.engineShare).toBeCloseTo(0.3);
  });

  it("attributes setup, simulation, mirror and snapshot time to the engine", () => {
    const perf = new CoworldEpisodePerf();
    perf.noteSetup(500);
    perf.noteStep(
      timing({ decisionMs: 300, brainWaitMs: 100, simMs: 50, mirrorMs: 1_000 }),
    );
    perf.noteSnapshotStep();
    perf.noteSnapshotBuild(150);

    const summary = perf.summary({ wallMs: 2_500, turns: 100 });
    expect(summary.engineMs).toBe(500 + 50 + 1_000 + 200 + 150);
    // Wall clock the phases did not claim: artifact writes, GC, jitter.
    expect(summary.otherMs).toBe(2_500 - summary.engineMs - 100);
  });

  it("counts skipped spectator builds and estimates what they would have cost", () => {
    const perf = new CoworldEpisodePerf();
    for (let step = 0; step < 10; step++) {
      perf.noteSnapshotStep();
    }
    perf.noteSnapshotBuild(20);
    perf.noteSnapshotBuild(40);

    const summary = perf.summary({ wallMs: 1_000, turns: 1_000 });
    expect(summary.snapshotBuilds).toBe(2);
    expect(summary.snapshotSkipped).toBe(8);
    expect(summary.snapshotMeanBuildMs).toBe(30);
    expect(summary.snapshotSkipSavedMsEst).toBe(240);
  });

  it("stays non-negative when a live viewer forces more builds than steps", () => {
    const perf = new CoworldEpisodePerf();
    perf.noteSnapshotStep();
    perf.noteSnapshotBuild(10);
    // finalize()/the live-frame refresher can build outside a step.
    perf.noteSnapshotBuild(10);

    expect(perf.summary({ wallMs: 100, turns: 1 }).snapshotSkipped).toBe(0);
  });

  it("reports a zero-wall episode without dividing by zero", () => {
    const summary = new CoworldEpisodePerf().summary({ wallMs: 0, turns: 0 });
    expect(summary.engineShare).toBe(0);
    expect(summary.otherMs).toBe(0);
    expect(coworldEpisodePerfLine("episode-complete", summary)).toContain(
      "engineSec=0.0 (0.0%)",
    );
  });
});
