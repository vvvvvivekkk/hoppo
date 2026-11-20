import { Controller, Get, Query } from '@nestjs/common';
import { ApiOperation, ApiTags } from '@nestjs/swagger';
import { WalletStatementService } from './wallet-statement.service';
import { CurrentUser } from '../common/decorators/current-user.decorator';
import { Roles } from '../common/decorators/roles.decorator';
import type { AuthenticatedUser } from '../common/types/authenticated-user';

/**
 * A student's own wallet: statement, rider earnings, withdrawal requests.
 *
 * Three GETs. There is no route here that takes a user id — the wallet is
 * always the caller's, from the token — and none that writes: requesting a
 * withdrawal and paying one out are not built (they wait on how payouts will
 * be made).
 *
 * @Roles('STUDENT'): riders are students, and only students have wallets.
 * Not @RequireVerified: a student whose verification is pending or was
 * withdrawn must still be able to see money that is theirs.
 */
@ApiTags('wallet')
@Controller('wallet')
@Roles('STUDENT')
export class WalletController {
  constructor(private readonly wallet: WalletStatementService) {}

  /** FR-PAY-04 */
  @Get('statement')
  @ApiOperation({ summary: 'My wallet statement, oldest first, with running balance' })
  statement(
    @CurrentUser() user: AuthenticatedUser,
    @Query('from') from?: string,
    @Query('to') to?: string,
    @Query('limit') limit?: string,
    @Query('cursor') cursor?: string,
  ) {
    return this.wallet.statement(user, { from, to, limit, cursor });
  }

  /** S-24, FR-WM-08 */
  @Get('earnings')
  @ApiOperation({ summary: 'What I earned as a rider in a period, cash and wallet apart' })
  earnings(
    @CurrentUser() user: AuthenticatedUser,
    @Query('from') from?: string,
    @Query('to') to?: string,
  ) {
    return this.wallet.earnings(user, { from, to });
  }

  @Get('withdrawals')
  @ApiOperation({ summary: 'My withdrawal requests (read-only)' })
  withdrawals(
    @CurrentUser() user: AuthenticatedUser,
    @Query('limit') limit?: string,
    @Query('cursor') cursor?: string,
  ) {
    return this.wallet.withdrawals(user, { limit, cursor });
  }
}
