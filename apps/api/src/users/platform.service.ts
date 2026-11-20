import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  Injectable,
  Logger,
  NotFoundException,
} from '@nestjs/common';
import * as argon2 from 'argon2';
import type { College, Prisma } from '@prisma/client';
import { DEFAULT_TIMEZONE } from '@hoppo/shared';
import { PrismaService } from '../prisma/prisma.service';
import { AuditAction, AuditService } from '../audit/audit.service';
import { AuthService } from '../auth/auth.service';
import { DispatchGateway } from '../dispatch/dispatch.gateway';
import { DEFAULT_FEE_BANDS } from '../shops/college-config.rules';
import type { AuthenticatedUser } from '../common/types/authenticated-user';
import type { CreateCollegeAdminDto, CreateCollegeDto } from './dto/platform.dto';

/** True for a zone name the runtime's tz database knows. */
export function isValidTimeZone(zone: string): boolean {
  try {
    new Intl.DateTimeFormat('en-US', { timeZone: zone });
    return true;
  } catch {
    return false;
  }
}

const ADMIN_SELECT = {
  id: true,
  name: true,
  mobile: true,
  email: true,
  status: true,
  collegeId: true,
  createdAt: true,
  lastLoginAt: true,
} as const;

/**
 * FR-TEN-01 and FR-ADM-07: tenants and their administrators.
 *
 * Everything here is for a SUPER_ADMIN, who belongs to no college and works
 * across all of them — so, uniquely, nothing in this service is tenant-scoped.
 * The restriction is the role: the controller is @Roles('SUPER_ADMIN'), and
 * each method re-checks it, because a method that creates administrators
 * should not depend on being reached through one particular controller.
 */
@Injectable()
export class PlatformService {
  private readonly logger = new Logger(PlatformService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly audit: AuditService,
    private readonly auth: AuthService,
    private readonly gateway: DispatchGateway,
  ) {}

  private assertSuperAdmin(user: AuthenticatedUser): void {
    if (user.role !== 'SUPER_ADMIN') {
      throw new ForbiddenException({
        code: 'FORBIDDEN',
        message: 'This action requires a super administrator.',
      });
    }
  }

  // =======================================================================
  // Colleges — FR-TEN-01
  // =======================================================================

  private async shapeColleges(colleges: College[]) {
    if (colleges.length === 0) return [];
    const ids = colleges.map((c) => c.id);

    const [configs, users, listings] = await Promise.all([
      this.prisma.collegeConfig.findMany({
        where: { collegeId: { in: ids } },
        select: { collegeId: true, serviceableRadiusM: true },
      }),
      this.prisma.user.groupBy({
        by: ['collegeId', 'role'],
        where: { collegeId: { in: ids }, role: { in: ['ADMIN', 'STUDENT'] }, status: 'ACTIVE' },
        _count: { _all: true },
      }),
      this.prisma.shopListing.groupBy({
        by: ['collegeId'],
        where: { collegeId: { in: ids } },
        _count: { _all: true },
      }),
    ]);

    const radius = new Map(configs.map((c) => [c.collegeId, c.serviceableRadiusM]));
    const count = (collegeId: string, role: 'ADMIN' | 'STUDENT') =>
      users.find((u) => u.collegeId === collegeId && u.role === role)?._count._all ?? 0;

    return colleges.map((c) => ({
      id: c.id,
      name: c.name,
      shortName: c.shortName,
      address: c.address,
      city: c.city,
      state: c.state,
      latitude: c.latitude,
      longitude: c.longitude,
      timezone: c.timezone,
      emailDomain: c.emailDomain,
      contactName: c.contactName,
      contactPhone: c.contactPhone,
      contactEmail: c.contactEmail,
      status: c.status,
      serviceableRadiusM: radius.get(c.id) ?? 3000,
      createdAt: c.createdAt,
      counts: {
        admins: count(c.id, 'ADMIN'),
        students: count(c.id, 'STUDENT'),
        shopListings: listings.find((l) => l.collegeId === c.id)?._count._all ?? 0,
      },
    }));
  }

