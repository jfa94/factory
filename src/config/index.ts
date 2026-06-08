/**
 * `src/config` — public config seam. Downstream imports `loadConfig`,
 * `resolveDataDir`, `ConfigSchema`, and the `Config` type from here.
 */
export { loadConfig, resolveDataDir, configPath, type DataDirOptions } from "./load.js";
export {
  saveRawConfig,
  readRawConfig,
  parseSetToken,
  splitPath,
  setAtPath,
  unsetAtPath,
  getAtPath,
  type ConfigValue,
} from "./save.js";
export {
  ConfigSchema,
  defaultConfig,
  QualitySchema,
  QuotaSchema,
  SpecSchema,
  SPEC_DEFAULTS,
  ReviewSchema,
  TestWriterSchema,
  ScribeSchema,
  CodexSchema,
  ObservabilitySchema,
  DependenciesSchema,
  GitSchema,
  type Config,
  type SpecConfig,
} from "./schema.js";
