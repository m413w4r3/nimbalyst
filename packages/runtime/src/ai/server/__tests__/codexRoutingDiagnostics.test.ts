// @vitest-environment node
import { afterEach, describe, expect, it, vi } from 'vitest';
import { logCodexRoute } from '../codexRoutingDiagnostics';

describe('Codex routing diagnostics', () => {
  const originalFlag = process.env.NIMBALYST_CODEX_ROUTE_DEBUG;

  afterEach(() => {
    if (originalFlag === undefined) {
      delete process.env.NIMBALYST_CODEX_ROUTE_DEBUG;
    } else {
      process.env.NIMBALYST_CODEX_ROUTE_DEBUG = originalFlag;
    }
    vi.restoreAllMocks();
  });

  it('adds no route log noise unless explicitly enabled', () => {
    delete process.env.NIMBALYST_CODEX_ROUTE_DEBUG;
    const log = vi.spyOn(console, 'log').mockImplementation(() => {});

    logCodexRoute('resolved', { model: 'deepseek-flash', provider: 'deepseek' });

    expect(log).not.toHaveBeenCalled();
  });

  it('logs routing fields without credential values when enabled', () => {
    process.env.NIMBALYST_CODEX_ROUTE_DEBUG = '1';
    const log = vi.spyOn(console, 'log').mockImplementation(() => {});

    logCodexRoute('resolved', {
      requestedModel: 'deepseek-flash',
      resolvedModel: 'deepseek-flash',
      provider: 'deepseek',
      profile: 'deepseek-flash',
      reasoningEffort: 'max',
    });

    expect(log).toHaveBeenCalledWith('[CODEX ROUTE] resolved', expect.objectContaining({
      requestedModel: 'deepseek-flash',
      resolvedModel: 'deepseek-flash',
      provider: 'deepseek',
      profile: 'deepseek-flash',
      reasoningEffort: 'max',
    }));
    expect(JSON.stringify(log.mock.calls)).not.toContain('DEEPSEEK_API_KEY');
    expect(JSON.stringify(log.mock.calls)).not.toContain('sk-secret');
  });
});