  private async collegeOrThrow(collegeId: string): Promise<College> {
    const college = await this.prisma.college.findUnique({ where: { id: collegeId } });
    if (!college) {
      throw new NotFoundException({ code: 'NOT_FOUND', message: 'College not found' });
    }
    return college;
  }

  async listColleges(user: AuthenticatedUser) {
    this.assertSuperAdmin(user);
    const colleges = await this.prisma.college.findMany({ orderBy: { name: 'asc' } });
    return { colleges: await this.shapeColleges(colleges) };
  }

  async collegeDetail(user: AuthenticatedUser, collegeId: string) {
    this.assertSuperAdmin(user);
    const college = await this.collegeOrThrow(collegeId);
    const [shaped] = await this.shapeColleges([college]);
    const admins = await this.prisma.user.findMany({
      where: { collegeId, role: 'ADMIN' },
      select: ADMIN_SELECT,
      orderBy: { createdAt: 'asc' },
    });
    return { ...shaped, admins };
  }

  /**
   * FR-TEN-01: "create a college tenant with a name, address, latitude and
   * longitude, serviceable radius (default 3 km), and contact details."
   *
   * The config row and fee bands are created with it, in one transaction: a
   * college without them cannot price a delivery or dispatch a task, and
   * every reader of `college_config` would be on its fallbacks.
   */
  async createCollege(user: AuthenticatedUser, dto: CreateCollegeDto) {
    this.assertSuperAdmin(user);

    const timezone = dto.timezone ?? DEFAULT_TIMEZONE;
    if (!isValidTimeZone(timezone)) {
      throw new BadRequestException({
        code: 'INVALID_TIMEZONE',
        message: `"${timezone}" is not a known timezone. Use an IANA name such as Asia/Kolkata.`,
      });
    }

    const nameClash = await this.prisma.college.findFirst({
      where: { name: { equals: dto.name, mode: 'insensitive' } },
      select: { id: true },
    });
    if (nameClash) {
      throw new ConflictException({
        code: 'COLLEGE_NAME_TAKEN',
        message: 'A college with that name already exists.',
      });
    }

    if (dto.emailDomain) {
      // Two colleges sharing a domain would let one address register at either.
      const domainClash = await this.prisma.college.findFirst({
        where: { emailDomain: { equals: dto.emailDomain, mode: 'insensitive' } },
        select: { id: true },
      });
      if (domainClash) {
        throw new ConflictException({
          code: 'EMAIL_DOMAIN_TAKEN',
          message: 'Another college already uses that email domain.',
        });
      }
    }

    const college = await this.prisma.$transaction(async (tx) => {
      const created = await tx.college.create({
        data: {
          name: dto.name,
          shortName: dto.shortName || null,
          address: dto.address,
          city: dto.city,
          state: dto.state,
          latitude: dto.latitude,
          longitude: dto.longitude,
          timezone,
          emailDomain: dto.emailDomain ?? null,
          contactName: dto.contactName || null,
          contactPhone: dto.contactPhone ?? null,
          contactEmail: dto.contactEmail ?? null,
        },
      });

      // Every other setting takes the schema's column default.
      await tx.collegeConfig.create({
        data: {
          collegeId: created.id,
          ...(dto.serviceableRadiusM ? { serviceableRadiusM: dto.serviceableRadiusM } : {}),
        },
      });

      await tx.feeBand.createMany({
        data: DEFAULT_FEE_BANDS.map((band) => ({ collegeId: created.id, ...band })),
      });

      await this.audit.recordInTransaction(tx, {
        actorId: user.userId,
        collegeId: created.id,
        action: AuditAction.COLLEGE_CREATED,
        targetType: 'college',
        targetId: created.id,
        detail: {
          name: created.name,
          latitude: created.latitude,
          longitude: created.longitude,
          serviceableRadiusM: dto.serviceableRadiusM ?? 3000,
          timezone,
          emailDomain: created.emailDomain,
        },
      });

      return created;
    });

    this.logger.log(`College ${college.id} (${college.name}) created by ${user.userId}`);
    return (await this.shapeColleges([college]))[0];
  }

