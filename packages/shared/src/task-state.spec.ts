import {
  TaskStatus,
  TaskEvent,
  TASK_TRANSITIONS,
  nextTaskStatus,
  canApplyTaskEvent,
  allowedTaskEvents,
  assertTaskTransition,
  IllegalTaskTransitionError,
  isTerminalTaskStatus,
} from './task-state';

describe('task state machine', () => {
  it('walks the happy path from creation to completion', () => {
    let status: TaskStatus = TaskStatus.CREATED;
    status = assertTaskTransition(status, TaskEvent.DISPATCH_DUE);
    expect(status).toBe(TaskStatus.BROADCASTING);
    status = assertTaskTransition(status, TaskEvent.RIDER_ACCEPTED);
    expect(status).toBe(TaskStatus.ASSIGNED);
    status = assertTaskTransition(status, TaskEvent.PICKUP_CONFIRMED);
    expect(status).toBe(TaskStatus.PICKED_UP);
    status = assertTaskTransition(status, TaskEvent.OTP_VALID);
    expect(status).toBe(TaskStatus.DELIVERED);
    status = assertTaskTransition(status, TaskEvent.SETTLEMENT_WRITTEN);
    expect(status).toBe(TaskStatus.COMPLETED);
  });

  it('re-broadcasts into itself while rounds remain', () => {
    expect(
      nextTaskStatus(TaskStatus.BROADCASTING, TaskEvent.WINDOW_EXPIRED_ROUNDS_REMAIN),
    ).toBe(TaskStatus.BROADCASTING);
  });

  it('gives up once rounds are exhausted', () => {
    expect(
      nextTaskStatus(TaskStatus.BROADCASTING, TaskEvent.WINDOW_EXPIRED_ROUNDS_EXHAUSTED),
    ).toBe(TaskStatus.UNFULFILLED);
  });

  it('offers an unfulfilled task all three FR-DLV-07 outcomes', () => {
    const events = allowedTaskEvents(TaskStatus.UNFULFILLED);
    expect(events).toContain(TaskEvent.REQUESTER_KEEPS_WAITING);
    expect(events).toContain(TaskEvent.REQUESTER_COLLECTED_IN_PERSON);
    expect(events).toContain(TaskEvent.REQUESTER_CANCELLED);
  });

  it('returns an abandoned task to broadcast', () => {
    expect(nextTaskStatus(TaskStatus.ASSIGNED, TaskEvent.RIDER_ABANDONED)).toBe(
      TaskStatus.BROADCASTING,
    );
  });

  it('escalates when the handover code runs out of attempts', () => {
    expect(nextTaskStatus(TaskStatus.PICKED_UP, TaskEvent.OTP_ATTEMPTS_EXHAUSTED)).toBe(
      TaskStatus.ESCALATED,
    );
  });

  it('refuses cancellation once the goods are picked up', () => {
    expect(canApplyTaskEvent(TaskStatus.PICKED_UP, TaskEvent.REQUESTER_CANCELLED)).toBe(false);
  });

  it('refuses to accept a task that is already assigned', () => {
    expect(canApplyTaskEvent(TaskStatus.ASSIGNED, TaskEvent.RIDER_ACCEPTED)).toBe(false);
  });

  it('throws, not returns, on an illegal transition', () => {
    expect(() => assertTaskTransition(TaskStatus.COMPLETED, TaskEvent.RIDER_ACCEPTED)).toThrow(
      IllegalTaskTransitionError,
    );
  });

  it('lets nothing out of a terminal state', () => {
    for (const status of [TaskStatus.COMPLETED, TaskStatus.CANCELLED]) {
      expect(isTerminalTaskStatus(status)).toBe(true);
      expect(allowedTaskEvents(status)).toHaveLength(0);
    }
  });

  it('has no duplicate from/event pairs, so no transition is ambiguous', () => {
    const seen = new Set<string>();
    for (const t of TASK_TRANSITIONS) {
      const key = `${t.from}:${t.event}`;
      expect(seen.has(key)).toBe(false);
      seen.add(key);
    }
  });

  it('can reach every non-initial state from CREATED', () => {
    const reachable = new Set<TaskStatus>([TaskStatus.CREATED]);
    let grew = true;
    while (grew) {
      grew = false;
      for (const t of TASK_TRANSITIONS) {
        if (reachable.has(t.from) && !reachable.has(t.to)) {
          reachable.add(t.to);
          grew = true;
        }
      }
    }
    for (const status of Object.values(TaskStatus)) {
      expect(reachable.has(status)).toBe(true);
    }
  });
});
