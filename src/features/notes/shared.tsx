import Feather from "@expo/vector-icons/Feather";
import { router } from "expo-router";
import { useRef, useState } from "react";
import { Alert, Pressable, View } from "react-native";
import ReanimatedSwipeable, {
  type SwipeableMethods,
} from "react-native-gesture-handler/ReanimatedSwipeable";
import { AppText, colors } from "../../components/ui/primitives";
import {
  createId,
  HIGHLIGHT_COLORS,
  HIGHLIGHT_PALETTE,
  validId,
} from "../../domain/document";
import type { Highlight, Note, NoteSummary } from "../../domain/types";
import { cleanImages } from "../../persistence/images";
import { totalHighlights } from "../../persistence/repository";
import { useApp } from "../../state/app-context";
import {
  loadNoteForOpening,
  stagePreparedNote,
  releasePreparedNote,
  type NoteOpening,
  type PreparedNote,
} from "./prepared-note";
import type { NoteRepository } from "../../persistence/repository";
import { perfMark, perfStart, type PerfTrace } from "../../dev/perf";

export const noteTitle = (title: string) => title.trim() || "Untitled Note";
export function formatTime(timestamp: number) {
  const date = new Date(timestamp);
  const now = new Date();
  const time = date.toLocaleTimeString(undefined, {
    hour: "numeric",
    minute: "2-digit",
  });
  if (date.toDateString() === now.toDateString()) return `Today, ${time}`;
  const yesterday = new Date(now);
  yesterday.setDate(now.getDate() - 1);
  if (date.toDateString() === yesterday.toDateString())
    return `Yesterday, ${time}`;
  return date.toLocaleDateString(undefined, {
    month: "short",
    day: "numeric",
    year: date.getFullYear() !== now.getFullYear() ? "numeric" : undefined,
  });
}
function beginOpening(
  noteId: string,
  load: () => Promise<PreparedNote | null>,
  title: string,
  target: NoteOpening["target"],
  trace?: PerfTrace,
) {
  const request: NoteOpening = {
    openingId: createId(),
    title,
    target,
    load,
    trace,
  };
  stagePreparedNote(request);
  try {
    perfMark("router.pushNote", trace);
    router.push({
      pathname: "/note/[id]",
      params: {
        id: noteId,
        openingId: request.openingId,
        title,
        ...(target?.type === "highlight" ? { highlightId: target.id } : {}),
        ...(target?.type === "search" ? { query: target.query } : {}),
      },
    });
  } catch (error) {
    releasePreparedNote(request);
    throw error;
  }
  // The destination starts preparation after its first committed frame.
}
export async function openNote(
  repo: NoteRepository,
  source:
    | string
    | Note
    | (Pick<NoteSummary, "id" | "title"> &
        Partial<Pick<NoteSummary, "preview">>),
  highlightId?: string,
  query?: string,
  trace?: PerfTrace,
) {
  trace ??= perfStart("open");
  const documentSource =
    typeof source === "string" || "content" in source ? source : source.id;
  const target =
    highlightId && validId(highlightId)
      ? { type: "highlight" as const, id: highlightId }
      : query && query.length <= 1000
        ? { type: "search" as const, query }
        : undefined;
  // The note screen reports preparation errors and returns to browsing. Callers only
  // handle a failure to dispatch navigation, avoiding duplicate error toasts.
  beginOpening(
    typeof source === "string" ? source : source.id,
    () => loadNoteForOpening(repo, documentSource, trace),
    typeof source === "string" ? "" : source.title,
    target,
    trace,
  );
}
export function useCreateNote() {
  const { repo, refresh, toast } = useApp();
  const lock = useRef(false);
  const [creating, setCreating] = useState(false);
  const create = async () => {
    const trace = perfStart("create");
    if (lock.current) return;
    lock.current = true;
    setCreating(true);
    try {
      beginOpening(
        "new",
        async () => {
          perfMark("create.insert.start", trace);
          const note = await repo.createNote();
          perfMark("create.insert.end", trace);
          refresh();
          toast("Note created");
          return loadNoteForOpening(repo, note, trace);
        },
        "",
        undefined,
        trace,
      );
    } catch (error) {
      toast(
        error instanceof Error
          ? error.message
          : "The note could not be created.",
      );
    } finally {
      lock.current = false;
      setCreating(false);
    }
  };
  return { create, creating };
}
export function confirmDelete(title: string, action: () => Promise<void>) {
  Alert.alert(
    "Delete this note?",
    `“${noteTitle(title)}” and its highlights will be permanently deleted.`,
    [
      { text: "Cancel", style: "cancel" },
      { text: "Delete", style: "destructive", onPress: () => void action() },
    ],
  );
}
export function NoteRow({
  note,
  query,
}: {
  note: NoteSummary;
  query?: string;
}) {
  const { repo, refresh, toast } = useApp();
  const swipe = useRef<SwipeableMethods>(null);
  const lock = useRef(false);
  const editedTime = formatTime(note.updatedAt);
  const highlightCount = totalHighlights(note);
  const pin = async () => {
    if (lock.current) return;
    lock.current = true;
    swipe.current?.close();
    try {
      await repo.setPinned(note.id, !note.isPinned);
      refresh();
      toast(note.isPinned ? "Note unpinned" : "Note pinned");
    } catch (error) {
      toast(
        error instanceof Error
          ? error.message
          : "The note could not be pinned.",
      );
    } finally {
      lock.current = false;
    }
  };
  const remove = () =>
    confirmDelete(note.title, async () => {
      if (lock.current) return;
      lock.current = true;
      swipe.current?.close();
      try {
        await repo.deleteNote(note.id);
        refresh();
        toast("Note deleted");
        try {
          await cleanImages(repo);
        } catch {
          toast("Note deleted. Image cleanup will retry next time.");
        }
      } catch (error) {
        toast(
          error instanceof Error
            ? error.message
            : "The note could not be deleted.",
        );
      } finally {
        lock.current = false;
      }
    });
  const actions = () =>
    Alert.alert(noteTitle(note.title), "Note actions", [
      { text: note.isPinned ? "Unpin" : "Pin", onPress: () => void pin() },
      { text: "Delete", style: "destructive", onPress: remove },
      { text: "Cancel", style: "cancel" },
    ]);
  return (
    <ReanimatedSwipeable
      ref={swipe}
      overshootRight={false}
      renderRightActions={() => (
        <View className="flex-row">
          <Pressable
            accessibilityRole="button"
            accessibilityLabel={note.isPinned ? "Unpin note" : "Pin note"}
            onPress={() => void pin()}
            android_ripple={{ color: colors.border }}
            className="w-20 items-center justify-center bg-muted"
          >
            <Feather name="bookmark" size={22} color="white" />
            <AppText className="mt-2 text-xs text-white">
              {note.isPinned ? "Unpin" : "Pin"}
            </AppText>
          </Pressable>
          <Pressable
            accessibilityRole="button"
            accessibilityLabel="Delete note"
            onPress={remove}
            android_ripple={{ color: colors.border }}
            className="w-20 items-center justify-center bg-red-500"
          >
            <Feather name="trash-2" size={22} color="white" />
            <AppText className="mt-2 text-xs text-white">Delete</AppText>
          </Pressable>
        </View>
      )}
    >
      <Pressable
        onPress={() =>
          void openNote(repo, note, undefined, query).catch((error) =>
            toast(
              error instanceof Error
                ? error.message
                : "This note could not be opened.",
            ),
          )
        }
        onLongPress={actions}
        accessibilityRole="button"
        accessibilityLabel={`${noteTitle(note.title)}${note.isPinned ? ", pinned" : ""}. ${note.preview || "Empty note"}. ${highlightCount} highlights. ${editedTime}. Long press for note actions.`}
        android_ripple={{ color: colors.field }}
        className="border-b border-line bg-white px-5 py-4"
      >
        <View className="flex-row items-start gap-3">
          <View className="flex-1">
            <View className="mb-1 flex-row items-center gap-2">
              {note.isPinned ? (
                <Feather name="bookmark" size={13} color={colors.muted} />
              ) : null}
              <AppText
                weight="semibold"
                className="flex-1 text-[16px]"
                numberOfLines={1}
              >
                {noteTitle(note.title)}
              </AppText>
            </View>
            <AppText
              className="text-[14px] leading-[20px] text-muted"
              numberOfLines={2}
            >
              {note.preview || "Start writing your note…"}
            </AppText>
            <AppText className="mt-1.5 text-[12px] text-muted">
              {editedTime}
            </AppText>
          </View>
          <View className="flex-row items-center gap-1.5 pt-1">
            {HIGHLIGHT_COLORS.filter(
              (color) => note.highlightCounts[color],
            ).map((color) => (
              <View
                key={color}
                style={{
                  backgroundColor: HIGHLIGHT_PALETTE[color].dot,
                  width: 9,
                  height: 9,
                  borderRadius: 5,
                }}
              />
            ))}
            {highlightCount > 0 ? (
              <AppText className="text-[13px] text-muted">
                {highlightCount}
              </AppText>
            ) : null}
            <Feather name="chevron-right" size={18} color={colors.muted} />
          </View>
        </View>
      </Pressable>
    </ReanimatedSwipeable>
  );
}
export function HighlightRow({
  highlight,
  onPress,
  card = false,
}: {
  highlight: Highlight;
  onPress?: () => void;
  card?: boolean;
}) {
  const { repo, toast } = useApp();
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={`${HIGHLIGHT_PALETTE[highlight.color].label} highlight: ${highlight.text}. ${noteTitle(highlight.noteTitle)}. Open original passage.`}
      onPress={
        onPress ??
        (() =>
          void openNote(
            repo,
            { id: highlight.noteId, title: highlight.noteTitle },
            highlight.id,
          ).catch((error) =>
            toast(
              error instanceof Error
                ? error.message
                : "This note could not be opened.",
            ),
          ))
      }
      android_ripple={{ color: colors.field }}
      className={`flex-row items-start gap-3 px-4 py-4 ${card ? "mb-2 rounded-xl border border-line" : "border-b border-line"}`}
    >
      <View
        style={{
          backgroundColor: HIGHLIGHT_PALETTE[highlight.color].dot,
          width: 12,
          height: 12,
          borderRadius: 6,
          marginTop: 4,
        }}
      />
      <View className="flex-1">
        <AppText className="text-[14px] leading-[21px]">
          {highlight.text}
        </AppText>
        <AppText
          className="mt-1.5 text-[12px] leading-[18px] text-muted"
          numberOfLines={2}
        >
          {card ? "" : `${noteTitle(highlight.noteTitle)} · `}
          {highlight.section ? `${highlight.section} · ` : ""}
          {formatTime(highlight.createdAt)}
        </AppText>
      </View>
      <Feather
        name="chevron-right"
        size={18}
        color={colors.muted}
        style={{ alignSelf: "center" }}
      />
    </Pressable>
  );
}
