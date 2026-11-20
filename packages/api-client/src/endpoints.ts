import type { ApiClient, TokenPair } from './client';
import type {
  AccountDeletion,
  AccountExport,
  ActiveTask,
  AdminDeliveryPoint,
  AdminOrderDetail,
  AdminOrderList,
  AdminOrderListQuery,
  AdminOrderSummary,
  AdminShopDetail,
  AdminShopListItem,
  AdminShopListQuery,
  AdminStudentDetail,
  AdminStudentListItem,
  AdminStudentListQuery,
  AuditLogEntry,
  AuditLogQuery,
  AuthUser,
  BrowseShop,
  Catalog,
  CatalogCategory,
  CatalogItem,
  ChatHistory,
  ChatSendResult,
  College,
  CollegeConfig,
  CollegeConfigUpdate,
  CollegeConfigUpdateResult,
  CollegeRadius,
  DeliveryPoint,
  DeliveryPointCreate,
  DeliveryPointUpdate,
  Escalation,
  EscalationOutcome,
  EscalationResolution,
  FlaggedShop,
  ItemSearchResult,
  MyOrder,
  MyShop,
  OrderDetail,
  OrderQuote,
  OrderRequestBody,
  OrderStatus,
  Paged,
  PasswordChange,
  PlatformAdmin,
  PlatformAdminCreate,
  PlatformCollege,
  PlatformCollegeCreate,
  PrivacyNotice,
  ReorderDraft,
  RiderEarnings,
  RiderPresence,
  PrivacyNoticeAcceptance,
  ProfileUpdate,
  RiderStatus,
  ShopDetail,
  ShopOrderHistory,
  ShopOrderHistoryQuery,
  ShopQueue,
  ShopQueueItem,
  ShopReinstatement,
  ShopSettlementQuery,
  ShopSettlementStatement,
  ShopSuspension,
  StudentReinstatement,
  StudentSuspension,
  VerificationQueueItem,
  WalletStatement,
  WalletStatementQuery,
  WalletWithdrawals,
} from './types';

/** The API takes several statuses as one comma-separated value. */
function statusList(status?: OrderStatus | OrderStatus[]): string | undefined {
  if (status === undefined) return undefined;
  const joined = Array.isArray(status) ? status.join(',') : status;
  return joined || undefined;
}

/**
 * Endpoint wrappers.
 *
 * Thin on purpose: each one is a path, a method and a return type. The value
 * is that a screen says `api.shops.queue(listingId)` rather than hand-writing
 * a URL, so a route change breaks the build in one place instead of silently
 * 404ing in three.
 */
