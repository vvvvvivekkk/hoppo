import type { TaskStatus } from '@hoppo/shared';
import { describeUnacceptable } from './dispatch.service';

/**
 * Why an accept was refused.
 *
 * This exists because the original code answered `ALREADY_TAKEN` for every
 * status that was not `BROADCASTING`, and that was wrong for six of the eight
 * task states. It was found by walking the student flow against a live stack:
 * a task still in `CREATED` — dispatch had not broadcast it yet, which was
 * correct — reported "that task has already been taken" while the database
 * showed `rider_id` null and nobody holding it.
 *
 * The test to write is not "does accept work"; the race suite already covers
 * that. It is that each state gets an answer that is true, because the two
 * failures that matter are both about being told the wrong thing:
 *
 *  - A rider told "someone was faster" for a task nobody has will go back to
 *    waiting, and miss the offer that was seconds away.
 *  - If dispatch broke and no task ever reached `BROADCASTING`, every accept
 *    would have reported healthy competition, and the outage would have looked
 *    like a busy evening.
 */
describe('describeUnacceptable', () => {
  it('reports ALREADY_TAKEN only when a rider actually holds the task', () => {
    const taken = describeUnacceptable('ASSIGNED', 'some-rider-id');
    expect(taken.code).toBe('ALREADY_TAKEN');
  });

  it('never reports ALREADY_TAKEN when rider_id is null', () => {
    // The whole bug in one assertion. Every state, unheld: none of them is
    // somebody else having been faster.
    const states: TaskStatus[] = [
      'CREATED',
      'BROADCASTING',
      'ASSIGNED',
      'PICKED_UP',
      'DELIVERED',
      'COMPLETED',
      'UNFULFILLED',
      'ESCALATED',
      'CANCELLED',
    ];

    for (const status of states) {
      expect(describeUnacceptable(status, null).code).not.toBe('ALREADY_TAKEN');
    }
  });

  it('tells a rider a CREATED task is coming rather than gone', () => {
    const result = describeUnacceptable('CREATED', null);
    expect(result.code).toBe('NOT_YET_OFFERED');
    // The wording has to leave them online, because the offer is imminent.
    expect(result.message).toMatch(/stay online/i);
  });

  it('distinguishes an order the student cancelled', () => {
    expect(describeUnacceptable('CANCELLED', null).code).toBe('TASK_CANCELLED');
  });

  it('distinguishes a task withdrawn for the student to decide on', () => {
    // FR-DLV-07: nobody took it, and the student is choosing between waiting,
    // collecting in person and cancelling. A rider arriving now is not late,
    // they are in the wrong place.
    expect(describeUnacceptable('UNFULFILLED', null).code).toBe('OFFER_CLOSED');
    expect(describeUnacceptable('ESCALATED', null).code).toBe('OFFER_CLOSED');
  });

  it('distinguishes a delivery that is already done', () => {
    expect(describeUnacceptable('DELIVERED', null).code).toBe('TASK_FINISHED');
    expect(describeUnacceptable('COMPLETED', null).code).toBe('TASK_FINISHED');
  });

  it('tells a rider who tapped late that the offer expired', () => {
    // L1: the accept UPDATE refuses an offer past its window, and for a few
    // seconds — until the sweep re-broadcasts or retires it — the task is
    // still BROADCASTING with nobody holding it. That is neither somebody
    // being faster nor a bug, and it must not be reported as either.
    const result = describeUnacceptable('BROADCASTING', null, true);
    expect(result.code).toBe('OFFER_EXPIRED');
    expect(result.message).toMatch(/expired/i);
  });

  it('still reports ALREADY_TAKEN for an expired offer somebody holds', () => {
    // Held beats expired: if a rider has it, that is the answer, whatever
    // the clock says about the offer they took it from.
    expect(describeUnacceptable('ASSIGNED', 'r1', true).code).toBe('ALREADY_TAKEN');
  });

  it('does not call a live, unheld offer expired', () => {
    // BROADCASTING, unheld, in its window, and yet refused: nothing honest
    // explains that, so it gets the findable code rather than a made-up one.
    expect(describeUnacceptable('BROADCASTING', null).code).toBe('TASK_NOT_ACCEPTABLE');
    expect(describeUnacceptable('BROADCASTING', null, false).code).toBe('TASK_NOT_ACCEPTABLE');
  });

  it('applies expiry only to a task that is on offer', () => {
    // A stale expiry flag must not relabel a cancelled or finished task.
    expect(describeUnacceptable('CANCELLED', null, true).code).toBe('TASK_CANCELLED');
    expect(describeUnacceptable('CREATED', null, true).code).toBe('NOT_YET_OFFERED');
  });

  it('does not dress an impossible state up as competition', () => {
    // ASSIGNED with no rider violates the check constraint, so reaching this
    // means a bug. A distinct code is what makes it findable in logs instead
    // of hiding among thousands of lost races.
    const result = describeUnacceptable('ASSIGNED', null);
    expect(result.code).toBe('TASK_NOT_ACCEPTABLE');
    expect(result.message).toContain('assigned');
  });

  it('gives every state a non-empty, actionable message', () => {
    const states: TaskStatus[] = [
      'CREATED',
      'ASSIGNED',
      'PICKED_UP',
      'DELIVERED',
      'COMPLETED',
      'UNFULFILLED',
      'ESCALATED',
      'CANCELLED',
    ];

    for (const status of states) {
      for (const riderId of [null, 'r1']) {
        const result = describeUnacceptable(status, riderId);
        expect(result.code).toMatch(/^[A-Z_]+$/);
        expect(result.message.length).toBeGreaterThan(10);
        // NFR-U-05: an error says what happened. A bare status name does not.
        expect(result.message).not.toBe(status);
      }
    }
  });
});
