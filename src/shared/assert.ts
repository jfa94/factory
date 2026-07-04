/**
 * Loud non-null assertions — the honest answer to `noUncheckedIndexedAccess`.
 *
 * With `noUncheckedIndexedAccess: true`, every `arr[i]` / `map.get(k)` is typed
 * `T | undefined`. The `!` non-null operator silences that at COMPILE time but
 * asserts NOTHING at runtime — a wrong index reads `undefined` and corrupts data
 * downstream with no signal. These helpers assert at runtime and throw LOUD with
 * a located message, so an out-of-range index or missing key fails at the read,
 * not three stack frames later. Prefer a `for..of` / `.entries()` refactor where
 * it makes the element natively `T`; reach for these where a bare index is clearest.
 */

/** Return `x`, throwing if it is `null`/`undefined`. The loud replacement for `x!`. */
export function nonNull<T>(x: T | null | undefined, msg?: string): T {
    if (x == null) {
        throw new Error(msg ?? 'unexpected nullish value')
    }
    return x
}

/** Index into `a`, throwing if the slot is out of range (or holds `undefined`). Replaces `a[i]!`. */
export function at<T>(a: readonly T[], i: number): T {
    return nonNull(a[i], `index ${i} out of range (length ${a.length})`)
}

/** `map.get(k)`, throwing if the key is absent. Replaces `map.get(k)!`. */
export function getOrThrow<K, V>(m: ReadonlyMap<K, V>, k: K, msg?: string): V {
    return nonNull(m.get(k), msg ?? 'missing map key')
}
