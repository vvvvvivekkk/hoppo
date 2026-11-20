/**
 * Response shapes.
 *
 * Hand-written rather than generated, and only the fields the clients
 * actually read. A generated client from the OpenAPI document would drift
 * less, but would also pull every field of every model into every app;
 * these are the contracts the UI depends on, which makes a breaking API
 * change a compile error in the screen that cares.
 */

export interface College {
  id: string;
  name: string;
  shortName: string | null;
  city: string;
  state: string;
  emailDomain: string | null;
}

export interface AuthUser {
  id: string;
  name: string;
  mobile: string;
  email: string;
  role: 'STUDENT' | 'SHOP_OWNER' | 'SHOP_STAFF' | 'ADMIN' | 'SUPER_ADMIN';
  status: 'ACTIVE' | 'SUSPENDED' | 'DEACTIVATED';
  avatarUrl: string | null;
  college: { id: string; name: string; shortName: string | null } | null;
  studentProfile: {
    rollNumber: string;
    department: string;
    yearOfStudy: number;
    verificationStatus: 'UNSUBMITTED' | 'PENDING' | 'VERIFIED' | 'REJECTED';
    verifiedAt: string | null;
    riderTermsAcceptedAt: string | null;
  } | null;
  riderState: {
    workModeOn: boolean;
    activeTaskId: string | null;
    barredUntil: string | null;
  } | null;
  /**
   * FR-PRIV-01: the privacy notice this user accepted, or null if none is on
   * record. Optional until the auth lane ships it on `/auth/me`.
   */
  privacyNotice?: PrivacyNoticeAcceptance | null;
}

export type OrderStatus =
  | 'PLACED'
  | 'SHOP_ACCEPTED'
  | 'PREPARING'
  | 'READY'
  | 'PICKED_UP'
  | 'DELIVERED'
  | 'COMPLETED'
  | 'CANCELLED';

export type TaskStatus =
  | 'CREATED'
  | 'BROADCASTING'
  | 'ASSIGNED'
  | 'PICKED_UP'
  | 'DELIVERED'
  | 'COMPLETED'
  | 'UNFULFILLED'
  | 'ESCALATED'
  | 'CANCELLED';

export interface ShopQueueOrder {
  id: string;
  reference: string;
  status: OrderStatus;
  itemsSubtotalMinor: number;
  itemsSubtotalLabel: string;
  totalMinor: number;
  paymentMethod: 'CASH' | 'ONLINE' | 'WALLET';
  dropLandmark: string | null;
  studentNote: string | null;
  statedPrepMinutes: number | null;
  expectedReadyAt: string | null;
  placedAt: string;
  shopAcceptedAt: string | null;
  readyAt: string | null;
  student: { id: string; name: string };
  items: {
    nameSnapshot: string;
    quantity: number;
    unitPriceMinor: number;
    note: string | null;
  }[];
  task: { id: string; status: TaskStatus; rider: { id: string; name: string } | null } | null;
  /** Seconds left on the FR-SHP-02 acceptance window, or null once accepted. */
  acceptSecondsRemaining: number | null;
  /** ADR-003: the rider is waiting for the shop to hand over. */
  awaitingRiderPickup: boolean;
}

export interface ShopQueue {
  listingId: string;
  acceptWindowSeconds: number;
  items: ShopQueueOrder[];
}

export interface CatalogItem {
  id: string;
  name: string;
  description: string | null;
  priceMinor: number;
  prepMinutes: number;
  imageUrl: string | null;
  isAvailable: boolean;
  categoryId?: string | null;
  sortOrder: number;
}

export interface CatalogCategory {
  id: string;
  name: string;
  sortOrder: number;
  items: CatalogItem[];
}

export interface HoursRow {
  id: string;
  dayOfWeek: number;
  openMinute: number;
  closeMinute: number;
  openLabel: string;
  closeLabel: string;
  crossesMidnight: boolean;
}

export interface Catalog {
  listingId: string;
  status: string;
  temporarilyClosedUntil: string | null;
  closureNote: string | null;
  categories: CatalogCategory[];
  uncategorised: CatalogItem[];
  hours: HoursRow[];
}

export interface MyShop {
  id: string;
  name: string;
  category: string;
  address: string;
  city: string;
  locationType: 'ON_CAMPUS' | 'OFF_CAMPUS';
  fssaiLicenceNumber: string | null;
  gstin: string | null;
  listings: {
    id: string;
    status: 'PENDING_VERIFICATION' | 'ACTIVE' | 'SUSPENDED' | 'REJECTED';
    distanceFromCollegeM: number;
    distanceLabel: string;
    submittedAt: string;
    approvedAt: string | null;
    rejectionReason: string | null;
    rejectionNote: string | null;
    flaggedForRadiusReviewAt: string | null;
    temporarilyClosedUntil: string | null;
    averageRating: number | null;
    college: { id: string; name: string; shortName: string | null };
    _count: { items: number; orders: number };
  }[];
  documents: { id: string; docType: string; fileName: string | null; uploadedAt: string }[];
}

export interface VerificationQueueItem {
  id: string;
  submittedAt: string;
  rollNumber: string;
  department: string;
  yearOfStudy: number;
  idCardUrl: string;
  govtIdType: string | null;
  govtIdLast4: string | null;
  govtIdImageUrl: string | null;
  consentGivenAt: string | null;
  priorRejections: number;
  user: {
    id: string;
    name: string;
    mobile: string;
    email: string;
    createdAt: string;
    mobileVerifiedAt: string | null;
    emailVerifiedAt: string | null;
  };
}

export interface ShopQueueItem {
  listingId: string;
  submittedAt: string;
  distanceM: number;
  distanceLabel: string;
  radiusM: number;
  withinRadius: boolean;
  pinWasAdjusted: boolean;
  collegePin: { latitude: number; longitude: number };
  shopPin: { latitude: number; longitude: number };
  shop: {
    id: string;
    name: string;
    category: string;
    ownerName: string;
    ownerMobile: string;
    ownerEmail: string;
    address: string;
    city: string;
    latitude: number;
    longitude: number;
    pinAdjusted: boolean;
    locationType: 'ON_CAMPUS' | 'OFF_CAMPUS';
    fssaiLicenceNumber: string | null;
    gstin: string | null;
    documents: {
      id: string;
      docType: string;
      fileName: string | null;
      mimeType: string | null;
      sizeBytes: number | null;
      uploadedAt: string;
    }[];
  };
}

export interface Paged<T> {
  items: T[];
  nextCursor: string | null;
  total?: number;
}

