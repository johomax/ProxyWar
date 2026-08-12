/**
 * Build-skipping spectator snapshot retention for the Coworld episode runner.
 *
 * Side-effect-free sibling module (matching `coworld-episode-index.ts`)
 * because `no-docker-coworld-episode.ts` runs `main()` at import time and
 * cannot be imported by a unit test.
 *
 * The runner used to build a spectator snapshot on EVERY decision step and
 * reservoir-decimate the retained array afterwards, so on a long episode most
 * of those O(all-owned-tiles) builds were discarded. This sampler moves the
 * retention decision BEFORE the build: `beginStep()` says whether the coming
 * step's snapshot will be kept, letting the runner skip builds nobody will
 * ever see (not retained, no live /global spectator watching).
 *
 * Retention rule: keep steps that are multiples of a stride that starts at 1
 * and doubles every time the retained array overflows the cap and is halved
 * by even-index decimation. The retained array is therefore always a run of
 * consecutive stride multiples starting at step 0 — evenly spaced, first
 * snapshot always kept, at most the cap's entries (`appendFinal` may add one
 * more; an odd cap is normalized up to even, see the constructor).
 */
export class CoworldSnapshotRetention<T> {
  readonly snapshots: T[] = [];
  private readonly maxRetained: number;
  private stride = 1;
  private stepsSeen = 0;

  constructor(maxRetained: number) {
    if (!Number.isFinite(maxRetained) || maxRetained < 1) {
      // Fail loud at episode startup: a NaN cap would flip the decimation
      // guard below to "decimate on every push" and silently destroy the
      // replay (the caller sanitizes env input; this catches everyone else).
      throw new Error(
        `CoworldSnapshotRetention requires a positive finite cap, got ${maxRetained}`,
      );
    }
    // Even cap only: decimating the odd-length overflow array keeps its final
    // (even) index, so the just-pushed newest snapshot always survives — the
    // episode runner's final-frame bookkeeping relies on that. An odd cap
    // would drop the newest entry at every decimation, and if that entry was
    // the episode's last step, the artifact's "Final standing" frame would go
    // a full stride stale.
    const floored = Math.floor(maxRetained);
    this.maxRetained = floored + (floored % 2);
  }

  /**
   * Count one snapshot step. True when this step's snapshot is retained and
   * must be built and passed to `retain()`; false when retention would only
   * ever discard it.
   */
  beginStep(): boolean {
    const retained = this.stepsSeen % this.stride === 0;
    this.stepsSeen += 1;
    return retained;
  }

  retain(snapshot: T): void {
    this.snapshots.push(snapshot);
    if (this.snapshots.length <= this.maxRetained) {
      return;
    }
    // Even-stride decimation: keep every other snapshot (indices 0,2,4,...),
    // halving the array in place while preserving the first snapshot and an
    // even temporal spread. Doubling the stride keeps the array's invariant
    // (consecutive multiples of `stride`), so future beginStep() calls skip
    // exactly the steps the next decimation would have dropped anyway.
    let write = 0;
    for (let read = 0; read < this.snapshots.length; read += 2) {
      this.snapshots[write] = this.snapshots[read];
      write += 1;
    }
    this.snapshots.length = write;
    this.stride *= 2;
  }

  /**
   * Append the episode's true final snapshot even when its step was not
   * stride-aligned (the artifact's last frame drives the spectator "Final
   * standing"). May leave `maxRetained + 1` entries; artifact writing
   * downsamples again anyway.
   */
  appendFinal(snapshot: T): void {
    this.snapshots.push(snapshot);
  }
}
