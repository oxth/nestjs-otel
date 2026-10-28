import { Body, Controller, Get, Logger, NotFoundException, Param, Post } from '@nestjs/common';
import { type CreateUserDto, UsersService } from './users.service.js';

@Controller('users')
export class UsersController {
  private readonly logger = new Logger(UsersController.name);

  constructor(private readonly users: UsersService) {}

  @Get(':id')
  findOne(@Param('id') id: string): { id: string } {
    this.logger.log('fetching user');
    if (id === '404') throw new NotFoundException(`user ${id} not found`);
    return this.users.findOne(id);
  }

  @Post()
  create(@Body() body: CreateUserDto): { id: string; name: string } {
    return this.users.create(body);
  }
}
