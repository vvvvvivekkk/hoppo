/**
 * The task state machine.
 *
 * A "state machine" here just means: a task is always in exactly one state,
 * and only certain moves between states are legal. Writing those moves down
 * as data rather than scattering `if (task.status === ...)` across the
 * codebase means there is one place to read the rules and one place to
 * enforce them — and a test can prove the table and the code agree.
 *
 * This is Appendix A of the SRS, with three gaps closed. Appendix A gives
 * UNFULFILLED no way out, but FR-DLV-07 says the requester may then choose to
 * keep waiting, to collect in person, or to cancel for a full refund. Those
 * are three transitions, so they are listed here. ASSIGNED gains an
 * administrator cancellation, because a task can go wrong after a rider has
 * it and someone has to be able to close it.
 */

export const TaskStatus = {
  CREATED: 'CREATED',
  BROADCASTING: 'BROADCASTING',
  ASSIGNED: 'ASSIGNED',
  PICKED_UP: 'PICKED_UP',
  DELIVERED: 'DELIVERED',
  COMPLETED: 'COMPLETED',
  UNFULFILLED: 'UNFULFILLED',
  ESCALATED: 'ESCALATED',
  CANCELLED: 'CANCELLED',
} as const;

export type TaskStatus = (typeof TaskStatus)[keyof typeof TaskStatus];

/** Named events, so a caller asks for a move by meaning rather than by target. */
export const TaskEvent = {
  DISPATCH_DUE: 'DISPATCH_DUE',
  RIDER_ACCEPTED: 'RIDER_ACCEPTED',
  WINDOW_EXPIRED_ROUNDS_REMAIN: 'WINDOW_EXPIRED_ROUNDS_REMAIN',
  WINDOW_EXPIRED_ROUNDS_EXHAUSTED: 'WINDOW_EXPIRED_ROUNDS_EXHAUSTED',
  RIDER_ABANDONED: 'RIDER_ABANDONED',
  PICKUP_CONFIRMED: 'PICKUP_CONFIRMED',
  OTP_VALID: 'OTP_VALID',
  OTP_ATTEMPTS_EXHAUSTED: 'OTP_ATTEMPTS_EXHAUSTED',
  SETTLEMENT_WRITTEN: 'SETTLEMENT_WRITTEN',
  REQUESTER_CANCELLED: 'REQUESTER_CANCELLED',
  SHOP_CANCELLED: 'SHOP_CANCELLED',
  REQUESTER_KEEPS_WAITING: 'REQUESTER_KEEPS_WAITING',
  REQUESTER_COLLECTED_IN_PERSON: 'REQUESTER_COLLECTED_IN_PERSON',
  ADMIN_RESOLVED_DELIVERED: 'ADMIN_RESOLVED_DELIVERED',
  ADMIN_RESOLVED_CANCELLED: 'ADMIN_RESOLVED_CANCELLED',
} as const;

export type TaskEvent = (typeof TaskEvent)[keyof typeof TaskEvent];

interface Transition {
  from: TaskStatus;
  event: TaskEvent;
  to: TaskStatus;
  /** Why this move exists, traced to a requirement. */
  note: string;
}

