import { Module } from '@nestjs/common';
import { GuardedController } from './guarded.controller.js';
import { UsersController } from './users.controller.js';
import { UsersService } from './users.service.js';

@Module({
  controllers: [UsersController, GuardedController],
  providers: [UsersService],
})
export class AppModule {}
