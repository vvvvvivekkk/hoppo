import { ConflictException } from '@nestjs/common';
import { OrderEvent, OrderStatus, TaskEvent, TaskStatus } from '@hoppo/shared';
import { resolveOrderTransition, resolveTaskTransition } from './order-transition';

/** Run `fn`, and hand back whatever it threw. */
function thrownBy(fn: () => unknown): unknown {
  try {
    fn();
  } catch (error) {
    return error;
  }
  throw new Error('expected a throw');
}

function expectStateChanged(error: unknown): void {
  expect(error).toBeInstanceOf(ConflictException);
  const conflict = error as ConflictException;
  expect(conflict.getStatus()).toBe(409);
  expect(conflict.getResponse()).toMatchObject({ code: 'ORDER_STATE_CHANGED' });
}

describe('order transitions answered in HTTP terms', () => {
  it('returns the next status for a legal move', () => {
    expect(resolveOrderTransition(OrderStatus.PLACED, OrderEvent.STUDENT_CANCELLED)).toBe(
      OrderStatus.CANCELLED,
    );
    expect(resolveOrderTransition(OrderStatus.PREPARING, OrderEvent.MARKED_READY)).toBe(
      OrderStatus.READY,
    );
  });

  // The loser of a cancel race: it queued behind the winner, then read CANCELLED.
  it('answers a second cancel on a cancelled order with 409, not a bare Error', () => {
    expectStateChanged(
      thrownBy(() => resolveOrderTransition(OrderStatus.CANCELLED, OrderEvent.STUDENT_CANCELLED)),
    );
  });

  it('answers a shop reject on a cancelled order with 409', () => {
    expectStateChanged(
      thrownBy(() => resolveOrderTransition(OrderStatus.CANCELLED, OrderEvent.SHOP_REJECTED)),
    );
  });

  // Lane A4's finding: "Mark ready" on an order the student just cancelled.
  it('answers "mark ready" on a cancelled or already-ready order with 409', () => {
    expectStateChanged(
      thrownBy(() => resolveOrderTransition(OrderStatus.CANCELLED, OrderEvent.MARKED_READY)),
    );
    expectStateChanged(
      thrownBy(() => resolveOrderTransition(OrderStatus.READY, OrderEvent.MARKED_READY)),
    );
  });

  it('answers a cancel on a task that has already been cancelled with 409', () => {
    expect(resolveTaskTransition(TaskStatus.CREATED, TaskEvent.REQUESTER_CANCELLED)).toBe(
      TaskStatus.CANCELLED,
    );
    expectStateChanged(
      thrownBy(() => resolveTaskTransition(TaskStatus.CANCELLED, TaskEvent.REQUESTER_CANCELLED)),
    );
  });
});
