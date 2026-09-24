export const APP_VERSION = '0.6.0';
export const SCANNER_MODEL_VERSION = '0.6.0';
export const SCANNER_SNAPSHOT_SCHEMA_VERSION = 2;
export const SCANNER_RUNTIME_SCHEMA_VERSION = 1;

export const VERSION_LABEL = [
  `App v${APP_VERSION}`,
  `Scanner v${SCANNER_MODEL_VERSION}`,
  `Sync-Schema v${SCANNER_SNAPSHOT_SCHEMA_VERSION}`,
  `Runtime-Schema v${SCANNER_RUNTIME_SCHEMA_VERSION}`,
].join(' · ');
