/** @type {import('tailwindcss').Config} */
module.exports = {
  content: [
    "./src/app/**/*.{js,jsx,ts,tsx}",
    "./src/components/**/*.{js,jsx,ts,tsx}",
    "./src/features/**/*.{js,jsx,ts,tsx}",
    "./src/state/**/*.{js,jsx,ts,tsx}",
  ],
  presets: [require("nativewind/preset")],
  theme: {
    extend: {
      colors: {
        ink: "#181B28",
        muted: "#667087",
        field: "#F3F4F7",
        line: "#ECEEF2",
      },
      fontFamily: {
        ui: ["Inter_400Regular"],
        "ui-medium": ["Inter_500Medium"],
        "ui-semibold": ["Inter_600SemiBold"],
        "ui-bold": ["Inter_700Bold"],
      },
    },
  },
  plugins: [],
};
