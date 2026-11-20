import { Module } from '@nestjs/common';
import { DispatchModule } from '../dispatch/dispatch.module';
import { ChatController } from './chat.controller';
import { ChatGateway } from './chat.gateway';
import { ChatService } from './chat.service';

/**
 * Chat on a delivery (FR-DLV-10, FR-CHAT-04, FR-CHAT-08).
 *
 * DispatchModule for the real-time gateway that carries messages out; it
 * imports nothing from here, so there is no cycle. PrismaService and
 * TenantService come from global modules.
 */
@Module({
  imports: [DispatchModule],
  controllers: [ChatController],
  providers: [ChatService, ChatGateway],
  exports: [ChatService],
})
export class ChatModule {}
