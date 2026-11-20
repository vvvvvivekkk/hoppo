import { Module } from '@nestjs/common';
import { AccountController } from './account.controller';
import { AccountService } from './account.service';
import { PlatformController } from './platform.controller';
import { PlatformService } from './platform.service';
import { AuthModule } from '../auth/auth.module';
import { DispatchModule } from '../dispatch/dispatch.module';

/**
 * Accounts as such: a person's own data (export, deletion) and the platform's
 * tenants and administrators.
 *
 * AuthModule for revoking sessions, DispatchModule for closing sockets —
 * neither imports this module, so there is no cycle.
 */
@Module({
  imports: [AuthModule, DispatchModule],
  controllers: [AccountController, PlatformController],
  providers: [AccountService, PlatformService],
})
export class UsersModule {}
