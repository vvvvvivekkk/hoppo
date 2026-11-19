import { WALLET_HEAD_ORDER, nextEntryTimestamp } from './wallet-ledger';

describe('wallet ledger ordering', () => {
  const now = new Date('2026-11-20T10:00:00.000Z');

  it('uses the current time for the first entry in a wallet', () => {
    expect(nextEntryTimestamp(null, now)).toEqual(now);
  });

  it('uses the current time when the previous entry is older', () => {
    const last = new Date(now.getTime() - 5_000);
    expect(nextEntryTimestamp(last, now)).toEqual(now);
  });

  it('moves one millisecond past a previous entry written in the same millisecond', () => {
    // The case that used to make "latest entry" ambiguous: two entries for
    // one user inside the same millisecond.
    const next = nextEntryTimestamp(new Date(now.getTime()), now);
    expect(next.getTime()).toBe(now.getTime() + 1);
  });

  it('stays ahead of a previous entry stamped later than this clock reads', () => {
    // Two API instances whose clocks disagree slightly must still append in order.
    const last = new Date(now.getTime() + 40);
    expect(nextEntryTimestamp(last, now).getTime()).toBe(now.getTime() + 41);
  });

  it('is strictly increasing over a burst written in one millisecond', () => {
    let last: Date | null = null;
    const stamps: number[] = [];
    for (let i = 0; i < 5; i += 1) {
      last = nextEntryTimestamp(last, now);
      stamps.push(last.getTime());
    }
    expect(new Set(stamps).size).toBe(5);
    expect([...stamps].sort((a, b) => a - b)).toEqual(stamps);
  });

  it('reads the head by createdAt, then by the database sequence', () => {
    // seq is assigned by the database in insert order, so it settles any two
    // rows that share a millisecond the same way on every read.
    expect(WALLET_HEAD_ORDER).toEqual([{ createdAt: 'desc' }, { seq: 'desc' }]);
  });
});
