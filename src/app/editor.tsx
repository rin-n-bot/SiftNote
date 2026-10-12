import { Redirect } from "expo-router";

// Legacy route only; remove in Step 3. It no longer owns an editor.
export default function LegacyEditorRoute() {
  return <Redirect href="/(tabs)" />;
}
