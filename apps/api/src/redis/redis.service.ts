import { Inject, Injectable, Logger, OnModuleDestroy } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import Redis from 'ioredis';
import { redisKeys } from '@hoppo/shared';

/**
 * Redis holds hot, short-lived state. Postgres remains the system of record.
 *
 * The division matters: if Redis is wiped, riders re-report their position on
 * the next ping and nothing of record is lost. Nothing here may be the only
 * copy of anything — see ADR-002.
 *
 * Three jobs:
 *   1. Rider presence as GEO sets, one per college, so the dispatcher can ask
 *      "who is within 1.5 km of this pickup" in sub-millisecond time.
 *   2. Pub/sub, so one broadcast fans out across every API instance.
 *   3. Short locks and rate-limit counters.
 */
@Injectable()
export class RedisService implements OnModuleDestroy {
  private readonly logger = new Logger(RedisService.name);
  readonly client: Redis;

  constructor(private readonly config: ConfigService) {
    const url = this.config.getOrThrow<string>('REDIS_URL');

    this.client = new Redis(url, {
      // NFR-R-05 asks for automatic reconnection with backoff. ioredis does
      // this; the strategy caps the delay so a long outage does not end with
      // a ten-minute wait after Redis comes back.
      retryStrategy: (times) => Math.min(times * 200, 3000),
      maxRetriesPerRequest: 3,
      lazyConnect: false,
    });

    this.client.on('error', (err) => this.logger.error(`Redis error: ${err.message}`));
    this.client.on('connect', () => this.logger.log('Redis connected'));
    this.client.on('reconnecting', () => this.logger.warn('Redis reconnecting'));
  }

  async onModuleDestroy(): Promise<void> {
    await this.client.quit();
  }

  /** A separate connection, because a subscribing client cannot issue commands. */
  duplicate(): Redis {
    return this.client.duplicate();
  }

  // -----------------------------------------------------------------------
  // Rider presence (FR-WM-03, FR-DLV-02)
  // -----------------------------------------------------------------------

  /**
   * Record a rider's position. Called on every ping, so it must be cheap:
   * two Redis writes, no database round trip.
   */
  async setRiderPosition(params: {
    collegeId: string;
    userId: string;
    latitude: number;
    longitude: number;
    ttlSeconds: number;
  }): Promise<void> {
    const { collegeId, userId, latitude, longitude, ttlSeconds } = params;

    await this.client
      .multi()
      // GEOADD takes longitude first. Getting this backwards puts every rider
      // in the wrong hemisphere, silently.
      .geoadd(redisKeys.riderGeo(collegeId), longitude, latitude, userId)
      .hset(redisKeys.riderPing(collegeId), userId, Date.now())
      // The GEO set itself is given a generous expiry so an abandoned college
      // key does not live forever; individual staleness is handled by the
      // ping timestamps and the idle sweep.
      .expire(redisKeys.riderGeo(collegeId), ttlSeconds * 10)
      .expire(redisKeys.riderPing(collegeId), ttlSeconds * 10)
      .exec();
  }

  /** Remove a rider from the pool — work mode off, suspended, or swept idle. */
  async removeRider(collegeId: string, userId: string): Promise<void> {
    await this.client
      .multi()
      .zrem(redisKeys.riderGeo(collegeId), userId)
      .hdel(redisKeys.riderPing(collegeId), userId)
      .srem(redisKeys.ridersBusy(collegeId), userId)
      .exec();
  }

  /**
   * Rider ids within `radiusM` of a point, nearest first.
   *
   * This is the query the §9.3 index could not have answered — see
   * resolution R-02. GEOSEARCH does it properly, on a sorted set that Redis
   * indexes by geohash.
   */
  async findRidersNear(params: {
    collegeId: string;
    latitude: number;
    longitude: number;
    radiusM: number;
    limit?: number;
  }): Promise<{ userId: string; distanceM: number }[]> {
    const { collegeId, latitude, longitude, radiusM, limit = 100 } = params;

    const results = (await this.client.geosearch(
      redisKeys.riderGeo(collegeId),
      'FROMLONLAT',
      longitude,
      latitude,
      'BYRADIUS',
      radiusM,
      'm',
      'ASC',
      'COUNT',
      limit,
      'WITHDIST',
    )) as unknown as [string, string][];

    return results.map(([userId, distance]) => ({
      userId,
      distanceM: Math.round(Number(distance)),
    }));
  }

  /** Riders excluded from broadcasts because they already hold a task (FR-WM-07). */
  async markRiderBusy(collegeId: string, userId: string): Promise<void> {
    await this.client.sadd(redisKeys.ridersBusy(collegeId), userId);
  }

  async markRiderFree(collegeId: string, userId: string): Promise<void> {
    await this.client.srem(redisKeys.ridersBusy(collegeId), userId);
  }

  async getBusyRiders(collegeId: string): Promise<string[]> {
    return this.client.smembers(redisKeys.ridersBusy(collegeId));
  }

  /** Riders whose last ping is older than the cutoff, for the idle sweep. */
  async findStaleRiders(collegeId: string, olderThanMs: number): Promise<string[]> {
    const pings = await this.client.hgetall(redisKeys.riderPing(collegeId));
    const cutoff = Date.now() - olderThanMs;
    return Object.entries(pings)
      .filter(([, ts]) => Number(ts) < cutoff)
      .map(([userId]) => userId);
  }

  // -----------------------------------------------------------------------
  // Locks
  // -----------------------------------------------------------------------

  /**
   * Try to take a short lock. Returns false if somebody else holds it.
   *
   * This is an optimisation, never a correctness guarantee: it stops two
   * dispatcher ticks doing the same work, but the invariant "one rider per
   * task" rests on the conditional UPDATE in ADR-001, not on this.
   */
  async acquireLock(key: string, ttlSeconds: number): Promise<boolean> {
    const result = await this.client.set(key, '1', 'EX', ttlSeconds, 'NX');
    return result === 'OK';
  }

  async releaseLock(key: string): Promise<void> {
    await this.client.del(key);
  }

  // -----------------------------------------------------------------------
  // Counters (NFR-S-06)
  // -----------------------------------------------------------------------

  /** Increment a windowed counter and return the new value. */
  async incrementWithExpiry(key: string, windowSeconds: number): Promise<number> {
    const results = await this.client.multi().incr(key).expire(key, windowSeconds, 'NX').exec();
    return (results?.[0]?.[1] as number) ?? 0;
  }
}
