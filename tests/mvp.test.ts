import { repository } from "./sqlite-fixture";
import "./persistent-editor.test.mjs";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, dirname, join, resolve } from "node:path";
import { test } from "node:test";
import { runInNewContext } from "node:vm";
import { JsxEmit, ModuleKind, transpileModule } from "typescript";
// SDK-specific contract test only; application code uses public Expo Router APIs.
import type { NavigatorScreenParams } from "expo-router/react-navigation";
import { getStateFromPath } from "../node_modules/expo-router/build/react-navigation/core/getStateFromPath";
import { StackRouter } from "../node_modules/expo-router/build/react-navigation/routers/StackRouter";
import { JSDOM } from "jsdom";
import {
  analyzeDocument,
  createId,
  duplicateDocument,
  emptyDocument,
  HIGHLIGHT_COLORS,
  parseDocument,
  plainDocument,
  validId,
  type RichDocument,
} from "../src/domain/document";
import { migrateDatabase } from "../src/persistence/repository";
import { Autosave } from "../src/persistence/autosave";
import { flushEditorChanges } from "../src/features/notes/flush-editor";
import {
  parseCommand,
  parseEvent,
  parseCommandPacket,
  parseEventPacket,
  type EditorEventPacket,
  type EditorEvent,
} from "../src/editor/bridge";
import { EditorController } from "../src/editor/controller";
import * as perf from "../src/dev/perf";
import { copyPastedSlice } from "../src/editor/extensions";
import {
  EDITOR_ENTRY,
  EDITOR_FILES,
  EDITOR_HTML,
} from "../src/editor/generated/html";

// Load the real offline script inline in JSDOM, which has no Android file URI.
// Exercise the app's page serialization rather than duplicating its escaping.
const runtimeExports: Partial<typeof import("../src/editor/runtime")> = {};
runInNewContext(
  transpileModule(readFileSync(resolve("src/editor/runtime.ts"), "utf8"), {
    compilerOptions: { module: ModuleKind.CommonJS },
  }).outputText,
  {
    exports: runtimeExports,
    require: (name: string) =>
      name === "./generated/html"
        ? { EDITOR_HTML, EDITOR_FILES, EDITOR_ENTRY }
        : { Directory: class {}, Paths: { cache: "unused" } },
  },
);
function editorTestPage(packet?: string) {
  const script = EDITOR_FILES.find((file) => file.name.endsWith(".js"));
  assert.ok(script);
  const html = packet ? runtimeExports.editorPage!(packet) : EDITOR_HTML;
  return html.replace(
    `<script src="${script.name}"></script>`,
    () =>
      `<script>${script.contents.replace(/<\/script/gi, "<\\/script")}</script>`,
  );
}

test("temporary perf diagnostics are dev-only and share a monotonic trace", () => {
  for (const dev of [false, true]) {
    let clock = 100;
    const logs: string[] = [];
    const exports: Partial<typeof perf> = {};
    runInNewContext(
      transpileModule(readFileSync(resolve("src/dev/perf.ts"), "utf8"), {
        compilerOptions: { module: ModuleKind.CommonJS },
      }).outputText,
      {
        exports,
        __DEV__: dev,
        process: { env: { EXPO_PUBLIC_DEBUG_NO_WEBVIEW: "1" } },
        performance: { now: () => clock },
        console: { info: (_prefix: string, log: string) => logs.push(log) },
      },
    );
    assert.equal(exports.DEBUG_NO_WEBVIEW, dev);
    const trace = exports.perfStart!("open");
    clock += 25;
    exports.perfMark!("prepare.end", trace);
    if (!dev) {
      assert.equal(trace, undefined);
      assert.deepEqual(logs, []);
    } else {
      const events = logs.map((raw) => JSON.parse(raw));
      assert.equal(events[0].trace, events[1].trace);
      assert.equal(events[0].elapsedMs, 0);
      assert.equal(events[1].elapsedMs, 25);
    }
  }
});

test("JS heartbeat measures late callbacks without running in release and cleans up", () => {
  for (const dev of [false, true]) {
    let clock = 0;
    let tick: (() => void) | undefined;
    let cleared = false;
    const logs: { event: string; lagMs?: number }[] = [];
    const exports: Partial<typeof perf> = {};
    runInNewContext(
      transpileModule(readFileSync(resolve("src/dev/perf.ts"), "utf8"), {
        compilerOptions: { module: ModuleKind.CommonJS },
      }).outputText,
      {
        exports,
        __DEV__: dev,
        process: { env: {} },
        performance: { now: () => clock },
        console: {
          info: (_prefix: string, value: string) =>
            logs.push(JSON.parse(value)),
        },
        setInterval: (callback: () => void, delay: number) => {
          assert.equal(delay, 50);
          tick = callback;
          return 1;
        },
        clearInterval: (id: number) => {
          assert.equal(id, 1);
          cleared = true;
        },
      },
    );
    const stop = exports.startJsHeartbeat!();
    if (dev) {
      clock = 50;
      tick!();
      assert.equal(logs.length, 0);
      clock = 570;
      tick!();
      assert.equal(logs[0].event, "js.heartbeat.lag");
      assert.equal(logs[0].lagMs, 470);
      clock = 620;
      tick!();
      assert.equal(logs.length, 1);
    } else assert.equal(tick, undefined);
    stop();
    assert.equal(cleared, dev);
  }
});

test("paint acknowledgement waits for assets and two visible frames of the current document", async () => {
  const packets: EditorEventPacket[] = [];
  const frames: FrameRequestCallback[] = [];
  let hidden = false;
  let fontsReady!: () => void;
  const fonts = new Promise<void>((resolve) => {
    fontsReady = resolve;
  });
  const first = createId(),
    second = createId();
  const dom = new JSDOM(editorTestPage(), {
    runScripts: "dangerously",
    beforeParse(window) {
      Object.defineProperty(window.document, "hidden", { get: () => hidden });
      Object.defineProperty(window.document, "fonts", {
        value: { ready: fonts },
      });
      window.requestAnimationFrame = (callback) => {
        frames.push(callback);
        return frames.length;
      };
      window.ReactNativeWebView = {
        postMessage: (raw: string) => packets.push(parseEventPacket(raw)),
      };
    },
  });
  const settle = async () => {
    await new Promise((resolve) => setTimeout(resolve, 0));
  };
  const frame = () => frames.splice(0).forEach((callback) => callback(0));
  const painted = () =>
    packets.filter((packet) => packet.event.type === "painted");
  const init = (sessionId: string, text: string) =>
    dom.window.siftNoteReceive!({
      sessionId,
      command: {
        type: "init",
        content: plainDocument(text),
        images: {},
        fontScale: 1,
      },
    });
  try {
    init(first, "First");
    const stale = createId();
    dom.window.siftNoteReceive!({
      sessionId: first,
      command: { type: "paint", requestId: stale },
    });
    await settle();
    assert.equal(
      frames.length,
      0,
      "A paint receipt cannot precede font readiness",
    );
    fontsReady();
    await settle();
    frame();
    assert.equal(painted().length, 0, "One frame is insufficient");
    init(second, "Second");
    frame();
    assert.equal(
      painted().length,
      0,
      "Replaced documents cannot acknowledge old paint requests",
    );
    const pending = createId();
    hidden = true;
    dom.window.siftNoteReceive!({
      sessionId: second,
      command: { type: "paint", requestId: pending },
    });
    await settle();
    frame();
    frame();
    assert.equal(
      painted().length,
      0,
      "A hidden WebView cannot authorize reveal",
    );
    hidden = false;
    dom.window.document.dispatchEvent(new dom.window.Event("visibilitychange"));
    await settle();
    frame();
    frame();
    assert.deepEqual(painted(), [
      { sessionId: second, event: { type: "painted", requestId: pending } },
    ]);
    const superseded = createId(),
      newest = createId();
    dom.window.siftNoteReceive!({
      sessionId: second,
      command: { type: "paint", requestId: superseded },
    });
    dom.window.siftNoteReceive!({
      sessionId: second,
      command: { type: "paint", requestId: newest },
    });
    await settle();
    frame();
    frame();
    assert.equal(painted().length, 2);
    assert.deepEqual(painted()[1].event, {
      type: "painted",
      requestId: newest,
    });
    assert.equal(
      dom.window.document.querySelector(".tiptap")?.textContent,
      "Second",
    );
  } finally {
    dom.window.close();
  }
});

test("paint bridge identities and editor background are validated", () => {
  const requestId = createId();
  assert.deepEqual(parseCommand({ type: "paint", requestId }), {
    type: "paint",
    requestId,
  });
  assert.deepEqual(parseEvent(JSON.stringify({ type: "painted", requestId })), {
    type: "painted",
    requestId,
  });
  assert.throws(() => parseCommand({ type: "paint", requestId: "" }));
  assert.throws(() =>
    parseEvent(JSON.stringify({ type: "painted", requestId: "" })),
  );
  const command = {
    type: "init",
    content: emptyDocument(),
    images: {},
    fontScale: 1,
    background: "#123456",
  };
  assert.equal((parseCommand(command) as typeof command).background, "#123456");
  assert.throws(() =>
    parseCommand({ ...command, background: "url(https://remote.invalid)" }),
  );
  assert.ok(
    runtimeExports.editorPage!(
      JSON.stringify({ sessionId: createId(), command }),
      "#123456",
    ).includes("--siftnote-background:#123456"),
  );
  assert.throws(() => runtimeExports.editorPage!("{}", "red;opacity:0"));
});

