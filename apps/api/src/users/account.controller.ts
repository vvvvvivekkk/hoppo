import { Body, Controller, Get, HttpCode, Patch, Post } from '@nestjs/common';
import { ApiOperation, ApiTags } from '@nestjs/swagger';
import { Throttle } from '@nestjs/throttler';
import { AccountService } from './account.service';
import { DeleteAccountDto, UpdateProfileDto } from './dto/account.dto';
import { CurrentUser } from '../common/decorators/current-user.decorator';
import { Roles } from '../common/decorators/roles.decorator';
import type { AuthenticatedUser } from '../common/types/authenticated-user';

/**
 * Account & data (S-55, FR-PRIV-05).
 *
 * @Roles('STUDENT'): the requirement is the student's. Not @RequireVerified —
 * a person waiting on verification, or rejected, has the same right to their
 * data and to leave.
 */
@ApiTags('account')
@Controller('account')
@Roles('STUDENT')
export class AccountController {
  constructor(private readonly account: AccountService) {}

  /** S-50: name and photo. Answers with the same body as GET /auth/me. */
  @Patch('profile')
  @ApiOperation({ summary: 'Change my display name or profile photo' })
  updateProfile(@CurrentUser() user: AuthenticatedUser, @Body() dto: UpdateProfileDto) {
    return this.account.updateProfile(user, dto);
  }

  /** Limited because each call reads the caller's whole history. */
  @Throttle({ default: { limit: 5, ttl: 3_600_000 } })
  @Get('export')
  @ApiOperation({ summary: 'Export my personal data as JSON' })
  exportData(@CurrentUser() user: AuthenticatedUser) {
    return this.account.exportData(user);
  }

  /** Password attempts are limited like a login. */
  @Throttle({ default: { limit: 5, ttl: 60_000 } })
  @Post('delete')
  @HttpCode(200)
  @ApiOperation({ summary: 'Delete my account and erase my personal details' })
  deleteAccount(@CurrentUser() user: AuthenticatedUser, @Body() dto: DeleteAccountDto) {
    return this.account.deleteAccount(user, dto.password);
  }
}
