/**
 * `factory` executable entry — THE only `process.exit` site for the CLI.
 *
 * Deliberately thin: it imports the importable dispatch logic and translates its
 * result/throw into a process exit. Keeping the `.then(process.exit)` here (not
 * in `src/cli/main.ts`) means tests can import `dispatch` without triggering a
 * real `process.exit`. esbuild bundles THIS file into `dist/factory.js`.
 */
import { dispatch } from "../cli/main.js";
import { EXIT } from "../cli/exit-codes.js";

dispatch(process.argv.slice(2))
  .then((code) => process.exit(code))
  .catch((err: unknown) => {
    const detail = err instanceof Error ? (err.stack ?? err.message) : String(err);
    process.stderr.write(detail + "\n");
    process.exit(EXIT.ERROR);
  });
