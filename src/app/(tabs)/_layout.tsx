import Feather from "@expo/vector-icons/Feather";
import { router, useFocusEffect, usePathname } from "expo-router";
import { useCallback } from "react";
import { BackHandler, Keyboard } from "react-native";
import { Tabs } from "expo-router/js-tabs";
import { colors, fontFamilies } from "../../components/ui/primitives";

export default function TabsLayout() {
  const pathname = usePathname();
  useFocusEffect(
    useCallback(() => {
      const subscription = BackHandler.addEventListener(
        "hardwareBackPress",
        () => {
          if (Keyboard.isVisible()) Keyboard.dismiss();
          else if (pathname === "/highlights") router.navigate("/(tabs)");
          else BackHandler.exitApp();
          return true;
        },
      );
      return () => subscription.remove();
    }, [pathname]),
  );
  return (
    <Tabs
      screenOptions={{
        headerShown: false,
        tabBarActiveTintColor: colors.text,
        tabBarInactiveTintColor: colors.muted,
        tabBarStyle: {
          backgroundColor: "#FFFFFF",
          borderTopColor: colors.border,
        },
        tabBarLabelStyle: { fontFamily: fontFamilies.semibold, fontSize: 12 },
        tabBarHideOnKeyboard: true,
      }}
    >
      <Tabs.Screen
        name="index"
        options={{
          title: "Notes",
          tabBarIcon: ({ color, size }) => (
            <Feather name="file-text" color={color} size={size} />
          ),
        }}
      />
      <Tabs.Screen
        name="highlights"
        options={{
          title: "Highlights",
          tabBarIcon: ({ color, size }) => (
            <Feather name="star" color={color} size={size} />
          ),
        }}
      />
    </Tabs>
  );
}