test("temporary browser paint diagnostics are opt-in and ignore replaced sessions", () => {
  for (const debug of [false, true]) {
    const packets: EditorEventPacket[] = [];
    const frames: FrameRequestCallback[] = [];
    const firstSession = createId();
    const dom = new JSDOM(
      editorTestPage(
        JSON.stringify({
          sessionId: firstSession,
          command: {
            type: "init",
            content: plainDocument("First"),
            images: {},
            fontScale: 1,
          },
          ...(debug ? { debugTraceId: "perf_1" } : {}),
        }),
      ),
      {
        runScripts: "dangerously",
        beforeParse(window) {
          window.requestAnimationFrame = (callback) => {
            frames.push(callback);
            return frames.length;
          };
          window.ReactNativeWebView = {
            postMessage: (raw: string) => packets.push(parseEventPacket(raw)),
          };
        },
      },
    );
    try {
      const nextSession = createId();
      dom.window.siftNoteReceive!({
        sessionId: nextSession,
        command: {
          type: "init",
          content: plainDocument("Second"),
          images: {},
          fontScale: 1,
        },
        ...(debug ? { debugTraceId: "perf_2" } : {}),
      });
      assert.equal(
        dom.window.document.querySelector(".tiptap")?.textContent,
        "Second",
      );
      const timing = () =>
        packets.filter((packet) => packet.event.type === "debugTiming");
      assert.equal(
        timing().some(
          ({ event }) =>
            event.type === "debugTiming" && event.phase === "firstPaint",
        ),
        false,
      );
      frames.splice(0).forEach((frame) => frame(0));
      assert.equal(
        timing().some(
          ({ event }) =>
            event.type === "debugTiming" && event.phase === "firstPaint",
        ),
        false,
      );
      frames.splice(0).forEach((frame) => frame(16));
      const paints = timing().filter(
        ({ event }) =>
          event.type === "debugTiming" && event.phase === "firstPaint",
      );
      assert.equal(paints.length, debug ? 1 : 0);
      if (debug) {
        assert.equal(paints[0].sessionId, nextSession);
        assert.equal(
          paints[0].event.type === "debugTiming" && paints[0].event.traceId,
          "perf_2",
        );
      } else assert.equal(timing().length, 0);
      assert.equal(
        packets.filter(({ event }) => event.type === "initialized").length,
        2,
      );
      assert.ok(
        !packets.some(
          ({ event }) => event.type === "dirty" || event.type === "error",
        ),
      );
    } finally {
      dom.window.close();
    }
  }
  assert.throws(() =>
    parseCommandPacket({
      sessionId: createId(),
      command: { type: "blur" },
      debugTraceId: "arbitrary text",
    }),
  );
  assert.throws(() =>
    parseEvent(
      JSON.stringify({
        type: "debugTiming",
        traceId: "perf_1",
        phase: "firstPaint",
        browserMs: -1,
      }),
    ),
  );
});

function recordAnimations(prototype: Element) {
  const animations: {
    element: Element;
    keyframes: Keyframe[] | PropertyIndexedKeyframes | null;
    options: number | KeyframeAnimationOptions | undefined;
    cancelled: boolean;
  }[] = [];
  // jsdom has no rendering/animation engine. Record public API calls and cleanup.
  prototype.animate = function (keyframes, options) {
    const animation = {
      element: this,
      keyframes: structuredClone(keyframes),
      options: structuredClone(options),
      cancelled: false,
    };
    animations.push(animation);
    return {
      cancel: () => {
        animation.cancelled = true;
      },
    } as Animation;
  };
  return animations;
}

function highlighted(
  text = "Cells 🧬 and DNA",
  color: "yellow" | "blue" = "yellow",
): RichDocument {
  return {
    type: "doc",
    content: [
      {
        type: "paragraph",
        content: [
          {
            type: "text",
            text,
            marks: [
              {
                type: "highlight",
                attrs: { id: createId(), color, createdAt: Date.now() },
              },
            ],
          },
        ],
      },
    ],
  };
}

test("notes and highlight index persist across a real SQLite close/reopen", async () => {
  const directory = mkdtempSync(join(tmpdir(), "siftnote-test-"));
  const path = join(directory, "notes.db");
  try {
    let { db, repo } = await repository(path);
    const { id } = await repo.createNote();
    await repo.saveNote(id, { title: "Biology", content: highlighted() }, 0);
    db.native.close();
    ({ db, repo } = await repository(path));
    assert.equal((await repo.getNote(id))?.title, "Biology");
    assert.equal((await repo.listHighlights())[0].text, "Cells 🧬 and DNA");
    assert.equal((await repo.listNotes())[0].highlightCounts.yellow, 1);
    assert.equal(
      (await db.getFirstAsync<{ user_version: number }>("PRAGMA user_version"))
        ?.user_version,
      1,
    );
    db.native.close();
  } finally {
    assert.equal(dirname(resolve(directory)), resolve(tmpdir()));
    assert.ok(basename(directory).startsWith("siftnote-"));
    rmSync(directory, { recursive: true, force: true });
  }
});
test("creation returns the committed empty note and failed inserts do not return a note", async () => {
  const { db, repo } = await repository();
  try {
    const note = await repo.createNote();
    assert.deepEqual(note, await repo.getNote(note.id));
    db.failOn = "INSERT INTO notes";
    await assert.rejects(repo.createNote(), /Simulated write failure/);
    assert.equal((await repo.listNotes()).length, 1);
  } finally {
    db.native.close();
  }
});
test("multi-statement highlight saves and duplicates stay atomic with bounded parameters", async () => {
  const { db, repo } = await repository();
  const content: RichDocument = {
    type: "doc",
    content: Array.from({ length: 130 }, (_, index) => ({
      type: "paragraph",
      content: [
        {
          type: "text",
          text: `Passage ${index}: 'quoted' 🧬 %_`,
          marks: [
            {
              type: "highlight",
              attrs: {
                id: createId(),
                color: HIGHLIGHT_COLORS[index % 6],
                createdAt: Date.now(),
              },
            },
          ],
        },
      ],
    })),
  };
  try {
    const { id } = await repo.createNote();
    const revision = await repo.saveNote(id, { title: "Original", content }, 0);
    const original = await repo.listHighlights({ noteId: id });
    assert.equal(original.length, 130);
    assert.ok(db.maxBindParameters <= 512);
    assert.ok(db.highlightInsertStatements < 10);
    const copyId = await repo.duplicateNote(id);
    const copy = await repo.listHighlights({ noteId: copyId });
    assert.equal(copy.length, original.length);
    assert.deepEqual(
      copy.map((highlight) => highlight.text),
      original.map((highlight) => highlight.text),
    );
    const originalIds = new Set(original.map((highlight) => highlight.id));
    assert.ok(copy.every((highlight) => !originalIds.has(highlight.id)));
    db.failOn = "INSERT INTO highlights";
    db.failOnOccurrence = 2;
    db.resetMeasurements();
    await assert.rejects(
      repo.saveNote(id, { title: "New title", content }, revision),
      /Simulated write failure/,
    );
    assert.equal((await repo.getNote(id))?.revision, revision);
    assert.equal((await repo.getNote(id))?.title, "Original");
    assert.deepEqual(await repo.listHighlights({ noteId: id }), original);
    assert.deepEqual(await repo.listHighlights({ noteId: copyId }), copy);
    db.failOn = undefined;
    await repo.saveNote(
      id,
      { title: "Removed marks", content: emptyDocument() },
      revision,
    );
    assert.equal((await repo.listHighlights({ noteId: id })).length, 0);
    assert.equal((await repo.listHighlights({ noteId: copyId })).length, 130);
  } finally {
    db.native.close();
  }
});

test("failed index write rolls back the note and optimistic revision", async () => {
  const { db, repo } = await repository();
  const { id } = await repo.createNote();
  const first = highlighted("Original");
  await repo.saveNote(id, { title: "Keep me", content: first }, 0);
  db.failOn = "INSERT INTO highlights";
  await assert.rejects(
    repo.saveNote(
      id,
      { title: "Must roll back", content: highlighted("Replacement") },
      1,
    ),
  );
  db.failOn = undefined;
  assert.equal((await repo.getNote(id))?.title, "Keep me");
  assert.equal((await repo.getNote(id))?.revision, 1);
  assert.equal((await repo.listHighlights())[0].text, "Original");
  db.native.close();
});
test("highlight lists read the saved index without parsing note bodies or rebuilding it", async () => {
  const { db, repo } = await repository();
  try {
    const { id } = await repo.createNote();
    const content: RichDocument = {
      type: "doc",
      content: HIGHLIGHT_COLORS.map((color) => ({
        type: "paragraph",
        content: [
          {
            type: "text",
            text: `${color} passage`,
            marks: [
              {
                type: "highlight",
                attrs: { id: createId(), color, createdAt: Date.now() },
              },
            ],
          },
        ],
      })),
    };
    await repo.saveNote(id, { title: "Indexed note", content }, 0);
    const expected = analyzeDocument(content).highlights;
    // A highlight list must not depend on opening/validating the rich body.
    await db.runAsync(
      "UPDATE notes SET content=? WHERE id=?",
      "unreadable",
      id,
    );
    db.resetMeasurements();
    const perNote = await repo.listHighlights({ noteId: id });
    assert.deepEqual(
      perNote.map((h) => h.id),
      expected.map((h) => h.id),
    );
    assert.deepEqual(
      perNote.map((h) => h.position),
      expected.map((h) => h.position),
    );
    assert.ok(
      perNote.every((h) => h.noteId === id && h.noteTitle === "Indexed note"),
    );
    assert.equal((await repo.listHighlights()).length, 6);
    assert.equal((await repo.listHighlights({ query: "  " })).length, 6);
    for (const color of HIGHLIGHT_COLORS) {
      const matches = await repo.listHighlights({ color, query: "PASSAGE" });
      assert.equal(matches.length, 1);
      assert.equal(matches[0].color, color);
    }
    assert.deepEqual(await repo.listHighlights({ query: "missing" }), []);
    assert.equal(db.writeStatements, 0);
  } finally {
    db.native.close();
  }
});

