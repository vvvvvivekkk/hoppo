import { ForbiddenException, NotFoundException } from '@nestjs/common';
import { ShopsService } from './shops.service';
import { AdminCollegeController, AdminShopsController } from './shops.controller';
import { TenantService } from '../common/tenant/tenant.service';
import type { AuthenticatedUser } from '../common/types/authenticated-user';

/**
 * Who may open a listing that is not ACTIVE, and how big a page of the
 * administrator's shop queue may be.
 */
const listingRow = (status: string) => ({
  id: 'listing-1',
  collegeId: 'college-a',
  status,
  distanceFromCollegeM: 800,
  temporarilyClosedUntil: null,
  closureNote: null,
  ratingSum: 0,
  ratingCount: 0,
  college: { timezone: 'Asia/Kolkata' },
  shop: {
    id: 'shop-1',
    name: 'Rival Canteen',
    category: 'FOOD',
    locationType: 'OFF_CAMPUS',
    address: '12 Private Lane',
    fssaiLicenceNumber: '12345678901234',
  },
  hours: [],
  categories: [],
  items: [{ id: 'item-1', name: 'Loose item', priceMinor: 4000 }],
});

function build(status: string, staffUserIds: string[] = []) {
  const prisma = {
    shopListing: {
      findUnique: jest.fn().mockResolvedValue(listingRow(status)),
      findMany: jest.fn().mockResolvedValue([]),
      count: jest.fn().mockResolvedValue(0),
    },
    collegeConfig: {
      // Two colleges with different radii, keyed by the id asked for.
      findUnique: jest.fn(async (args: { where: { collegeId: string } }) => {
        const radii: Record<string, number> = { 'college-a': 2500, 'college-b': 4000 };
        const radius = radii[args.where.collegeId];
        return radius === undefined ? null : { serviceableRadiusM: radius };
      }),
    },
    shopStaff: {
      findUnique: jest.fn(
        async (args: { where: { shopId_userId: { shopId: string; userId: string } } }) => {
          const { shopId, userId } = args.where.shopId_userId;
          return shopId === 'shop-1' && staffUserIds.includes(userId) ? { userId } : null;
        },
      ),
    },
  };
  const Ctor = ShopsService as unknown as new (...args: unknown[]) => ShopsService;
  const service = new Ctor(prisma, {}, {}, {}, new TenantService());
  return { service, prisma };
}

const user = (
  role: AuthenticatedUser['role'],
  userId = 'u1',
  collegeId: string | null = 'college-a',
) => ({ userId, collegeId, role, isVerified: true }) as AuthenticatedUser;

describe('ShopsService.shopDetail: listings that are not ACTIVE', () => {
  it.each(['PENDING_VERIFICATION', 'SUSPENDED', 'REJECTED'])(
    'hides a %s listing from another shop owner in the same college',
    async (status) => {
      const { service } = build(status, ['the-real-owner']);

      const attempt = service.shopDetail(user('SHOP_OWNER', 'competitor'), 'listing-1');

      await expect(attempt).rejects.toBeInstanceOf(NotFoundException);
      await expect(attempt).rejects.toMatchObject({ response: { code: 'SHOP_NOT_AVAILABLE' } });
    },
  );

  it('hides it from shop staff of a different shop, and from students', async () => {
    const { service } = build('PENDING_VERIFICATION', ['the-real-owner']);

    await expect(
      service.shopDetail(user('SHOP_STAFF', 'other-staff'), 'listing-1'),
    ).rejects.toBeInstanceOf(NotFoundException);
    await expect(service.shopDetail(user('STUDENT'), 'listing-1')).rejects.toBeInstanceOf(
      NotFoundException,
    );
  });

  it("shows it to the shop's own owner and staff", async () => {
    const { service, prisma } = build('PENDING_VERIFICATION', ['the-real-owner', 'their-staff']);

    const asOwner = await service.shopDetail(user('SHOP_OWNER', 'the-real-owner'), 'listing-1');
    const asStaff = await service.shopDetail(user('SHOP_STAFF', 'their-staff'), 'listing-1');

    expect(asOwner.shop.address).toBe('12 Private Lane');
    expect(asStaff.listingId).toBe('listing-1');
    expect(prisma.shopStaff.findUnique).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { shopId_userId: { shopId: 'shop-1', userId: 'the-real-owner' } },
      }),
    );
  });

  it("shows it to the college's administrator and to a super administrator", async () => {
    const { service } = build('SUSPENDED');

    await expect(service.shopDetail(user('ADMIN'), 'listing-1')).resolves.toMatchObject({
      listingId: 'listing-1',
    });
    await expect(
      service.shopDetail(user('SUPER_ADMIN', 'root', null), 'listing-1'),
    ).resolves.toMatchObject({ listingId: 'listing-1' });
  });

  it("does not show it to another college's administrator (C-1)", async () => {
    const { service } = build('PENDING_VERIFICATION');

    await expect(
      service.shopDetail(user('ADMIN', 'admin-b', 'college-b'), 'listing-1'),
    ).rejects.toBeInstanceOf(ForbiddenException);
  });

  it('shows an ACTIVE listing to anyone in the college, uncategorised items included', async () => {
    const { service, prisma } = build('ACTIVE');

    // Read loosely so this spec also compiles against revisions that did not
    // return the field yet.
    const detail: Record<string, unknown> = await service.shopDetail(user('STUDENT'), 'listing-1');

    expect(detail.uncategorised).toEqual([{ id: 'item-1', name: 'Loose item', priceMinor: 4000 }]);
    // No staff lookup is needed for a listing everybody may see.
    expect(prisma.shopStaff.findUnique).not.toHaveBeenCalled();
  });
});

