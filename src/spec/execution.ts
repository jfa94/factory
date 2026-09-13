import type {SpecTask} from './schema.js'

export function safeRepoPath(path: string): boolean {
    return (
        !path.includes(String.fromCharCode(0)) &&
        !/[\\*?[\]{}:]/.test(path) &&
        path.split('/').every((part) => part !== '' && part !== '.' && part !== '..')
    )
}

/** Return a stable topological order, or actionable generation feedback. */
export function executionOrder(tasks: readonly SpecTask[]): SpecTask[] {
    const ids = new Map<string, SpecTask>()
    for (const task of tasks) {
        if (!/^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(task.task_id) || ids.has(task.task_id)) {
            throw new Error(`invalid or duplicate task id: ${task.task_id}`)
        }
        if (task.files.some((file) => !safeRepoPath(file))) {
            throw new Error(`${task.task_id}: files must be exact, safe repository-relative paths`)
        }
        ids.set(task.task_id, task)
    }
    const ordered: SpecTask[] = []
    const visiting = new Set<string>()
    const visited = new Set<string>()
    const visit = (id: string): void => {
        if (visited.has(id)) {
            return
        }
        if (visiting.has(id)) {
            throw new Error(`dependency cycle at ${id}`)
        }
        const task = ids.get(id)
        if (!task) {
            throw new Error(`unknown dependency: ${id}`)
        }
        if (new Set(task.depends_on).size !== task.depends_on.length) {
            throw new Error(`${id}: duplicate dependencies`)
        }
        visiting.add(id)
        for (const dependency of task.depends_on) {
            visit(dependency)
        }
        visiting.delete(id)
        visited.add(id)
        ordered.push(task)
    }
    for (const task of tasks) {
        visit(task.task_id)
    }
    const ancestors = new Map<string, Set<string>>()
    const owners = new Map<string, string>()
    for (const task of ordered) {
        const before = new Set(task.depends_on)
        for (const id of task.depends_on) {
            for (const ancestor of ancestors.get(id) ?? []) {
                before.add(ancestor)
            }
        }
        for (const file of task.files) {
            const prior = owners.get(file)
            if (prior !== undefined && !before.has(prior)) {
                throw new Error(`${task.task_id}: shared file ${file} requires a dependency on ${prior}`)
            }
            owners.set(file, task.task_id)
        }
        ancestors.set(task.task_id, before)
    }
    const closedSlices = new Set<string>()
    let current: string | undefined
    for (const task of ordered) {
        if (task.slice_id !== current) {
            if (current !== undefined) {
                closedSlices.add(current)
            }
            current = task.slice_id
            if (current !== undefined && closedSlices.has(current)) {
                throw new Error(`slice ${current} is interleaved; order dependencies within complete slices`)
            }
        }
    }
    return ordered
}
