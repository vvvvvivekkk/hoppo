import { Module } from '@nestjs/common';
import { RiderController, TasksController } from './rider.controller';
import { RiderService } from './rider.service';
import { DispatchModule } from '../dispatch/dispatch.module';

@Module({
  imports: [DispatchModule],
  controllers: [RiderController, TasksController],
  providers: [RiderService],
  exports: [RiderService],
})
export class RiderModule {}
