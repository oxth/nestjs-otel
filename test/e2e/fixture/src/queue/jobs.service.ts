import { InjectQueue } from '@nestjs/bullmq';
import { Injectable } from '@nestjs/common';
import type { Queue } from 'bullmq';

@Injectable()
export class JobsService {
  constructor(@InjectQueue('emails') private readonly queue: Queue) {}

  async enqueue(body: { to: string; password?: string; fail?: boolean }): Promise<string | undefined> {
    const job = await this.queue.add('send', body, { attempts: 1 });
    return job.id;
  }

  async state(id: string): Promise<string> {
    const job = await this.queue.getJob(id);
    return job ? await job.getState() : 'missing';
  }
}
