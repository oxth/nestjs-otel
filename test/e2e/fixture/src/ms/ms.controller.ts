import { Body, Controller, Get, HttpCode, Param, Post } from '@nestjs/common';
import { MsClientService } from './ms-client.service.js';
import type { MsUser } from './users-ms.controller.js';

@Controller('ms')
export class MsController {
  constructor(private readonly ms: MsClientService) {}

  @Get('users/:id')
  get(@Param('id') id: string): Promise<MsUser> {
    return this.ms.get(Number(id));
  }

  @Post('events')
  @HttpCode(202)
  async events(@Body() body: Record<string, unknown>): Promise<void> {
    await this.ms.created(body);
  }

  /** The handler always throws, so this answers 500. */
  @Post('fail')
  fail(@Body() body: Record<string, unknown>): Promise<unknown> {
    return this.ms.fail(body);
  }
}