test("sorting, literal/case/Unicode search, stale revisions, and deletion", async () => {
  const { db, repo } = await repository();
  const { id: first } = await repo.createNote();
  const { id: second } = await repo.createNote();
  await repo.saveNote(
    first,
    { title: "École", content: highlighted("ＣＥＬＬ 🧬 100%_DNA") },
    0,
  );
  await repo.setPinned(first, true);
  assert.equal((await repo.listNotes())[0].id, first);
  assert.equal((await repo.listNotes("éCOLE")).length, 1);
  assert.equal((await repo.listNotes("cell 🧬")).length, 1);
  assert.equal((await repo.listHighlights({ query: "100%_dna" })).length, 1);
  assert.equal((await repo.listNotes("not present")).length, 0);
  await assert.rejects(
    repo.saveNote(first, { title: "stale", content: emptyDocument() }, 0),
  );
  await repo.deleteNote(first);
  assert.equal(await repo.getNote(first), null);
  assert.equal((await repo.listHighlights()).length, 0);
  assert.equal((await repo.listNotes()).length, 1);
  await repo.deleteNote(second);
  db.native.close();
});
test("duplicate regenerates highlight IDs and shared images survive until last note deletion", async () => {
  const { db, repo } = await repository();
  const { id } = await repo.createNote();
  const asset = createId();
  await repo.registerAsset(id, {
    id: asset,
    fileName: `${asset}.jpg`,
    mime: "image/jpeg",
  });
  const content = highlighted();
  content.content.push({
    type: "image",
    attrs: { assetId: asset, src: `siftnote-image:${asset}` },
  });
  await repo.saveNote(id, { title: "Original", content }, 0);
  const copy = await repo.duplicateNote(id);
  const originalHighlight = (await repo.listHighlights({ noteId: id }))[0];
  const copiedHighlight = (await repo.listHighlights({ noteId: copy }))[0];
  assert.notEqual(copiedHighlight.id, originalHighlight.id);
  assert.equal(copiedHighlight.text, originalHighlight.text);
  // Exercise explicit dependent cleanup even when the transaction's connection has FK off.
  await db.execAsync("PRAGMA foreign_keys=OFF");
  await repo.deleteNote(id);
  assert.equal((await repo.listAssets()).length, 1);
  assert.equal((await repo.listHighlights({ noteId: id })).length, 0);
  await repo.deleteNote(copy);
  assert.equal((await repo.listAssets()).length, 0);
  assert.equal(
    (await db.getAllAsync("SELECT * FROM pending_file_deletions")).length,
    1,
  );
  db.native.close();
});
test("malformed persisted content is preserved; missing asset references never commit", async () => {
  const { db, repo } = await repository();
  const { id } = await repo.createNote();
  await db.runAsync("UPDATE notes SET content=? WHERE id=?", "{broken", id);
  await assert.rejects(repo.getNote(id));
  assert.equal(
    (
      await db.getFirstAsync<{ content: string }>(
        "SELECT content FROM notes WHERE id=?",
        id,
      )
    )?.content,
    "{broken",
  );
  const asset = createId();
  await assert.rejects(
    repo.saveNote(
      id,
      {
        title: "",
        content: {
          type: "doc",
          content: [
            {
              type: "image",
              attrs: { assetId: asset, src: `siftnote-image:${asset}` },
            },
          ],
        },
      },
      0,
    ),
  );
  await assert.rejects(
    repo.registerAsset(createId(), {
      id: asset,
      fileName: `${asset}.png`,
      mime: "image/png",
    }),
  );
  assert.equal((await repo.listAssets()).length, 0);
  db.native.close();
});
test("migrations refuse a newer database without dropping data", async () => {
  const { db } = await repository();
  await db.execAsync("PRAGMA user_version=9");
  await assert.rejects(migrateDatabase(db));
  assert.equal(
    (await db.getFirstAsync<{ user_version: number }>("PRAGMA user_version"))
      ?.user_version,
    9,
  );
  db.native.close();
});
test("document analysis uses marks, groups multiline fragments, and derives PM positions", () => {
  const doc = highlighted("🧬");
  const attrs = doc.content[0].content![0].marks![0];
  doc.content.unshift({
    type: "heading",
    attrs: { level: 2 },
    content: [{ type: "text", text: "The Cell" }],
  });
  doc.content.push({
    type: "paragraph",
    content: [{ type: "text", text: "DNA", marks: [attrs] }],
  });
  const result = analyzeDocument(parseDocument(doc));
  assert.equal(result.highlights[0].section, "The Cell");
  assert.equal(result.highlights[0].position, 11);
  assert.equal(result.highlights[0].text, "🧬\nDNA");
  assert.notEqual(
    analyzeDocument(duplicateDocument(doc)).highlights[0].id,
    result.highlights[0].id,
  );
  assert.throws(() =>
    parseDocument({ type: "doc", content: [{ type: "unknown" }] }),
  );
});
test("autosave coalesces keystrokes, serializes saves, retains failures for retry", async () => {
  const writes: string[] = [];
  let fail = true;
  const status: string[] = [];
  const save = new Autosave<string>(
    async (value) => {
      if (fail) throw new Error("disk full");
      writes.push(value);
    },
    (state) => status.push(state),
    10000,
  );
  save.schedule("a");
  save.schedule("ab");
  await assert.rejects(save.flush());
  assert.equal(save.dirty, true);
  fail = false;
  await save.flush();
  assert.deepEqual(writes, ["ab"]);
  assert.equal(save.dirty, false);
  assert.equal(status.at(-1), "saved");
  let release: () => void = () => {};
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  const serial = new Autosave<string>(
    async (value) => {
      writes.push(value);
      if (value === "first") await gate;
    },
    () => {},
    10000,
  );
  serial.schedule("first");
  const flushing = serial.flush();
  serial.schedule("latest");
  release();
  await flushing;
  assert.deepEqual(writes.slice(1), ["first", "latest"]);
});
test("bridge rejects arbitrary commands, remote paths, malformed documents and events", () => {
  const init = {
    type: "init",
    content: emptyDocument(),
    images: {},
    fontScale: 1,
  };
  assert.throws(() =>
    parseCommand({ ...init, target: { type: "highlight", id: "wrong" } }),
  );
  assert.throws(() =>
    parseCommand({
      ...init,
      target: { type: "search", query: "x".repeat(1001) },
    }),
  );
  assert.throws(() => parseCommand({ type: "eval", code: "alert(1)" }));
  assert.throws(() => parseCommand({ type: "reveal", animate: false }));
  assert.throws(() =>
    parseCommand({
      type: "insertImage",
      assetId: createId(),
      uri: "https://example.com/p.jpg",
    }),
  );
  assert.throws(() => parseEvent('{"type":"selection","state":{}}'));
  assert.throws(() =>
    parseEvent(
      '{"type":"change","version":1,"content":{"type":"doc","content":[]}}',
    ),
  );
  assert.equal(parseEvent('{"type":"ready"}').type, "ready");
});

test("background save commits received content before a suspended WebView responds", async () => {
  const { db, repo } = await repository();
  const { id } = await repo.createNote();
  let revision = 0;
  const saver = new Autosave<import("../src/domain/types").NoteDraft>(
    async (draft) => {
      revision = await repo.saveNote(id, draft, revision);
    },
    () => {},
    10000,
  );
  try {
    saver.schedule({
      title: "Background",
      content: highlighted("Received text"),
    });
    let release!: () => void;
    const waiting = new Promise<void>((resolve) => {
      release = resolve;
    });
    let started!: () => void;
    const requested = new Promise<void>((resolve) => {
      started = resolve;
    });
    const saving = flushEditorChanges(
      saver,
      async () => {
        started();
        await waiting;
        throw new Error("WebView suspended");
      },
      true,
    );
    const failure = assert.rejects(saving, /WebView suspended/);
    await requested;
    assert.equal((await repo.getNote(id))?.title, "Background");
    assert.equal((await repo.listHighlights())[0].text, "Received text");
    release();
    await failure;
    await assert.rejects(
      flushEditorChanges(saver, undefined, true),
      /unsaved changes/,
    );
    await flushEditorChanges(
      saver,
      async () => {
        saver.schedule({
          title: "Background",
          content: highlighted("Fresh snapshot"),
        });
      },
      true,
    );
    assert.equal((await repo.listHighlights())[0].text, "Fresh snapshot");
    assert.equal((await repo.getNote(id))?.revision, 2);
  } finally {
    await saver.stop();
    db.native.close();
  }
});

