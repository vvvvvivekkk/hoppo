/**
 * Compile-time checks of exported shapes against what the API sends. Never
 * executed: test/endpoints.test.mjs compiles this file and fails on any
 * diagnostic. Each `@ts-expect-error` is itself an assertion — it becomes an
 * error the moment the line beneath it starts to compile.
 */
import { endpoints } from '../src';
import type {
  AccountDeletion,
  AccountExport,
  AdminDeliveryPoint,
  AdminOrderDetail,
  AdminOrderList,
  AdminOrderSummary,
  AdminShopDetail,
  AdminShopListItem,
  AdminStudentDetail,
  AdminStudentListItem,
  AuditLogEntry,
  AuthUser,
  CollegeConfig,
  CollegeConfigUpdateResult,
  CollegeRadius,
  Escalation,
  EscalationResolution,
  Paged,
  PasswordChange,
  PlatformAdmin,
  PlatformCollege,
  PrivacyNotice,
  PrivacyNoticeAcceptance,
  ShopOrderHistory,
  ShopReinstatement,
  ShopSuspension,
  SocketException,
  StudentReinstatement,
  StudentSuspension,
  TaskOfferWithdrawn,
  TaskStatusEvent,
} from '../src';

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

// ---------------------------------------------------------------------------
// Round three: the A1, A2 and A5 contracts.
// ---------------------------------------------------------------------------
type Result<F> = F extends (...args: never[]) => Promise<infer R> ? R : never;
type Admin = Api['admin'];

// A1: admin order report and shop history.
assertType<Equal<Result<Admin['orders']['list']>, AdminOrderList>>();
assertType<Equal<Result<Admin['orders']['summary']>, AdminOrderSummary>>();
assertType<Equal<Result<Admin['orders']['detail']>, AdminOrderDetail>>();
assertType<Equal<Result<Api['shops']['orderHistory']>, ShopOrderHistory>>();
assertType<Equal<AdminOrderList['items'][number]['rider'], { id: string; name: string } | null>>();
assertType<Equal<AdminOrderSummary['money']['basis'], 'COMPLETED'>>();
assertType<Equal<AdminOrderSummary['timings']['medianPlacedToAcceptedSeconds'], number | null>>();
assertType<Equal<keyof AdminOrderSummary['cancellations']['byWho'], 'STUDENT' | 'SHOP' | 'ADMIN' | 'SYSTEM'>>();
// The shop is not shown the delivery fee or the total (contract section 4).
assertType<Equal<'totalMinor' extends keyof ShopOrderHistory['items'][number] ? true : false, false>>();
assertType<Equal<ShopOrderHistory['items'][number]['netToShopMinor'], number>>();
// The detail has a timeline instead of the list row's placedAt.
assertType<Equal<'placedAt' extends keyof AdminOrderDetail ? true : false, false>>();
assertType<Equal<AdminOrderDetail['walletEntries'][number]['party'], 'STUDENT' | 'RIDER' | 'OTHER'>>();

// Orders lane: what a cancellation or rejection returned to the wallet.
assertType<Equal<Result<Api['orders']['cancel']>['refundedMinor'], number>>();
assertType<Equal<Result<Api['shops']['rejectOrder']>['refundedMinor'], number>>();
type Unfulfilled = Result<Api['orders']['resolveUnfulfilled']>;
assertType<Equal<Unfulfilled['refundedMinor'], number | undefined>>();
assertType<Equal<Unfulfilled['refundedFeeMinor'], number | undefined>>();

// A2: escalations.
assertType<Equal<Result<Admin['escalations']['list']>, Paged<Escalation>>>();
assertType<Equal<Result<Admin['escalations']['detail']>, Escalation>>();
assertType<Equal<Result<Admin['escalations']['resolve']>, EscalationResolution>>();
assertType<Equal<Escalation['canResolveAs'], ('DELIVERED' | 'NOT_DELIVERED')[]>>();
assertType<Equal<EscalationResolution['status'], 'COMPLETED' | 'CANCELLED'>>();
// @ts-expect-error DISPUTED is not an outcome in this release
void ((api: Api) => api.admin.escalations.resolve('t', 'DISPUTED', 'a note long enough'));

// A5 section 1: college configuration.
assertType<Equal<Result<Admin['config']['get']>, CollegeConfig>>();
assertType<Equal<Result<Admin['config']['update']>, CollegeConfigUpdateResult>>();
assertType<Equal<CollegeConfig['feeBands'][number]['maxDistanceM'], number | null>>();
assertType<Equal<CollegeConfig['limits']['maxOtpAttempts'], { min: number; max: number }>>();
// @ts-expect-error the radius is changed through admin.updateRadius, not here
void ((api: Api) => api.admin.config.update({ serviceableRadiusM: 2000 }));

