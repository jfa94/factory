/** @type {import('dependency-cruiser').IConfiguration} */
module.exports = {
    forbidden: [
        {
            name: 'no-circular',
            severity: 'error',
            from: {},
            to: {circular: true},
        },
        {
            name: 'domain-no-infrastructure',
            severity: 'error',
            comment: 'Domain layer must never depend on infrastructure',
            from: {path: '^src/domain'},
            to: {path: '^src/(services|lib|app|components)'},
        },
        {
            name: 'components-no-services',
            severity: 'error',
            comment: 'Components must not directly import services',
            from: {path: '^src/components'},
            to: {path: '^src/services'},
        },
        {
            name: 'lib-not-to-app',
            severity: 'error',
            comment: 'lib/* must not depend on app/* — app may consume lib, never the reverse',
            from: {path: '^src/lib'},
            to: {path: '^src/app'},
        },
        {
            name: 'components-no-app',
            severity: 'error',
            comment:
                'components/* must not couple to app/* page/route/layout modules — ' +
                'src/app/actions/** is exempted: server actions are an idiomatic public API boundary in Next.js',
            from: {path: '^src/components'},
            to: {path: '^src/app', pathNot: '^src/app/actions'},
        },
        {
            name: 'not-to-test',
            severity: 'error',
            from: {pathNot: '\\.(test|spec)\\.'},
            to: {path: '\\.(test|spec)\\.'},
        },
        {
            name: 'not-to-dev-dep',
            severity: 'error',
            from: {path: '^src', pathNot: '\\.(test|spec)\\.'},
            to: {dependencyTypes: ['npm-dev']},
        },
        {
            name: 'no-unresolvable',
            severity: 'error',
            from: {},
            to: {couldNotResolve: true},
        },
    ],
    options: {
        doNotFollow: {path: 'node_modules'},
        includeOnly: '^src',
        tsPreCompilationDeps: true,
        tsConfig: {fileName: 'tsconfig.json'},
        cache: true,
    },
}