function editorFixture(
  content: RichDocument = plainDocument("Before 🧬 highlighted text after"),
) {
  const dom = new JSDOM("<div id='editor'></div>", {
    pretendToBeVisual: true,
    url: "https://local.invalid",
  });
  const w = dom.window;
  for (const name of [
    "window",
    "document",
    "navigator",
    "HTMLElement",
    "Node",
    "DOMParser",
    "MutationObserver",
    "getComputedStyle",
    "requestAnimationFrame",
    "cancelAnimationFrame",
    "innerHeight",
    "innerWidth",
  ]) {
    Object.defineProperty(globalThis, name, {
      value: name === "window" ? w : w[name as keyof typeof w],
      configurable: true,
      writable: true,
    });
  }
  w.Range.prototype.getClientRects = () => [] as unknown as DOMRectList;
  w.Range.prototype.getBoundingClientRect = () => ({
    x: 0,
    y: 0,
    width: 0,
    height: 0,
    top: 0,
    left: 0,
    right: 0,
    bottom: 0,
    toJSON: () => ({}),
  });
  w.scrollTo = () => {};
  w.document.elementFromPoint = () => null;
  const events: EditorEvent[] = [];
  const controller = new EditorController(
    w.document.getElementById("editor")!,
    (event) => events.push(event),
  );
  controller.receive({ type: "init", content, images: {}, fontScale: 1 });
  return {
    controller,
    editor: controller.editor,
    events,
    close: () => {
      controller.destroy();
      dom.window.close();
    },
  };
}
test("typing coalesces dirty notifications and snapshots acknowledge only matching live versions", () => {
  const f = editorFixture(plainDocument("Body"));
  try {
    const e = f.editor;
    f.events.length = 0;
    const first = createId();
    f.controller.receive({
      type: "snapshot",
      requestId: first,
      knownVersion: 0,
    });
    assert.deepEqual(f.events, [{ type: "snapshot", requestId: first }]);
    e.commands.insertContent("1");
    e.commands.insertContent("2");
    e.commands.insertContent("3");
    assert.equal(f.events.filter((event) => event.type === "dirty").length, 1);
    const fresh = createId();
    f.controller.receive({
      type: "snapshot",
      requestId: fresh,
      knownVersion: 0,
    });
    const change = f.events.findLast((event) => event.type === "change");
    assert.ok(change?.type === "change");
    assert.equal(change.version, 3);
    assert.equal(change.requestId, fresh);
    assert.deepEqual(change.content, parseDocument(e.getJSON()));
    const unchanged = createId();
    f.controller.receive({
      type: "snapshot",
      requestId: unchanged,
      knownVersion: 3,
    });
    assert.deepEqual(f.events.at(-1), {
      type: "snapshot",
      requestId: unchanged,
    });
    assert.equal(f.events.filter((event) => event.type === "change").length, 1);
    e.commands.insertContent("4");
    assert.equal(f.events.filter((event) => event.type === "dirty").length, 2);
    // Native may still believe the note is clean when typing immediately before
    // Back. The browser version forces a fresh body, never a false clean ack.
    const last = createId();
    f.controller.receive({
      type: "snapshot",
      requestId: last,
      knownVersion: 3,
    });
    const latest = f.events.findLast((event) => event.type === "change");
    assert.ok(latest?.type === "change");
    assert.equal(latest.version, 4);
    assert.equal(latest.requestId, last);
    assert.deepEqual(latest.content, parseDocument(e.getJSON()));
    assert.throws(() =>
      parseCommand({ type: "snapshot", requestId: first, knownVersion: -1 }),
    );
    assert.throws(() =>
      parseCommand({ type: "snapshot", requestId: first, knownVersion: 1.5 }),
    );
    assert.throws(() =>
      parseEvent('{"type":"snapshot","requestId":"invalid"}'),
    );
    assert.deepEqual(
      parseEvent(JSON.stringify({ type: "snapshot", requestId: first })),
      { type: "snapshot", requestId: first },
    );
  } finally {
    f.close();
  }
});
test("toolbar state follows stored marks, typing, selection and undo without duplicate transaction hooks", () => {
  const f = editorFixture(plainDocument("Body"));
  try {
    const latest = () => {
      const event = f.events.findLast((event) => event.type === "selection");
      assert.ok(event?.type === "selection");
      return event.state;
    };
    f.controller.receive({ type: "format", format: "bold" });
    assert.equal(latest().bold, true);
    f.editor.commands.insertContent("Bold ");
    assert.equal(latest().canUndo, true);
    f.controller.receive({ type: "format", format: "undo" });
    assert.equal(latest().canUndo, false);
    assert.equal(latest().canRedo, true);
    f.editor.commands.setTextSelection({ from: 1, to: 3 });
    assert.equal(latest().hasSelection, true);
    f.controller.receive({ type: "highlight", color: "green" });
    assert.equal(latest().highlightColor, "green");
    f.controller.receive({ type: "removeHighlight" });
    assert.equal(latest().highlightColor, null);
  } finally {
    f.close();
  }
});
test("review receives current unsaved marks on blur without duplicate document traffic", async () => {
  const { db, repo } = await repository();
  const initial = highlighted("Saved passage");
  const { id } = await repo.createNote();
  let revision = await repo.saveNote(
    id,
    { title: "Review", content: initial },
    0,
  );
  const f = editorFixture(initial);
  const saver = new Autosave<import("../src/domain/types").NoteDraft>(
    async (draft) => {
      revision = await repo.saveNote(id, draft, revision);
    },
    () => {},
    60000,
  );
  try {
    f.editor.commands.setTextSelection(4);
    f.editor.commands.insertContent(" fresh");
    assert.ok(!f.events.some((event) => event.type === "change"));
    f.controller.receive({ type: "blur" });
    const snapshot = f.events.findLast((event) => event.type === "change");
    assert.ok(snapshot?.type === "change");
    const review = analyzeDocument(snapshot.content).highlights;
    assert.equal(review[0].id, analyzeDocument(initial).highlights[0].id);
    assert.ok(review[0].text.includes("fresh"));
    saver.schedule({ title: "Review", content: snapshot.content });
    // Review can show the draft before persistence, without awaiting a query.
    assert.equal(
      (await repo.listHighlights({ noteId: id }))[0].text,
      "Saved passage",
    );
    const changes = f.events.filter((event) => event.type === "change").length;
    f.controller.receive({ type: "blur" });
    assert.equal(
      f.events.filter((event) => event.type === "change").length,
      changes,
    );
    const requestId = createId();
    f.controller.receive({ type: "snapshot", requestId });
    assert.ok(
      f.events.some(
        (event) => event.type === "change" && event.requestId === requestId,
      ),
    );
    await saver.flush();
    assert.equal(
      (await repo.listHighlights({ noteId: id }))[0].text,
      review[0].text,
    );
    assert.equal((await repo.getNote(id))?.revision, revision);
  } finally {
    await saver.stop();
    f.close();
    db.native.close();
  }
});

test("real ProseMirror highlights survive edits before/inside/after, recolor, undo/redo and deletion", () => {
  const f = editorFixture();
  try {
    const e = f.editor;
    assert.equal(e.can().undo(), false);
    e.commands.setTextSelection({ from: 11, to: 27 });
    f.controller.receive({ type: "highlight", color: "yellow" });
    const original = analyzeDocument(parseDocument(e.getJSON())).highlights[0];
    assert.ok(original.id);
    e.view.dispatch(e.state.tr.insertText("prefix ", 1));
    let next = analyzeDocument(parseDocument(e.getJSON())).highlights[0];
    assert.equal(next.id, original.id);
    assert.equal(next.position, original.position + 7);
    e.view.dispatch(e.state.tr.insertText("X", next.position + 2));
    next = analyzeDocument(parseDocument(e.getJSON())).highlights[0];
    assert.equal(next.id, original.id);
    assert.ok(next.text.includes("X"));
    e.view.dispatch(
      e.state.tr.insertText(" tail", e.state.doc.content.size - 1),
    );
    assert.equal(
      analyzeDocument(parseDocument(e.getJSON())).highlights[0].id,
      original.id,
    );
    e.commands.setTextSelection(next.position + 2);
    f.controller.receive({ type: "highlight", color: "blue" });
    assert.equal(
      analyzeDocument(parseDocument(e.getJSON())).highlights[0].color,
      "blue",
    );
    e.commands.undo();
    assert.equal(
      analyzeDocument(parseDocument(e.getJSON())).highlights[0].color,
      "yellow",
    );
    e.commands.redo();
    assert.equal(
      analyzeDocument(parseDocument(e.getJSON())).highlights[0].id,
      original.id,
    );
    f.controller.receive({ type: "removeHighlight" });
    assert.equal(
      analyzeDocument(parseDocument(e.getJSON())).highlights.length,
      0,
    );
    e.commands.undo();
    next = analyzeDocument(parseDocument(e.getJSON())).highlights[0];
    assert.equal(next.id, original.id);
    e.view.dispatch(
      e.state.tr.delete(next.position, next.position + next.text.length),
    );
    assert.equal(
      analyzeDocument(parseDocument(e.getJSON())).highlights.length,
      0,
    );
  } finally {
    f.close();
  }
});
test("multiline highlights, clipboard IDs, formatting and exact source lookup", () => {
  const f = editorFixture(plainDocument("repeat 🧬\nrepeat 🧬"));
  try {
    const e = f.editor;
    e.commands.setTextSelection({ from: 1, to: e.state.doc.content.size - 1 });
    f.controller.receive({ type: "highlight", color: "purple" });
    const first = analyzeDocument(parseDocument(e.getJSON())).highlights[0];
    assert.equal(first.text, "repeat 🧬\nrepeat 🧬");
    const copied = copyPastedSlice(
      e.state.doc.slice(0, e.state.doc.content.size),
      {},
    );
    e.view.dispatch(
      e.state.tr.insert(e.state.doc.content.size, copied.content),
    );
    let highlights = analyzeDocument(parseDocument(e.getJSON())).highlights;
    assert.equal(highlights.length, 2);
    assert.notEqual(highlights[0].id, highlights[1].id);
    f.controller.receive({ type: "jumpHighlight", id: highlights[1].id });
    assert.equal(e.state.selection.from, highlights[1].position);
    e.commands.setTextSelection({ from: 1, to: 7 });
    for (const format of ["bold", "italic", "underline"] as const)
      f.controller.receive({ type: "format", format });
    assert.ok(
      e.state.doc.nodeAt(1)?.marks.some((mark) => mark.type.name === "bold"),
    );
    f.controller.receive({ type: "format", format: "heading" });
    assert.equal(e.state.doc.firstChild?.type.name, "heading");
    f.controller.receive({ type: "format", format: "normal" });
    assert.equal(e.state.doc.firstChild?.type.name, "paragraph");
    highlights = analyzeDocument(parseDocument(e.getJSON())).highlights;
    assert.equal(highlights[0].id, first.id);
  } finally {
    f.close();
  }
});
test("source jumps skip later content after finding the exact passage", () => {
  const content = highlighted("First passage");
  content.content.push({
    type: "paragraph",
    content: [
      { type: "text", text: "Later " },
      { type: "text", text: "unrelated", marks: [{ type: "bold" }] },
      { type: "text", text: " content" },
    ],
  });
  const f = editorFixture(content);
  const doc = f.editor.state.doc;
  const descendants = doc.descendants;
  const visited: string[] = [];
  doc.descendants = (callback) =>
    descendants.call(doc, (node, pos, parent, index) => {
      visited.push(node.type.name);
      return callback(node, pos, parent, index);
    });
  try {
    const highlight = analyzeDocument(content).highlights[0];
    f.controller.receive({ type: "jumpHighlight", id: highlight.id });
    assert.equal(f.editor.state.selection.from, highlight.position);
    assert.deepEqual(visited, ["paragraph", "text", "paragraph"]);
    visited.length = 0;
    f.controller.receive({ type: "jumpSearch", query: "passage" });
    assert.equal(f.editor.state.selection.from, 7);
    assert.deepEqual(visited, ["paragraph", "paragraph"]);
    assert.ok(
      !f.events.some(
        (event) => event.type === "dirty" || event.type === "error",
      ),
    );
  } finally {
    doc.descendants = descendants;
    f.close();
  }
});

