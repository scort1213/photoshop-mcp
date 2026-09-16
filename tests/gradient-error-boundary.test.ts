import { expect, it, vi } from 'vitest';
import { createMaskTools } from '../src/tools/mask-tools.js';
import type { PhotoshopConnection } from '../src/platform/connection.js';
const mock = vi.hoisted(() => ({ execute: vi.fn() }));
vi.mock('../src/api/photoshop-api.js', () => ({
  PhotoshopAPIFactory: class { async createAPI() { return { executeScript: mock.execute }; } },
}));

it.each([
  { ok: false, code: 'partial_completion', message: 'mask changed but painting failed' },
  { applied: false },
  {},
])('does not report gradient success for an unconfirmed result %j', async payload => {
  mock.execute.mockResolvedValue(payload);
  const tool = createMaskTools({} as PhotoshopConnection).find(x => x.tool.name === 'photoshop_apply_gradient_mask')!;
  const result = await tool.handler({});
  expect(result.isError).toBe(true);
  expect(JSON.stringify(result)).toContain('partial_completion');
});

it.each(['90', null, NaN, Infinity])('rejects invalid angle %s before executing', async angle => {
  mock.execute.mockClear();
  const tool = createMaskTools({} as PhotoshopConnection).find(x => x.tool.name === 'photoshop_apply_gradient_mask')!;
  const result = await tool.handler({ angle_deg: angle });
  expect(result.isError).toBe(true);
  expect(JSON.stringify(result)).toContain('invalid_arguments');
  expect(mock.execute).not.toHaveBeenCalled();
});
