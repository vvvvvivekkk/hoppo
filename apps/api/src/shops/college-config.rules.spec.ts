import 'reflect-metadata';
import { validate } from 'class-validator';
import { plainToInstance } from 'class-transformer';
import {
  CONFIG_LIMITS,
  EDITABLE_CONFIG_FIELDS,
  configValueProblem,
  feeBandsProblem,
  normaliseFeeBands,
} from './college-config.rules';
import { UpdateCollegeConfigDto } from './dto/college-admin.dto';

const band = (minDistanceM: number, maxDistanceM: number | null, feeMinor = 2000) => ({
  minDistanceM,
  maxDistanceM,
  feeMinor,
});

describe('fee bands (FR-ADM-03): every distance has exactly one fee', () => {
  it('accepts contiguous bands ending open-ended, in any order', () => {
    expect(feeBandsProblem([band(0, null)])).toBeNull();
    expect(feeBandsProblem([band(0, 1000), band(1000, 2500), band(2500, null)])).toBeNull();
    expect(feeBandsProblem([band(2500, null), band(0, 1000), band(1000, 2500)])).toBeNull();
  });

  it.each([
    ['no bands', [], /At least one/],
    ['a first band not starting at 0', [band(500, null)], /start at 0/],
    ['a gap', [band(0, 1000), band(1200, null)], /gap between 1000 m and 1200 m/],
    ['an overlap', [band(0, 1500), band(1000, null)], /overlaps/],
    ['two bands starting at the same distance', [band(0, 1000), band(0, null)], /overlaps/],
    ['a closed last band', [band(0, 1000), band(1000, 2000)], /last band must be open-ended/],
    ['an open-ended band that is not last', [band(0, null), band(1000, null)], /only the last/],
    ['a band that ends before it starts', [band(0, 0), band(0, null)], /greater than minDistanceM/],
    ['a negative fee', [band(0, null, -1)], /feeMinor/],
    ['a fractional fee', [band(0, null, 20.5)], /feeMinor/],
    ['a fractional distance', [band(0, 999.5), band(999.5, null)], /whole number/],
    ['an absurd fee', [band(0, null, 100_001)], /feeMinor/],
    [
      'eleven bands',
      [...Array.from({ length: 10 }, (_, i) => band(i * 100, (i + 1) * 100)), band(1000, null)],
      /At most 10/,
    ],
  ])('rejects %s', (_name, bands, message) => {
    expect(feeBandsProblem(bands)).toMatch(message);
  });

  it('normalises to sorted bands with only the stored fields', () => {
    const messy = [{ ...band(1000, null, 3000), extra: 1 }, band(0, 1000)];
    expect(normaliseFeeBands(messy)).toEqual([band(0, 1000), band(1000, null, 3000)]);
  });
});

describe('config value bounds', () => {
  it('covers every editable field with a sane range, and never the radius', () => {
    expect(EDITABLE_CONFIG_FIELDS.length).toBe(20);
    expect(EDITABLE_CONFIG_FIELDS).not.toContain('serviceableRadiusM');
    for (const field of EDITABLE_CONFIG_FIELDS) {
      const { min, max } = CONFIG_LIMITS[field];
      expect(Number.isInteger(min) && Number.isInteger(max) && min >= 0 && max > min).toBe(true);
      expect(configValueProblem(field, min)).toBeNull();
      expect(configValueProblem(field, max)).toBeNull();
      expect(configValueProblem(field, min - 1)).toMatch(/between/);
      expect(configValueProblem(field, max + 1)).toMatch(/between/);
      expect(configValueProblem(field, min + 0.5)).toMatch(/whole number/);
      expect(configValueProblem(field, String(min))).toMatch(/whole number/);
      expect(configValueProblem(field, null)).toMatch(/whole number/);
    }
  });

  it('the DTO enforces the same bounds, and refuses the radius and unknown fields', async () => {
    const check = async (body: object) =>
      (
        await validate(plainToInstance(UpdateCollegeConfigDto, body), {
          whitelist: true,
          forbidNonWhitelisted: true,
        })
      ).map((e) => e.property);

    expect(await check({ acceptanceWindowSeconds: 60, commissionBps: 1000 })).toEqual([]);
    expect(await check({ acceptanceWindowSeconds: 5 })).toEqual(['acceptanceWindowSeconds']);
    expect(await check({ commissionBps: 5001 })).toEqual(['commissionBps']);
    expect(await check({ maxOtpAttempts: '5' })).toEqual(['maxOtpAttempts']);
    expect(await check({ feeIncrementMinor: 12.5 })).toEqual(['feeIncrementMinor']);
    expect(await check({ serviceableRadiusM: 4000 })).toEqual(['serviceableRadiusM']);
    expect(await check({ collegeId: 'someone-elses' })).toEqual(['collegeId']);
    expect(await check({ feeBands: [] })).toEqual(['feeBands']);
    expect(
      await check({ feeBands: [{ minDistanceM: 0, maxDistanceM: null, feeMinor: 2000 }] }),
    ).toEqual([]);
    expect(
      await check({ feeBands: [{ minDistanceM: 0, maxDistanceM: null, feeMinor: -5 }] }),
    ).toEqual(['feeBands']);
  });
});