test("highlight boundaries exclude neighboring inserted text and images stay canonical", () => {
  const f = editorFixture(plainDocument("before mark after"));
  try {
    const e = f.editor;
    e.commands.setTextSelection({ from: 8, to: 12 });
    f.controller.receive({ type: "highlight", color: "orange" });
    let h = analyzeDocument(parseDocument(e.getJSON())).highlights[0];
    e.view.dispatch(e.state.tr.insertText("left", h.position));
    h = analyzeDocument(parseDocument(e.getJSON())).highlights[0];
    assert.equal(h.text, "mark");
    e.view.dispatch(e.state.tr.insertText("right", h.position + h.text.length));
    assert.equal(
      analyzeDocument(parseDocument(e.getJSON())).highlights[0].text,
      "mark",
    );
    const asset = createId();
    f.controller.receive({
      type: "insertImage",
      assetId: asset,
      uri: `file:///app/siftnote-images/${asset}.jpg`,
    });
    const doc = parseDocument(e.getJSON());
    assert.equal(analyzeDocument(doc).assetIds[0], asset);
    assert.ok(JSON.stringify(doc).includes(`siftnote-image:${asset}`));
    assert.ok(!JSON.stringify(doc).includes("file:///"));
  } finally {
    f.close();
  }
});

test("all six colors, lists and Unicode search locations use the real editor", () => {
  const f = editorFixture(
    plainDocument("\uFB03 cafe\u0301 🧬\nsecond paragraph"),
  );
  try {
    const e = f.editor;
    f.controller.receive({ type: "jumpSearch", query: "fi" });
    assert.equal(e.state.selection.from, 1);
    f.controller.receive({ type: "jumpSearch", query: "🧬" });
    assert.equal(e.state.selection.from, 9);
    e.commands.setTextSelection({ from: 1, to: 2 });
    let identity: string | undefined;
    for (const color of HIGHLIGHT_COLORS) {
      f.controller.receive({ type: "highlight", color });
      const highlight = analyzeDocument(parseDocument(e.getJSON()))
        .highlights[0];
      assert.equal(highlight.color, color);
      if (identity) assert.equal(highlight.id, identity);
      identity = highlight.id;
    }
    f.controller.receive({ type: "format", format: "bulletList" });
    assert.equal(e.state.doc.firstChild?.type.name, "bulletList");
    f.controller.receive({ type: "format", format: "orderedList" });
    assert.equal(e.state.doc.firstChild?.type.name, "orderedList");
    assert.equal(
      analyzeDocument(parseDocument(e.getJSON())).highlights[0].id,
      identity,
    );
  } finally {
    f.close();
  }
});

test("the bundled editor has complete content-addressed local fonts and a small page", () => {
  const page = EDITOR_FILES.find((file) => file.name === EDITOR_ENTRY);
  assert.equal(page?.contents, EDITOR_HTML);
  assert.ok(Buffer.byteLength(EDITOR_HTML) < 512 * 1024);
  const fonts = EDITOR_FILES.filter((file) => file.encoding === "base64");
  assert.equal(fonts.length, 6);
  for (const file of EDITOR_FILES) {
    const bytes = Buffer.from(file.contents, file.encoding);
    assert.equal(bytes.length, file.byteLength);
    const hash = createHash("sha256").update(bytes).digest("hex").slice(0, 16);
    assert.equal(
      file.name,
      `${file.encoding === "base64" ? "inter" : "editor"}-${hash}.${file.encoding === "base64" ? "ttf" : file.name.endsWith(".js") ? "js" : "html"}`,
    );
    if (file.encoding === "base64") {
      assert.ok(EDITOR_HTML.includes(`url(${file.name})`));
      assert.equal(bytes.readUInt32BE(0), 0x00010000);
    }
    if (file.name.endsWith(".js"))
      assert.ok(EDITOR_HTML.includes(`<script src="${file.name}"></script>`));
  }
  assert.ok(!EDITOR_HTML.includes("data:font"));
  assert.ok(!EDITOR_HTML.includes("font-display:block"));
  assert.ok(EDITOR_HTML.includes("font-display:swap"));
});

test("bridge packets require a valid session for edits and save acknowledgments", () => {
  const sessionId = createId();
  assert.throws(() =>
    parseEventPacket(
      JSON.stringify({ sessionId: null, event: { type: "initialized" } }),
    ),
  );
  assert.equal(
    parseEventPacket(
      JSON.stringify({ sessionId, event: { type: "initialized" } }),
    ).event.type,
    "initialized",
  );
  assert.equal(
    parseCommandPacket({ sessionId, command: { type: "blur" } }).sessionId,
    sessionId,
  );
  assert.throws(() =>
    parseCommandPacket({ sessionId: "wrong", command: { type: "blur" } }),
  );
  assert.throws(() =>
    parseEventPacket(
      JSON.stringify({
        sessionId: null,
        event: { type: "change", version: 0, content: emptyDocument() },
      }),
    ),
  );
  assert.throws(() =>
    parseEventPacket(
      JSON.stringify({ sessionId, event: { type: "selection", state: {} } }),
    ),
  );
  assert.equal(
    parseEventPacket(
      JSON.stringify({ sessionId: null, event: { type: "ready" } }),
    ).event.type,
    "ready",
  );
  const staleChange = JSON.stringify({
    sessionId: createId(),
    event: { type: "change", version: 1, content: { type: "invalid" } },
  });
  assert.equal(parseEventPacket(staleChange, sessionId), undefined);
  assert.throws(() => parseEventPacket(staleChange));
  assert.throws(() =>
    parseEventPacket(
      JSON.stringify({
        sessionId,
        event: { type: "change", version: 1, content: { type: "invalid" } },
      }),
      sessionId,
    ),
  );
  assert.equal(
    parseEventPacket(
      JSON.stringify({
        sessionId,
        event: { type: "snapshot", requestId: createId() },
      }),
      sessionId,
    )?.event.type,
    "snapshot",
  );
  assert.equal(
    parseEventPacket(
      JSON.stringify({
        sessionId: null,
        event: { type: "error", code: "editor" },
      }),
      sessionId,
    )?.event.type,
    "error",
  );
});

test("native stack retains Tabs beneath pushed notes and pops to the same browsing route", () => {
  const cold = getStateFromPath<{
    "note/[id]": { id: string };
    "(tabs)": NavigatorScreenParams<{
      index: undefined;
      highlights: undefined;
    }>;
  }>("/", {
    initialRouteName: "(tabs)",
    screens: {
      "(tabs)": { screens: { index: "", highlights: "highlights" } },
      "note/[id]": "note/:id",
    },
  });
  assert.deepEqual(
    cold?.routes.map((route) => route.name),
    ["(tabs)"],
  );
  const stack = StackRouter({ initialRouteName: "(tabs)" });
  const config = {
    routeNames: ["(tabs)", "note/[id]"],
    routeParamList: {},
    routeGetIdList: {},
  };
  let state = stack.getInitialState(config);
  const tabsKey = state.routes[0].key;
  const apply = (action: Parameters<typeof stack.getStateForAction>[1]) => {
    const next = stack.getStateForAction(state, action, config);
    assert.ok(next);
    state = stack.getRehydratedState(next, config);
    assert.equal(state.routes[0].key, tabsKey);
    assert.equal(state.preloadedRoutes.length, 0);
  };
  for (const tab of ["index", "highlights", "index"]) {
    apply({
      type: "SET_PARAMS",
      source: tabsKey,
      payload: { params: { screen: tab } },
    });
    const id = createId();
    apply({
      type: "PUSH",
      payload: { name: "note/[id]", params: { id, openingId: createId() } },
    });
    assert.deepEqual(
      state.routes.map((route) => route.name),
      ["(tabs)", "note/[id]"],
    );
    assert.equal((state.routes[1].params as { id: string })?.id, id);
    apply({ type: "POP", payload: { count: 1 } });
    assert.equal(state.routes.length, 1);
    assert.equal((state.routes[0].params as { screen: string })?.screen, tab);
  }
});

for (const result of ["loaded", "failed", "detached"] as const)
  test(`startup fonts settle before the first document layout (${result})`, async () => {
    const sessionId = createId();
    const content = highlighted("Stable first layout");
    const packets: EditorEventPacket[] = [];
    const requests: {
      font: string;
      resolve: (faces: FontFace[]) => void;
      reject: (error: Error) => void;
    }[] = [];
    const dom = new JSDOM(
      editorTestPage(
        JSON.stringify({
          sessionId,
          command: { type: "init", content, images: {}, fontScale: 1 },
        }),
      ),
      {
        runScripts: "dangerously",
        beforeParse(window) {
          Object.defineProperty(window.document, "fonts", {
            value: {
              status: "loaded",
              load: (font: string) =>
                new Promise<FontFace[]>((resolve, reject) =>
                  requests.push({ font, resolve, reject }),
                ),
            },
          });
          window.ReactNativeWebView = {
            postMessage: (raw: string) => packets.push(parseEventPacket(raw)),
          };
        },
      },
    );
    try {
      assert.equal(requests.length, 4);
      assert.equal(dom.window.document.querySelector(".tiptap"), null);
      assert.equal(
        packets.length,
        0,
        "No document/ready acknowledgement precedes fonts",
      );
      for (const [index, request] of requests.slice(0, -1).entries()) {
        if (result === "failed" && index === 0)
          request.reject(new Error("Missing local font"));
        else request.resolve([]);
      }
      await new Promise<void>((resolve) => dom.window.setTimeout(resolve, 0));
      assert.equal(dom.window.document.querySelector(".tiptap"), null);
      if (result === "detached")
        dom.window.document.getElementById("editor")!.remove();
      requests.at(-1)!.resolve([]);
      await new Promise<void>((resolve) => dom.window.setTimeout(resolve, 0));
      if (result === "detached") {
        assert.equal(dom.window.document.querySelector(".tiptap"), null);
        assert.equal(
          packets.length,
          0,
          "A closed host must not initialize late",
        );
      } else {
        assert.equal(
          dom.window.document.querySelector(".tiptap")!.textContent,
          "Stable first layout",
        );
        assert.equal(
          packets.filter((p) => p.event.type === "initialized").length,
          1,
        );
        assert.equal(packets.filter((p) => p.event.type === "ready").length, 1);
        assert.ok(
          !packets.some(
            (p) => p.event.type === "dirty" || p.event.type === "error",
          ),
        );
        const requestId = createId();
        dom.window.siftNoteReceive!({
          sessionId,
          command: { type: "snapshot", requestId },
        });
        const saved = packets.find(
          (p) => p.event.type === "change" && p.event.requestId === requestId,
        );
        assert.ok(saved?.event.type === "change");
        assert.deepEqual(saved.event.content, content);
        assert.equal(saved.event.version, 0);
      }
    } finally {
      dom.window.close();
    }
  });