export function endpoints(client: ApiClient) {
  return {
    auth: {
      colleges: (q?: string) =>
        client.get<{ colleges: College[] }>('/auth/colleges', q ? { q } : undefined),

      login: (identifier: string, password: string) =>
        client.anonymousPost<TokenPair>('/auth/login', { identifier, password }),

      requestMobileOtp: (mobile: string) =>
        client.anonymousPost<{ challengeId: string; expiresAt: string; devCode?: string }>(
          '/auth/mobile/request-otp',
          { mobile },
        ),

      verifyMobileOtp: (challengeId: string, code: string) =>
        client.anonymousPost<{ verified: boolean }>('/auth/mobile/verify-otp', {
          challengeId,
          code,
        }),

      register: (body: {
        name: string;
        mobile: string;
        email: string;
        password: string;
        collegeId: string;
        mobileOtpChallengeId: string;
        /** FR-PRIV-01: the `version` of the notice shown and accepted. */
        privacyNoticeVersion?: string;
      }) => client.anonymousPost<TokenPair & { userId: string }>('/auth/register', body),

      me: () => client.get<{ user: AuthUser }>('/auth/me'),

      logout: (refreshToken?: string, allDevices?: boolean) =>
        client.post<{ revoked: number }>('/auth/logout', { refreshToken, allDevices }),

      requestPasswordReset: (mobile: string) =>
        client.anonymousPost<{ message: string; challengeId?: string; devCode?: string }>(
          '/auth/password/request-reset',
          { mobile },
        ),

      resetPassword: (challengeId: string, code: string, newPassword: string) =>
        client.anonymousPost<{ message: string }>('/auth/password/reset', {
          challengeId,
          code,
          newPassword,
        }),

      /**
       * S-50. Any signed-in role.
       *
       * The change ends every session of the account, including the refresh
       * token this client is holding, and the answer carries a new pair. The
       * caller MUST store it straight away with `ApiClient.setTokens(result)`,
       * exactly as after login: carrying on with the old pair gets
       * `401 REFRESH_REUSED` at the next refresh and signs the user out of
       * the device they just changed their password on.
       *
       * `403 PASSWORD_INCORRECT` is a wrong current password, not an expired
       * session. `400 PASSWORD_UNCHANGED` when the new one equals the old.
       */
      changePassword: (currentPassword: string, newPassword: string) =>
        client.post<PasswordChange>('/auth/password/change', { currentPassword, newPassword }),
    },

    shops: {
      /** D-03 / D-04: the radius check, before committing to a registration. */
      distanceCheck: (body: {
        collegeId: string;
        address?: string;
        latitude?: number;
        longitude?: number;
      }) =>
        client.anonymousPost<{
          college: { id: string; name: string };
          latitude: number;
          longitude: number;
          formattedAddress?: string;
          distanceM: number;
          distanceLabel: string;
          radiusM: number;
          radiusLabel: string;
          withinRadius: boolean;
          needsPinConfirmation: boolean;
          message: string;
        }>('/shops/distance-check', body),

      register: (body: Record<string, unknown>) =>
        client.anonymousPost<{
          shopId: string;
          listingId: string;
          ownerId: string;
          status: string;
          distanceM: number;
          distanceLabel: string;
          message: string;
        }>('/shops/register', body),

      mine: () => client.get<{ shops: MyShop[] }>('/shops/mine'),

      /** D-08: the live queue. */
      queue: (listingId: string) => client.get<ShopQueue>(`/shops/${listingId}/orders`),

      /**
       * D-14: the settlement statement. Owner or ADMIN only — counter staff
       * get `403 NOT_SHOP_OWNER`. Read-only: nothing here pays anyone.
       */
      settlements: (listingId: string, query: ShopSettlementQuery = {}) =>
        client.get<ShopSettlementStatement>(`/shops/${listingId}/settlements`, { ...query }),

      /** D-10: orders that are over (completed and cancelled by default), a page at a time. */
      orderHistory: (listingId: string, query: ShopOrderHistoryQuery = {}) =>
        client.get<ShopOrderHistory>(`/shops/${listingId}/orders/history`, {
          ...query,
          status: statusList(query.status),
        }),

      acceptOrder: (listingId: string, orderId: string, prepMinutes?: number) =>
        client.post<{
          orderId: string;
          status: string;
          prepMinutes: number;
          expectedReadyAt: string;
          dispatchDueAt: string;
          message: string;
        }>(`/shops/${listingId}/orders/${orderId}/accept`, { prepMinutes }),

      rejectOrder: (listingId: string, orderId: string, reason: string) =>
        client.post<{
          orderId: string;
          status: string;
          /** What went back to the student's wallet; 0 for a cash order. */
          refundedMinor: number;
          message: string;
        }>(`/shops/${listingId}/orders/${orderId}/reject`, { reason }),

      markReady: (listingId: string, orderId: string) =>
        client.post<{ orderId: string; status: string; message: string }>(
          `/shops/${listingId}/orders/${orderId}/ready`,
          {},
        ),
    },

    catalog: {
      get: (listingId: string) => client.get<Catalog>(`/shops/${listingId}/catalog`),

      createCategory: (listingId: string, name: string, sortOrder?: number) =>
        client.post<CatalogCategory>(`/shops/${listingId}/catalog/categories`, {
          name,
          sortOrder,
        }),

      updateCategory: (
        listingId: string,
        categoryId: string,
        body: { name?: string; sortOrder?: number },
      ) =>
        client.patch<CatalogCategory>(`/shops/${listingId}/catalog/categories/${categoryId}`, body),

      deleteCategory: (listingId: string, categoryId: string) =>
        client.delete<{ deleted: boolean; itemsUncategorised: number; message: string }>(
          `/shops/${listingId}/catalog/categories/${categoryId}`,
        ),

      createItem: (listingId: string, body: Record<string, unknown>) =>
        client.post<CatalogItem>(`/shops/${listingId}/catalog/items`, body),

      updateItem: (listingId: string, itemId: string, body: Record<string, unknown>) =>
        client.patch<CatalogItem>(`/shops/${listingId}/catalog/items/${itemId}`, body),

      setAvailability: (listingId: string, itemIds: string[], isAvailable: boolean) =>
        client.post<{ updated: number; isAvailable: boolean; message: string }>(
          `/shops/${listingId}/catalog/items/availability`,
          { itemIds, isAvailable },
        ),

      deleteItem: (listingId: string, itemId: string) =>
        client.delete<{ deleted: boolean; message: string }>(
          `/shops/${listingId}/catalog/items/${itemId}`,
        ),

      setHours: (
        listingId: string,
        hours: { dayOfWeek: number; openMinute: number; closeMinute: number }[],
      ) =>
        client.put<{ hours: Catalog['hours']; message: string }>(
          `/shops/${listingId}/catalog/hours`,
          { hours },
        ),

      setClosure: (listingId: string, reopenAt: string, note?: string) =>
        client.post<{ temporarilyClosedUntil: string; note: string | null; message: string }>(
          `/shops/${listingId}/catalog/closure`,
          { reopenAt, note },
        ),

      clearClosure: (listingId: string) =>
        client.delete<{ message: string }>(`/shops/${listingId}/catalog/closure`),
    },

    admin: {
      /** A-03 */
      verificationQueue: (limit?: number, cursor?: string) =>
        client.get<Paged<VerificationQueueItem>>('/admin/verification/queue', {
          limit,
          cursor,
        }),

      viewVerificationDocuments: (submissionId: string) =>
        client.get<{
          idCardUrl: string;
          govtIdImageUrl: string | null;
          govtIdImageExpired: boolean;
        }>(`/admin/verification/${submissionId}/documents`),

      approveVerification: (submissionId: string, note?: string) =>
        client.post<{ submissionId: string; status: string; message: string }>(
          `/admin/verification/${submissionId}/approve`,
          { note },
        ),

      rejectVerification: (submissionId: string, reason: string, note?: string) =>
        client.post<{ submissionId: string; status: string; message: string }>(
          `/admin/verification/${submissionId}/reject`,
          { reason, note },
        ),

      suspendStudent: (studentId: string, reason: string) =>
        client.post<StudentSuspension>(`/admin/verification/students/${studentId}/suspend`, {
          reason,
        }),

      reinstateStudent: (studentId: string) =>
        client.post<StudentReinstatement>(
          `/admin/verification/students/${studentId}/reinstate`,
          {},
        ),

      /** A-04: find a student of my college. */
      listStudents: (query: AdminStudentListQuery = {}) =>
        client.get<Paged<AdminStudentListItem>>('/admin/students', { ...query }),

      /** A-04 */
      studentDetail: (studentId: string) =>
        client.get<AdminStudentDetail>(`/admin/students/${studentId}`),

      /** A-05 */
      shopQueue: (limit?: number, cursor?: string) =>
        client.get<Paged<ShopQueueItem>>('/admin/shops/queue', { limit, cursor }),

      viewShopDocument: (listingId: string, documentId: string) =>
        client.get<{
          documentId: string;
          docType: string;
          fileName: string | null;
          url: string | null;
        }>(`/admin/shops/${listingId}/documents/${documentId}`),

      approveShop: (listingId: string) =>
        client.post<{ listingId: string; status: string; message: string }>(
          `/admin/shops/${listingId}/approve`,
          {},
        ),

      rejectShop: (listingId: string, reason: string, note?: string) =>
        client.post<{ listingId: string; status: string; reason: string }>(
          `/admin/shops/${listingId}/reject`,
          { reason, note },
        ),

      suspendShop: (listingId: string, reason: string) =>
        client.post<ShopSuspension>(`/admin/shops/${listingId}/suspend`, { reason }),

      /** The way back from a suspension. 409 `NOT_SUSPENDED` otherwise. */
      reinstateShop: (listingId: string) =>
        client.post<ShopReinstatement>(`/admin/shops/${listingId}/reinstate`, {}),

      /** A-06: every listing of my college, in any state. */
      listShops: (query: AdminShopListQuery = {}) =>
        client.get<Paged<AdminShopListItem>>('/admin/shops', { ...query }),

      /** A-06 */
      shopDetail: (listingId: string) => client.get<AdminShopDetail>(`/admin/shops/${listingId}`),

      /** A-09: the radius in force, with the bounds a change must stay within. */
      radius: () => client.get<CollegeRadius>('/admin/college/radius'),

      /** A-09 */
      updateRadius: (serviceableRadiusM: number) =>
        client.patch<{
          collegeId: string;
          previousRadiusM: number;
          serviceableRadiusM: number;
          shopsFlaggedForReview: number;
          message: string;
        }>('/admin/college/radius', { serviceableRadiusM }),

      flaggedShops: () => client.get<{ items: FlaggedShop[] }>('/admin/college/radius/flagged'),

      /** FR-ADM-05, A-02, A-07: the order report. */
      orders: {
        list: (query: AdminOrderListQuery = {}) =>
          client.get<AdminOrderList>('/admin/orders', {
            ...query,
            status: statusList(query.status),
          }),

        /** Both dates default to today in the college's timezone; at most 366 days. */
        summary: (query: { from?: string; to?: string; collegeId?: string } = {}) =>
          client.get<AdminOrderSummary>('/admin/orders/summary', { ...query }),

        detail: (orderId: string) => client.get<AdminOrderDetail>(`/admin/orders/${orderId}`),
      },

      /** FR-ADM-04, A-08 */
      escalations: {
        /** Oldest first: the one that has waited longest is at the top. */
        list: (limit?: number, cursor?: string) =>
          client.get<Paged<Escalation>>('/admin/escalations', { limit, cursor }),

        /** Also answers for a task since resolved, so the outcome can be shown after a 409. */
        detail: (taskId: string) => client.get<Escalation>(`/admin/escalations/${taskId}`),

        /** `note` is mandatory: 10 to 500 characters. */
        resolve: (taskId: string, outcome: EscalationOutcome, note: string) =>
          client.post<EscalationResolution>(`/admin/escalations/${taskId}/resolve`, {
            outcome,
            note,
          }),
      },

      /** FR-ADM-03, A-09. The radius is not here: see `updateRadius`. */
      config: {
        get: () => client.get<CollegeConfig>('/admin/college/config'),

        update: (body: CollegeConfigUpdate) =>
          client.patch<CollegeConfigUpdateResult>('/admin/college/config', body),
      },

      /** FR-ORD-02, A-10. There is no delete: a point is retired by deactivating it. */
      deliveryPoints: {
        /** Active and inactive, by `sortOrder` then name. */
        list: () => client.get<{ points: AdminDeliveryPoint[] }>('/admin/delivery-points'),

        create: (body: DeliveryPointCreate) =>
          client.post<AdminDeliveryPoint>('/admin/delivery-points', body),

        update: (pointId: string, body: DeliveryPointUpdate) =>
          client.patch<AdminDeliveryPoint>(`/admin/delivery-points/${pointId}`, body),

        deactivate: (pointId: string) =>
          client.post<AdminDeliveryPoint>(`/admin/delivery-points/${pointId}/deactivate`, {}),

        activate: (pointId: string) =>
          client.post<AdminDeliveryPoint>(`/admin/delivery-points/${pointId}/activate`, {}),

        /** Every point of the college, each once, in the order wanted. */
        reorder: (pointIds: string[]) =>
          client.put<{ points: AdminDeliveryPoint[] }>('/admin/delivery-points/order', {
            pointIds,
          }),
      },

      /** FR-ADM-06, A-15. Read-only; "export" is paging to the end. */
      audit: {
        list: (query: AuditLogQuery = {}) =>
          client.get<Paged<AuditLogEntry>>('/admin/audit-log', { ...query }),

        /** The known action names, for the filter control. */
        actions: () => client.get<{ actions: string[] }>('/admin/audit-log/actions'),
      },

      /**
       * FR-ADM-05, A-14: active riders per clock hour. `from` inclusive, `to`
       * exclusive, both ISO date-times with an offset or `Z`; at most 92 days.
       */
      riderPresence: (from: string, to: string) =>
        client.get<RiderPresence>('/admin/riders/presence', { from, to }),
    },

    /** FR-TEN-01, FR-ADM-07, A-16, A-18. SUPER_ADMIN only: an ADMIN gets 403. */
    superAdmin: {
      colleges: () => client.get<{ colleges: PlatformCollege[] }>('/platform/colleges'),

      createCollege: (body: PlatformCollegeCreate) =>
        client.post<PlatformCollege>('/platform/colleges', body),

      college: (collegeId: string) =>
        client.get<PlatformCollege & { admins: PlatformAdmin[] }>(
          `/platform/colleges/${collegeId}`,
        ),

      deactivateCollege: (collegeId: string, reason: string) =>
        client.post<PlatformCollege>(`/platform/colleges/${collegeId}/deactivate`, { reason }),

      activateCollege: (collegeId: string) =>
        client.post<PlatformCollege>(`/platform/colleges/${collegeId}/activate`, {}),

      /** Creates a new ADMIN account attached to that college. */
      createAdmin: (collegeId: string, body: PlatformAdminCreate) =>
        client.post<PlatformAdmin>(`/platform/colleges/${collegeId}/admins`, body),

      deactivateAdmin: (userId: string, reason: string) =>
        client.post<PlatformAdmin>(`/platform/admins/${userId}/deactivate`, { reason }),

      reactivateAdmin: (userId: string) =>
        client.post<PlatformAdmin>(`/platform/admins/${userId}/reactivate`, {}),

      /** Set an administrator's password (10 to 128 characters); ends their sessions. */
      setAdminPassword: (userId: string, password: string) =>
        client.post<PlatformAdmin & { sessionsRevoked: number }>(
          `/platform/admins/${userId}/password`,
          { password },
        ),
    },

    /** FR-PRIV-01 */
    privacy: {
      /** Public: no session is needed to read it. */
      notice: () => client.get<PrivacyNotice>('/legal/privacy-notice'),

      /**
       * Record that the signed-in user accepts `version` (the notice's own
       * `version`). Accepting again returns the existing acceptance.
       * `409 PRIVACY_NOTICE_OUTDATED` if it is no longer the current one.
       */
      accept: (version: string) =>
        client.post<PrivacyNoticeAcceptance>('/legal/privacy-notice/accept', { version }),
    },

    /** FR-PRIV-05, S-55. STUDENT, own account only. */
    account: {
      /** Rate-limited to five an hour. */
      export: () => client.get<AccountExport>('/account/export'),

      /** S-50: name and photo only. Answers with the same body as `auth.me()`. */
      updateProfile: (body: ProfileUpdate) =>
        client.patch<{ user: AuthUser }>('/account/profile', body),

      /** Refused while a task is open, the wallet holds money or a withdrawal is pending. */
      delete: (password: string) => client.post<AccountDeletion>('/account/delete', { password }),
    },

    verification: {
      /** FR-SVER-01: status, plus what it unlocks. */
      me: () =>
        client.get<{
          status: 'UNSUBMITTED' | 'PENDING' | 'VERIFIED' | 'REJECTED';
          verifiedAt: string | null;
          profile: {
            rollNumber: string | null;
            department: string | null;
            yearOfStudy: number | null;
          };
          latestSubmission: {
            id: string;
            status: string;
            submittedAt: string;
            decidedAt: string | null;
            rejectionReason: string | null;
            rejectionNote: string | null;
          } | null;
          submissionsUsed: number;
          submissionsAllowed: number;
          /**
           * When the rolling submission window next frees an attempt (ISO
           * timestamp). Always sent; null while attempts remain.
           */
          retryAt: string | null;
          unlocked: {
            browseShops: boolean;
            placeOrders: boolean;
            workMode: boolean;
            chat: boolean;
            community: boolean;
          };
        }>('/verification/me'),

      /** FR-SVER-02 */
      submit: (body: {
        rollNumber: string;
        department: string;
        yearOfStudy: number;
        idCardUrl: string;
        govtIdType?: string;
        govtIdLast4?: string;
      }) =>
        client.post<{
          submissionId: string;
          status: string;
          submissionsUsed: number;
          submissionsAllowed: number;
          message: string;
        }>('/verification/submit', body),

      /** FR-WM-02 */
      acceptRiderTerms: () =>
        client.post<{ accepted: boolean; version: string }>('/verification/rider-terms/accept', {}),
    },

    browse: {
      /** FR-CAT-06 */
      shops: (query?: {
        category?: string;
        q?: string;
        sort?: 'distance' | 'rating' | 'prepTime';
        openNow?: boolean;
        limit?: number;
        cursor?: string;
      }) => client.get<{ items: BrowseShop[]; nextCursor: string | null }>('/browse/shops', query),

      shop: (listingId: string) => client.get<ShopDetail>(`/browse/shops/${listingId}`),

      items: (q: string) =>
        client.get<{ query: string; items: ItemSearchResult[] }>('/browse/items', { q }),

      /** The drop points offered at checkout. */
      deliveryPoints: () => client.get<{ points: DeliveryPoint[] }>('/browse/delivery-points'),
    },

    orders: {
      /** FR-ORD-03 */
      quote: (body: OrderRequestBody) => client.post<OrderQuote>('/orders/quote', body),

      /** FR-ORD-04 */
      place: (
        body: OrderRequestBody & {
          paymentMethod: string;
          expectedTotalMinor: number;
          studentNote?: string;
        },
      ) =>
        client.post<{
          orderId: string;
          reference: string;
          status: string;
          taskId: string;
          totals: OrderQuote['totals'];
          message: string;
        }>('/orders', body),

      mine: (limit?: number, cursor?: string) =>
        client.get<{ items: MyOrder[]; nextCursor: string | null }>('/orders', { limit, cursor }),

      detail: (orderId: string) => client.get<OrderDetail>(`/orders/${orderId}`),

      /**
       * S-21: a past order as a draft cart at today's prices. Places nothing;
       * show it, let the student edit, then go through `quote` and `place`.
       */
      reorder: (orderId: string) => client.get<ReorderDraft>(`/orders/${orderId}/reorder`),

      /** FR-ORD-05 */
      cancel: (orderId: string, reason?: string) =>
        client.post<{
          orderId: string;
          status: string;
          /** The held total returned to the wallet; 0 for a cash order. */
          refundedMinor: number;
          message: string;
        }>(`/orders/${orderId}/cancel`, { reason }),

      /** FR-DLV-07 */
      resolveUnfulfilled: (
        orderId: string,
        choice: 'KEEP_WAITING' | 'COLLECT_IN_PERSON' | 'CANCEL',
      ) =>
        client.post<{
          orderId: string;
          choice: string;
          /** CANCEL only: the total refunded to the wallet; 0 for a cash order. */
          refundedMinor?: number;
          /** COLLECT_IN_PERSON only: the delivery fee refunded; 0 for a cash order. */
          refundedFeeMinor?: number;
          message: string;
        }>(`/orders/${orderId}/unfulfilled`, { choice }),
    },

    rider: {
      /** FR-WM-08 */
      status: () => client.get<RiderStatus>('/rider/status'),

      /** FR-WM-01, FR-WM-05 */
      setWorkMode: (enabled: boolean, latitude?: number, longitude?: number) =>
        client.post<{ workModeOn: boolean; activeTaskId: string | null; message: string }>(
          '/rider/work-mode',
          { enabled, latitude, longitude },
        ),

      /** FR-WM-03, HTTP fallback for the socket. */
      ping: (latitude: number, longitude: number) =>
        client.post<{ ok: boolean }>('/rider/ping', { latitude, longitude }),

      /** FR-DLV-04 */
      accept: (taskId: string) =>
        client.post<{
          taskId: string;
          status: string;
          feeMinor: number;
          pickupLabel: string;
          dropLabel: string;
          chatRoomId: string;
        }>(`/rider/tasks/${taskId}/accept`, {}),

      /** FR-DLV-08 */
      abandon: (taskId: string, reason: string) =>
        client.post<{ taskId: string; abandoned: boolean; barred: boolean; message: string }>(
          `/rider/tasks/${taskId}/abandon`,
          { reason },
        ),

      task: (taskId: string) => client.get<ActiveTask>(`/rider/tasks/${taskId}`),

      /** FR-DLV-11 */
      confirmPickup: (taskId: string, proofImageKey?: string) =>
        client.post<{ taskId: string; status: string; message: string }>(
          `/rider/tasks/${taskId}/pickup`,
          { proofImageKey },
        ),

      /** FR-DLV-13, FR-DLV-14 */
      submitHandoverCode: (taskId: string, code: string) =>
        client.post<{
          taskId: string;
          status: string;
          feeMinor: number;
          feeLabel: string;
          settledInCash: boolean;
          message: string;
        }>(`/rider/tasks/${taskId}/handover`, { code }),
    },

    tasks: {
      /** FR-DLV-12: the requester's side. */
      handoverCode: (taskId: string) =>
        client.get<{
          taskId: string;
          codeIssuedAt: string | null;
          codeLength: number;
          canReissue: boolean;
          message: string;
        }>(`/tasks/${taskId}/handover-code`),

      reissueHandoverCode: (taskId: string) =>
        client.post<{ taskId: string; code: string; message: string }>(
          `/tasks/${taskId}/handover-code/reissue`,
          {},
        ),
    },

    /** FR-PAY-04, S-24. STUDENT, own wallet only. Read-only: nothing requests a withdrawal. */
    wallet: {
      /** Oldest first, like a bank statement. */
      statement: (query: WalletStatementQuery = {}) =>
        client.get<WalletStatement>('/wallet/statement', { ...query }),

      /** Default range: the current month to date. At most 366 days. */
      earnings: (query: { from?: string; to?: string } = {}) =>
        client.get<RiderEarnings>('/wallet/earnings', { ...query }),

      /** Newest first. */
      withdrawals: (limit?: number, cursor?: string) =>
        client.get<WalletWithdrawals>('/wallet/withdrawals', { limit, cursor }),
    },

    /**
     * FR-DLV-10: text chat between the student who ordered and the rider.
     * One conversation, reachable by its task (what the rider knows) or its
     * order (what the student knows).
     */
    chat: {
      /** Newest first; pass the previous `nextCursor` as `before` for older messages. */
      taskMessages: (taskId: string, query: { limit?: number; before?: string } = {}) =>
        client.get<ChatHistory>(`/chat/tasks/${taskId}/messages`, { ...query }),

      orderMessages: (orderId: string, query: { limit?: number; before?: string } = {}) =>
        client.get<ChatHistory>(`/chat/orders/${orderId}/messages`, { ...query }),

      /**
       * FR-CHAT-04: mint `clientMessageId` once per message (8 to 64
       * characters of `A-Za-z0-9_-`; a UUID is fine) and send the SAME one on
       * every retry. A retry answers with the stored message and
       * `duplicate: true`; treat both as success.
       */
      sendToTask: (taskId: string, body: string, clientMessageId: string) =>
        client.post<ChatSendResult>(`/chat/tasks/${taskId}/messages`, { body, clientMessageId }),

      sendToOrder: (orderId: string, body: string, clientMessageId: string) =>
        client.post<ChatSendResult>(`/chat/orders/${orderId}/messages`, {
          body,
          clientMessageId,
        }),
    },

    uploads: {
      url: (body: {
        kind: string;
        contentType: string;
        sizeBytes: number;
        originalFilename?: string;
      }) =>
        client.post<{ uploadUrl: string; key: string; expiresInSeconds: number }>(
          '/uploads/url',
          body,
        ),
    },

    health: {
      ready: () =>
        client.get<{
          status: string;
          checks: Record<string, { ok: boolean; detail?: string }>;
        }>('/health/ready'),
    },
  };
}

export type Endpoints = ReturnType<typeof endpoints>;
