import { expect, it, vi } from 'vitest';
import { Logger } from '../src/utils/logger.js';

it('retains the cause of startup failures on stderr without writing protocol stdout', () => {
  const stderr = vi.spyOn(process.stderr, 'write').mockReturnValue(true);
  const stdout = vi.spyOn(process.stdout, 'write').mockReturnValue(true);
  try {
    new Logger('startup').error('Initialization failed', new Error('missing runtime path'));
    expect(String(stderr.mock.calls[0][0])).toContain('missing runtime path');
    expect(String(stderr.mock.calls[0][0])).toContain('stack');
    expect(stdout).not.toHaveBeenCalled();
  } finally { stderr.mockRestore(); stdout.mockRestore(); }
});
