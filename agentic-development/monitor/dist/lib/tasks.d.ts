export interface AgentInfo {
    agent: string;
    status: string;
    model?: string;
    durationSeconds?: number;
    inputTokens?: number;
    outputTokens?: number;
    cost?: number;
    callCount?: number;
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
}
export interface TaskCounts {
    pending: number;
    in_progress: number;
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
