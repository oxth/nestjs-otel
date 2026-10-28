import { Module } from '@nestjs/common';
import { OtelModule } from '@oxth/nestjs-otel';
import { GuardedController } from './guarded.controller.js';
import { UsersController } from './users.controller.js';
import { UsersService } from './users.service.js';

@Module({
  imports: [OtelModule.forRoot()],
  controllers: [UsersController, GuardedController],
  providers: [UsersService],
})
export class AppModule {}
