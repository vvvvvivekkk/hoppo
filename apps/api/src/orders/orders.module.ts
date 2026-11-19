import { Module } from '@nestjs/common';
import { OrdersController, ShopOrdersController } from './orders.controller';
import { OrdersService } from './orders.service';
import { DispatchModule } from '../dispatch/dispatch.module';

@Module({
  imports: [DispatchModule],
  controllers: [OrdersController, ShopOrdersController],
  providers: [OrdersService],
  exports: [OrdersService],
})
export class OrdersModule {}
