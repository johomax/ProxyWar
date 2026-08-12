import { describe, expect, it } from "vitest";
import { CoworldSnapshotRetention } from "./coworld-snapshot-retention.ts";

// Drive the sampler like the episode runner does: one beginStep() per
// snapshot step, building (here: recording the step index) only when told to.
function run(
  maxRetained: number,
  steps: number,
): {
  kept: number[];
  builds: number;
  maxLength: number;
} {
  const sampler = new CoworldSnapshotRetention<number>(maxRetained);
  let builds = 0;
  let maxLength = 0;
  for (let step = 0; step < steps; step++) {
    if (sampler.beginStep()) {
      builds += 1;
      sampler.retain(step);
    }
    maxLength = Math.max(maxLength, sampler.snapshots.length);
  }
  return { kept: sampler.snapshots, builds, maxLength };
}

describe("CoworldSnapshotRetention", () => {
  it("keeps every step until the cap is reached", () => {
    const { kept, builds } = run(48, 48);
    expect(kept).toEqual(Array.from({ length: 48 }, (_, i) => i));
    expect(builds).toBe(48);
  });

  it("retains evenly spaced steps and skips the rest on a long episode", () => {
    // 301 callbacks (after-spawn + 300 decision steps): decimations at steps
    // 48, 96, 192 leave stride 8, so the kept set is every 8th step.
    const { kept, builds, maxLength } = run(48, 301);
    expect(kept).toEqual(Array.from({ length: 38 }, (_, i) => i * 8));
    // 49 + 24 + 24 + 13 stride-aligned builds — everything else skipped.
    expect(builds).toBe(110);
    expect(maxLength).toBeLessThanOrEqual(48);
  });

  it.each([
    [16, 1],
    [16, 5],
    [16, 1000],
    [17, 1000], // odd env-override cap: normalized up to 18
    [48, 5000],
  ])(
    "cap %i / %i steps: kept set is consecutive stride multiples from 0",
    (cap, steps) => {
      const { kept, maxLength } = run(cap, steps);
      // An odd cap is normalized up to even (so decimation never drops the
      // newest entry), hence the +1 allowance.
      expect(maxLength).toBeLessThanOrEqual(cap + (cap % 2));
      expect(kept[0]).toBe(0);
      const spacing = kept.length > 1 ? kept[1] - kept[0] : 1;
      expect(Math.log2(spacing) % 1).toBe(0);
      for (let i = 1; i < kept.length; i++) {
        expect(kept[i] - kept[i - 1]).toBe(spacing);
      }
      // The newest kept step trails the newest seen step by under one stride.
      expect(steps - 1 - kept[kept.length - 1]).toBeLessThan(spacing);
    },
  );

  it("never drops the newest retained entry, even with an odd cap", () => {
    // Regression: an odd cap used to let decimation discard the just-pushed
    // snapshot. If that push was the episode's LAST step, the runner (which
    // clears its pending-final slot on retained steps) lost the true final
    // frame and the artifact's "Final standing" went a full stride stale.
    const sampler = new CoworldSnapshotRetention<number>(17);
    let lastRetained = -1;
    for (let step = 0; step < 1000; step++) {
      if (sampler.beginStep()) {
        sampler.retain(step);
        lastRetained = step;
        expect(sampler.snapshots[sampler.snapshots.length - 1]).toBe(step);
      }
    }
    expect(sampler.snapshots[sampler.snapshots.length - 1]).toBe(lastRetained);
  });

  it.each([Number.NaN, Infinity, 0, -3])(
    "rejects invalid cap %s instead of decimating every push",
    (cap) => {
      // NaN in particular: `length <= NaN` is always false, which would turn
      // the sampler into "decimate on every push" and destroy the replay.
      expect(() => new CoworldSnapshotRetention<number>(cap)).toThrow(
        /positive finite cap/,
      );
    },
  );

  it("appendFinal may exceed the cap by one for the true final frame", () => {
    const sampler = new CoworldSnapshotRetention<number>(16);
    for (let step = 0; step < 100; step++) {
      if (sampler.beginStep()) {
        sampler.retain(step);
      }
    }
    expect(sampler.snapshots).not.toContain(99);
    sampler.appendFinal(99);
    expect(sampler.snapshots.length).toBeLessThanOrEqual(17);
    expect(sampler.snapshots[sampler.snapshots.length - 1]).toBe(99);
  });
});
