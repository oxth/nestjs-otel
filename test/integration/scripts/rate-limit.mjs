import { trace } from '@opentelemetry/api';
import { readBootstrapConfig, startSdk } from '../.tmp/bootstrap/index.mjs';

const handle = startSdk(readBootstrapConfig(process.env));
const tracer = trace.getTracer('rate-limit-test');
const timer = setInterval(() => tracer.startSpan('work').end(), 10);
await new Promise((resolve) => setTimeout(resolve, 2000));
clearInterval(timer);
await handle.shutdown();
console.log('done');
