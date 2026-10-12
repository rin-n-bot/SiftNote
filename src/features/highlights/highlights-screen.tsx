import { useEffect, useRef, useState } from "react";
import { FlatList, Pressable, View } from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import {
  AppText,
  colors,
  EmptyState,
  ErrorState,
  LoadingState,
} from "../../components/ui/primitives";
import {
  HIGHLIGHT_COLORS,
  HIGHLIGHT_PALETTE,
  type HighlightColor,
} from "../../domain/document";
import type { Highlight } from "../../domain/types";
import { useApp } from "../../state/app-context";
import { HighlightRow, useCreateNote } from "../notes/shared";

function ColorFilters({
  selected,
  onChange,
}: {
  selected: "all" | HighlightColor;
  onChange: (value: "all" | HighlightColor) => void;
}) {
  return (
    <View className="flex-row flex-wrap gap-2">
      {(["all", ...HIGHLIGHT_COLORS] as const).map((color) => (
        <Pressable
          key={color}
          accessibilityRole="button"
          accessibilityState={{ selected: selected === color }}
          accessibilityLabel={`Filter ${color === "all" ? "all highlights" : `${HIGHLIGHT_PALETTE[color].label} highlights`}`}
          onPress={() => onChange(color)}
          android_ripple={{ color: colors.border }}
          className={`min-h-6 flex-row items-center gap-1.5 rounded-xl px-3 py-2 ${selected === color ? "bg-ink" : "bg-field"}`}
        >
          {color !== "all" ? (
            <View
              style={{
                width: 9,
                height: 9,
                borderRadius: 5,
                backgroundColor: HIGHLIGHT_PALETTE[color].dot,
              }}
            />
          ) : null}
          <AppText
            className={`text-[12px] ${selected === color ? "text-white" : "text-ink"}`}
          >
            {color === "all" ? "All" : HIGHLIGHT_PALETTE[color].label}
          </AppText>
        </Pressable>
      ))}
    </View>
  );
}
export function HighlightsScreen() {
  const { repo, revision } = useApp();
  const { create } = useCreateNote();
  const insets = useSafeAreaInsets();
  const list = useRef<FlatList<Highlight>>(null);
  const [filter, setFilter] = useState<"all" | HighlightColor>("all");
  const [result, setResult] = useState<Highlight[]>();
  const highlights =
    filter === "all" ? result : result?.filter((item) => item.color === filter);
  const [error, setError] = useState<string>();
  const [attempt, setAttempt] = useState(0);
  const changeFilter = (value: typeof filter) => {
    if (value === filter) return;
    setFilter(value);
    list.current?.scrollToOffset({ offset: 0, animated: false });
  };
  // Keep the existing rows across focus changes. Committed mutations and
  // explicit retries invalidate them without delaying tab navigation.
  useEffect(() => {
    let cancelled = false;
    void repo
      .listHighlights()
      .then((items) => {
        if (!cancelled) {
          setResult(items);
          setError(undefined);
        }
      })
      .catch((cause) => {
        if (!cancelled)
          setError(
            cause instanceof Error
              ? cause.message
              : "Highlights could not be loaded.",
          );
      });
    return () => {
      cancelled = true;
    };
  }, [repo, revision, attempt]);
  return (
    <View className="flex-1 bg-white" style={{ paddingTop: insets.top }}>
      <AppText
        weight="bold"
        accessibilityRole="header"
        className="px-5 pb-3 pt-5 text-[32px]"
      >
        Highlights
      </AppText>
      <View className="border-b border-line px-5 pb-3">
        <ColorFilters selected={filter} onChange={changeFilter} />
      </View>
      {error ? (
        <ErrorState message={error} onRetry={() => setAttempt((a) => a + 1)} />
      ) : !highlights ? (
        <LoadingState />
      ) : (
        <FlatList
          ref={list}
          data={highlights}
          keyboardShouldPersistTaps="handled"
          keyboardDismissMode="on-drag"
          keyExtractor={(h) => `${h.noteId}_${h.id}`}
          renderItem={({ item }) => <HighlightRow highlight={item} />}
          contentContainerStyle={{ flexGrow: 1, paddingBottom: 20 }}
          ListEmptyComponent={
            <EmptyState
              icon="sun"
              title={
                filter === "all"
                  ? "No highlights yet"
                  : `No ${filter} highlights`
              }
              description={
                filter === "all"
                  ? "Highlight text in your notes to save key points, ideas, and information for later."
                  : "Choose All to see your other highlighted passages."
              }
              action={
                filter === "all"
                  ? "Create a note to start"
                  : "Show all highlights"
              }
              onAction={
                filter === "all"
                  ? () => void create()
                  : () => changeFilter("all")
              }
            />
          }
        />
      )}
    </View>
  );
}
