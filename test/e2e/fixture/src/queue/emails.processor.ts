import { Processor, WorkerHost } from '@nestjs/bullmq';
import type { Job } from 'bullmq';

@Processor('emails')
export class EmailsProcessor extends WorkerHost {
  async process(job: Job<{ to: string; password?: string; fail?: boolean }>): Promise<{ token: string }> {
    if (job.data.fail) throw new Error('smtp down');
    return { token: 'tok-SECRET' };
  }
}
