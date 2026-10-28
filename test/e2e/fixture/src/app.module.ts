import { Module, type Type } from '@nestjs/common';
import { OtelModule } from '@oxth/nestjs-otel';
import { GuardedController } from './guarded.controller.js';
import { UsersController } from './users.controller.js';
import { UsersService } from './users.service.js';

@Module({
  imports: [OtelModule.forRoot()],
  controllers: [UsersController, GuardedController],
  providers: [UsersService],
})
export class AppModule {}

/**
 * The DB module selected by `DB` (typeorm-pg | typeorm-mysql | mikro-pg | mikro-mysql | mikro-mongo),
 * connected to `DATABASE_URL`. Without `DB` nothing is loaded: no ORM or driver package is required.
 */
export async function loadDbModule(): Promise<Type | undefined> {
  const db = process.env.DB;
  if (!db) return undefined;
  const url = process.env.DATABASE_URL;
  if (!url) throw new Error('DATABASE_URL is required with DB');
  if (db === 'typeorm-pg' || db === 'typeorm-mysql') {
    const { createTypeormDbModule } = await import('./db/typeorm.module.js');
    return createTypeormDbModule(db, url);
  }
  if (db === 'mikro-pg' || db === 'mikro-mysql' || db === 'mikro-mongo') {
    const { createMikroOrmDbModule } = await import('./db/mikro-orm.module.js');
    return createMikroOrmDbModule(db, url);
  }
  throw new Error(`unknown DB ${db}`);
}
