import { readBootstrapConfig, startSdk } from '../.tmp/bootstrap/index.mjs';

startSdk(readBootstrapConfig(process.env));
process.on('SIGTERM', () => {
  console.log('user');
  setTimeout(() => process.exit(0), 300);
});
setInterval(() => {}, 1000);
console.log('ready');
