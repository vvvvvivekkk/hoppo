import { Body, Controller, Get, Param, Post, Query } from '@nestjs/common';
import { ApiOperation, ApiTags } from '@nestjs/swagger';
import { Throttle } from '@nestjs/throttler';
import { CurrentUser } from '../common/decorators/current-user.decorator';
import { RequireVerified } from '../common/decorators/require-verified.decorator';
import { Roles } from '../common/decorators/roles.decorator';
import type { AuthenticatedUser } from '../common/types/authenticated-user';
import { ChatService } from './chat.service';
import { ChatHistoryQueryDto, SendChatMessageDto } from './dto/chat.dto';

/**
 * Chat on a delivery, over REST (screens S-19, S-28, S-30): history, and a
 * send for when the socket is down or a client would rather not use it.
 *
 * The two parties are both students — the one who placed the order and the
 * one delivering it — so the controller is `@Roles('STUDENT')`, with
 * verification as everywhere else a student acts. That is only the outer
 * door: which student, on which task, is ChatService's question, asked of
 * the database on every call.
 *
 * A conversation is named by its task (the rider's screens know the task)
 * or by its order (the student's screens know the order). Both lead to the
 * same room.
 */
@ApiTags('chat')
@Controller('chat')
@Roles('STUDENT')
@RequireVerified()
export class ChatController {
  constructor(private readonly chat: ChatService) {}

  @Get('tasks/:taskId/messages')
  @ApiOperation({ summary: 'The chat on a delivery, newest first, with who is in it' })
  taskHistory(
    @CurrentUser() user: AuthenticatedUser,
    @Param('taskId') taskId: string,
    @Query() query: ChatHistoryQueryDto,
  ) {
    return this.chat.history(user, taskId, query.limit, query.before);
  }

  /** Sixty a minute is a fast typist; it is not a flood. Per user. */
  @Throttle({ default: { limit: 60, ttl: 60_000 } })
  @Post('tasks/:taskId/messages')
  @ApiOperation({ summary: 'Send a message on a delivery in progress' })
  sendToTask(
    @CurrentUser() user: AuthenticatedUser,
    @Param('taskId') taskId: string,
    @Body() dto: SendChatMessageDto,
  ) {
    return this.chat.send(user, taskId, dto);
  }

  @Get('orders/:orderId/messages')
  @ApiOperation({ summary: 'The chat on an order\'s delivery, newest first' })
  async orderHistory(
    @CurrentUser() user: AuthenticatedUser,
    @Param('orderId') orderId: string,
    @Query() query: ChatHistoryQueryDto,
  ) {
    const taskId = await this.chat.taskIdForOrder(user, orderId);
    return this.chat.history(user, taskId, query.limit, query.before);
  }

  @Throttle({ default: { limit: 60, ttl: 60_000 } })
  @Post('orders/:orderId/messages')
  @ApiOperation({ summary: 'Send a message on an order\'s delivery' })
  async sendToOrder(
    @CurrentUser() user: AuthenticatedUser,
    @Param('orderId') orderId: string,
    @Body() dto: SendChatMessageDto,
  ) {
    const taskId = await this.chat.taskIdForOrder(user, orderId);
    return this.chat.send(user, taskId, dto);
  }
}