test("startup data populates the actual document before ready without a native init round trip", async () => {
  for (const initialScale of [1, 1.4]) {
    const sessionId = createId();
    const text = 'Quotes " ` ${window.executed=true} $& $` </script> DNA 🧬\\n';
    const content = highlighted(text);
    const target = analyzeDocument(content).highlights[0].id;
    const assetId = createId();
    const uri = `file:///app/siftnote-images/${assetId}.jpg`;
    content.content.push(
      {
        type: "image",
        attrs: { assetId, src: `siftnote-image:${assetId}`, alt: "Note image" },
      },
      { type: "paragraph" },
    );
    const packet = JSON.stringify({
      sessionId,
      command: {
        type: "init",
        content,
        images: { [assetId]: uri },
        fontScale: initialScale,
        target: { type: "highlight", id: target },
      },
    });
    const events: EditorEventPacket[] = [];
    const dom = new JSDOM(editorTestPage(packet), {
      runScripts: "dangerously",
      pretendToBeVisual: true,
      url: `file:///app/siftnote-editor/${EDITOR_ENTRY}`,
      beforeParse(window) {
        window.ReactNativeWebView = {
          postMessage: (raw: string) => {
            const packet = parseEventPacket(raw);
            events.push(packet);
            if (packet.event.type === "initialized") {
              assert.ok(
                window.document
                  .querySelector(".tiptap")
                  ?.textContent?.includes(text),
              );
              assert.notEqual(
                window.getComputedStyle(
                  window.document.getElementById("editor")!,
                ).opacity,
                "0",
              );
            }
          },
        };
      },
    });
    try {
      assert.ok(
        !events.some((packet) => packet.event.type === "error"),
        JSON.stringify(events),
      );
      assert.equal(
        JSON.parse(
          dom.window.document.getElementById("siftnote-startup")!.textContent!,
        ).sessionId,
        sessionId,
        "Startup is one JSON object, not an escaped JSON string requiring another full parse.",
      );
      assert.equal(
        events.filter((packet) => packet.event.type === "initialized").length,
        1,
      );
      assert.ok(
        events.some(
          (packet) =>
            packet.sessionId === sessionId && packet.event.type === "ready",
        ),
      );
      assert.equal(
        dom.window.document.querySelector(".tiptap img")?.getAttribute("src"),
        uri,
      );
      assert.ok(dom.window.document.querySelector(".source-flash"));
      assert.equal(
        (dom.window as unknown as { executed?: boolean }).executed,
        undefined,
      );
      // Let image/selection DOM observations settle while the page is live.
      await new Promise<void>((resolve) => dom.window.setTimeout(resolve, 0));
      const requestId = createId();
      dom.window.siftNoteReceive!({
        sessionId,
        command: { type: "snapshot", requestId },
      });
      const saved = events.find(
        (packet) =>
          packet.event.type === "change" &&
          packet.event.requestId === requestId,
      );
      assert.ok(saved?.event.type === "change");
      assert.deepEqual(saved.event.content, content);
      assert.equal(saved.event.version, 0);
      assert.ok(!events.some((packet) => packet.event.type === "dirty"));
    } finally {
      dom.window.close();
    }
  }
});

test("note bodies retain their document without JavaScript entrance animations on reopening or editing", () => {
  const assetId = createId();
  const content = highlighted("First passage");
  content.content.push(
    {
      type: "heading",
      attrs: { level: 2 },
      content: [{ type: "text", text: "Heading" }],
    },
    {
      type: "bulletList",
      content: [
        {
          type: "listItem",
          content: [
            {
              type: "paragraph",
              content: [{ type: "text", text: "List item" }],
            },
          ],
        },
      ],
    },
    {
      type: "image",
      attrs: { assetId, src: `siftnote-image:${assetId}`, alt: "Note image" },
    },
    { type: "paragraph" },
    {
      type: "paragraph",
      content: [{ type: "text", text: "Offscreen passage" }],
    },
  );
  for (let opening = 0; opening < 2; opening++) {
    const sessionId = createId();
    const command = {
      type: "init",
      content,
      images: { [assetId]: `file:///app/siftnote-images/${assetId}.jpg` },
      fontScale: 1,
    };
    const packets: EditorEventPacket[] = [];
    let animations!: ReturnType<typeof recordAnimations>;
    const dom = new JSDOM(
      editorTestPage(JSON.stringify({ sessionId, command })),
      {
        runScripts: "dangerously",
        pretendToBeVisual: true,
        beforeParse(window) {
          animations = recordAnimations(window.Element.prototype);
          Object.defineProperty(window, "innerHeight", { value: 240 });
          window.Element.prototype.getBoundingClientRect = function () {
            const index = this.parentElement?.classList.contains("tiptap")
              ? Array.from(this.parentElement.children).indexOf(this)
              : 0;
            return {
              x: 0,
              y: index * 60,
              top: index * 60,
              bottom: index * 60 + 50,
              left: 0,
              right: 300,
              width: 300,
              height: 50,
              toJSON: () => ({}),
            };
          };
          window.ReactNativeWebView = {
            postMessage: (raw: string) => packets.push(parseEventPacket(raw)),
          };
        },
      },
    );
    try {
      assert.equal(animations.length, 0);
      assert.notEqual(
        dom.window.getComputedStyle(
          dom.window.document.querySelector(".tiptap")!,
        ).opacity,
        "0",
      );
      assert.equal(
        packets.filter((packet) => packet.event.type === "initialized").length,
        1,
      );
      const receive = dom.window.siftNoteReceive!;
      const requestId = createId();
      receive({ sessionId, command: { type: "snapshot", requestId } });
      const saved = packets.find(
        (packet) =>
          packet.event.type === "change" &&
          packet.event.requestId === requestId,
      );
      assert.ok(saved?.event.type === "change");
      assert.deepEqual(saved.event.content, content);
      assert.equal(saved.event.version, 0);
      receive({ sessionId, command: { type: "fontScale", value: 1.4 } });
      assert.equal(animations.length, 0);
      dom.window.document
        .querySelector(".tiptap")!
        .dispatchEvent(new dom.window.Event("pointerdown", { bubbles: true }));
      receive({ sessionId, command: { type: "format", format: "heading" } });
      assert.equal(
        animations.length,
        0,
        "Editing must not add an entrance fade.",
      );
      assert.ok(!packets.some((packet) => packet.event.type === "error"));
    } finally {
      dom.window.close();
    }
  }
});

test("empty notes and reduced-motion settings never hide the editor body", () => {
  for (const reduced of [false, true]) {
    const sessionId = createId();
    const content = reduced
      ? highlighted("Visible with reduced motion")
      : emptyDocument();
    let animations!: ReturnType<typeof recordAnimations>;
    const packets: EditorEventPacket[] = [];
    const dom = new JSDOM(
      editorTestPage(
        JSON.stringify({
          sessionId,
          command: { type: "init", content, images: {}, fontScale: 1 },
        }),
      ),
      {
        runScripts: "dangerously",
        beforeParse(window) {
          animations = recordAnimations(window.Element.prototype);
          Object.defineProperty(window, "matchMedia", {
            value: () => ({ matches: reduced }),
          });
          window.Element.prototype.getBoundingClientRect = () => ({
            x: 0,
            y: 0,
            top: 0,
            bottom: 60,
            left: 0,
            right: 300,
            width: 300,
            height: 60,
            toJSON: () => ({}),
          });
          window.ReactNativeWebView = {
            postMessage: (raw: string) => packets.push(parseEventPacket(raw)),
          };
        },
      },
    );
    try {
      assert.equal(animations.length, 0);
      assert.equal(
        packets.filter((packet) => packet.event.type === "initialized").length,
        1,
      );
      assert.notEqual(
        dom.window.getComputedStyle(
          dom.window.document.querySelector(".tiptap")!,
        ).opacity,
        "0",
      );
      assert.equal(
        dom.window.document.querySelector(".tiptap")!.textContent,
        reduced ? "Visible with reduced motion" : "",
      );
      assert.ok(!packets.some((packet) => packet.event.type === "error"));
    } finally {
      dom.window.close();
    }
  }
});

test("startup data rejects malformed commands and remote image mappings", () => {
  for (const command of [
    { type: "format", format: "bold" },
    {
      type: "init",
      content: emptyDocument(),
      images: { [createId()]: "https://remote.invalid/image.jpg" },
      fontScale: 1,
    },
  ]) {
    const events: EditorEventPacket[] = [];
    const dom = new JSDOM(
      editorTestPage(JSON.stringify({ sessionId: createId(), command })),
      {
        runScripts: "dangerously",
        beforeParse(window) {
          window.ReactNativeWebView = {
            postMessage: (raw: string) => events.push(parseEventPacket(raw)),
          };
        },
      },
    );
    try {
      assert.ok(events.some((packet) => packet.event.type === "error"));
      assert.ok(
        !events.some(
          (packet) =>
            packet.event.type === "initialized" ||
            packet.event.type === "change",
        ),
      );
    } finally {
      dom.window.close();
    }
  }
});

