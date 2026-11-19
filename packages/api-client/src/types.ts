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
