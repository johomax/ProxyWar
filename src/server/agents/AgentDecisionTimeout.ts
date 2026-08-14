import { AgentBrainDecisionPromise, AgentDecision } from "./AgentTypes";

export interface DeferredDecisionTimeout {
  arm(): void;
  clear(): void;
}

export function createDeferredDecisionTimeout(
  timeoutMs: number,
  onTimeout: () => void,
): DeferredDecisionTimeout {
  let timeoutID: ReturnType<typeof setTimeout> | undefined;
  let settled = false;

  return {
    arm: () => {
      if (
        settled ||
        timeoutID !== undefined ||
        !Number.isFinite(timeoutMs) ||
        timeoutMs <= 0
      ) {
        return;
      }
      timeoutID = setTimeout(onTimeout, timeoutMs);
    },
    clear: () => {
      settled = true;
      if (timeoutID !== undefined) {
        clearTimeout(timeoutID);
      }
    },
  };
}

export function makeArmableDecisionPromise(
  promise: Promise<AgentDecision>,
  timeout: DeferredDecisionTimeout,
): AgentBrainDecisionPromise {
  const decisionPromise = promise as AgentBrainDecisionPromise;
  decisionPromise.armDecisionTimeout = timeout.arm;
  // Direct brain callers have no observation-batch barrier to arm the hook.
  // The league calls it synchronously first; this microtask then becomes a
  // no-op. Standalone callers retain their prior immediate timeout behavior.
  queueMicrotask(timeout.arm);
  return decisionPromise;
}

export function withDeferredDecisionTimeout<T>(
  promise: Promise<T>,
  timeoutMs: number,
  timeoutError: () => Error,
): { promise: Promise<T>; timeout: DeferredDecisionTimeout } {
  let rejectTimeout: (error: Error) => void = () => undefined;
  const timeoutPromise = new Promise<T>((_resolve, reject) => {
    rejectTimeout = reject;
  });
  const timeout = createDeferredDecisionTimeout(timeoutMs, () => {
    rejectTimeout(timeoutError());
  });
  const timedPromise = Promise.race([promise, timeoutPromise]);
  void timedPromise.then(timeout.clear, timeout.clear);
  queueMicrotask(timeout.arm);
  return { promise: timedPromise, timeout };
}
