import { Transform } from 'class-transformer';
import { IsOptional, IsString, MaxLength, MinLength, ValidateIf } from 'class-validator';

export class DeleteAccountDto {
  /** The account password, re-entered: deletion cannot be undone. */
  @IsString()
  @MinLength(1, { message: 'Enter your password to confirm' })
  @MaxLength(128)
  password!: string;
}

/**
 * S-50: what a student may change about their own profile.
 *
 * Two fields are editable. The rest are declared only so that sending one is
 * answered with a reason (see AccountService.updateProfile) instead of the
 * validation pipe's generic "property should not exist".
 */
export class UpdateProfileDto {
  @IsOptional()
  @Transform(({ value }) => (typeof value === 'string' ? value.trim() : value))
  @IsString()
  @MinLength(2, { message: 'Enter your full name' })
  @MaxLength(100)
  name?: string;

  /** The `key` from POST /uploads/url with kind AVATAR, or null to remove the photo. */
  @IsOptional()
  @ValidateIf((_o, value) => value !== null)
  @IsString()
  @MaxLength(300)
  avatarKey?: string | null;

  // --- Not editable here. Typed loosely on purpose: whatever is sent, the
  // --- answer is the specific refusal, not a type error.
  @IsOptional() email?: unknown;
  @IsOptional() mobile?: unknown;
  @IsOptional() rollNumber?: unknown;
  @IsOptional() department?: unknown;
  @IsOptional() yearOfStudy?: unknown;
}
