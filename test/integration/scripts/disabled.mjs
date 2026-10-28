import { readBootstrapConfig, startSdk, getSdkHandle } from '../.tmp/bootstrap/index.mjs';

const handle = startSdk(readBootstrapConfig(process.env));
console.log(JSON.stringify({ handle: handle === undefined, global: getSdkHandle() === undefined }));
