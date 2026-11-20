import { Module } from '@nestjs/common';
import { RiderController, TasksController } from './rider.controller';
import { RiderService } from './rider.service';
import { EscalationsController } from './escalations.controller';
import { EscalationsService } from './escalations.service';
import { RiderPresenceController } from './presence.controller';
import { RiderPresenceService } from './presence.service';
import { DispatchModule } from '../dispatch/dispatch.module';
import { OrdersModule } from '../orders/orders.module';

@Module({
  // OrdersModule for the administrator's refund (FR-ADM-04): cancelling an
  // order and releasing its hold is the orders module's code to run. It
  // imports DispatchModule and nothing from here, so there is no cycle.
  imports: [DispatchModule, OrdersModule],
  controllers: [RiderController, TasksController, EscalationsController, RiderPresenceController],
  providers: [RiderService, EscalationsService, RiderPresenceService],
  exports: [RiderService],
})
export class RiderModule {}
