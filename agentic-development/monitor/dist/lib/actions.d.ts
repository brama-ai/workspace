export declare function claimTask(taskDir: string, workerId: string): boolean;
export declare function releaseTask(taskDir: string): void;
/**
 * Archive a task: move it to tasks/archives/DD-MM-YYYY/task-slug/
 * Returns the archive path, or throws if task is truly in_progress (mid-pipeline).
 * Tasks stuck as in_progress but with all agents done are auto-completed first.
 */
export declare function archiveTask(taskDir: string): string;
export declare function findRepoRoot(): string;
export interface CmdResult {
    session: string;
    attachCmd: string;
    message: string;
}
export declare function startWorkers(repoRoot: string): CmdResult;
export declare function stopWorkers(repoRoot: string): CmdResult;
export declare function retryFailed(repoRoot: string): CmdResult;
export declare function runAutotest(repoRoot: string, smoke: boolean): CmdResult;
export declare function ultraworksLaunch(repoRoot: string): CmdResult;
export declare function ultraworksAttach(repoRoot: string): CmdResult;
export declare function ultraworksCleanup(repoRoot: string): CmdResult;
export interface ProcessEntry {
    pid: number;
    stat: string;
    etime: string;
    args: string;
    zombie: boolean;
    log: string | null;
}
export interface ProcessStatus {
    workers: ProcessEntry[];
    zombies: ProcessEntry[];
    lock: {
        pid: number;
        state: string;
        zombie: boolean;
    } | null;
}
/** Read live process status via foundry_process_status() shell helper */
export declare function getProcessStatus(repoRoot: string): ProcessStatus;
/** Clean zombie processes and stale batch lock */
export declare function cleanZombies(repoRoot: string): CmdResult;
/** Tail last N lines of a log file */
export declare function tailLog(logPath: string, lines?: number): string[];
