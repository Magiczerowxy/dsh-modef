// Host-side entry for dsh-modef: declares the durable configuration schema
// behind the "高级推理等级滑块" card on the Plugins page. The browser half
// (exports["./client"]) reads the flags, renders that card, and conditionally
// claims the composer model seat.
//
// 0.1.7-rc.1 changed how a plugin owns settings, and this file is the host
// half of that change:
//
//   * `ctx.settings.register(ns, Config, …)` is GONE. The `settings` service
//     no longer accepts registrations — the whole `register` symbol has left
//     its public surface — and `settingsNamespace` is no longer exported by
//     `@deepseek-ai/dsh-settings`, so the old import failed at load time.
//   * A plugin now owns settings simply by EXPORTING a schemastery `Config`.
//     The loader reads it off the module (`fiber.runtime.Config`), the
//     settings service derives a form from it (`schema(entry)`), and the
//     values live in the profile's loader entry — which is why the browser
//     half addresses this document by our ENTRY id ("dsh-modef", declared in
//     this bundle's cordis.patch.yml) rather than by a namespace string.
//   * `inject: ["settings"]` is therefore unnecessary: nothing here talks to
//     the settings service. Dropping it also removes a start-up dependency —
//     a fiber that injects a service nobody provides never activates, which is
//     the failure mode that left three other plugins pending on this upgrade.
//
// The schema is otherwise unchanged: same three fields, same defaults, so an
// existing profile keeps the values it already had.
import z from "@deepseek-ai/schemastery";

const name = "@magiczerowxy/dsh-modef";

// Every field is `.volatile()`, which is what makes it EDITABLE in 0.1.7-rc.1:
// the settings service derives its writable form with `volatileForm(schema)`,
// and a schema with no volatile field at any depth yields `undefined`, so
// `settings.write()` refuses the whole namespace with "has no volatile fields".
// Volatile is also the correct semantic here rather than a workaround — it is
// the contract for "changing this value must not remount the plugin", which is
// precisely how these preferences behave (the browser half re-reads them from
// the snapshot store and repaints).
const Config = z.object({
  advancedEffort: z.boolean().default(false).volatile(),
  effortStyle: z.string().default("spray-flow").volatile(),
  // "滑块栏形状": "rounded" (default) | "capsule".
  trackShape: z.string().default("rounded").volatile(),
  // Added after the initial release. Declared here so the settings form shows
  // them and the Host accepts writes to them; the defaults are copied from the
  // browser half's own fallbacks (DEFAULT_GLASS_OPACITY = 62,
  // DEFAULT_GLASS_BLUR = 16, collapseProviders = true) so a deployment that
  // never opens the card behaves exactly as the client-side defaults describe.
  collapseProviders: z.boolean().default(true).volatile(),
  glassPanel: z.boolean().default(false).volatile(),
  glassOpacity: z.number().default(62).volatile(),
  glassBlur: z.number().default(16).volatile(),
  // ---- 可选提供商 (optional providers) --------------------------------------
  // The provider ROUTES the user turned off from the switch this plugin puts on
  // every provider card in 设置 → 模型. The model picker reads it and leaves those
  // providers' models out of the list.
  //
  // This field is the SECOND home of that list, not the first: the browser half
  // keeps the live copy in its own per-machine store (the same defensive
  // `localStorage` the provider memory and the row order use), because a switch
  // has to take effect the moment it is clicked — and a document write is only
  // accepted once the Host has projected this field, i.e. after a reload. Every
  // flip therefore writes the store first and then brings this field in step
  // (`set` when the list is non-empty, `unset` when it empties), so the choice
  // also survives a profile backup. A refusal is logged, never surfaced: the
  // switch already worked locally.
  //
  // Declared with NO default, like `diag`/`lastSeatError` below, so a profile
  // that never touches a switch gains no `disabledProviders: []`. `.volatile()`
  // is what makes the path writable at all — the settings service derives its
  // form with `volatileForm(schema)` and refuses a path outside one.
  disabledProviders: z.array(z.string()).required(false).default(undefined).volatile(),
  // ---- Crash telemetry (written by the browser half, never by the user) -----
  // `lastSeatError` is written once when the composer control crashes, so the
  // stack survives where it can be read. It has to be DECLARED, not merely
  // written: 0.1.7-rc.1 validates every written path against the schema and
  // rejects an undeclared field outright ("Config field \"lastSeatError\" is not
  // volatile"), and the writer is `.catch()`-guarded, so an undeclared key would
  // fail silently exactly when it is needed. The card never renders it — the
  // browser half projects only the seven preferences above.
  //
  // `diag` is now a LEGACY key with no writer at all: the browser half used to
  // buffer status transitions into it on a 1.5s timer, which in 0.1.7-rc.1
  // became a feedback loop — the write changed `entry.options.config`, the Host
  // emitted `settings/document-updated`, ui-model-selection reloaded its catalog
  // (`status: "loading"`), and the flicker this was reported for appeared every
  // ~1.9s. The writer is gone; the field stays declared only so a profile that
  // already carries a saved `diag: [...]` keeps validating and so the leftover
  // array is not silently stripped from the document (schemastery preserves
  // undeclared keys, so removing it here would not clean anything up anyway).
  //
  // Both are declared with NO default, so an untouched profile gains neither:
  // `required(false)` only drops the "must be present" rule, while schemastery
  // still supplies its own type default (`[]` for an array, `""` for a string),
  // and a default is what the settings document would then materialise. Passing
  // `undefined` explicitly is what removes it.
  diag: z.array(z.string()).required(false).default(undefined).volatile(),
  lastSeatError: z.string().required(false).default(undefined).volatile(),
  // ---- TPS 显示 (live tokens-per-second readout) ----------------------------
  // 由 dsh-live-tps 并入：在输入行「完全权限」右侧显示实时 tok/s。
  // 默认 false（关闭），所以既有 profile 升级后行为完全不变；开关在插件页本卡片上，
  // 保存后立即生效——指示器直接读同一份 settings 快照，不需要重载。
  tpsIndicator: z.boolean().default(false).volatile()
});

/** Host plugin body — the exported schema IS the registration. */
function apply() {}

export { Config, apply, name };
