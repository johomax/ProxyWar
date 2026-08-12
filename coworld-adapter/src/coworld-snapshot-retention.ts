/**
 * Build-skipping spectator snapshot retention for the Coworld episode runner.
 *
 * Side-effect-free sibling module (matching `coworld-episode-index.ts`)
 * because `no-docker-coworld-episode.ts` runs `main()` at import time and
 * cannot be imported by a unit test.
 *
 * The runner used to build a spectator snapshot on EVERY decision step and
 * reservoir-decimate the retained array afterwards, so on a long episode most
 * of those O(all-owned-tiles) builds were discarded. This sampler decides
 * BEFORE building whether the coming step's frame will be kept, letting the
 * runner skip builds nobody will ever see (not retained, no live /global
 * spectator watching).
 *
 * Retention rule: keep steps that are multiples of a stride that starts at 1
 * and doubles every time the retained array overflows the cap and is halved
 * by even-index decimation. The retained array is therefore always a run of
 * consecutive stride multiples starting at step 0 — evenly spaced, first
 * snapshot always kept, at most the cap's entries (`finalize` may add one
 * more; an odd cap is normalized up to even, see the constructor).
 *
 * NOTE: this retained set intentionally differs from the previous
 * build-everything-then-decimate scheme, which converged to a recency-dense
 * tail (the endgame at 1-2 step grain, older history coarse). Reproducing
 * that set is impossible without building every step — which steps survive
 * to the end depends on the episode's final length. Uniform spacing is the
 * accepted trade for skipping builds; `finalize()` still guarantees the true
 * final frame.
 *
 * Caller contract: every frame returned non-null by `step()`,
 * `buildPendingFrame()`, or `finalize()` must be broadcast/recorded — the
 * sampler uses "was built" to also mean "was already broadcast" when deciding
 * what `finalize()` and `buildPendingFrame()` still owe the caller.
 */
export class CoworldSnapshotRetention<T> {
  readonly snapshots: T[] = [];
  private readonly maxRetained: number;
  private stride = 1;
  private stepsSeen = 0;
  // The newest step's frame when that step was not retained: the builder to
  // recreate it, plus the frame itself when a forced build already produced
  // (and broadcast) it. Owning this here — instead of exporting half the
  // survival invariant to the episode runner — makes it impossible for the
  // runner's bookkeeping to desynchronize from the stride logic.
  private pendingFinal: { build: () => T; built: T | null } | null = null;

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
    // final-frame bookkeeping relies on that. An odd cap would drop the
    // newest entry at every decimation, and if that entry was the episode's
    // last step, the artifact's "Final standing" frame would go a full
    // stride stale.
    const floored = Math.floor(maxRetained);
    this.maxRetained = floored + (floored % 2);
  }

  /**
   * Process one snapshot step. `build` runs only when the frame is retained
   * or `forceBuild` is true (a live viewer needs it). Returns the built frame
   * (broadcast it) or null when the step was skipped entirely.
   */
  step(build: () => T, forceBuild: boolean): T | null {
    const retained = this.stepsSeen % this.stride === 0;
    this.stepsSeen += 1;
    // Bookkeeping first, build second: if build() throws, no stale pending
    // from an earlier step can resurface as a bogus "final" frame.
    this.pendingFinal = retained ? null : { build, built: null };
    if (!retained && !forceBuild) {
      return null;
    }
    try {
      const frame = build();
      if (retained) {
        this.retain(frame);
      } else {
        this.pendingFinal!.built = frame;
      }
      return frame;
    } catch (error) {
      this.pendingFinal = null;
      throw error;
    }
  }

  /**
   * Build (and remember) the newest step's frame if it hasn't been built yet.
   * For a live viewer connecting mid-stride: returns the fresh frame to
   * broadcast, or null when the newest frame was already built and broadcast.
   */
  buildPendingFrame(): T | null {
    if (this.pendingFinal === null || this.pendingFinal.built !== null) {
      return null;
    }
    this.pendingFinal.built = this.pendingFinal.build();
    return this.pendingFinal.built;
  }

  /**
   * Append the episode's true final frame when the last step was not retained
   * (the artifact's last frame drives the spectator "Final standing"; may
   * leave cap + 1 entries — artifact writing downsamples again anyway).
   * Returns the frame when it was never broadcast (broadcast it), else null.
   */
  finalize(): T | null {
    if (this.pendingFinal === null) {
      return null;
    }
    const alreadyBroadcast = this.pendingFinal.built !== null;
    const frame = this.pendingFinal.built ?? this.pendingFinal.build();
    this.snapshots.push(frame);
    this.pendingFinal = null;
    return alreadyBroadcast ? null : frame;
  }

  private retain(snapshot: T): void {
    this.snapshots.push(snapshot);
    if (this.snapshots.length <= this.maxRetained) {
      return;
    }
    // Even-stride decimation: keep every other snapshot (indices 0,2,4,...),
    // halving the array in place while preserving the first snapshot and an
    // even temporal spread. Doubling the stride keeps the array's invariant
    // (consecutive multiples of `stride`), so future steps skip exactly the
    // steps that could never enter the array again.
    let write = 0;
    for (let read = 0; read < this.snapshots.length; read += 2) {
      this.snapshots[write] = this.snapshots[read];
      write += 1;
    }
    this.snapshots.length = write;
    this.stride *= 2;
  }
}
