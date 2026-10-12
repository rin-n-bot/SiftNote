import Feather from "@expo/vector-icons/Feather";
import { useEffect, useLayoutEffect, useState } from "react";
import { FlatList, Keyboard, Pressable, View } from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import {
  AppInput,
  AppText,
  colors,
  EmptyState,
  ErrorState,
  IconButton,
  LoadingState,
} from "../../components/ui/primitives";
import type { Highlight, NoteSummary } from "../../domain/types";
import { useApp } from "../../state/app-context";
import { HighlightRow, NoteRow, useCreateNote } from "./shared";
import { perfMark } from "../../dev/perf";

type Row =
  | { kind: "note"; note: NoteSummary }
  | { kind: "highlight"; highlight: Highlight }
  | { kind: "header"; title: string };
export function NotesScreen() {
  perfMark("notes.render.start");
  useLayoutEffect(() => {
    perfMark("notes.commit");
  });
  useEffect(() => {
    perfMark("notes.mount");
    return () => perfMark("notes.unmount");
  }, []);
  const { repo, revision } = useApp();
  const { create, creating } = useCreateNote();
  const insets = useSafeAreaInsets();
  const [query, setQuery] = useState("");
  const [filter, setFilter] = useState<"all" | "notes" | "highlights">("all");
  const [result, setResult] = useState<{
    query: string;
    notes: NoteSummary[];
    highlights: Highlight[];
  }>();
  const data = result?.query === query ? result : undefined;
  const [error, setError] = useState<string>();
  const [attempt, setAttempt] = useState(0);
  const search = !!query.trim();
  useEffect(() => {
    let cancelled = false;
    const load = () => {
      perfMark("notes.query.start", undefined, { revision });
      void Promise.all([
        repo.listNotes(query),
        search ? repo.listHighlights({ query }) : Promise.resolve([]),
      ])
        .then(([notes, highlights]) => {
          perfMark("notes.query.end", undefined, {
            notes: notes.length,
            highlights: highlights.length,
          });
          if (!cancelled) {
            setResult({ query, notes, highlights });
            setError(undefined);
          }
        })
        .catch((cause) => {
          if (!cancelled)
            setError(
              cause instanceof Error
                ? cause.message
                : "Notes could not be loaded.",
            );
        });
    };
    const timer = setTimeout(load, search ? 150 : 0);
    return () => {
      cancelled = true;
      clearTimeout(timer);
    };
    // Revision and retry are external invalidation signals for the local query.
  }, [repo, revision, query, search, attempt]);
  const rows: Row[] = [];
  if (data) {
    if (!search || filter !== "highlights") {
      if (search && data.notes.length)
        rows.push({ kind: "header", title: `Notes (${data.notes.length})` });
      rows.push(...data.notes.map((note) => ({ kind: "note" as const, note })));
    }
    if (search && filter !== "notes" && data.highlights.length) {
      rows.push({
        kind: "header",
        title: `Highlights (${data.highlights.length})`,
      });
      rows.push(
        ...data.highlights.map((highlight) => ({
          kind: "highlight" as const,
          highlight,
        })),
      );
    }
  }
  const clear = () => {
    setQuery("");
    setFilter("all");
    Keyboard.dismiss();
  };
  const screen = (
    <View className="flex-1 bg-white" style={{ paddingTop: insets.top }}>
      <View className="flex-row items-center justify-between px-5 pb-2 pt-3">
        <AppText
          weight="bold"
          accessibilityRole="header"
          className="text-[32px]"
        >
          Notes
        </AppText>
        <IconButton
          name="plus"
          label="Create note"
          disabled={creating}
          onPress={() => void create()}
        />
      </View>
      <View className="mx-5 mb-3 flex-row items-center rounded-xl bg-field pl-3">
        <Feather name="search" size={18} color={colors.muted} />
        <AppInput
          value={query}
          onChangeText={setQuery}
          maxLength={1000}
          accessibilityLabel="Search notes and highlights"
          placeholder="Search notes…"
          returnKeyType="search"
          onSubmitEditing={() => Keyboard.dismiss()}
          className="min-h-12 flex-1 px-3 py-3 text-[14px]"
        />
        {query ? (
          <IconButton name="x" label="Clear search" onPress={clear} />
        ) : null}
      </View>
      {search ? (
        <View className="mb-2 flex-row gap-2 px-5">
          {(["all", "notes", "highlights"] as const).map((value) => (
            <Pressable
              key={value}
              accessibilityRole="button"
              accessibilityState={{ selected: filter === value }}
              onPress={() => setFilter(value)}
              android_ripple={{ color: colors.border }}
              className={`min-h-11 justify-center rounded-full px-3 py-2 ${filter === value ? "bg-ink" : "bg-field"}`}
            >
              <AppText
                className={`text-[12px] ${filter === value ? "text-white" : "text-ink"}`}
              >
                {value[0].toUpperCase() + value.slice(1)} (
                {value === "all"
                  ? (data?.notes.length ?? 0) + (data?.highlights.length ?? 0)
                  : (data?.[value].length ?? 0)}
                )
              </AppText>
            </Pressable>
          ))}
        </View>
      ) : null}
      {error ? (
        <ErrorState message={error} onRetry={() => setAttempt((a) => a + 1)} />
      ) : !data ? (
        <LoadingState />
      ) : (
        <FlatList
          data={rows}
          keyboardShouldPersistTaps="handled"
          keyboardDismissMode="on-drag"
          keyExtractor={(row) =>
            row.kind === "header"
              ? row.title
              : row.kind === "note"
                ? `n_${row.note.id}`
                : `h_${row.highlight.noteId}_${row.highlight.id}`
          }
          renderItem={({ item }) =>
            item.kind === "header" ? (
              <AppText
                weight="semibold"
                accessibilityRole="header"
                className="px-5 pb-2 pt-5 text-[19px]"
              >
                {item.title}
              </AppText>
            ) : item.kind === "note" ? (
              <NoteRow note={item.note} query={search ? query : undefined} />
            ) : (
              <HighlightRow highlight={item.highlight} />
            )
          }
          contentContainerStyle={{ flexGrow: 1, paddingBottom: 20 }}
          ListEmptyComponent={
            search ? (
              <EmptyState
                icon="search"
                title="No results found"
                description={`No ${filter === "all" ? "notes or highlights" : filter} match “${query.trim()}”. Try a different keyword.`}
                action="Clear search"
                onAction={clear}
              />
            ) : (
              <EmptyState
                title="No notes yet"
                description="Start capturing your thoughts, ideas, and insights. Your first note is just a tap away."
                action="Create your first note"
                onAction={() => void create()}
              />
            )
          }
        />
      )}
    </View>
  );
  perfMark("notes.render.end");
  return screen;
}
