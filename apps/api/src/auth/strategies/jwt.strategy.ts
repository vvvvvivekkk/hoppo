import { Injectable, UnauthorizedException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { PassportStrategy } from '@nestjs/passport';
import { ExtractJwt, Strategy } from 'passport-jwt';
import { PrismaService } from '../../prisma/prisma.service';
import { ShopAccessService, isShopRole } from '../../common/access/shop-access.service';
import type { AccessTokenPayload, AuthenticatedUser } from '../../common/types/authenticated-user';

/**
 * Validates the access token on every authenticated request.
 *
 * A signed token proves the claims were issued by us and have not been
 * altered. It does not prove the account is still in good standing — a
 * student suspended thirty seconds ago still holds a valid, unexpired token.
 *
 * FR-SVER-08 requires suspension to terminate active sessions *immediately*,
 * so this strategy checks the database on each request rather than trusting
 * the token's claims alone. That is one indexed primary-key lookup per
 * request, which is cheap, and it is the only way a short-lived token can be
 * revoked before it expires.
 */
@Injectable()
export class JwtStrategy extends PassportStrategy(Strategy, 'jwt') {
  constructor(
    config: ConfigService,
    private readonly prisma: PrismaService,
    private readonly shopAccess: ShopAccessService,
  ) {
    super({
      jwtFromRequest: ExtractJwt.fromAuthHeaderAsBearerToken(),
      ignoreExpiration: false,
      secretOrKey: config.getOrThrow<string>('JWT_ACCESS_SECRET'),
    });
  }

  async validate(payload: AccessTokenPayload): Promise<AuthenticatedUser> {
    const user = await this.prisma.user.findUnique({
      where: { id: payload.sub },
      select: {
        id: true,
        collegeId: true,
        role: true,
        status: true,
        studentProfile: { select: { verificationStatus: true } },
      },
    });

    if (!user) {
      throw new UnauthorizedException('Account no longer exists');
    }

    // FR-SVER-08: suspension takes effect now, not when the token expires.
    if (user.status === 'SUSPENDED') {
      throw new UnauthorizedException({
        code: 'ACCOUNT_SUSPENDED',
        message: 'This account has been suspended. Contact your campus administrator.',
      });
    }

    if (user.status === 'DEACTIVATED') {
      throw new UnauthorizedException({
        code: 'ACCOUNT_DEACTIVATED',
        message: 'This account has been closed.',
      });
    }

    // A shop account exists from the moment of (public) registration, long
    // before an administrator approves the shop. Whether it has been approved
    // is looked up here, per request, so approval takes effect without a new
    // login and ShopApprovalGuard can refuse everything else until then.
    const shopApproved = isShopRole(user.role)
      ? await this.shopAccess.hasApprovedShop(user.id)
      : undefined;

    return {
      userId: user.id,
      collegeId: user.collegeId,
      role: user.role,
      // Read from the database, not from the token: a student verified two
      // minutes ago should not have to log out and back in to place an order.
      isVerified: user.studentProfile?.verificationStatus === 'VERIFIED',
      ...(shopApproved === undefined ? {} : { shopApproved }),
    };
  }
}
