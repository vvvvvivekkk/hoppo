import { Controller, Get } from '@nestjs/common';
import { ApiOperation, ApiTags } from '@nestjs/swagger';
import { Public } from '../common/decorators/public.decorator';
import { PrismaService } from '../prisma/prisma.service';
import { RedisService } from '../redis/redis.service';

@ApiTags('health')
@Controller('health')
export class HealthController {
  constructor(
    private readonly prisma: PrismaService,
    private readonly redis: RedisService,
  ) {}

  /**
   * Liveness: is the process up. Deliberately checks nothing else, so that a
   * database blip does not cause the orchestrator to kill a healthy process.
   */
  @Public()
  @Get()
  @ApiOperation({ summary: 'Liveness' })
  live() {
    return { status: 'ok', uptime: Math.round(process.uptime()) };
  }

  /**
   * Readiness: can this instance actually serve traffic. Checks both stores,
   * and reports PostGIS specifically — without it, shop registration cannot
   * validate a radius, so an instance missing it is not ready even though the
   * database answers.
   */
  @Public()
  @Get('ready')
  @ApiOperation({ summary: 'Readiness, including dependencies' })
  async ready() {
    const checks: Record<string, { ok: boolean; detail?: string }> = {};

    try {
      await this.prisma.$queryRaw`SELECT 1`;
      checks.database = { ok: true };
    } catch (e) {
      checks.database = { ok: false, detail: e instanceof Error ? e.message : 'unknown' };
    }

    try {
      const rows = await this.prisma.$queryRaw<{ v: string }[]>`SELECT postgis_version() AS v`;
      checks.postgis = { ok: true, detail: rows[0]?.v };
    } catch {
      checks.postgis = {
        ok: false,
        detail: 'PostGIS unavailable — shop radius validation will fail',
      };
    }

    try {
      const pong = await this.redis.client.ping();
      checks.redis = { ok: pong === 'PONG' };
    } catch (e) {
      checks.redis = { ok: false, detail: e instanceof Error ? e.message : 'unknown' };
    }

    const ok = Object.values(checks).every((c) => c.ok);
    return { status: ok ? 'ok' : 'degraded', checks };
  }
}