// A5 section 2: delivery points.
assertType<Equal<Result<Admin['deliveryPoints']['list']>, { points: AdminDeliveryPoint[] }>>();
assertType<Equal<Result<Admin['deliveryPoints']['create']>, AdminDeliveryPoint>>();
assertType<Equal<Result<Admin['deliveryPoints']['reorder']>, { points: AdminDeliveryPoint[] }>>();
assertType<Equal<AdminDeliveryPoint['isActive'], boolean>>();
// There is no delete route.
assertType<Equal<'delete' extends keyof Admin['deliveryPoints'] ? true : false, false>>();

// A5 section 3: audit log.
assertType<Equal<Result<Admin['audit']['list']>, Paged<AuditLogEntry>>>();
assertType<Equal<Result<Admin['audit']['actions']>, { actions: string[] }>>();
assertType<Equal<AuditLogEntry['actor'], { id: string; name: string; role: AuthUser['role'] } | null>>();

// A5 section 4: students and shops.
assertType<Equal<Result<Admin['listStudents']>, Paged<AdminStudentListItem>>>();
assertType<Equal<Result<Admin['studentDetail']>, AdminStudentDetail>>();
assertType<Equal<Result<Admin['listShops']>, Paged<AdminShopListItem>>>();
assertType<Equal<Result<Admin['shopDetail']>, AdminShopDetail>>();
assertType<Equal<Result<Admin['suspendStudent']>, StudentSuspension>>();
assertType<Equal<Result<Admin['reinstateStudent']>, StudentReinstatement>>();
assertType<Equal<Result<Admin['suspendShop']>, ShopSuspension>>();
assertType<Equal<Result<Admin['reinstateShop']>, ShopReinstatement>>();
assertType<Equal<StudentSuspension['suspendedBy'], { id: string; name: string } | null>>();
assertType<Equal<AdminShopDetail['rating'], { average: number | null; count: number }>>();

// A5 section 5: privacy and the account.
assertType<Equal<Result<Api['privacy']['notice']>, PrivacyNotice>>();
assertType<Equal<Result<Api['account']['export']>, AccountExport>>();
assertType<Equal<Result<Api['account']['delete']>, AccountDeletion>>();
assertType<Equal<PrivacyNotice['sections'][number]['key'], 'dataCollected' | 'purpose' | 'retention' | 'grievance'>>();
assertType<Equal<AuthUser['privacyNotice'], PrivacyNoticeAcceptance | null | undefined>>();
assertType<Equal<AccountDeletion['status'], 'DEACTIVATED'>>();

// A5 section 6: platform.
type Platform = Api['superAdmin'];
assertType<Equal<Result<Platform['colleges']>, { colleges: PlatformCollege[] }>>();
assertType<Equal<Result<Platform['college']>, PlatformCollege & { admins: PlatformAdmin[] }>>();
assertType<Equal<Result<Platform['createAdmin']>, PlatformAdmin>>();
assertType<Equal<Result<Platform['deactivateAdmin']>, PlatformAdmin>>();
assertType<Equal<PlatformCollege['status'], 'ACTIVE' | 'INACTIVE'>>();

// ---------------------------------------------------------------------------
// Round four: A5 contract section 8, and A2's escalations as implemented.
// ---------------------------------------------------------------------------
assertType<Equal<Result<Api['privacy']['accept']>, PrivacyNoticeAcceptance>>();
// PATCH /account/profile answers with the body of GET /auth/me.
assertType<Equal<Result<Api['account']['updateProfile']>, Result<Api['auth']['me']>>>();
// @ts-expect-error email is not editable in Phase 1
void ((api: Api) => api.account.updateProfile({ email: 'a@b.c' }));
// A password change returns a token pair the caller must store.
assertType<Equal<Result<Api['auth']['changePassword']>, PasswordChange>>();
assertType<Equal<PasswordChange['accessToken'], string>>();
assertType<Equal<PasswordChange['refreshToken'], string>>();
assertType<Equal<PasswordChange['sessionsRevoked'], number>>();
assertType<
  Equal<Result<Platform['setAdminPassword']>, PlatformAdmin & { sessionsRevoked: number }>
>();

// EscalationsService.present: once resolved, the reason is null and the
// administrator's note and time are present instead.
assertType<Equal<Escalation['escalationReason'], string | null>>();
assertType<Equal<Escalation['resolvedAt'], string | null | undefined>>();
assertType<Equal<Escalation['resolutionNote'], string | null | undefined>>();
// The contract says an escalated task always names its rider.
assertType<Equal<null extends Escalation['rider'] ? true : false, false>>();
