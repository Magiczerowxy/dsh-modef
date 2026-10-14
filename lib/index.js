// Host-side entry for dsh-modef: registers the durable settings namespace
// behind the "高级的推理强度选择" toggle in General settings. The browser
// half (exports["./client"]) reads the flag and conditionally claims the
// composer model seat.
import z from "@deepseek-ai/schemastery";

// DSH 0.1.2-alpha.1 removed the `settingsNamespace` (and
// `installSettingsSection`) named exports from `@deepseek-ai/dsh-settings`
// — importing a missing named export is a SyntaxError at module evaluation,
// which makes the whole plugin tree fail to load (dsh exits 1). The settings
// service itself is unchanged: `ctx.settings.register(ns, schema, { base })`
// behaves identically from 0.1.0-rc.7 through 0.1.2-alpha.3. So inline what
// the removed wrapper did — a validated namespace string — instead of
// depending on an export upstream is free to move (same approach as
// dshmarket 1.38.1 lib/settings.js).
const NAMESPACE_PATTERN = /^[a-z][a-z0-9]*(?:-[a-z0-9]+)*$/;
const NS = "dsh-modef";
if (!NAMESPACE_PATTERN.test(NS)) {
  throw new TypeError(`settings namespace "${NS}" must match ${String(NAMESPACE_PATTERN)}`);
}

const name = "@magiczerowxy/dsh-modef";
// Official pattern (same as dsh-plugin-desktop): hard-inject the settings
// service; the fiber starts only once it is available.
const inject = ["settings"];

const Config = z.object({
  advancedEffort: z.boolean().default(false),
  effortStyle: z.string().default("spray-flow")
});

function apply(ctx, config) {
  ctx.settings.register(NS, Config, {
    base: config || {}
  });
}

export { Config, apply, inject, name };
