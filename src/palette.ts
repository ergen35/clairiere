// Colours for the maps. One hue per top-level folder, in a fixed order that stays readable
// for colour-blind people; beyond eight folders, the rest share a neutral grey.
const SERIES_LIGHT = ['#2a78d6', '#eb6834', '#1baf7a', '#eda100', '#e87ba4', '#008300', '#6250d6', '#e34948'];
const SERIES_DARK = ['#3987e5', '#d95926', '#199e70', '#c98500', '#d55181', '#008300', '#9085e9', '#e66767'];
const NEUTRAL_LIGHT = '#a7a99f';
const NEUTRAL_DARK = '#5f635a';

export function isDark(): boolean {
  return window.matchMedia('(prefers-color-scheme: dark)').matches;
}

export interface MapTheme {
  surface: string;
  surfaceRgb: [number, number, number];
  dark: boolean;
  series: string[];
  neutral: string;
  ink: string;
  inkSoft: string;
  outline: string;
}

export function hexToRgb(hex: string): [number, number, number] {
  const n = parseInt(hex.slice(1), 16);
  return [(n >> 16) & 255, (n >> 8) & 255, n & 255];
}

export function mapTheme(): MapTheme {
  const dark = isDark();
  const surface = dark ? '#191c18' : '#fbfbf8';
  return {
    surface,
    surfaceRgb: hexToRgb(surface),
    dark,
    series: dark ? SERIES_DARK : SERIES_LIGHT,
    neutral: dark ? NEUTRAL_DARK : NEUTRAL_LIGHT,
    ink: dark ? '#f0efec' : '#14160f',
    inkSoft: dark ? '#a9ada2' : '#5a5d53',
    outline: dark ? '#ffffff' : '#14160f',
  };
}

export function slotColor(slot: number, theme: MapTheme): string {
  return slot >= 0 && slot < theme.series.length ? theme.series[slot] : theme.neutral;
}

/** Blends a colour toward the surface; deeper levels recede. */
export function mix(hex: string, theme: MapTheme, amount: number): string {
  const [r, g, b] = hexToRgb(hex);
  const [sr, sg, sb] = theme.surfaceRgb;
  const f = (a: number, s: number) => Math.round(a + (s - a) * amount);
  return `rgb(${f(r, sr)},${f(g, sg)},${f(b, sb)})`;
}

function luminance(color: string): number {
  const m = color.startsWith('#') ? hexToRgb(color) : (color.match(/\d+/g) ?? []).map(Number);
  const [r, g, b] = m.map((v) => {
    const c = v / 255;
    return c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
  });
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
}

/** Dark or light text, whichever reads better on this fill. */
export function textOn(fill: string): string {
  const l = luminance(fill);
  return (l + 0.05) / 0.05 > 1.05 / (l + 0.05) ? '#10120d' : '#ffffff';
}
