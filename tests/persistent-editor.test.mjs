import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { resolve } from "node:path";
import { test } from "node:test";
import { runInNewContext } from "node:vm";
import { JSDOM } from "jsdom";
import { transpileModule, ModuleKind, JsxEmit } from "typescript";
import { repository } from "./sqlite-fixture";
import * as documentModel from "../src/domain/document";
import * as bridge from "../src/editor/bridge";
import { Autosave } from "../src/persistence/autosave";
import {
  flushBeforeBack,
  flushEditorChanges,
} from "../src/features/notes/flush-editor";
import * as perf from "../src/dev/perf";
import {
  EDITOR_HTML,
  EDITOR_FILES,
  EDITOR_ENTRY,
} from "../src/editor/generated/html";

test("temporary native placeholder opens documents without mounting WebView or emitting edits", async () => {
  const require = createRequire(resolve("package.json"));
  const React = require("react");
  const { createRoot } = require("react-dom/client");
  const host = new JSDOM("<div id='root'></div>");
  const globals = new Map();
  for (const [name, value] of Object.entries({
    window: host.window,
    document: host.window.document,
    IS_REACT_ACT_ENVIRONMENT: true,
  })) {
    globals.set(name, Object.getOwnPropertyDescriptor(globalThis, name));
    Object.defineProperty(globalThis, name, {
      value,
      writable: true,
      configurable: true,
    });
  }
  const root = createRoot(host.window.document.getElementById("root"));
  const exports = {};
  runInNewContext(
    transpileModule(
      readFileSync(resolve("src/editor/rich-editor.tsx"), "utf8"),
      {
        compilerOptions: { module: ModuleKind.CommonJS, jsx: JsxEmit.ReactJSX },
      },
    ).outputText,
    {
      exports,
      require: (name) => {
        if (name === "react" || name === "react/jsx-runtime")
          return require(name);
        if (name === "../dev/perf") return { ...perf, DEBUG_NO_WEBVIEW: true };
        if (name === "react-native") return { View: "div" };
        if (name === "react-native-webview")
          return {
            WebView: () => assert.fail("No WebView in diagnostic mode"),
          };
        return {};
      },
    },
  );
  const ref = React.createRef();
  let acknowledged = 0;
  let edits = 0;
  const content = documentModel.plainDocument("Retained canonical document");
  const props = {
    ref,
    runtime: { uri: "unused" },
    initialDocument: content,
    images: {},
    onReady: () => acknowledged++,
    onDocument: () => edits++,
    onDirty: () => edits++,
  };
  try {
    await React.act(async () =>
      root.render(
        React.createElement(exports.RichEditor, {
          ...props,
          documentId: "first",
        }),
      ),
    );
    await ref.current.waitUntilReady();
    await ref.current.snapshot();
    await React.act(async () =>
      root.render(
        React.createElement(exports.RichEditor, {
          ...props,
          documentId: "second",
        }),
      ),
    );
    await ref.current.snapshot();
    assert.equal(
      acknowledged,
      2,
      "Each opening must finish without waiting for a nonexistent browser",
    );
    assert.equal(
      edits,
      0,
      "The placeholder must never overwrite the real document with an empty one",
    );
    assert.equal(
      documentModel.analyzeDocument(content).text,
      "Retained canonical document",
    );
  } finally {
    await React.act(async () => root.unmount());
    host.window.close();
    for (const [name, descriptor] of globals) {
      if (descriptor) Object.defineProperty(globalThis, name, descriptor);
      else delete globalThis[name];
    }
  }
});

