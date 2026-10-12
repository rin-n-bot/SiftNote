import {
  isColor,
  isRecord,
  parseDocument,
  validId,
  type HighlightColor,
  type RichDocument,
} from "../domain/document";

export type Format =
  | "normal"
  | "heading"
  | "bold"
  | "italic"
  | "underline"
  | "bulletList"
  | "orderedList"
  | "undo"
  | "redo";
export type EditorTarget =
  { type: "highlight"; id: string } | { type: "search"; query: string };
export type EditorCommand =
  | {
      type: "init";
      content: RichDocument;
      images: Record<string, string>;
      fontScale: number;
      background?: string;
      target?: EditorTarget;
    }
  | { type: "format"; format: Format }
  | { type: "highlight"; color: HighlightColor }
  | { type: "removeHighlight" }
  | { type: "jumpHighlight"; id: string }
  | { type: "jumpSearch"; query: string }
  | { type: "insertImage"; assetId: string; uri: string }
  | { type: "snapshot"; requestId: string; knownVersion?: number }
  | { type: "paint"; requestId: string }
  | { type: "blur" }
  | { type: "fontScale"; value: number };
export type SelectionState = {
  hasSelection: boolean;
  canUndo: boolean;
  canRedo: boolean;
  bold: boolean;
  italic: boolean;
  underline: boolean;
  heading: boolean;
  bulletList: boolean;
  orderedList: boolean;
  highlightColor: HighlightColor | null;
};
export const EMPTY_SELECTION: SelectionState = {
  hasSelection: false,
  canUndo: false,
  canRedo: false,
  bold: false,
  italic: false,
  underline: false,
  heading: false,
  bulletList: false,
  orderedList: false,
  highlightColor: null,
};
export type EditorEvent =
  | { type: "ready" }
  | { type: "initialized" }
  | { type: "painted"; requestId: string }
  // TEMPORARY: emitted only when a __DEV__ caller supplies a diagnostic trace.
  | {
      type: "debugTiming";
      traceId: string;
      phase: "documentReceived" | "documentSet" | "firstPaint";
      browserMs: number;
      sentAt?: number;
    }
  | { type: "dirty"; version: number }
  | { type: "snapshot"; requestId: string }
  | {
      type: "change";
      content: RichDocument;
      version: number;
      requestId?: string;
    }
  | { type: "selection"; state: SelectionState }
  | {
      type: "feedback";
      kind: "applied" | "removed" | "image" | "missingPassage" | "selectText";
    }
  | { type: "error"; code: "editor" | "invalidDocument" };
type EditorCommandPacket = {
  sessionId: string;
  command: EditorCommand;
  debugTraceId?: string; // TEMPORARY, not part of document data.
};
export type EditorEventPacket = {
  sessionId: string | null;
  event: EditorEvent;
};

export function parseCommandPacket(value: unknown): EditorCommandPacket {
  if (!isRecord(value) || !validId(value.sessionId))
    throw new Error("Invalid editor session.");
  if (value.debugTraceId !== undefined && !validDebugTrace(value.debugTraceId))
    throw new Error("Invalid diagnostic trace.");
  return {
    sessionId: value.sessionId,
    command: parseCommand(value.command),
    ...(value.debugTraceId
      ? { debugTraceId: value.debugTraceId as string }
      : {}),
  };
}
const validDebugTrace = (value: unknown): value is string =>
  typeof value === "string" && /^perf_[0-9]{1,10}$/.test(value);
export function parseEventPacket(raw: string): EditorEventPacket;
export function parseEventPacket(
  raw: string,
  expectedSessionId: string,
): EditorEventPacket | undefined;
export function parseEventPacket(
  raw: string,
  expectedSessionId?: string,
): EditorEventPacket | undefined {
  if (raw.length > 16000000) throw new Error("Editor message is too large.");
  const value: unknown = JSON.parse(raw);
  if (
    !isRecord(value) ||
    !(value.sessionId === null || validId(value.sessionId))
  )
    throw new Error("Invalid editor session.");
  // A replaced WebView may still deliver queued messages. Discard its packet
  // before validating a document that cannot belong to the current editor.
  if (
    expectedSessionId !== undefined &&
    value.sessionId !== null &&
    value.sessionId !== expectedSessionId
  )
    return undefined;
  const event = parseEventValue(value.event);
  if (
    value.sessionId === null &&
    event.type !== "ready" &&
    event.type !== "error"
  )
    throw new Error("This editor event requires a session.");
  return { sessionId: value.sessionId, event };
}
const formats: Format[] = [
  "normal",
  "heading",
  "bold",
  "italic",
  "underline",
  "bulletList",
  "orderedList",
  "undo",
  "redo",
];
export const isLocalImageUri = (value: unknown): value is string =>
  typeof value === "string" &&
  /^file:\/\/[^?#]+\/siftnote-images\/sn_[a-z0-9]{1,16}_[a-z0-9]{32}\.(jpg|png|gif|webp)$/.test(
    value,
  ) &&
  !value.includes("..");
const validScale = (value: unknown): value is number =>
  typeof value === "number" &&
  Number.isFinite(value) &&
  value >= 0.5 &&
  value <= 5;
