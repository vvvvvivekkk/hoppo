import { Global, Module } from '@nestjs/common';
import { PrismaService } from './prisma.service';

/**
 * Global so that every feature module can inject PrismaService without
 * importing this module explicitly. Appropriate for a cross-cutting
 * dependency that every module needs; not a pattern to reach for otherwise.
 */
@Global()
@Module({
  providers: [PrismaService],
  exports: [PrismaService],
})
export class PrismaModule {}
