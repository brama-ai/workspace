export declare function rlog(event: string, payload: Record<string, unknown>, level?: "INFO" | "WARN" | "ERROR"): void;
export declare function rlogModelCall(agent: string, model: string, attempt: number, timeout: number): void;
export declare function rlogModelResult(agent: string, model: string, exitCode: number, duration: number, blacklisted: boolean, reason?: string): void;
export declare function rlogBlacklist(model: string, ttlSeconds: number, reason: string, exitCode: number, duration: number): void;