export function parseCommand(value: unknown): EditorCommand {
  if (!isRecord(value)) throw new Error("Invalid editor command.");
  switch (value.type) {
    case "init": {
      if (
        !isRecord(value.images) ||
        !validScale(value.fontScale) ||
        Object.keys(value.images).length > 10000
      )
        break;
      if (
        value.background !== undefined &&
        (typeof value.background !== "string" ||
          !/^#[0-9a-f]{6}$/i.test(value.background))
      )
        break;
      let target: EditorTarget | undefined;
      if (value.target !== undefined) {
        if (!isRecord(value.target)) break;
        if (value.target.type === "highlight" && validId(value.target.id))
          target = { type: "highlight", id: value.target.id };
        else if (
          value.target.type === "search" &&
          typeof value.target.query === "string" &&
          value.target.query.length <= 1000
        )
          target = { type: "search", query: value.target.query };
        else break;
      }
      const images: Record<string, string> = {};
      for (const [id, uri] of Object.entries(value.images)) {
        if (!validId(id) || !isLocalImageUri(uri))
          throw new Error("Invalid editor image.");
        images[id] = uri;
      }
      return {
        type: "init",
        content: parseDocument(value.content),
        images,
        fontScale: value.fontScale,
        ...(value.background !== undefined
          ? { background: value.background as string }
          : {}),
        ...(target ? { target } : {}),
      };
    }
    case "format":
      if (formats.includes(value.format as Format))
        return { type: "format", format: value.format as Format };
      break;
    case "highlight":
      if (isColor(value.color))
        return { type: "highlight", color: value.color };
      break;
    case "removeHighlight":
    case "blur":
      return { type: value.type };
    case "jumpHighlight":
      if (validId(value.id)) return { type: "jumpHighlight", id: value.id };
      break;
    case "jumpSearch":
      if (typeof value.query === "string" && value.query.length <= 1000)
        return { type: "jumpSearch", query: value.query };
      break;
    case "insertImage":
      if (validId(value.assetId) && isLocalImageUri(value.uri))
        return { type: "insertImage", assetId: value.assetId, uri: value.uri };
      break;
    case "snapshot":
      if (
        validId(value.requestId) &&
        (value.knownVersion === undefined ||
          (Number.isSafeInteger(value.knownVersion) &&
            Number(value.knownVersion) >= 0))
      )
        return {
          type: "snapshot",
          requestId: value.requestId,
          ...(value.knownVersion !== undefined
            ? { knownVersion: Number(value.knownVersion) }
            : {}),
        };
      break;
    case "paint":
      if (validId(value.requestId))
        return { type: "paint", requestId: value.requestId };
      break;
    case "fontScale":
      if (validScale(value.value))
        return { type: "fontScale", value: value.value };
      break;
  }
  throw new Error("Invalid editor command.");
}
export function parseEvent(raw: string): EditorEvent {
  if (raw.length > 16000000) throw new Error("Editor message is too large.");
  const value: unknown = JSON.parse(raw);
  return parseEventValue(value);
}
function parseEventValue(value: unknown): EditorEvent {
  if (!isRecord(value)) throw new Error("Invalid editor event.");
  const versionValid =
    Number.isSafeInteger(value.version) && Number(value.version) >= 0;
  switch (value.type) {
    case "debugTiming":
      if (
        validDebugTrace(value.traceId) &&
        ["documentReceived", "documentSet", "firstPaint"].includes(
          value.phase as string,
        ) &&
        typeof value.browserMs === "number" &&
        Number.isFinite(value.browserMs) &&
        value.browserMs >= 0 &&
        (value.sentAt === undefined ||
          (typeof value.sentAt === "number" &&
            Number.isFinite(value.sentAt) &&
            value.sentAt > 0))
      )
        return {
          type: "debugTiming",
          traceId: value.traceId,
          phase: value.phase as Extract<
            EditorEvent,
            { type: "debugTiming" }
          >["phase"],
          browserMs: value.browserMs,
          ...(typeof value.sentAt === "number" ? { sentAt: value.sentAt } : {}),
        };
      break;
    case "ready":
    case "initialized":
      return { type: value.type };
    case "dirty":
      if (versionValid)
        return { type: "dirty", version: Number(value.version) };
      break;
    case "snapshot":
    case "painted":
      if (validId(value.requestId))
        return { type: value.type, requestId: value.requestId };
      break;
    case "change":
      if (
        versionValid &&
        (value.requestId === undefined || validId(value.requestId))
      )
        return {
          type: "change",
          content: parseDocument(value.content),
          version: Number(value.version),
          ...(value.requestId ? { requestId: value.requestId } : {}),
        };
      break;
    case "selection": {
      if (!isRecord(value.state)) break;
      const s = value.state;
      if (
        !Object.keys(EMPTY_SELECTION).every((key) =>
          key === "highlightColor"
            ? s[key] === null || isColor(s[key])
            : typeof s[key] === "boolean",
        )
      )
        break;
      return { type: "selection", state: s as SelectionState };
    }
    case "feedback":
      if (
        [
          "applied",
          "removed",
          "image",
          "missingPassage",
          "selectText",
        ].includes(value.kind as string)
      )
        return {
          type: "feedback",
          kind: value.kind as Extract<
            EditorEvent,
            { type: "feedback" }
          >["kind"],
        };
      break;
    case "error":
      if (value.code === "editor" || value.code === "invalidDocument")
        return { type: "error", code: value.code };
      break;
  }
  throw new Error("Invalid editor event.");
}
