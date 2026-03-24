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
