import type { ApiClient, TokenPair } from './client';
import type {
  ActiveTask,
  AuthUser,
  BrowseShop,
  Catalog,
  CatalogCategory,
  CatalogItem,
  College,
  FlaggedShop,
  ItemSearchResult,
  MyOrder,
  MyShop,
  OrderDetail,
  OrderQuote,
  OrderRequestBody,
  Paged,
  RiderStatus,
  ShopDetail,
  ShopQueue,
  ShopQueueItem,
  VerificationQueueItem,
} from './types';

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
        client.post<{ orderId: string; status: string; message: string }>(
          `/shops/${listingId}/orders/${orderId}/reject`,
          { reason },
        ),

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
        client.patch<CatalogCategory>(
          `/shops/${listingId}/catalog/categories/${categoryId}`,
          body,
        ),

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
      ) => client.put<{ hours: Catalog['hours']; message: string }>(
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
        client.post<{
          studentId: string;
          status: string;
          sessionsRevoked: number;
          taskReleased: string | null;
          message: string;
        }>(`/admin/verification/students/${studentId}/suspend`, { reason }),

      reinstateStudent: (studentId: string) =>
        client.post<{ studentId: string; status: string; message: string }>(
          `/admin/verification/students/${studentId}/reinstate`,
          {},
        ),

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
        client.post<{
          listingId: string;
          status: string;
          inFlightOrders: number;
          message: string;
        }>(`/admin/shops/${listingId}/suspend`, { reason }),

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
    },

    verification: {
      /** FR-SVER-01: status, plus what it unlocks. */
      me: () =>
        client.get<{
          status: 'UNSUBMITTED' | 'PENDING' | 'VERIFIED' | 'REJECTED';
          verifiedAt: string | null;
          profile: { rollNumber: string | null; department: string | null; yearOfStudy: number | null };
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
    },

    orders: {
      /** FR-ORD-03 */
      quote: (body: OrderRequestBody) => client.post<OrderQuote>('/orders/quote', body),

      /** FR-ORD-04 */
      place: (body: OrderRequestBody & { paymentMethod: string; expectedTotalMinor: number; studentNote?: string }) =>
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

      /** FR-ORD-05 */
      cancel: (orderId: string, reason?: string) =>
        client.post<{ orderId: string; status: string; message: string }>(
          `/orders/${orderId}/cancel`,
          { reason },
        ),

      /** FR-DLV-07 */
      resolveUnfulfilled: (orderId: string, choice: 'KEEP_WAITING' | 'COLLECT_IN_PERSON' | 'CANCEL') =>
        client.post<{ orderId: string; choice: string; message: string }>(
          `/orders/${orderId}/unfulfilled`,
          { choice },
        ),
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

    uploads: {
      url: (body: { kind: string; contentType: string; sizeBytes: number; originalFilename?: string }) =>
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
