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
