import { createAnthropicProvider } from './anthropic';
import type { AiConfig } from './config';
import { createFakeProvider } from './fake';
import { createGeminiProvider } from './gemini';
import { createOpenAiProvider } from './openai';
import type { AiProvider } from './types';

/** O provedor escolhido por AI_PROVIDER. Trocar de provedor é só trocar o ambiente. */
export function createProvider(config: AiConfig): AiProvider {
  const { apiKey, models } = config;
  switch (config.provider) {
    case 'anthropic':
      return createAnthropicProvider({ apiKey, models });
    case 'openai':
      return createOpenAiProvider({ apiKey, models });
    case 'gemini':
      return createGeminiProvider({ apiKey, models });
    case 'fake':
      return createFakeProvider();
  }
}