export const TASK_TRANSITIONS: readonly Transition[] = [
  {
    from: TaskStatus.CREATED,
    event: TaskEvent.DISPATCH_DUE,
    to: TaskStatus.BROADCASTING,
    note: 'FR-DLV-01: shop order reached its dispatch lead time, or a non-shop task was created.',
  },
  {
    from: TaskStatus.BROADCASTING,
    event: TaskEvent.RIDER_ACCEPTED,
    to: TaskStatus.ASSIGNED,
    note: 'FR-DLV-04: first accept wins, decided by a conditional update.',
  },
  {
    from: TaskStatus.BROADCASTING,
    event: TaskEvent.WINDOW_EXPIRED_ROUNDS_REMAIN,
    to: TaskStatus.BROADCASTING,
    note: 'FR-DLV-06: re-broadcast with a wider radius and a higher fee.',
  },
  {
    from: TaskStatus.BROADCASTING,
    event: TaskEvent.WINDOW_EXPIRED_ROUNDS_EXHAUSTED,
    to: TaskStatus.UNFULFILLED,
    note: 'FR-DLV-06: all configured rounds used without an acceptance.',
  },
  {
    from: TaskStatus.ASSIGNED,
    event: TaskEvent.RIDER_ABANDONED,
    to: TaskStatus.BROADCASTING,
    note: 'FR-DLV-08: abandonment before pickup returns the task to broadcast.',
  },
  {
    from: TaskStatus.ASSIGNED,
    event: TaskEvent.PICKUP_CONFIRMED,
    to: TaskStatus.PICKED_UP,
    note: 'FR-DLV-11: the shop unlocks it, the rider confirms it.',
  },
  {
    from: TaskStatus.PICKED_UP,
    event: TaskEvent.OTP_VALID,
    to: TaskStatus.DELIVERED,
    note: 'FR-DLV-13: handover code accepted at the drop point.',
  },
  {
    from: TaskStatus.PICKED_UP,
    event: TaskEvent.OTP_ATTEMPTS_EXHAUSTED,
    to: TaskStatus.ESCALATED,
    note: 'FR-DLV-14: too many wrong codes, hand it to an administrator.',
  },
  {
    from: TaskStatus.DELIVERED,
    event: TaskEvent.SETTLEMENT_WRITTEN,
    to: TaskStatus.COMPLETED,
    note: 'FR-DLV-15 / NFR-R-03: the ledger entry and the status move together.',
  },
  {
    from: TaskStatus.CREATED,
    event: TaskEvent.REQUESTER_CANCELLED,
    to: TaskStatus.CANCELLED,
    note: 'FR-ORD-05: cancellable before preparation begins.',
  },
  {
    from: TaskStatus.CREATED,
    event: TaskEvent.SHOP_CANCELLED,
    to: TaskStatus.CANCELLED,
    note: 'FR-SHP-04: shop rejected the order, or the accept window expired.',
  },
  {
    from: TaskStatus.BROADCASTING,
    event: TaskEvent.REQUESTER_CANCELLED,
    to: TaskStatus.CANCELLED,
    note: 'FR-ORD-05.',
  },
  {
    from: TaskStatus.BROADCASTING,
    event: TaskEvent.SHOP_CANCELLED,
    to: TaskStatus.CANCELLED,
    note: 'FR-SHP-04.',
  },
  // --- Gaps in Appendix A, closed from FR-DLV-07 -------------------------
  {
    from: TaskStatus.UNFULFILLED,
    event: TaskEvent.REQUESTER_KEEPS_WAITING,
    to: TaskStatus.BROADCASTING,
    note: 'FR-DLV-07: requester chose to keep waiting; rounds reset.',
  },
  {
    from: TaskStatus.UNFULFILLED,
    event: TaskEvent.REQUESTER_COLLECTED_IN_PERSON,
    to: TaskStatus.COMPLETED,
    note: 'FR-DLV-07: requester collected the order themselves; no fee is due.',
  },
  {
    from: TaskStatus.UNFULFILLED,
    event: TaskEvent.REQUESTER_CANCELLED,
    to: TaskStatus.CANCELLED,
    note: 'FR-DLV-07: cancel with a full refund.',
  },
  {
    from: TaskStatus.ASSIGNED,
    event: TaskEvent.ADMIN_RESOLVED_CANCELLED,
    to: TaskStatus.CANCELLED,
    note: 'Operational necessity: a task can go wrong after assignment.',
  },
  {
    from: TaskStatus.ESCALATED,
    event: TaskEvent.ADMIN_RESOLVED_DELIVERED,
    to: TaskStatus.DELIVERED,
    note: 'FR-ADM-04: marked delivered, which then settles to COMPLETED.',
  },
  {
    from: TaskStatus.ESCALATED,
    event: TaskEvent.ADMIN_RESOLVED_CANCELLED,
    to: TaskStatus.CANCELLED,
    note: 'FR-ADM-04: cancelled with refund.',
  },
];

/** States from which nothing further happens. */
export const TERMINAL_TASK_STATUSES: readonly TaskStatus[] = [
  TaskStatus.COMPLETED,
  TaskStatus.CANCELLED,
];

export function isTerminalTaskStatus(status: TaskStatus): boolean {
  return TERMINAL_TASK_STATUSES.includes(status);
}

/** The state this event moves to from here, or null if the move is illegal. */
export function nextTaskStatus(from: TaskStatus, event: TaskEvent): TaskStatus | null {
  const match = TASK_TRANSITIONS.find((t) => t.from === from && t.event === event);
  return match ? match.to : null;
}

export function canApplyTaskEvent(from: TaskStatus, event: TaskEvent): boolean {
  return nextTaskStatus(from, event) !== null;
}

/** Every event legal from a given state. Drives admin UI affordances. */
export function allowedTaskEvents(from: TaskStatus): TaskEvent[] {
  return TASK_TRANSITIONS.filter((t) => t.from === from).map((t) => t.event);
}

/**
 * Thrown rather than returned, because an illegal transition is a bug or a
 * replayed request, not a user error to render in a form.
 */
export class IllegalTaskTransitionError extends Error {
  constructor(
    public readonly from: TaskStatus,
    public readonly event: TaskEvent,
  ) {
    super(`Task cannot move from ${from} on ${event}`);
    this.name = 'IllegalTaskTransitionError';
  }
}

export function assertTaskTransition(from: TaskStatus, event: TaskEvent): TaskStatus {
  const to = nextTaskStatus(from, event);
  if (to === null) throw new IllegalTaskTransitionError(from, event);
  return to;
}
