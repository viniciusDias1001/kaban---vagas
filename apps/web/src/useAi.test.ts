import { describe, expect, it } from 'vitest';
import { AI_KEYS, SETTINGS_REFRESH_KEYS } from './useAi';
import { APPLY_KEYS } from './useApply';

describe('what a settings change refreshes', () => {
  it('rereads the AI state and the automatic application status', () => {
    // O cartão "Hoje" da candidatura (ligada/desligada, horário) vem de /apply/status, que só é relido a cada 15 s:
    // sem isto, logo depois de salvar ele ainda diz "Salva como desligada".
    expect(SETTINGS_REFRESH_KEYS).toContainEqual(APPLY_KEYS.status);
    expect(SETTINGS_REFRESH_KEYS).toContainEqual(AI_KEYS.settings);
    expect(SETTINGS_REFRESH_KEYS).toContainEqual(AI_KEYS.status);
  });
});
