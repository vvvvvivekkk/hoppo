/**
 * Delivery fee calculation.
 *
 * FR-ORD-10: the fee comes from the college's configured base plus a distance
 * band. FR-DLV-06: it rises by a configured increment on each re-broadcast
 * round when nobody accepts.
 *
 * One rule the SRS leaves open and this module settles: the requester is
 * quoted a fee before confirming (FR-ORD-03), and the fee then rises if no
 * rider accepts. Charging the requester more than they agreed to would be
 * indefensible, so **the platform absorbs the increment**. `baseFeeMinor` is
 * what the requester pays; `feeMinor` is what the rider is offered; the gap is
 * the platform's cost of filling a hard task. See docs/decisions.md ADR-004.
 */

import type { Minor } from './money';

export interface FeeBand {
  /** Inclusive, in metres. */
  minDistanceM: number;
  /** Exclusive, in metres. Null means unbounded. */
  maxDistanceM: number | null;
  feeMinor: Minor;
}

export interface FeeQuote {
  /** What the requester is quoted and will be charged. */
  baseFeeMinor: Minor;
  /** What a rider is currently offered. Equals baseFeeMinor on round 1. */
  offeredFeeMinor: Minor;
  /** offeredFeeMinor - baseFeeMinor. Borne by the platform. */
  platformSubsidyMinor: Minor;
  matchedBand: FeeBand | null;
}

/**
 * Pick the band whose range contains this distance. Bands are expected to be
 * contiguous and non-overlapping; the one with the highest `minDistanceM`
 * that is still at or below the distance wins, so a misconfigured gap falls
 * back to the nearest lower band rather than throwing at checkout.
 */
export function resolveBand(bands: readonly FeeBand[], distanceM: number): FeeBand | null {
  const candidates = bands
    .filter((b) => distanceM >= b.minDistanceM)
    .filter((b) => b.maxDistanceM === null || distanceM < b.maxDistanceM)
    .sort((a, b) => b.minDistanceM - a.minDistanceM);

  if (candidates.length > 0) return candidates[0];

  // No band matched — the distance is beyond every configured band's ceiling.
  // Fall back to the widest band so the order can still be quoted.
  const fallback = [...bands].sort((a, b) => b.minDistanceM - a.minDistanceM)[0];
  return fallback ?? null;
}

export function quoteFee(params: {
  bands: readonly FeeBand[];
  distanceM: number;
  /** 0 for the initial quote; 1, 2, 3 ... for each re-broadcast. */
  broadcastRound?: number;
  feeIncrementMinor?: Minor;
}): FeeQuote {
  const { bands, distanceM, broadcastRound = 0, feeIncrementMinor = 0 } = params;

  const matchedBand = resolveBand(bands, distanceM);
  const baseFeeMinor = matchedBand?.feeMinor ?? 0;

  const increment = Math.max(0, broadcastRound) * Math.max(0, feeIncrementMinor);
  const offeredFeeMinor = baseFeeMinor + increment;

  return {
    baseFeeMinor,
    offeredFeeMinor,
    platformSubsidyMinor: offeredFeeMinor - baseFeeMinor,
    matchedBand,
  };
}

/** The line-by-line total a student sees at checkout (FR-ORD-03). */
export interface OrderTotals {
  itemsSubtotalMinor: Minor;
  deliveryFeeMinor: Minor;
  platformFeeMinor: Minor;
  totalMinor: Minor;
  /** Retained from the shop's share, not added to what the student pays. */
  commissionMinor: Minor;
}

export function computeOrderTotals(params: {
  lineTotals: readonly Minor[];
  deliveryFeeMinor: Minor;
  platformFeeMinor?: Minor;
  commissionBps?: number;
}): OrderTotals {
  const { lineTotals, deliveryFeeMinor, platformFeeMinor = 0, commissionBps = 0 } = params;

  const itemsSubtotalMinor = lineTotals.reduce((t, v) => t + v, 0);
  const commissionMinor = Math.round((itemsSubtotalMinor * commissionBps) / 10_000);

  return {
    itemsSubtotalMinor,
    deliveryFeeMinor,
    platformFeeMinor,
    totalMinor: itemsSubtotalMinor + deliveryFeeMinor + platformFeeMinor,
    commissionMinor,
  };
}
