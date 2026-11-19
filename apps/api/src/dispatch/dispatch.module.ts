import { Module } from '@nestjs/common';
import { JwtModule } from '@nestjs/jwt';
import { DispatchService } from './dispatch.service';
import { DispatchGateway } from './dispatch.gateway';

@Module({
  imports: [JwtModule.register({})],
  providers: [DispatchService, DispatchGateway],
  exports: [DispatchService, DispatchGateway],
})
export class DispatchModule {}