test("note opening navigates before preparation and releases failed navigation requests", async () => {
  const { db, repo } = await repository();
  const note = await repo.createNote();
  const prepared = {
    openingId: createId(),
    note,
    images: {},
    runtime: { uri: "file:///app/editor.html" },
    missingImage: false,
  };
  const order: string[] = [];
  let failRequest = false;
  let routedHighlightId: string | undefined;
  let handedOff: unknown;
  let loading: Promise<typeof prepared | null> = Promise.resolve(prepared);
  const sources: (string | typeof note)[] = [];
  // Exercise the actual native opening function with platform adapters mocked.
  // No screen/layout/WebView readiness event is provided by this test.
  const compiled = transpileModule(
    readFileSync(resolve("src/features/notes/shared.tsx"), "utf8"),
    { compilerOptions: { module: ModuleKind.CommonJS, jsx: JsxEmit.ReactJSX } },
  );
  const exports: {
    openNote?: typeof import("../src/features/notes/shared").openNote;
    useCreateNote?: typeof import("../src/features/notes/shared").useCreateNote;
  } = {};
  runInNewContext(compiled.outputText, {
    exports,
    require: (name: string) => {
      if (name === "../../dev/perf") return perf;
      if (name === "react")
        return {
          useRef: (current: unknown) => ({ current }),
          useState: (initial: unknown) => [initial, () => {}],
        };
      if (name === "../../state/app-context")
        return {
          useApp: () => ({
            repo: {
              createNote: async () => {
                order.push("insert");
                return repo.createNote();
              },
            },
            refresh: () => order.push("refresh"),
            toast: () => {},
          }),
        };
      if (name === "expo-router")
        return {
          usePathname: () => {
            throw new Error(
              "Opening must not subscribe to global pathname changes",
            );
          },
          router: {
            push: (href: {
              pathname: string;
              params: { id: string; openingId: string; highlightId?: string };
            }) => {
              order.push("request");
              assert.equal(href.pathname, "/note/[id]");
              const request =
                handedOff as import("../src/features/notes/prepared-note").NoteOpening;
              routedHighlightId =
                request.target?.type === "highlight"
                  ? request.target.id
                  : undefined;
              assert.ok(validId(request.openingId));
              if (failRequest) throw new Error("Navigation failed");
            },
          },
        };
      if (name === "./prepared-note")
        return {
          loadNoteForOpening: (
            _repo: unknown,
            source: string | typeof note,
          ) => {
            order.push("load");
            sources.push(source);
            return loading;
          },
          stagePreparedNote: (value: unknown) => {
            order.push("stage");
            handedOff = value;
          },
          releasePreparedNote: (value: unknown) => {
            assert.equal(value, handedOff);
            order.push("release");
            handedOff = undefined;
          },
        };
      if (name === "../../domain/document") return { createId, validId };
      return {};
    },
  });
  try {
    assert.ok(exports.openNote);
    let finishLoading!: (value: typeof prepared) => void;
    loading = new Promise((resolve) => {
      finishLoading = resolve;
    });
    const highlightId = createId();
    const opening = exports.openNote(repo, note.id, highlightId);
    // Dispatch navigation before calling SQLite or preparing the runtime.
    assert.deepEqual(order, ["stage", "request"]);
    (
      handedOff as import("../src/features/notes/prepared-note").NoteOpening
    ).load();
    assert.deepEqual(order, ["stage", "request", "load"]);
    assert.equal(routedHighlightId, highlightId);
    const firstRequest = handedOff;
    let finishReopening!: (value: typeof prepared) => void;
    loading = new Promise((resolve) => {
      finishReopening = resolve;
    });
    const reopened = exports.openNote(repo, note);
    assert.notEqual(handedOff, firstRequest);
    (
      handedOff as import("../src/features/notes/prepared-note").NoteOpening
    ).load();
    const twoOpenings = [
      "stage",
      "request",
      "load",
      "stage",
      "request",
      "load",
    ];
    assert.deepEqual(order, twoOpenings);
    finishLoading(prepared);
    await opening;
    assert.deepEqual(order, twoOpenings);
    finishReopening(prepared);
    await reopened;
    assert.deepEqual(sources, [note.id, note]);
    order.length = 0;
    failRequest = true;
    loading = Promise.resolve(prepared);
    await assert.rejects(exports.openNote(repo, note.id), /Navigation failed/);
    assert.deepEqual(order, ["stage", "request", "release"]);
    order.length = 0;
    failRequest = false;
    const successfulOpen = exports.openNote(repo, note);
    assert.deepEqual(order, ["stage", "request"]);
    (
      handedOff as import("../src/features/notes/prepared-note").NoteOpening
    ).load();
    assert.deepEqual(order, ["stage", "request", "load"]);
    await successfulOpen;
    assert.equal(sources.at(-1), note);
    order.length = 0;
    loading = Promise.reject(new Error("Storage unavailable"));
    void loading.catch(() => {});
    const rejectedLoad = exports.openNote(repo, note.id);
    assert.deepEqual(order, ["stage", "request"]);
    (
      handedOff as import("../src/features/notes/prepared-note").NoteOpening
    ).load();
    assert.deepEqual(order, ["stage", "request", "load"]);
    await rejectedLoad;
    await assert.rejects(
      (
        handedOff as import("../src/features/notes/prepared-note").NoteOpening
      ).load(),
      /Storage unavailable/,
    );
    order.length = 0;
    loading = Promise.resolve(prepared);
    const creation = exports.useCreateNote!().create();
    assert.deepEqual(order, ["stage", "request"]);
    (
      handedOff as import("../src/features/notes/prepared-note").NoteOpening
    ).load();
    await new Promise((resolve) => setTimeout(resolve, 0));
    await creation;
    assert.deepEqual(order, ["stage", "request", "insert", "refresh", "load"]);
    assert.equal((handedOff as { title: string }).title, "");
    assert.notEqual((sources.at(-1) as typeof note).id, note.id);
    assert.equal((await repo.listNotes()).length, 2);
    order.length = 0;
    loading = Promise.resolve(prepared);
    const lastOpen = exports.openNote(repo, note.id);
    assert.deepEqual(order, ["stage", "request"]);
    (
      handedOff as import("../src/features/notes/prepared-note").NoteOpening
    ).load();
    assert.deepEqual(order, ["stage", "request", "load"]);
    await lastOpen;
  } finally {
    db.native.close();
  }
});

test("opening channel delivers synchronously and old cancellation cannot remove a newer request", () => {
  type Handoff = typeof import("../src/features/notes/prepared-note");
  const exports: Partial<
    Pick<
      Handoff,
      | "stagePreparedNote"
      | "currentPreparedNote"
      | "subscribePreparedNote"
      | "releasePreparedNote"
    >
  > = {};
  const compiled = transpileModule(
    readFileSync(resolve("src/features/notes/prepared-note.ts"), "utf8"),
    { compilerOptions: { module: ModuleKind.CommonJS } },
  );
  runInNewContext(compiled.outputText, {
    exports,
    require: (name: string) => (name.endsWith("/dev/perf") ? perf : {}),
  });
  assert.ok(exports.stagePreparedNote);
  assert.ok(exports.currentPreparedNote);
  assert.ok(exports.subscribePreparedNote);
  assert.ok(exports.releasePreparedNote);
  const first = {
    openingId: createId(),
    title: "",
    load: () => Promise.resolve(null),
  };
  const second = { ...first, openingId: createId() };
  const delivered: unknown[] = [];
  const unsubscribe = exports.subscribePreparedNote(() =>
    delivered.push(exports.currentPreparedNote!()),
  );
  exports.stagePreparedNote(first);
  assert.equal(exports.currentPreparedNote(), first);
  assert.deepEqual(delivered, [first]);
  exports.stagePreparedNote(second);
  exports.releasePreparedNote(first);
  assert.equal(exports.currentPreparedNote(), second);
  exports.releasePreparedNote(second);
  assert.equal(exports.currentPreparedNote(), undefined);
  assert.deepEqual(delivered, [first, second, undefined]);
  unsubscribe();
  exports.stagePreparedNote(first);
  exports.releasePreparedNote(first);
  assert.equal(delivered.length, 3);
});

