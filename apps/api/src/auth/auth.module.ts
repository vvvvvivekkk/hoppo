import { Module } from '@nestjs/common';
import { JwtModule } from '@nestjs/jwt';
import { PassportModule } from '@nestjs/passport';
import { AuthController } from './auth.controller';
import { AuthService } from './auth.service';
import { JwtStrategy } from './strategies/jwt.strategy';
import { OtpModule } from '../otp/otp.module';

@Module({
  imports: [
    PassportModule,
    // Secrets are passed per-sign call rather than registered here, because
    // access and refresh tokens use different secrets — sharing them would
    // let an access token be replayed as a refresh token.
    JwtModule.register({}),
    OtpModule,
  ],
  controllers: [AuthController],
  providers: [AuthService, JwtStrategy],
  exports: [AuthService],
})
export class AuthModule {}
