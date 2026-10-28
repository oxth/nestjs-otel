import { Module, type Type } from '@nestjs/common';
import { getRepositoryToken, TypeOrmModule } from '@nestjs/typeorm';
import type { Repository } from 'typeorm';
import { TypeormUser, type User } from './entities.js';
import { UsersDbController } from './users-db.controller.js';
import { USERS_STORE, UsersDbService, type UsersStore } from './users-db.service.js';

const TYPES = { 'typeorm-pg': 'postgres', 'typeorm-mysql': 'mysql' } as const;

/** A static module (so `UsersDbService` is auto-traced) for `DB=typeorm-pg|typeorm-mysql`. */
export function createTypeormDbModule(db: keyof typeof TYPES, url: string): Type {
  @Module({
    imports: [
      TypeOrmModule.forRoot({ type: TYPES[db], url, entities: [TypeormUser], dropSchema: true, synchronize: true }),
      TypeOrmModule.forFeature([TypeormUser]),
    ],
    controllers: [UsersDbController],
    providers: [
      UsersDbService,
      {
        provide: USERS_STORE,
        inject: [getRepositoryToken(TypeormUser)],
        useFactory: (repo: Repository<User>): UsersStore => ({
          findOne: (id) => repo.findOne({ where: { id } }),
          create: (dto) => repo.save({ ...dto }),
          insert: (dto) => repo.insert(dto),
        }),
      },
    ],
  })
  class TypeormDbModule {}
  return TypeormDbModule;
}
