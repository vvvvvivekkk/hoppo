import type { CollegeConfig } from '@prisma/client';

/**
 * FR-ADM-03: the per-college settings an administrator may change, and the
 * range each must stay inside.
 *
 * The ranges are deliberately wide — they are guard rails against a typo that
 * would break dispatch for a whole campus (a 0-second acceptance window, a
 * ₹10,000 fee increment), not product policy. Policy is the administrator's.
 *
 * `serviceableRadiusM` is absent on purpose. Changing the radius flags
 * already-approved shops (FR-TEN-05), so it has its own endpoint and is
 * read-only here.
 */
export const CONFIG_LIMITS = {
  acceptanceWindowSeconds: { min: 15, max: 300 },
  maxBroadcastRounds: { min: 1, max: 10 },
  initialProximityM: { min: 100, max: 5000 },
  proximityIncrementM: { min: 0, max: 5000 },
  feeIncrementMinor: { min: 0, max: 10_000 },
  dispatchLeadMinutes: { min: 0, max: 60 },
  workModeIdleTimeoutMinutes: { min: 5, max: 720 },
  riderPingIntervalSeconds: { min: 5, max: 120 },
  shopAcceptWindowSeconds: { min: 30, max: 1800 },
  maxOtpAttempts: { min: 1, max: 10 },
  platformFeeMinor: { min: 0, max: 10_000 },
  commissionBps: { min: 0, max: 5000 },
  minWithdrawalMinor: { min: 0, max: 1_000_000 },
  maxVerificationSubmissions: { min: 1, max: 10 },
  verificationWindowDays: { min: 1, max: 90 },
  abandonmentBanThreshold: { min: 1, max: 20 },
  abandonmentWindowDays: { min: 1, max: 90 },
  abandonmentBanHours: { min: 1, max: 720 },
  chatRetentionDays: { min: 1, max: 730 },
  reportHideThreshold: { min: 1, max: 100 },
} as const satisfies Partial<Record<keyof CollegeConfig, { min: number; max: number }>>;

export type EditableConfigField = keyof typeof CONFIG_LIMITS;

export const EDITABLE_CONFIG_FIELDS = Object.keys(CONFIG_LIMITS) as EditableConfigField[];

export const FEE_BAND_LIMITS = {
  minBands: 1,
  maxBands: 10,
  maxFeeMinor: 100_000,
  maxDistanceM: 20_000,
} as const;

export interface FeeBandInput {
  minDistanceM: number;
  maxDistanceM: number | null;
  feeMinor: number;
}

/** The values a college starts with: the schema's column defaults. */
export const DEFAULT_FEE_BANDS: readonly FeeBandInput[] = [
  { minDistanceM: 0, maxDistanceM: 1000, feeMinor: 2000 },
  { minDistanceM: 1000, maxDistanceM: 2500, feeMinor: 2500 },
  { minDistanceM: 2500, maxDistanceM: null, feeMinor: 3500 },
];

/**
 * Check one config value. Returns a message, or null when it is acceptable.
 * The DTO applies the same bounds; this exists so the service does not rely
 * on having been reached through the DTO.
 */
export function configValueProblem(field: EditableConfigField, value: unknown): string | null {
  const { min, max } = CONFIG_LIMITS[field];
  if (typeof value !== 'number' || !Number.isInteger(value)) {
    return `${field} must be a whole number`;
  }
  if (value < min || value > max) return `${field} must be between ${min} and ${max}`;
  return null;
}

/**
 * FR-ORD-10: the delivery fee is looked up by distance, so the bands must
 * cover every distance exactly once.
 *
 * Returns a message naming the first rule broken, or null. The rules: between
 * 1 and 10 bands; whole, non-negative numbers; the first starts at 0; each
 * band ends where the next begins (no gap, no overlap); only the last is
 * open-ended, and it must be.
 */
export function feeBandsProblem(bands: readonly FeeBandInput[]): string | null {
  if (!Array.isArray(bands) || bands.length < FEE_BAND_LIMITS.minBands) {
    return 'At least one fee band is required';
  }
  if (bands.length > FEE_BAND_LIMITS.maxBands) {
    return `At most ${FEE_BAND_LIMITS.maxBands} fee bands are allowed`;
  }

  const sorted = [...bands].sort((a, b) => a.minDistanceM - b.minDistanceM);

  for (const [index, band] of sorted.entries()) {
    const label = `Band ${index + 1}`;
    if (!Number.isInteger(band.minDistanceM) || band.minDistanceM < 0) {
      return `${label}: minDistanceM must be a whole number of metres, 0 or more`;
    }
    if (
      !Number.isInteger(band.feeMinor) ||
      band.feeMinor < 0 ||
      band.feeMinor > FEE_BAND_LIMITS.maxFeeMinor
    ) {
      return `${label}: feeMinor must be a whole number of paise between 0 and ${FEE_BAND_LIMITS.maxFeeMinor}`;
    }

    const isLast = index === sorted.length - 1;
    if (isLast) {
      if (band.maxDistanceM !== null) {
        return 'The last band must be open-ended (maxDistanceM: null) so every distance has a fee';
      }
      continue;
    }

    if (band.maxDistanceM === null) {
      return `${label}: only the last band may be open-ended`;
    }
    if (!Number.isInteger(band.maxDistanceM) || band.maxDistanceM <= band.minDistanceM) {
      return `${label}: maxDistanceM must be a whole number greater than minDistanceM`;
    }
    if (band.maxDistanceM > FEE_BAND_LIMITS.maxDistanceM) {
      return `${label}: maxDistanceM may not exceed ${FEE_BAND_LIMITS.maxDistanceM} m`;
    }

    const next = sorted[index + 1];
    if (next.minDistanceM < band.maxDistanceM) {
      return `${label} overlaps the next band: it ends at ${band.maxDistanceM} m but the next starts at ${next.minDistanceM} m`;
    }
    if (next.minDistanceM > band.maxDistanceM) {
      return `There is a gap between ${band.maxDistanceM} m and ${next.minDistanceM} m that no band covers`;
    }
  }

  if (sorted[0].minDistanceM !== 0) return 'The first band must start at 0 m';

  return null;
}

/** Sorted, and reduced to exactly the three fields that are stored. */
export function normaliseFeeBands(bands: readonly FeeBandInput[]): FeeBandInput[] {
  return [...bands]
    .sort((a, b) => a.minDistanceM - b.minDistanceM)
    .map((b) => ({
      minDistanceM: b.minDistanceM,
      maxDistanceM: b.maxDistanceM,
      feeMinor: b.feeMinor,
    }));
}
