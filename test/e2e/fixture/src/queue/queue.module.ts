import { BullModule } from '@nestjs/bullmq';
import { Module, type Type } from '@nestjs/common';
import { EmailsProcessor } from './emails.processor.js';
import { JobsController } from './jobs.controller.js';
import { JobsService } from './jobs.service.js';

/** A static module (so `JobsService` and `EmailsProcessor` are auto-traced) for `QUEUE=bullmq`. */
export function createQueueModule(url: string): Type {
  @Module({
    imports: [BullModule.forRoot({ connection: { url } }), BullModule.registerQueue({ name: 'emails' })],
    controllers: [JobsController],
    providers: [JobsService, EmailsProcessor],
  })
  class QueueModule {}
  return QueueModule;
}
