import { Module } from '@nestjs/common';
import {
  AdminVerificationController,
  VerificationController,
} from './verification.controller';
import { VerificationService } from './verification.service';
import { AuthModule } from '../auth/auth.module';

@Module({
  // AuthModule, because suspension must revoke sessions (FR-SVER-08).
  imports: [AuthModule],
  controllers: [VerificationController, AdminVerificationController],
  providers: [VerificationService],
  exports: [VerificationService],
})
export class VerificationModule {}