export interface FlaggedShop {
  listingId: string;
  shop: { id: string; name: string; category: string; address: string };
  status: string;
  distanceM: number;
  distanceLabel: string;
  currentRadiusM: number;
  overByM: number;
  lifetimeOrders: number;
  flaggedAt: string;
}

// ===========================================================================
// Student and rider shapes
// ===========================================================================

export interface BrowseShop {
  listingId: string;
  shop: { id: string; name: string; category: string; locationType: string };
  distanceM: number;
  distanceLabel: string;
  averageRating: number | null;
  ratingCount: number;
  medianPrepMinutes: number | null;
  itemCount: number;
  /** FR-CAT-05: a closed shop is shown as closed, not hidden. */
  isOpen: boolean;
  closedReason: string | null;
  opensInMinutes: number | null;
  closureNote: string | null;
}

export interface ShopDetail {
  listingId: string;
  shop: {
    id: string;
    name: string;
    category: string;
    locationType: string;
    address: string;
    fssaiLicenceNumber: string | null;
  };
  distanceM: number;
  distanceLabel: string;
  averageRating: number | null;
  ratingCount: number;
  isOpen: boolean;
  closedReason: string | null;
  opensInMinutes: number | null;
  closureNote: string | null;
  hours: { dayOfWeek: number; openMinute: number; closeMinute: number }[];
  categories: {
    id: string;
    name: string;
    sortOrder: number;
    items: CatalogItem[];
  }[];
  /**
   * Items the shop has not filed under any category. A shop that never set
   * categories up has its whole menu here, so a screen that renders only
   * `categories` shows it as empty.
   */
  uncategorised: CatalogItem[];
}

export interface ItemSearchResult {
  id: string;
  name: string;
  description: string | null;
  priceMinor: number;
  prepMinutes: number;
  imageUrl: string | null;
  isAvailable: boolean;
  listingId: string;
  shop: { id: string; name: string; category: string };
  distanceM: number;
  distanceLabel: string;
  shopIsOpen: boolean;
}

export interface DeliveryPoint {
  id: string;
  name: string;
  description: string | null;
  latitude: number;
  longitude: number;
  sortOrder: number;
}

export interface OrderRequestBody {
  listingId: string;
  lines: { catalogItemId: string; quantity: number; note?: string }[];
  deliveryPointId?: string;
  dropLandmark?: string;
  dropLatitude?: number;
  dropLongitude?: number;
}

export interface OrderQuote {
  listingId: string;
  shop: { id: string; name: string };
  lines: {
    catalogItemId: string;
    name: string;
    unitPriceMinor: number;
    quantity: number;
    lineTotalMinor: number;
    note: string | null;
  }[];
  drop: { deliveryPointId: string | null; label: string; latitude: number; longitude: number };
  distanceM: number;
  distanceLabel: string;
  totals: {
    itemsSubtotalMinor: number;
    deliveryFeeMinor: number;
    platformFeeMinor: number;
    totalMinor: number;
    commissionMinor: number;
    itemsSubtotalLabel: string;
    deliveryFeeLabel: string;
    platformFeeLabel: string;
    totalLabel: string;
  };
  estimatedPrepMinutes: number;
  shopIsOpen: boolean;
  closedReason: string | null;
}

export interface MyOrder {
  id: string;
  reference: string;
  status: OrderStatus;
  totalMinor: number;
  totalLabel: string;
  placedAt: string;
  completedAt: string | null;
  cancelledAt: string | null;
  canCancel: boolean;
  shopListing: { id: string; shop: { id: string; name: string } };
  items: { nameSnapshot: string; quantity: number }[];
  task: { id: string; status: TaskStatus; riderId: string | null } | null;
}

export interface OrderDetail {
  id: string;
  reference: string;
  status: OrderStatus;
  itemsSubtotalMinor: number;
  deliveryFeeMinor: number;
  platformFeeMinor: number;
  totalMinor: number;
  totalLabel: string;
  paymentMethod: string;
  paymentStatus: string;
  dropLandmark: string | null;
  studentNote: string | null;
  statedPrepMinutes: number | null;
  expectedReadyAt: string | null;
  placedAt: string;
  shopAcceptedAt: string | null;
  readyAt: string | null;
  pickedUpAt: string | null;
  deliveredAt: string | null;
  completedAt: string | null;
  cancelledAt: string | null;
  cancelledBy: string | null;
  cancelledReason: string | null;
  canCancel: boolean;
  shopListing: { id: string; shop: { id: string; name: string; ownerMobile: string } };
  items: {
    nameSnapshot: string;
    unitPriceMinor: number;
    quantity: number;
    lineTotalMinor: number;
    note: string | null;
  }[];
  task: {
    id: string;
    status: TaskStatus;
    feeMinor: number;
    broadcastRound: number;
    offerExpiresAt: string | null;
    assignedAt: string | null;
    pickedUpAt: string | null;
  } | null;
  /** FR-TRST-02 and FR-PRIV-03: rating and count, never the mobile number. */
  rider: { id: string; name: string; averageRating: number | null; completedTasks: number } | null;
  /** FR-DLV-12: whether a handover code is live, for the requester only. */
  handoverCodeAvailable: boolean;
}

export interface RiderStatus {
  workModeOn: boolean;
  workModeOnAt: string | null;
  lastPingAt: string | null;
  canEnable: {
    verified: boolean;
    termsAccepted: boolean;
    termsVersionCurrent: boolean;
    notBarred: boolean;
  };
  barredUntil: string | null;
  pingIntervalSeconds: number;
  idleTimeoutMinutes: number;
  activeTask: ActiveTask | null;
  today: { completedTasks: number; earningsMinor: number; earningsLabel: string };
  lifetime: {
    completedTasks: number;
    earningsMinor: number;
    earningsLabel: string;
    acceptanceRate: number | null;
    abandonedTasks: number;
    averageRating: number | null;
  };
}

export interface ActiveTask {
  id: string;
  type: string;
  status: TaskStatus;
  riderId: string | null;
  pickupLabel: string;
  pickupLatitude: number;
  pickupLongitude: number;
  dropLabel: string;
  dropLatitude: number;
  dropLongitude: number;
  distanceM: number;
  feeMinor: number;
  feeLabel: string;
  description: string | null;
  collectionRef: string | null;
  reimbursementMinor: number | null;
  otpAttempts: number;
  assignedAt: string | null;
  pickedUpAt: string | null;
  chatRoom: { id: string; isArchived: boolean } | null;
  order: {
    id: string;
    reference: string;
    status: OrderStatus;
    paymentMethod: string;
    totalMinor: number;
    itemsSubtotalMinor: number;
    expectedReadyAt: string | null;
    studentNote: string | null;
    items: { nameSnapshot: string; quantity: number }[];
    student: { id: string; name: string };
    shopListing: { shop: { name: string; ownerMobile: string; address: string } };
  } | null;
  /** ADR-003: enabled only once the shop has marked the order ready. */
  canConfirmPickup: boolean;
  canAbandon: boolean;
  awaitingHandoverCode: boolean;
  /** ADR-006: what the rider pays the shop and collects at the door, in cash. */
  cashToPayShopMinor: number;
  cashToCollectMinor: number;
}

