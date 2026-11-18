import { useSyncExternalStore } from 'react';

export type ProviderId = 'openrouter' | 'openai' | 'anthropic' | 'gemini' | 'groq' | 'xai';

export interface AiProvider {
  id: ProviderId;
  name: string;
  keyUrl: string;
  keyPlaceholder: string;
  defaultModel: string;
  chatUrl: string;
  freeModels?: boolean;
}

export const PROVIDERS: AiProvider[] = [
  {
    id: 'openrouter',
    name: 'OpenRouter',
    keyUrl: 'https://openrouter.ai/keys',
    keyPlaceholder: 'sk-or-v1-…',
    defaultModel: 'google/gemma-4-31b-it:free',
    chatUrl: 'https://openrouter.ai/api/v1/chat/completions',
    freeModels: true,
  },
  {
    id: 'openai',
    name: 'OpenAI',
    keyUrl: 'https://platform.openai.com/api-keys',
    keyPlaceholder: 'sk-…',
    defaultModel: 'gpt-4.1-mini',
    chatUrl: 'https://api.openai.com/v1/chat/completions',
  },
  {
    id: 'anthropic',
    name: 'Claude (Anthropic)',
    keyUrl: 'https://console.anthropic.com/settings/keys',
    keyPlaceholder: 'sk-ant-…',
    defaultModel: 'claude-opus-5-5',
    chatUrl: 'https://api.anthropic.com/v1/messages',
  },
  {
    id: 'gemini',
    name: 'Google Gemini',
    keyUrl: 'https://aistudio.google.com/apikey',
    keyPlaceholder: 'AIza…',
    defaultModel: 'gemini-2.5-flash',
    chatUrl: 'https://generativelanguage.googleapis.com/v1beta/openai/chat/completions',
  },
  {
    id: 'groq',
    name: 'Groq',
    keyUrl: 'https://console.groq.com/keys',
    keyPlaceholder: 'gsk_…',
    defaultModel: 'llama-3.3-70b-versatile',
    chatUrl: 'https://api.groq.com/openai/v1/chat/completions',
  },
  {
    id: 'xai',
    name: 'xAI Grok',
    keyUrl: 'https://console.x.ai',
    keyPlaceholder: 'xai-…',
    defaultModel: 'grok-3-mini',
    chatUrl: 'https://api.x.ai/v1/chat/completions',
  },
];

export const providerById = (id: string): AiProvider =>
  PROVIDERS.find((p) => p.id === id) ?? PROVIDERS[0];

const PROVIDER_STORAGE = 'constintell.ai.provider';
const KEY_STORAGE = 'constintell.ai.key';
const MODEL_STORAGE = 'constintell.ai.model';
const CHANGE_EVENT = 'constintell:ai-key';

const read = (name: string): string => {
  try {
    return localStorage.getItem(name)?.trim() ?? '';
  } catch {
    return '';
  }
};

const write = (name: string, value: string): void => {
  try {
    if (value.trim()) localStorage.setItem(name, value.trim());
    else localStorage.removeItem(name);
  } catch {
    // Storage blocked (private mode) or full: the key lives for this page only.
  }
};

export const getProviderId = (): ProviderId => providerById(read(PROVIDER_STORAGE)).id;
export const getProvider = (): AiProvider => providerById(read(PROVIDER_STORAGE));
export const getApiKey = (): string => read(KEY_STORAGE);
export const getPreferredModel = (): string => read(MODEL_STORAGE);

export const saveAiSettings = (provider: ProviderId, key: string, model: string): void => {
  write(PROVIDER_STORAGE, provider);
  write(KEY_STORAGE, key);
  write(MODEL_STORAGE, model);
  window.dispatchEvent(new Event(CHANGE_EVENT));
};

export const clearAiSettings = (): void => saveAiSettings('openrouter', '', '');

const subscribe = (onChange: () => void): (() => void) => {
  const onStorage = (e: StorageEvent) => {
    if (e.key === null || e.key.startsWith('constintell.ai.')) onChange();
  };
  window.addEventListener(CHANGE_EVENT, onChange);
  window.addEventListener('storage', onStorage);
  return () => {
    window.removeEventListener(CHANGE_EVENT, onChange);
    window.removeEventListener('storage', onStorage);
  };
};

export const useProviderId = (): ProviderId =>
  useSyncExternalStore(subscribe, getProviderId, () => 'openrouter' as ProviderId);

export const useApiKey = (): string =>
  useSyncExternalStore(subscribe, getApiKey, () => '');

export const usePreferredModel = (): string =>
  useSyncExternalStore(subscribe, getPreferredModel, () => '');
