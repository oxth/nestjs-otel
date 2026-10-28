import '@oxth/nestjs-otel/register';

const { bootstrap } = await import('./bootstrap.js');
void bootstrap();
