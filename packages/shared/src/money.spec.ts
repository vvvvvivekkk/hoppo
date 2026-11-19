import { rupeesToMinor, minorToRupees, formatMinor, applyBps, isValidMinor } from './money';

describe('money', () => {
  it('converts rupees to paise without float drift', () => {
    expect(rupeesToMinor(120.5)).toBe(12050);
    expect(rupeesToMinor(0.1)).toBe(10);
    expect(rupeesToMinor(1)).toBe(100);
  });

  it('survives the addition that breaks floats', () => {
    // 0.1 added ten times as a float gives 0.9999999999999999.
    let total = 0;
    for (let i = 0; i < 10; i += 1) total += rupeesToMinor(0.1);
    expect(total).toBe(100);
    expect(minorToRupees(total)).toBe(1);
  });

  it('formats with Indian digit grouping', () => {
    expect(formatMinor(12050)).toBe('₹120.50');
    expect(formatMinor(100)).toBe('₹1.00');
    expect(formatMinor(5)).toBe('₹0.05');
    expect(formatMinor(10000000)).toBe('₹1,00,000.00');
    expect(formatMinor(123456789)).toBe('₹12,34,567.89');
    expect(formatMinor(-2500)).toBe('-₹25.00');
  });

  it('applies a basis-point rate', () => {
    expect(applyBps(12000, 1000)).toBe(1200); // 10% of ₹120
    expect(applyBps(12345, 250)).toBe(309); // 2.5%, rounded
    expect(applyBps(12000, 0)).toBe(0);
  });

  it('rejects values that are not safe whole paise', () => {
    expect(isValidMinor(1200)).toBe(true);
    expect(isValidMinor(0)).toBe(true);
    expect(isValidMinor(12.5)).toBe(false);
    expect(isValidMinor(-1)).toBe(false);
    expect(isValidMinor('1200')).toBe(false);
    expect(isValidMinor(Number.MAX_VALUE)).toBe(false);
  });
});
