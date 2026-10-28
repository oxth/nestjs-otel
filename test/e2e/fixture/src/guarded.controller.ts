import { type CanActivate, Controller, Get, Injectable, UseGuards } from '@nestjs/common';

@Injectable()
export class ExplodingGuard implements CanActivate {
  canActivate(): boolean {
    throw new Error('guard broke');
  }
}

@Controller('guarded')
export class GuardedController {
  @Get()
  @UseGuards(ExplodingGuard)
  get(): { ok: true } {
    return { ok: true };
  }
}
