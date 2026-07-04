/**
 * Atomic, durable file writes — frozen seam (WS1's StateManager composes this).
 *
 * Durability sequence (carried over from the proven bash mechanic in the design
 * doc: "temp + fsync + rename + fsync-parent"):
 *   1. mkdir -p the parent directory.
 *   2. Write to a unique sibling temp file `.<name>.<pid>.<rand>.tmp`.
 *   3. fsync the temp file's contents to disk, then close it.
 *   4. rename() the temp file onto the target (atomic on POSIX same-filesystem).
 *   5. fsync the PARENT directory so the rename itself is durable across crash.
 *
 * Why the temp file is a sibling (same dir) and not in /tmp: rename() is only
 * atomic within a single filesystem. A sibling guarantees that.
 *
 * On any failure the temp file is best-effort unlinked so no partial residue is
 * left behind (asserted by the colocated test).
 *
 * Both a sync and an async variant are provided; signatures are FROZEN.
 */
/* eslint-disable security/detect-non-literal-fs-filename -- fs seam: paths are internal derived run/spec/state/repo paths, never external input; runtime write-danger is covered by the TCB write-deny hook */
import {closeSync, fsyncSync, mkdirSync, openSync, renameSync, unlinkSync, writeSync} from 'node:fs'
import {mkdir, open, rename, unlink} from 'node:fs/promises'
import {dirname, basename, join} from 'node:path'
import {randomBytes} from 'node:crypto'

/** Data accepted by the atomic writers. */
export type WritableData = string | Uint8Array

function tempPathFor(target: string): string {
    const dir = dirname(target)
    const name = basename(target)
    const rand = randomBytes(6).toString('hex')
    return join(dir, `.${name}.${process.pid}.${rand}.tmp`)
}

/**
 * Synchronously write `data` to `target` atomically and durably.
 * Creates parent directories as needed. Leaves no temp file on failure.
 */
export function atomicWriteFileSync(target: string, data: WritableData): void {
    const dir = dirname(target)
    mkdirSync(dir, {recursive: true})
    const tmp = tempPathFor(target)

    // Write + fsync the file contents.
    let fd = openSync(tmp, 'w', 0o600)
    try {
        writeSync(fd, data as never)
        fsyncSync(fd)
    } catch (err) {
        closeSync(fd)
        bestEffortUnlinkSync(tmp)
        throw err
    }
    closeSync(fd)

    // Atomic swap.
    try {
        renameSync(tmp, target)
    } catch (err) {
        bestEffortUnlinkSync(tmp)
        throw err
    }

    // fsync the parent dir so the rename (directory entry change) is durable.
    // Directory fsync is unsupported on some platforms (e.g. Windows) — treat
    // EISDIR/EPERM/EINVAL there as non-fatal; the data fsync above already ran.
    try {
        fd = openSync(dir, 'r')
        try {
            fsyncSync(fd)
        } finally {
            closeSync(fd)
        }
    } catch {
        /* parent-dir fsync unsupported on this platform; acceptable */
    }
}

/**
 * Asynchronously write `data` to `target` atomically and durably.
 * Mirrors {@link atomicWriteFileSync}.
 */
export async function atomicWriteFile(target: string, data: WritableData): Promise<void> {
    const dir = dirname(target)
    await mkdir(dir, {recursive: true})
    const tmp = tempPathFor(target)

    const handle = await open(tmp, 'w', 0o600)
    try {
        await handle.writeFile(data)
        await handle.sync()
    } catch (err) {
        await handle.close()
        await bestEffortUnlink(tmp)
        throw err
    }
    await handle.close()

    try {
        await rename(tmp, target)
    } catch (err) {
        await bestEffortUnlink(tmp)
        throw err
    }

    try {
        const dirHandle = await open(dir, 'r')
        try {
            await dirHandle.sync()
        } finally {
            await dirHandle.close()
        }
    } catch {
        /* parent-dir fsync unsupported on this platform; acceptable */
    }
}

function bestEffortUnlinkSync(p: string): void {
    try {
        unlinkSync(p)
    } catch {
        /* already gone */
    }
}

async function bestEffortUnlink(p: string): Promise<void> {
    try {
        await unlink(p)
    } catch {
        /* already gone */
    }
}