test("a warm browser switches note sessions without retaining undo or accepting stale commands", async () => {
  const packets: EditorEventPacket[] = [];
  const dom = new JSDOM(editorTestPage(), {
    runScripts: "dangerously",
    pretendToBeVisual: true,
    url: `file:///app/siftnote-editor/${EDITOR_ENTRY}`,
    beforeParse(window) {
      window.ReactNativeWebView = {
        postMessage: (raw: string) => packets.push(parseEventPacket(raw)),
      };
      window.Range.prototype.getClientRects = () =>
        [] as unknown as DOMRectList;
      window.Range.prototype.getBoundingClientRect = () => ({
        x: 0,
        y: 0,
        top: 0,
        left: 0,
        right: 0,
        bottom: 0,
        width: 0,
        height: 0,
        toJSON: () => ({}),
      });
    },
  });
  try {
    const receive = dom.window.siftNoteReceive!;
    const view = dom.window.document.querySelector(".tiptap");
    assert.ok(
      view,
      "The editor runtime must already exist before the first note.",
    );
    const first = createId(),
      second = createId();
    receive({
      sessionId: first,
      command: {
        type: "init",
        content: plainDocument("First note"),
        images: {},
        fontScale: 1,
      },
    });
    const paragraph = dom.window.document.querySelector(".tiptap p")!;
    paragraph.textContent = "First note edited";
    paragraph.dispatchEvent(new dom.window.Event("input", { bubbles: true }));
    await new Promise((resolve) => dom.window.setTimeout(resolve, 25));
    assert.ok(
      packets.some(
        (packet) => packet.sessionId === first && packet.event.type === "dirty",
      ),
    );
    receive({
      sessionId: second,
      command: {
        type: "init",
        content: plainDocument("Second note"),
        images: {},
        fontScale: 1,
      },
    });
    receive({
      sessionId: first,
      command: {
        type: "insertImage",
        assetId: createId(),
        uri: `file:///app/siftnote-images/${createId()}.jpg`,
      },
    });
    const staleRequest = createId();
    receive({
      sessionId: first,
      command: { type: "snapshot", requestId: staleRequest },
    });
    receive({ sessionId: second, command: { type: "format", format: "undo" } });
    const requestId = createId();
    receive({ sessionId: second, command: { type: "snapshot", requestId } });
    const saved = packets.find(
      (packet) =>
        packet.event.type === "change" && packet.event.requestId === requestId,
    );
    assert.equal(saved?.sessionId, second);
    if (saved?.event.type === "change") {
      assert.equal(saved.event.version, 0);
      assert.deepEqual(saved.event.content, plainDocument("Second note"));
    } else assert.fail("The second session did not acknowledge its snapshot.");
    const acknowledged = createId();
    const changes = packets.filter(
      (packet) => packet.event.type === "change",
    ).length;
    receive({
      sessionId: second,
      command: { type: "snapshot", requestId: acknowledged, knownVersion: 0 },
    });
    const ack = packets.find(
      (packet) =>
        packet.event.type === "snapshot" &&
        packet.event.requestId === acknowledged,
    );
    assert.equal(ack?.sessionId, second);
    assert.equal(
      packets.filter((packet) => packet.event.type === "change").length,
      changes,
    );
    assert.throws(() =>
      parseEventPacket(
        JSON.stringify({
          sessionId: null,
          event: { type: "snapshot", requestId: acknowledged },
        }),
      ),
    );
    const selection = packets.findLast(
      (packet) =>
        packet.sessionId === second && packet.event.type === "selection",
    );
    if (selection?.event.type === "selection")
      assert.equal(selection.event.state.canUndo, false);
    else assert.fail("The second session did not report selection state.");
    await new Promise((resolve) => dom.window.setTimeout(resolve, 250));
    assert.ok(
      !packets.some(
        (packet) =>
          packet.event.type === "change" &&
          packet.event.requestId === staleRequest,
      ),
    );
    assert.ok(
      !packets.some(
        (packet) =>
          packet.sessionId === first && packet.event.type === "change",
      ),
    );
    assert.equal(dom.window.document.querySelectorAll(".tiptap").length, 1);
    assert.equal(dom.window.document.querySelector(".tiptap"), view);
    assert.ok(!packets.some((packet) => packet.event.type === "error"));
  } finally {
    dom.window.close();
  }
});

test("document replacement places the source without a body overlay or remounting Tiptap", () => {
  const packets: EditorEventPacket[] = [];
  const positions: string[] = [];
  const dom = new JSDOM(editorTestPage(), {
    runScripts: "dangerously",
    pretendToBeVisual: true,
    beforeParse(window) {
      window.Element.prototype.scrollIntoView = function () {
        positions.push(this.textContent ?? "");
      };
      window.ReactNativeWebView = {
        postMessage(raw: string) {
          const packet = parseEventPacket(raw);
          if (packet.event.type === "initialized")
            assert.notEqual(
              window.getComputedStyle(window.document.getElementById("editor")!)
                .opacity,
              "0",
            );
          packets.push(packet);
        },
      };
    },
  });
  try {
    const receive = dom.window.siftNoteReceive!;
    const view = dom.window.document.querySelector(".tiptap")!;
    const first = createId(),
      second = createId(),
      assetId = createId();
    const content = highlighted("Requested passage");
    const mark = analyzeDocument(content).highlights[0];
    receive({
      sessionId: first,
      command: {
        type: "init",
        content,
        images: {
          [assetId]: `file:///app/siftnote-images/${assetId}.jpg`,
        },
        fontScale: 1,
        target: { type: "highlight", id: mark.id },
      },
    });
    assert.deepEqual(positions, ["Requested passage"]);
    assert.equal(
      packets.filter((packet) => packet.event.type === "initialized").length,
      1,
    );
    const next: RichDocument = {
      type: "doc",
      content: [
        {
          type: "paragraph",
          content: [{ type: "text", text: "Current second note" }],
        },
        {
          type: "image",
          attrs: {
            assetId,
            src: `siftnote-image:${assetId}`,
            alt: "Note image",
          },
        },
      ],
    };
    receive({
      sessionId: second,
      command: {
        type: "init",
        content: next,
        images: {},
        fontScale: 1,
      },
    });
    assert.equal(dom.window.document.querySelector(".tiptap"), view);
    assert.equal(
      view.querySelector("img")!.getAttribute("src"),
      "",
      "Old note image registrations must not leak.",
    );
    assert.equal(view.querySelectorAll(".source-flash").length, 0);
    assert.equal(
      packets.filter((packet) => packet.event.type === "initialized").length,
      2,
    );
    const requestId = createId();
    receive({ sessionId: second, command: { type: "snapshot", requestId } });
    const result = packets.find(
      (packet) =>
        packet.event.type === "change" && packet.event.requestId === requestId,
    );
    assert.ok(result?.event.type === "change");
    assert.equal(result.event.version, 0);
    assert.deepEqual(result.event.content, next);
    assert.ok(
      !packets.some(
        (packet) =>
          packet.event.type === "dirty" || packet.event.type === "error",
      ),
    );
  } finally {
    dom.window.close();
  }
});

test("later font readiness for source scrolling cannot target a superseded note", async () => {
  const packets: EditorEventPacket[] = [];
  const scrolls: string[] = [];
  const dom = new JSDOM(editorTestPage(), {
    runScripts: "dangerously",
    beforeParse(window) {
      window.ReactNativeWebView = {
        postMessage: (raw: string) => packets.push(parseEventPacket(raw)),
      };
      window.Element.prototype.scrollIntoView = function () {
        scrolls.push(this.textContent ?? "");
      };
    },
  });
  try {
    let resolveFonts!: () => void;
    const fonts = {
      status: "loading",
      ready: new Promise<void>((resolve) => {
        resolveFonts = resolve;
      }),
    };
    Object.defineProperty(dom.window.document, "fonts", { value: fonts });
    const first = createId(),
      second = createId();
    const receive = dom.window.siftNoteReceive!;
    receive({
      sessionId: first,
      command: {
        type: "init",
        content: plainDocument("Old passage"),
        images: {},
        fontScale: 1,
        target: { type: "search", query: "Old passage" },
      },
    });
    assert.equal(
      packets.filter((packet) => packet.event.type === "initialized").length,
      1,
    );
    fonts.status = "loaded";
    receive({
      sessionId: second,
      command: {
        type: "init",
        content: plainDocument("Current note"),
        images: {},
        fontScale: 1,
      },
    });
    resolveFonts();
    await fonts.ready;
    assert.deepEqual(scrolls, []);
    assert.equal(
      packets.filter((packet) => packet.event.type === "initialized").length,
      2,
    );
    assert.equal(
      packets.findLast((packet) => packet.event.type === "initialized")!
        .sessionId,
      second,
    );
    assert.equal(
      dom.window.document.querySelector(".tiptap p")!.textContent,
      "Current note",
    );
    assert.ok(!packets.some((packet) => packet.event.type === "error"));
  } finally {
    dom.window.close();
  }
});

test("the generated offline HTML initializes without a reveal command or changing content and undo history", async () => {
  const events: EditorEvent[] = [];
  const dom = new JSDOM(editorTestPage(), {
    runScripts: "dangerously",
    pretendToBeVisual: true,
    url: `file:///app/siftnote-editor/${EDITOR_ENTRY}`,
    beforeParse(window) {
      window.ReactNativeWebView = {
        postMessage: (raw: string) => events.push(parseEventPacket(raw).event),
      };
    },
  });
  try {
    assert.equal(events[0]?.type, "ready");
    const document = dom.window.document;
    const policy = document
      .querySelector('meta[http-equiv="Content-Security-Policy"]')
      ?.getAttribute("content");
    assert.ok(policy?.includes("connect-src 'none'"));
    assert.ok(policy?.includes("default-src 'none'"));
    assert.equal(
      document.querySelectorAll("script[src], link[href]").length,
      0,
    );
    assert.ok(policy?.includes("font-src file:"));
    const receive = dom.window.siftNoteReceive;
    assert.ok(receive);
    const content = highlighted("Offline passage");
    const sessionId = createId();
    receive({
      sessionId,
      command: {
        type: "init",
        content,
        images: {},
        fontScale: 1.3,
      },
    });
    assert.equal(
      events.filter((event) => event.type === "initialized").length,
      1,
    );
    assert.ok(
      !events.some(
        (event) => event.type === "change" || event.type === "dirty",
      ),
    );
    const host = document.querySelector<HTMLElement>("#editor")!;
    assert.equal(host.textContent, "Offline passage");
    assert.notEqual(dom.window.getComputedStyle(host).opacity, "0");
    assert.ok(
      !events.some(
        (event) => event.type === "change" || event.type === "dirty",
      ),
    );
    const selection = events.findLast((event) => event.type === "selection");
    assert.ok(selection?.type === "selection" && !selection.state.canUndo);
    const requestId = createId();
    receive({ sessionId, command: { type: "snapshot", requestId } });
    const result = events.find(
      (event) => event.type === "change" && event.requestId === requestId,
    );
    assert.equal(result?.type, "change");
    if (result?.type === "change") {
      assert.equal(result.version, 0);
      assert.deepEqual(result.content, content);
      assert.equal(
        analyzeDocument(result.content).highlights[0].text,
        "Offline passage",
      );
    }
    assert.equal(
      document.querySelector<HTMLElement>(".tiptap")?.style.fontSize,
      "20.8px",
    );
    assert.ok(!events.some((event) => event.type === "error"));
  } finally {
    dom.window.close();
  }
});
