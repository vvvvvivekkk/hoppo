import * as shared from './index';

describe('constants shared with the API', () => {
  it('exports the per-line cart cap from the package entry point', () => {
    // apps/api/src/orders/dto/orders.dto.ts validates quantity with @Max of this.
    expect(shared.MAX_CART_ITEM_QUANTITY).toBe(20);
  });

  it('builds the offered-riders key exactly as the dispatcher does', () => {
    expect(shared.redisKeys.offeredRiders('task-1')).toBe('dispatch:offered:task-1');
  });

  it('gives every per-task key its own namespace', () => {
    expect(shared.redisKeys.offeredRiders('t')).not.toBe(shared.redisKeys.dispatchLock('t'));
  });
});
