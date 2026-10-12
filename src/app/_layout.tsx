import "../global.css";
import Feather from "@expo/vector-icons/Feather";
import { useFonts } from "expo-font";
import { Stack } from "expo-router";
import * as SplashScreen from "expo-splash-screen";
import { StatusBar } from "expo-status-bar";
import { useEffect, useState } from "react";
import { GestureHandlerRootView } from "react-native-gesture-handler";
import { SafeAreaProvider } from "react-native-safe-area-context";
import { colors, ErrorState } from "../components/ui/primitives";
import { AppProvider, useApp } from "../state/app-context";
import { perfMark, startJsHeartbeat } from "../dev/perf";

export const unstable_settings = { initialRouteName: "(tabs)" };
void SplashScreen.preventAutoHideAsync().catch(() => {});
export default function RootLayout() {
  useEffect(startJsHeartbeat, []);
  const [attempt, setAttempt] = useState(0);
  return (
    <GestureHandlerRootView
      style={{ flex: 1, backgroundColor: colors.background }}
    >
      <SafeAreaProvider>
        <StatusBar style="dark" />
        <FontGate
          key={attempt}
          onRetry={() => setAttempt((value) => value + 1)}
        />
      </SafeAreaProvider>
    </GestureHandlerRootView>
  );
}
function FontGate({ onRetry }: { onRetry: () => void }) {
  const [loaded, error] = useFonts({
    Inter_400Regular: require("@expo-google-fonts/inter/400Regular/Inter_400Regular.ttf"),
    Inter_500Medium: require("@expo-google-fonts/inter/500Medium/Inter_500Medium.ttf"),
    Inter_600SemiBold: require("@expo-google-fonts/inter/600SemiBold/Inter_600SemiBold.ttf"),
    Inter_700Bold: require("@expo-google-fonts/inter/700Bold/Inter_700Bold.ttf"),
    ...Feather.font,
  });
  useEffect(() => {
    if (loaded || error) void SplashScreen.hideAsync();
  }, [loaded, error]);
  if (!loaded && !error) return null;
  return (
    <>
      {error ? (
        <ErrorState
          message="Inter could not be loaded. Your notes have been kept."
          onRetry={onRetry}
        />
      ) : (
        <AppProvider>
          <AppStack />
        </AppProvider>
      )}
    </>
  );
}
function AppStack() {
  const { beginNoteClose, endNoteClose } = useApp();
  return (
    <Stack
      // TEMPORARY: native navigation timing.
      screenListeners={({ route }) => ({
        transitionStart: (event) => {
          perfMark("native.transitionStart", undefined, {
            screen: route.name,
            closing: event.data.closing,
          });
          if (route.name === "note/[id]" && event.data.closing)
            beginNoteClose();
        },
        transitionEnd: (event) => {
          perfMark("native.transitionEnd", undefined, {
            screen: route.name,
            closing: event.data.closing,
          });
          // Router drops listeners for a route once it has popped. The
          // returning screen's appear event therefore also completes the pop.
          if (
            (route.name === "note/[id]" && event.data.closing) ||
            !event.data.closing
          )
            endNoteClose();
        },
      })}
      screenOptions={{
        headerShown: false,
        contentStyle: { backgroundColor: colors.background },
      }}
    >
      <Stack.Screen name="(tabs)" />
      <Stack.Screen name="note/[id]" />
      <Stack.Screen name="editor" />
    </Stack>
  );
}
