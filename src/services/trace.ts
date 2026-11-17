export type AgentStage =
  | 'planning'
  | 'searching'
  | 'analyzing'
  | 'writing'
  | 'verifying'
  | 'repairing'
  | 'drafting_quiz'
  | 'checking_quiz';

export type StepStatus = 'running' | 'done' | 'failed' | 'stopped';

export interface StepInfo {
  searches?: Array<{ query: string; countries: string[] }>;
  // planning: the planner failed and the question was searched as typed.
  // searching: the database was unreachable and the bundled articles were searched.
  fallback?: boolean;
  // searching: sources found. verifying: problems found. drafting_quiz: questions drafted.
  // checking_quiz: questions checked.
  count?: number;
  kept?: number;
  countries?: string[];
  repaired?: boolean;
}

export interface AgentStep extends StepInfo {
  stage: AgentStage;
  status: StepStatus;
  startedAt: number;
  ms?: number;
}

// Records what each agent did so the interface can show the steps live and afterwards.
export class Trace {
  private readonly steps: AgentStep[] = [];
  private readonly onChange?: (steps: AgentStep[]) => void;

  constructor(onChange?: (steps: AgentStep[]) => void) {
    this.onChange = onChange;
  }

  start(stage: AgentStage, info: StepInfo = {}): void {
    this.finish('done');
    this.steps.push({ stage, status: 'running', startedAt: Date.now(), ...info });
    this.emit();
  }

  note(info: StepInfo): void {
    const step = this.running();
    if (!step) return;
    Object.assign(step, info);
    this.emit();
  }

  close(status: Exclude<StepStatus, 'running'> = 'done'): void {
    if (this.finish(status)) this.emit();
  }

  private running(): AgentStep | undefined {
    const last = this.steps.at(-1);
    return last?.status === 'running' ? last : undefined;
  }

  private finish(status: Exclude<StepStatus, 'running'>): boolean {
    const step = this.running();
    if (!step) return false;
    step.status = status;
    step.ms = Date.now() - step.startedAt;
    return true;
  }

  private emit(): void {
    this.onChange?.(this.steps.map((s) => ({ ...s })));
  }
}