/** The task offer pushed over the socket (FR-DLV-03). */
export interface TaskOffer {
  taskId: string;
  type: string;
  round: number;
  pickupLabel: string;
  pickupLatitude: number;
  pickupLongitude: number;
  dropLabel: string;
  dropLatitude: number;
  dropLongitude: number;
  distanceM: number;
  feeMinor: number;
  description: string | null;
  reimbursementMinor: number | null;
  orderReference: string | null;
  shopName: string | null;
  expectedReadyAt: string | null;
  expiresAt: string;
  acceptanceWindowSeconds: number;
  /**
   * ADR-006: on a cash order, what the rider hands the shop and what they
   * collect at the door. Optional because older API builds do not send them;
   * absent or zero means there is no cash leg to show.
   */
  cashToPayShopMinor?: number;
  cashToCollectMinor?: number;
}

/**
 * `task:offer:withdrawn` (FR-DLV-05), as DispatchGateway.withdrawOffer emits
 * it. The winner's copy carries their own id and `won: true`; every other
 * rider's carries `winnerUserId: null` and `won: false` — nobody is told who
 * won.
 */
export interface TaskOfferWithdrawn {
  taskId: string;
  winnerUserId: string | null;
  won: boolean;
}

/**
 * `task:status`, which carries two different payloads on one event name.
 *
 * DispatchGateway.notifyTaskStatus sends `{ taskId, status, ...extra }`; the
 * extras the API sends today are `reason` (a rider released or the task
 * escalated), `riderId` (on ASSIGNED) and `choices` (on UNFULFILLED).
 * DispatchGateway.notifyWorkModeDisabled (FR-WM-06) sends the second shape,
 * which has no task in it at all. Tell them apart with `'type' in event` or
 * `event.type === 'WORK_MODE_DISABLED'`.
 */
export type TaskStatusEvent =
  | {
      type?: undefined;
      taskId: string;
      status: string;
      reason?: string;
      riderId?: string;
      choices?: string[];
    }
  | {
      type: 'WORK_MODE_DISABLED';
      reason: 'IDLE_TIMEOUT';
      afterMinutes: number;
    };

/** `GET /admin/college/radius` (A-09), as ShopsService.currentRadius returns it. */
export interface CollegeRadius {
  collegeId: string;
  /** Whole metres; 3000 when the college has no configuration row. */
  serviceableRadiusM: number;
  /** The same distance in words, e.g. "3.0 km". */
  serviceableRadiusLabel: string;
  /** RADIUS_MIN_M and RADIUS_MAX_M from @hoppo/shared. */
  minRadiusM: number;
  maxRadiusM: number;
}

/**
 * The `/rt` socket's `exception` event, sent just before the server closes a
 * connection it refuses for a stated reason.
 *
 * Today that is one case: a shop account with no approved shop gets
 * `connect`, then `exception` with code `SHOP_NOT_APPROVED`, then
 * `disconnect` (reason `io server disconnect`). It is not a `connect_error`,
 * so a client must listen for this event to tell "awaiting approval" from a
 * dropped connection it should retry. Missing or invalid tokens and
 * suspended accounts are still disconnected with no event.
 */
export interface SocketException {
  code: string;
  message: string;
}

// ===========================================================================
// Administrator order report and shop order history (A1 contract; FR-ADM-05)
// ===========================================================================

export type PaymentMethod = 'CASH' | 'WALLET' | 'ONLINE';

export type PaymentStatus =
  'NOT_REQUIRED' | 'PENDING' | 'HELD' | 'CAPTURED' | 'REFUNDED' | 'FAILED';

export type CancelledBy = 'STUDENT' | 'SHOP' | 'ADMIN' | 'SYSTEM';

/** A name and an id — never a mobile number, email or roll number (FR-PRIV-03). */
export interface PersonRef {
  id: string;
  name: string;
}

/**
 * The date range a report applied: calendar dates (`YYYY-MM-DD`), both
 * inclusive, read in the college's timezone. Null where that end was open.
 */
export interface ReportRange {
  from: string | null;
  to: string | null;
  timezone: string;
}

/** Filters for `GET /admin/orders`. */
export interface AdminOrderListQuery {
  /** One status, or several: sent as a comma-separated list. */
  status?: OrderStatus | OrderStatus[];
  /** `YYYY-MM-DD`, inclusive, on `placedAt`. */
  from?: string;
  to?: string;
  listingId?: string;
  /** Order reference, case-insensitive "contains", at most 32 characters. */
  q?: string;
  limit?: number;
  cursor?: string;
  /** Honoured for a SUPER_ADMIN only; ignored for everyone else. */
  collegeId?: string;
}

export interface AdminOrderListItem {
  id: string;
  reference: string;
  status: OrderStatus;
  placedAt: string;
  shop: { listingId: string; shopId: string; name: string };
  student: PersonRef;
  /** Null until a rider is assigned. */
  rider: PersonRef | null;
  itemsSubtotalMinor: number;
  itemsSubtotalLabel: string;
  deliveryFeeMinor: number;
  deliveryFeeLabel: string;
  platformFeeMinor: number;
  platformFeeLabel: string;
  totalMinor: number;
  totalLabel: string;
  commissionMinor: number;
  commissionLabel: string;
  paymentMethod: PaymentMethod;
  paymentStatus: PaymentStatus;
  taskStatus: TaskStatus | null;
  cancelledBy: CancelledBy | null;
}

export interface AdminOrderList {
  items: AdminOrderListItem[];
  nextCursor: string | null;
  range: ReportRange;
}

export interface AdminOrderTimelineStep {
  event:
    'PLACED' | 'SHOP_ACCEPTED' | 'READY' | 'PICKED_UP' | 'DELIVERED' | 'COMPLETED' | 'CANCELLED';
  at: string;
}

export interface AdminOrderLine {
  name: string;
  unitPriceMinor: number;
  quantity: number;
  lineTotalMinor: number;
  note: string | null;
}

export interface AdminOrderBroadcastRound {
  /** 1 is the first search; 2, 3, ... after the task went back into the pool. */
  cycle: number;
  /** Restarts at 1 in each search, so it is not unique within an order. */
  round: number;
  radiusM: number;
  feeMinor: number;
  eligibleCount: number;
  sentAt: string;
  outcome: 'PENDING' | 'ACCEPTED' | 'EXPIRED' | 'CANCELLED';
  resolvedAt: string | null;
}

