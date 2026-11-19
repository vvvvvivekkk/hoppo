/**
 * The order state machine — separate from the task state machine on purpose.
 *
 * An order is a commercial document between a student and a shop. A task is a
 * physical movement job offered to riders. A parcel pickup has a task and no
 * order at all, and a cancelled-before-broadcast order has an order and a task
 * that never left CREATED. Collapsing them into one status column would mean
 * inventing states that are meaningless for one side or the other.
 *
 * The two machines touch at exactly one point: pickup. The SRS has FR-SHP-06
 * ("the shop shall confirm handover, moving the order to PICKED_UP") and
 * FR-DLV-11 ("the rider shall mark PICKED_UP") both claiming to own that
 * transition. The rule this codebase adopts:
 *
 *   The shop's confirmation sets `readyForHandover` and *unlocks* the rider's
 *   button. Only the rider's tap writes `pickedUpAt`, and it writes it to the
 *   order and the task inside one database transaction.
 *
 * One actor, one write, two rows that cannot drift apart. See
 * docs/decisions.md ADR-003.
 */

export const OrderStatus = {
  PLACED: 'PLACED',
  SHOP_ACCEPTED: 'SHOP_ACCEPTED',
  PREPARING: 'PREPARING',
  READY: 'READY',
  PICKED_UP: 'PICKED_UP',
  DELIVERED: 'DELIVERED',
  COMPLETED: 'COMPLETED',
  CANCELLED: 'CANCELLED',
} as const;

export type OrderStatus = (typeof OrderStatus)[keyof typeof OrderStatus];

export const OrderEvent = {
  SHOP_ACCEPTED: 'SHOP_ACCEPTED',
  SHOP_REJECTED: 'SHOP_REJECTED',
  ACCEPT_WINDOW_EXPIRED: 'ACCEPT_WINDOW_EXPIRED',
  PREPARATION_STARTED: 'PREPARATION_STARTED',
  MARKED_READY: 'MARKED_READY',
  RIDER_PICKED_UP: 'RIDER_PICKED_UP',
  HANDOVER_CONFIRMED: 'HANDOVER_CONFIRMED',
  SETTLEMENT_WRITTEN: 'SETTLEMENT_WRITTEN',
  STUDENT_CANCELLED: 'STUDENT_CANCELLED',
  COLLECTED_IN_PERSON: 'COLLECTED_IN_PERSON',
  ADMIN_CANCELLED: 'ADMIN_CANCELLED',
} as const;

export type OrderEvent = (typeof OrderEvent)[keyof typeof OrderEvent];

interface OrderTransition {
  from: OrderStatus;
  event: OrderEvent;
  to: OrderStatus;
  note: string;
}

export const ORDER_TRANSITIONS: readonly OrderTransition[] = [
  {
    from: OrderStatus.PLACED,
    event: OrderEvent.SHOP_ACCEPTED,
    to: OrderStatus.SHOP_ACCEPTED,
    note: 'FR-SHP-03.',
  },
  {
    from: OrderStatus.PLACED,
    event: OrderEvent.SHOP_REJECTED,
    to: OrderStatus.CANCELLED,
    note: 'FR-SHP-04.',
  },
  {
    from: OrderStatus.PLACED,
    event: OrderEvent.ACCEPT_WINDOW_EXPIRED,
    to: OrderStatus.CANCELLED,
    note: 'FR-SHP-04: no response inside the configured window.',
  },
  {
    from: OrderStatus.PLACED,
    event: OrderEvent.STUDENT_CANCELLED,
    to: OrderStatus.CANCELLED,
    note: 'FR-ORD-05: free cancellation at PLACED.',
  },
  {
    from: OrderStatus.SHOP_ACCEPTED,
    event: OrderEvent.PREPARATION_STARTED,
    to: OrderStatus.PREPARING,
    note: 'FR-SHP-03: acceptance flows straight into preparing.',
  },
  {
    from: OrderStatus.SHOP_ACCEPTED,
    event: OrderEvent.STUDENT_CANCELLED,
    to: OrderStatus.CANCELLED,
    note: 'FR-ORD-05: still free to cancel at SHOP_ACCEPTED.',
  },
  {
    from: OrderStatus.PREPARING,
    event: OrderEvent.MARKED_READY,
    to: OrderStatus.READY,
    note: 'FR-SHP-05.',
  },
  {
    from: OrderStatus.PREPARING,
    event: OrderEvent.ADMIN_CANCELLED,
    to: OrderStatus.CANCELLED,
    note: 'FR-ORD-05 bars the student here; an administrator may still act.',
  },
  {
    from: OrderStatus.READY,
    event: OrderEvent.RIDER_PICKED_UP,
    to: OrderStatus.PICKED_UP,
    note: 'ADR-003: the shop unlocks, the rider writes.',
  },
  {
    from: OrderStatus.READY,
    event: OrderEvent.COLLECTED_IN_PERSON,
    to: OrderStatus.COMPLETED,
    note: 'FR-DLV-07: no rider was found and the student collected it.',
  },
  {
    from: OrderStatus.READY,
    event: OrderEvent.ADMIN_CANCELLED,
    to: OrderStatus.CANCELLED,
    note: 'FR-ADM-04.',
  },
  {
    from: OrderStatus.PICKED_UP,
    event: OrderEvent.HANDOVER_CONFIRMED,
    to: OrderStatus.DELIVERED,
    note: 'FR-DLV-13: handover code accepted.',
  },
  {
    from: OrderStatus.PICKED_UP,
    event: OrderEvent.ADMIN_CANCELLED,
    to: OrderStatus.CANCELLED,
    note: 'FR-ADM-04: resolution of an escalated task.',
  },
  {
    from: OrderStatus.DELIVERED,
    event: OrderEvent.SETTLEMENT_WRITTEN,
    to: OrderStatus.COMPLETED,
    note: 'NFR-R-03.',
  },
];

export const TERMINAL_ORDER_STATUSES: readonly OrderStatus[] = [
  OrderStatus.COMPLETED,
  OrderStatus.CANCELLED,
];

/**
 * FR-ORD-05: the student may cancel without charge at PLACED or
 * SHOP_ACCEPTED, and not once preparation has begun. Exposed as its own
 * function because the mobile app needs to decide whether to show the button.
 */
export function isStudentCancellable(status: OrderStatus): boolean {
  return status === OrderStatus.PLACED || status === OrderStatus.SHOP_ACCEPTED;
}

export function nextOrderStatus(from: OrderStatus, event: OrderEvent): OrderStatus | null {
  const match = ORDER_TRANSITIONS.find((t) => t.from === from && t.event === event);
  return match ? match.to : null;
}

export function canApplyOrderEvent(from: OrderStatus, event: OrderEvent): boolean {
  return nextOrderStatus(from, event) !== null;
}

export class IllegalOrderTransitionError extends Error {
  constructor(
    public readonly from: OrderStatus,
    public readonly event: OrderEvent,
  ) {
    super(`Order cannot move from ${from} on ${event}`);
    this.name = 'IllegalOrderTransitionError';
  }
}

export function assertOrderTransition(from: OrderStatus, event: OrderEvent): OrderStatus {
  const to = nextOrderStatus(from, event);
  if (to === null) throw new IllegalOrderTransitionError(from, event);
  return to;
}
