/**
 * UsageError — a flag/argument usage error that the CLI entry maps to EXIT.USAGE (2).
 * Lives in `shared/` so `orchestrator/` can throw it without importing from `cli/`.
 */

/** A flag/argument usage error — the CLI entry maps it to EXIT.USAGE (2). */
export class UsageError extends Error {
    readonly isUsageError = true
    constructor(message: string) {
        super(message)
        this.name = 'UsageError'
    }
}

/** Type guard for {@link UsageError} (survives bundling — no instanceof reliance). */
export function isUsageError(err: unknown): err is UsageError {
    return err instanceof UsageError || (typeof err === 'object' && err !== null && 'isUsageError' in err)
}
