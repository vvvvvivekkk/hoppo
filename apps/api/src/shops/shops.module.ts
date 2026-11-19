import { Module } from '@nestjs/common';
import {
  AdminCollegeController,
  AdminShopsController,
  BrowseController,
  ShopsController,
} from './shops.controller';
import { ShopsService } from './shops.service';

@Module({
  controllers: [
    ShopsController,
    BrowseController,
    AdminShopsController,
    AdminCollegeController,
  ],
  providers: [ShopsService],
  exports: [ShopsService],
})
export class ShopsModule {}
