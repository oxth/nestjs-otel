// Nest app with enableShutdownHooks whose onApplicationShutdown hook emits telemetry while
// Nest is still draining. WITH_MODULE=1 also imports OtelModule (from the built package: it shares
// the SDK started here through globalThis state, like an app loading both register and index).
import 'reflect-metadata';
import { readBootstrapConfig, startSdk } from '../.tmp/bootstrap/index.mjs';

startSdk(readBootstrapConfig(process.env));

const { logs, trace } = await import('@opentelemetry/api');
const { Injectable, Module } = await import('@nestjs/common');
const { NestFactory } = await import('@nestjs/core');
const { OtelModule } = await import('../../../dist/index.mjs');

class HookService {
  async onApplicationShutdown() {
    await new Promise((r) => setTimeout(r, 300));
    trace.getTracer('test').startSpan('shutdown-hook-span').end();
    logs.getLogger('test').emit({ body: 'shutdown-hook-log' });
    console.log('hook');
  }
}
Injectable()(HookService);

class AppModule {}
Module({ imports: process.env.WITH_MODULE === '1' ? [OtelModule.forRoot()] : [], providers: [HookService] })(AppModule);

const app = await NestFactory.createApplicationContext(AppModule, { logger: false });
app.enableShutdownHooks();
setInterval(() => {}, 1000);
console.log('ready');
