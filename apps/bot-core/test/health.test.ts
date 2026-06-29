import { Test } from '@nestjs/testing';
import { HealthController } from '../src/webhook/health.controller';

describe('HealthController', () => {
  let controller: HealthController;

  beforeEach(async () => {
    const module = await Test.createTestingModule({
      controllers: [HealthController],
    }).compile();
    controller = module.get(HealthController);
  });

  it('GET /health returns ok', () => {
    expect(controller.health()).toEqual({ status: 'ok' });
  });

  it('GET /ready returns ready', () => {
    expect(controller.ready()).toEqual({ status: 'ready' });
  });
});