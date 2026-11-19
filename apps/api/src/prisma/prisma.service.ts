import { Injectable, Logger, OnModuleDestroy, OnModuleInit } from '@nestjs/common';
import { PrismaClient } from '@prisma/client';

/**
 * The database client, as a Nest service so it participates in the lifecycle
 * (connect on boot, disconnect on shutdown) and can be injected anywhere.
 */
@Injectable()
export class PrismaService extends PrismaClient implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(PrismaService.name);

  constructor() {
    super({
      log: [
        { emit: 'event', level: 'warn' },
        { emit: 'event', level: 'error' },
      ],
    });
  }

  async onModuleInit(): Promise<void> {
    await this.$connect();
    this.logger.log('Database connected');
  }

  async onModuleDestroy(): Promise<void> {
    await this.$disconnect();
  }

  /**
   * Geodesic distance in metres between two WGS84 points.
   *
   * Delegates to the SQL function created in the integrity-constraints
   * migration, which is the single authority for constraint C-2. Doing this
   * arithmetic in TypeScript would be a second, divergent implementation of a
   * rule that decides whether a shop may register.
   *
   * Note the argument order is latitude first, which is the opposite of
   * PostGIS ST_MakePoint — the SQL function handles the swap.
   */
  async geodesicDistanceM(
    a: { latitude: number; longitude: number },
    b: { latitude: number; longitude: number },
  ): Promise<number> {
    const rows = await this.$queryRaw<{ m: number | null }[]>`
      SELECT hoppo_geodesic_distance_m(
        ${a.latitude}::double precision,
        ${a.longitude}::double precision,
        ${b.latitude}::double precision,
        ${b.longitude}::double precision
      ) AS m
    `;

    const metres = rows[0]?.m;
    if (metres === null || metres === undefined || !Number.isFinite(metres)) {
      throw new Error('Geodesic distance calculation returned no result');
    }
    return Math.round(metres);
  }
}
