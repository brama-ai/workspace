export interface AgentInfo {
    agent: string;
    attempt?: number;
    status: string;
    model?: string;
    durationSeconds?: number;
    inputTokens?: number;
    outputTokens?: number;
    cost?: number;
    callCount?: number;
    updatedAt?: string;
    sessionId?: string;
}
export interface QAQuestion {
    id: string;
    agent: string;
    timestamp: string;
    priority: "blocking" | "non-blocking";
    category: string;
    question: string;
    context?: string;
    options?: string[];
    answer: string | null;
    answered_at: string | null;
    answered_by: string | null;
    answer_source?: string | null;
}
export interface QAData {
    version: number;
    questions: QAQuestion[];
}
export interface TaskInfo {
    dir: string;
    workflow: "foundry" | "ultraworks";
    status: string;
    title: string;
    priority: number;
    currentStep: string;
    workerId: string;
    startedAt: string;
    updatedAt: string;
    agents?: AgentInfo[];
    sessionName?: string;
    worktreePath?: string;
    branchName?: string;
    hasStaleLock?: boolean;
    lastEventTime?: string;
    lastEventAge?: number;
    branchExists?: boolean;
    attempt?: number;
    profile?: string;
    qaData?: QAData;
    waitingAgent?: string;
    waitingSince?: string;
    questionsCount?: number;
    questionsAnswered?: number;
}
export interface TaskCounts {
    pending: number;
    in_progress: number;
    waiting_answer: number;
    completed: number;
    failed: number;
    suspended: number;
    cancelled: number;
}
export interface ReadResult {
    tasks: TaskInfo[];
    counts: TaskCounts;
    focusDir: string | null;
}
export declare function readAllTasks(root: string): ReadResult;