export interface AdminOrderWalletEntry {
  id: string;
  type: string;
  direction: 'CREDIT' | 'DEBIT';
  amountMinor: number;
  amountLabel: string;
  balanceAfterMinor: number;
  party: 'STUDENT' | 'RIDER' | 'OTHER';
  user: PersonRef;
  note: string | null;
  createdAt: string;
}

/** `GET /admin/orders/:orderId`. */
export interface AdminOrderDetail extends Omit<AdminOrderListItem, 'placedAt' | 'taskStatus'> {
  /** The campus point's name or the free-text landmark. No coordinates. */
  dropLabel: string | null;
  studentNote: string | null;
  statedPrepMinutes: number | null;
  expectedReadyAt: string | null;
  cancelledReason: string | null;
  /** Only the steps that happened, in time order. */
  timeline: AdminOrderTimelineStep[];
  items: AdminOrderLine[];
  task: {
    id: string;
    status: TaskStatus;
    baseFeeMinor: number;
    feeMinor: number;
    broadcastRound: number;
    distanceM: number;
    assignedAt: string | null;
    pickedUpAt: string | null;
    deliveredAt: string | null;
    completedAt: string | null;
    cancelledAt: string | null;
  } | null;
  broadcast: {
    /** Every round of every search, ordered by `cycle` then `round`. */
    rounds: AdminOrderBroadcastRound[];
    /** Total across all searches. */
    roundsSent: number;
    /** How many separate searches there have been. */
    searches: number;
    roundsInLatestSearch: number;
    /** First round of the latest search to assigned, in seconds; null if never assigned. */
    secondsToAcceptance: number | null;
  };
  /** Every ledger row for this order, oldest first. */
  walletEntries: AdminOrderWalletEntry[];
}

/** `GET /admin/orders/summary` (FR-ADM-05). */
export interface AdminOrderSummary {
  range: ReportRange;
  ordersPlaced: number;
  /** Always all eight statuses. */
  byStatus: Record<OrderStatus, number>;
  /** COMPLETED / ordersPlaced in basis points: 7381 is 73.81%. 0 with no orders. */
  completionRateBps: number;
  /** Sums over COMPLETED orders only, as `basis` says. */
  money: {
    basis: 'COMPLETED';
    grossItemsMinor: number;
    grossItemsLabel: string;
    deliveryFeesMinor: number;
    deliveryFeesLabel: string;
    platformFeesMinor: number;
    platformFeesLabel: string;
    commissionMinor: number;
    commissionLabel: string;
    totalMinor: number;
    totalLabel: string;
  };
  cancellations: { total: number; byWho: Record<CancelledBy, number> };
  /** Medians in whole seconds; null when the sample is empty. */
  timings: {
    medianPlacedToAcceptedSeconds: number | null;
    medianReadyToDeliveredSeconds: number | null;
    placedToAcceptedSampleSize: number;
    readyToDeliveredSampleSize: number;
  };
  unfulfilledBroadcasts: number;
  /** Completed orders only, largest gross first, at most 50 rows. */
  revenueByShop: {
    listingId: string;
    shopName: string;
    completedOrders: number;
    grossItemsMinor: number;
    grossItemsLabel: string;
    commissionMinor: number;
  }[];
}

/** Filters for `GET /shops/:listingId/orders/history`. */
export interface ShopOrderHistoryQuery {
  /** Defaults to COMPLETED and CANCELLED on the server. */
  status?: OrderStatus | OrderStatus[];
  from?: string;
  to?: string;
  limit?: number;
  cursor?: string;
}

export interface ShopOrderHistoryItem {
  id: string;
  reference: string;
  status: OrderStatus;
  placedAt: string;
  shopAcceptedAt: string | null;
  readyAt: string | null;
  pickedUpAt: string | null;
  deliveredAt: string | null;
  completedAt: string | null;
  cancelledAt: string | null;
  cancelledBy: CancelledBy | null;
  cancelledReason: string | null;
  student: PersonRef;
  rider: PersonRef | null;
  items: AdminOrderLine[];
  studentNote: string | null;
  itemsSubtotalMinor: number;
  itemsSubtotalLabel: string;
  commissionMinor: number;
  commissionLabel: string;
  /** itemsSubtotalMinor - commissionMinor. */
  netToShopMinor: number;
  netToShopLabel: string;
  paymentMethod: PaymentMethod;
  taskStatus: TaskStatus | null;
}

/** D-10. The shop is deliberately not shown delivery fee, platform fee or total. */
export interface ShopOrderHistory {
  listingId: string;
  items: ShopOrderHistoryItem[];
  nextCursor: string | null;
  range: ReportRange;
}

// ===========================================================================
// Escalated tasks (A2 contract; FR-ADM-04, A-08)
// ===========================================================================

export type EscalationOutcome = 'DELIVERED' | 'NOT_DELIVERED';

export interface Escalation {
  taskId: string;
  type: 'SHOP_ORDER' | 'PARCEL_PICKUP' | 'PEER_ERRAND';
  /** ESCALATED while open; COMPLETED or CANCELLED once resolved. */
  status: TaskStatus;
  escalatedAt: string;
  /** Why it escalated. Null once resolved: the administrator's note replaces it. */
  escalationReason: string | null;
  otpAttempts: number;
  maxOtpAttempts: number;
  assignedAt: string | null;
  pickedUpAt: string | null;
  createdAt: string;
  pickupLabel: string;
  dropLabel: string;
  feeMinor: number;
  /** Peer errands only. */
  reimbursementMinor: number | null;
  requester: { id: string; name: string; mobile: string };
  /** Never null: a task cannot escalate without a rider holding it (A2 contract). */
  rider: { id: string; name: string; mobile: string; status: string };
  order: {
    id: string;
    reference: string;
    status: OrderStatus;
    paymentMethod: PaymentMethod;
    paymentStatus: PaymentStatus;
    itemsSubtotalMinor: number;
    deliveryFeeMinor: number;
    totalMinor: number;
    shopName: string;
    items: { name: string; quantity: number }[];
  } | null;
  /** Both outcomes while ESCALATED, empty once resolved: render buttons from this. */
  canResolveAs: EscalationOutcome[];
  /** Both present only once the task has been resolved. */
  resolutionNote?: string | null;
  resolvedAt?: string | null;
}

