/**
 * `factory-hook` executable entry — THE only `process.exit` site for the hook
 * dispatcher. Thin by design (mirror of `src/bin/factory.ts`): imports the
 * importable `dispatchHook` and translates result/throw into a process exit.
 * esbuild bundles THIS file into `dist/factory-hook.js`.
 */
import { dispatchHook } from "../hooks/main.js";
import { EXIT } from "../shared/exit-codes.js";

dispatchHook(process.argv.slice(2))
  .then((code) => process.exit(code))
  .catch((err: unknown) => {
    const detail = err instanceof Error ? (err.stack ?? err.message) : String(err);
    process.stderr.write(detail + "\n");
    process.exit(EXIT.ERROR);
  });
