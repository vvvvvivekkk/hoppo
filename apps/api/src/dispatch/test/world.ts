/**
 * Rows for the dispatch and rider specs: one college, one shop, one student
 * with one order and its delivery task, and however many riders a spec adds.
 *
 * Everything is a row in the fake database (see ./fakes). Related rows are
 * linked by reference — `task.order` *is* the row in the `order` table — so
 * a write to one is seen through the other, as a join would show it.
 */

type Row = Record<string, any>;

export const STAFF = [{ userId: 'staff-1' }, { userId: 'owner-1' }];

export const COLLEGE_CONFIG = {
  collegeId: 'col-1',
  acceptanceWindowSeconds: 60,
  initialProximityM: 1500,
  proximityIncrementM: 1000,
  feeIncrementMinor: 500,
  maxBroadcastRounds: 3,
  riderPingIntervalSeconds: 15,
  shopAcceptWindowSeconds: 300,
  maxOtpAttempts: 5,
  abandonmentBanThreshold: 3,
  abandonmentWindowDays: 7,
  abandonmentBanHours: 48,
};

/**
 * The student's order and the task that delivers it. Pass `order: null` for a
 * peer errand, which has no order.
 */
export function seedTask(
  prisma: any,
  task: Row = {},
  order: Row | null = {},
): { task: Row; order: Row | null } {
  const [config] = prisma.$rows('collegeConfig').length
    ? prisma.$rows('collegeConfig')
    : prisma.$seed('collegeConfig', [{ ...COLLEGE_CONFIG }]);

  const orderRow: Row | null =
    order === null
      ? null
      : {
          id: 'order-1',
          reference: 'HP-0001',
          collegeId: 'col-1',
          studentId: 'student-1',
          status: 'PREPARING',
          paymentMethod: 'CASH',
          paymentStatus: 'NOT_REQUIRED',
          placedAt: new Date(Date.now() - 600_000),
          expectedReadyAt: new Date('2026-11-20T12:30:00Z'),
          itemsSubtotalMinor: 12_000,
          totalMinor: 14_500,
          shopListing: {
            id: 'listing-1',
            college: { config },
            shop: { name: 'Sri Sai Tiffins', staff: STAFF },
          },
          ...order,
        };
  if (orderRow) prisma.$seed('order', [orderRow]);

  const taskRow: Row = {
    id: 'task-1',
    collegeId: 'col-1',
    type: orderRow ? 'SHOP_ORDER' : 'PEER_ERRAND',
    status: 'CREATED',
    riderId: null,
    requesterId: 'student-1',
    pickupLabel: 'Sri Sai Tiffins',
    pickupLatitude: 17.42,
    pickupLongitude: 78.65,
    dropLabel: 'Boys Hostel B',
    dropLatitude: 17.421,
    dropLongitude: 78.651,
    distanceM: 640,
    baseFeeMinor: 2000,
    feeMinor: 2000,
    broadcastRound: 0,
    // Which search this is; advanced whenever the task returns to the pool.
    broadcastCycle: 1,
    currentProximityM: null,
    description: null,
    reimbursementMinor: null,
    offerExpiresAt: null,
    firstBroadcastAt: null,
    dispatchDueAt: null,
    assignedAt: null,
    otpHash: null,
    otpAttempts: 0,
    orderId: orderRow?.id ?? null,
    order: orderRow,
    chatRoom: null,
    college: { config, feeBands: [] },
    ...task,
  };
  if (orderRow) orderRow.task = taskRow;
  prisma.$seed('task', [taskRow]);

  return { task: taskRow, order: orderRow };
}

/** Put a task on offer, as round `round` of a broadcast would leave it. */
export const onOffer = (round = 1): Row => ({
  status: 'BROADCASTING',
  broadcastRound: round,
  // When this search began — which is also what its offer-list entries are
  // stamped with (see `offerEntry` in dispatch.service.ts).
  firstBroadcastAt: new Date(Date.now() - 30_000),
  offerExpiresAt: new Date(Date.now() + 60_000),
});

/**
 * A verified student who is online as a rider, pinged a moment ago and
 * holding nothing. Seeded as a `user` row and as the `riderState` row it
 * points at.
 */
export function seedRider(prisma: any, userId: string, riderState: Row = {}): Row {
  const state: Row = {
    userId,
    workModeOn: true,
    activeTaskId: null,
    barredUntil: null,
    lastPingAt: new Date(),
    ...riderState,
  };
  prisma.$seed('riderState', [state]);
  prisma.$seed('user', [
    {
      id: userId,
      collegeId: 'col-1',
      role: 'STUDENT',
      status: 'ACTIVE',
      studentProfile: { verificationStatus: 'VERIFIED' },
      riderState: state,
    },
  ]);
  return state;
}

/** The task's chat room, with its members, linked from the task row. */
export function seedChatRoom(prisma: any, task: Row, memberIds: string[]): Row {
  const [room] = prisma.$seed('chatRoom', [
    // `task` is the row itself, so a filter through the relation sees its live status.
    { id: 'room-1', collegeId: 'col-1', type: 'TASK', taskId: task.id, task, isArchived: false, archivedAt: null },
  ]);
  prisma.$seed(
    'chatMember',
    memberIds.map((userId) => ({ roomId: room.id, userId, leftAt: null })),
  );
  task.chatRoom = room;
  return room;
}

/** The `code` of the structured error a rejected call carried. */
export async function codeOf(call: Promise<unknown>): Promise<string> {
  const error: any = await call.then(
    () => {
      throw new Error('expected the call to be refused, but it succeeded');
    },
    (e: unknown) => e,
  );
  const code = error?.getResponse?.()?.code;
  // Anything that is not one of our structured refusals is a real failure.
  if (!code) throw error;
  return code;
}
