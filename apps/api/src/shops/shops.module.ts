import { Module } from '@nestjs/common';
import {
  AdminCollegeController,
  AdminDeliveryPointsController,
  AdminShopsController,
  BrowseController,
  ShopsController,
} from './shops.controller';
import { ShopsService } from './shops.service';
import { CollegeAdminService } from './college-admin.service';

@Module({
  controllers: [
    ShopsController,
    BrowseController,
    AdminShopsController,
    AdminCollegeController,
    AdminDeliveryPointsController,
  ],
  providers: [ShopsService, CollegeAdminService],
  exports: [ShopsService],
})
export class ShopsModule {}