export interface EscalationResolution {
  taskId: string;
  outcome: EscalationOutcome;
  /** COMPLETED for DELIVERED, CANCELLED for NOT_DELIVERED. */
  status: 'COMPLETED' | 'CANCELLED';
  orderStatus: 'COMPLETED' | 'CANCELLED' | null;
  resolvedAt: string;
  riderFeeMinor: number;
  settledInCash: boolean;
  /** NOT_DELIVERED on a wallet-paid order: the total credited back to the student. Otherwise 0. */
  refundedMinor: number;
  message: string;
}

// ===========================================================================
// College configuration, delivery points, audit log (A5 contract)
// ===========================================================================

/** The fields `PATCH /admin/college/config` accepts. All whole numbers. */
export interface CollegeConfigEditable {
  acceptanceWindowSeconds: number;
  maxBroadcastRounds: number;
  initialProximityM: number;
  proximityIncrementM: number;
  feeIncrementMinor: number;
  dispatchLeadMinutes: number;
  workModeIdleTimeoutMinutes: number;
  riderPingIntervalSeconds: number;
  shopAcceptWindowSeconds: number;
  maxOtpAttempts: number;
  platformFeeMinor: number;
  commissionBps: number;
  minWithdrawalMinor: number;
  maxVerificationSubmissions: number;
  verificationWindowDays: number;
  abandonmentBanThreshold: number;
  abandonmentWindowDays: number;
  abandonmentBanHours: number;
  chatRetentionDays: number;
  reportHideThreshold: number;
}

/** `maxDistanceM` is exclusive; null on the last band means "and beyond". */
export interface FeeBand {
  minDistanceM: number;
  maxDistanceM: number | null;
  feeMinor: number;
}

/** `GET /admin/college/config` (FR-ADM-03, A-09). */
export interface CollegeConfig {
  collegeId: string;
  updatedAt: string;
  /** `serviceableRadiusM` is read-only here: change it with `admin.updateRadius`. */
  config: CollegeConfigEditable & { serviceableRadiusM: number };
  /** Sorted by `minDistanceM`. */
  feeBands: FeeBand[];
  limits: Record<keyof CollegeConfigEditable, { min: number; max: number }> & {
    feeBands: { minBands: number; maxBands: number; maxFeeMinor: number; maxDistanceM: number };
  };
}

/** Any subset of the editable fields, and optionally the complete new band list. */
export type CollegeConfigUpdate = Partial<CollegeConfigEditable> & { feeBands?: FeeBand[] };

/** `PATCH /admin/college/config`: the new state, and the names of what changed. */
export interface CollegeConfigUpdateResult extends CollegeConfig {
  changed: (keyof CollegeConfigEditable | 'feeBands')[];
}

/** A delivery point as an administrator sees it (A-10): inactive ones too. */
export interface AdminDeliveryPoint {
  id: string;
  name: string;
  description: string | null;
  latitude: number;
  longitude: number;
  isActive: boolean;
  sortOrder: number;
  /** Orders that used this point. */
  orderCount: number;
  createdAt: string;
  updatedAt: string;
}

export interface DeliveryPointCreate {
  name: string;
  description?: string;
  latitude: number;
  longitude: number;
}

export interface DeliveryPointUpdate {
  name?: string;
  description?: string | null;
  latitude?: number;
  longitude?: number;
}

/** Filters for `GET /admin/audit-log`. */
export interface AuditLogQuery {
  actorId?: string;
  /** Exact action name, e.g. `SHOP_SUSPENDED`. */
  action?: string;
  targetType?: string;
  targetId?: string;
  /** ISO date or date-time; `from` inclusive, `to` exclusive. */
  from?: string;
  to?: string;
  limit?: number;
  cursor?: string;
  /** SUPER_ADMIN only. */
  collegeId?: string;
}

export interface AuditLogEntry {
  id: string;
  createdAt: string;
  action: string;
  targetType: string | null;
  targetId: string | null;
  collegeId: string | null;
  /** Null for system actions. */
  actor: { id: string; name: string; role: AuthUser['role'] } | null;
  detail: Record<string, unknown> | null;
  ipAddress: string | null;
  userAgent: string | null;
}

// ===========================================================================
// Student and shop administration (A5 contract; A-04, A-06)
// ===========================================================================

export type VerificationStatus = 'UNSUBMITTED' | 'PENDING' | 'VERIFIED' | 'REJECTED';

export interface AdminStudentListQuery {
  /** Name, mobile, email or roll number, "contains". */
  q?: string;
  status?: AuthUser['status'];
  verificationStatus?: VerificationStatus;
  limit?: number;
  cursor?: string;
}

export interface AdminStudentListItem {
  id: string;
  name: string;
  mobile: string;
  email: string;
  status: AuthUser['status'];
  verificationStatus: VerificationStatus | null;
  rollNumber: string | null;
  department: string | null;
  createdAt: string;
}

/** `GET /admin/students/:studentId`. No document URLs: those stay audited. */
export interface AdminStudentDetail {
  student: {
    id: string;
    name: string;
    mobile: string;
    email: string;
    status: AuthUser['status'];
    createdAt: string;
    lastLoginAt: string | null;
    mobileVerifiedAt: string | null;
  };
  /** Null unless the account is SUSPENDED. */
  suspension: {
    reason: string | null;
    suspendedAt: string | null;
    suspendedBy: PersonRef | null;
  } | null;
  profile: {
    rollNumber: string | null;
    department: string | null;
    yearOfStudy: number | null;
    verificationStatus: VerificationStatus;
    verifiedAt: string | null;
    govtIdType: string | null;
    govtIdLast4: string | null;
    riderTermsAcceptedAt: string | null;
  } | null;
  /** Null if the student never rode. */
  rider: { workModeOn: boolean; activeTaskId: string | null; barredUntil: string | null } | null;
  submissions: {
    id: string;
    status: string;
    submittedAt: string;
    decidedAt: string | null;
    rejectionReason: string | null;
    rejectionNote: string | null;
  }[];
  counts: { orders: number; tasksRequested: number; tasksDelivered: number };
  /** Up to ten, newest first. */
  recentOrders: {
    id: string;
    reference: string;
    status: OrderStatus;
    totalMinor: number;
    createdAt: string;
    shopName: string;
  }[];
  recentTasks: {
    id: string;
    type: string;
    status: TaskStatus;
    role: 'REQUESTER' | 'RIDER';
    feeMinor: number;
    createdAt: string;
  }[];
}

export interface StudentSuspension {
  studentId: string;
  status: 'SUSPENDED';
  reason: string;
  suspendedAt: string;
  suspendedBy: PersonRef | null;
  sessionsRevoked: number;
  taskReleased: string | null;
  message: string;
}

export interface StudentReinstatement {
  studentId: string;
  status: 'ACTIVE';
  reinstatedAt: string;
  reinstatedBy: PersonRef | null;
  message: string;
}