describe('administrator shop queue: page size', () => {
  const admin = user('ADMIN', 'admin-a');

  it.each([
    [Number.NaN, 25],
    [1_000_000, 100],
    [0, 1],
    [-5, 1],
    [40, 40],
  ])('the service reads at most a clamped page for limit %p', async (requested, expected) => {
    const { service, prisma } = build('ACTIVE');

    await service.queue(admin, requested);

    const args = prisma.shopListing.findMany.mock.calls[0][0] as { take: number };
    expect(args.take).toBe(expected + 1);
  });

  it.each([
    ['abc', 25],
    ['1e9', 100],
    ['100000', 100],
    ['-1', 1],
    [undefined, 25],
    ['50', 50],
  ])('the controller turns ?limit=%p into %p', (raw, expected) => {
    const queue = jest.fn().mockReturnValue({ items: [] });
    const controller = new AdminShopsController({ queue } as unknown as ShopsService);

    controller.queue(admin, raw, 'cursor-1');

    expect(queue).toHaveBeenCalledWith(admin, expected, 'cursor-1');
  });
});

describe('GET /admin/college/radius', () => {
  type RadiusReader = {
    currentRadius(user: AuthenticatedUser): Promise<Record<string, unknown>>;
  };
  const reader = (service: ShopsService) => service as unknown as RadiusReader;

  it("returns the administrator's own college's radius and the permitted range", async () => {
    const { service, prisma } = build('ACTIVE');

    const result = await reader(service).currentRadius(user('ADMIN', 'admin-a'));

    expect(result).toEqual({
      collegeId: 'college-a',
      serviceableRadiusM: 2500,
      serviceableRadiusLabel: '2.5 km',
      minRadiusM: 1000,
      maxRadiusM: 5000,
    });
    expect(prisma.collegeConfig.findUnique).toHaveBeenCalledWith(
      expect.objectContaining({ where: { collegeId: 'college-a' } }),
    );
  });

  it('is scoped by the college on the token (C-1)', async () => {
    const { service } = build('ACTIVE');

    const result = await reader(service).currentRadius(user('ADMIN', 'admin-b', 'college-b'));

    expect(result).toMatchObject({ collegeId: 'college-b', serviceableRadiusM: 4000 });
  });

  it('falls back to 3 km for a college with no configuration row', async () => {
    const { service } = build('ACTIVE');

    const result = await reader(service).currentRadius(user('ADMIN', 'admin-c', 'college-c'));

    expect(result).toMatchObject({ collegeId: 'college-c', serviceableRadiusM: 3000 });
  });

  it('refuses an account attached to no college', async () => {
    const { service, prisma } = build('ACTIVE');

    await expect(
      reader(service).currentRadius(user('SUPER_ADMIN', 'root', null)),
    ).rejects.toBeInstanceOf(ForbiddenException);
    expect(prisma.collegeConfig.findUnique).not.toHaveBeenCalled();
  });

  it('the controller passes the caller through and is restricted to ADMIN', () => {
    const currentRadius = jest.fn().mockReturnValue({ serviceableRadiusM: 2500 });
    const controller = new AdminCollegeController(
      { currentRadius } as unknown as ShopsService,
      {} as never,
    );
    const admin = user('ADMIN', 'admin-a');

    const handler = (controller as unknown as { radius(u: AuthenticatedUser): unknown }).radius;
    expect(handler.call(controller, admin)).toEqual({ serviceableRadiusM: 2500 });
    expect(currentRadius).toHaveBeenCalledWith(admin);
    // Class-level @Roles, so the new route inherits it.
    expect(Reflect.getMetadata('roles', AdminCollegeController)).toEqual(['ADMIN']);
    expect(Reflect.getMetadata('path', handler)).toBe('radius');
    expect(Reflect.getMetadata('method', handler)).toBe(0); // RequestMethod.GET
  });
});
