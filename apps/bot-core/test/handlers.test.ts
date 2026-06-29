import { Handler, HandlerContext, HandlerRegistry } from '../src/handlers/handler.interface';
import { RouteDecision, NormalizedReply } from '@mpcb/shared';

class StubHandler implements Handler {
  readonly name = 'stub';
  async handle(): Promise<NormalizedReply> { return { text: 'stub-out' }; }
}

describe('HandlerRegistry', () => {
  it('registers and retrieves handler by name', () => {
    const reg = new HandlerRegistry();
    const h = new StubHandler();
    reg.register(h);
    expect(reg.get('stub')).toBe(h);
  });

  it('returns undefined for unknown handler', () => {
    expect(new HandlerRegistry().get('nope')).toBeUndefined();
  });
});