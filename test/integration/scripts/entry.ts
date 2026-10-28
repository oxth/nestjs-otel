// Test-only bundle entry: exposes bootstrap internals to the spawned scripts.
export { readBootstrapConfig } from '../../../src/bootstrap/config';
export { startSdk, getSdkHandle } from '../../../src/bootstrap/sdk';
