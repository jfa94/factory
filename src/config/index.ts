/**
 * `src/config` — public config seam. Downstream imports `loadConfig`,
 * `resolveDataDir`, `ConfigSchema`, and the `Config` type from here.
 */
export { loadConfig, resolveDataDir, configPath, type DataDirOptions } from "./load.js";
export {
  ConfigSchema,
  defaultConfig,
  QualitySchema,
  QuotaSchema,
  ReviewSchema,
  TestWriterSchema,
  ScribeSchema,
  CodexSchema,
  ObservabilitySchema,
  DependenciesSchema,
  type Config,
} from "./schema.js";