// Real React screens, bundled Tiptap and SQLite; native surfaces/device events
// are adapted. These checks cannot establish Android compositor performance.
for (const nativeOnly of [false, true])
  test(`pushed note lifecycle prepares after commit and retains browsing (${nativeOnly ? "no WebView" : "WebView"})`, async () => {
    const require = createRequire(resolve("package.json"));
    const React = require("react");
    const { createRoot } = require("react-dom/client");
    const { act, createElement: element } = React;
    const host = new JSDOM("<div id='root'></div>", {
      pretendToBeVisual: true,
    });
    const globals = new Map();
    for (const [name, value] of Object.entries({
      window: host.window,
      document: host.window.document,
      navigator: host.window.navigator,
      IS_REACT_ACT_ENVIRONMENT: true,
    })) {
      globals.set(name, Object.getOwnPropertyDescriptor(globalThis, name));
      Object.defineProperty(globalThis, name, {
        value,
        writable: true,
        configurable: true,
      });
    }
    const { db, repo } = await repository();
    const root = createRoot(host.window.document.getElementById("root"));
    const logs = [];
    const diagnostic = {
      ...perf,
      DEBUG_NO_WEBVIEW: nativeOnly,
      perfMark: (name) => logs.push(name),
    };
    const frames = new Map();
    let frameId = 0;
    const runFrames = () => {
      const callbacks = [...frames.values()];
      frames.clear();
      for (const callback of callbacks) callback(0);
    };
    function load(file, adapters) {
      const exports = {};
      runInNewContext(
        transpileModule(readFileSync(resolve(file), "utf8"), {
          compilerOptions: {
            module: ModuleKind.CommonJS,
            jsx: JsxEmit.ReactJSX,
          },
        }).outputText,
        {
          exports,
          __DEV__: true,
          setTimeout,
          clearTimeout,
          Promise,
          Error,
          console,
          requestAnimationFrame: (callback) => {
            frames.set(++frameId, callback);
            return frameId;
          },
          cancelAnimationFrame: (id) => frames.delete(id),
          require: (name) => {
            if (name.endsWith("/dev/perf")) return diagnostic;
            if (name === "react" || name === "react/jsx-runtime")
              return require(name);
            if (Object.hasOwn(adapters, name)) return adapters[name];
            throw new Error(`Missing adapter ${file}: ${name}`);
          },
        },
      );
      return exports;
    }
    const runtime = load("src/editor/runtime.ts", {
      "expo-file-system": { Directory: class {}, Paths: { cache: "unused" } },
      "./generated/html": { EDITOR_HTML, EDITOR_FILES, EDITOR_ENTRY },
    });
    const script = EDITOR_FILES.find((file) => file.name.endsWith(".js"));
    let browser, webviewProps, titleProps, menuProps, removal, RootLayout;
    let routePresent = false,
      pathname = "/",
      params = {},
      routeKey = 0;
    let mounts = 0,
      unmounts = 0,
      loads = 0,
      guardCalls = 0,
      keyboardVisible = false;
    let holdSnapshot = false,
      deleteConfirmation;
    let titleRenders = 0;
    const errors = [],
      packets = [],
      commands = [],
      scrolled = [],
      backHandlers = new Set(),
      appHandlers = new Set();
    let closing = false,
      refreshPending = false,
      stackProps;
    const app = {
      repo,
      revision: 0,
      beginNoteClose: () => {
        closing = true;
      },
      endNoteClose: () => {
        closing = false;
        if (refreshPending) {
          refreshPending = false;
          app.refresh();
        }
      },
      refresh: () => {
        if (closing) {
          refreshPending = true;
          return;
        }
        app.revision++;
        render();
      },
      toast: (message) => errors.push(message),
    };
    const render = () => root.render(element(RootLayout));
    const commitPop = () => {
      routePresent = false;
      params = {};
      render();
    };
    const navigation = {
      dispatch: (action) => {
        assert.equal(action.type, "POP");
        commitPop();
      },
      addListener: () => assert.fail("Editor must not wait for transitionEnd"),
    };
    const router = {
      canGoBack: () => routePresent,
      push: (href) => {
        assert.equal(href.pathname, "/note/[id]");
        params = href.params;
        routeKey++;
        routePresent = true;
        render();
      },
      back: () => {
        if (removal?.enabled) {
          guardCalls++;
          removal.callback({ data: { action: { type: "POP" } } });
        } else commitPop();
      },
      replace: () => commitPop(),
      navigate: () => {
        pathname = "/";
        render();
      },
    };
    const View = ({ children, onPress, accessibilityLabel, style }) =>
      element(
        "div",
        {
          "aria-label": accessibilityLabel,
          onClick: onPress,
          "data-opacity": style?.opacity,
        },
        children,
      );
    const native = {
      View,
      Pressable: View,
      ScrollView: View,
      FlatList: () => null,
      useWindowDimensions: () => ({ width: 400, height: 800, fontScale: 1 }),
      Alert: {
        alert: (_title, _message, buttons) => {
          deleteConfirmation = buttons.find(
            (button) => button.text === "Delete",
          ).onPress;
        },
      },
      Keyboard: {
        isVisible: () => keyboardVisible,
        dismiss: () => {
          keyboardVisible = false;
        },
      },
      BackHandler: {
        exitApp: () => {},
        addEventListener: (_event, callback) => {
          backHandlers.add(callback);
          return { remove: () => backHandlers.delete(callback) };
        },
      },
      AppState: {
        currentState: "active",
        addEventListener: (_event, callback) => {
          appHandlers.add(callback);
          return { remove: () => appHandlers.delete(callback) };
        },
      },
    };
    const primitives = {
      colors: { background: "#F9FAFB", field: "#F3F4F6" },
      fontFamilies: {},
      AppText: View,
      EmptyState: () => null,
      LoadingState: () => null,
      AppInput: (props) => {
        if (props.accessibilityLabel === "Note title") {
          titleProps = props;
          titleRenders++;
        }
        return element("textarea", {
          "aria-label": props.accessibilityLabel,
          value: props.value,
          readOnly: true,
          disabled: props.editable === false,
        });
      },
      ErrorState: ({ message }) => {
        errors.push(message);
        return null;
      },
      IconButton: ({ label, onPress }) =>
        element("button", { "aria-label": label, onClick: onPress }),
    };
    const WebView = React.forwardRef(function WebView(props, ref) {
      webviewProps = props;
      React.useImperativeHandle(ref, () => ({
        injectJavaScript: (code) => {
          const packet = JSON.parse(
            code.slice(
              code.indexOf("siftNoteReceive(") + 16,
              code.lastIndexOf(");true;"),
            ),
          );
          commands.push(packet);
          if (holdSnapshot && packet.command.type === "snapshot") return;
          browser.window.eval(code);
        },
      }));
      React.useEffect(() => {
        mounts++;
        return () => {
          unmounts++;
          browser?.window.close();
        };
      }, []);
      React.useEffect(() => {
        if (!props.source) return;
        loads++;
        props.onLoadStart();
        const html = props.source.html.replace(
          `<script src="${script.name}"></script>`,
          () =>
            `<script>${script.contents.replace(/<\/script/gi, "<\\/script")}</script>`,
        );
        const propsForSession = props;
        browser = new JSDOM(html, {
          runScripts: "dangerously",
          pretendToBeVisual: true,
          beforeParse(window) {
            window.Element.prototype.scrollIntoView = function () {
              scrolled.push(this);
            };
            window.scrollTo = () => {};
            window.Range.prototype.getClientRects = () => [];
            window.Range.prototype.getBoundingClientRect = () => ({
              left: 0,
              right: 0,
              top: 0,
              bottom: 0,
            });
            window.document.elementFromPoint = () => null;
            window.ReactNativeWebView = {
              postMessage: (raw) => {
                packets.push(bridge.parseEventPacket(raw));
                queueMicrotask(() =>
                  propsForSession.onMessage({ nativeEvent: { data: raw } }),
                );
              },
            };
          },
        });
        props.onLoadEnd();
      }, [props.source]);
      return element("div", { "data-webview": true });
    });
    const prepared = load("src/features/notes/prepared-note.ts", {
      "expo-file-system": {},
      "../../domain/document": documentModel,
      "../../editor/runtime": {},
      "../../persistence/images": {},
    });
    prepared.loadNoteForOpening = async (_repo, source) => {
      const note =
        typeof source === "string" ? await repo.getNote(source) : source;
      return note
        ? {
            note,
            openingId: documentModel.createId(),
            images: {},
            missingImage: false,
            runtime: { uri: "file:///app/editor.html" },
          }
        : null;
    };
    const shared = load("src/features/notes/shared.tsx", {
      "@expo/vector-icons/Feather": () => null,
      "expo-router": {
        router,
        usePathname: () => {
          throw new Error(
            "Opening must not subscribe to global pathname changes",
          );
        },
      },
      "react-native": native,
      "react-native-gesture-handler/ReanimatedSwipeable": {},
      "../../components/ui/primitives": primitives,
      "../../domain/document": documentModel,
      "../../persistence/images": {},
      "../../persistence/repository": {},
      "../../state/app-context": { useApp: () => app },
      "./prepared-note": prepared,
    });
    const autosave = load("src/persistence/use-autosave.ts", {
      "./autosave": { Autosave },
    });
    const rich = load("src/editor/rich-editor.tsx", {
      "react-native": native,
      "react-native-webview": { WebView },
      "../components/ui/primitives": primitives,
      "../domain/document": documentModel,
      "./bridge": bridge,
      "./runtime": runtime,
    });
    const safeArea = { useSafeAreaInsets: () => ({ top: 0, bottom: 0 }) };
    const screen = load("src/features/notes/editor-screen.tsx", {
      "@expo/vector-icons/Feather": () => null,
      "expo-router": {
        router,
        useLocalSearchParams: () => params,
        useNavigation: () => navigation,
        useIsFocused: () => true,
      },
      "expo-router/react-navigation": {
        usePreventRemove: (enabled, callback) => {
          // Model Router's registration update in the subscribing component.
          const [, setRegistered] = React.useState(false);
          removal = { enabled, callback };
          React.useEffect(() => setRegistered(true), []);
          React.useEffect(
            () => () => {
              removal = undefined;
            },
            [],
          );
        },
      },
      "react-native": native,
      "react-native-safe-area-context": safeArea,
      "../../components/ui/primitives": primitives,
      "../../domain/document": documentModel,
      "../../editor/bridge": bridge,
      "../../editor/rich-editor": rich,
      "./prepared-note": prepared,
      "../../persistence/use-autosave": autosave,
      "../../persistence/images": { cleanImages: async () => {} },
      "../../state/app-context": { useApp: () => app },
      "./shared": shared,
      "./flush-editor": { flushEditorChanges, flushBeforeBack },
      "./editor-controls": {
        EditorMenu: (props) => {
          menuProps = props;
          return null;
        },
        EditorToolbar: () => null,
      },
    });
    const notes = load("src/features/notes/notes-screen.tsx", {
      "@expo/vector-icons/Feather": () => null,
      "react-native": native,
      "react-native-safe-area-context": safeArea,
      "../../components/ui/primitives": primitives,
      "../../state/app-context": { useApp: () => app },
      "./shared": shared,
    });
    const tabs = load("src/app/(tabs)/_layout.tsx", {
      "@expo/vector-icons/Feather": () => null,
      "expo-router": {
        router,
        usePathname: () => pathname,
        useFocusEffect: (callback) =>
          React.useEffect(
            () => (routePresent ? undefined : callback()),
            [callback, routePresent],
          ),
      },
      "react-native": native,
      "expo-router/js-tabs": {
        Tabs: Object.assign(() => element(notes.NotesScreen), {
          Screen: () => null,
        }),
      },
      "../../components/ui/primitives": primitives,
    });
    const options = [];
    const Stack = Object.assign(
      (props) => {
        stackProps = props;
        options.push(props.screenOptions);
        React.Children.forEach(props.children, (child) =>
          options.push(child.props.options ?? {}),
        );
        return element(
          React.Fragment,
          null,
          element(tabs.default, { key: "tabs" }),
          routePresent ? element(screen.EditorScreen, { key: routeKey }) : null,
        );
      },
      { Screen: () => null },
    );
    const adapters = {
      "../global.css": {},
      "@expo/vector-icons/Feather": Object.assign(() => null, { font: {} }),
      "expo-font": { useFonts: () => [true] },
      "expo-router": { Stack },
      "expo-splash-screen": {
        preventAutoHideAsync: async () => {},
        hideAsync: async () => {},
      },
      "expo-status-bar": { StatusBar: () => null },
      "react-native-gesture-handler": { GestureHandlerRootView: View },
      "react-native-safe-area-context": { SafeAreaProvider: View },
      "../components/ui/primitives": primitives,
      "../state/app-context": { AppProvider: View, useApp: () => app },
    };
    for (const font of ["400Regular", "500Medium", "600SemiBold", "700Bold"])
      adapters[`@expo-google-fonts/inter/${font}/Inter_${font}.ttf`] = {};
    RootLayout = load("src/app/_layout.tsx", adapters).default;
    const settle = async (ms = 40) =>
      act(async () => {
        await new Promise((resolve) => setTimeout(resolve, ms));
      });
    const open = async (note, highlightId) => {
      await act(async () => {
        void shared.openNote(repo, note, highlightId);
      });
      // No document load/WebView work runs until the destination commits.
      await act(async () => runFrames());
      await settle();
    };
    const body = () => browser.window.document.querySelector(".tiptap");
    const type = async (text) => {
      await act(async () => {
        const node = body().querySelector("p:last-of-type").lastChild;
        node.nodeValue += text;
        body().dispatchEvent(
          new browser.window.Event("input", { bubbles: true }),
        );
        await new Promise((resolve) => setTimeout(resolve, 0));
      });
    };
    const back = async () => {
      await act(async () => {
        assert.equal([...backHandlers].at(-1)(), true);
      });
      await settle();
      if (!routePresent)
        await act(async () =>
          stackProps
            .screenListeners({ route: { name: "(tabs)" } })
            .transitionEnd({ data: { closing: false } }),
        );
    };
    try {
      const first = await repo.createNote();
      await repo.saveNote(
        first.id,
        { title: "First", content: documentModel.plainDocument("Alpha") },
        0,
      );
      const second = await repo.createNote();
      const highlightId = documentModel.createId();
      const highlighted = documentModel.plainDocument("Beta source");
      highlighted.content[0].content[0].marks = [
        {
          type: "highlight",
          attrs: { id: highlightId, color: "purple", createdAt: Date.now() },
        },
      ];
      await repo.saveNote(
        second.id,
        { title: "Second", content: highlighted },
        0,
      );
      await act(async () => render());
      await settle();
      assert.equal(mounts, 0, "No retained editor below browsing");
      const loadNormally = prepared.loadNoteForOpening;
      let prepares = 0;
      prepared.loadNoteForOpening = (...args) => {
        prepares++;
        return loadNormally(...args);
      };
      await act(async () => {
        void shared.openNote(repo, { id: first.id, title: "First" });
      });
      assert.equal(
        prepares,
        0,
        "Tap/first commit must not perform preparation",
      );
      const titleNode = host.window.document.querySelector(
        '[aria-label="Note title"]',
      );
      const earlyHost = host.window.document.querySelector("[data-webview]");
      assert.equal(titleNode.value, "First");
      assert.equal(titleNode.disabled, true);
      assert.equal(
        mounts,
        nativeOnly ? 0 : 1,
        "Native host mounts with the screen",
      );
      assert.equal(loads, 0, "No empty editor document is loaded");
      assert.equal(webviewProps?.source, undefined);
      await act(async () => router.back());
      await act(async () => runFrames());
      assert.equal(prepares, 0, "Immediate Back cancels queued preparation");
      await act(async () =>
        stackProps
          .screenListeners({ route: { name: "(tabs)" } })
          .transitionEnd({ data: { closing: false } }),
      );
      if (nativeOnly) {
        await open(first.id);
        assert.equal(mounts, 0);
        assert.ok(logs.includes("nativePlaceholder.mount"));
        await back();
        assert.equal(guardCalls, 0);
        await open(first.id);
        await act(async () => titleProps.onChangeText("Native baseline edit"));
        await back();
        assert.equal(
          (await repo.getNote(first.id)).title,
          "Native baseline edit",
        );
        assert.equal(guardCalls, 1);
        assert.equal(mounts, 0, "Open/Back mode never mounts a WebView");
        assert.equal(logs.filter((name) => name === "notes.mount").length, 1);
        return;
      }
      // A document resolving after Back must not revive the popped screen.
      let finishLate;
      const lateDocument = new Promise((resolve) => {
        finishLate = resolve;
      });
      prepared.loadNoteForOpening = () => lateDocument;
      await act(async () => {
        void shared.openNote(repo, first.id);
      });
      await act(async () => runFrames());
      await back();
      await act(async () => finishLate(await loadNormally(repo, first.id)));
      assert.equal(routePresent, false);
      assert.equal(loads, 0);
      prepared.loadNoteForOpening = loadNormally;

      // Missing notes close cleanly without initializing a browser document.
      await open(documentModel.createId());
      assert.equal(routePresent, false);
      assert.equal(loads, 0);
      assert.match(errors.pop(), /deleted/);

      const abandonedMounts = mounts;
      const beforeTitleRenders = titleRenders;
      await act(async () => {
        void shared.openNote(repo, { id: first.id, title: "First" });
      });
      const stableTitle = host.window.document.querySelector(
        '[aria-label="Note title"]',
      );
      const stableHost = host.window.document.querySelector("[data-webview]");
      assert.notEqual(stableTitle, titleNode);
      assert.notEqual(stableHost, earlyHost);
      await act(async () => runFrames());
      await settle();
      assert.equal(
        host.window.document.querySelector('[aria-label="Note title"]'),
        stableTitle,
      );
      assert.equal(stableTitle.disabled, false);
      assert.equal(
        host.window.document.querySelector("[data-webview]"),
        stableHost,
      );
      assert.equal(
        mounts,
        abandonedMounts + 1,
        "Hydration does not remount the host",
      );
      assert.equal(loads, 1, "Only the actual note startup HTML is loaded");
      assert.equal(
        titleRenders,
        beforeTitleRenders + 2,
        "The header renders on mount and hydration, not guard registration/readiness",
      );
      const beforeDuplicateSelection = logs.filter(
        (event) => event === "noteSession.render.start",
      ).length;
      const lastSelection = packets.findLast(
        (packet) => packet.event.type === "selection",
      );
      await act(async () =>
        webviewProps.onMessage({
          nativeEvent: { data: JSON.stringify(lastSelection) },
        }),
      );
      assert.equal(
        logs.filter((event) => event === "noteSession.render.start").length,
        beforeDuplicateSelection,
        "Identical selection packets do not reconcile the screen",
      );
      assert.equal(
        body().textContent,
        "Alpha",
        "Startup HTML contains the actual note",
      );
      assert.equal(
        webviewProps.style.backgroundColor,
        primitives.colors.background,
      );
      assert.equal(webviewProps.style.opacity, undefined);
      assert.equal(
        browser.window.document.documentElement.style.getPropertyValue(
          "--siftnote-background",
        ),
        primitives.colors.background,
      );
      assert.ok(
        webviewProps.source.html.includes(
          "html,body{margin:0;background:var(--siftnote-background,#fff)",
        ),
      );
      assert.ok(
        options.every(
          (value) =>
            value.animation === undefined && value.presentation === undefined,
        ),
      );
      assert.equal(
        host.window.document.querySelector('[aria-label="Opening note"]'),
        null,
      );
      const beforeClean = commands.filter(
        ({ command }) => command.type === "snapshot",
      ).length;
      await back();
      assert.equal(routePresent, false);
      assert.equal(guardCalls, 0, "Clean note pops without entering the guard");
      assert.equal(
        commands.filter(({ command }) => command.type === "snapshot").length,
        beforeClean,
      );
      assert.equal(unmounts, abandonedMounts + 1);
      await open(first.id);
      assert.equal(
        mounts,
        abandonedMounts + 2,
        "Reopening creates a per-screen session",
      );
      await type(" pending");
      await act(async () => titleProps.onChangeText("First edited"));
      keyboardVisible = true;
      await back();
      assert.equal(
        routePresent,
        true,
        "Keyboard Back dismisses keyboard first",
      );
      await back();
      assert.equal(routePresent, false);
      assert.equal(guardCalls, 1);
      assert.equal((await repo.getNote(first.id)).title, "First edited");
      assert.match(
        documentModel.analyzeDocument((await repo.getNote(first.id)).content)
          .text,
        /Alpha pending/,
      );
      await open(first.id);
      assert.match(body().textContent, /Alpha pending/);
      await type(" background");
      await act(async () => {
        native.AppState.currentState = "background";
        for (const handler of appHandlers) handler("background");
      });
      await settle();
      assert.match(
        documentModel.analyzeDocument((await repo.getNote(first.id)).content)
          .text,
        /background/,
      );
      native.AppState.currentState = "active";
      await back();
      pathname = "/highlights";
      await open(second.id, highlightId);
      assert.equal(body().textContent, "Beta source");
      assert.equal(
        body()
          .querySelector("[data-highlight-id]")
          .getAttribute("data-highlight-id"),
        highlightId,
      );
      assert.equal(
        packets.filter((packet) => packet.event.type === "selection").at(-1)
          .event.state.canUndo,
        false,
      );
      assert.equal(scrolled.at(-1)?.textContent, "Beta source");
      await type(" edited");
      await back();
      assert.equal(pathname, "/highlights");
      assert.doesNotMatch(
        documentModel.analyzeDocument((await repo.getNote(first.id)).content)
          .text,
        /Beta/,
      );
      assert.equal(
        (await repo.listHighlights({ noteId: second.id }))[0].id,
        highlightId,
      );
      await open(first.id);
      // Preserve a received document and a newer title when the browser is silent.
      await type(" received");
      await settle(220);
      await act(async () => titleProps.onChangeText("Timeout title"));
      holdSnapshot = true;
      await act(async () => router.back());
      assert.equal(
        routePresent,
        true,
        "Dirty pop waits briefly for a snapshot",
      );
      await settle(340);
      assert.equal(routePresent, false, "Silent WebView cannot hang Back");
      holdSnapshot = false;
      assert.equal((await repo.getNote(first.id)).title, "Timeout title");
      assert.match(
        documentModel.analyzeDocument((await repo.getNote(first.id)).content)
          .text,
        /received/,
      );
      assert.ok(logs.includes("back.guard.timeout"));
      await open(first.id);
      assert.match(body().textContent, /received/);
      // Delete is allowed to pop even when the guard was enabled by pending edits.
      await act(async () => titleProps.onChangeText("Delete pending"));
      const originalDelete = repo.deleteNote.bind(repo);
      const deletedAfterPop = [];
      repo.deleteNote = async (id) => {
        deletedAfterPop.push(!routePresent);
        await originalDelete(id);
      };
      await act(async () => {
        menuProps.remove();
        deleteConfirmation();
      });
      await settle();
      assert.deepEqual(deletedAfterPop, [true]);
      assert.equal(await repo.getNote(first.id), null);
      assert.equal(routePresent, false);
      assert.deepEqual(errors, ["Note deleted"]);
      errors.length = 0;

      // Creation follows the same first-frame host path; no placeholder draft
      // may be saved under the route's temporary "new" identifier.
      const createNormally = repo.createNote.bind(repo);
      let created;
      repo.createNote = async () => {
        created = await createNormally();
        return created;
      };
      await act(async () =>
        host.window.document
          .querySelector('[aria-label="Create note"]')
          .click(),
      );
      assert.equal(routePresent, true);
      assert.equal(created, undefined, "Creation never precedes navigation");
      assert.equal(webviewProps.source, undefined);
      assert.equal(titleProps.editable, false);
      await act(async () => runFrames());
      await settle();
      assert.equal(body().textContent, "");
      await act(async () => titleProps.onChangeText("Created and saved"));
      await back();
      assert.equal((await repo.getNote(created.id)).title, "Created and saved");
      assert.deepEqual(errors, ["Note created"]);
      assert.equal(logs.filter((name) => name === "notes.mount").length, 1);
      assert.equal(logs.filter((name) => name === "notes.unmount").length, 0);
      assert.equal(loads, mounts - abandonedMounts);
      assert.equal(unmounts, mounts);
    } finally {
      await act(async () => root.unmount());
      host.window.close();
      db.native.close();
      for (const [name, descriptor] of globals) {
        if (descriptor) Object.defineProperty(globalThis, name, descriptor);
        else delete globalThis[name];
      }
    }
  });

