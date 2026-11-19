import { Module } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import { APP_FILTER, APP_GUARD } from '@nestjs/core';
import { ScheduleModule } from '@nestjs/schedule';
import { ThrottlerGuard, ThrottlerModule } from '@nestjs/throttler';

import { loadConfiguration } from './config/configuration';
import { PrismaModule } from './prisma/prisma.module';
import { RedisModule } from './redis/redis.module';
import { AuditModule } from './audit/audit.module';
import { TenantModule } from './common/tenant/tenant.module';
import { AuthModule } from './auth/auth.module';
import { VerificationModule } from './verification/verification.module';
import { StorageModule } from './storage/storage.module';
import { GeocodingModule } from './geocoding/geocoding.module';
import { ShopsModule } from './shops/shops.module';
import { CatalogModule } from './catalog/catalog.module';
import { HealthModule } from './health/health.module';

import { JwtAuthGuard } from './common/guards/jwt-auth.guard';
import { RolesGuard } from './common/guards/roles.guard';
import { VerifiedGuard } from './common/guards/verified.guard';
import { AllExceptionsFilter } from './common/filters/all-exceptions.filter';

@Module({
  imports: [
    ConfigModule.forRoot({
      isGlobal: true,
      // Validated at startup; a missing DATABASE_URL stops the process rather
      // than surfacing as `undefined` mid-request hours after deploy.
      load: [loadConfiguration],
      validate: () => loadConfiguration(),
      envFilePath: ['.env', '../../.env'],
    }),

    // NFR-S-06: a global default, with tighter per-endpoint limits applied by
    // @Throttle on the expensive ones (OTP issue, login, task accept).
    ThrottlerModule.forRoot([{ ttl: 60_000, limit: 120 }]),

    // ADR-005: the dispatcher and the idle sweeps run as scheduled jobs.
    ScheduleModule.forRoot(),

    PrismaModule,
    RedisModule,
    AuditModule,
    TenantModule,
    StorageModule,
    GeocodingModule,

    AuthModule,
    VerificationModule,
    ShopsModule,
    CatalogModule,
    HealthModule,
  ],
  providers: [
    // Guard order matters, and it is the order listed here: authenticate
    // first, then check the role, then check verification. Each later guard
    // relies on request.user existing, which only the first one sets.
    { provide: APP_GUARD, useClass: ThrottlerGuard },
    { provide: APP_GUARD, useClass: JwtAuthGuard },
    { provide: APP_GUARD, useClass: RolesGuard },
    { provide: APP_GUARD, useClass: VerifiedGuard },

    { provide: APP_FILTER, useClass: AllExceptionsFilter },
  ],
})
export class AppModule {}