export type ShopListingStatus = 'PENDING_VERIFICATION' | 'ACTIVE' | 'SUSPENDED' | 'REJECTED';

export interface AdminShopListQuery {
  status?: ShopListingStatus;
  /** Shop name, "contains". */
  q?: string;
  limit?: number;
  cursor?: string;
}

export interface AdminShopListItem {
  listingId: string;
  status: ShopListingStatus;
  distanceM: number;
  submittedAt: string;
  flaggedForRadiusReview: boolean;
  shop: { id: string; name: string; category: string; locationType: string };
}

/** `GET /admin/shops/:listingId` (A-06). Document bytes stay behind the audited route. */
export interface AdminShopDetail {
  listingId: string;
  collegeId: string;
  status: ShopListingStatus;
  distanceM: number;
  distanceLabel: string;
  radiusM: number;
  withinRadius: boolean;
  flaggedForRadiusReviewAt: string | null;
  submittedAt: string;
  approval: { approvedAt: string; approvedBy: PersonRef | null } | null;
  rejection: { reason: string | null; note: string | null } | null;
  suspension: {
    reason: string | null;
    suspendedAt: string | null;
    suspendedBy: PersonRef | null;
  } | null;
  shop: {
    id: string;
    name: string;
    category: string;
    ownerName: string;
    ownerMobile: string;
    ownerEmail: string | null;
    address: string;
    city: string;
    state: string;
    pincode: string;
    latitude: number;
    longitude: number;
    pinAdjusted: boolean;
    locationType: string;
    fssaiLicenceNumber: string | null;
    gstin: string | null;
  };
  staff: { userId: string; name: string; isOwner: boolean; status: AuthUser['status'] }[];
  documents: {
    id: string;
    docType: string;
    fileName: string | null;
    mimeType: string | null;
    sizeBytes: number | null;
    uploadedAt: string;
  }[];
  counts: { catalogItems: number; orders: number; inFlightOrders: number };
  /** `average` is null until the shop has a rating. */
  rating: { average: number | null; count: number };
}

export interface ShopSuspension {
  listingId: string;
  status: 'SUSPENDED';
  reason: string;
  suspendedAt: string;
  suspendedBy: PersonRef | null;
  inFlightOrders: number;
  message: string;
}

export interface ShopReinstatement {
  listingId: string;
  status: 'ACTIVE';
  reinstatedAt: string;
  reinstatedBy: PersonRef | null;
  message: string;
}

// ===========================================================================
// Privacy notice, data export, account deletion (A5 contract; FR-PRIV-01, -05)
// ===========================================================================

/** Which notice a user accepted, and when. */
export interface PrivacyNoticeAcceptance {
  version: string;
  acceptedAt: string;
}

/** `GET /legal/privacy-notice` — public. */
export interface PrivacyNotice {
  version: string;
  effectiveFrom: string;
  title: string;
  /** Always these four keys, in this order. */
  sections: {
    key: 'dataCollected' | 'purpose' | 'retention' | 'grievance';
    heading: string;
    body: string;
  }[];
  grievanceContact: { name: string | null; email: string | null };
  /** When true, a registration without `privacyNoticeVersion` is refused. */
  acceptanceRequired: boolean;
}

/**
 * `GET /account/export` (FR-PRIV-05, S-55): the caller's own data, oldest
 * first in every list. No document images, and nobody else's name or id.
 * Shaped from AccountService.exportData, which sends a little more than the
 * first issue of the contract listed (order and line notes, a requested
 * task's description and completion time).
 */
export interface AccountExport {
  exportedAt: string;
  formatVersion: number;
  account: {
    id: string;
    name: string;
    mobile: string;
    email: string;
    role: AuthUser['role'];
    status: AuthUser['status'];
    createdAt: string;
    lastLoginAt: string | null;
    college: { id: string; name: string } | null;
    privacyNotice: PrivacyNoticeAcceptance | null;
  };
  studentProfile: {
    rollNumber: string | null;
    department: string | null;
    yearOfStudy: number | null;
    verificationStatus: VerificationStatus;
    verifiedAt: string | null;
    govtIdType: string | null;
    govtIdLast4: string | null;
    riderTermsVersion: string | null;
    riderTermsAcceptedAt: string | null;
  } | null;
  verificationSubmissions: {
    id: string;
    status: string;
    submittedAt: string;
    decidedAt: string | null;
    rejectionReason: string | null;
    rejectionNote: string | null;
    rollNumber: string | null;
    department: string | null;
    yearOfStudy: number | null;
    govtIdType: string | null;
    govtIdLast4: string | null;
  }[];
  orders: {
    id: string;
    reference: string;
    status: OrderStatus;
    createdAt: string;
    shopName: string;
    itemsSubtotalMinor: number;
    deliveryFeeMinor: number;
    platformFeeMinor: number;
    totalMinor: number;
    paymentMethod: PaymentMethod;
    /** The delivery point's name, else the free-text landmark, else null. */
    deliveryLabel: string | null;
    studentNote: string | null;
    items: { name: string; quantity: number; unitPriceMinor: number; note: string | null }[];
  }[];
  tasksRequested: {
    id: string;
    type: string;
    status: TaskStatus;
    createdAt: string;
    completedAt: string | null;
    pickupLabel: string;
    dropLabel: string;
    description: string | null;
    feeMinor: number;
  }[];
  tasksDelivered: {
    id: string;
    type: string;
    status: TaskStatus;
    assignedAt: string | null;
    completedAt: string | null;
    pickupLabel: string;
    dropLabel: string;
    feeMinor: number;
  }[];
  walletEntries: {
    id: string;
    createdAt: string;
    direction: 'CREDIT' | 'DEBIT';
    type: string;
    amountMinor: number;
    balanceAfterMinor: number;
    taskId: string | null;
    orderId: string | null;
    note: string | null;
  }[];
  withdrawals: { id: string; status: string; amountMinor: number; requestedAt: string }[];
}

/**
 * `POST /auth/password/change`: a fresh token pair, because the change ends
 * every existing session of the account, the caller's own included.
 */
export interface PasswordChange {
  accessToken: string;
  refreshToken: string;
  expiresIn: string;
  sessionsRevoked: number;
  message: string;
}

/** `PATCH /account/profile` (S-50). Email, mobile and verified fields are not editable. */
export interface ProfileUpdate {
  /** 2 to 100 characters. */
  name?: string;
  /** The `key` from `uploads.url` with kind `AVATAR`; null removes the photo. */
  avatarKey?: string | null;
}

