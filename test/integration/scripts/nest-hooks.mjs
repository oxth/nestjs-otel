import 'reflect-metadata';
import { readBootstrapConfig, startSdk } from '../.tmp/bootstrap/index.mjs';

startSdk(readBootstrapConfig(process.env));

const { Injectable, Module } = await import('@nestjs/common');
const { NestFactory } = await import('@nestjs/core');

class HookService {
  onApplicationShutdown() {
    console.log('hook');
  }
}
Injectable()(HookService);

class AppModule {}
Module({ providers: [HookService] })(AppModule);

const app = await NestFactory.createApplicationContext(AppModule, { logger: false });
app.enableShutdownHooks();
setInterval(() => {}, 1000);
console.log('ready');
