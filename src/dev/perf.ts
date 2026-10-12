// TEMPORARY: remove after the Android navigation investigation.
// Only timings, counts and diagnostic IDs; never note text, IDs or image paths.
const enabled = typeof __DEV__ !== "undefined" && __DEV__;
export const DEBUG_NO_WEBVIEW =
  enabled && process.env.EXPO_PUBLIC_DEBUG_NO_WEBVIEW === "1";
export const DEBUG_WEBVIEW_HARDWARE =
  enabled && process.env.EXPO_PUBLIC_DEBUG_WEBVIEW_HARDWARE === "1";
export type PerfTrace = { id: string; startedAt: number };
let sequence = 0;
let current: PerfTrace | undefined;

export function perfTrace(): PerfTrace | undefined {
  if (!enabled) return undefined;
  return (current ??= { id: "perf_0", startedAt: performance.now() });
}

export function perfStart(action: "open" | "create" | "back") {
  if (!enabled) return undefined;
  current = { id: `perf_${++sequence}`, startedAt: performance.now() };
  perfMark("tap", current, {
    action,
    noWebView: DEBUG_NO_WEBVIEW,
    hardware: DEBUG_WEBVIEW_HARDWARE,
  });
  return current;
}

// TEMPORARY: no React updates and no per-frame logging. Distinguishes a stalled
// RN JS event loop from a delayed Router/React delivery on the next device run.
export function startJsHeartbeat() {
  if (!enabled) return () => {};
  const interval = 50;
  let expected = performance.now() + interval;
  const timer = setInterval(() => {
    const now = performance.now();
    const lagMs = now - expected;
    if (lagMs > 16)
      perfMark("js.heartbeat.lag", undefined, {
        lagMs: Number(lagMs.toFixed(2)),
      });
    expected = now + interval;
  }, interval);
  return () => clearInterval(timer);
}

export function perfMark(
  event: string,
  trace = perfTrace(),
  fields?: Record<string, string | number | boolean>,
) {
  if (!enabled || !trace) return;
  console.info(
    "[SiftNote perf]",
    JSON.stringify({
      trace: trace.id,
      elapsedMs: Number((performance.now() - trace.startedAt).toFixed(2)),
      event,
      ...fields,
    }),
  );
}

// TEMPORARY: bracket synchronous work without changing its result or errors.
export function perfSync<T>(
  event: string,
  work: () => T,
  trace = perfTrace(),
): T {
  if (!enabled) return work();
  const start = performance.now();
  perfMark(`${event}.start`, trace);
  try {
    return work();
  } finally {
    perfMark(`${event}.end`, trace, {
      durationMs: Number((performance.now() - start).toFixed(2)),
    });
  }
}
