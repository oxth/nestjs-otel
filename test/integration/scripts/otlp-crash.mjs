import '../../../dist/register.mjs';

const mode = process.argv[2];
console.log(JSON.stringify({ uncaught: process.listenerCount('uncaughtException'), rejection: process.listenerCount('unhandledRejection') }));
if (mode === 'user-listener') {
  process.on('uncaughtException', () => console.log('user handled'));
  setTimeout(() => console.log('still running'), 300);
  setTimeout(() => process.exit(0), 3000);
}
setTimeout(() => {
  if (mode === 'rejection') Promise.reject(new Error('kaboom'));
  else throw new Error('kaboom');
}, 50);
