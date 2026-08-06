// Low-memory declaration config keeps the canonical unified runtime graph but
// moves TypeScript declaration emission into the existing native tsgo process.
import type { UserConfig } from "tsdown";
import { TSDOWN_UNIFIED_CONFIG_GROUP } from "./scripts/lib/tsdown-config-groups.mjs";
import configs from "./tsdown.config.ts";

const lowMemoryConfigs = configs.map((config): UserConfig => {
  if (config.name !== TSDOWN_UNIFIED_CONFIG_GROUP || config.dts === false) {
    return config;
  }
  return Object.assign({}, config, {
    // The native emitter compiles a tsconfig eagerly, unlike the standard
    // entry-driven backend. Keep private tests out while retaining the one
    // intentionally packaged test-support entry.
    dts: { tsconfig: "tsconfig.tsdown.dts.json", tsgo: true },
  });
});

export default lowMemoryConfigs;
