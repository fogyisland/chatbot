import { QueueService } from '../src/queue/queue.service';

describe('QueueService', () => {
  it('enqueue uses msgId as jobId for idempotency', async () => {
    const added: any[] = [];
    const fakeQueue: any = {
      add: async (name: string, data: any, opts: any) => {
        added.push({ name, data, opts });
        return { id: opts.jobId };
      },
    };
    const svc = new QueueService(fakeQueue);
    await svc.enqueueMessage({ msgId: 'm1', platform: 'wechat', chatId: 'c1', chatType: 'group', senderId: 'u1', senderName: 'A', text: 'hi', mentions: [], attachments: [], rawTimestamp: 0 });
    expect(added[0].opts.jobId).toBe('m1');
  });
});
