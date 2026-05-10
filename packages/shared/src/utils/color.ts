const COLORS = [
  '#E0282E', // Red
  '#E91E63', // Pink
  '#9C27B0', // Purple
  '#673AB7', // Deep Purple
  '#3F51B5', // Indigo
  '#2196F3', // Blue
  '#03A9F4', // Light Blue
  '#00BCD4', // Cyan
  '#009688', // Teal
  '#4CAF50', // Green
  '#8BC34A', // Light Green
  '#CDDC39', // Lime
  '#FFC107', // Amber
  '#FF9800', // Orange
  '#FF5722', // Deep Orange
  '#795548', // Brown
  '#607D8B', // Blue Grey
  '#333333', // Dark Grey
  '#D4D4D8', // Zinc
  '#06B6D4', // Sky
];

/**
 * Deterministically maps a string ID to one of 20 professional colors.
 */
export function getStableColor(id: string): string {
  let hash = 0;
  for (let i = 0; i < id.length; i++) {
    hash = id.charCodeAt(i) + ((hash << 5) - hash);
  }

  const index = Math.abs(hash) % COLORS.length;
  return COLORS[index] ?? '#3F51B5';
}

/**
 * Returns black or white text color based on background luminance.
 * Uses the W3C relative luminance formula (sRGB).
 */
export function getContrastColor(hex: string): '#000000' | '#ffffff' {
  const r = Number.parseInt(hex.slice(1, 3), 16) / 255;
  const g = Number.parseInt(hex.slice(3, 5), 16) / 255;
  const b = Number.parseInt(hex.slice(5, 7), 16) / 255;
  const luminance = 0.299 * r + 0.587 * g + 0.114 * b;
  return luminance > 0.5 ? '#000000' : '#ffffff';
}
