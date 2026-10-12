import * as SQLite from "expo-sqlite";
import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from "react";
import { Pressable, View } from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import {
  AppText,
  colors,
  ErrorState,
  LoadingState,
} from "../components/ui/primitives";
import { cleanImages } from "../persistence/images";
import { migrateDatabase, NoteRepository } from "../persistence/repository";
import { prepareEditorRuntime } from "../editor/runtime";
import { perfMark } from "../dev/perf";

type AppContextValue = {
  repo: NoteRepository;
  revision: number;
  refresh: () => void;
  beginNoteClose: () => void;
  endNoteClose: () => void;
  toast: (message: string) => void;
};
const AppContext = createContext<AppContextValue | null>(null);
let repositoryPromise: Promise<NoteRepository> | undefined;
async function openRepository() {
  if (!repositoryPromise)
    repositoryPromise = (async () => {
      const db = await SQLite.openDatabaseAsync("siftnote.db");
      try {
        await migrateDatabase(db);
        return new NoteRepository(db);
      } catch (error) {
        await db.closeAsync();
        throw error;
      }
    })().catch((error) => {
      repositoryPromise = undefined;
      throw error;
    });
  return repositoryPromise;
}
export function AppProvider({ children }: { children: ReactNode }) {
  const [repo, setRepo] = useState<NoteRepository>();
  const [error, setError] = useState<string>();
  const [attempt, setAttempt] = useState(0);
  const [revision, setRevision] = useState(0);
  const [message, setMessage] = useState<{ text: string; key: number }>();
  const insets = useSafeAreaInsets();
  const closingNote = useRef(false);
  const refreshPending = useRef(false);
  const refresh = useCallback(() => {
    perfMark("lists.refresh.request");
    if (closingNote.current) {
      refreshPending.current = true;
      perfMark("lists.refresh.deferred");
      return;
    }
    perfMark("lists.refresh.commit");
    setRevision((value) => value + 1);
  }, []);
  const beginNoteClose = useCallback(() => {
    closingNote.current = true;
  }, []);
  const endNoteClose = useCallback(() => {
    closingNote.current = false;
    if (!refreshPending.current) return;
    refreshPending.current = false;
    perfMark("lists.refresh.commit");
    setRevision((value) => value + 1);
  }, []);
  const toast = useCallback(
    (text: string) => setMessage({ text, key: Date.now() }),
    [],
  );
  useEffect(() => {
    let cancelled = false;
    // Prepare the offline page while the app opens, ahead of note navigation.
    // NoteLoader retries and presents errors if preparation fails.
    void prepareEditorRuntime().catch(() => {});
    void openRepository()
      .then(async (repository) => {
        if (cancelled) return;
        try {
          await cleanImages(repository, true);
        } catch {
          if (!cancelled)
            toast("Image cleanup will retry next time you open SiftNote.");
        }
        if (!cancelled) setRepo(repository);
      })
      .catch((cause) => {
        if (!cancelled)
          setError(
            cause instanceof Error
              ? cause.message
              : "Local storage could not be opened. Your data has been kept.",
          );
      });
    return () => {
      cancelled = true;
    };
  }, [attempt, toast]);
  useEffect(() => {
    if (!message) return;
    const timer = setTimeout(() => setMessage(undefined), 4200);
    return () => clearTimeout(timer);
  }, [message]);
  const value = useMemo(
    () =>
      repo
        ? { repo, revision, refresh, beginNoteClose, endNoteClose, toast }
        : null,
    [repo, revision, refresh, beginNoteClose, endNoteClose, toast],
  );
  if (error)
    return (
      <ErrorState
        message={error}
        onRetry={() => {
          setError(undefined);
          setAttempt((a) => a + 1);
        }}
      />
    );
  if (!repo) return <LoadingState />;
  return (
    <AppContext.Provider value={value}>
      {children}
      {message ? (
        <View
          pointerEvents="box-none"
          style={{
            position: "absolute",
            left: 20,
            right: 20,
            bottom: insets.bottom + 80,
            zIndex: 50,
          }}
        >
          <Pressable
            accessibilityRole="button"
            accessibilityLabel={`${message.text}. Dismiss notification`}
            onPress={() => setMessage(undefined)}
            android_ripple={{ color: colors.border }}
            className="rounded-xl bg-ink px-5 py-4"
            style={{ boxShadow: "0 4px 16px #00000018" }}
          >
            <AppText
              accessibilityLiveRegion="polite"
              className="text-[14px] text-white"
            >
              {message.text}
            </AppText>
          </Pressable>
        </View>
      ) : null}
    </AppContext.Provider>
  );
}
export function useApp() {
  const context = useContext(AppContext);
  if (!context) throw new Error("AppProvider is required.");
  return context;
}
