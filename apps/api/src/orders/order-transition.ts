import { ConflictException } from '@nestjs/common';
import {
  IllegalOrderTransitionError,
  IllegalTaskTransitionError,
  assertOrderTransition,
  assertTaskTransition,
  type OrderEvent,
  type OrderStatus,
  type TaskEvent,
  type TaskStatus,
} from '@hoppo/shared';

/**
 * The state machines in @hoppo/shared, answered in HTTP terms.
 *
 * `assertOrderTransition` throws a plain `IllegalOrderTransitionError` when an
 * event does not apply to the status it is given. That is the right thing for
 * a shared, framework-free package to do, but nothing in the API knows that
 * class, so left alone it reaches the caller as 500 INTERNAL_ERROR, "please
 * try again".
 *
 * In a request handler it is almost never a server fault. It means the order
 * was read, somebody else moved it (a second cancel, a shop reject, the
 * accept-window sweep), and this request is now asking for a move that no
 * longer makes sense. That is a lost race: 409 ORDER_STATE_CHANGED, the same
 * answer the conditional UPDATE gives when it matches no row. Retrying cannot
 * succeed, so telling the client to try again would be wrong advice.
 *
 * These helpers only translate the error. They decide nothing: whether a
 * transition actually happens is still settled by the conditional UPDATE that
 * follows (ADR-001).
 */
export function orderStateChanged(): ConflictException {
  return new ConflictException({
    code: 'ORDER_STATE_CHANGED',
    message: 'This order was just updated by someone else. Refresh to see where it stands.',
  });
}

/** Where `event` takes an order in `from`; 409 if it does not apply. */
export function resolveOrderTransition(from: OrderStatus, event: OrderEvent): OrderStatus {
  try {
    return assertOrderTransition(from, event);
  } catch (error) {
    // Anything else is a real fault and must stay a 500.
    if (error instanceof IllegalOrderTransitionError) throw orderStateChanged();
    throw error;
  }
}

/** The same for the delivery task that travels with the order. */
export function resolveTaskTransition(from: TaskStatus, event: TaskEvent): TaskStatus {
  try {
    return assertTaskTransition(from, event);
  } catch (error) {
    if (error instanceof IllegalTaskTransitionError) throw orderStateChanged();
    throw error;
  }
}
