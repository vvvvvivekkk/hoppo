/**
 * Values that both the API and the clients must agree on exactly.
 *
 * Anything an administrator can change per college lives in the
 * `college_config` table instead — see NFR-M-01. What is here is either a
 * platform-wide invariant or a shape (an upload limit, a code length) that
 * clients need in order to validate before they send.
 */

/** Length of the handover code (FR-DLV-12). */
export const HANDOVER_OTP_LENGTH = 6;

/** Length of the account verification code (FR-AUTH-02). */
export const AUTH_OTP_LENGTH = 6;

export const AUTH_OTP_TTL_SECONDS = 10 * 60;

/** FR-SVER-03 / FR-CHAT-02: upload ceilings, in bytes. */
export const MAX_DOCUMENT_BYTES = 5 * 1024 * 1024;
export const MAX_IMAGE_BYTES = 5 * 1024 * 1024;
export const MAX_CHAT_ATTACHMENT_BYTES = 10 * 1024 * 1024;

export const ACCEPTED_IMAGE_MIME_TYPES = ['image/jpeg', 'image/png', 'image/webp'] as const;
export const ACCEPTED_DOCUMENT_MIME_TYPES = [
  'image/jpeg',
  'image/png',
  'image/webp',
  'application/pdf',
] as const;

/** FR-ORD-01: a cart may hold items from one shop only. */
export const MAX_CART_SHOPS = 1;
export const MAX_CART_ITEM_QUANTITY = 20;

/** FR-TRST-02 / FR-TRST-06: aggregates are hidden below this many ratings, so
 *  a rider cannot work out who left a single low score. */
export const MIN_RATINGS_BEFORE_DISPLAY = 5;

export const RATING_MIN = 1;
export const RATING_MAX = 5;

/** Version string recorded when a student accepts the rider terms (FR-WM-02). */
export const RIDER_TERMS_VERSION = '2026-11-01';

/** Prefix for the short human-readable order reference, e.g. HP-7F3K2MP. */
export const ORDER_REFERENCE_PREFIX = 'HP';

/**
 * Characters in the random part of an order reference.
 *
 * Seven, from a 32-character alphabet, so about 34 billion possibilities.
 * Five characters — 33.5 million — looks ample and is not: at a few tens of
 * thousands of orders a year the birthday bound makes a collision near
 * certain rather than unlikely. The unique constraint on the column is still
 * the guarantee; this decides how often it has to do anything.
 */
export const ORDER_REFERENCE_LENGTH = 7;

/** Redis key layouts. Centralised so the dispatcher and the gateway agree. */
export const redisKeys = {
  /** GEO set of online riders for one college. */
  riderGeo: (collegeId: string) => `riders:geo:${collegeId}`,
  /** Hash of rider id to last ping timestamp, for idle sweeping. */
  riderPing: (collegeId: string) => `riders:ping:${collegeId}`,
  /** Set of rider ids currently holding a task, excluded from broadcasts. */
  ridersBusy: (collegeId: string) => `riders:busy:${collegeId}`,
  /** Pub/sub channel carrying broadcast events across API instances. */
  dispatchChannel: (collegeId: string) => `dispatch:${collegeId}`,
  /** Short-lived guard so two dispatcher ticks cannot process one task. */
  dispatchLock: (taskId: string) => `lock:dispatch:${taskId}`,
} as const;

/** Notification categories a student may toggle (FR-NOTF-03). */
export const NOTIFICATION_CATEGORIES = [
  'VERIFICATION',
  'ORDER_STATUS',
  'TASK_OFFER',
  'TASK_STATUS',
  'CHAT',
  'COMMUNITY',
  'WALLET',
  'ANNOUNCEMENT',
] as const;

export type NotificationCategory = (typeof NOTIFICATION_CATEGORIES)[number];

/** FR-NOTF-03: this one cannot be switched off while work mode is on. */
export const UNDISABLEABLE_WHILE_ONLINE: NotificationCategory = 'TASK_OFFER';

/** WebSocket event names. Both ends import these rather than typing strings. */
export const wsEvents = {
  // server -> rider
  TASK_OFFER: 'task:offer',
  TASK_OFFER_WITHDRAWN: 'task:offer:withdrawn',
  TASK_ASSIGNED: 'task:assigned',
  // server -> requester / shop
  ORDER_STATUS_CHANGED: 'order:status',
  TASK_STATUS_CHANGED: 'task:status',
  /**
   * FR-DLV-12: the six-digit handover code, sent to the requester's device
   * only. Never stored in plaintext, so this push and a later re-issue are
   * the only ways it reaches anyone.
   */
  HANDOVER_CODE_ISSUED: 'task:handover-code',
  // server -> shop
  ORDER_INCOMING: 'order:incoming',
  // chat, both directions
  MESSAGE_NEW: 'message:new',
  MESSAGE_DELIVERED: 'message:delivered',
  MESSAGE_READ: 'message:read',
  // rider -> server
  RIDER_PING: 'rider:ping',
  TASK_ACCEPT: 'task:accept',
} as const;
