import { Transform, Type } from 'class-transformer';
import { IsIn, IsInt, IsOptional, IsString, Max, MaxLength, Min, MinLength } from 'class-validator';

/** How an administrator closes an escalated task (FR-ADM-04). */
export const ESCALATION_OUTCOMES = ['DELIVERED', 'NOT_DELIVERED'] as const;
export type EscalationOutcome = (typeof ESCALATION_OUTCOMES)[number];

export class EscalationQueueQueryDto {
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(100)
  limit?: number = 25;

  /** The `nextCursor` of the previous page. */
  @IsOptional()
  @IsString()
  cursor?: string;
}

export class ResolveEscalationDto {
  @IsIn(ESCALATION_OUTCOMES, { message: 'outcome must be DELIVERED or NOT_DELIVERED' })
  outcome!: EscalationOutcome;

  /**
   * FR-ADM-04: "with a mandatory note". Trimmed before it is measured, so a
   * row of spaces is not a note; ten characters because a resolution moves
   * money and "ok" explains nothing to whoever reads the audit log later.
   */
  @Transform(({ value }) => (typeof value === 'string' ? value.trim() : value))
  @IsString()
  @MinLength(10, { message: 'Say what you established — at least 10 characters' })
  @MaxLength(500)
  note!: string;
}
