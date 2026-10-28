import 'reflect-metadata';
import { type DynamicModule, type INestApplication, Module } from '@nestjs/common';
import { NestFactory } from '@nestjs/core';
import { OtelLogger } from '@oxth/nestjs-otel';
import type { AddressInfo } from 'node:net';
import { AppModule } from './app.module.js';

@Module({})
class RootModule {}

/**
 * Starts the fixture app. `ADAPTER` = express | fastify. `LOGGER` = nest (OtelLogger) | pino (nestjs-pino);
 * unset keeps Nest's default logger. `PORT` defaults to 0 (any free port).
 */
export async function bootstrap(): Promise<INestApplication> {
  const adapterName = process.env.ADAPTER ?? 'express';
  const loggerName = process.env.LOGGER;

  const imports: DynamicModule['imports'] = [AppModule];
  if (loggerName === 'pino') {
    const { LoggerModule } = await import('nestjs-pino');
    imports.push(LoggerModule.forRoot());
  }
  const root: DynamicModule = { module: RootModule, imports };

  let app: INestApplication;
  if (adapterName === 'fastify') {
    const { FastifyAdapter } = await import('@nestjs/platform-fastify');
    app = await NestFactory.create(root, new FastifyAdapter(), { bufferLogs: loggerName !== undefined });
  } else {
    const { ExpressAdapter } = await import('@nestjs/platform-express');
    app = await NestFactory.create(root, new ExpressAdapter(), { bufferLogs: loggerName !== undefined });
  }
  if (loggerName === 'pino') {
    const { Logger } = await import('nestjs-pino');
    app.useLogger(app.get(Logger));
  } else if (loggerName === 'nest') {
    app.useLogger(app.get(OtelLogger));
  }

  await app.listen(Number(process.env.PORT ?? 0), '127.0.0.1');
  const { port } = app.getHttpServer().address() as AddressInfo;
  process.stdout.write(`listening:${port}\n`);
  return app;
}
