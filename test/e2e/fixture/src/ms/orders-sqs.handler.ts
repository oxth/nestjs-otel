import type { Message } from '@aws-sdk/client-sqs';
import { Injectable } from '@nestjs/common';
import { SqsMessageHandler } from '@ssut/nestjs-sqs';

@Injectable()
export class OrdersSqsHandler {
  @SqsMessageHandler('orders')
  async handle(message: Message): Promise<void> {
    const body = JSON.parse(message.Body ?? '{}') as { fail?: boolean };
    if (body.fail) throw new Error('order rejected');
  }
}
