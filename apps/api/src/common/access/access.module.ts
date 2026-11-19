import { Global, Module } from '@nestjs/common';
import { ShopAccessService } from './shop-access.service';

/**
 * Global for the same reason TenantModule is: the answer to "is this shop
 * account approved?" is needed by authentication and by the socket layer, and
 * there must be exactly one implementation of it.
 */
@Global()
@Module({
  providers: [ShopAccessService],
  exports: [ShopAccessService],
})
export class AccessModule {}