test("temporary Back guard persists the latest browser snapshot before returning", async () => {
  const { db, repo } = await repository();
  const note = await repo.createNote();
  let revision = note.revision;
  const errors = [];
  const saver = new Autosave(
    async (draft) => {
      revision = await repo.saveNote(note.id, draft, revision);
    },
    () => {},
    60000,
  );
  try {
    saver.schedule({
      title: "Edited",
      content: documentModel.plainDocument("Received"),
    });
    await flushBeforeBack(
      saver,
      async () => {
        saver.schedule({
          title: "Edited",
          content: documentModel.plainDocument("Latest browser snapshot"),
        });
      },
      (error) => errors.push(error),
      () => assert.fail("Responsive snapshot must not time out"),
    );
    assert.equal(
      documentModel.analyzeDocument((await repo.getNote(note.id)).content).text,
      "Latest browser snapshot",
    );
    assert.deepEqual(errors, []);
    assert.equal(saver.dirty, false);
  } finally {
    await saver.stop();
    db.native.close();
  }
});

test("temporary Back deadline permits pop while a pending revision-protected write continues", async () => {
  const { db, repo } = await repository();
  const note = await repo.createNote();
  let finish;
  const barrier = new Promise((resolve) => {
    finish = resolve;
  });
  const errors = [];
  let timeouts = 0;
  let writes = 0;
  const saver = new Autosave(
    async (draft) => {
      writes++;
      await barrier;
      await repo.saveNote(note.id, draft, note.revision);
    },
    () => {},
    60000,
  );
  try {
    saver.schedule({
      title: "Leaving",
      content: documentModel.plainDocument("Last known RN document"),
    });
    await flushBeforeBack(
      saver,
      async () => {},
      (error) => errors.push(error),
      () => {
        timeouts++;
      },
    );
    assert.equal(
      timeouts,
      1,
      "Back is bounded even if SQLite has not completed",
    );
    assert.equal(saver.dirty, true);
    finish();
    await saver.flush();
    assert.equal(
      writes,
      1,
      "Fallback must not write the same revision concurrently",
    );
    assert.equal(
      documentModel.analyzeDocument((await repo.getNote(note.id)).content).text,
      "Last known RN document",
    );
    assert.deepEqual(errors, []);
  } finally {
    finish();
    await saver.stop();
    db.native.close();
  }
});

