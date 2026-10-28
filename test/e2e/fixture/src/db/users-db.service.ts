import { Inject, Injectable } from '@nestjs/common';

export interface CreateDbUserDto {
  id?: number;
  email: string;
  password: string;
}

/**
 * ORM-specific data access, provided by each DB module as a factory value (not a class), so the only
 * auto-traced span between the controller and the ORM is `UsersDbService.*`.
 */
export interface UsersStore {
  findOne(id: number): Promise<unknown>;
  /** Repository `save` / em `insert`. */
  create(dto: CreateDbUserDto): Promise<unknown>;
  /** A plain insert. */
  insert(dto: CreateDbUserDto): Promise<unknown>;
}

export const USERS_STORE = Symbol('USERS_STORE');

@Injectable()
export class UsersDbService {
  private nextId = 1_000;

  constructor(@Inject(USERS_STORE) private readonly store: UsersStore) {}

  async findOne(id: number): Promise<unknown> {
    return (await this.store.findOne(id)) ?? null;
  }

  async create(dto: CreateDbUserDto): Promise<unknown> {
    return this.store.create({ id: this.nextId++, ...dto });
  }

  /** Inserts the same id twice: the second insert fails with a unique violation. */
  async dup(dto: CreateDbUserDto): Promise<void> {
    await this.store.insert(dto);
    await this.store.insert(dto);
  }
}
