import { describe, expect, it } from 'vitest';
import { createProvider } from './provider';

describe('createProvider', () => {
  it('builds the provider named in the configuration', () => {
    const base = { apiKey: 'k', models: { fast: 'a', strong: 'b' }, dailyBudgetUsd: 1, budgetTimeZone: 'UTC' };
    for (const provider of ['anthropic', 'openai', 'gemini', 'fake'] as const) {
      expect(createProvider({ ...base, provider }).id).toBe(provider);
    }
  });
});
