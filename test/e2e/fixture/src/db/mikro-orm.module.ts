import { EntityManager, MikroORM } from '@mikro-orm/core';
import { MikroOrmModule } from '@mikro-orm/nestjs';
import { Module, type Type } from '@nestjs/common';
import { MikroMongoUser, MikroUser, type User } from './entities.js';
import { UsersDbController } from './users-db.controller.js';
import { USERS_STORE, UsersDbService, type UsersStore } from './users-db.service.js';

export type MikroDb = 'mikro-pg' | 'mikro-mysql' | 'mikro-mongo';

/** Only the selected driver package is loaded. */
async function loadDriver(db: MikroDb): Promise<any> {
  if (db === 'mikro-pg') return (await import('@mikro-orm/postgresql')).PostgreSqlDriver;
  if (db === 'mikro-mysql') return (await import('@mikro-orm/mysql')).MySqlDriver;
  return (await import('@mikro-orm/mongodb')).MongoDriver;
}

/**
 * A static module (so `UsersDbService` is auto-traced) for `DB=mikro-pg|mikro-mysql|mikro-mongo`. The
 * em is the request-scoped one from @mikro-orm/nestjs' RequestContext middleware.
 */
export async function createMikroOrmDbModule(db: MikroDb, url: string): Promise<Type> {
  const driver = await loadDriver(db);
  const User = db === 'mikro-mongo' ? MikroMongoUser : MikroUser;

  @Module({
    imports: [MikroOrmModule.forRoot({ driver, clientUrl: url, entities: [User] })],
    controllers: [UsersDbController],
    providers: [
      UsersDbService,
      {
        provide: USERS_STORE,
        inject: [MikroORM, EntityManager],
        useFactory: async (orm: MikroORM, em: EntityManager): Promise<UsersStore> => {
          // Drop and recreate the schema (and Mongo's indexes): `refresh` in v7, `refreshDatabase` in v6.
          const schema: any = orm.schema;
          await (schema.refresh ?? schema.refreshDatabase).call(schema);
          return {
            findOne: (id) => em.findOne<User>(User, { id }),
            create: (dto) => em.insert<User>(User, { ...dto }),
            insert: (dto) => em.insert<User>(User, { ...dto }),
          };
        },
      },
    ],
  })
  class MikroOrmDbModule {}
  return MikroOrmDbModule;
}
