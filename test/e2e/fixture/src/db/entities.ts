import { EntitySchema as MikroEntitySchema } from '@mikro-orm/core';
import { EntitySchema as TypeormEntitySchema } from 'typeorm';

export interface User {
  id: number;
  email: string;
  password: string;
}

/**
 * TypeORM: table `users`. Ids are assigned by `UsersDbService` (on Postgres, TypeORM drops an explicit id
 * of a generated column, so the duplicate insert would not conflict).
 */
export const TypeormUser = new TypeormEntitySchema<User>({
  name: 'User',
  tableName: 'users',
  columns: {
    id: { type: Number, primary: true },
    email: { type: String },
    password: { type: String },
  },
});

/** MikroORM on SQL: table `users`. */
export const MikroUser = new MikroEntitySchema<User>({
  name: 'User',
  tableName: 'users',
  properties: {
    id: { type: 'number', primary: true, autoincrement: false },
    email: { type: 'string' },
    password: { type: 'string' },
  },
});

/** MikroORM on Mongo: collection `users`; the numeric id is stored as `_id` (Mongo's only primary key). */
export const MikroMongoUser = new MikroEntitySchema<User>({
  name: 'User',
  collection: 'users',
  properties: {
    id: { type: 'number', primary: true, fieldName: '_id' },
    email: { type: 'string' },
    password: { type: 'string' },
  },
});
