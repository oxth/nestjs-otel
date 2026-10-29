import { Controller } from '@nestjs/common';
import { EventPattern, MessagePattern, Payload, RpcException } from '@nestjs/microservices';

export interface MsUser {
  id: number;
  name: string;
}

/** The microservice side of the hybrid app: handlers for what `MsClientService` sends to itself. */
@Controller()
export class UsersMsController {
  @MessagePattern('users.get')
  get(@Payload() data: { id: number }): MsUser {
    return { id: Number(data.id), name: `user-${data.id}` };
  }

  @MessagePattern('users.fail')
  fail(@Payload() _data: { password?: string }): never {
    throw new RpcException('users.fail rejected');
  }

  @EventPattern('user.created')
  created(@Payload() _data: { password?: string }): void {}

  /** Used by the Kafka start-up check (see `kafkaReady`), never by the tests. */
  @MessagePattern('ms.ping')
  ping(): string {
    return 'pong';
  }
}
