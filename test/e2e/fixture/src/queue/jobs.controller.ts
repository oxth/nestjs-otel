import { Body, Controller, Get, Param, Post } from '@nestjs/common';
import { JobsService } from './jobs.service.js';

@Controller('jobs')
export class JobsController {
  constructor(private readonly jobs: JobsService) {}

  @Post()
  async enqueue(@Body() body: { to: string; password?: string; fail?: boolean }): Promise<{ id: string | undefined }> {
    return { id: await this.jobs.enqueue(body) };
  }

  @Get(':id')
  async state(@Param('id') id: string): Promise<{ state: string }> {
    return { state: await this.jobs.state(id) };
  }
}
