import { Module } from '@nestjs/common';
import { OrdersController, ShopOrdersController } from './orders.controller';
import { OrdersService } from './orders.service';
import { AdminOrdersController } from './admin-orders.controller';
import { AdminOrdersService } from './admin-orders.service';
import { ShopSettlementsController } from './shop-settlements.controller';
import { ShopSettlementsService } from './shop-settlements.service';
import { DispatchModule } from '../dispatch/dispatch.module';
import { WalletController } from '../wallet/wallet.controller';
import { WalletStatementService } from '../wallet/wallet-statement.service';

@Module({
  imports: [DispatchModule],
  controllers: [
    OrdersController,
    ShopOrdersController,
    AdminOrdersController,
    ShopSettlementsController,
    // The wallet's read-only routes live in src/wallet but are registered
    // here: OrdersModule is already wired into the application, and the
    // wallet has no module of its own to import.
    WalletController,
  ],
  providers: [OrdersService, AdminOrdersService, ShopSettlementsService, WalletStatementService],
  exports: [OrdersService],
})
export class OrdersModule {}
