import { BadRequestException, ForbiddenException } from '@nestjs/common';
import { OrdersService } from './orders.service';
import { TenantService } from '../common/tenant/tenant.service';
import type { AuthenticatedUser } from '../common/types/authenticated-user';

/**
 * S-21 reorder: a past order becomes a draft cart, priced from the menu as
 * it is NOW.
 *
 * The real service runs against a small stand-in menu. The stand-in honours
 * the `where` it is given (listing, not deleted), because half of what is
 * being tested is that the service asks the right question of the menu.
 */

const STUDENT: AuthenticatedUser = {
  userId: 'student-1',
  collegeId: 'col-1',
  role: 'STUDENT',
  isVerified: true,
};

type Row = Record<string, any>;

/** Open every minute of every day, so "is the shop open" is not what a test trips on. */
const ALWAYS_OPEN = [0, 1, 2, 3, 4, 5, 6].map((dayOfWeek) => ({
  dayOfWeek,
  openMinute: 0,
  closeMinute: 1440,
}));

function build(seed: { order?: Row; listing?: Row | null; menu?: Row[]; point?: Row | null } = {}) {
  const order: Row = {
    id: 'order-1',
    collegeId: 'col-1',
    studentId: 'student-1',
    reference: 'HP-OLD1234',
    placedAt: new Date('2026-10-01T06:00:00Z'),
    shopListingId: 'listing-1',
    deliveryPointId: 'point-1',
    items: [
      { catalogItemId: 'dosa', nameSnapshot: 'Masala Dosa', unitPriceMinor: 6000, quantity: 2, note: 'no onion' },
      { catalogItemId: 'chai', nameSnapshot: 'Chai', unitPriceMinor: 1500, quantity: 3, note: null },
    ],
    ...seed.order,
  };
  const listing: Row | null =
    seed.listing === null
      ? null
      : {
          id: 'listing-1',
          collegeId: 'col-1',
          status: 'ACTIVE',
          temporarilyClosedUntil: null,
          shop: { id: 'shop-1', name: 'Sri Sai Tiffins' },
          hours: ALWAYS_OPEN,
          college: { timezone: 'Asia/Kolkata' },
          ...seed.listing,
        };
  const menu: Row[] = seed.menu ?? [
    { id: 'dosa', shopListingId: 'listing-1', name: 'Masala Dosa', priceMinor: 6000, prepMinutes: 12, isAvailable: true, isDeleted: false },
    { id: 'chai', shopListingId: 'listing-1', name: 'Chai', priceMinor: 1500, prepMinutes: 4, isAvailable: true, isDeleted: false },
  ];

  const prisma: Row = {
    order: {
      findUnique: jest.fn(async () => order),
      create: jest.fn(),
      update: jest.fn(),
      updateMany: jest.fn(),
    },
    task: { create: jest.fn(), updateMany: jest.fn() },
    walletEntry: { create: jest.fn(), findFirst: jest.fn() },
    shopListing: { findUnique: jest.fn(async () => listing) },
    catalogItem: {
      findMany: jest.fn(async ({ where }: { where: Row }) =>
        menu.filter(
          (item) =>
            (where.id.in as string[]).includes(item.id) &&
            (where.shopListingId === undefined || item.shopListingId === where.shopListingId) &&
            (where.isDeleted === undefined || item.isDeleted === where.isDeleted),
        ),
      ),
    },
    deliveryPoint: {
      findFirst: jest.fn(async () =>
        seed.point === undefined ? { id: 'point-1', name: 'Boys Hostel B' } : seed.point,
      ),
    },
    $transaction: jest.fn(),
  };

  const service = new OrdersService(prisma as never, new TenantService(), {} as never);
  return { service, prisma, menu };
}

const item = (overrides: Row) => ({
  shopListingId: 'listing-1',
  prepMinutes: 10,
  isAvailable: true,
  isDeleted: false,
  ...overrides,
});

