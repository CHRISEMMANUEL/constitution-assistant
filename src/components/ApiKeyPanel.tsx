import React, { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { KeyRound, X } from 'lucide-react';
import { Button } from './Button';
import { Card } from './Card';
import {
  PROVIDERS,
  clearAiSettings,
  providerById,
  saveAiSettings,
  useApiKey,
  usePreferredModel,
  useProviderId,
  type ProviderId,
} from '../services/aiKey';

const inputClass =
  'w-full bg-paper-soft dark:bg-ink-800 border border-slate/25 dark:border-ink-700 rounded-xl py-2.5 px-3 sm:px-4 text-ink-100 dark:text-paper outline-none focus:border-iris-500 transition-colors text-sm';

export const ApiKeyPanel: React.FC<{ onClose: () => void }> = ({ onClose }) => {
  const { t } = useTranslation();
  const savedProvider = useProviderId();
  const savedKey = useApiKey();
  const savedModel = usePreferredModel();
  const [providerId, setProviderId] = useState<ProviderId>(savedProvider);
  const [key, setKey] = useState(savedKey);
  const [model, setModel] = useState(savedModel);
  const provider = providerById(providerId);

  const changeProvider = (next: ProviderId) => {
    setProviderId(next);
    setKey(next === savedProvider ? savedKey : '');
    setModel(next === savedProvider ? savedModel : '');
  };

  const save = (e: React.FormEvent) => {
    e.preventDefault();
    saveAiSettings(providerId, key, model);
    if (key.trim()) onClose();
  };

  const remove = () => {
    clearAiSettings();
    setProviderId('openrouter');
    setKey('');
    setModel('');
  };

  return (
    <Card className="mb-3 sm:mb-4 p-4 sm:p-5">
      <form onSubmit={save} className="space-y-3">
        <div className="flex items-start justify-between gap-3">
          <div className="flex items-center gap-2">
            <KeyRound className="w-4 h-4 text-iris-500 shrink-0" />
            <h2 className="m-0 text-base sm:text-lg">{t('assistant.key_title')}</h2>
          </div>
          <button
            type="button"
            onClick={onClose}
            className="text-slate dark:text-mist hover:text-iris-500"
            aria-label={t('assistant.key_close')}
          >
            <X className="w-4 h-4" />
          </button>
        </div>

        <p className="text-slate dark:text-mist text-[12px] sm:text-sm">
          {t('assistant.key_intro')}
        </p>

        <label className="block space-y-1">
          <span className="text-xs font-medium">{t('assistant.provider_label')}</span>
          <select
            value={providerId}
            onChange={(e) => changeProvider(e.target.value as ProviderId)}
            className={inputClass}
          >
            {PROVIDERS.map((p) => (
              <option key={p.id} value={p.id}>
                {p.name}
              </option>
            ))}
          </select>
        </label>

        <label className="block space-y-1">
          <span className="text-xs font-medium">
            {t('assistant.key_label', { provider: provider.name })}
          </span>
          <input
            type="password"
            value={key}
            onChange={(e) => setKey(e.target.value)}
            placeholder={provider.keyPlaceholder}
            autoComplete="off"
            spellCheck={false}
            className={inputClass}
          />
          <a
            href={provider.keyUrl}
            target="_blank"
            rel="noopener noreferrer"
            className="inline-block text-[11px] sm:text-xs text-iris-500 hover:underline"
          >
            {t('assistant.key_get', { provider: provider.name })}
          </a>
        </label>

        <label className="block space-y-1">
          <span className="text-xs font-medium">{t('assistant.model_label')}</span>
          <input
            type="text"
            value={model}
            onChange={(e) => setModel(e.target.value)}
            placeholder={provider.defaultModel}
            autoComplete="off"
            spellCheck={false}
            className={inputClass}
          />
          <span className="block text-[11px] sm:text-xs text-slate dark:text-mist">
            {provider.freeModels
              ? t('assistant.model_hint')
              : t('assistant.model_hint_paid', { model: provider.defaultModel, provider: provider.name })}
          </span>
        </label>

        <div className="flex flex-wrap gap-2 pt-1">
          <Button type="submit" disabled={!key.trim()} className="py-2 text-sm">
            {t('assistant.key_save')}
          </Button>
          {savedKey && (
            <Button type="button" variant="secondary" onClick={remove} className="py-2 text-sm">
              {t('assistant.key_remove')}
            </Button>
          )}
        </div>
      </form>
    </Card>
  );
};
