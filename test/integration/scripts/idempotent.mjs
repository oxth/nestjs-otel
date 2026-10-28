import { readBootstrapConfig, startSdk, getSdkHandle } from '../.tmp/bootstrap/index.mjs';

const cfg = readBootstrapConfig(process.env);
const a = startSdk(cfg);
const b = startSdk(cfg);
console.log(JSON.stringify({ defined: a !== undefined, same: a === b, global: getSdkHandle() === a }));
await a.shutdown();
