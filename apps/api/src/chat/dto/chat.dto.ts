import { Transform, Type } from 'class-transformer';
import { IsInt, IsOptional, IsString, Matches, Max, MaxLength, Min, MinLength } from 'class-validator';

/** The longest message body, in characters. Text only in this release. */
export const MAX_CHAT_BODY_LENGTH = 2000;

/** The longest client message id. A UUID is 36. */
export const MAX_CLIENT_MESSAGE_ID_LENGTH = 64;

export class SendChatMessageDto {
  /**
   * Trimmed before it is measured: a message of spaces is not a message.
   * Plain text. It is stored and returned as given and never interpreted as
   * markup; rendering it safely is the client's job (NFR-S-07).
   */
  @Transform(({ value }) => (typeof value === 'string' ? value.trim() : value))
  @IsString()
  @MinLength(1, { message: 'Write something to send' })
  @MaxLength(MAX_CHAT_BODY_LENGTH)
  body!: string;

  /**
   * FR-CHAT-04: made up by the client, once per message, and sent again
   * unchanged on a retry. It is what lets a message queued offline and
   * re-sent on reconnection be stored once.
   */
  @IsString()
  @MinLength(8)
  @MaxLength(MAX_CLIENT_MESSAGE_ID_LENGTH)
  @Matches(/^[A-Za-z0-9_-]+$/, {
    message: 'clientMessageId may contain letters, digits, hyphens and underscores only',
  })
  clientMessageId!: string;
}

export class ChatHistoryQueryDto {
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(100)
  limit?: number = 50;

  /** The `nextCursor` of the previous page: return messages older than this one. */
  @IsOptional()
  @IsString()
  before?: string;
}
