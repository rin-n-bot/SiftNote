import Feather from "@expo/vector-icons/Feather";
import {
  router,
  useLocalSearchParams,
  useNavigation,
  useIsFocused,
} from "expo-router";
import {
  usePreventRemove,
  type ParamListBase,
} from "expo-router/react-navigation";
import type { NativeStackNavigationProp } from "expo-router/native-stack";
import {
  Profiler,
  memo,
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import {
  AppState,
  BackHandler,
  FlatList,
  Keyboard,
  Pressable,
  ScrollView,
  View,
} from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import {
  AppInput,
  AppText,
  colors,
  EmptyState,
  IconButton,
} from "../../components/ui/primitives";
import {
  analyzeDocument,
  createId,
  emptyDocument,
  HIGHLIGHT_COLORS,
  HIGHLIGHT_PALETTE,
  validId,
  type HighlightColor,
  type RichDocument,
} from "../../domain/document";
import type { Highlight, NoteDraft } from "../../domain/types";
import {
  EMPTY_SELECTION,
  type EditorTarget,
  type Format,
  type SelectionState,
} from "../../editor/bridge";
import { RichEditor, type RichEditorHandle } from "../../editor/rich-editor";
import {
  currentPreparedNote,
  releasePreparedNote,
  loadNoteForOpening,
  type PreparedNote,
  type NoteOpening,
} from "./prepared-note";
import { useAutosave } from "../../persistence/use-autosave";
import { cleanImages, pickImage } from "../../persistence/images";
import { useApp } from "../../state/app-context";
import { confirmDelete, formatTime, HighlightRow, openNote } from "./shared";
import { flushBeforeBack, flushEditorChanges } from "./flush-editor";
import {
  perfMark,
  perfSync,
  perfStart,
  perfTrace,
  type PerfTrace,
} from "../../dev/perf";
import {
  EditorMenu,
  EditorToolbar,
  type EditorMenuKind,
} from "./editor-controls";

// Each pushed note owns one editor session; native Back destroys that session.
export function EditorScreen() {
  const {
    id,
    openingId,
    highlightId,
    query,
    title: openingTitle,
  } = useLocalSearchParams<{
    id: string;
    openingId?: string;
    highlightId?: string;
    query?: string;
    title?: string;
  }>();
  const [request] = useState(() => {
    const pending = currentPreparedNote();
    return pending?.openingId === openingId ? pending : undefined;
  });
  const [trace] = useState(() => request?.trace ?? perfTrace());
  perfMark("noteScreen.render.start", trace);
  const target: EditorTarget | undefined =
    highlightId && validId(highlightId)
      ? { type: "highlight", id: highlightId }
      : query && query.length <= 1000
        ? { type: "search", query }
        : undefined;
  useEffect(() => {
    perfMark("noteScreen.mount", trace);
    return () => perfMark("noteScreen.unmount", trace);
  }, [trace]);
  useLayoutEffect(() => {
    perfMark("noteScreen.commit", trace);
    return () => {
      perfMark("noteScreen.cleanup.start");
      perfMark("noteScreen.cleanup.end");
    };
  }, [trace]);
  const screen = (
    <NoteSession
      id={id}
      request={request}
      openingTitle={openingTitle}
      target={target}
      trace={trace}
    />
  );
  perfMark("noteScreen.render.end", trace);
  return __DEV__ ? (
    <Profiler
      id="note"
      onRender={(
        _id,
        phase,
        actualDuration,
        baseDuration,
        startTime,
        commitTime,
      ) => {
        perfMark("note.reactCommit", trace, {
          phase,
          actualDuration,
          baseDuration,
          startTime,
          commitTime,
        });
      }}
    >
      {screen}
    </Profiler>
  ) : (
    screen
  );
}
function NoteSession({
  id,
  request,
  openingTitle,
  target,
  trace,
}: {
  id: string;
  request?: NoteOpening;
  openingTitle?: string;
  target?: EditorTarget;
  trace?: PerfTrace;
}) {
  perfMark("noteSession.render.start", trace);
  const active = useIsFocused();
  const [prepared, setPrepared] = useState<PreparedNote>();
  const note = prepared?.note;
  const [session] = useState(() => ({ documentId: createId(), target, trace }));
  const runtime = prepared?.runtime;
  useEffect(() => {
    perfMark("noteSession.mount", session.trace);
    return () => perfMark("noteSession.unmount", session.trace);
  }, [session.trace]);
  const { repo, refresh, toast, beginNoteClose } = useApp();
  const insets = useSafeAreaInsets();
  const editor = useRef<RichEditorHandle>(null);
  const [content, setContent] = useState(emptyDocument);
  const draft = useRef<NoteDraft>({ title: openingTitle ?? "", content });
  const revision = useRef(0);
  const lastVersion = useRef(0);
  const ready = useRef(false);
  const bodyDirty = useRef(false);
  const latestDirtyVersion = useRef(0);
  const deleting = useRef(false);
  const mounted = useRef(true);
  const visible = useRef(active);
  useLayoutEffect(() => {
    visible.current = active;
  }, [active]);
  const lock = useRef(false);
  const [title, setTitle] = useState(openingTitle ?? "");
  const [pinned, setPinned] = useState(false);
  const [status, setStatus] = useState<"saving" | "saved" | "error">("saved");
  const [hasPendingEdits, setHasPendingEdits] = useState(false);
  const [saveError, setSaveError] = useState<string>();
  const [updated, setUpdated] = useState<number>();
  const analysis = useMemo(
    () =>
      perfSync(
        "noteSession.analysis",
        () => analyzeDocument(content),
        session.trace,
      ),
    [content, session.trace],
  );
  const review = useMemo(() => {
    const counts: Partial<Record<HighlightColor, number>> = {};
    const highlights: Highlight[] = analysis.highlights.map((highlight) => {
      counts[highlight.color] = (counts[highlight.color] ?? 0) + 1;
      return { ...highlight, noteId: note?.id ?? id, noteTitle: title };
    });
    return { highlights, counts };
  }, [analysis.highlights, note?.id, id, title]);
  const [selection, setSelection] = useState(EMPTY_SELECTION);
  // Compare bridge packets before scheduling state, including packets arriving
  // before React commits the previous selection update.
  const receivedSelection = useRef(EMPTY_SELECTION);
  const onSelection = useCallback((next: SelectionState) => {
    if (
      (Object.keys(next) as (keyof SelectionState)[]).every(
        (key) => next[key] === receivedSelection.current[key],
      )
    )
      return;
    receivedSelection.current = next;
    setSelection(next);
  }, []);
  const [mode, setMode] = useState<"full" | "highlights">("full");
  const [hasOpenedHighlights, setHasOpenedHighlights] = useState(false);
  const [menu, setMenu] = useState<EditorMenuKind>(null);
  const [rename, setRename] = useState(title);
  const [busy, setBusy] = useState(false);
  const [editorReady, setEditorReady] = useState(false);
  const [startupSlow, setStartupSlow] = useState(false);
  const [images, setImages] = useState<Record<string, string>>({});
  useEffect(() => {
    let cancelled = false;
    if (request) releasePreparedNote(request);
    perfMark("prepare.scheduled", trace);
    const frame = requestAnimationFrame(() => {
      if (cancelled) return;
      perfMark("prepare.frame", trace);
      const loading =
        request?.load() ??
        (validId(id)
          ? loadNoteForOpening(repo, id, trace)
          : Promise.resolve(null));
      void loading
        .then((value) => {
          if (cancelled) return;
          if (!value) throw new Error("This note may have been deleted.");
          perfMark("note.documentReady", trace);
          // Hydrate this screen in one update without replacing its native
          // title, controls or WebView host. Input remains disabled until here.
          draft.current = {
            title: value.note.title,
            content: value.note.content,
          };
          revision.current = value.note.revision;
          setTitle(value.note.title);
          setRename(value.note.title);
          setPinned(value.note.isPinned);
          setUpdated(value.note.updatedAt);
          setContent(value.note.content);
          setImages(value.images);
          setPrepared(value);
        })
        .catch((error: unknown) => {
          if (cancelled) return;
          toast(
            error instanceof Error
              ? error.message
              : "This note could not be opened.",
          );
          if (router.canGoBack()) router.back();
          else router.replace("/(tabs)");
        });
    });
    return () => {
      cancelled = true;
      cancelAnimationFrame(frame);
    };
  }, [repo, id, request, trace, toast]);
  useEffect(() => {
    if (!prepared || editorReady) return;
    const timer = setTimeout(() => setStartupSlow(true), 1000);
    return () => clearTimeout(timer);
  }, [prepared, editorReady]);
  const saveDraft = useCallback(
    async (value: NoteDraft) => {
      if (!note) throw new Error("No note is open.");
      perfMark("session.save.start");
      revision.current = await repo.saveNote(note.id, value, revision.current);
      perfMark("session.save.end");
      // Refresh lists when this session closes, rather than on every autosave.
      // A write completing after unmount still needs to invalidate their rows.
      if (mounted.current) setUpdated(Date.now());
      else refresh();
    },
    [repo, note, refresh],
  );
  const onSaveStatus = useCallback(
    (state: "saving" | "saved" | "error", error?: Error) => {
      if (mounted.current) {
        setHasPendingEdits(state !== "saved" || bodyDirty.current);
        setStatus(state === "saved" && bodyDirty.current ? "saving" : state);
        setSaveError(error?.message);
        if (error && !visible.current)
          toast(
            "A note could not be saved. Reopen it before closing SiftNote.",
          );
      } else if (error)
        toast("A note could not be saved. Reopen it before closing SiftNote.");
    },
    [toast],
  );
  const autosave = useAutosave(saveDraft, onSaveStatus);
  const onDocument = useCallback(
    (content: RichDocument, version: number) => {
      if (
        !note ||
        !mounted.current ||
        deleting.current ||
        version < lastVersion.current
      )
        return;
      if (version > lastVersion.current) {
        lastVersion.current = version;
        draft.current = { ...draft.current, content };
        bodyDirty.current = version < latestDirtyVersion.current;
        setContent(content);
        autosave.schedule({ ...draft.current });
      }
    },
    [autosave, note],
  );
  const flush = useCallback(async () => {
    if (!note || deleting.current) return;
    perfMark("session.flush.start");
    try {
      await flushEditorChanges(
        autosave,
        ready.current
          ? async () => {
              const currentEditor = editor.current;
              if (!currentEditor)
                throw new Error(
                  "The editor closed before its changes could be saved.",
                );
              await currentEditor.snapshot(lastVersion.current);
            }
          : undefined,
        bodyDirty.current,
      );
    } catch (error) {
      if (mounted.current) {
        setStatus("error");
        setSaveError(
          error instanceof Error
            ? error.message
            : "The note could not be saved.",
        );
      }
      throw error;
    } finally {
      perfMark("session.flush.end");
    }
  }, [autosave, note]);
  const run = useCallback(
    async (action: () => Promise<void>) => {
      if (lock.current) return;
      lock.current = true;
      setBusy(true);
      try {
        await action();
      } catch (error) {
        const message =
          error instanceof Error
            ? error.message
            : "This action could not be completed.";
        toast(message);
      } finally {
        lock.current = false;
        if (mounted.current) setBusy(false);
      }
    },
    [toast],
  );
  const leaving = useRef(false);
  const back = useCallback(() => {
    const trace = perfStart("back");
    perfMark("router.popNote.request", trace);
    router.back();
    beginNoteClose();
  }, [beginNoteClose]);
  // TEMPORARY: screen-owned autosave needs a bounded snapshot guard on dirty
  // notes. Clean notes use the normal native pop without any bridge round trip.
  const guardBack = (continueBack: () => void) => {
    if (deleting.current) {
      continueBack();
      return;
    }
    if (leaving.current) return;
    leaving.current = true;
    perfMark("back.guard.start");
    void flushBeforeBack(
      autosave,
      ready.current
        ? () => editor.current!.snapshot(lastVersion.current)
        : undefined,
      (error) => toast(error.message),
      () => {
        perfMark("back.guard.timeout");
        if (bodyDirty.current)
          toast(
            "The editor did not respond. Only the last received text could be saved.",
          );
      },
    ).then(() => {
      perfMark("back.guard.end");
      perfMark("router.popNote.dispatch");
      continueBack();
      beginNoteClose();
      refresh();
    });
  };
  useEffect(() => {
    if (!active) return;
    const subscription = BackHandler.addEventListener(
      "hardwareBackPress",
      () => {
        if (Keyboard.isVisible()) {
          Keyboard.dismiss();
          return true;
        }
        if (menu) {
          setMenu(null);
          return true;
        }
        if (mode === "highlights") {
          setMode("full");
          return true;
        }
        back();
        return true;
      },
    );
    return () => subscription.remove();
  }, [active, menu, mode, back]);
  useEffect(() => {
    if (active) return;
    editor.current?.send({ type: "blur" });
    Keyboard.dismiss();
  }, [active]);
  useEffect(() => {
    mounted.current = true;
    const subscription = AppState.addEventListener("change", (state) => {
      if (state !== "active")
        void flush().catch((error) => {
          if (!mounted.current) return;
          setSaveError(
            error instanceof Error
              ? error.message
              : "The note could not be saved.",
          );
          setStatus("error");
        });
    });
    return () => {
      perfMark("noteSession.cleanup.start");
      mounted.current = false;
      subscription.remove();
      if (note && revision.current !== note.revision) refresh();
      perfMark("noteSession.cleanup.end");
    };
  }, [autosave, flush, note, refresh]);
  const changeTitle = useCallback(
    (value: string) => {
      if (!note) return;
      setTitle(value);
      draft.current = { ...draft.current, title: value };
      autosave.schedule({ ...draft.current });
    },
    [note, autosave],
  );
  const format = (value: Format) => {
    setMenu(null);
    editor.current?.send({ type: "format", format: value });
  };
  const changeMode = useCallback(
    (next: typeof mode) => {
      if (next === mode) return;
      setMode(next);
      if (next === "highlights") {
        setHasOpenedHighlights(true);
        // This stays inside the same editing session. Request the latest body
        // without waiting for the bridge or SQLite; normal autosave persists it.
        editor.current?.send({ type: "blur" });
        Keyboard.dismiss();
      }
    },
    [mode],
  );
  const pin = () =>
    void run(async () => {
      if (!note) return;
      setMenu(null);
      await flush();
      await repo.setPinned(note.id, !pinned);
      setPinned(!pinned);
      refresh();
      toast(pinned ? "Note unpinned" : "Note pinned");
    });
  const duplicate = () =>
    void run(async () => {
      if (!note) return;
      setMenu(null);
      await flush();
      const id = await repo.duplicateNote(note.id);
      refresh();
      toast("Note duplicated");
      await openNote(repo, id);
    });
  const remove = () => {
    if (!note) return;
    setMenu(null);
    confirmDelete(title, async () => {
      await run(async () => {
        deleting.current = true;
        // Stop accepting edits, pop immediately, then finish existing writes
        // before deleting the row. No deleted document remains on screen.
        const stopped = autosave.stop();
        back();
        await stopped;
        await repo.deleteNote(note.id);
        refresh();
        toast("Note deleted");
        // Keep the last frame intact during the closing transition. The
        // deleted session cannot save again; the next open replaces its state.
        try {
          await cleanImages(repo);
        } catch {
          toast("Note deleted. Image cleanup will retry next time.");
        }
      });
    });
  };
  const insertImage = () =>
    void run(async () => {
      if (!note) return;
      await flush();
      Keyboard.dismiss();
      const asset = await pickImage(repo, note.id);
      if (asset) {
        setImages((previous) => ({ ...previous, [asset.id]: asset.uri }));
        editor.current?.send({
          type: "insertImage",
          assetId: asset.id,
          uri: asset.uri,
        });
        await flush();
      }
    });
  const onReady = () => {
    ready.current = true;
    setEditorReady(true);
    lastVersion.current = 0;
    latestDirtyVersion.current = 0;
    bodyDirty.current = false;
    setHasPendingEdits(autosave.isDirty());
    setStatus(autosave.isDirty() ? "saving" : "saved");
  };
  const renderHighlight = useCallback(
    ({ item }: { item: Highlight }) => (
      <HighlightRow
        highlight={item}
        card
        onPress={() => {
          setMode("full");
          requestAnimationFrame(() =>
            editor.current?.send({ type: "jumpHighlight", id: item.id }),
          );
        }}
      />
    ),
    [],
  );
  const openActions = useCallback(() => setMenu("overflow"), []);
  const retrySave = useCallback(() => {
    void run(async () => {
      await flush();
      setSaveError(undefined);
    });
  }, [run, flush]);
  const statusLabel =
    !editorReady && startupSlow && status !== "error"
      ? "Opening editor?"
      : status === "saved"
        ? "Saved"
        : status === "error"
          ? "Not saved"
          : "Saving?";
  const screen = (
    <View
      className="flex-1 bg-white"
      style={{ paddingTop: insets.top, paddingBottom: insets.bottom }}
    >
      <NoteBackGuard enabled={hasPendingEdits} onRemove={guardBack} />
      <NoteHeader
        loaded={!!note}
        title={title}
        pinned={pinned}
        busy={busy}
        updated={updated}
        wordCount={analysis.wordCount}
        statusLabel={statusLabel}
        saveError={saveError}
        mode={mode}
        counts={review.counts}
        onBack={back}
        onActions={openActions}
        onTitle={changeTitle}
        onMode={changeMode}
        onRetry={retrySave}
      />
      <View style={{ flex: 1 }}>
        <View
          style={{ flex: 1 }}
          pointerEvents={mode === "full" ? "auto" : "none"}
          accessibilityElementsHidden={mode !== "full"}
          importantForAccessibility={
            mode === "full" ? "auto" : "no-hide-descendants"
          }
        >
          <RichEditor
            ref={editor}
            documentId={session.documentId}
            trace={session.trace}
            runtime={runtime}
            initialTarget={session.target}
            initialDocument={note ? content : undefined}
            images={images}
            onDocument={onDocument}
            onDirty={(version) => {
              if (!note || deleting.current) return;
              latestDirtyVersion.current = version;
              bodyDirty.current = true;
              setHasPendingEdits(true);
              setStatus("saving");
            }}
            onFailure={() => {
              ready.current = false;
              setEditorReady(false);
              setStatus("error");
            }}
            onSelection={onSelection}
            onFeedback={(kind) =>
              toast(
                {
                  applied: "Highlight applied",
                  removed: "Highlight removed",
                  image: "Image added",
                  missingPassage: "This highlight was changed or removed.",
                  selectText: "Select text to highlight first.",
                }[kind],
              )
            }
            onReady={onReady}
          />
        </View>
        {hasOpenedHighlights ? (
          <View
            pointerEvents={mode === "highlights" ? "auto" : "none"}
            accessibilityElementsHidden={mode !== "highlights"}
            importantForAccessibility={
              mode === "highlights" ? "auto" : "no-hide-descendants"
            }
            style={{
              position: "absolute",
              top: 0,
              bottom: 0,
              left: 0,
              right: 0,
              opacity: mode === "highlights" ? 1 : 0,
              backgroundColor: colors.background,
            }}
          >
            <FlatList
              data={review.highlights}
              keyboardShouldPersistTaps="handled"
              keyboardDismissMode="on-drag"
              keyExtractor={(h) => h.id}
              renderItem={renderHighlight}
              contentContainerStyle={{
                flexGrow: 1,
                paddingHorizontal: 20,
                paddingBottom: 20,
              }}
              ListEmptyComponent={
                <EmptyState
                  icon="sun"
                  title="No highlights yet"
                  description="Select important text in Full Note and choose a highlight color."
                  action="Back to Full Note"
                  onAction={() => setMode("full")}
                />
              }
            />
          </View>
        ) : null}
      </View>
      {mode === "full" ? (
        <EditorToolbar
          selection={selection}
          busy={busy}
          ready={editorReady}
          send={(command) => editor.current?.send(command)}
          format={format}
          insertImage={insertImage}
          openFormat={() => setMenu("format")}
        />
      ) : null}
      <EditorMenu
        menu={active ? menu : null}
        setMenu={setMenu}
        rename={rename}
        setRename={setRename}
        title={title}
        pinned={pinned}
        selection={selection}
        pin={pin}
        duplicate={duplicate}
        remove={remove}
        format={format}
        saveRename={(value) => {
          changeTitle(value);
          void run(flush);
        }}
      />
    </View>
  );
  perfMark("noteSession.render.end", session.trace);
  return screen;
}

// Router's guard registration updates its context, even on a clean opening.
// Keep that subscription local so it does not render the whole editor again.
function NoteBackGuard({
  enabled,
  onRemove,
}: {
  enabled: boolean;
  onRemove: (continueBack: () => void) => void;
}) {
  const navigation = useNavigation<NativeStackNavigationProp<ParamListBase>>();
  usePreventRemove(enabled, ({ data }) =>
    onRemove(() => navigation.dispatch(data.action)),
  );
  return null;
}

// Readiness/selection updates belong to the editor controls. They must not
// reconcile the unchanged title and six highlight-count rows during opening.
const NoteHeader = memo(function NoteHeader({
  loaded,
  title,
  pinned,
  busy,
  updated,
  wordCount,
  statusLabel,
  saveError,
  mode,
  counts,
  onBack,
  onActions,
  onTitle,
  onMode,
  onRetry,
}: {
  loaded: boolean;
  title: string;
  pinned: boolean;
  busy: boolean;
  updated?: number;
  wordCount: number;
  statusLabel: string;
  saveError?: string;
  mode: "full" | "highlights";
  counts: Partial<Record<HighlightColor, number>>;
  onBack: () => void;
  onActions: () => void;
  onTitle: (title: string) => void;
  onMode: (mode: "full" | "highlights") => void;
  onRetry: () => void;
}) {
  return (
    <>
      <View className="flex-row items-center justify-between px-2">
        <IconButton
          name="chevron-left"
          label="Save and return to notes"
          disabled={busy}
          onPress={onBack}
        />
        <View className="flex-row items-center">
          {pinned ? (
            <Feather name="bookmark" size={16} color={colors.muted} />
          ) : null}
          <IconButton
            name="more-horizontal"
            label="Note actions"
            disabled={!loaded || busy}
            onPress={onActions}
          />
        </View>
      </View>
      <View className="px-5">
        <AppInput
          value={title}
          editable={loaded}
          onChangeText={onTitle}
          placeholder="Untitled Note"
          accessibilityLabel="Note title"
          maxLength={1000}
          multiline
          weight="bold"
          className="pb-1 text-[24px] leading-[31px]"
          style={{ maxHeight: 100 }}
        />
        <AppText
          accessibilityLiveRegion="polite"
          className="mb-3 text-[12px] leading-[18px] text-muted"
          style={{ minHeight: 18 }}
        >
          {loaded ? (
            <>
              {updated === undefined ? "" : formatTime(updated)} · {wordCount}{" "}
              {wordCount === 1 ? "word" : "words"} · {statusLabel}
            </>
          ) : null}
        </AppText>
        {saveError ? (
          <Pressable
            accessibilityRole="button"
            android_ripple={{ color: colors.border }}
            onPress={onRetry}
            className="mb-2 rounded-lg bg-red-50 px-3 py-2"
          >
            <AppText className="text-[13px] leading-[18px] text-red-700">
              {saveError} Tap to retry.
            </AppText>
          </Pressable>
        ) : null}
        <View className="mb-2 flex-row rounded-xl bg-field p-1">
          {(["full", "highlights"] as const).map((value) => (
            <Pressable
              key={value}
              accessibilityRole="button"
              accessibilityState={{
                selected: mode === value,
                disabled: !loaded || busy,
              }}
              disabled={!loaded || busy}
              onPress={() => onMode(value)}
              android_ripple={{ color: colors.border }}
              className={`min-h-8 flex-1 items-center justify-center rounded-lg px-2 py-2 ${mode === value ? "bg-white" : ""}`}
            >
              <AppText
                weight={mode === value ? "semibold" : "regular"}
                className="text-[14px]"
              >
                {value === "full" ? "Full Note" : "Highlights"}
              </AppText>
            </Pressable>
          ))}
        </View>
        <ScrollView
          horizontal
          showsHorizontalScrollIndicator={false}
          contentContainerStyle={{ gap: 8, paddingBottom: 12 }}
        >
          {HIGHLIGHT_COLORS.map((color) => (
            <View
              key={color}
              accessible
              accessibilityLabel={`${HIGHLIGHT_PALETTE[color].label}: ${counts[color] ?? 0} highlights`}
              className="flex-row items-center gap-2 rounded-full bg-field px-3 py-2"
            >
              <View
                style={{
                  width: 10,
                  height: 10,
                  borderRadius: 5,
                  backgroundColor: HIGHLIGHT_PALETTE[color].dot,
                }}
              />
              <AppText className="text-[13px]">{counts[color] ?? 0}</AppText>
            </View>
          ))}
        </ScrollView>
      </View>
    </>
  );
});
