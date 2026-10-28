import { Body, Controller, Get, NotFoundException, Param, Post } from '@nestjs/common';
import { type CreateUserDto, UsersService } from './users.service.js';

@Controller('users')
export class UsersController {
  constructor(private readonly users: UsersService) {}

  @Get(':id')
  findOne(@Param('id') id: string): { id: string } {
    if (id === '404') throw new NotFoundException(`user ${id} not found`);
    return this.users.findOne(id);
  }

  @Post()
  create(@Body() body: CreateUserDto): { id: string; name: string } {
    return this.users.create(body);
  }
}
