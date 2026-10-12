import Feather from "@expo/vector-icons/Feather";
import { Modal, Pressable, ScrollView, View } from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import {
  AppInput,
  AppText,
  Button,
  IconButton,
  colors,
} from "../../components/ui/primitives";
import { HIGHLIGHT_COLORS, HIGHLIGHT_PALETTE } from "../../domain/document";
import type {
  EditorCommand,
  Format,
  SelectionState,
} from "../../editor/bridge";
export type EditorMenuKind = "overflow" | "format" | "rename" | null;
export function EditorToolbar({
  selection,
  busy,
  ready,
  send,
  format,
  insertImage,
  openFormat,
}: {
  selection: SelectionState;
  busy: boolean;
  ready: boolean;
  send: (command: EditorCommand) => void;
  format: (format: Format) => void;
  insertImage: () => void;
  openFormat: () => void;
}) {
  const showSelection =
    selection.hasSelection || selection.highlightColor !== null;
  return (
    <View className="border-t border-line bg-white">
      {showSelection ? (
        <View className="px-3 pt-2">
          <AppText className="mb-1 px-2 text-[12px] text-muted">
            Highlight
          </AppText>
          <ScrollView
            horizontal
            keyboardShouldPersistTaps="always"
            showsHorizontalScrollIndicator={false}
            contentContainerStyle={{ alignItems: "center" }}
          >
            {HIGHLIGHT_COLORS.map((color) => (
              <Pressable
                key={color}
                accessibilityRole="button"
                accessibilityLabel={`${selection.highlightColor ? "Change highlight to" : "Highlight selection in"} ${color}`}
                accessibilityState={{
                  selected: selection.highlightColor === color,
                }}
                onPress={() => send({ type: "highlight", color })}
                android_ripple={{ color: colors.border, borderless: true }}
                className="h-12 w-12 items-center justify-center"
              >
                <View
                  style={{
                    height: 27,
                    width: 27,
                    borderRadius: 14,
                    backgroundColor: HIGHLIGHT_PALETTE[color].fill,
                    borderWidth: selection.highlightColor === color ? 2 : 1,
                    borderColor:
                      selection.highlightColor === color
                        ? colors.accent
                        : HIGHLIGHT_PALETTE[color].dot,
                  }}
                />
              </Pressable>
            ))}
            <IconButton
              name="x"
              label="Remove highlight"
              onPress={() => send({ type: "removeHighlight" })}
            />
          </ScrollView>
        </View>
      ) : null}
      <ScrollView
        horizontal
        keyboardShouldPersistTaps="always"
        showsHorizontalScrollIndicator={false}
        contentContainerStyle={{
          paddingHorizontal: 12,
          justifyContent: "space-between",
          flexGrow: 1,
          paddingVertical: 4,
        }}
      >
        <Pressable
          accessibilityRole="button"
          accessibilityLabel="Text formatting"
          disabled={!ready}
          accessibilityState={{ disabled: !ready }}
          style={{ opacity: ready ? 1 : 0.35 }}
          onPress={() => openFormat()}
          android_ripple={{ color: colors.border, borderless: true }}
          className="h-12 w-12 items-center justify-center"
        >
          <AppText weight="medium" className="text-[19px]">
            Aa
          </AppText>
        </Pressable>
        <IconButton
          name="list"
          label="Bullet list"
          selected={selection.bulletList}
          disabled={!ready}
          onPress={() => format("bulletList")}
        />
        <Pressable
          accessibilityRole="button"
          accessibilityLabel="Numbered list"
          disabled={!ready}
          accessibilityState={{
            selected: selection.orderedList,
            disabled: !ready,
          }}
          style={{ opacity: ready ? 1 : 0.35 }}
          onPress={() => format("orderedList")}
          android_ripple={{ color: colors.border, borderless: true }}
          className={`h-12 w-12 items-center justify-center rounded-xl ${selection.orderedList ? "bg-field" : ""}`}
        >
          <AppText weight="medium" className="text-[18px]">
            1.
          </AppText>
        </Pressable>
        <IconButton
          name="image"
          label="Insert image"
          disabled={busy || !ready}
          onPress={insertImage}
        />
        <IconButton
          name="rotate-ccw"
          label="Undo"
          disabled={!ready || !selection.canUndo}
          onPress={() => format("undo")}
        />
        <IconButton
          name="rotate-cw"
          label="Redo"
          disabled={!ready || !selection.canRedo}
          onPress={() => format("redo")}
        />
      </ScrollView>
    </View>
  );
}
export function EditorMenu({
  menu,
  setMenu,
  rename,
  setRename,
  title,
  pinned,
  selection,
  pin,
  duplicate,
  remove,
  format,
  saveRename,
}: {
  menu: EditorMenuKind;
  setMenu: (value: EditorMenuKind) => void;
  rename: string;
  setRename: (value: string) => void;
  title: string;
  pinned: boolean;
  selection: SelectionState;
  pin: () => void;
  duplicate: () => void;
  remove: () => void;
  format: (format: Format) => void;
  saveRename: (title: string) => void;
}) {
  const insets = useSafeAreaInsets();
  return (
    <Modal
      visible={menu !== null}
      transparent
      animationType="fade"
      onRequestClose={() => setMenu(null)}
    >
      <View
        style={{
          flex: 1,
          backgroundColor: menu === "rename" ? "#00000055" : "#00000015",
          justifyContent:
            menu === "overflow"
              ? "flex-start"
              : menu === "rename"
                ? "center"
                : "flex-end",
          paddingTop: insets.top + 48,
          paddingBottom: insets.bottom + 12,
          paddingHorizontal: 20,
        }}
      >
        <Pressable
          accessibilityRole="button"
          accessibilityLabel="Close menu"
          onPress={() => setMenu(null)}
          style={{ position: "absolute", top: 0, right: 0, bottom: 0, left: 0 }}
        />
        <View
          className="rounded-2xl border border-line bg-white p-3"
          style={{
            alignSelf: menu === "overflow" ? "flex-end" : "stretch",
            minWidth: menu === "overflow" ? 190 : undefined,
            boxShadow: "0 8px 28px #00000018",
          }}
        >
          {menu === "overflow" ? (
            <>
              {[
                {
                  label: "Rename",
                  icon: "edit-2" as const,
                  action: () => {
                    setRename(title);
                    setMenu("rename");
                  },
                },
                {
                  label: pinned ? "Unpin" : "Pin",
                  icon: "bookmark" as const,
                  action: pin,
                },
                {
                  label: "Duplicate",
                  icon: "copy" as const,
                  action: duplicate,
                },
                { label: "Delete", icon: "trash-2" as const, action: remove },
              ].map((item) => (
                <Pressable
                  key={item.label}
                  accessibilityRole="button"
                  onPress={item.action}
                  android_ripple={{ color: colors.border }}
                  className="min-h-12 flex-row items-center gap-3 px-3 py-3"
                >
                  <Feather
                    name={item.icon}
                    size={18}
                    color={
                      item.label === "Delete" ? colors.danger : colors.text
                    }
                  />
                  <AppText
                    className={`text-[15px] ${item.label === "Delete" ? "text-red-600" : ""}`}
                  >
                    {item.label}
                  </AppText>
                </Pressable>
              ))}
            </>
          ) : menu === "rename" ? (
            <>
              <AppText weight="semibold" className="mb-3 text-[20px]">
                Rename note
              </AppText>
              <AppInput
                autoFocus
                value={rename}
                onChangeText={setRename}
                maxLength={1000}
                accessibilityLabel="New note title"
                placeholder="Untitled Note"
                className="mb-4 rounded-lg bg-field px-3 py-3 text-[16px]"
              />
              <View className="flex-row gap-2">
                <View className="flex-1">
                  <Button
                    title="Cancel"
                    secondary
                    onPress={() => setMenu(null)}
                  />
                </View>
                <View className="flex-1">
                  <Button
                    title="Save"
                    onPress={() => {
                      setMenu(null);
                      saveRename(rename);
                    }}
                  />
                </View>
              </View>
            </>
          ) : (
            <>
              <AppText weight="semibold" className="px-3 pb-2 text-[18px]">
                Text formatting
              </AppText>
              {(
                [
                  { label: "Normal text", value: "normal" },
                  { label: "Heading", value: "heading" },
                  { label: "Bold", value: "bold" },
                  { label: "Italic", value: "italic" },
                  { label: "Underline", value: "underline" },
                ] as const
              ).map((item) => (
                <Pressable
                  key={item.value}
                  accessibilityRole="button"
                  accessibilityState={{
                    selected: item.value !== "normal" && selection[item.value],
                  }}
                  onPress={() => format(item.value)}
                  android_ripple={{ color: colors.border }}
                  className="min-h-12 flex-row items-center justify-between px-3 py-3"
                >
                  <AppText className="text-[16px]">{item.label}</AppText>
                  {item.value !== "normal" && selection[item.value] ? (
                    <Feather name="check" size={18} color={colors.text} />
                  ) : null}
                </Pressable>
              ))}
            </>
          )}
        </View>
      </View>
    </Modal>
  );
}
