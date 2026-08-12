import { describe, expect, it } from "vitest";
import { CoworldSnapshotRetention } from "./coworld-snapshot-retention.ts";

// Drive the sampler like the episode runner does: one step() per snapshot
// step, the build closure recording the step index it built.
function run(
  maxRetained: number,
  steps: number,
  forceBuild = false,
): {
  sampler: CoworldSnapshotRetention<number>;
  kept: number[];
  builds: number;
  maxLength: number;
} {
  const sampler = new CoworldSnapshotRetention<number>(maxRetained);
  let builds = 0;
  let maxLength = 0;
  for (let step = 0; step < steps; step++) {
    sampler.step(() => {
      builds += 1;
      return step;
    }, forceBuild);
    maxLength = Math.max(maxLength, sampler.snapshots.length);
  }
  return { sampler, kept: sampler.snapshots, builds, maxLength };
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
    // snapshot; if that push was the episode's LAST step, the true final
    // frame was lost and the artifact's "Final standing" went a full stride
    // stale. Odd caps now normalize up to even.
    const sampler = new CoworldSnapshotRetention<number>(17);
    for (let step = 0; step < 1000; step++) {
      const frame = sampler.step(() => step, false);
      if (frame !== null) {
        expect(sampler.snapshots[sampler.snapshots.length - 1]).toBe(step);
      }
    }
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

  it("finalize appends and returns the unbuilt final frame for broadcast", () => {
    const { sampler, kept } = run(16, 100);
    expect(kept).not.toContain(99);
    // Returning 99 proves the stored build closure ran at finalize time.
    expect(sampler.finalize()).toBe(99);
    expect(sampler.snapshots.length).toBeLessThanOrEqual(17);
    expect(sampler.snapshots[sampler.snapshots.length - 1]).toBe(99);
    // Idempotent: nothing left pending.
    expect(sampler.finalize()).toBeNull();
  });

  it("finalize is a no-op when the last step was retained", () => {
    // Step 96 is stride-aligned at cap 16 (stride 8 by then).
    const { sampler, kept } = run(16, 97);
    expect(kept[kept.length - 1]).toBe(96);
    const lengthBefore = sampler.snapshots.length;
    expect(sampler.finalize()).toBeNull();
    expect(sampler.snapshots.length).toBe(lengthBefore);
  });

  it("finalize appends but does not re-broadcast a spectator-built frame", () => {
    // forceBuild (a live viewer) builds and broadcasts every step, so the
    // final frame was already sent: finalize must append it to the artifact
    // without asking the caller to broadcast it again.
    const { sampler, builds } = run(16, 100, true);
    expect(builds).toBe(100);
    expect(sampler.finalize()).toBeNull();
    expect(sampler.snapshots[sampler.snapshots.length - 1]).toBe(99);
  });

  it("buildPendingFrame builds the newest skipped frame exactly once", () => {
    const { sampler } = run(16, 100);
    expect(sampler.buildPendingFrame()).toBe(99);
    // Already built (and broadcast by the caller contract): nothing owed.
    expect(sampler.buildPendingFrame()).toBeNull();
    expect(sampler.finalize()).toBeNull();
    expect(sampler.snapshots[sampler.snapshots.length - 1]).toBe(99);
  });

  it("buildPendingFrame is a no-op with no pending step", () => {
    const sampler = new CoworldSnapshotRetention<number>(16);
    expect(sampler.buildPendingFrame()).toBeNull();
    sampler.step(() => 0, false); // retained, already broadcast
    expect(sampler.buildPendingFrame()).toBeNull();
  });

  it("a build that throws leaves no stale pending final frame", () => {
    const sampler = new CoworldSnapshotRetention<number>(16);
    for (let step = 0; step < 17; step++) {
      sampler.step(() => step, false);
    }
    // Step 17 is unretained (stride 2 after the first decimation); a forced
    // build that throws must not leave an older frame (or the throwing
    // builder) registered as the episode's final frame.
    expect(() =>
      sampler.step(() => {
        throw new Error("boom");
      }, true),
    ).toThrow("boom");
    const lengthBefore = sampler.snapshots.length;
    expect(sampler.finalize()).toBeNull();
    expect(sampler.snapshots.length).toBe(lengthBefore);
  });
});
