import {
  forwardRef,
  useCallback,
  useEffect,
  useImperativeHandle,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import { AppState, View, useWindowDimensions } from "react-native";
import { WebView } from "react-native-webview";
import { colors, ErrorState } from "../components/ui/primitives";
import { createId, type RichDocument } from "../domain/document";
import {
  parseEventPacket,
  type EditorCommand,
  type EditorEvent,
  type EditorTarget,
  type SelectionState,
} from "./bridge";
import { editorPage, type EditorRuntime } from "./runtime";
import {
  DEBUG_NO_WEBVIEW,
  DEBUG_WEBVIEW_HARDWARE,
  perfMark,
  perfSync,
  perfTrace,
  type PerfTrace,
} from "../dev/perf";

export type RichEditorHandle = {
  send: (command: EditorCommand) => void;
  snapshot: (knownVersion?: number) => Promise<void>;
  paint: (requestId: string) => Promise<void>;
  cancelPaint: () => void;
  waitUntilReady: () => Promise<void>;
  restartAfterFailure: () => void;
};
type Props = {
  trace?: PerfTrace; // TEMPORARY, not editor/document state.
  documentId: string;
  runtime?: EditorRuntime;
  initialTarget?: EditorTarget;
  initialDocument?: RichDocument;
  images: Record<string, string>;
  onDocument: (content: RichDocument, version: number) => void;
  onDirty: (version: number) => void;
  onSelection: (state: SelectionState) => void;
  onFeedback: (
    kind: Extract<EditorEvent, { type: "feedback" }>["kind"],
  ) => void;
  onReady: () => void;
  onFailure: () => void;
};

// The page belongs to one mounted note screen. Only explicit failure recovery
// restarts this screen's WebView; editing never changes its initial source.
const WebViewEditor = forwardRef<RichEditorHandle, Props>(
  function RichEditor(props, ref) {
    perfMark("richEditor.render.start", props.trace);
    useEffect(() => {
      perfMark("richEditor.mount");
      return () => perfMark("richEditor.unmount");
    }, []);
    const webview = useRef<WebView>(null);
    const latest = useRef(props);
    latest.current = props;
    const { fontScale } = useWindowDimensions();
    const scale = useRef(fontScale);
    scale.current = fontScale;
    const [generation, setGeneration] = useState(0);
    const [ready, setReady] = useState(false);
    const [error, setError] = useState<string>();
    const initialized = useRef(false);
    const failed = useRef(false);
    const active = useRef({ documentId: props.documentId, sessionId: "" });
    const diagnosticTrace = useRef(props.trace ?? perfTrace());
    const paintRequests = useRef(
      new Map<
        string,
        {
          resolve: () => void;
          reject: (error: Error) => void;
          timer?: ReturnType<typeof setTimeout>;
        }
      >(),
    );
    const cancelPaint = useCallback(() => {
      for (const request of paintRequests.current.values()) {
        clearTimeout(request.timer);
        request.reject(new Error("The note opening was cancelled."));
      }
      paintRequests.current.clear();
    }, []);
    const armPaintTimeout = useCallback((id: string) => {
      const request = paintRequests.current.get(id);
      if (!request) return;
      request.timer = setTimeout(() => {
        paintRequests.current.delete(id);
        request.reject(
          new Error("The note could not be displayed. Please retry."),
        );
      }, 5000);
    }, []);
    const readyRequests = useRef(
      new Set<{
        resolve: () => void;
        reject: (error: Error) => void;
        timer: ReturnType<typeof setTimeout>;
      }>(),
    );
    const requests = useRef(
      new Map<
        string,
        {
          resolve: () => void;
          reject: (error: Error) => void;
          timer: ReturnType<typeof setTimeout>;
        }
      >(),
    );
    const page = useMemo(() => {
      // Mount the native host with the screen. Its first loaded page contains
      // the real document; no empty Tiptap session precedes it.
      if (!props.runtime || !latest.current.initialDocument) return undefined;
      const trace = latest.current.trace ?? perfTrace();
      diagnosticTrace.current = trace;
      const sessionId = createId();
      active.current = { documentId: latest.current.documentId, sessionId };
      const command: EditorCommand = {
        type: "init",
        content: latest.current.initialDocument,
        images: latest.current.images,
        fontScale: scale.current,
        background: colors.background ?? "#FFFFFF",
        target: latest.current.initialTarget,
      };
      perfMark("document.serialize.start", trace, { transport: "startupHtml" });
      const packet = perfSync(
        "document.stringify",
        () =>
          JSON.stringify({
            sessionId,
            command,
            debugTraceId: trace?.id,
          }),
        trace,
      );
      perfMark("document.sent", trace, {
        transport: "startupHtml",
        payloadChars: packet.length,
      });
      return {
        sessionId,
        trace,
        fontScale: scale.current,
        source: {
          html: perfSync(
            "document.html",
            () => editorPage(packet, colors.background ?? "#FFFFFF"),
            trace,
          ),
          baseUrl: props.runtime.uri,
        },
      };
      // Edits update the browser document, never its initial page/source.
      // A restart uses the latest received draft and a fresh bridge identity.
      // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [props.runtime?.uri, generation]);
    const send = useCallback((command: EditorCommand) => {
      if (!active.current.sessionId) return;
      const trace = latest.current.trace ?? perfTrace();
      if (command.type === "init") {
        diagnosticTrace.current = trace;
        perfMark("document.serialize.start", trace, { transport: "bridge" });
      }
      const packet = JSON.stringify({
        sessionId: active.current.sessionId,
        command,
        ...(command.type === "init" && trace ? { debugTraceId: trace.id } : {}),
      });
      if (command.type === "init")
        perfMark("document.sent", trace, {
          transport: "bridge",
          payloadChars: packet.length,
        });
      webview.current?.injectJavaScript(
        `window.siftNoteReceive&&window.siftNoteReceive(${packet});true;`,
      );
    }, []);
    const rejectRequests = useCallback(
      (message: string) => {
        cancelPaint();
        for (const request of requests.current.values()) {
          clearTimeout(request.timer);
          request.reject(new Error(message));
        }
        requests.current.clear();
        for (const request of readyRequests.current) {
          clearTimeout(request.timer);
          request.reject(new Error(message));
        }
        readyRequests.current.clear();
      },
      [cancelPaint],
    );
    const fail = useCallback(() => {
      perfMark("webview.failed", diagnosticTrace.current);
      failed.current = true;
      initialized.current = false;
      setReady(false);
      latest.current.onFailure();
      setError(
        "The editor stopped. The last received text is retained. Restart the editor to continue.",
      );
      rejectRequests("The editor stopped before it could save all changes.");
    }, [rejectRequests]);
    const waitUntilReady = useCallback(() => {
      if (failed.current)
        return Promise.reject(
          new Error(
            "The editor stopped. Retry to restart it with the last received text.",
          ),
        );
      if (initialized.current) return Promise.resolve();
      return new Promise<void>((resolve, reject) => {
        const request = {
          resolve,
          reject,
          timer: setTimeout(() => {
            readyRequests.current.delete(request);
            reject(
              new Error(
                "The editor did not become ready. Stay here and retry.",
              ),
            );
          }, 15000),
        };
        readyRequests.current.add(request);
      });
    }, []);
    const restartAfterFailure = useCallback(() => {
      if (!failed.current) return;
      perfMark("webview.restart", diagnosticTrace.current);
      failed.current = false;
      initialized.current = false;
      setReady(false);
      setError(undefined);
      setGeneration((value) => value + 1);
    }, []);
    useImperativeHandle(ref, () => ({
      send,
      cancelPaint,
      paint: (requestId) =>
        new Promise<void>((resolve, reject) => {
          if (!initialized.current) {
            reject(new Error("The editor is not ready."));
            return;
          }
          cancelPaint();
          paintRequests.current.set(requestId, { resolve, reject });
          if (
            AppState.currentState == null ||
            AppState.currentState === "active"
          )
            armPaintTimeout(requestId);
          send({ type: "paint", requestId });
        }),
      waitUntilReady,
      restartAfterFailure,
      snapshot: (knownVersion) =>
        new Promise<void>((resolve, reject) => {
          if (!initialized.current) {
            reject(
              new Error(
                "The editor is not ready. Your previous saved note has been kept.",
              ),
            );
            return;
          }
          const id = createId();
          const timer = setTimeout(() => {
            requests.current.delete(id);
            reject(
              new Error(
                "The editor did not respond. Stay here and retry to protect your edits.",
              ),
            );
          }, 5000);
          requests.current.set(id, { resolve, reject, timer });
          send({ type: "snapshot", requestId: id, knownVersion });
        }),
    }));
    useLayoutEffect(() => {
      if (!page || !props.initialDocument) return;
      if (active.current.documentId === props.documentId) return;
      // The owner flushes the old note before changing documentId. Discard any
      // queued old events before accepting callbacks for the new document.
      rejectRequests("The editor changed documents before it responded.");
      active.current = { documentId: props.documentId, sessionId: createId() };
      initialized.current = false;
      setReady(false);
      setError(undefined);
      send({
        type: "init",
        content: props.initialDocument,
        images: props.images,
        fontScale: scale.current,
        background: colors.background ?? "#FFFFFF",
        target: props.initialTarget,
      });
      // Content and image edits must never initialize the document again.
      // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [props.documentId, page, rejectRequests, send]);
    useEffect(() => {
      if (initialized.current) send({ type: "fontScale", value: fontScale });
    }, [fontScale, send]);
    useEffect(() => {
      const subscription = AppState.addEventListener("change", (state) => {
        for (const [id, request] of paintRequests.current) {
          clearTimeout(request.timer);
          request.timer = undefined;
          if (state === "active") armPaintTimeout(id);
        }
      });
      return () => subscription.remove();
    }, [armPaintTimeout]);
    useEffect(() => {
      if (!page || ready || error) return;
      const timer = setTimeout(fail, 15000);
      return () => clearTimeout(timer);
    }, [page, ready, error, generation, fail]);
    useEffect(
      () => () => {
        perfMark("richEditor.cleanup.start");
        rejectRequests("The editor was closed before it responded.");
        perfMark("richEditor.cleanup.end");
      },
      [rejectRequests],
    );
    const acknowledge = (requestId: string) => {
      const request = requests.current.get(requestId);
      if (!request) return;
      clearTimeout(request.timer);
      requests.current.delete(requestId);
      request.resolve();
    };
    const view = (
      <View
        // Keep the WebView's native parent stable when readiness changes.
        collapsable={false}
        className="flex-1"
        pointerEvents={ready || error ? "auto" : "none"}
        accessibilityElementsHidden={!ready && !error}
        importantForAccessibility={
          ready || error ? "auto" : "no-hide-descendants"
        }
      >
        <WebView
          key={generation}
          ref={webview}
          source={page?.source}
          originWhitelist={["file://", "about:blank"]}
          style={{ flex: 1, backgroundColor: colors.background ?? "#FFFFFF" }}
          androidLayerType={DEBUG_WEBVIEW_HARDWARE ? "hardware" : "none"}
          allowFileAccess
          allowFileAccessFromFileURLs={false}
          allowUniversalAccessFromFileURLs={false}
          setSupportMultipleWindows={false}
          javaScriptCanOpenWindowsAutomatically={false}
          textZoom={100}
          scalesPageToFit={false}
          onShouldStartLoadWithRequest={(request) =>
            request.url === "about:blank" ||
            request.url === page?.source.baseUrl
          }
          onError={fail}
          onLoadStart={() =>
            perfMark("webview.loadStart", page?.trace ?? props.trace, {
              generation,
            })
          }
          onLoadEnd={() =>
            perfMark("webview.loadEnd", page?.trace ?? props.trace, {
              generation,
            })
          }
          onLayout={(event) =>
            perfMark("webview.layout", diagnosticTrace.current, {
              width: event.nativeEvent.layout.width,
              height: event.nativeEvent.layout.height,
            })
          }
          onRenderProcessGone={fail}
          onContentProcessDidTerminate={fail}
          onMessage={(message) => {
            if (!page) return;
            try {
              const packet = parseEventPacket(
                message.nativeEvent.data,
                active.current.sessionId,
              );
              if (!packet) return;
              if (packet.sessionId === null && packet.event.type === "error") {
                fail();
                return;
              }
              if (
                packet.sessionId !== active.current.sessionId ||
                active.current.documentId !== latest.current.documentId
              )
                return;
              const callbacks = latest.current;
              const event = packet.event;
              switch (event.type) {
                case "ready":
                  perfMark("bridge.runtimeReady", diagnosticTrace.current);
                  break;
                case "debugTiming": {
                  const trace = diagnosticTrace.current;
                  if (trace?.id === event.traceId)
                    perfMark(`webview.${event.phase}`, trace, {
                      browserMs: event.browserMs,
                      ...(event.sentAt !== undefined
                        ? { deliveryMs: Math.max(0, Date.now() - event.sentAt) }
                        : {}),
                    });
                  break;
                }
                case "initialized":
                  perfMark("bridge.documentAck", diagnosticTrace.current);
                  failed.current = false;
                  initialized.current = true;
                  if (scale.current !== page.fontScale)
                    send({ type: "fontScale", value: scale.current });
                  setReady(true);
                  setError(undefined);
                  callbacks.onReady();
                  for (const request of readyRequests.current) {
                    clearTimeout(request.timer);
                    request.resolve();
                  }
                  readyRequests.current.clear();
                  break;
                case "change":
                  callbacks.onDocument(event.content, event.version);
                  if (event.requestId) acknowledge(event.requestId);
                  break;
                case "dirty":
                  callbacks.onDirty(event.version);
                  break;
                case "snapshot":
                  acknowledge(event.requestId);
                  break;
                case "painted": {
                  const request = paintRequests.current.get(event.requestId);
                  if (request) {
                    clearTimeout(request.timer);
                    paintRequests.current.delete(event.requestId);
                    request.resolve();
                  }
                  break;
                }
                case "selection":
                  callbacks.onSelection(event.state);
                  break;
                case "feedback":
                  callbacks.onFeedback(event.kind);
                  break;
                case "error":
                  fail();
                  break;
              }
            } catch {
              fail();
            }
          }}
        />
        {error ? (
          <View className="absolute inset-0 bg-white">
            <ErrorState message={error} onRetry={restartAfterFailure} />
          </View>
        ) : null}
      </View>
    );
    perfMark("richEditor.render.end", props.trace);
    return view;
  },
);

// TEMPORARY: native-only navigation baseline. No fake documents/edit events.
// Only the explicit dev flag selects this; release builds always use WebView.
const NativeDiagnosticEditor = forwardRef<RichEditorHandle, Props>(
  function NativeDiagnosticEditor(props, ref) {
    const latest = useRef(props);
    latest.current = props;
    useImperativeHandle(
      ref,
      () => ({
        send: () => {},
        snapshot: () => Promise.resolve(),
        paint: () => Promise.resolve(),
        cancelPaint: () => {},
        waitUntilReady: () => Promise.resolve(),
        restartAfterFailure: () => {},
      }),
      [],
    );
    useEffect(() => {
      perfMark("nativePlaceholder.mount");
      return () => perfMark("nativePlaceholder.unmount");
    }, []);
    useLayoutEffect(() => {
      if (!latest.current.runtime || !latest.current.initialDocument) return;
      perfMark("nativePlaceholder.documentCommit", latest.current.trace);
      latest.current.onReady();
    }, [props.documentId, props.runtime]);
    return (
      <View
        style={{ flex: 1, backgroundColor: "#FFFFFF" }}
        accessibilityLabel="Native navigation diagnostic placeholder"
      />
    );
  },
);
export const RichEditor = DEBUG_NO_WEBVIEW
  ? NativeDiagnosticEditor
  : WebViewEditor;
