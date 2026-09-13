/**
 * Chart styling: presets plus user overrides. Colours are deliberately muted —
 * this is a screen people stare at for hours.
 */

export type ThemeName = 'darkProfessional' | 'softDark' | 'minimal' | 'lightProfessional';

export interface ChartStyle {
  name: string;
  theme: 'dark' | 'light';
  background: string;
  panelBg: string;
  gridColor: string;
  gridOpacity: number;
  textColor: string;
  mutedText: string;
  crosshair: string;
  bull: string;
  bear: string;
  wickBull: string;
  wickBear: string;
  border: string;
  lineColor: string;
  areaTop: string;
  areaBottom: string;
  volumeUp: string;
  volumeDown: string;
  sessionLine: string;
  axisBg: string;
  axisBorder: string;
  markerText: string;
  replayShade: string;
  replayLine: string;
  fontFamily: string;
  fontSize: number;
  candleBorder: boolean;
}

const BASE = {
  fontFamily:
    "'Inter', 'Segoe UI', 'SF Pro Text', system-ui, -apple-system, 'Helvetica Neue', Arial, sans-serif",
  fontSize: 11,
  gridOpacity: 1,
  candleBorder: false,
} as const;

export const PRESETS: Record<ThemeName, ChartStyle> = {
  darkProfessional: {
    ...BASE,
    name: 'Dark Professional',
    theme: 'dark',
    background: '#161a22',
    panelBg: '#1b2029',
    gridColor: '#242b38',
    textColor: '#c9d1dc',
    mutedText: '#78849a',
    crosshair: '#8f9bb3',
    bull: '#3c9d78',
    bear: '#cf6068',
    wickBull: '#4bb88e',
    wickBear: '#d97a80',
    border: 'rgba(0,0,0,0)',
    lineColor: '#7aa2d6',
    areaTop: 'rgba(122,162,214,0.28)',
    areaBottom: 'rgba(122,162,214,0.02)',
    volumeUp: 'rgba(60,157,120,0.45)',
    volumeDown: 'rgba(207,96,104,0.45)',
    sessionLine: 'rgba(150,164,190,0.22)',
    axisBg: '#161a22',
    axisBorder: '#2b3444',
    markerText: '#e6ebf3',
    replayShade: 'rgba(9,11,16,0.55)',
    replayLine: 'rgba(196,164,90,0.85)',
  } as ChartStyle,
  softDark: {
    ...BASE,
    name: 'Soft Dark',
    theme: 'dark',
    background: '#1e2127',
    panelBg: '#23272e',
    gridColor: '#2a2f37',
    textColor: '#bfc6d0',
    mutedText: '#767e8b',
    crosshair: '#98a2b3',
    bull: '#4f9c82',
    bear: '#c07a80',
    wickBull: '#5aab8f',
    wickBear: '#ca8a90',
    border: 'rgba(0,0,0,0)',
    lineColor: '#8fa8c8',
    areaTop: 'rgba(143,168,200,0.24)',
    areaBottom: 'rgba(143,168,200,0.02)',
    volumeUp: 'rgba(79,156,130,0.4)',
    volumeDown: 'rgba(192,122,128,0.4)',
    sessionLine: 'rgba(150,158,172,0.18)',
    axisBg: '#1e2127',
    axisBorder: '#333940',
    markerText: '#e8ecf2',
    replayShade: 'rgba(12,13,16,0.5)',
    replayLine: 'rgba(200,172,104,0.8)',
  } as ChartStyle,
  minimal: {
    ...BASE,
    name: 'Minimal',
    theme: 'dark',
    background: '#101114',
    panelBg: '#15171b',
    gridColor: '#1b1e23',
    textColor: '#a9b0bb',
    mutedText: '#5f6673',
    crosshair: '#6b7280',
    bull: '#8b9aa8',
    bear: '#6f7d8b',
    wickBull: '#9aa8b6',
    wickBear: '#7e8c9a',
    border: 'rgba(0,0,0,0)',
    lineColor: '#a9b0bb',
    areaTop: 'rgba(169,176,187,0.18)',
    areaBottom: 'rgba(169,176,187,0.01)',
    volumeUp: 'rgba(139,154,168,0.3)',
    volumeDown: 'rgba(111,125,139,0.3)',
    sessionLine: 'rgba(120,128,142,0.14)',
    axisBg: '#101114',
    axisBorder: '#22252b',
    markerText: '#d7dbe2',
    replayShade: 'rgba(0,0,0,0.5)',
    replayLine: 'rgba(170,178,190,0.7)',
  } as ChartStyle,
  lightProfessional: {
    ...BASE,
    name: 'Light Professional',
    theme: 'light',
    background: '#fbfcfd',
    panelBg: '#f3f5f8',
    gridColor: '#e7ebf0',
    textColor: '#39414f',
    mutedText: '#7e8896',
    crosshair: '#8b95a6',
    bull: '#2f8f6c',
    bear: '#c25a63',
    wickBull: '#38a37d',
    wickBear: '#cf727a',
    border: 'rgba(0,0,0,0)',
    lineColor: '#4a72b0',
    areaTop: 'rgba(74,114,176,0.24)',
    areaBottom: 'rgba(74,114,176,0.02)',
    volumeUp: 'rgba(47,143,108,0.35)',
    volumeDown: 'rgba(194,90,99,0.35)',
    sessionLine: 'rgba(80,96,120,0.16)',
    axisBg: '#fbfcfd',
    axisBorder: '#d9dfe7',
    markerText: '#1f2733',
    replayShade: 'rgba(240,243,247,0.65)',
    replayLine: 'rgba(150,120,40,0.75)',
  } as ChartStyle,
};

export const PRESET_ORDER: ThemeName[] = ['darkProfessional', 'softDark', 'minimal', 'lightProfessional'];

export type ChartMode = 'candles' | 'bars' | 'line' | 'area';
export const CHART_MODES: { id: ChartMode; label: string }[] = [
  { id: 'candles', label: 'Candlesticks' },
  { id: 'bars', label: 'OHLC bars' },
  { id: 'line', label: 'Line' },
  { id: 'area', label: 'Area' },
];

export interface ChartSettings {
  theme: ThemeName;
  overrides: Partial<ChartStyle>;
  mode: ChartMode;
  showGrid: boolean;
  showVolume: boolean;
  showSessionSeparators: boolean;
  showCrosshairLabels: boolean;
  /** Draw a hollow body outline around filled candles (sharper at small sizes). */
  outlineCandles: boolean;
  priceDecimals: number;
}

export const DEFAULT_CHART_SETTINGS: ChartSettings = {
  theme: 'darkProfessional',
  overrides: {},
  mode: 'candles',
  showGrid: true,
  showVolume: true,
  showSessionSeparators: true,
  showCrosshairLabels: true,
  outlineCandles: false,
  priceDecimals: 5,
};

export function resolveStyle(settings: Pick<ChartSettings, 'theme' | 'overrides'>): ChartStyle {
  return { ...PRESETS[settings.theme], ...settings.overrides };
}
