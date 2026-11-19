import { Module } from '@nestjs/common';
import {
  AdminVerificationController,
  VerificationController,
} from './verification.controller';
import { VerificationService } from './verification.service';
import { AuthModule } from '../auth/auth.module';
import { DispatchModule } from '../dispatch/dispatch.module';

@Module({
  // AuthModule, because suspension must revoke sessions (FR-SVER-08), and
  // DispatchModule, because it must also close the student's open sockets.
  // DispatchModule imports nothing from here or from AuthModule, so this is
  // not circular.
  imports: [AuthModule, DispatchModule],
  controllers: [VerificationController, AdminVerificationController],
  providers: [VerificationService],
  exports: [VerificationService],
})
export class VerificationModule {}
