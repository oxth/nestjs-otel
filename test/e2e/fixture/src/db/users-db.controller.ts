import { Body, Controller, Get, Param, Post } from '@nestjs/common';
import { type CreateDbUserDto, UsersDbService } from './users-db.service.js';

@Controller('db/users')
export class UsersDbController {
  constructor(private readonly users: UsersDbService) {}

  @Post('dup')
  async dup(@Body() body: CreateDbUserDto): Promise<void> {
    await this.users.dup(body);
  }

  @Get(':id')
  findOne(@Param('id') id: string): Promise<unknown> {
    return this.users.findOne(Number(id));
  }

  @Post()
  create(@Body() body: CreateDbUserDto): Promise<unknown> {
    return this.users.create(body);
  }
}
