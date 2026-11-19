/**
 * Geography helpers.
 *
 * Two different jobs, two different tools:
 *
 *  1. The *authoritative* distance between a shop and its college is computed
 *     by PostGIS in the database, with ST_Distance over the `geography` type.
 *     That measures over the curved surface of the earth, which is what the
 *     SRS means by "geodesic" (C-2, FR-SHOP-05). It is the number that decides
 *     whether a shop may register, so it must be exact and it must be
 *     computed in one place.
 *
 *  2. The *approximate* distances shown in a UI — "1.2 km away", sorting a
 *     list, drawing a radius circle — are computed here with the haversine
 *     formula. Good to a few metres over campus distances, needs no round
 *     trip, and nobody's registration depends on it.
 *
 * Never use the functions in this file to make an admission decision. Call
 * the database.
 */

export interface LatLng {
  latitude: number;
  longitude: number;
}

/** Mean earth radius in metres, as used by the haversine formula. */
const EARTH_RADIUS_M = 6_371_008.8;

const toRadians = (degrees: number): number => (degrees * Math.PI) / 180;

/**
 * Great-circle distance between two points, in metres.
 *
 * "Haversine" treats the earth as a sphere and measures the shortest path
 * across its surface. The error against a proper ellipsoid model is well
 * under 0.5%, which over 3 km is about 15 m — fine for a label, not fine for
 * a threshold.
 */
export function haversineMetres(a: LatLng, b: LatLng): number {
  const dLat = toRadians(b.latitude - a.latitude);
  const dLng = toRadians(b.longitude - a.longitude);
  const lat1 = toRadians(a.latitude);
  const lat2 = toRadians(b.latitude);

  const h =
    Math.sin(dLat / 2) ** 2 + Math.cos(lat1) * Math.cos(lat2) * Math.sin(dLng / 2) ** 2;

  return 2 * EARTH_RADIUS_M * Math.asin(Math.min(1, Math.sqrt(h)));
}

/** "850 m" under a kilometre, "1.2 km" above it. */
export function formatDistance(metres: number): string {
  if (metres < 1000) return `${Math.round(metres)} m`;
  return `${(metres / 1000).toFixed(1)} km`;
}

/** Cheap sanity check on coordinates arriving from a client or a geocoder. */
export function isPlausibleLatLng(value: unknown): value is LatLng {
  if (typeof value !== 'object' || value === null) return false;
  const { latitude, longitude } = value as Partial<LatLng>;
  return (
    typeof latitude === 'number' &&
    typeof longitude === 'number' &&
    Number.isFinite(latitude) &&
    Number.isFinite(longitude) &&
    latitude >= -90 &&
    latitude <= 90 &&
    longitude >= -180 &&
    longitude <= 180 &&
    // 0,0 is in the Gulf of Guinea. It is almost always an unset field.
    !(latitude === 0 && longitude === 0)
  );
}

/** FR-TEN-04: an administrator may set the radius between 1 km and 5 km. */
export const RADIUS_MIN_M = 1000;
export const RADIUS_MAX_M = 5000;
export const RADIUS_DEFAULT_M = 3000;

export function isRadiusInPermittedRange(metres: number): boolean {
  return Number.isInteger(metres) && metres >= RADIUS_MIN_M && metres <= RADIUS_MAX_M;
}
