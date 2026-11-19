/**
 * The app's visual constants.
 *
 * React Native has no CSS, so these are plain values imported where needed.
 * Kept small on purpose — a student app used between classes needs to be
 * legible at a glance on a mid-range Android phone in daylight (U1), not
 * elaborately themed.
 */
export const colour = {
  ink: '#11181c',
  inkSoft: '#3d4a52',
  inkFaint: '#68787f',

  surface: '#ffffff',
  surfaceSunken: '#f2f5f6',
  line: '#d6dee1',

  accent: '#0f766e',
  accentStrong: '#0b5a54',
  accentSoft: '#e4f2f0',

  // Each status colour is always paired with text in the UI, never used alone
  // — the same rule as the web consoles, and for the same reasons.
  waiting: '#b4530a',
  waitingBg: '#fdf1e3',
  live: '#0b5f8a',
  liveBg: '#e7f2f9',
  good: '#1a6b3c',
  goodBg: '#e6f4ec',
  danger: '#a11a1a',
  dangerBg: '#fcebeb',
} as const;

export const space = {
  xs: 4,
  sm: 8,
  md: 12,
  lg: 16,
  xl: 24,
  xxl: 32,
} as const;

export const radius = {
  sm: 8,
  md: 12,
  lg: 16,
  pill: 999,
} as const;

export const text = {
  // NFR-U-04 asks for a 44 px minimum touch target. These are the type sizes
  // that go with it; nothing interactive is smaller than `tap`.
  display: 30,
  title: 22,
  body: 16,
  small: 14,
  tiny: 12,
} as const;

/** The minimum touch target, per NFR-U-04. */
export const TAP = 48;