  /**
   * FR-ADM-07: deactivate, or bring back, a tenant.
   *
   * Nothing is deleted. An inactive college leaves the signup list, refuses
   * registration and login, and the JWT strategy refuses its users' requests
   * (COLLEGE_INACTIVE) — so deactivation is one status change, reversed by
   * one status change.
   */
  async setCollegeStatus(
    user: AuthenticatedUser,
    collegeId: string,
    status: 'ACTIVE' | 'INACTIVE',
    reason?: string,
  ) {
    this.assertSuperAdmin(user);
    const college = await this.collegeOrThrow(collegeId);

    if (college.status === status) {
      throw new ConflictException({
        code: status === 'ACTIVE' ? 'ALREADY_ACTIVE' : 'ALREADY_INACTIVE',
        message: `That college is already ${status.toLowerCase()}.`,
      });
    }

    const { updated, memberIds, sessionsRevoked } = await this.prisma.$transaction(async (tx) => {
      const row = await tx.college.update({ where: { id: collegeId }, data: { status } });

      let members: string[] = [];
      let revoked = 0;
      if (status === 'INACTIVE') {
        // Every account of the tenant, whatever its role or standing: these
        // are the people whose sessions and sockets have to end now.
        members = (
          await tx.user.findMany({ where: { collegeId }, select: { id: true } })
        ).map((u) => u.id);

        // In the same transaction as the status change, so there is no
        // moment at which the college is inactive and its refresh tokens live.
        revoked = (
          await tx.refreshToken.updateMany({
            where: { user: { collegeId }, revokedAt: null },
            data: { revokedAt: new Date() },
          })
        ).count;
      }

      await this.audit.recordInTransaction(tx, {
        actorId: user.userId,
        collegeId,
        action:
          status === 'ACTIVE' ? AuditAction.COLLEGE_ACTIVATED : AuditAction.COLLEGE_DEACTIVATED,
        targetType: 'college',
        targetId: collegeId,
        detail:
          status === 'INACTIVE'
            ? { ...(reason ? { reason } : {}), sessionsRevoked: revoked, accounts: members.length }
            : reason
              ? { reason }
              : undefined,
      });
      return { updated: row, memberIds: members, sessionsRevoked: revoked };
    });

    // After the commit, never before: a socket dropped for a deactivation
    // that then rolled back would be a disconnection for nothing. A socket is
    // authenticated once, at connect, so without this an open one would keep
    // receiving offers and chat from a college that is switched off.
    for (const memberId of memberIds) this.gateway.disconnectUser(memberId);

    if (status === 'INACTIVE') {
      this.logger.warn(
        `College ${collegeId} deactivated by ${user.userId}: ${sessionsRevoked} session(s) revoked, ${memberIds.length} account(s) disconnected`,
      );
    }

    return (await this.shapeColleges([updated]))[0];
  }

  // =======================================================================
  // College administrators — FR-ADM-07
  // =======================================================================

  /**
   * "Assign administrators": create an ADMIN account attached to the college.
   * An account belongs to exactly one college (FR-TEN-02), so assigning is
   * creating; there is no moving an administrator between tenants.
   */
  async createCollegeAdmin(user: AuthenticatedUser, collegeId: string, dto: CreateCollegeAdminDto) {
    this.assertSuperAdmin(user);
    const college = await this.collegeOrThrow(collegeId);

    if (college.status !== 'ACTIVE') {
      throw new ConflictException({
        code: 'COLLEGE_INACTIVE',
        message: 'Activate the college before adding administrators to it.',
      });
    }

    const passwordHash = await argon2.hash(dto.password, { type: argon2.argon2id });

    // Mobile and email uniqueness is the database's: a clash is P2002, which
    // the exception filter turns into 409 ALREADY_EXISTS.
    return this.prisma.$transaction(async (tx) => {
      const admin = await tx.user.create({
        data: {
          collegeId,
          role: 'ADMIN',
          name: dto.name,
          mobile: dto.mobile,
          email: dto.email,
          passwordHash,
          // The super administrator vouches for the number by entering it.
          // Without this the account could never use password reset, which
          // is sent only to a verified mobile (FR-AUTH-07).
          mobileVerifiedAt: new Date(),
        },
        select: ADMIN_SELECT,
      });

      await this.audit.recordInTransaction(tx, {
        actorId: user.userId,
        collegeId,
        action: AuditAction.ADMIN_CREATED,
        targetType: 'user',
        targetId: admin.id,
        detail: { collegeName: college.name, mobileVouchedBy: user.userId },
      });

      return admin;
    });
  }

