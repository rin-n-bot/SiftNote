import { EditorController } from "./controller";
import {
  parseCommandPacket,
  type EditorEvent,
  type EditorEventPacket,
} from "./bridge";
declare global {
  interface Window {
    ReactNativeWebView?: {
      postMessage: (message: string) => void;
    };
    siftNoteReceive?: (command: unknown) => void;
  }
}
const send = (sessionId: string | null, event: EditorEvent) => {
  const packet: EditorEventPacket = { sessionId, event };
  window.ReactNativeWebView?.postMessage(JSON.stringify(packet));
};
const element = document.getElementById("editor");
function mountEditor(element: HTMLElement) {
  // TEMPORARY: browser timings use this realm's clock. RN logs receive times
  // against the shared tap trace; clocks from the two runtimes are not subtracted.
  let documentStartedAt = performance.now();
  // Startup data is part of the page, before the local runtime script. Android
  // does not need to inject it asynchronously after the page has started.
  const raw = document.getElementById("siftnote-startup")?.textContent;
  const startup: unknown = raw ? JSON.parse(raw) : null;
  const packet = startup === null ? null : parseCommandPacket(startup);
  if (packet && packet.command.type !== "init")
    throw new Error("Editor startup requires a document.");
  let sessionId: string | null = packet?.sessionId ?? null;
  let debugTraceId = packet?.debugTraceId;
  const timing = (phase: "documentReceived" | "documentSet" | "firstPaint") => {
    if (!debugTraceId) return;
    send(sessionId, {
      type: "debugTiming",
      traceId: debugTraceId,
      phase,
      browserMs: performance.now() - documentStartedAt,
      sentAt: Date.now(),
    });
  };
  timing("documentReceived");
  // Each document init replaces plugin state, not the view or extensions.
  const controller = new EditorController(
    element,
    (event) => {
      send(sessionId, event);
      if (event.type === "initialized" && debugTraceId) {
        timing("documentSet");
        const capturedSession = sessionId;
        const capturedTrace = debugTraceId;
        const startedAt = documentStartedAt;
        // A paint opportunity, not proof of Android compositor presentation.
        requestAnimationFrame(() =>
          requestAnimationFrame(() => {
            if (capturedSession !== sessionId) return;
            send(capturedSession, {
              type: "debugTiming",
              traceId: capturedTrace,
              phase: "firstPaint",
              browserMs: performance.now() - startedAt,
              sentAt: Date.now(),
            });
          }),
        );
      }
    },
    packet?.command.type === "init" ? packet.command : undefined,
  );
  let paintRequest: { sessionId: string; requestId: string } | undefined;
  const confirmPaint = (request: NonNullable<typeof paintRequest>) => {
    // Fonts/images belong to the new document. Failed image decode is allowed
    // to show its normal missing-image state; it must not block indefinitely.
    const assets = Array.from(element.querySelectorAll("img"));
    void Promise.allSettled([
      ...(document.fonts ? [document.fonts.ready] : []),
      ...assets.map((image) => image.decode?.()),
    ]).then(() => {
      requestAnimationFrame(() =>
        requestAnimationFrame(() => {
          if (paintRequest !== request || sessionId !== request.sessionId)
            return;
          if (document.hidden) return; // visibilitychange will retry this request.
          send(request.sessionId, {
            type: "painted",
            requestId: request.requestId,
          });
          paintRequest = undefined;
        }),
      );
    });
  };
  window.siftNoteReceive = (input) => {
    try {
      const startedAt = performance.now();
      const packet = parseCommandPacket(input);
      if (packet.command.type === "init") {
        paintRequest = undefined;
        sessionId = packet.sessionId;
        debugTraceId = packet.debugTraceId;
        documentStartedAt = startedAt;
        timing("documentReceived");
      }
      if (packet.sessionId === sessionId) {
        if (packet.command.type === "paint") {
          paintRequest = {
            sessionId: packet.sessionId,
            requestId: packet.command.requestId,
          };
          confirmPaint(paintRequest);
        } else controller.receiveValidated(packet.command);
      }
    } catch {
      send(sessionId, { type: "error", code: "invalidDocument" });
    }
  };
  window.addEventListener("pagehide", () =>
    controller.receive({ type: "blur" }),
  );
  document.addEventListener("visibilitychange", () => {
    if (document.hidden) controller.receive({ type: "blur" });
    else if (paintRequest) confirmPaint(paintRequest);
  });
  window.addEventListener("error", () =>
    send(sessionId, { type: "error", code: "editor" }),
  );
  send(sessionId, { type: "ready" });
}
if (element) {
  const mount = () => {
    if (!element.isConnected) return;
    try {
      mountEditor(element);
    } catch {
      send(null, { type: "error", code: "editor" });
    }
  };
  if (document.fonts?.load) {
    // Load the four faces used by body text/formatting before Tiptap's first
    // layout. Otherwise font-display:swap changes visible glyph widths.
    // A missing local font settles as a failure and uses the normal fallback.
    void Promise.allSettled(
      [
        "16px Inter",
        "700 16px Inter",
        "italic 16px Inter",
        "italic 700 16px Inter",
      ].map((font) => document.fonts.load(font)),
    ).then(mount);
  } else mount();
}
