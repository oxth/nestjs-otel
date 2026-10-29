import { Body, Controller, HttpCode, Post } from '@nestjs/common';
import { SqsClientService } from './sqs-client.service.js';

@Controller('ms')
export class SqsController {
  constructor(private readonly sqs: SqsClientService) {}

  @Post('events')
  @HttpCode(202)
  events(@Body() body: Record<string, unknown>): Promise<void> {
    return this.sqs.created(body);
  }

  /** Accepted: the handler fails later, on the consumer side. */
  @Post('fail')
  @HttpCode(202)
  fail(@Body() body: Record<string, unknown>): Promise<void> {
    return this.sqs.fail(body);
  }
}
