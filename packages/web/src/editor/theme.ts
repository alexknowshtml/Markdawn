import { darkDefaultTheme, lightDefaultTheme, Theme } from "@blocknote/mantine";

const baseZincTheme = {
  borderRadius: 8,
  fontFamily: "Inter, ui-sans-serif, system-ui, sans-serif",
} satisfies Theme;

const lightZincTheme = {
  ...baseZincTheme,
  colors: {
    editor: {
      text: "#18181b",
      background: "transparent",
    },
    menu: {
      text: "#18181b",
      background: "#f4f4f5",
    },
    tooltip: {
      text: "#fafafa",
      background: "#18181b",
    },
    hovered: {
      text: "#18181b",
      background: "#e4e4e7",
    },
    selected: {
      text: "#18181b",
      background: "#d4d4d8",
    },
    disabled: {
      text: "#a1a1aa",
      background: "#f4f4f5",
    },
    shadow: "#e4e4e7",
    border: "#d4d4d8",
    sideMenu: "#a1a1aa",
    highlights: lightDefaultTheme.colors?.highlights,
  },
} satisfies Theme;

const darkZincTheme = {
  ...baseZincTheme,
  colors: {
    editor: {
      text: "#fafafa",
      background: "transparent",
    },
    menu: {
      text: "#fafafa",
      background: "#18181b",
    },
    tooltip: {
      text: "#fafafa",
      background: "#09090b",
    },
    hovered: {
      text: "#fafafa",
      background: "#27272a",
    },
    selected: {
      text: "#fafafa",
      background: "#3f3f46",
    },
    disabled: {
      text: "#71717a",
      background: "#18181b",
    },
    shadow: "#09090b",
    border: "#27272a",
    sideMenu: "#71717a",
    highlights: darkDefaultTheme.colors?.highlights,
  },
} satisfies Theme;

export const zincTheme = {
  light: lightZincTheme,
  dark: darkZincTheme,
};
