import React, { useState } from 'react';
import { Ban, Check, ChevronDown, Loader2, X } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import type { TFunction } from 'i18next';
import type { AgentStage, AgentStep } from '../services/trace';

const runningLabel: Record<AgentStage, string> = {
  planning: 'assistant.stage_planning',
  searching: 'assistant.finding_sources',
  analyzing: 'assistant.stage_analyzing',
  writing: 'assistant.stage_writing',
  verifying: 'assistant.stage_verifying',
  repairing: 'assistant.stage_repairing',
  drafting_quiz: 'tutor.stage_drafting',
  checking_quiz: 'tutor.stage_checking',
};

function doneLabel(step: AgentStep, t: TFunction): string {
  switch (step.stage) {
    case 'planning':
      return t('timeline.planned', { n: step.searches?.length ?? 0 });
    case 'searching':
      return t('timeline.searched', { n: step.count ?? 0 });
    case 'analyzing':
      return t('timeline.analyzed', { countries: (step.countries ?? []).join(', ') });
    case 'writing':
      return t('timeline.wrote');
    case 'verifying':
      return step.count ? t('timeline.verify_problems', { n: step.count }) : t('timeline.verify_ok');
    case 'repairing':
      return t(step.repaired ? 'timeline.repair_kept' : 'timeline.repair_dropped');
    case 'drafting_quiz':
      return t('timeline.drafted', { n: step.count ?? 0 });
    case 'checking_quiz':
      return t('timeline.checked', { kept: step.kept ?? 0, n: step.count ?? 0 });
  }
}

function details(step: AgentStep, t: TFunction): string[] {
  const lines: string[] = [];
  if (step.stage === 'planning') {
    for (const s of step.searches ?? []) {
      lines.push(`“${s.query}” · ${s.countries.length ? s.countries.join(', ') : t('timeline.all_countries')}`);
    }
    if (step.fallback) lines.push(t('timeline.planner_fallback'));
  }
  if (step.stage === 'searching' && step.fallback) lines.push(t('timeline.offline'));
  return lines;
}

const StatusIcon: React.FC<{ status: AgentStep['status'] }> = ({ status }) => {
  if (status === 'running') return <Loader2 className="w-3 h-3 animate-spin text-iris-500" />;
  if (status === 'failed') return <X className="w-3 h-3 text-rose-500" />;
  if (status === 'stopped') return <Ban className="w-3 h-3 text-slate dark:text-mist" />;
  return <Check className="w-3 h-3 text-sage-500" />;
};

// Open while the agents work, folded once they finish; a click overrides either.
export const AgentTimeline: React.FC<{ steps: AgentStep[]; live: boolean }> = ({ steps, live }) => {
  const { t } = useTranslation();
  const [toggled, setToggled] = useState<boolean | null>(null);
  const open = toggled ?? live;
  if (steps.length === 0) return null;

  const seconds = (steps.reduce((sum, s) => sum + (s.ms ?? 0), 0) / 1000).toFixed(1);
  return (
    <div className="text-[11px] sm:text-xs">
      <button
        onClick={() => setToggled(!open)}
        aria-expanded={open}
        className="flex items-center gap-1.5 text-slate dark:text-mist hover:text-iris-500 transition-colors"
      >
        <ChevronDown className={`w-3.5 h-3.5 transition-transform ${open ? '' : '-rotate-90'}`} />
        <span>{t('timeline.title')}</span>
        {!live && <span className="opacity-70">· {t('timeline.summary', { n: steps.length, seconds })}</span>}
      </button>
      {open && (
        <ol className="mt-2 ml-1.5 border-l border-slate/25 dark:border-ink-700 space-y-2">
          {steps.map((step, i) => (
            <li key={i} className="relative pl-4">
              <span className="absolute -left-[7px] top-0.5 w-3.5 h-3.5 rounded-full flex items-center justify-center bg-paper-soft dark:bg-ink-900">
                <StatusIcon status={step.status} />
              </span>
              <div className="flex items-baseline gap-2">
                <span className={step.status === 'running' ? 'text-iris-500' : 'text-ink-100 dark:text-paper'}>
                  {step.status === 'done' ? doneLabel(step, t) : t(runningLabel[step.stage])}
                  {(step.status === 'failed' || step.status === 'stopped') && (
                    <span className="text-slate dark:text-mist"> · {t(`timeline.${step.status}`)}</span>
                  )}
                </span>
                {step.ms !== undefined && (
                  <span className="ml-auto shrink-0 tabular-nums text-slate dark:text-mist">
                    {(step.ms / 1000).toFixed(1)} s
                  </span>
                )}
              </div>
              {details(step, t).map((line) => (
                <p key={line} className="text-slate dark:text-mist break-words">
                  {line}
                </p>
              ))}
            </li>
          ))}
        </ol>
      )}
    </div>
  );
};