/** `POST /account/delete`. */
export interface AccountDeletion {
  status: 'DEACTIVATED';
  deletedAt: string;
  /** Human-readable phrases for what was scrubbed and what was kept: show them, never match on them. */
  erased: string[];
  retained: string[];
  /** Identity documents and profile photo in file storage: how many there were, how many were removed. */
  storedFiles: { expected: number; removed: number };
  /**
   * What the deletion could not do, to show to the user. Always says that
   * past audit entries cannot be altered; also says so when `storedFiles`
   * shows files that could not be removed.
   */
  caveats: string[];
  message: string;
}

// ===========================================================================
// Platform administration (A5 contract; SUPER_ADMIN only; A-16, A-18)
// ===========================================================================

export interface PlatformCollege {
  id: string;
  name: string;
  shortName: string | null;
  address: string;
  city: string;
  state: string;
  latitude: number;
  longitude: number;
  timezone: string;
  emailDomain: string | null;
  contactName: string | null;
  contactPhone: string | null;
  contactEmail: string | null;
  status: 'ACTIVE' | 'INACTIVE';
  serviceableRadiusM: number;
  createdAt: string;
  counts: { admins: number; students: number; shopListings: number };
}

export interface PlatformAdmin {
  id: string;
  name: string;
  mobile: string;
  email: string;
  status: AuthUser['status'];
  collegeId: string;
  createdAt: string;
  lastLoginAt: string | null;
}

export interface PlatformCollegeCreate {
  name: string;
  shortName?: string;
  address: string;
  city: string;
  state: string;
  latitude: number;
  longitude: number;
  /** 1000 to 5000; the server defaults to 3000. */
  serviceableRadiusM?: number;
  /** IANA name; the server defaults to Asia/Kolkata. */
  timezone?: string;
  emailDomain?: string;
  contactName?: string;
  contactPhone?: string;
  contactEmail?: string;
}

export interface PlatformAdminCreate {
  name: string;
  mobile: string;
  email: string;
  /** At least ten characters. There are no email invites: this is the first password. */
  password: string;
}

// ===========================================================================
// Reorder (A1-CONTRACT-reorder.md; S-21)
// ===========================================================================

/**
 * `GET /orders/:orderId/reorder`: a past order turned into a draft cart at
 * today's prices. A read — nothing is placed, held or reserved. There is
 * deliberately no delivery fee or total: send `lines` to `orders.quote`.
 */
export interface ReorderDraft {
  sourceOrder: { id: string; reference: string; placedAt: string };
  listingId: string;
  shop: { id: string; name: string };
  shopIsOpen: boolean;
  /** Same values as `OrderQuote.closedReason`; null while the shop is open. */
  closedReason: string | null;
  /** Ready to send to `orders.quote` as `{ catalogItemId, quantity, note }`. May be empty. */
  lines: {
    catalogItemId: string;
    name: string;
    quantity: number;
    unitPriceMinor: number;
    lineTotalMinor: number;
    note: string | null;
    /** For a "was ₹60" label only: the price is never carried over. */
    previousUnitPriceMinor: number;
    priceChanged: boolean;
  }[];
  /** Items of the old order that are not in `lines`: show them to the student. */
  unavailable: {
    /** Null when the item was removed from the menu altogether. */
    catalogItemId: string | null;
    name: string;
    quantity: number;
    /** UNAVAILABLE: switched off for now. REMOVED: no longer on the menu. */
    reason: 'UNAVAILABLE' | 'REMOVED';
  }[];
  itemsSubtotalMinor: number;
  itemsSubtotalLabel: string;
  anyPriceChanged: boolean;
  /** Null when `lines` is empty. */
  estimatedPrepMinutes: number | null;
  /** Null if the old order used a landmark or the point is gone. */
  suggestedDeliveryPoint: { id: string; name: string } | null;
  /** At least one line and the shop is open. */
  canCheckout: boolean;
}

// ===========================================================================
// Shop settlement statement (A1-CONTRACT-settlements.md; D-14) — read-only
// ===========================================================================

export interface ShopSettlementQuery {
  /** `YYYY-MM-DD`, inclusive, college timezone. Default: this month to date. */
  from?: string;
  to?: string;
  /** Pages `lines` only; the totals always cover the whole period. */
  limit?: number;
  cursor?: string;
}

export interface ShopSettlementLine {
  orderId: string;
  reference: string;
  placedAt: string;
  completedAt: string;
  paymentMethod: PaymentMethod;
  itemsSubtotalMinor: number;
  itemsSubtotalLabel: string;
  commissionMinor: number;
  commissionLabel: string;
  netToShopMinor: number;
  netToShopLabel: string;
  settledBy: 'CASH_AT_COUNTER' | 'PLATFORM';
}

/**
 * COMPLETED orders only, dated by `completedAt`. A statement, not a payout:
 * no route pays a shop or stores bank details, so show `payout.message`
 * where a "Withdraw" button would go.
 */
export interface ShopSettlementStatement {
  listingId: string;
  shop: { id: string; name: string };
  range: ReportRange;
  basis: { status: 'COMPLETED'; date: 'completedAt' };
  totals: {
    ordersDelivered: number;
    grossItemsMinor: number;
    grossItemsLabel: string;
    commissionMinor: number;
    commissionLabel: string;
    /** grossItems - commission. */
    netEarningsMinor: number;
    netEarningsLabel: string;
    /** Commission / gross in basis points: 500 is 5.00%. 0 with no sales. */
    effectiveCommissionBps: number;
  };
  byPaymentMethod: {
    /** Already paid to the shop in cash at the counter; it owes the commission. */
    cash: {
      orders: number;
      grossItemsMinor: number;
      grossItemsLabel: string;
      commissionMinor: number;
      commissionLabel: string;
      alreadyReceivedByShopMinor: number;
      alreadyReceivedByShopLabel: string;
    };
    /** Paid from the student's wallet; the platform owes the shop. */
    heldByPlatform: {
      orders: number;
      grossItemsMinor: number;
      grossItemsLabel: string;
      commissionMinor: number;
      commissionLabel: string;
      owedToShopMinor: number;
      owedToShopLabel: string;
    };
  };
  position: {
    platformOwesShopMinor: number;
    platformOwesShopLabel: string;
    shopOwesPlatformMinor: number;
    shopOwesPlatformLabel: string;
    /** Can be negative: a shop selling mostly for cash owes commission. */
    netPayableToShopMinor: number;
    netPayableToShopLabel: string;
  };
  /** Always NOT_AVAILABLE in this release. */
  payout: { status: 'NOT_AVAILABLE'; message: string };
  lines: ShopSettlementLine[];
  nextCursor: string | null;
}

// ===========================================================================
// Wallet statement, rider earnings, withdrawals (A1-CONTRACT-wallet.md) — read-only
// ===========================================================================

