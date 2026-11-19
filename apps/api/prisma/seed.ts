/**
 * Development seed.
 *
 * This builds the exact scenario section 12.3 of the SRS calls the Phase 1
 * acceptance test, so that a demo can be run end to end immediately:
 *
 *   - one college tenant with config, fee bands and campus delivery points
 *   - a super administrator and a college administrator
 *   - a verified student to place an order
 *   - a second verified student to ride
 *   - an unverified student, to show the gated state
 *   - a shop inside the radius, approved, with a catalog and opening hours
 *   - a shop outside the radius, to demonstrate the rejection path
 *
 * Run with:  pnpm db:seed
 *
 * Everything here is idempotent: it upserts by a stable natural key, so
 * running it twice does not duplicate rows.
 */

import { PrismaClient, type Prisma } from '@prisma/client';
import * as argon2 from 'argon2';

const prisma = new PrismaClient();

/** Anurag University, Venkatapur, Hyderabad. */
const COLLEGE = {
  id: '00000000-0000-4000-8000-000000000001',
  name: 'Anurag University',
  shortName: 'AU',
  address: 'Venkatapur, Ghatkesar',
  city: 'Hyderabad',
  state: 'Telangana',
  latitude: 17.3045,
  longitude: 78.6188,
  emailDomain: 'anurag.edu.in',
};

const DEV_PASSWORD = 'Hoppo@dev123';