test("list invalidations coalesce until closing finishes, then late writes refresh normally", async () => {
  const require = createRequire(resolve("package.json"));
  const React = require("react");
  const { createRoot } = require("react-dom/client");
  const host = new JSDOM("<div id='root'></div>");
  const globals = new Map();
  for (const [name, value] of Object.entries({
    window: host.window,
    document: host.window.document,
    IS_REACT_ACT_ENVIRONMENT: true,
  })) {
    globals.set(name, Object.getOwnPropertyDescriptor(globalThis, name));
    Object.defineProperty(globalThis, name, {
      value,
      writable: true,
      configurable: true,
    });
  }
  const root = createRoot(host.window.document.getElementById("root"));
  const exports = {};
  const logs = [];
  const adapters = {
    "expo-sqlite": { openDatabaseAsync: async () => ({}) },
    "react-native": { View: "div", Pressable: "button" },
    "react-native-safe-area-context": {
      useSafeAreaInsets: () => ({ bottom: 0 }),
    },
    "../components/ui/primitives": {
      LoadingState: () => null,
      ErrorState: () => null,
    },
    "../persistence/images": { cleanImages: async () => {} },
    "../persistence/repository": {
      migrateDatabase: async () => {},
      NoteRepository: class {},
    },
    "../editor/runtime": { prepareEditorRuntime: async () => ({}) },
    "../dev/perf": { perfMark: (name) => logs.push(name) },
  };
  runInNewContext(
    transpileModule(
      readFileSync(resolve("src/state/app-context.tsx"), "utf8"),
      {
        compilerOptions: { module: ModuleKind.CommonJS, jsx: JsxEmit.ReactJSX },
      },
    ).outputText,
    {
      exports,
      setTimeout,
      clearTimeout,
      require: (name) =>
        name === "react" || name === "react/jsx-runtime"
          ? require(name)
          : adapters[name],
    },
  );
  let app;
  const Probe = () => {
    app = exports.useApp();
    return null;
  };
  try {
    await React.act(async () =>
      root.render(
        React.createElement(
          exports.AppProvider,
          null,
          React.createElement(Probe),
        ),
      ),
    );
    await React.act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 0));
    });
    assert.equal(app.revision, 0);
    await React.act(async () => {
      app.beginNoteClose();
      app.refresh();
      app.refresh();
    });
    assert.equal(
      app.revision,
      0,
      "No provider/list render is triggered during the closing transition",
    );
    assert.equal(
      logs.filter((event) => event === "lists.refresh.commit").length,
      0,
    );
    await React.act(async () => app.endNoteClose());
    assert.equal(app.revision, 1, "Multiple saves need one list invalidation");
    await React.act(async () => {
      app.endNoteClose();
      app.refresh();
    });
    assert.equal(
      app.revision,
      2,
      "A write completing after the transition refreshes without getting stuck",
    );
  } finally {
    await React.act(async () => root.unmount());
    host.window.close();
    for (const [name, descriptor] of globals) {
      if (descriptor) Object.defineProperty(globalThis, name, descriptor);
      else delete globalThis[name];
    }
  }
});