export type WalletEntryType =
  | 'DELIVERY_FEE_EARNED'
  | 'ERRAND_REIMBURSEMENT'
  | 'ORDER_HOLD'
  | 'ORDER_CAPTURE'
  | 'ORDER_RELEASE'
  | 'WITHDRAWAL'
  | 'ADJUSTMENT';

export interface WalletStatementQuery {
  /** `YYYY-MM-DD`, inclusive, college timezone. Both optional: the whole ledger. */
  from?: string;
  to?: string;
  limit?: number;
  cursor?: string;
}

export interface WalletStatementEntry {
  id: string;
  createdAt: string;
  type: WalletEntryType;
  direction: 'CREDIT' | 'DEBIT';
  amountMinor: number;
  amountLabel: string;
  /**
   * Signed: what this line did to the balance. Not always `amountMinor` — a
   * fee collected in cash, an errand reimbursement and a capture marker are
   * records only (0, with `affectsBalance: false`). Style those as
   * informational, not as money in.
   */
  balanceChangeMinor: number;
  affectsBalance: boolean;
  balanceAfterMinor: number;
  balanceAfterLabel: string;
  note: string | null;
  orderId: string | null;
  orderReference: string | null;
  taskId: string | null;
}

/** `GET /wallet/statement` (FR-PAY-04). Oldest first, like a bank statement. */
export interface WalletStatement {
  range: ReportRange;
  /** Opening and closing describe the range, not the page. */
  openingBalanceMinor: number;
  openingBalanceLabel: string;
  closingBalanceMinor: number;
  closingBalanceLabel: string;
  currentBalanceMinor: number;
  currentBalanceLabel: string;
  entries: WalletStatementEntry[];
  nextCursor: string | null;
}

/** `GET /wallet/earnings` (S-24, FR-WM-08). Default range: this month to date. */
export interface RiderEarnings {
  range: ReportRange;
  deliveries: number;
  /** Always collectedInCash + creditedToWallet. */
  feesEarnedMinor: number;
  feesEarnedLabel: string;
  /** Fees on cash orders: already in the rider's pocket, never withdrawable. */
  collectedInCashMinor: number;
  collectedInCashLabel: string;
  creditedToWalletMinor: number;
  creditedToWalletLabel: string;
  /** Errand reimbursements paid to the rider in person by the requester. */
  reimbursedDirectlyMinor: number;
  reimbursedDirectlyLabel: string;
  /** As of now, not of the period. */
  wallet: {
    balanceMinor: number;
    balanceLabel: string;
    minWithdrawalMinor: number;
    minWithdrawalLabel: string;
    /** Only "balance >= minimum": it does not mean a withdrawal can be made. */
    meetsMinimum: boolean;
    pendingWithdrawals: number;
    pendingWithdrawalMinor: number;
    pendingWithdrawalLabel: string;
  };
  /** Always NOT_AVAILABLE in this release: show `message` in place of a button. */
  withdrawals: { status: 'NOT_AVAILABLE'; message: string };
}

export interface WalletWithdrawal {
  id: string;
  amountMinor: number;
  amountLabel: string;
  status: 'REQUESTED' | 'APPROVED' | 'PAID' | 'REJECTED';
  /** Masked on purpose. */
  destination: { bankAccountLast4: string | null; upiIdMasked: string | null };
  requestedAt: string;
  handledAt: string | null;
  payoutReference: string | null;
  rejectionNote: string | null;
}

/** `GET /wallet/withdrawals`. Newest first; empty for everyone in this release. */
export interface WalletWithdrawals {
  items: WalletWithdrawal[];
  nextCursor: string | null;
  /** False in this release: no route requests a withdrawal. */
  canRequest: boolean;
}

// ===========================================================================
// Chat on a delivery (A2-CONTRACT-chat.md; FR-DLV-10, FR-CHAT-04)
// ===========================================================================

export type ChatRole = 'REQUESTER' | 'RIDER';

export interface ChatMessage {
  id: string;
  senderId: string;
  senderRole: ChatRole;
  /** Plain text exactly as typed: render as text, never as HTML. Null once deleted. */
  body: string | null;
  deleted: boolean;
  clientMessageId: string | null;
  sentAt: string;
}

export interface ChatRoom {
  taskId: string;
  orderId: string | null;
  roomId: string | null;
  /** NOT_OPEN until a rider accepts; ARCHIVED once the delivery is over (read-only). */
  state: 'NOT_OPEN' | 'OPEN' | 'ARCHIVED';
  canSend: boolean;
  archivedAt: string | null;
  you: ChatRole;
  /** No RIDER entry while NOT_OPEN. Never a mobile number. */
  participants: { userId: string; name: string; role: ChatRole }[];
}

/** Newest first. Pass `nextCursor` as `before` for the older page. */
export interface ChatHistory {
  room: ChatRoom;
  messages: ChatMessage[];
  nextCursor: string | null;
}

/** A retry with the same `clientMessageId` returns the stored message, `duplicate: true`. */
export interface ChatSendResult {
  message: ChatMessage;
  duplicate: boolean;
}

/**
 * `message:new` (`wsEvents.MESSAGE_NEW`) as received: a message plus the
 * conversation it belongs to. The sender's own sockets get it too, so
 * de-duplicate on `id`.
 */
export interface ChatMessageEvent extends ChatMessage {
  taskId: string;
  orderId: string | null;
  roomId: string;
}

/** What a client emits on `message:new` to send over the socket instead of POST. */
export type ChatSocketSend = { body: string; clientMessageId: string } & (
  { taskId: string; orderId?: undefined } | { orderId: string; taskId?: undefined }
);

/** The acknowledgement to `ChatSocketSend`. */
export type ChatSocketAck =
  | { ok: true; message: ChatMessage; duplicate: boolean }
  | { ok: false; code: string; message: string };

// ===========================================================================
// Active riders by hour (A2-CONTRACT-rider-presence.md; FR-ADM-05, A-14)
// ===========================================================================

/**
 * `GET /admin/riders/presence`. Counts only: no rider is ever named. The
 * range is widened to whole UTC clock hours; bucket to local time on the
 * client.
 */
export interface RiderPresence {
  from: string;
  to: string;
  /**
   * The earliest hour presence exists for, or null if none ever has. Hours
   * before it are "not recorded", not "nobody online": render them as no-data.
   */
  recordedSince: string | null;
  /** Every hour of the range, ascending, 0 where nobody was online. */
  hours: { hourStart: string; activeRiders: number }[];
  distinctRiders: number;
  /** The first hour with the highest count; null when every hour is 0. */
  peak: { hourStart: string; activeRiders: number } | null;
}
