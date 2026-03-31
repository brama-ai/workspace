import { type TaskState as BaseTaskState } from "../state/task-state-v2.js";
interface TaskState extends BaseTaskState {
    attempt?: number;
}
import { type ProcessHealth } from "../lib/db-info.js";
/** @internal exported for testing */
export declare function getTotalCost(state: TaskState): number;
/** @internal exported for testing */
export declare function getFailedAgents(state: TaskState): string[];
/** @internal exported for testing */
export declare function getSummaryStatus(taskDir: string): "PASS" | "FAIL" | "UNKNOWN" | "NO_SUMMARY";
export type ErrorCategory = "timeout" | "rate_limit" | "git_conflict" | "zombie" | "preflight" | "agent_error" | "summary_fail" | "unknown";
type FixAction = "retry" | "wait_retry" | "clean_retry" | "fix_env" | "retry_with_split" | "manual";
export interface Diagnosis {
    category: ErrorCategory;
    action: FixAction;
    detail: string;
}
/** @internal exported for testing */
export declare function diagnose(taskDir: string, state: TaskState): Diagnosis;
export interface StallResult {
    stalled: boolean;
    idleSec: number;
    threshold: number;
    /** DB-based health (null if DB check was skipped) */
    dbHealth: ProcessHealth | null;
}
/** @internal exported for testing */
export declare function checkStall(taskDir: string, status: string, step: string | null): StallResult;
/** @deprecated Use `foundry monitor` sidebar chat instead. Will be removed in a future release. */
export declare function cmdSupervisor(args: string[]): Promise<number>;
export {};
