import { quoteFee, resolveBand, computeOrderTotals, type FeeBand } from './fees';

const bands: FeeBand[] = [
  { minDistanceM: 0, maxDistanceM: 1000, feeMinor: 2000 },
  { minDistanceM: 1000, maxDistanceM: 2500, feeMinor: 2500 },
  { minDistanceM: 2500, maxDistanceM: null, feeMinor: 3500 },
];

describe('fee bands', () => {
  it('picks the band containing the distance', () => {
    expect(resolveBand(bands, 500)?.feeMinor).toBe(2000);
    expect(resolveBand(bands, 1000)?.feeMinor).toBe(2500);
    expect(resolveBand(bands, 2499)?.feeMinor).toBe(2500);
    expect(resolveBand(bands, 2500)?.feeMinor).toBe(3500);
    expect(resolveBand(bands, 9000)?.feeMinor).toBe(3500);
  });

  it('returns null when no bands are configured', () => {
    expect(resolveBand([], 500)).toBeNull();
  });
});

describe('fee quoting', () => {
  it('quotes the band fee on the first round', () => {
    const q = quoteFee({ bands, distanceM: 1200 });
    expect(q.baseFeeMinor).toBe(2500);
    expect(q.offeredFeeMinor).toBe(2500);
    expect(q.platformSubsidyMinor).toBe(0);
  });

  it('raises only the rider offer on re-broadcast, never the requester quote', () => {
    const q = quoteFee({ bands, distanceM: 1200, broadcastRound: 2, feeIncrementMinor: 500 });
    expect(q.baseFeeMinor).toBe(2500);
    expect(q.offeredFeeMinor).toBe(3500);
    // ADR-004: the platform absorbs the difference, the student does not.
    expect(q.platformSubsidyMinor).toBe(1000);
  });
});

describe('order totals', () => {
  it('adds the fees the student sees and keeps commission separate', () => {
    const t = computeOrderTotals({
      lineTotals: [6000, 4000, 2000],
      deliveryFeeMinor: 2500,
      platformFeeMinor: 200,
      commissionBps: 1000,
    });
    expect(t.itemsSubtotalMinor).toBe(12000);
    expect(t.totalMinor).toBe(12000 + 2500 + 200);
    // Commission comes out of the shop's share, so the student's total is
    // unchanged by it: 12000 + 2500 + 200, with no 1200 added.
    expect(t.commissionMinor).toBe(1200);
    expect(t.totalMinor).toBe(14700);
  });
});
