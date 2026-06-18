/**
 * `src/shared` — cross-domain primitives barrel. This is a FROZEN seam set:
 * WS1+ import from here. Do not break these signatures post-freeze.
 */
export { createLogger, log } from "./logging.js";
export type { Logger, LogLevel } from "./logging.js";

export { exec, execOrThrow, ExecError } from "./exec.js";
export type { ExecResult, ExecOptions } from "./exec.js";

export { atomicWriteFile, atomicWriteFileSync } from "./atomic-write.js";
export type { WritableData } from "./atomic-write.js";

export {
  parseJson,
  readJsonFile,
  readJsonFileSync,
  writeJsonFile,
  writeJsonFileSync,
  stringifyJson,
  JsonParseError,
} from "./json.js";

export { appendJsonl, readJsonl } from "./jsonl.js";

export { nowIso, nowEpoch, parseIso8601ToEpoch, epochToIso } from "./time.js";

export {
  SECRET_CONTENT_PATTERNS,
  SECRET_REDACTION_PATTERNS,
  REDACTION_TOKEN,
  redactSecrets,
  detectSecrets,
} from "./secret-patterns.js";
export type { SecretPattern } from "./secret-patterns.js";

export { isValidId, validateId, slugify, ID_PATTERN, SLUG_MAX_LENGTH } from "./ids.js";

export { withFileLock, DEFAULT_FILE_LOCK_TUNING } from "./file-lock.js";
export type { FileLockTuning, FileLockOptions } from "./file-lock.js";

export { UsageError, isUsageError } from "./usage-error.js";