describe('reorder draft', () => {
  it('rebuilds the cart for the same shop with the same items and quantities', async () => {
    const { service } = build();

    const draft = await service.reorderDraft(STUDENT, 'order-1');

    expect(draft).toMatchObject({
      sourceOrder: { id: 'order-1', reference: 'HP-OLD1234' },
      listingId: 'listing-1',
      shop: { id: 'shop-1', name: 'Sri Sai Tiffins' },
      shopIsOpen: true,
      unavailable: [],
      itemsSubtotalMinor: 16500,
      anyPriceChanged: false,
      estimatedPrepMinutes: 12,
      suggestedDeliveryPoint: { id: 'point-1', name: 'Boys Hostel B' },
      canCheckout: true,
    });
    expect(draft.lines).toEqual([
      { catalogItemId: 'dosa', name: 'Masala Dosa', quantity: 2, unitPriceMinor: 6000, lineTotalMinor: 12000, note: 'no onion', previousUnitPriceMinor: 6000, priceChanged: false },
      { catalogItemId: 'chai', name: 'Chai', quantity: 3, unitPriceMinor: 1500, lineTotalMinor: 4500, note: null, previousUnitPriceMinor: 1500, priceChanged: false },
    ]);
  });

  it("charges today's price, never the price on the old order", async () => {
    const { service } = build({
      menu: [
        item({ id: 'dosa', name: 'Masala Dosa', priceMinor: 7500 }), // was 6000
        item({ id: 'chai', name: 'Chai', priceMinor: 1000 }), // was 1500: a drop is honoured too
      ],
    });

    const draft = await service.reorderDraft(STUDENT, 'order-1');

    expect(draft.lines.map((l) => [l.catalogItemId, l.unitPriceMinor, l.lineTotalMinor])).toEqual([
      ['dosa', 7500, 15000],
      ['chai', 1000, 3000],
    ]);
    expect(draft.itemsSubtotalMinor).toBe(18000);
    // The old price is reported for display only.
    expect(draft.lines.map((l) => [l.previousUnitPriceMinor, l.priceChanged])).toEqual([
      [6000, true],
      [1500, true],
    ]);
    expect(draft.anyPriceChanged).toBe(true);
  });

  it('uses the current name of a renamed item', async () => {
    const { service } = build({
      menu: [item({ id: 'dosa', name: 'Ghee Masala Dosa', priceMinor: 6000 }), item({ id: 'chai', name: 'Chai', priceMinor: 1500 })],
    });
    expect((await service.reorderDraft(STUDENT, 'order-1')).lines[0].name).toBe('Ghee Masala Dosa');
  });

  it('leaves out an item marked unavailable and says so', async () => {
    const { service } = build({
      menu: [item({ id: 'dosa', name: 'Masala Dosa', priceMinor: 6000, isAvailable: false }), item({ id: 'chai', name: 'Chai', priceMinor: 1500 })],
    });

    const draft = await service.reorderDraft(STUDENT, 'order-1');

    expect(draft.lines.map((l) => l.catalogItemId)).toEqual(['chai']);
    expect(draft.unavailable).toEqual([
      { catalogItemId: 'dosa', name: 'Masala Dosa', quantity: 2, reason: 'UNAVAILABLE' },
    ]);
    expect(draft.itemsSubtotalMinor).toBe(4500);
    expect(draft.canCheckout).toBe(true);
  });

  it('leaves out an item deleted from the menu, reported under its old name', async () => {
    const { service } = build({
      menu: [item({ id: 'dosa', name: 'Masala Dosa', priceMinor: 6000, isDeleted: true }), item({ id: 'chai', name: 'Chai', priceMinor: 1500 })],
    });

    const draft = await service.reorderDraft(STUDENT, 'order-1');

    expect(draft.lines.map((l) => l.catalogItemId)).toEqual(['chai']);
    expect(draft.unavailable).toEqual([
      { catalogItemId: 'dosa', name: 'Masala Dosa', quantity: 2, reason: 'REMOVED' },
    ]);
  });

  it('does not match a re-created item by name, nor an item now on another shop', async () => {
    const { service } = build({
      menu: [
        // Same name, new id: a different item.
        item({ id: 'dosa-2', name: 'Masala Dosa', priceMinor: 9000 }),
        // Same id, but it belongs to a different listing now.
        item({ id: 'chai', name: 'Chai', priceMinor: 100, shopListingId: 'listing-other' }),
      ],
    });

    const draft = await service.reorderDraft(STUDENT, 'order-1');

    expect(draft.lines).toEqual([]);
    expect(draft.unavailable.map((u) => [u.catalogItemId, u.reason])).toEqual([
      ['dosa', 'REMOVED'],
      ['chai', 'REMOVED'],
    ]);
    expect(draft).toMatchObject({ itemsSubtotalMinor: 0, estimatedPrepMinutes: null, canCheckout: false });
  });

  it('reports a line the old order never linked to a catalog item', async () => {
    const { service } = build({
      order: { items: [{ catalogItemId: null, nameSnapshot: 'Special thali', unitPriceMinor: 9000, quantity: 1, note: null }] },
    });
    const draft = await service.reorderDraft(STUDENT, 'order-1');
    expect(draft.unavailable).toEqual([
      { catalogItemId: null, name: 'Special thali', quantity: 1, reason: 'REMOVED' },
    ]);
  });

  it('returns the draft when the shop is closed, but not as ready to check out', async () => {
    const { service } = build({ listing: { hours: [] } });

    const draft = await service.reorderDraft(STUDENT, 'order-1');

    expect(draft.shopIsOpen).toBe(false);
    expect(draft.closedReason).not.toBeNull();
    expect(draft.lines).toHaveLength(2);
    expect(draft.canCheckout).toBe(false);
  });

  it('suggests no delivery point when the old one is gone or was a landmark', async () => {
    const gone = build({ point: null });
    expect((await gone.service.reorderDraft(STUDENT, 'order-1')).suggestedDeliveryPoint).toBeNull();

    const landmark = build({ order: { deliveryPointId: null } });
    expect((await landmark.service.reorderDraft(STUDENT, 'order-1')).suggestedDeliveryPoint).toBeNull();
    expect(landmark.prisma.deliveryPoint.findFirst).not.toHaveBeenCalled();
  });

  it('places nothing: no order, task or ledger write, and no transaction', async () => {
    const { service, prisma } = build();

    await service.reorderDraft(STUDENT, 'order-1');

    for (const write of [
      prisma.order.create, prisma.order.update, prisma.order.updateMany,
      prisma.task.create, prisma.task.updateMany, prisma.walletEntry.create, prisma.$transaction,
    ]) {
      expect(write).not.toHaveBeenCalled();
    }
  });
});

