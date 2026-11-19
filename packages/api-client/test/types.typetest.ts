/**
 * Compile-time checks of exported shapes against what the API sends. Never
 * executed: test/endpoints.test.mjs compiles this file and fails on any
 * diagnostic. Each `@ts-expect-error` is itself an assertion — it becomes an
 * error the moment the line beneath it starts to compile.
 */
import { endpoints } from '../src';
import type { CollegeRadius, SocketException, TaskOfferWithdrawn, TaskStatusEvent } from '../src';

type Equal<A, B> = (<T>() => T extends A ? 1 : 2) extends <T>() => T extends B ? 1 : 2
  ? true
  : false;
const assertType = <T extends true>(): T | undefined => undefined;

type Api = ReturnType<typeof endpoints>;

// GET /verification/me always sends retryAt (VerificationService.myStatus).
type Me = Awaited<ReturnType<Api['verification']['me']>>;
assertType<Equal<Me['retryAt'], string | null>>();
assertType<Equal<undefined extends Me['retryAt'] ? true : false, false>>();

// GET /admin/college/radius (ShopsService.currentRadius).
assertType<Equal<Awaited<ReturnType<Api['admin']['radius']>>, CollegeRadius>>();
assertType<
  Equal<
    CollegeRadius,
    {
      collegeId: string;
      serviceableRadiusM: number;
      serviceableRadiusLabel: string;
      minRadiusM: number;
      maxRadiusM: number;
    }
  >
>();

// The `exception` event on /rt (DispatchGateway.handleConnection).
assertType<Equal<SocketException, { code: string; message: string }>>();

// task:offer:withdrawn (DispatchGateway.withdrawOffer).
assertType<
  Equal<TaskOfferWithdrawn, { taskId: string; winnerUserId: string | null; won: boolean }>
>();

// task:status narrows on `type` (notifyTaskStatus / notifyWorkModeDisabled).
export function narrow(event: TaskStatusEvent): string | number {
  if (event.type === 'WORK_MODE_DISABLED') return event.afterMinutes;
  // @ts-expect-error afterMinutes exists only on the work-mode branch
  void event.afterMinutes;
  return event.taskId + event.status;
}
