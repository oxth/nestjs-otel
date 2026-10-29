import { Injectable } from '@nestjs/common';
import { SqsService } from '@ssut/nestjs-sqs';
import { randomUUID } from 'node:crypto';

@Injectable()
export class SqsClientService {
  constructor(private readonly sqs: SqsService) {}

  async created(body: Record<string, unknown>): Promise<void> {
    await this.sqs.send('orders', { id: randomUUID(), body });
  }

  async fail(body: Record<string, unknown>): Promise<void> {
    await this.sqs.send('orders', { id: randomUUID(), body: { ...body, fail: true } });
  }
}
