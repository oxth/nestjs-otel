import { Inject, Injectable, type OnModuleInit } from '@nestjs/common';
import type { ClientProxy } from '@nestjs/microservices';
import { firstValueFrom } from 'rxjs';
import type { MsUser } from './users-ms.controller.js';

export const MS_CLIENT = 'MS_CLIENT';

/** Request-reply topics: a Kafka client must subscribe to their `.reply` topics before it connects. */
export const KAFKA_REQUEST_TOPICS = ['users.get', 'users.fail', 'ms.ping'];

/** The client side of the hybrid app: a `ClientProxy` pointed at this app's own microservice. */
@Injectable()
export class MsClientService implements OnModuleInit {
  constructor(@Inject(MS_CLIENT) private readonly client: ClientProxy) {}

  /** The client connects on first use: the app's own microservice only listens after init. */
  onModuleInit(): void {
    const kafka = this.client as ClientProxy & { subscribeToResponseOf?(pattern: string): void };
    if (typeof kafka.subscribeToResponseOf === 'function') {
      for (const topic of KAFKA_REQUEST_TOPICS) kafka.subscribeToResponseOf(topic);
    }
  }

  get(id: number): Promise<MsUser> {
    return firstValueFrom(this.client.send<MsUser>('users.get', { id }));
  }

  async created(body: Record<string, unknown>): Promise<void> {
    await firstValueFrom(this.client.emit('user.created', body), { defaultValue: undefined });
  }

  fail(body: Record<string, unknown>): Promise<unknown> {
    return firstValueFrom(this.client.send('users.fail', body));
  }
}
