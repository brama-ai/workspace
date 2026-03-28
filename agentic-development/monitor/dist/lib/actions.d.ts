export declare function claimTask(taskDir: string, workerId: string): boolean;
export declare function releaseTask(taskDir: string): void;
export declare function archiveTask(taskDir: string): string;
export declare function findRepoRoot(): string;
export interface CmdResult {
    session: string;
    attachCmd: string;
    message: string;
}
export declare function getWorkerCount(repoRoot: string): number;
export declare function setWorkerCount(repoRoot: string, count: number): CmdResult;
export declare function cycleWorkerCount(repoRoot: string): CmdResult;
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
/** Read live process status — pure TypeScript, no bash/jq overhead */
export declare function getProcessStatus(repoRoot: string): ProcessStatus;
/** Async version — returns via callback to avoid blocking Ink render */
export declare function getProcessStatusAsync(repoRoot: string, cb: (status: ProcessStatus) => void): void;
/** Clean zombie processes and stale batch lock */
export declare function cleanZombies(repoRoot: string): CmdResult;
/** Run u-doctor general diagnostics in tmux */
export declare function runDoctor(repoRoot: string): CmdResult;
/** Run u-doctor diagnostics for a specific task */
export declare function runDoctorTask(repoRoot: string, taskSlug: string): CmdResult;
/** Tail last N lines of a log file */
export declare function tailLog(logPath: string, lines?: number): string[];
