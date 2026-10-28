import { Injectable } from '@nestjs/common';

export interface CreateUserDto {
  name: string;
  password: string;
}

@Injectable()
export class UsersService {
  findOne(id: string): { id: string } {
    if (id === '500') throw new Error('db exploded', { cause: new Error('conn reset') });
    return { id };
  }

  create(dto: CreateUserDto): { id: string; name: string } {
    if (dto.name === 'fail') throw new Error('create failed');
    return { id: '1', name: dto.name };
  }
}
