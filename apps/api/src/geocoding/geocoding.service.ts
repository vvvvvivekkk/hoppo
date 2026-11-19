import { BadRequestException, Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { isPlausibleLatLng, type LatLng } from '@hoppo/shared';

export interface GeocodeResult extends LatLng {
  formattedAddress: string;
  /** How precise the match was. ROOFTOP is a building; APPROXIMATE is a locality. */
  precision: 'ROOFTOP' | 'RANGE_INTERPOLATED' | 'GEOMETRIC_CENTER' | 'APPROXIMATE';
  placeId?: string;
}

/**
 * Address to coordinates (SI-1, FR-SHOP-04).
 *
 * Geocoding is only ever a *starting point* here. FR-SHOP-04 lets the owner
 * drag the pin to correct it, and that correction is what gets stored —
 * because a geocoder asked for "Ghatkesar Main Road" returns the middle of a
 * road that may be two kilometres long, and at a 3 km threshold that is the
 * difference between approval and rejection.
 *
 * So the rule this service encodes: a geocoded result with APPROXIMATE
 * precision is flagged as needing the owner to confirm the pin before the
 * distance is treated as meaningful.
 */
@Injectable()
export class GeocodingService {
  private readonly logger = new Logger(GeocodingService.name);
  private readonly apiKey: string | undefined;

  constructor(private readonly config: ConfigService) {
    this.apiKey = this.config.get<string>('GOOGLE_MAPS_API_KEY') || undefined;

    if (!this.apiKey) {
      this.logger.warn(
        'No GOOGLE_MAPS_API_KEY: address geocoding is unavailable, so shop registration ' +
          'requires explicit coordinates from the map pin',
      );
    }
  }

  get isConfigured(): boolean {
    return Boolean(this.apiKey);
  }

  /**
   * Geocode an address.
   *
   * Without an API key this throws a clear error rather than guessing, and
   * the shop registration flow falls back to requiring the coordinates the
   * owner set with the map pin — which is the more accurate input anyway.
   */
  async geocode(address: string): Promise<GeocodeResult> {
    if (!this.apiKey) {
      throw new BadRequestException({
        code: 'GEOCODING_NOT_CONFIGURED',
        message:
          'Address lookup is unavailable. Set the shop location by dragging the map pin instead.',
      });
    }

    const url = new URL('https://maps.googleapis.com/maps/api/geocode/json');
    url.searchParams.set('address', address);
    url.searchParams.set('key', this.apiKey);
    // Bias towards India, so "Main Road" does not resolve to Ohio.
    url.searchParams.set('region', 'in');
    url.searchParams.set('components', 'country:IN');

    const response = await fetch(url, { signal: AbortSignal.timeout(8000) });

    if (!response.ok) {
      this.logger.error(`Geocoding HTTP ${response.status}`);
      throw new BadRequestException({
        code: 'GEOCODING_FAILED',
        message: 'Could not look up that address. Set the location with the map pin instead.',
      });
    }

    const body = (await response.json()) as {
      status: string;
      results?: {
        geometry: { location: { lat: number; lng: number }; location_type: string };
        formatted_address: string;
        place_id: string;
      }[];
    };

    if (body.status === 'ZERO_RESULTS' || !body.results?.length) {
      throw new BadRequestException({
        code: 'ADDRESS_NOT_FOUND',
        message:
          'That address was not found. Check it, or set the location by dragging the map pin.',
      });
    }

    if (body.status !== 'OK') {
      this.logger.error(`Geocoding status ${body.status}`);
      throw new BadRequestException({
        code: 'GEOCODING_FAILED',
        message: 'Could not look up that address. Set the location with the map pin instead.',
      });
    }

    const top = body.results[0];
    const result: GeocodeResult = {
      latitude: top.geometry.location.lat,
      longitude: top.geometry.location.lng,
      formattedAddress: top.formatted_address,
      precision: (top.geometry.location_type as GeocodeResult['precision']) ?? 'APPROXIMATE',
      placeId: top.place_id,
    };

    if (!isPlausibleLatLng(result)) {
      throw new BadRequestException({
        code: 'GEOCODING_FAILED',
        message: 'The address lookup returned an invalid location.',
      });
    }

    return result;
  }

  /**
   * True when the geocoded point is too coarse to decide a radius on, so the
   * UI must make the owner confirm the pin (FR-SHOP-04).
   */
  needsPinConfirmation(precision: GeocodeResult['precision']): boolean {
    return precision === 'APPROXIMATE' || precision === 'GEOMETRIC_CENTER';
  }
}
