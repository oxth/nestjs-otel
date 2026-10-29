import { CreateQueueCommand, SQSClient } from '@aws-sdk/client-sqs';
import { Module } from '@nestjs/common';
import { SqsModule } from '@ssut/nestjs-sqs';
import type { MsSetup } from './ms.module.js';
import { OrdersSqsHandler } from './orders-sqs.handler.js';
import { SqsClientService } from './sqs-client.service.js';
import { SqsController } from './sqs.controller.js';

/**
 * A static module (so `SqsClientService` and `OrdersSqsHandler` are auto-traced) for `TRANSPORT=sqs`,
 * against the SQS-compatible endpoint `endpoint` (ElasticMQ). Creates the queue behind the `orders`
 * consumer and producer first.
 */
export async function createSqsMsModule(endpoint: string): Promise<MsSetup> {
  const region = 'us-east-1';
  const sqs = new SQSClient({ endpoint, region, credentials: { accessKeyId: 'test', secretAccessKey: 'test' } });
  // One queue per process: a killed app's pending long poll would otherwise take the next app's message.
  const { QueueUrl } = await sqs.send(new CreateQueueCommand({ QueueName: `orders-${process.pid}-${Date.now()}` }));
  // ElasticMQ answers with its own advertised host; reach the queue through the mapped endpoint instead.
  const queueUrl = new URL(new URL(QueueUrl!).pathname, endpoint).toString();

  @Module({
    imports: [
      SqsModule.register({
        consumers: [{ name: 'orders', queueUrl, region, sqs, waitTimeSeconds: 1 }],
        producers: [{ name: 'orders', queueUrl, region, sqs }],
      }),
    ],
    controllers: [SqsController],
    providers: [SqsClientService, OrdersSqsHandler],
  })
  class SqsMsModule {}
  return { module: SqsMsModule };
}
