import { readBootstrapConfig, startSdk } from '../.tmp/bootstrap/index.mjs';

startSdk(readBootstrapConfig(process.env));
setInterval(() => {}, 1000);
console.log('ready');
