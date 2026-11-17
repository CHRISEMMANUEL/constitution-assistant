import React, { useState } from 'react';
import { RotateCcw } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import type { Quiz } from '../services/tutor';

type OptionState = 'idle' | 'right' | 'wrong' | 'other';

const optionStyles: Record<OptionState, string> = {
  idle: 'border-slate/25 dark:border-ink-700 hover:border-iris-500 hover:text-iris-500',
  right: 'border-sage-500 bg-sage-500/10 text-sage-500',
  wrong: 'border-rose-500 bg-rose-500/10 text-rose-500',
  other: 'border-slate/15 dark:border-ink-700 opacity-60',
};

export const QuizCard: React.FC<{ quiz: Quiz }> = ({ quiz }) => {
  const { t } = useTranslation();
  const total = quiz.questions.length;
  const [picks, setPicks] = useState<Array<number | null>>(() => quiz.questions.map(() => null));
  const answered = picks.filter((p) => p !== null).length;
  const correct = picks.filter((p, i) => p === quiz.questions[i].answer).length;

  const pick = (qi: number, oi: number) =>
    setPicks((prev) => prev.map((p, i) => (i === qi ? oi : p)));

  return (
    <div className="space-y-4">
      <p className="font-medium">{t('tutor.heading', { topic: quiz.topic })}</p>
      <ol className="space-y-5">
        {quiz.questions.map((q, qi) => {
          const chosen = picks[qi];
          const source = quiz.sources[q.source - 1];
          return (
            <li key={qi} className="space-y-2">
              <p className="font-medium">
                {qi + 1}. {q.question}
              </p>
              <div className="grid gap-1.5">
                {q.options.map((option, oi) => {
                  const state: OptionState =
                    chosen === null ? 'idle' : oi === q.answer ? 'right' : oi === chosen ? 'wrong' : 'other';
                  return (
                    <button
                      key={oi}
                      onClick={() => pick(qi, oi)}
                      disabled={chosen !== null}
                      className={`text-left px-3 py-2 rounded-lg border transition-colors ${optionStyles[state]}`}
                    >
                      {option}
                    </button>
                  );
                })}
              </div>
              {chosen !== null && (
                <div className="text-[12px] space-y-1.5 pl-3 border-l-2 border-iris-500/40">
                  <p>
                    <strong>{chosen === q.answer ? t('tutor.correct') : t('tutor.incorrect')}</strong>{' '}
                    {q.explanation}
                  </p>
                  <p className="italic text-slate dark:text-mist">“{q.quote}”</p>
                  {source && (
                    <span className="inline-block text-[10px] uppercase tracking-wider px-2 py-1 rounded-full border border-iris-500/40 text-iris-500 bg-iris-500/5">
                      {source.constitution.flag} {source.constitution.country} · {source.article.article_number}
                    </span>
                  )}
                </div>
              )}
            </li>
          );
        })}
      </ol>
      <div className="flex flex-wrap items-center gap-2 pt-1 text-[12px]">
        <span className="font-medium">
          {answered === total ? t('tutor.score', { correct, total }) : t('tutor.progress', { answered, total })}
        </span>
        {answered > 0 && (
          <button
            onClick={() => setPicks(quiz.questions.map(() => null))}
            className="ml-auto flex items-center gap-1 text-[11px] px-2 py-1 rounded-full border border-slate/25 dark:border-ink-700 text-slate dark:text-mist hover:border-iris-500 hover:text-iris-500 transition-colors"
          >
            <RotateCcw className="w-3 h-3" /> {t('tutor.retry')}
          </button>
        )}
      </div>
    </div>
  );
};
