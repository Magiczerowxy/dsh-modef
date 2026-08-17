// Host-side entry for dsh-modef: registers the durable settings namespace
// behind the "高级的推理强度选择" toggle in General settings. The browser
// half (exports["./client"]) reads the flag and conditionally claims the
// composer model seat.
import z from "@deepseek-ai/schemastery";
import { settingsNamespace } from "@deepseek-ai/dsh-settings";
import { appendFileSync } from "node:fs";

const name = "@magiczerowxy/dsh-modef";
// Official pattern (same as dsh-plugin-desktop): hard-inject the settings
// service; the fiber starts only once it is available.
const inject = ["settings"];

const NS = settingsNamespace("dsh-modef");
const Config = z.object({
  advancedEffort: z.boolean().default(false),
  effortStyle: z.string().default("spray-flow")
});

const MARKER = "F:/Harnes workspace/_dsh_ui_tmp/dsh-modef-host-apply.log";

function trace(line) {
  try {
    appendFileSync(MARKER, new Date().toISOString() + " " + line + "\n", "utf8");
  } catch (e) { /* marker only */ }
}

function apply(ctx, config) {
  trace("apply called (inject=[settings])");
  try {
    const scope = ctx.settings.register(NS, Config, {
      base: config || {}
    });
    trace("settings.register OK; scope=" + (typeof scope));
    try {
      const v = scope.get();
      trace("scope.get()=" + JSON.stringify(v));
    } catch (e) {
      trace("scope.get() error: " + (e && e.message ? e.message : String(e)));
    }
  } catch (e) {
    trace("settings.register ERROR: " + (e && e.message ? e.message : String(e)));
  }
}

export { Config, apply, inject, name };
