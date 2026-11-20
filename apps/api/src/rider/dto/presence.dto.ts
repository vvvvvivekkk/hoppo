import { IsISO8601 } from 'class-validator';

/**
 * The date range of the dashboard (FR-ADM-05, "for a selected date range").
 * Instants, not calendar dates: the client knows the college's time zone and
 * says exactly which hours it wants; the server stores and answers in UTC.
 */
export class RiderPresenceQueryDto {
  /** Start of the range, inclusive. ISO 8601 with an offset, e.g. 2026-11-20T00:00:00+05:30. */
  @IsISO8601({ strict: true }, { message: 'from must be an ISO 8601 date-time' })
  from!: string;

  /** End of the range, exclusive. */
  @IsISO8601({ strict: true }, { message: 'to must be an ISO 8601 date-time' })
  to!: string;
}