async function main() {
  console.log('Seeding...');

  // Argon2id, the same algorithm the API uses. NFR-S-02 requires a
  // memory-hard hash — one deliberately expensive in RAM as well as CPU, so
  // that a leaked table cannot be brute-forced cheaply on a GPU.
  const passwordHash = await argon2.hash(DEV_PASSWORD, { type: argon2.argon2id });

  // -----------------------------------------------------------------------
  // College tenant
  // -----------------------------------------------------------------------
  const college = await prisma.college.upsert({
    where: { id: COLLEGE.id },
    update: {},
    create: { ...COLLEGE, status: 'ACTIVE' },
  });

  await prisma.collegeConfig.upsert({
    where: { collegeId: college.id },
    update: {},
    create: {
      collegeId: college.id,
      serviceableRadiusM: 3000,
      acceptanceWindowSeconds: 60,
      maxBroadcastRounds: 3,
      dispatchLeadMinutes: 7,
      platformFeeMinor: 0,
      commissionBps: 1000, // 10%
    },
  });

  // FR-ORD-10: base fee plus distance band.
  const bands: Prisma.FeeBandCreateManyInput[] = [
    { collegeId: college.id, minDistanceM: 0, maxDistanceM: 1000, feeMinor: 2000 }, // ₹20
    { collegeId: college.id, minDistanceM: 1000, maxDistanceM: 2500, feeMinor: 2500 }, // ₹25
    { collegeId: college.id, minDistanceM: 2500, maxDistanceM: null, feeMinor: 3500 }, // ₹35
  ];
  for (const band of bands) {
    await prisma.feeBand.upsert({
      where: { collegeId_minDistanceM: { collegeId: band.collegeId, minDistanceM: band.minDistanceM } },
      update: { feeMinor: band.feeMinor, maxDistanceM: band.maxDistanceM ?? null },
      create: band,
    });
  }

  // FR-ORD-02: the campus points a student may pick as a drop location.
  const points = [
    { name: 'Boys Hostel Block A', latitude: 17.3038, longitude: 78.6175, sortOrder: 1 },
    { name: 'Girls Hostel Block C', latitude: 17.3052, longitude: 78.6171, sortOrder: 2 },
    { name: 'Central Library', latitude: 17.3047, longitude: 78.6192, sortOrder: 3 },
    { name: 'CSE Department Block', latitude: 17.3041, longitude: 78.6196, sortOrder: 4 },
    { name: 'Main Gate', latitude: 17.3029, longitude: 78.6183, sortOrder: 5 },
  ];
  for (const p of points) {
    const existing = await prisma.deliveryPoint.findFirst({
      where: { collegeId: college.id, name: p.name },
    });
    if (!existing) {
      await prisma.deliveryPoint.create({ data: { ...p, collegeId: college.id } });
    }
  }

  // -----------------------------------------------------------------------
  // People
  // -----------------------------------------------------------------------

  // A super administrator has no college (FR-TEN-02 / the check constraint).
  await prisma.user.upsert({
    where: { email: 'super@hoppo.app' },
    update: {},
    create: {
      role: 'SUPER_ADMIN',
      name: 'Platform Super Admin',
      mobile: '+919000000000',
      email: 'super@hoppo.app',
      passwordHash,
      mobileVerifiedAt: new Date(),
      emailVerifiedAt: new Date(),
    },
  });

  const admin = await prisma.user.upsert({
    where: { email: 'admin@anurag.edu.in' },
    update: {},
    create: {
      collegeId: college.id,
      role: 'ADMIN',
      name: 'AU Campus Admin',
      mobile: '+919000000001',
      email: 'admin@anurag.edu.in',
      passwordHash,
      mobileVerifiedAt: new Date(),
      emailVerifiedAt: new Date(),
    },
  });

  /** Creates a student, optionally already verified. */
  async function makeStudent(opts: {
    name: string;
    mobile: string;
    email: string;
    rollNumber: string;
    department: string;
    yearOfStudy: number;
    verified: boolean;
  }) {
    const user = await prisma.user.upsert({
      where: { email: opts.email },
      update: {},
      create: {
        collegeId: college.id,
        role: 'STUDENT',
        name: opts.name,
        mobile: opts.mobile,
        email: opts.email,
        passwordHash,
        mobileVerifiedAt: new Date(),
        emailVerifiedAt: new Date(),
      },
    });

    await prisma.studentProfile.upsert({
      where: { userId: user.id },
      update: {},
      create: {
        userId: user.id,
        rollNumber: opts.rollNumber,
        department: opts.department,
        yearOfStudy: opts.yearOfStudy,
        verificationStatus: opts.verified ? 'VERIFIED' : 'UNSUBMITTED',
        verifiedAt: opts.verified ? new Date() : null,
        verifiedByUserId: opts.verified ? admin.id : null,
        // Section 11: type and last four only. Never the number, never the image.
        govtIdType: opts.verified ? 'DRIVING_LICENCE' : null,
        govtIdLast4: opts.verified ? '4417' : null,
        govtIdVerifiedAt: opts.verified ? new Date() : null,
      },
    });

    if (opts.verified) {
      await prisma.riderReliability.upsert({
        where: { userId: user.id },
        update: {},
        create: { userId: user.id },
      });
    }

    return user;
  }

  const customer = await makeStudent({
    name: 'Vivek Reddy',
    mobile: '+919346375528',
    email: 'vivek@anurag.edu.in',
    rollNumber: '26EG107A01',
    department: 'Artificial Intelligence',
    yearOfStudy: 4,
    verified: true,
  });

  const rider = await makeStudent({
    name: 'Srichandana Peddi',
    mobile: '+919000000011',
    email: 'srichandana@anurag.edu.in',
    rollNumber: '26EG107A02',
    department: 'AIML',
    yearOfStudy: 4,
    verified: true,
  });

  await makeStudent({
    name: 'Unverified Fresher',
    mobile: '+919000000012',
    email: 'fresher@anurag.edu.in',
    rollNumber: '26EG107A99',
    department: 'CSE',
    yearOfStudy: 1,
    verified: false,
  });

  // The rider needs a rider_state row before work mode can be turned on.
  await prisma.riderState.upsert({
    where: { userId: rider.id },
    update: {},
    create: { userId: rider.id, workModeOn: false },
  });

  // -----------------------------------------------------------------------
  // Shops
  // -----------------------------------------------------------------------

  /**
   * The distance is computed by PostGIS rather than in TypeScript, because
   * constraint C-2 says the geodesic calculation has exactly one home and
   * this is it. `$queryRaw` is used because the function is SQL-side.
   */
  async function geodesicDistanceM(lat: number, lng: number): Promise<number> {
    const rows = await prisma.$queryRaw<{ m: number }[]>`
      SELECT hoppo_geodesic_distance_m(
        ${college.latitude}::double precision,
        ${college.longitude}::double precision,
        ${lat}::double precision,
        ${lng}::double precision
      ) AS m
    `;
    return Math.round(rows[0].m);
  }

  async function makeShop(opts: {
    name: string;
    category: string;
    latitude: number;
    longitude: number;
    locationType: 'ON_CAMPUS' | 'OFF_CAMPUS';
    address: string;
    status: 'ACTIVE' | 'PENDING_VERIFICATION' | 'REJECTED';
    ownerEmail: string;
    ownerMobile: string;
    fssai?: string;
  }) {
    const distance = await geodesicDistanceM(opts.latitude, opts.longitude);

    const shop = await prisma.shop.upsert({
      where: { id: `shop-${opts.name.toLowerCase().replace(/[^a-z0-9]+/g, '-')}` },
      update: {},
      create: {
        id: `shop-${opts.name.toLowerCase().replace(/[^a-z0-9]+/g, '-')}`,
        name: opts.name,
        category: opts.category,
        ownerName: `${opts.name} Owner`,
        ownerMobile: opts.ownerMobile,
        ownerEmail: opts.ownerEmail,
        address: opts.address,
        city: 'Hyderabad',
        state: 'Telangana',
        latitude: opts.latitude,
        longitude: opts.longitude,
        locationType: opts.locationType,
        fssaiLicenceNumber: opts.fssai ?? null,
      },
    });

    const listing = await prisma.shopListing.upsert({
      where: { shopId_collegeId: { shopId: shop.id, collegeId: college.id } },
      update: {},
      create: {
        shopId: shop.id,
        collegeId: college.id,
        distanceFromCollegeM: distance,
        status: opts.status,
        approvedByUserId: opts.status === 'ACTIVE' ? admin.id : null,
        approvedAt: opts.status === 'ACTIVE' ? new Date() : null,
        // The check constraint requires a reason whenever status is REJECTED.
        rejectionReason: opts.status === 'REJECTED' ? 'ADDRESS_OUTSIDE_RADIUS' : null,
        rejectionNote:
          opts.status === 'REJECTED'
            ? `Measured ${distance} m from campus, beyond the 3000 m serviceable radius.`
            : null,
      },
    });

    console.log(`  ${opts.name}: ${distance} m from campus -> ${opts.status}`);
    return { shop, listing, distance };
  }

  // Inside the radius, approved, with a full catalog.
  const cafe = await makeShop({
    name: 'Campus Corner Cafe',
    category: 'FOOD',
    latitude: 17.3051,
    longitude: 78.6194,
    locationType: 'ON_CAMPUS',
    address: 'Near Main Gate, Anurag University Campus',
    status: 'ACTIVE',
    ownerEmail: 'cafe@example.com',
    ownerMobile: '+919000000020',
    fssai: '12345678901234',
  });

  const stationery = await makeShop({
    name: 'Sri Stationery and Xerox',
    category: 'STATIONERY',
    latitude: 17.3105,
    longitude: 78.6221,
    locationType: 'OFF_CAMPUS',
    address: 'Ghatkesar Main Road',
    status: 'ACTIVE',
    ownerEmail: 'stationery@example.com',
    ownerMobile: '+919000000021',
  });

  // Outside the radius — demonstrates the FR-SHOP-06 rejection path.
  await makeShop({
    name: 'Far Away Biryani House',
    category: 'FOOD',
    latitude: 17.3850,
    longitude: 78.4867,
    locationType: 'OFF_CAMPUS',
    address: 'Abids, Hyderabad',
    status: 'REJECTED',
    ownerEmail: 'faraway@example.com',
    ownerMobile: '+919000000022',
    fssai: '98765432109876',
  });

  // -----------------------------------------------------------------------
  // Catalog and hours for the cafe
  // -----------------------------------------------------------------------
  const catalogs: Record<string, { name: string; priceMinor: number; prepMinutes: number }[]> = {
    Beverages: [
      { name: 'Masala Chai', priceMinor: 1500, prepMinutes: 5 },
      { name: 'Filter Coffee', priceMinor: 2000, prepMinutes: 5 },
      { name: 'Cold Coffee', priceMinor: 6000, prepMinutes: 8 },
      { name: 'Fresh Lime Soda', priceMinor: 4000, prepMinutes: 4 },
    ],
    Snacks: [
      { name: 'Veg Puff', priceMinor: 2500, prepMinutes: 3 },
      { name: 'Samosa (2 pc)', priceMinor: 3000, prepMinutes: 5 },
      { name: 'Paneer Roll', priceMinor: 9000, prepMinutes: 12 },
      { name: 'Masala Maggi', priceMinor: 6000, prepMinutes: 10 },
    ],
    Meals: [
      { name: 'Veg Thali', priceMinor: 12000, prepMinutes: 15 },
      { name: 'Chicken Biryani (Single)', priceMinor: 18000, prepMinutes: 20 },
      { name: 'Paneer Butter Masala with Roti', priceMinor: 15000, prepMinutes: 18 },
    ],
  };

  for (const [categoryName, items] of Object.entries(catalogs)) {
    const category = await prisma.catalogCategory.upsert({
      where: { shopListingId_name: { shopListingId: cafe.listing.id, name: categoryName } },
      update: {},
      create: { shopListingId: cafe.listing.id, name: categoryName },
    });

    for (const item of items) {
      const existing = await prisma.catalogItem.findFirst({
        where: { shopListingId: cafe.listing.id, name: item.name },
      });
      if (!existing) {
        await prisma.catalogItem.create({
          data: {
            shopListingId: cafe.listing.id,
            categoryId: category.id,
            name: item.name,
            priceMinor: item.priceMinor,
            prepMinutes: item.prepMinutes,
            isAvailable: true,
          },
        });
      }
    }
  }

  // A small stationery catalog, so search across shops returns more than one.
  const stationeryCategory = await prisma.catalogCategory.upsert({
    where: { shopListingId_name: { shopListingId: stationery.listing.id, name: 'Printing' } },
    update: {},
    create: { shopListingId: stationery.listing.id, name: 'Printing' },
  });
  for (const item of [
    { name: 'Black and White Xerox (per page)', priceMinor: 100, prepMinutes: 2 },
    { name: 'Colour Print (per page)', priceMinor: 1000, prepMinutes: 3 },
    { name: 'Spiral Binding', priceMinor: 4000, prepMinutes: 10 },
    { name: 'A4 Notebook 200 pages', priceMinor: 6500, prepMinutes: 1 },
  ]) {
    const existing = await prisma.catalogItem.findFirst({
      where: { shopListingId: stationery.listing.id, name: item.name },
    });
    if (!existing) {
      await prisma.catalogItem.create({
        data: { ...item, shopListingId: stationery.listing.id, categoryId: stationeryCategory.id },
      });
    }
  }

  // Opening hours: 08:00-21:00 every day for the cafe, 09:00-20:00 Mon-Sat
  // for the stationery shop. Stored as minutes from midnight.
  for (let day = 0; day < 7; day += 1) {
    const existing = await prisma.shopHours.findFirst({
      where: { shopListingId: cafe.listing.id, dayOfWeek: day },
    });
    if (!existing) {
      await prisma.shopHours.create({
        data: { shopListingId: cafe.listing.id, dayOfWeek: day, openMinute: 480, closeMinute: 1260 },
      });
    }
  }
  for (let day = 1; day <= 6; day += 1) {
    const existing = await prisma.shopHours.findFirst({
      where: { shopListingId: stationery.listing.id, dayOfWeek: day },
    });
    if (!existing) {
      await prisma.shopHours.create({
        data: {
          shopListingId: stationery.listing.id,
          dayOfWeek: day,
          openMinute: 540,
          closeMinute: 1200,
        },
      });
    }
  }

  console.log('\nSeed complete.');
  console.log('\nAccounts (password for all: %s)', DEV_PASSWORD);
  console.log('  super@hoppo.app          super administrator, no college');
  console.log('  admin@anurag.edu.in      college administrator');
  console.log('  vivek@anurag.edu.in      verified student, places the order');
  console.log('  srichandana@anurag.edu.in verified student, rides the task');
  console.log('  fresher@anurag.edu.in    unverified student, shows the gated state');
  console.log('\nIds for manual testing:');
  console.log('  college      %s', college.id);
  console.log('  customer     %s', customer.id);
  console.log('  rider        %s', rider.id);
  console.log('  cafe listing %s', cafe.listing.id);
}

main()
  .then(async () => {
    await prisma.$disconnect();
  })
  .catch(async (e) => {
    console.error(e);
    await prisma.$disconnect();
    process.exit(1);
  });
