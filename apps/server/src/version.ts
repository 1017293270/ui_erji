declare const __VERSION__: string | undefined;

/** Set by build.mjs: build time and git commit. "dev" when run from source. */
export const VERSION: string = typeof __VERSION__ === "string" ? __VERSION__ : "dev";
