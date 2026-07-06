/**
 * Filesystem error predicates.
 *
 * `isEnoent` is the single home for the "is this a genuine file-absence?"
 * check — every reader keeps its OWN absent/corrupt policy (return null,
 * rethrow, default…); only the predicate is shared.
 */
export function isEnoent(err: unknown): boolean {
    return err instanceof Error && (err as NodeJS.ErrnoException).code === 'ENOENT'
}