  /**
   * Set a college administrator's password.
   *
   * For the administrator who is locked out and cannot receive a reset code.
   * Ends every session the account has: whoever was signed in with the old
   * password should not stay signed in. The audit entry records that it
   * happened and who did it — never the password.
   */
  async setAdminPassword(user: AuthenticatedUser, adminId: string, password: string) {
    this.assertSuperAdmin(user);

    const target = await this.prisma.user.findUnique({
      where: { id: adminId },
      select: { id: true, role: true, collegeId: true },
    });
    if (!target) throw new NotFoundException({ code: 'NOT_FOUND', message: 'Account not found' });

    // ADMIN accounts only, for the same reason as setAdminStatus: this must
    // not be a way into a student's, a shop's or another super admin's account.
    if (target.role !== 'ADMIN') {
      throw new BadRequestException({
        code: 'NOT_AN_ADMIN',
        message: 'That account is not a college administrator.',
      });
    }

    const passwordHash = await argon2.hash(password, { type: argon2.argon2id });

    const updated = await this.prisma.$transaction(async (tx) => {
      const row = await tx.user.update({
        where: { id: adminId },
        data: { passwordHash, failedLoginCount: 0, lockedUntil: null },
        select: ADMIN_SELECT,
      });
      await this.audit.recordInTransaction(tx, {
        actorId: user.userId,
        collegeId: target.collegeId,
        action: AuditAction.ADMIN_PASSWORD_SET,
        targetType: 'user',
        targetId: adminId,
      });
      return row;
    });

    const sessionsRevoked = await this.auth.revokeAllSessions(adminId);
    this.gateway.disconnectUser(adminId);

    return { ...updated, sessionsRevoked };
  }

  /** Deactivate or reactivate a college administrator's account. */
  async setAdminStatus(
    user: AuthenticatedUser,
    adminId: string,
    status: 'ACTIVE' | 'DEACTIVATED',
    reason?: string,
  ) {
    this.assertSuperAdmin(user);

    const target = await this.prisma.user.findUnique({
      where: { id: adminId },
      select: { id: true, role: true, status: true, collegeId: true },
    });
    if (!target) throw new NotFoundException({ code: 'NOT_FOUND', message: 'Account not found' });

    // Only ADMIN accounts: this route must not become a way to close a
    // student's or a shop's account, or another super administrator's.
    if (target.role !== 'ADMIN') {
      throw new BadRequestException({
        code: 'NOT_AN_ADMIN',
        message: 'That account is not a college administrator.',
      });
    }

    if (target.status === status) {
      throw new ConflictException({
        code: status === 'ACTIVE' ? 'ALREADY_ACTIVE' : 'ALREADY_INACTIVE',
        message:
          status === 'ACTIVE'
            ? 'That account is already active.'
            : 'That account is already deactivated.',
      });
    }

    const data: Prisma.UserUpdateInput = { status };

    const updated = await this.prisma.$transaction(async (tx) => {
      const row = await tx.user.update({ where: { id: adminId }, data, select: ADMIN_SELECT });
      await this.audit.recordInTransaction(tx, {
        actorId: user.userId,
        collegeId: target.collegeId,
        action: status === 'ACTIVE' ? AuditAction.ADMIN_REACTIVATED : AuditAction.ADMIN_DEACTIVATED,
        targetType: 'user',
        targetId: adminId,
        detail: reason ? { reason } : undefined,
      });
      return row;
    });

    if (status === 'DEACTIVATED') {
      // The JWT strategy already refuses a DEACTIVATED account on its next
      // request; this ends the refresh tokens and any open socket as well.
      await this.auth.revokeAllSessions(adminId);
      this.gateway.disconnectUser(adminId);
    }

    return updated;
  }
}
