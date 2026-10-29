import { Module, type Type } from '@nestjs/common';
import { OtelModule } from '@oxth/nestjs-otel';
import { GuardedController } from './guarded.controller.js';
import { UsersController } from './users.controller.js';
import { UsersService } from './users.service.js';

@Module({
  imports: [OtelModule.forRoot()],
  controllers: [UsersController, GuardedController],
  providers: [UsersService],
})
export class AppModule {}

/**
 * The DB module selected by `DB` (typeorm-pg | typeorm-mysql | mikro-pg | mikro-mysql | mikro-mongo),
 * connected to `DATABASE_URL`. Without `DB` nothing is loaded: no ORM or driver package is required.
 */
export async function loadDbModule(): Promise<Type | undefined> {
  const db = process.env.DB;
  if (!db) return undefined;
  const url = process.env.DATABASE_URL;
  if (!url) throw new Error('DATABASE_URL is required with DB');
  if (db === 'typeorm-pg' || db === 'typeorm-mysql') {
    const { createTypeormDbModule } = await import('./db/typeorm.module.js');
    return createTypeormDbModule(db, url);
  }
  if (db === 'mikro-pg' || db === 'mikro-mysql' || db === 'mikro-mongo') {
    const { createMikroOrmDbModule } = await import('./db/mikro-orm.module.js');
    return createMikroOrmDbModule(db, url);
  }
  throw new Error(`unknown DB ${db}`);
}

/**
 * The queue module selected by `QUEUE` (bullmq), connected to `REDIS_URL`. Without `QUEUE` nothing is
 * loaded: no queue package is required.
 */
export async function loadQueueModule(): Promise<Type | undefined> {
  const queue = process.env.QUEUE;
  if (!queue) return undefined;
  const url = process.env.REDIS_URL;
  if (!url) throw new Error('REDIS_URL is required with QUEUE');
  if (queue === 'bullmq') {
    const { createQueueModule } = await import('./queue/queue.module.js');
    return createQueueModule(url);
  }
  throw new Error(`unknown QUEUE ${queue}`);
}

/**
 * The hybrid microservice setup selected by `TRANSPORT` (tcp | redis | kafka | rmq | sqs), connected to
 * `REDIS_URL`, `KAFKA_BROKERS`, `AMQP_URL` or `SQS_ENDPOINT`. Without `TRANSPORT` nothing is loaded: no
 * transport package is required.
 */
export async function loadMsModule(): Promise<import('./ms/ms.module.js').MsSetup | undefined> {
  const transport = process.env.TRANSPORT;
  if (!transport) return undefined;
  if (transport === 'sqs') {
    const endpoint = process.env.SQS_ENDPOINT;
    if (!endpoint) throw new Error('SQS_ENDPOINT is required with TRANSPORT=sqs');
    const { createSqsMsModule } = await import('./ms/sqs.module.js');
    return createSqsMsModule(endpoint);
  }
  if (transport === 'tcp' || transport === 'redis' || transport === 'kafka' || transport === 'rmq') {
    const { createMsModule } = await import('./ms/ms.module.js');
    return createMsModule(transport);
  }
  throw new Error(`unknown TRANSPORT ${transport}`);
}
