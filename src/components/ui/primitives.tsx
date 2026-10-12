import Feather from "@expo/vector-icons/Feather";
import { forwardRef } from "react";
import {
  ActivityIndicator,
  Pressable,
  Text,
  TextInput,
  View,
  type TextInputProps,
  type TextProps,
} from "react-native";

export const colors = {
  background: "#FFFFFF",
  text: "#181B28",
  muted: "#667087",
  border: "#ECEEF2",
  field: "#F3F4F7",
  danger: "#D83040",
  accent: "#277CDB",
};
const fonts = {
  regular: "font-ui",
  medium: "font-ui-medium",
  semibold: "font-ui-semibold",
  bold: "font-ui-bold",
};
export const fontFamilies = {
  regular: "Inter_400Regular",
  medium: "Inter_500Medium",
  semibold: "Inter_600SemiBold",
  bold: "Inter_700Bold",
} as const;
export function AppText({
  weight = "regular",
  className = "",
  ...props
}: TextProps & { weight?: keyof typeof fonts; className?: string }) {
  return (
    <Text {...props} className={`${fonts[weight]} text-ink ${className}`} />
  );
}
export const AppInput = forwardRef<
  TextInput,
  TextInputProps & { className?: string; weight?: keyof typeof fonts }
>(function AppInput(
  { className = "", weight = "regular", style, ...props },
  ref,
) {
  return (
    <TextInput
      {...props}
      ref={ref}
      className={`text-ink ${className}`}
      style={[{ fontFamily: fontFamilies[weight] }, style]}
      placeholderTextColor={colors.muted}
    />
  );
});
export function IconButton({
  name,
  label,
  onPress,
  disabled = false,
  selected = false,
}: {
  name: keyof typeof Feather.glyphMap;
  label: string;
  onPress: () => void;
  disabled?: boolean;
  selected?: boolean;
}) {
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={label}
      accessibilityState={{ disabled, selected }}
      onPress={onPress}
      disabled={disabled}
      android_ripple={{ color: colors.border, borderless: true }}
      className={`h-12 w-12 items-center justify-center rounded-xl ${selected ? "bg-field" : ""}`}
      style={{ opacity: disabled ? 0.35 : 1 }}
    >
      <Feather name={name} size={21} color={colors.text} />
    </Pressable>
  );
}
export function Button({
  title,
  onPress,
  secondary = false,
  disabled = false,
}: {
  title: string;
  onPress: () => void;
  secondary?: boolean;
  disabled?: boolean;
}) {
  return (
    <Pressable
      onPress={onPress}
      disabled={disabled}
      accessibilityRole="button"
      accessibilityState={{ disabled }}
      android_ripple={{ color: secondary ? colors.border : "#383C4B" }}
      className={`min-h-12 justify-center rounded-xl px-5 py-3 ${secondary ? "bg-field" : "bg-ink"}`}
      style={{ opacity: disabled ? 0.5 : 1 }}
    >
      <AppText
        weight="semibold"
        className={`text-center text-[15px] ${secondary ? "text-ink" : "text-white"}`}
      >
        {title}
      </AppText>
    </Pressable>
  );
}
export function EmptyState({
  title,
  description,
  action,
  onAction,
  icon = "file-text",
}: {
  title: string;
  description: string;
  action?: string;
  onAction?: () => void;
  icon?: keyof typeof Feather.glyphMap;
}) {
  return (
    <View className="flex-1 items-center justify-center px-7 py-12">
      <View className="mb-6 h-24 w-24 items-center justify-center rounded-3xl bg-field">
        <Feather name={icon} size={48} color="#A2A7B8" />
      </View>
      <AppText weight="bold" className="text-center text-[22px]">
        {title}
      </AppText>
      <AppText className="mb-6 mt-3 max-w-[300px] text-center text-[15px] leading-[22px] text-muted">
        {description}
      </AppText>
      {action && onAction ? (
        <View className="w-full max-w-[320px]">
          <Button title={action} onPress={onAction} />
        </View>
      ) : null}
    </View>
  );
}
export function ErrorState({
  message,
  onRetry,
}: {
  message: string;
  onRetry: () => void;
}) {
  return (
    <EmptyState
      title="Something went wrong"
      description={message}
      icon="alert-circle"
      action="Try again"
      onAction={onRetry}
    />
  );
}
export function LoadingState() {
  return (
    <View className="flex-1 items-center justify-center">
      <ActivityIndicator
        accessibilityLabel="Loading notes"
        color={colors.muted}
      />
    </View>
  );
}
