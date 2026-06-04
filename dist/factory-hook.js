#!/usr/bin/env node

// src/cli/exit-codes.ts
var EXIT = {
  /** Success. */
  OK: 0,
  /** Generic failure (uncaught error, classified drop, gate/verify failure). */
  ERROR: 1,
  /** Usage error: unknown subcommand/hook, bad flags, missing required arg. */
  USAGE: 2
};

// src/hooks/branch-protection.ts
function runBranchProtection(_argv) {
  return EXIT.OK;
}

// src/hooks/main.ts
var hookRegistry = {
  "branch-protection": {
    describe: "Verify required branch protection is present (WS0 stub: no-op)",
    run: (argv) => runBranchProtection(argv)
  }
};
function printHelp() {
  const names = Object.keys(hookRegistry).sort();
  const width = names.reduce((m, n) => Math.max(m, n.length), 0);
  const lines = [
    "factory-hook \u2014 factory plugin hook dispatcher",
    "",
    "Usage: factory-hook <hook-name> [args]",
    "",
    "Hooks:",
    ...names.map((n) => `  ${n.padEnd(width)}  ${hookRegistry[n].describe}`)
  ];
  process.stdout.write(lines.join("\n") + "\n");
}
async function dispatchHook(argv) {
  const [name, ...rest] = argv;
  if (name === void 0 || name === "--help" || name === "-h") {
    printHelp();
    return EXIT.OK;
  }
  const hook = hookRegistry[name];
  if (!hook) {
    process.stderr.write(
      `factory-hook: unknown hook '${name}'. Run \`factory-hook --help\` for the list.
`
    );
    return EXIT.USAGE;
  }
  return hook.run(rest);
}

// src/bin/factory-hook.ts
dispatchHook(process.argv.slice(2)).then((code) => process.exit(code)).catch((err) => {
  const detail = err instanceof Error ? err.stack ?? err.message : String(err);
  process.stderr.write(detail + "\n");
  process.exit(EXIT.ERROR);
});