describe('who may reorder what', () => {
  it("refuses another student's order", async () => {
    const { service, prisma } = build({ order: { studentId: 'someone-else' } });

    await expect(service.reorderDraft(STUDENT, 'order-1')).rejects.toBeInstanceOf(ForbiddenException);
    await expect(service.reorderDraft(STUDENT, 'order-1')).rejects.toMatchObject({
      response: { code: 'NOT_YOUR_ORDER' },
    });
    // Refused before the menu is even read.
    expect(prisma.catalogItem.findMany).not.toHaveBeenCalled();
  });

  it("refuses an order from another college", async () => {
    const { service } = build({ order: { collegeId: 'col-2' } });
    await expect(service.reorderDraft(STUDENT, 'order-1')).rejects.toMatchObject({
      response: { code: 'CROSS_TENANT_ACCESS' },
    });
  });

  it.each([
    ['suspended', { status: 'SUSPENDED' }],
    ['listed for another college now', { collegeId: 'col-2' }],
  ])('refuses when the shop is %s', async (_label, listing) => {
    const { service } = build({ listing });
    const attempt = service.reorderDraft(STUDENT, 'order-1');
    await expect(attempt).rejects.toBeInstanceOf(BadRequestException);
    await expect(attempt).rejects.toMatchObject({ response: { code: 'SHOP_NOT_AVAILABLE' } });
  });

  it('refuses when the shop listing no longer exists', async () => {
    const { service } = build({ listing: null });
    await expect(service.reorderDraft(STUDENT, 'order-1')).rejects.toMatchObject({
      response: { code: 'SHOP_NOT_AVAILABLE' },
    });
  });
});
