// Headless smoke test for lib/client.js. Loads the real module with a minimal
// React stub, runs apply() against mock Cordis contexts, and renders every
// registered slot component 鈥?including the failure paths the composer seat is
// now hardened against. Run: node smoke.cjs
const fs = require('fs');
const path = require('path');
const vm = require('vm');

// ---- minimal React ---------------------------------------------------------
let hookIndex = 0;
let hookState = [];
let capturedEffects = [];
const resetHooks = () => { hookIndex = 0; capturedEffects = []; };
const React = {
  Fragment: Symbol('Fragment'),
  createElement(type, props, ...children) { return { __el: true, type, props: props || {}, children }; },
  useState(initial) {
    const i = hookIndex++;
    if (!(i in hookState)) hookState[i] = typeof initial === 'function' ? initial() : initial;
    const setter = (v) => { hookState[i] = typeof v === 'function' ? v(hookState[i]) : v; };
    return [hookState[i], setter];
  },
  useRef(initial) { const i = hookIndex++; if (!(i in hookState)) hookState[i] = { current: initial }; return hookState[i]; },
  useEffect(fn) { hookIndex++; capturedEffects.push(fn); return undefined; },
  useLayoutEffect(fn) { hookIndex++; capturedEffects.push(fn); return undefined; },
  useMemo(fn) { hookIndex++; return fn(); },
  useCallback(fn) { hookIndex++; return fn; },
  useSyncExternalStore(subscribe, getSnapshot) { hookIndex++; return getSnapshot(); },
  Component: class Component {
    constructor(props) { this.props = props; this.state = {}; }
    setState(patch) { this.state = { ...this.state, ...(typeof patch === 'function' ? patch(this.state) : patch) }; }
  }
};
React.Component.prototype.isReactComponent = {};

/** Run the effects captured by the last render pass; returns their cleanups. */
function runEffects() {
  const cleanups = [];
  for (const fn of capturedEffects) {
    try {
      const cleanup = fn();
      if (typeof cleanup === 'function') cleanups.push(cleanup);
    } catch (error) { throw error; }
  }
  return cleanups;
}

// ---- module loading --------------------------------------------------------
const source = fs.readFileSync(path.join(__dirname, '..', 'lib', 'client.js'), 'utf8');
// The HOST half, read as text: it cannot be imported here (it needs a real
// schemastery, and its whole job is to declare a schema at module scope), but
// its shape is exactly what 0.1.7-rc.1's loader inspects.
const hostSource = fs.readFileSync(path.join(__dirname, '..', 'lib', 'index.js'), 'utf8');
const pkg = JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'package.json'), 'utf8'));
// Captures the stylesheet the module injects, so a test can check it is
// well-formed without a DOM.
let injectedCss = '';
// Every cosmos ROLL dealt into its dedicated <style> element (one entry per
// effort-panel open while the cosmos style is active). Kept separate from
// injectedCss so a roll never clobbers the main stylesheet capture.
let cosmosRolls = [];
// Every 晚霞 (sunset) ROLL, routed the same way and for the same reason: each
// roll is written into a dedicated element, and if the stub let it land in
// `injectedCss` it would clobber the captured static stylesheet (that is
// exactly how the reduced-motion check first broke when sunset was added).
let sunsetRolls = [];
// Frame instrumentation: `rafScheduled` counts scheduled frames (so a test can
// prove input coalescing), and the captured callbacks let a test run a frame
// synchronously. The timers still fire them too; every writer here is idempotent.
let rafScheduled = 0;
let rafCallbacks = [];
// Everything the plugin logged through `console.error`, in order. The sandbox's
// console is built once per `loadModule()`, so this is module-level rather than a
// `loadModule` option: a test resets it (`clientErrors.length = 0`) and then
// asserts that a contained failure was REPORTED rather than eaten.
const clientErrors = [];
// Every `t(key, params)` call the sandbox made, in order. The stub answers with
// the key, so this is how a test reads the VALUES a string was given.
const localeCalls = [];
function flushRaf() {
  const pending = rafCallbacks;
  rafCallbacks = [];
  for (const fn of pending) { try { fn(Date.now()); } catch (error) { /* keep flushing */ } }
  return pending.length;
}
function loadModule(opts) {
  const o = opts || {};
  let captured = null;
  // `o.timers` replaces the timer functions the SANDBOX sees. It exists because
  // the sandbox snapshots `setTimeout` by value here, so a test cannot swap the
  // global after the fact and expect the module to notice — a test that needs to
  // fire a scheduled callback deterministically (the 500ms drag hold) has to
  // supply the implementation up front.
  const timers = o.timers || {};
  const sandbox = {
    // Every `console.error` the plugin logs, kept so a test can prove a CONTAINED
    // failure was reported instead of silently dropped (the sandbox keeps the
    // real stderr line too). Reset with `clientErrors.length = 0`.
    console: {
      info() {},
      warn() {},
      error: (...a) => {
        clientErrors.push(a);
        console.log('  [client console.error]', ...a);
      }
    },
    setTimeout: timers.setTimeout || setTimeout,
    clearTimeout: timers.clearTimeout || clearTimeout,
    setInterval, clearInterval,
    requestAnimationFrame: (fn) => {
      rafScheduled += 1;
      rafCallbacks.push(fn);
      return setTimeout(() => fn(Date.now()), 0);
    },
    cancelAnimationFrame: (id) => clearTimeout(id),
    performance: { now: () => Date.now() },
    // The close path defers its refocus through queueMicrotask, so the sandbox
    // needs it or driving a real close would throw.
    queueMicrotask: (fn) => { Promise.resolve().then(fn); },
    // `o.fetch` is the page's `fetch`. Without it the sandbox has none, which is
    // the "no network seam" path the billing-rate lookup must survive — it checks
    // for the function instead of assuming it.
    fetch: o.fetch,
    // `o.document` REPLACES this stub, which is how a test drives the keyboard
    // paths: they compare the focused element against `document.activeElement`,
    // and only the caller can hand the module the same node it made active.
    document: o.document || {
      createElement: () => ({ dataset: {}, style: {}, textContent: '' }),
      head: {
        appendChild: (tag) => {
          const css = String(tag.textContent || '');
          // Cosmos rolls live in their own element; route them aside so they
          // never overwrite the main stylesheet capture.
          if (tag.dataset && tag.dataset.pluginCss === '@magiczerowxy/dsh-modef/cosmos.css') { cosmosRolls.push(css); return; }
          if (tag.dataset && tag.dataset.pluginCss === '@magiczerowxy/dsh-modef/sunset.css') { sunsetRolls.push(css); return; }
          injectedCss = css;
        }
      },
      querySelector: () => null,
      addEventListener: () => {}, removeEventListener: () => {},
      activeElement: null, body: {}
    },
    // `o.window` lets a test supply a viewport (`innerWidth`/`innerHeight`).
    // Without it the sandbox window has neither, which is the "cannot measure"
    // path the level-2 panel must keep working on — it falls back to the CSS
    // anchor instead of guessing.
    window: Object.assign({ __ModuleLoader__: { load(def) { captured = def; } }, matchMedia: () => ({ matches: false }), addEventListener: () => {} }, o.window || {}),
    require(name) {
      if (name === 'react') return React;
      // Platform seed word in the shell's module table (see My() in the shell
      // bundle). The card header requires its chevron and its sliding switches
      // from here.
      if (name === '@deepseek-ai/dsh-client-ui-primitives') {
        // `noPrimitives` models a shell whose module table lacks the seed word,
        // which must degrade to the hand-drawn fallbacks rather than throw.
        if (o.noPrimitives) throw new Error('module not composed: ' + name);
        return {
          IconChevronDownOutline14: function IconChevronDownOutline14() { return { __el: true, type: 'svg', props: {}, children: [] }; },
          Switch: function Switch(props) {
            return React.createElement('button', {
              type: 'button',
              role: 'switch',
              'aria-checked': props.checked,
              'aria-label': props.label,
              disabled: props.disabled,
              className: props.className,
              onClick: () => { props.onChange(!props.checked); }
            }, React.createElement('span', { className: 'thumb' }));
          }
        };
      }
      throw new Error('unexpected require: ' + name);
    }
  };
  sandbox.globalThis = sandbox;
  vm.createContext(sandbox);
  vm.runInContext(source, sandbox, { filename: 'client.js' });
  if (!captured) throw new Error('module did not register itself');
  return captured.factory(sandbox.require);
}

// ---- mock Cordis context ---------------------------------------------------
// The slot names this DSH declares for the surfaces this plugin uses. A slot the
// running DSH does not declare is a slot this plugin cannot register into, so the
// mock refuses it the same way. `settings.models.footer` is 0.2.x's ordered
// extension area at the bottom of the 设置 → 模型 page, where the 可选提供商 panel
// lives — NOT `settings.models.provider-card`, which is a KEYED cell whose
// `llm-pi-ai` key `dsh-better-reasoning-effort` already holds in this deployment.
const SLOT_NAMES = ['conversation.input.model', 'plugins.item', 'settings.models.footer'];
function makeCtx(opts) {
  const o = opts || {};
  const registrations = [];
  const writes = [];
  const mutations = [];
  const selects = [];
  // Every profile-entry id the plugin asked `configForms` for. Recorded so a
  // test can assert the id is the HOST ENTRY ("dsh-modef") rather than a
  // namespace string — 0.1.7-rc.1 keys a settings document by the entry that
  // serves it, and a wrong id yields a form that never becomes ready.
  const configFormIds = [];
  // Every slot name the plugin injected into, so a test can prove it asks for
  // the slots this DSH declares.
  const injectedSlotNames = [];
  // Every `remote.$on(event, handler)` a plugin installed, so a test can fire the
  // event the way the Host would (the 可选提供商 panel refreshes on an adapter
  // change).
  const adapterHandlers = [];
  // Every registration whose disposer ran. A real slot ledger drops the entry, so
  // this list is how a test sees a contribution being withdrawn (disposal is a
  // no-op on `registrations` for the plug-ins that never dispose).
  const disposedRegistrations = [];
  const settingsValue = o.settingsValue || { advancedEffort: true, effortStyle: 'spray-flow', glassPanel: true, glassOpacity: 62, glassBlur: 16 };
  const status = o.settingsStatus || 'ready';
  // Emulate the Host: apply an op list to the document the way the real
  // `settings.mutate` does, so the card's post-save read-back verification can
  // actually succeed.
  const applyOps = (ops) => {
    for (const op of ops) {
      const field = op.path[0];
      if (op.op === 'set') settingsValue[field] = op.value;
      else if (op.op === 'unset') delete settingsValue[field];
    }
  };
  const scope = {
    getSnapshot: () => ({ status, value: status === 'ready' ? settingsValue : undefined, writable: true, revision: 3 }),
    subscribe: () => () => {},
    set: (k, v) => { writes.push([k, v]); settingsValue[k] = v; return Promise.resolve(); },
    unset: (k) => { delete settingsValue[k]; return Promise.resolve(); },
    mutate: (ops) => { mutations.push(ops); applyOps(ops); return Promise.resolve(); }
  };
  const directoryStore = {
    getSnapshot: () => ({
      // `effort` is parameterised so a test can put the control at MAX, which is
      // the only tier where the gradient class and the chip sweep exist.
      // `effortBox` is a MUTABLE holder: flipping it between renders is how a test
      // simulates the user switching tier while the panel is open, which is the
      // only situation the chip flourish is allowed to fire in.
      // `current` is overridable for the one case the default cannot express: a
      // SELECTED model on a route whose ids are codenames. The composer trigger
      // and the capsule caption resolve the brand of the CURRENT model, so
      // branding them cannot be exercised through `groups` alone.
      current: o.current || { provider: 'deepseek-official', model: 'deepseek-v4-flash', reasoningEffort: o.effortBox ? o.effortBox.value : (o.effort || 'high') },
      routable: true,
      status: o.state ? o.state.storeStatus : 'ready',
      error: null, failures: [],
      // `groups` is overridable so a test can put providers in the catalog whose
      // brand cannot be resolved, which is the only way to exercise the empty
      // brand slot in the model dropdown.
      groups: o.groups || [{ id: 'deepseek-official', name: 'DeepSeek', models: [{ id: 'deepseek-v4-flash', name: o.modelName === undefined ? 'DeepSeek V4 Flash' : o.modelName, reasoning: { defaultEffort: 'high', efforts: [{ id: 'low', name: 'Low' }, { id: 'high', name: 'High' }, { id: 'max', name: 'Max' }] } }] }]
    }),
    subscribe: () => () => {}
  };
  const ctx = {
    effect: (fn) => { const d = fn(); return typeof d === 'function' ? d : () => {}; },
    on: () => () => {},
    get: () => undefined,
    // The dictionary stub answers with the KEY (tests pin keys, never copy) and
    // records every call, so a test can still read WHAT a string was given — the
    // hidden-provider count in the picker footer, say — without duplicating copy
    // here. `localeCalls` is module-level for the same reason `clientErrors` is.
    locale: {
      register: () => () => {},
      bind: () => (key, params) => {
        localeCalls.push({ key: key, params: params });
        return params
          ? String(key).replace(/\{(\w+)\}/g, (whole, name) => (Object.prototype.hasOwnProperty.call(params, name) ? String(params[name]) : whole))
          : key;
      }
    },
    slots: {
      // A real slot registry only fires the callback once the NAMED slot
      // exists; injecting into a slot nobody declares leaves the registration
      // unmade (this is how the removed `settings.plugin.item` fails on
      // 0.1.7-rc.1 — silently, with no card). The mock models that, so a wrong
      // slot name in the source actually costs the test its registration
      // instead of passing anyway. The returned disposer is the inject
      // CONTROLLER: disposing it must dispose whatever the callback registered,
      // exactly as the real service does (a registration withdrawn with its
      // namespace would otherwise look permanent to the ledger assertions).
      inject: (key, cb) => {
        injectedSlotNames.push(key);
        let live = null;
        if (SLOT_NAMES.indexOf(key) !== -1) { live = cb(); }
        return () => {
          if (typeof live === 'function') { live(); live = null; }
          else if (Array.isArray(live)) { for (const d of live) if (typeof d === 'function') d(); live = null; }
        };
      },
      // `o.registerThrows` names a slot whose registration fails. 0.2.0-rc.1 made
      // `slots.register` a HARD error (an undeclared slot, or a second entry in one
      // cell at the same priority), and `slots.inject` now re-throws an inject
      // callback's failure from a microtask instead of swallowing it, so a test has
      // to be able to drive that path deliberately.
      register: (options, component) => {
        if (o.registerThrows === options.name) {
          throw new Error('slot "' + options.name + '" already has a registration at priority 0 (0.2.0-rc.1 turns this into a hard error)');
        }
        registrations.push({ options, component });
        return () => {
          const at = registrations.findIndex((r) => r.options === options);
          if (at >= 0) registrations.splice(at, 1);
          disposedRegistrations.push(options);
        };
      }
    },
    // 0.1.7-rc.1 replaced the `settingsScope` service with `configForms`. The
    // mock mirrors the real shape: the service hands out one form controller
    // per HOST PROFILE ENTRY id, and that controller answers the same face the
    // plugin already used (getSnapshot / subscribe / set / unset / mutate).
    //
    // There is deliberately no `describe()` here any more. The 可选提供商 panel is
    // built from `remote.session.modelCatalog()` — the Host's own provider list —
    // rather than from the cross-namespace settings mirror the page uses, because
    // the mirror's provider rows are the very thing the switches FILTER (see the
    // panel's own comment). A mock face nothing calls would only rot.
    configForms: {
      get: (entryId) => { configFormIds.push(entryId); return scope; }
    },
    modelDirectories: {
      directoryFor: () => {
        if (o.state && o.state.directoryThrows) throw new Error('ui-model-selection: session "s" resolved no scope');
        if (o.directoryThrows) throw new Error('ui-model-selection: session "s" resolved no scope');
        return {
          store: directoryStore,
          load: () => {
            if (o.state) { o.state.loadCalls += 1; o.state.storeStatus = 'ready'; }
            return Promise.resolve();
          },
          select: (selection) => { selects.push(selection); return Promise.resolve(true); }
        };
      }
    },
    sessions: { subagentAddress: () => (o.subagent ? { agentId: 'sub-1' } : undefined) },
    // `remote.session.modelCatalog()` is where the 可选提供商 panel gets its
    // provider list (`o.catalog`, defaulting to the empty catalog). `o.noCatalog`
    // models a deployment whose remote face is absent, which must degrade to the
    // panel's "could not read" line rather than throw. `$on` records the adapter
    // subscription so a test can fire it, as the Host would.
    remote: {
      session: {
        modelCatalog: () => {
          if (o.noCatalog) throw new Error('cannot get property "session" without inject');
          return Promise.resolve({ ok: true, value: o.catalog || { groups: [] } });
        }
      },
      $on: (event, handler) => { adapterHandlers.push({ event, handler }); return () => {}; }
    },
    inject: (deps, cb) => { cb({ slots: ctx.slots, modelDirectories: ctx.modelDirectories, sessions: ctx.sessions }); return () => {}; }
  };
  return {
    ctx, registrations, writes, mutations, selects, configFormIds, injectedSlotNames, disposedRegistrations, settingsValue,
    /** Fire the adapter-change event the panel refreshes on, as the Host would. */
    fireAdaptersUpdated: () => { for (const entry of adapterHandlers.slice()) entry.handler(); },
    adapterSubscriptions: () => adapterHandlers.map((entry) => entry.event)
  };
}

// ---- renderer with error-boundary semantics --------------------------------
function renderNode(node, depth) {
  if (node === null || node === undefined || typeof node === 'boolean') return;
  if (Array.isArray(node)) { for (const n of node) renderNode(n, depth); return; }
  if (!node.__el) return;
  const { type, props, children } = node;
  if (type === React.Fragment) { for (const c of children) renderNode(c, depth); return; }
  if (typeof type === 'function') {
    if (type.prototype && type.prototype.isReactComponent) {
      const instance = new type(props);
      if (typeof instance.componentDidMount === 'function') instance.componentDidMount();
      for (let pass = 0; pass < 3; pass++) {
        resetHooks();
        try {
          renderNode(instance.render(), depth + 1);
          return;
        } catch (error) {
          const derived = typeof type.getDerivedStateFromError === 'function' ? type.getDerivedStateFromError(error) : null;
          if (!derived) throw error;
          instance.state = { ...instance.state, ...derived };
          if (typeof instance.componentDidCatch === 'function') instance.componentDidCatch(error);
        }
      }
      resetHooks();
      renderNode(instance.render(), depth + 1);
      return;
    }
    // A nested component must NOT steal the outer component's captured effects.
    // `resetHooks()` clears `capturedEffects`, and an outer component registers its
    // hooks/effects BEFORE its element tree is walked — so descending into any child
    // function component used to leave `runEffects()` with nothing to run at all (the
    // symptom: the effects of the component under test silently never executed).
    // Effects captured inside the child are APPENDED to the outer list rather than
    // replacing it, because React runs a child's effects alongside its parent's; the
    // `resetHooks()` below still gives the child its own hook slots, as before.
    const outerEffects = capturedEffects;
    const outerIndex = hookIndex;
    resetHooks();
    renderNode(type({ ...props, children }), depth + 1);
    capturedEffects = outerEffects.concat(capturedEffects);
    hookIndex = outerIndex;
    return;
  }
  for (const c of children) renderNode(c, depth);
}

const seatOf = (regs) => regs.find((r) => r.options.name === 'conversation.input.model');
const rowOf = (regs, id) => regs.find((r) => r.options.id === id);
// The settings card moved from the removed `settings.plugin.item` slot to
// `plugins.item` in 0.1.7-rc.1, where every shipped configuration card lives.
const cardOf = (regs) => regs.find((r) => r.options.name === 'plugins.item');
/**
 * Expand function/class components into their rendered element tree so
 * `findAll` can traverse it. `renderNode` discards the tree it builds, so a
 * test that needs to inspect or click rendered elements uses this instead.
 * Hook state persists across calls (module-level `hookState`), which is what
 * lets a click in one expansion be observed by the next.
 */
function expand(node, depth) {
  if (node === null || node === undefined || typeof node === 'boolean') return node;
  if (Array.isArray(node)) return node.map((n) => expand(n, depth));
  if (!node.__el) return node;
  const { type, props, children } = node;
  if (type === React.Fragment) return { ...node, children: children.map((c) => expand(c, depth)) };
  if (typeof type === 'function') {
    // Descending into a child function component must not steal the OUTER component's
    // captured effects: `resetHooks()` clears them, and an outer component registers
    // its effects BEFORE its element tree is walked, so a nested component (such as the
    // brand-icon component rendered in the panel caption) would leave `runEffects()`
    // with nothing to run at all. Child effects are appended to the outer list the way
    // React runs them alongside the parent's.
    const outerEffects = capturedEffects;
    const outerIndex = hookIndex;
    if (type.prototype && type.prototype.isReactComponent) {
      const instance = new type(props);
      if (typeof instance.componentDidMount === 'function') instance.componentDidMount();
      resetHooks();
      const out = expand(instance.render(), depth + 1);
      capturedEffects = outerEffects.concat(capturedEffects);
      hookIndex = outerIndex;
      return out;
    }
    resetHooks();
    const out = expand(type({ ...props, children }), depth + 1);
    capturedEffects = outerEffects.concat(capturedEffects);
    hookIndex = outerIndex;
    return out;
  }
  return { ...node, children: children.map((c) => expand(c, depth)) };
}
/** Collect every rendered element whose props satisfy `pred`. */
function findAll(node, pred, out) {
  const acc = out || [];
  if (node === null || node === undefined || typeof node === 'boolean') return acc;
  if (Array.isArray(node)) { for (const n of node) findAll(n, pred, acc); return acc; }
  if (!node.__el) return acc;
  if (pred(node.props)) acc.push(node);
  for (const c of node.children) findAll(c, pred, acc);
  return acc;
}
let failures = 0;
let total = 0;
/** Labels of checks that returned a promise; the runner awaits them before reporting. */
const pending = [];
function check(label, fn) {
  total += 1;
  try {
    const answer = fn();
    // A check that returns a promise is one of the few that must observe an async
    // path (the 可选提供商 panel's catalog load). Its failure is recorded when it
    // settles, and the summary below waits for every one of them — a check that
    // silently resolved after the summary would be a lie.
    if (answer && typeof answer.then === 'function') {
      const settled = answer.then(
        () => { console.log('PASS', label); },
        (error) => { failures += 1; console.log('FAIL', label, '->', error && error.message); }
      );
      pending.push(settled);
      return;
    }
    console.log('PASS', label);
  }
  catch (error) { failures += 1; console.log('FAIL', label, '->', error && error.message, process.env.DMS_TRACE ? '\n' + (error && error.stack) : ''); }
}

// 1. module + apply + every registration renders. The feature now contributes
// ONE card to the Plugins section, the conditional composer seat, and the
// 可选提供商 panel in the Models settings footer.
check('apply() registers the plugins card and renders it', () => {
  const made = makeCtx({});
  const { ctx, registrations } = made;
  loadModule().apply(ctx);
  const bySlot = (name) => registrations.filter((r) => r.options.name === name);
  if (bySlot('plugins.item').length !== 1) throw new Error('expected one plugins.item card, got ' + bySlot('plugins.item').length);
  if (bySlot('conversation.input.model').length !== 1) throw new Error('expected one composer seat, got ' + bySlot('conversation.input.model').length);
  if (bySlot('settings.models.footer').length !== 1) {
    throw new Error('expected one optional-provider panel, got ' + bySlot('settings.models.footer').length);
  }
  // A LIST slot needs an id of our own; reusing a shipped one would replace it.
  if (bySlot('settings.models.footer')[0].options.id !== 'dsh-modef-providers') {
    throw new Error('the provider panel id is ' + JSON.stringify(bySlot('settings.models.footer')[0].options.id));
  }
  if (registrations.length !== 3) throw new Error('expected 3 registrations, got ' + registrations.length);
  const card = cardOf(registrations);
  if (!card) throw new Error('plugins.item card not registered');
  // `plugins.item` is a LIST slot: `id` is our own cell key (it must be our
  // own, not a shipped one, or we would replace that occupant), and the card
  // is titled through `label`.
  if (card.options.id !== 'dsh-modef') throw new Error('card id is ' + JSON.stringify(card.options.id) + ', expected "dsh-modef"');
  if (typeof card.options.label !== 'function') throw new Error('card label is not a thunk, so it would not follow the locale');
  if (typeof card.options.order !== 'number') throw new Error('card order is not a number: ' + JSON.stringify(card.options.order));
  // Our settings document is addressed by the HOST PROFILE ENTRY id, which the
  // bundle's cordis.patch.yml declares as `dsh-modef`.
  if (made.configFormIds.indexOf('dsh-modef') === -1) {
    throw new Error('configForms was never asked for the "dsh-modef" entry, got ' + JSON.stringify(made.configFormIds));
  }
  // The slots this plugin registers into must be slots 0.1.7-rc.1 DECLARES.
  // `settings.plugin.item` was removed in that release; naming it here leaves
  // the card unregistered with nothing to show for it.
  for (const slot of made.injectedSlotNames) {
    if (SLOT_NAMES.indexOf(slot) === -1) {
      throw new Error('the plugin injects into an undeclared slot: ' + JSON.stringify(slot));
    }
  }
  if (made.injectedSlotNames.indexOf('plugins.item') === -1) {
    throw new Error('the plugin never injected into plugins.item, got ' + JSON.stringify(made.injectedSlotNames));
  }
  // The fiber's inject list decides whether the plugin activates AT ALL: a
  // service nobody provides leaves it at "pending (waiting for service: X)"
  // forever, which is how three other plugins broke on this upgrade. 0.1.7-rc.1
  // removed `settingsScope`, so requiring it here would be fatal, and the
  // replacement `configForms` must be named instead.
  const inject = loadModule().inject;
  if (!Array.isArray(inject)) throw new Error('the module exports no inject list');
  if (inject.indexOf('settingsScope') !== -1) {
    throw new Error('the fiber still injects settingsScope, which 0.1.7-rc.1 removed');
  }
  if (inject.indexOf('configForms') === -1) {
    throw new Error('the fiber does not inject configForms: ' + JSON.stringify(inject));
  }
  // The rest were checked against the running build and still exist; keep them
  // named so a future edit cannot quietly drop one the composer depends on.
  for (const needed of ['locale', 'slots', 'modelDirectories', 'sessions', 'remote', 'remote.session']) {
    if (inject.indexOf(needed) === -1) {
      throw new Error('the fiber stopped injecting ' + needed + ': ' + JSON.stringify(inject));
    }
  }
  for (const reg of registrations) {
    const injected = typeof reg.options.inject === 'function' ? reg.options.inject('session-1') : {};
    renderNode(reg.component({ ...injected }), 0);
  }
});

// 1c. The fallback is load-bearing: a throwing slot entry is RETIRED by the
// ledger, so if the shell's primitives package (or one of its exports) is
// missing, the card must still render its own hand-drawn switch instead of
// throwing. The card no longer owns an accordion — `plugins.item` renders it
// with `view: 'page'` when the Plugins page opens the card, and that page owns
// the chevron — so the page view is rendered directly.
check('card degrades to hand-drawn switch without primitives', () => {
  const made = makeCtx({});
  loadModule({ noPrimitives: true }).apply(made.ctx);
  const card = cardOf(made.registrations);
  const injected = card.options.inject();
  hookState.length = 0;

  const tree = expand(card.component({ ...injected, view: 'page' }));

  const switches = findAll(tree, (p) => p.role === 'switch');
  if (switches.length !== 3) throw new Error('expected 3 fallback switches (master + collapse + glass), got ' + switches.length);
  for (const sw of switches) {
    if (String(sw.props.className).indexOf('dms-switch') !== 0) throw new Error('fallback switch lost its class: ' + sw.props.className);
    if (typeof sw.props.onClick !== 'function') throw new Error('fallback switch is missing its click handler');
  }
  // The one-liner view must not throw either: the Plugins page renders it on
  // the collapsed card, and a throw there retires the entry for the page's life.
  const summary = expand(card.component({ ...injected, view: 'summary' }));
  if (typeof summary !== 'string' || summary.length === 0) {
    throw new Error('the summary view is not a plain one-liner: ' + JSON.stringify(summary));
  }
});

// 1b. The card body renders when the page asks for it, and saving commits ONE
// atomic mutation carrying every field. `plugins.item` renders the entry as the
// one-liner (`view: 'summary'`) on the card and as the form (`view: 'page'`)
// once the card is opened — the accordion belongs to the Plugins page now, so
// there is no header to click here.
check('expanded card stages a draft and saves it as one atomic mutation', () => {
  const made = makeCtx({});
  loadModule().apply(made.ctx);
  const card = cardOf(made.registrations);
  const injected = card.options.inject();
  hookState.length = 0;   // drop hook state left by earlier renders

  let tree = expand(card.component({ ...injected, view: 'page' }));

  // The three sliding switches (master + collapse-providers + glass), in that
  // order. They are
  // role="switch" buttons, NOT checkboxes: the card uses the shell's Switch
  // primitive so it matches every other switch in Settings. The primitive
  // renders a <button>, reports state through aria-checked (never a parallel
  // class), and fires its handler with no event argument.
  const switches = findAll(tree, (p) => p.role === 'switch');
  if (switches.length !== 3) throw new Error('expected 3 switches, got ' + switches.length);
  for (const sw of switches) {
    if (sw.type !== 'button') throw new Error('switch is not a button: ' + sw.type);
    if (typeof sw.props.onClick !== 'function') throw new Error('switch is missing its click handler');
    if (typeof sw.props['aria-checked'] !== 'boolean') throw new Error('switch is missing a boolean aria-checked');
    if (typeof sw.props['aria-label'] !== 'string') throw new Error('switch is missing its aria-label');
  }
  // Toggling the master switch reports the NEXT value (not an event object).
  switches[0].props.onClick();

  // Re-render the page view: the previous tree's handlers closed over the
  // pre-click render.
  tree = expand(card.component({ ...injected, view: 'page' }));
  const save = findAll(tree, (p) => p.className === 'dms-cardSave')[0];
  if (!save) throw new Error('save button not found');
  if (save.props.disabled) throw new Error('save should be enabled after a staged change');
  save.props.onClick();

  if (made.mutations.length !== 1) throw new Error('expected exactly 1 mutation, got ' + made.mutations.length);
  const ops = made.mutations[0];
  const setAdvanced = ops.find((op) => op.path[0] === 'advancedEffort');
  if (!setAdvanced || setAdvanced.op !== 'set' || setAdvanced.value !== false) {
    throw new Error('advancedEffort was not committed as false: ' + JSON.stringify(ops));
  }
  // Every declared field travels in the same atomic call.
  for (const field of ['advancedEffort', 'effortStyle', 'trackShape', 'collapseProviders', 'glassPanel', 'glassOpacity', 'glassBlur']) {
    if (!ops.some((op) => op.path[0] === field)) throw new Error('field missing from the mutation: ' + field);
  }
  // Ops must be plain JSON: the real scope structuredClones them on the way in.
  JSON.stringify(ops);
});

// 1b-ter. The card answers the 0.1.7-rc.1 `plugins.item` contract, which is a
// TWO-VIEW entry: the Plugins page renders it once as the card's one-liner
// (`view: 'summary'`) and once as the body of the page the card opens
// (`view: 'page'`). The page owns the list item, the title, the chevron and the
// open/close state, so the entry must draw NONE of that itself — a nested
// accordion is the failure this pins. Same shape the shipped cards use: a bare
// text line for `summary`, a bare form for `page`.
check('the plugins card answers the summary and page views', () => {
  const made = makeCtx({});
  loadModule().apply(made.ctx);
  const card = cardOf(made.registrations);
  const injected = card.options.inject();

  hookState.length = 0;
  const summary = expand(card.component({ ...injected, view: 'summary' }));
  // A plain string: the owner drops it straight into its own description row,
  // so an element here would nest block content inside that one line.
  if (typeof summary !== 'string') throw new Error('summary view returned ' + typeof summary + ', not a one-liner string');
  if (summary.length === 0) throw new Error('summary view is empty');

  hookState.length = 0;
  const page = expand(card.component({ ...injected, view: 'page' }));
  // The body must be its own container — and must NOT be a list item, a
  // heading, or an accordion trigger: the owner supplies all three.
  if (page.type !== 'div') throw new Error('page view root is <' + String(page.type) + '>, expected div');
  if (page.props.className !== 'dms-cardBody') throw new Error('page view root class is ' + JSON.stringify(page.props.className));
  for (const gone of ['li', 'button']) {
    if (page.type === gone) throw new Error('page view root is a <' + gone + '>, which belongs to the page chrome');
  }
  // No chevron and no aria-expanded anywhere in either view: the open state is
  // the page's, and a second one would disagree with it.
  for (const view of [summary, page]) {
    const tree = typeof view === 'string' ? null : view;
    if (tree === null) continue;
    if (findAll(tree, (p) => p['aria-expanded'] !== undefined).length > 0) {
      throw new Error('the entry still renders its own accordion trigger');
    }
    if (findAll(tree, (p) => p.viewBox === '0 0 14 14').length > 0) {
      throw new Error('the entry still renders its own chevron');
    }
  }
});

// 1b-bis. 「折叠模型供应商」. ON is the default, so the card must read an UNSET
// key as ON, and the two directions must stage opposite ops: turning it OFF
// writes one boolean, turning it back ON removes the key again. Storing the
// default would litter the settings document for every install that never
// touches this switch.
check('the collapse-providers switch stages the opt-out and the removal', () => {
  /** Render the page view, click `clickSwitch`, save, and return the staged ops. */
  const stage = (committed, clickSwitch) => {
    const made = makeCtx({
      settingsValue: Object.assign(
        { advancedEffort: true, effortStyle: 'spray-flow', trackShape: 'capsule', glassPanel: true },
        committed || {}
      )
    });
    loadModule().apply(made.ctx);
    const card = cardOf(made.registrations);
    const injected = card.options.inject();
    hookState.length = 0;
    resetHooks();
    let tree = expand(card.component({ ...injected, view: 'page' }));
    // The mock locale returns the KEY itself, so the label is the key.
    const sw = findAll(tree, (p) => p.role === 'switch' && p['aria-label'] === 'settings.collapse.title')[0];
    if (!sw) throw new Error('the card has no 折叠模型供应商 switch');
    const before = sw.props['aria-checked'];
    if (clickSwitch) {
      sw.props.onClick();
      tree = expand(card.component({ ...injected, view: 'page' }));
      const save = findAll(tree, (p) => p.className === 'dms-cardSave')[0];
      if (!save) throw new Error('save button not found');
      if (save.props.disabled) throw new Error('save stayed disabled after the collapse switch was staged');
      save.props.onClick();
    }
    if (made.mutations.length !== (clickSwitch ? 1 : 0)) {
      throw new Error('expected ' + (clickSwitch ? 1 : 0) + ' mutation(s), got ' + made.mutations.length);
    }
    const ops = clickSwitch ? made.mutations[0] : null;
    return { before, ops, op: ops ? ops.find((o) => o.path[0] === 'collapseProviders') : null };
  };

  // An untouched install: no key at all, and the switch reads ON.
  const fresh = stage(null, false);
  if (fresh.before !== true) throw new Error('the switch does not default to ON: ' + String(fresh.before));
  // Turning it off is the only state worth storing.
  const off = stage(null, true);
  if (!off.op || off.op.op !== 'set' || off.op.value !== false) {
    throw new Error('turning folding off did not stage `set false`: ' + JSON.stringify(off.op));
  }
  // Turning it back on removes the key rather than writing the default.
  const back = stage({ collapseProviders: false }, true);
  if (back.before !== false) throw new Error('a committed `false` did not reach the switch: ' + String(back.before));
  if (!back.op || back.op.op !== 'unset') {
    throw new Error('turning folding back on did not stage an unset: ' + JSON.stringify(back.op));
  }
});

// 2. spray-flow style + glass on renders the whole max-tier tree
check('composer seat renders the spray-flow max-tier tree', () => {
  const { ctx, registrations } = makeCtx({});
  loadModule().apply(ctx);
  const seat = seatOf(registrations);
  const injected = seat.options.inject('session-1');
  if (!injected.directory) throw new Error('directory missing');
  renderNode(seat.component(injected), 0);
});

// 2b. A SAVED style that no longer exists must fall back, not break: removing
// the 彩虹猫 style leaves `effortStyle: "nyancat"` behind in any profile that had
// selected it. The whitelist (`styleById` / EFFECT_STYLES.some) has to fold that
// back to the default at BOTH ends — the composer seat's live style and the
// settings card's dropdown — and the deleted style's classes must be gone from
// every rendered tree.
check('a saved style that was removed falls back to the default', () => {
  const gone = makeCtx({ effort: 'max', settingsValue: { advancedEffort: true, effortStyle: 'nyancat', trackShape: 'capsule' } });
  loadModule().apply(gone.ctx);
  const seat = seatOf(gone.registrations);
  const injected = seat.options.inject('session-1');
  hookState.length = 0;
  let tree = expand(seat.component({ ...injected }));
  const trigger = findAll(tree, (p) => p && p.className === 'dms-effortTrigger')[0];
  if (trigger && trigger.props && trigger.props.onClick) trigger.props.onClick();
  for (let i = 0; i < 4; i += 1) { runEffects(); resetHooks(); tree = expand(seat.component({ ...injected })); }
  const html = JSON.stringify(tree);
  for (const dead of ['dms-rainbow', 'dms-nyanCat', 'dms-nyanPix', 'dms-thumbNyan', 'dms-sliderNyan', 'dms-rangeNyan']) {
    if (html.indexOf(dead) !== -1) throw new Error('the removed style still renders ' + dead);
  }
  // …and it must fall back to the DEFAULT style, not merely render nothing: the
  // fallback used to be "the id is unknown", which is invisible until you look
  // for the default's own runtime marker. At MAX the spray-flow fill carries
  // `dms-fx-spray-flow`, so a live MAX panel proves which style actually won.
  if (html.indexOf('dms-fx-spray-flow') === -1) {
    throw new Error('the seat did not fall back to the default style (no dms-fx-spray-flow at MAX)');
  }
  // The card's dropdown must not offer it either, and must show the fallback.
  // The stub locale returns the KEY, so the field is found by the aria-label it
  // is given, and its options are read off the select node's own children.
  const card = cardOf(gone.registrations);
  const cardInjected = card.options.inject();
  hookState.length = 0;
  const cardTree = expand(card.component({ ...cardInjected, view: 'page' }));
  const select = findAll(cardTree, (p) => p && p['aria-label'] === 'settings.style.title')[0];
  if (!select) throw new Error('the style dropdown is gone from the card');
  // The options are the select's child array (one `EFFECT_STYLES.map(...)`), so
  // flatten one level before reading their `value`s.
  const flat = [];
  for (const child of select.children || []) {
    if (Array.isArray(child)) flat.push(...child);
    else flat.push(child);
  }
  const values = flat.map((c) => c && c.props && c.props.value);
  if (values.indexOf('nyancat') !== -1) throw new Error('the removed style is still offered: ' + JSON.stringify(values));
  if (values.join(',') !== 'spray-flow,undertow,cosmos,sunset') {
    throw new Error('the surviving styles are ' + JSON.stringify(values));
  }
  // The CURRENT value must be the fallback, not the dead id: a select whose value
  // matches no option renders blank, which is how a removed style would look.
  if (select.props.value !== 'spray-flow') {
    throw new Error('the dropdown did not fall back to the default: ' + JSON.stringify(select.props.value));
  }
});

// cosmos style: only changes max-tier, renders white-blue fluid tree at MAX
check('composer seat renders the cosmos max-tier fluid tree only at MAX', () => {
  const openPanelTree = (effort) => {
    const made = makeCtx({
      effort: effort,
      settingsValue: { advancedEffort: true, effortStyle: 'cosmos', trackShape: 'capsule' }
    });
    loadModule().apply(made.ctx);
    const seat = seatOf(made.registrations);
    const injected = seat.options.inject('session-1');
    hookState.length = 0;
    let tree = expand(seat.component({ ...injected }));
    const trigger = findAll(tree, (p) => p && p.className === 'dms-effortTrigger')[0];
    if (trigger && trigger.props && trigger.props.onClick) trigger.props.onClick();
    for (let i = 0; i < 4; i += 1) { runEffects(); resetHooks(); tree = expand(seat.component({ ...injected })); }
    return tree;
  };

  // 1. Non-MAX tier (high): fill must NOT have dms-fillMax or dms-fx-cosmos (opacity gated by CSS)
  const treeHigh = openPanelTree('high');
  const fillsHigh = findAll(treeHigh, (p) => p && typeof p.className === 'string' && /(^|\s)dms-fill(\s|$)/.test(p.className));
  if (fillsHigh.length === 0) throw new Error('dms-fill missing at high tier');
  const highFill = fillsHigh[0];
  if (highFill.props.className.indexOf('dms-fillMax') !== -1) {
    throw new Error('dms-fillMax present at high tier: ' + highFill.props.className);
  }
  if (highFill.props.className.indexOf('dms-fx-cosmos') !== -1) {
    throw new Error('dms-fx-cosmos active at high tier: ' + highFill.props.className);
  }

  // 2. MAX tier: fill gets dms-fx-cosmos and renders fluid elements & drops
  const treeMax = openPanelTree('max');
  // More opens (any tier): TWENTY rolls give the cross-roll sameness guards
  // below statistical teeth — a pinned value fails certainly, while honest
  // random rolls collide with vanishing probability. The direction check is
  // the binding one: it is Bernoulli, so a single layer is all-same over N
  // rolls with probability 2*2^-N. At N=12 that was 0.049% per layer (~0.29%
  // per suite run across both effects' six layers), which really did fire —
  // one flake in 100 runs. N=20 drops it to 0.0011% per run while leaving the
  // guard's teeth untouched (a pinned direction is all-same in EVERY roll).
  for (let i = 0; i < 18; i += 1) openPanelTree('high');
  const fillsMax = findAll(treeMax, (p) => p && typeof p.className === 'string' && p.className.indexOf('dms-fillMax') !== -1);
  if (fillsMax.length === 0) throw new Error('dms-fillMax missing at max tier');
  const maxFill = fillsMax[0];
  if (maxFill.props.className.indexOf('dms-fx-cosmos') === -1) {
    throw new Error('dms-fx-cosmos missing from fillClass at max tier: ' + maxFill.props.className);
  }
  const cosmosMax = findAll(treeMax, (p) => p && typeof p.className === 'string' && p.className.indexOf('dms-fillCosmos') !== -1);
  if (cosmosMax.length === 0) throw new Error('dms-fillCosmos element missing at max tier');

  const base = findAll(treeMax, (p) => p && p.className === 'dms-cosmosFluidBase');
  if (base.length === 0) throw new Error('dms-cosmosFluidBase missing');
  const mid = findAll(treeMax, (p) => p && p.className === 'dms-cosmosFluidMid');
  if (mid.length === 0) throw new Error('dms-cosmosFluidMid missing');
  const top = findAll(treeMax, (p) => p && p.className === 'dms-cosmosFluidTop');
  if (top.length === 0) throw new Error('dms-cosmosFluidTop missing');
  // Exactly THREE continuous layers: base current + sky-blue blobs + white-blue wisps.
  // There must be no fourth, one-shot "pour" layer: mounted-once keyframes would
  // animate (invisibly) below MAX and be finished before MAX is ever reached.
  const fluidLayers = findAll(treeMax, (p) => p && typeof p.className === 'string' && /^dms-cosmosFluid(Base|Mid|Top)$/.test(p.className));
  if (fluidLayers.length !== 3) {
    throw new Error('expected exactly 3 cosmos fluid layers, got ' + fluidLayers.length + ': ' + fluidLayers.map((f) => f.props.className).join(' / '));
  }
  const pour = findAll(treeMax, (p) => p && typeof p.className === 'string' && p.className.indexOf('dms-cosmosFluidPour') !== -1);
  if (pour.length !== 0) throw new Error('expected 0 one-shot pour layers, got ' + pour.length);

  // Must have NO spark drops or caustic glow sweeps
  const drops = findAll(treeMax, (p) => p && typeof p.className === 'string' && p.className.indexOf('dms-cosmosDrop') !== -1);
  if (drops.length !== 0) throw new Error('expected 0 spark drops, got ' + drops.length);
  const caustics = findAll(treeMax, (p) => p && typeof p.className === 'string' && p.className.indexOf('dms-cosmosCaustic') !== -1);
  if (caustics.length !== 0) throw new Error('expected 0 caustics, got ' + caustics.length);

  // ------------------------------------------------------------------
  // The MAX panel backdrop (淡蓝白流体浮层) was REMOVED by request. Assert it is
  // gone from BOTH halves — a leftover element, stylesheet rule or keyframe
  // would be dead weight, and a half-removal is exactly the kind of thing that
  // silently comes back. The cosmos max-tier BAR effect is a separate feature
  // and must remain fully intact (asserted right below).
  // ------------------------------------------------------------------
  for (const tree of [treeHigh, treeMax]) {
    const leftover = findAll(tree, (p) => p && typeof p.className === 'string' && p.className.indexOf('dms-panelFluid') !== -1);
    if (leftover.length !== 0) {
      throw new Error('the removed panel fluid layer is still being rendered: ' + leftover.length + ' element(s)');
    }
  }
  const panelKindsNow = (() => {
    // (expand() copies nodes, so address the panel by class rather than identity.)
    const panelEl = findAll(treeMax, (p) => p && typeof p.className === 'string' && /(^|\s)dms-panel(\s|$)/.test(p.className))[0];
    if (!panelEl) throw new Error('panel not found at MAX');
    return (panelEl.children || []).filter(Boolean).map((c) => String((c.props || {}).className));
  })();
  if (panelKindsNow.some((k) => k.indexOf('dms-panelFluid') !== -1)) {
    throw new Error('the panel still mounts the removed fluid backdrop: ' + panelKindsNow.join(' / '));
  }
  for (const dead of ['dms-panelFluid', 'dms-pfluid']) {
    if (injectedCss.indexOf(dead) !== -1) {
      throw new Error('orphan stylesheet rule for the removed panel fluid is still injected: ' + dead);
    }
  }
  if (source.indexOf('panelFluid') !== -1 || source.indexOf('pfluid') !== -1) {
    throw new Error('the removed panel fluid effect is still referenced in lib/client.js');
  }
  const rmNow = /@media \(prefers-reduced-motion:reduce\)\{([^]*)\}$/.exec(injectedCss.trim());
  if (!rmNow || rmNow[1].indexOf('dms-cosmosFluidBase') === -1) {
    throw new Error('the reduced-motion freeze lost the cosmos layers');
  }

  // Fluid-wander keyframes injected; the retired one-way-current keyframes,
  // stripe keyframes and stripe gradients are all gone.
  for (const kf of ['dms-fluid-wander-a', 'dms-fluid-wander-b', 'dms-fluid-wander-c']) {
    if (injectedCss.indexOf('@keyframes ' + kf) === -1) throw new Error('missing keyframes: ' + kf);
  }
  for (const gone of ['dms-fluid-surge', 'dms-fluid-flow', 'dms-fluid-swell', 'dms-cosmos-flow', 'dms-cosmos-drift', 'dms-cosmos-mix-a', 'dms-cosmos-mix-b', 'dms-cosmosFluidSwell', 'dms-cosmosFluidPour', 'dms-fluid-pour']) {
    if (injectedCss.indexOf(gone) !== -1) throw new Error('stale stripe/fluid reference still in stylesheet: ' + gone);
  }
  for (const stripe of ['repeating-linear-gradient', 'dms-cosmos-mix']) {
    if (injectedCss.indexOf(stripe) !== -1) throw new Error('stripe gradient still present: ' + stripe);
  }

  // The ground is LIGHT — the reference look is a white-blue body of water
  // with blue patches wandering through it; a dark base would invert that.
  const ground = /\.dms-fillMax\.dms-fx-cosmos\{[^}]*background-color:#([0-9a-fA-F]{6})/.exec(injectedCss);
  if (!ground) throw new Error('cosmos max-tier ground colour rule missing');
  const lum = (0.2126 * parseInt(ground[1].slice(0, 2), 16)
    + 0.7152 * parseInt(ground[1].slice(2, 4), 16)
    + 0.0722 * parseInt(ground[1].slice(4, 6), 16)) / 255;
  if (lum < 0.75) {
    throw new Error('cosmos ground #' + ground[1] + ' is too dark (luminance ' + lum.toFixed(2) + '); the style is a LIGHT fluid with blue patches, not a deep-blue river');
  }

  const kfBody = (name) => {
    const at = injectedCss.indexOf('@keyframes ' + name);
    if (at === -1) return null;
    const open = injectedCss.indexOf('{', at);
    let depth = 0;
    for (let i = open; i < injectedCss.length; i += 1) {
      if (injectedCss[i] === '{') depth += 1;
      else if (injectedCss[i] === '}') { depth -= 1; if (depth === 0) return injectedCss.slice(open, i + 1); }
    }
    return null;
  };
  const LAYER_OF = {
    'dms-fluid-wander-a': 'dms-cosmosFluidBase',
    'dms-fluid-wander-b': 'dms-cosmosFluidMid',
    'dms-fluid-wander-c': 'dms-cosmosFluidTop'
  };

  // IRREGULAR WANDER ("不规律运动") invariants, per layer:
  for (const [name, cls] of Object.entries(LAYER_OF)) {
    const body = kfBody(name);
    if (!body) throw new Error('missing keyframes: ' + name);
    const rule = new RegExp('\\.' + cls + '\\{([^}]*)\\}').exec(injectedCss);
    if (!rule) throw new Error('missing cosmos layer rule: ' + cls);
    // 1. Organic easing: a liquid swells and settles. `linear` is the timing
    //    of the retired one-way current and reads as a mechanical march here.
    if (!/ease-in-out/.test(rule[1])) {
      throw new Error(cls + ' does not ease in-out, so the drift cannot swell and settle like a liquid: ' + rule[1]);
    }
    if (/\blinear\b/.test(rule[1])) {
      throw new Error(cls + ' still runs `linear` (one-way-current timing): ' + rule[1]);
    }
    // 2. A CLOSED, multi-stop wander: >= 4 stops so the path goes out, around
    //    and back; every stop translates (the layer drifts, it does not sit);
    //    the 100% stop restates 0% exactly (an open loop snaps every lap);
    //    and at least two intermediate stops differ (else it holds still).
    const stops = [...body.matchAll(/([\d.]+)%\{([^}]*)\}/g)].map((m) => ({ at: Number(m[1]), css: m[2] }));
    if (stops.length < 4) {
      throw new Error(name + ' has only ' + stops.length + ' stops; a wander needs >= 4 (out, around, back, home): ' + body);
    }
    for (const s of stops) {
      if (!/transform:[^;]*translate/.test(s.css)) {
        throw new Error(name + ' stop ' + s.at + '% has no translate transform — the layer must drift, not sit: ' + s.css);
      }
    }
    if (stops[0].at !== 0 || stops[stops.length - 1].at !== 100) {
      throw new Error(name + ' must start at 0% and end at 100%: ' + body);
    }
    if (stops[0].css !== stops[stops.length - 1].css) {
      throw new Error(name + ' is an OPEN loop (0% ≠ 100%), so it snaps every lap: ' + stops[0].css + ' vs ' + stops[stops.length - 1].css);
    }
    const mids = stops.slice(1, -1).map((s) => s.css);
    if (new Set(mids).size < 2) {
      throw new Error(name + ' never actually wanders — every intermediate stop is identical: ' + mids.join(' | '));
    }
    // 3. Oversized horizontally: otherwise the wandering translate slides the
    //    layer's own edge into view.
    const left = /left:(-?\d+)%/.exec(rule[1]);
    const right = /right:(-?\d+)%/.exec(rule[1]);
    if (!left || !right || Number(left[1]) >= 0 || Number(right[1]) >= 0) {
      throw new Error(cls + ' is not oversized horizontally, so drifting exposes its edge: ' + rule[1]);
    }
  }

  // REGRESSION: every colour must span the FULL height of the bar ("不要分上中下").
  // A radial blob whose vertical radius is comparable to the bar height fades out
  // before it reaches the top and bottom edges, so that colour survives only as a
  // middle stripe with the base colour showing above and below it — the bar reads as
  // horizontal strata instead of one mixed body of liquid. Every cosmos blob must be
  // centred at 50% vertically and be far taller than the tallest bar (28px capsule) —
  // on ALL THREE layers now that the base layer is made of blobs too.
  const BAR_TALLEST = 28;
  for (const cls of ['dms-cosmosFluidBase', 'dms-cosmosFluidMid', 'dms-cosmosFluidTop']) {
    const rule = new RegExp('\\.' + cls + '\\{([^}]*)\\}').exec(injectedCss);
    if (!rule) throw new Error('missing cosmos layer rule: ' + cls);
    const blobs = [...rule[1].matchAll(/ellipse (\d+)px (\d+)px at ([\d.]+)% ([\d.]+)%/g)];
    if (!blobs.length) throw new Error('no radial blob geometry found on ' + cls);
    for (const b of blobs) {
      const ry = Number(b[2]);
      const cy = Number(b[4]);
      if (cy !== 50) {
        throw new Error(cls + ' has a blob centred at ' + cy + '% vertically; it must be 50%, otherwise the colour is off-centre and leaves a band of base colour on the opposite edge');
      }
      if (ry < BAR_TALLEST * 3) {
        throw new Error(cls + ' blob vertical radius is ' + ry + 'px against a ' + BAR_TALLEST + 'px bar; it fades out before reaching the top/bottom edges and reads as horizontal strata (分上中下)');
      }
    }
  }

  // The three layers must run at DISTINCT durations. Equal (or simply related)
  // periods would make the wander phases line up, so the superposition would
  // visibly repeat instead of drifting irregularly.
  const speeds = [['base', 'dms-cosmosFluidBase'], ['mid', 'dms-cosmosFluidMid'], ['top', 'dms-cosmosFluidTop']]
    .map(([name, cls]) => {
      const body = new RegExp('\\.' + cls + '\\{([^}]*)\\}').exec(injectedCss)[1];
      const d = /animation:dms-fluid-[\w-]+ ([\d.]+)s/.exec(body);
      if (!d) throw new Error(name + ' has no parsable animation duration: ' + body);
      return Number(d[1]);
    });
  if (new Set(speeds).size !== speeds.length) {
    throw new Error('the cosmos layers all run at the same speed (' + speeds.join(', ') + '), so they convoy rigidly instead of mixing; give each a distinct duration');
  }

  // RANDOM ROLL (随机流体): every effort-panel open while the cosmos style
  // is active must re-deal the whole effect — palette, blob geometry,
  // wander paths, speeds AND directions. The static rules above are only
  // the fallback; the live look comes from the per-open <style> element.
  // ------------------------------------------------------------------
  if (cosmosRolls.length < 2) {
    throw new Error('expected one cosmos roll per panel open (the test opened the panel twice), got ' + cosmosRolls.length);
  }
  if (new Set(cosmosRolls).size !== cosmosRolls.length) {
    throw new Error('two panel opens dealt the IDENTICAL cosmos css — the roll is not re-dealt per open (or the RNG is stuck)');
  }
  // A roll's @media freeze block is STRIPPED before any rule is parsed. The
  // block contains a bare `animation:none` for each layer, and a rule regex
  // like `/\.dms-cosmosFluidBase\{([^}]*)\}/` would otherwise match THAT block
  // first whenever the freeze happens to precede the rules — reporting a parse
  // error and making the source-order guard below literally unreachable. The
  // freeze's own presence and position are asserted separately.
  const stripFreeze = (css) => css.replace(/@media \(prefers-reduced-motion:reduce\)\{[^}]*\}[^}]*\}/g, '');
  const assertRoll = (rawCss) => {
    const css = stripFreeze(rawCss);
    // Light ground, re-drawn per roll (hex only, luminance >= 0.75).
    const gnd = /\.dms-fillMax\.dms-fx-cosmos\{background-color:#([0-9a-fA-F]{6})\}/.exec(css);
    if (!gnd) throw new Error('roll has no light ground rule: ' + css.slice(0, 120));
    const gl = (0.2126 * parseInt(gnd[1].slice(0, 2), 16) + 0.7152 * parseInt(gnd[1].slice(2, 4), 16) + 0.0722 * parseInt(gnd[1].slice(4, 6), 16)) / 255;
    if (gl < 0.75) throw new Error('rolled ground #' + gnd[1] + ' is too dark (luminance ' + gl.toFixed(2) + ')');
    const durations = [];
    for (const cls of ['dms-cosmosFluidBase', 'dms-cosmosFluidMid', 'dms-cosmosFluidTop']) {
      const rule = new RegExp('\\.' + cls + '\\{([^}]*)\\}').exec(css);
      if (!rule) throw new Error('roll is missing the layer rule: ' + cls);
      const body = rule[1];
      // Easing only; `linear` is the retired one-way march.
      if (!/ease-in-out/.test(body)) throw new Error('rolled ' + cls + ' lost its easing: ' + body);
      if (/\blinear\b/.test(body)) throw new Error('rolled ' + cls + ' contains `linear`: ' + body);
      // Random direction (normal|reverse) and a negative delay (random phase).
      const anim = /animation:(dms-fluid-wander-[abc]-g\d+) ([\d.]+)s ease-in-out (-[\d.]+)s infinite (normal|reverse)/.exec(body);
      if (!anim) throw new Error('rolled ' + cls + ' animation shorthand is not "<kf> <dur>s ease-in-out -<delay>s infinite <normal|reverse>": ' + body);
      durations.push(Number(anim[2]));
      if (Number(anim[2]) < 5 || Number(anim[2]) > 23) throw new Error('rolled ' + cls + ' duration ' + anim[2] + 's is outside the 5–23s bands');
      // The keyframes the rule points at must exist in the SAME roll.
      if (css.indexOf('@keyframes ' + anim[1]) === -1) throw new Error('rolled ' + cls + ' points at missing keyframes ' + anim[1]);
      // Full-height blobs, still centred at 50% (不分上中下).
      const blobs = [...body.matchAll(/ellipse (\d+)px (\d+)px at ([\d.]+)% ([\d.]+)%/g)];
      if (!blobs.length) throw new Error('rolled ' + cls + ' has no radial blobs: ' + body);
      for (const b of blobs) {
        if (Number(b[4]) !== 50) throw new Error('rolled ' + cls + ' blob centred at ' + b[4] + '% vertically (must be 50)');
        if (Number(b[2]) < 84) throw new Error('rolled ' + cls + ' blob ry ' + b[2] + 'px fades before the bar edges (strata)');
      }
      // Oversized horizontally.
      if (!/left:-\d+%/.test(body) || !/right:-\d+%/.test(body)) throw new Error('rolled ' + cls + ' lost its horizontal oversize: ' + body);
    }
    if (new Set(durations).size !== durations.length) {
      throw new Error('rolled durations are not distinct: ' + durations.join(', '));
    }
    // Every wander kf in this roll: closed loop, >= 4 stops, every stop
    // translates, at least two distinct intermediate stops.
    for (const kf of [...css.matchAll(/@keyframes (dms-fluid-wander-[abc]-g\d+)\{/g)].map((m) => m[1])) {
      const at = css.indexOf('@keyframes ' + kf);
      const open = css.indexOf('{', at);
      let depth = 0;
      let body = null;
      for (let i = open; i < css.length; i += 1) {
        if (css[i] === '{') depth += 1;
        else if (css[i] === '}') { depth -= 1; if (depth === 0) { body = css.slice(open, i + 1); break; } }
      }
      if (!body) throw new Error('unbalanced keyframes: ' + kf);
      const stops = [...body.matchAll(/([\d.]+)%\{([^}]*)\}/g)].map((m) => ({ at: Number(m[1]), css: m[2] }));
      if (stops.length < 4) throw new Error(kf + ' has only ' + stops.length + ' stops: ' + body);
      if (stops[0].at !== 0 || stops[stops.length - 1].at !== 100) throw new Error(kf + ' must span 0%..100%: ' + body);
      if (stops[0].css !== stops[stops.length - 1].css) throw new Error(kf + ' is an OPEN loop (0% ≠ 100%): ' + stops[0].css + ' vs ' + stops[stops.length - 1].css);
      for (const s of stops) {
        if (!/transform:[^;]*translate/.test(s.css)) throw new Error(kf + ' stop ' + s.at + '% does not translate: ' + s.css);
      }
      const mids = stops.slice(1, -1).map((s) => s.css);
      if (new Set(mids).size < 2) throw new Error(kf + ' holds still — every intermediate stop identical: ' + mids.join(' | '));
    }
  };
  for (const roll of cosmosRolls) assertRoll(roll);
  // NOTHING may stay pinned across opens ("每次打开浮层显示颜色不要固定运动
  // 方向和颜色搭配"): per layer, the duration, the blob palette AND the
  // direction bits must each move from roll to roll. Duration/palette are
  // continuous randoms (an honest collision is for all practical purposes
  // impossible, a pinned value fails certainly); direction is Bernoulli, so
  // a single layer over 12 opens is all-same with honest probability
  // 2x2^-12 ≈ 0.05% — and a pinned direction fails with certainty.
  const ruleBody = (css, cls) => (new RegExp('\\.' + cls + '\\{([^}]*)\\}').exec(css) || [])[1] || [];
  const grid = {};
  for (const cls of ['dms-cosmosFluidBase', 'dms-cosmosFluidMid', 'dms-cosmosFluidTop']) {
    grid[cls] = cosmosRolls.map((css) => {
      const body = ruleBody(css, cls);
      const anim = /animation:dms-fluid-wander-[abc]-g\d+ ([\d.]+)s ease-in-out -[\d.]+s infinite (normal|reverse)/.exec(body) || [];
      return { bg: (/(?:^|;)background:([^;]+)/.exec(body) || [])[1] || '', dur: anim[1] || '', dir: anim[2] || '' };
    });
  }
  // EVERY Fluid roll must carry its own reduced-motion freeze (see the matching
  // sunset guard below for why the static one is not enough).
  for (const css of cosmosRolls) {
    const freeze = css.indexOf('@media (prefers-reduced-motion:reduce)');
    if (freeze === -1) {
      throw new Error('a cosmos roll carries no reduced-motion freeze, so it would override the static one: ' + css.slice(0, 120));
    }
    for (const layer of ['dms-cosmosFluidBase', 'dms-cosmosFluidMid', 'dms-cosmosFluidTop']) {
      const rule = css.indexOf('.' + layer + '{position:absolute');
      if (rule === -1) throw new Error('a cosmos roll is missing the ' + layer + ' rule');
      if (rule > freeze) {
        throw new Error('the ' + layer + ' animation rule in a roll comes AFTER its reduced-motion freeze, so it would win');
      }
    }
  }
  for (const cls of Object.keys(grid)) {
    const rows = grid[cls];
    if (new Set(rows.map((r) => r.dur)).size === 1) {
      throw new Error(cls + ' kept the SAME duration across every open (' + rows[0].dur + 's) — 速度不是随机重掷的');
    }
    if (new Set(rows.map((r) => r.bg)).size === 1) {
      throw new Error(cls + ' kept the SAME blob palette/geometry across every open — 颜色搭配不是随机重掷的');
    }
    if (new Set(rows.map((r) => r.dir)).size === 1) {
      throw new Error(cls + ' kept the SAME animation direction across every open (' + rows[0].dir + ') — 运动方向不是随机重掷的');
    }
  }
});

// 2c. 晚霞 (sunset) — ui: "新增滑块栏样式[晚霞]，主色调是以图片中的色调为主，
// 展现出晚霞天空云雾、光线色调的不规则变化".
//
// Three things have to hold at once, and each has its own failure mode:
//   (a) the PALETTE is the photo's, not an invented pink-purple. The reference
//       image's four median-cut families are pinned below as sampled; every
//       colour the roll deals must sit inside one of them, so "以图片中的色调
//       为主" is a measurement rather than a claim;
//   (b) the SKY is stratified and the CLOUDS are not: a sunset is blue above
//       and gold below, so the ground gradient must actually walk that way,
//       while the cloud blobs must sit at FREE depths (that is what makes it
//       read as 云霭 rather than as the Fluid style's full-height bands);
//   (c) 光线色调的不规则变化 is both SPATIAL (three layers with distinct,
//       incommensurate durations drifting over the ground) and TEMPORAL (the
//       glow loop animates opacity, so the light beats instead of merely
//       sliding) — and every open re-deals it, exactly like the Fluid roll.
check('the sunset style is sampled from the photo, layered, and re-dealt per open', () => {
  // ---- (a) sampled palette -------------------------------------------
  // Each entry: one median-cut family of the reference photo, and the vertical
  // band (as a fraction of the bar's height) that family is allowed to occupy.
  // The bands OVERLAP on purpose: the photo's own boundaries are soft, and hard
  // edges here would forbid honest clouds that straddle two families.
  //
  // The ORDER matters: consecutive families are what the roll actually blends
  // (see dmsSunsetCloud), so the entries below are also the vertices of the
  // palette polyline used to measure "is this colour the photo's?".
  const FAMILIES = [
    { name: '长春花蓝 periwinkle', rgb: [0x8f, 0xa5, 0xf6], lo: -0.22, hi: 0.52 },
    { name: '亮蓝 bright blue', rgb: [0x79, 0x82, 0xd7], lo: -0.22, hi: 0.52 },
    { name: '紫罗兰 violet', rgb: [0x74, 0x72, 0xa3], lo: 0.0, hi: 0.72 },
    { name: '深紫灰 deep grey-violet', rgb: [0x69, 0x5d, 0x6d], lo: 0.0, hi: 0.72 },
    { name: '玫瑰褐 mauve', rgb: [0x92, 0x74, 0x7d], lo: 0.1, hi: 0.9 },
    { name: '暖玫瑰 warm rose', rgb: [0xa7, 0x82, 0x92], lo: 0.15, hi: 0.95 },
    { name: '暖褐 warm mauve', rgb: [0xc6, 0x84, 0x73], lo: 0.18, hi: 1.0 },
    { name: '橙金 orange-gold', rgb: [0xee, 0xa7, 0x6b], lo: 0.3, hi: 1.0 },
    { name: '金黄 gold', rgb: [0xfd, 0xc9, 0x6c], lo: 0.35, hi: 1.0 },
    { name: '浅金 pale gold', rgb: [0xfb, 0xde, 0x97], lo: 0.35, hi: 1.0 },
    { name: '近白暖金 near-white gold', rgb: [0xfd, 0xf1, 0xa5], lo: 0.4, hi: 1.0 }
  ];
  // "On the photo's palette" is measured as the distance to the palette
  // POLYLINE, not to the nearest single sample. The style legitimately emits
  // blends of two NEIGHBOURING families, and those midpoints can sit ~37 away
  // from either endpoint — measuring against the points alone rejected honest
  // colours (a real flake: rgb(173,132,144), a mauve..rose blend, was reported
  // as 36.7 from its nearest sample while being 3.3 from the segment).
  // Calibrated: the worst honest blend over 200k samples is 4.2 away, so a
  // tolerance of 12 passes every legitimate colour with ~3x margin and still
  // rejects anything the roll cannot actually produce (pure green is 222,
  // pure red 184, an invented pastel pink 69).
  const PALETTE_TOL = 12;
  const segDist = (p, a, b) => {
    const v = [b[0] - a[0], b[1] - a[1], b[2] - a[2]];
    const w = [p[0] - a[0], p[1] - a[1], p[2] - a[2]];
    const vv = v[0] * v[0] + v[1] * v[1] + v[2] * v[2];
    let t = vv ? (w[0] * v[0] + w[1] * v[1] + w[2] * v[2]) / vv : 0;
    t = Math.max(0, Math.min(1, t));
    const q = [a[0] + v[0] * t, a[1] + v[1] * t, a[2] + v[2] * t];
    return Math.hypot(p[0] - q[0], p[1] - q[1], p[2] - q[2]);
  };
  const paletteDist = (r, g, b) => {
    let best = Infinity;
    for (let i = 0; i + 1 < FAMILIES.length; i += 1) {
      best = Math.min(best, segDist([r, g, b], FAMILIES[i].rgb, FAMILIES[i + 1].rgb));
    }
    return best;
  };
  const nearest = (r, g, b) => {
    let best = null;
    let bestD = Infinity;
    for (const f of FAMILIES) {
      const d = Math.hypot(r - f.rgb[0], g - f.rgb[1], b - f.rgb[2]);
      if (d < bestD) { bestD = d; best = f; }
    }
    return { family: best, dist: bestD };
  };
  const rgbaOf = (token) => {
    const m = /rgba\((\d+),(\d+),(\d+),([\d.]+)\)/.exec(token);
    return m ? { r: Number(m[1]), g: Number(m[2]), b: Number(m[3]), a: Number(m[4]) } : null;
  };
  const hexes = (css) => [...css.matchAll(/#([0-9a-fA-F]{6})/g)].map((m) => m[1]);
  // A colour is "in the palette" when it is within PALETTE_TOL of the polyline.
  const assertInPalette = (label, r, g, b) => {
    const d = paletteDist(r, g, b);
    if (d > PALETTE_TOL) {
      const near = nearest(r, g, b);
      throw new Error(label + ' rgb(' + r + ',' + g + ',' + b + ') is ' + d.toFixed(1)
        + ' away from the palette polyline (nearest family: ' + near.family.name
        + ', tol ' + PALETTE_TOL + ') — the style must stay on the photo\'s palette');
    }
    return nearest(r, g, b).family;
  };

  const sunsetRollsBefore = sunsetRolls.length;
  const openSunset = (effort) => {
    const made = makeCtx({
      effort: effort,
      settingsValue: { advancedEffort: true, effortStyle: 'sunset', trackShape: 'capsule' }
    });
    loadModule().apply(made.ctx);
    const seat = seatOf(made.registrations);
    const injected = seat.options.inject('session-1');
    hookState.length = 0;
    let tree = expand(seat.component({ ...injected }));
    const trigger = findAll(tree, (p) => p && p.className === 'dms-effortTrigger')[0];
    if (trigger && trigger.props && trigger.props.onClick) trigger.props.onClick();
    for (let i = 0; i < 4; i += 1) { runEffects(); resetHooks(); tree = expand(seat.component({ ...injected })); }
    return tree;
  };

  // ---- (b) tree shape, gated on MAX exactly like the other fill styles ----
  // NOTE the subtree is mounted at EVERY tier on purpose — like .dms-fillCosmos,
  // it is revealed by its own 0.5s opacity transition when the fill gains
  // `.dms-fillMax`, which is what keeps the MAX entry/exit symmetric without a
  // one-shot keyframe that would play (invisibly) below MAX. The TIER GATE is
  // therefore the class, not the element's existence.
  const treeHigh = openSunset('high');
  const highFills = findAll(treeHigh, (p) => p && typeof p.className === 'string' && /(^|\s)dms-fill(\s|$)/.test(p.className));
  if (highFills.length === 0) throw new Error('dms-fill missing at high tier');
  if (highFills[0].props.className.indexOf('dms-fillMax') !== -1) {
    throw new Error('dms-fillMax present below MAX: ' + highFills[0].props.className);
  }
  if (highFills[0].props.className.indexOf('dms-fx-sunset') !== -1) {
    throw new Error('dms-fx-sunset active below MAX: ' + highFills[0].props.className);
  }
  // …and the reveal must be a TRANSITION on the container, never an animation:
  // a mounted-once keyframe would have finished long before the user reaches MAX.
  const containerRule = /\.dms-fillSunset\{([^}]*)\}/.exec(injectedCss);
  if (!containerRule) throw new Error('the .dms-fillSunset container rule is missing');
  if (!/opacity:0/.test(containerRule[1])) throw new Error('the sunset container is not hidden below MAX: ' + containerRule[1]);
  if (!/transition:opacity/.test(containerRule[1])) throw new Error('the sunset reveal is not a transition: ' + containerRule[1]);
  if (/animation:/.test(containerRule[1])) throw new Error('the sunset container must not carry a one-shot entry animation');
  if (/\.dms-fillMax\.dms-fx-sunset \.dms-fillSunset\{opacity:1\}/.test(injectedCss) === false) {
    throw new Error('nothing reveals the sunset container at MAX');
  }

  const treeMax = openSunset('max');
  // Ten→eighteen more opens (any tier) give the cross-roll sameness guards
  // below statistical teeth, exactly like the Fluid check: a pinned value fails
  // with certainty, while an honest random roll collides with vanishing
  // probability (per-layer direction is Bernoulli, so 20 rolls are all-same
  // with honest probability 2 x 2^-20 ≈ 0.0002% — at 12 rolls that was 0.05%
  // and it did flake).
  for (let i = 0; i < 18; i += 1) openSunset('high');
  const maxFills = findAll(treeMax, (p) => p && typeof p.className === 'string' && p.className.indexOf('dms-fillMax') !== -1);
  if (maxFills.length === 0) throw new Error('dms-fillMax missing at max tier');
  if (maxFills[0].props.className.indexOf('dms-fx-sunset') === -1) {
    throw new Error('dms-fx-sunset missing from fillClass at max tier: ' + maxFills[0].props.className);
  }
  const root = findAll(treeMax, (p) => p && typeof p.className === 'string' && p.className.indexOf('dms-fillSunset') !== -1);
  if (root.length === 0) throw new Error('dms-fillSunset element missing at max tier');
  // Exactly FOUR layers inside the root: sky + 云雾 + 受光云顶 + 光线. A fifth
  // would be an unintended stack; a missing one would silently drop a feature.
  const layers = (root[0].children || []).filter(Boolean).map((c) => String((c.props || {}).className));
  const expectedLayers = ['dms-sunsetSky', 'dms-sunsetCloudLo', 'dms-sunsetCloudHi', 'dms-sunsetGlow'];
  if (layers.join(',') !== expectedLayers.join(',')) {
    throw new Error('the sunset stack is ' + JSON.stringify(layers) + ', expected ' + JSON.stringify(expectedLayers));
  }
  // The other styles must not have leaked in with it.
  for (const other of ['dms-fillCosmos', 'dms-cosmosFluidBase', 'dms-fillSpray', 'dms-undertow']) {
    const leaked = findAll(treeMax, (p) => p && typeof p.className === 'string' && p.className.indexOf(other) !== -1);
    if (leaked.length !== 0) throw new Error('a foreign effect leaked into the sunset fill: ' + other);
  }

  // ---- static stylesheet: the sky is stratified, the NO-DOM fallback ------
  const sunsetCss = injectedCss;
  const skyRule = /\.dms-sunsetSky\{([^}]*)\}/.exec(sunsetCss);
  if (!skyRule) throw new Error('the sunset sky rule is missing from the static stylesheet');
  const skyStops = [...skyRule[1].matchAll(/#([0-9a-fA-F]{6})\s+([\d.]+)%/g)]
    .map((m) => ({ hex: m[1], at: Number(m[2]) }));
  // Nine stops in a 24–28px bar is ~3px per band: without softening, the ground
  // reads as a hard-edged LADDER of stripes rather than as a sky. The blur must
  // be paired with an OVERSIZE — a filter blurs by sampling outside the box,
  // and at `inset:0` those samples are transparent, so the edges would fade and
  // expose the dark ground colour as a rim. Both halves are asserted together
  // because either one alone is a defect: blur-without-oversize rims, and
  // oversize-without-blur still ladders.
  if (!/filter:blur\(/.test(skyRule[1])) {
    throw new Error('the sky gradient is not softened, so nine stops would render as hard stripes: ' + skyRule[1]);
  }
  for (const side of ['left', 'right', 'top', 'bottom']) {
    const m = new RegExp(side + ':(-\\d+)px').exec(skyRule[1]);
    if (!m) throw new Error('the blurred sky is not oversized on ' + side + ', so its edge would rim with the ground colour: ' + skyRule[1]);
    if (Number(m[1]) >= 0) throw new Error('the sky oversize on ' + side + ' is not negative: ' + m[1]);
  }
  if (skyStops.length < 5) throw new Error('the sky gradient has only ' + skyStops.length + ' stops');
  if (skyStops[0].at !== 0 || skyStops[skyStops.length - 1].at !== 100) {
    throw new Error('the sky gradient does not span 0..100%: ' + JSON.stringify(skyStops.map((s) => s.at)));
  }
  let prevAt = -1;
  for (const s of skyStops) {
    if (s.at <= prevAt) throw new Error('the sky stops are not strictly increasing: ' + JSON.stringify(skyStops.map((x) => x.at)));
    prevAt = s.at;
  }
  // STRATIFICATION, asserted as the photo's own vertical order: the top stop
  // must be the BLUE family and the bottom one the GOLD family, and the top
  // must be cooler (bluer) than the bottom. This is what stops the style from
  // degrading back into a generic warm blob field.
  const rgbOf = (hex) => [parseInt(hex.slice(0, 2), 16), parseInt(hex.slice(2, 4), 16), parseInt(hex.slice(4, 6), 16)];
  const topRgb = rgbOf(skyStops[0].hex);
  const botRgb = rgbOf(skyStops[skyStops.length - 1].hex);
  const topFam = assertInPalette('the sky gradient top stop', topRgb[0], topRgb[1], topRgb[2]);
  const botFam = assertInPalette('the sky gradient bottom stop', botRgb[0], botRgb[1], botRgb[2]);
  if (topFam.name.indexOf('蓝') === -1) throw new Error('the sky does not start blue at the top (it starts ' + topFam.name + ')');
  if (botFam.name.indexOf('金') === -1) throw new Error('the sky does not end gold at the bottom (it ends ' + botFam.name + ')');
  const blueBias = (hex) => rgbOf(hex)[2] - rgbOf(hex)[0]; // b - r: high = cool/blue, low = warm
  if (blueBias(skyStops[0].hex) <= blueBias(skyStops[skyStops.length - 1].hex)) {
    throw new Error('the sky is not cooler at the top than at the bottom ('
      + blueBias(skyStops[0].hex) + ' vs ' + blueBias(skyStops[skyStops.length - 1].hex) + ')');
  }
  // Every intermediate stop must ALSO be a sampled family (no invented colour
  // sneaking into the middle of the ramp).
  for (const s of skyStops) {
    const c = rgbOf(s.hex);
    assertInPalette('sky stop ' + s.at + '%', c[0], c[1], c[2]);
  }
  // The two cloud layers and the glow must be present in the static sheet too,
  // and the glow must carry the opacity beat in BOTH places (rule + keyframes).
  for (const cls of ['dms-sunsetCloudLo', 'dms-sunsetCloudHi', 'dms-sunsetGlow']) {
    if (new RegExp('\\.' + cls + '\\{').test(sunsetCss) === false) {
      throw new Error('the static fallback rule for ' + cls + ' is missing');
    }
  }
  // The STATIC fallback clouds obey the same shape rule as the rolled ones: a
  // full-height blob would make the no-DOM look (and any roll that fails to
  // deal) read as the Fluid style's strata. Asserting it only on the rolls
  // leaves the fallback — the one path a user actually sees when the roll is
  // skipped — completely unguarded.
  for (const cls of ['dms-sunsetCloudLo', 'dms-sunsetCloudHi', 'dms-sunsetGlow']) {
    const rule = new RegExp('\\.' + cls + '\\{([^}]*)\\}').exec(sunsetCss);
    const blobs = [...rule[1].matchAll(/ellipse (\d+)px (\d+)px at ([\d.]+)% ([\d.]+)%/g)];
    if (blobs.length === 0) throw new Error('the static ' + cls + ' rule has no radial blobs');
    for (const b of blobs) {
      if (Number(b[2]) > 90) {
        throw new Error('the static ' + cls + ' blob ry ' + b[2] + 'px fills the whole bar — that is a stratum, not a cloud');
      }
    }
  }
  if (sunsetCss.indexOf('@keyframes dms-sunset-drift-c') === -1) {
    throw new Error('the 光线 drift keyframes are missing from the static stylesheet');
  }
  const glowKfStatic = sunsetCss.slice(sunsetCss.indexOf('@keyframes dms-sunset-drift-c'));
  if (!/opacity:/.test(glowKfStatic.slice(0, glowKfStatic.indexOf('}}') + 2))) {
    throw new Error('the 光线 layer does not animate opacity in the static keyframes — 光线色调不会变化');
  }
  // The capsule shape must actually CLIP the sunset fill, not merely mention it:
  // an unclipped container would show square corners poking out of the capsule.
  const capsuleSunset = /\.dms-sliderCapsule \.dms-fillSunset\{([^}]*)\}/.exec(sunsetCss);
  if (!capsuleSunset) throw new Error('the capsule shape does not clip the sunset fill');
  if (!/border-radius:999px/.test(capsuleSunset[1])) {
    throw new Error('the sunset fill is not rounded to the capsule: ' + capsuleSunset[1]);
  }
  if (!/corner-shape:round/.test(capsuleSunset[1])) {
    throw new Error('the sunset fill is missing corner-shape:round: ' + capsuleSunset[1]);
  }
  // …and it must follow the capsule's taller 28px bar.
  if (new RegExp('\\.dms-sliderCapsule \\.dms-fillSunset\\{[^}]*height:28px').test(sunsetCss) === false) {
    throw new Error('the sunset fill does not follow the capsule bar height');
  }
  const rmSunset = /@media \(prefers-reduced-motion:reduce\)\{([^]*)\}$/.exec(sunsetCss.trim());
  if (!rmSunset || rmSunset[1].indexOf('dms-sunsetGlow') === -1) {
    throw new Error('reduced motion does not freeze the sunset layers');
  }

  // ---- (c) the per-open roll -----------------------------------------
  if (sunsetRolls.length - sunsetRollsBefore < 20) {
    throw new Error('expected one sunset roll per panel open (the test opened the panel 20 times), got ' + (sunsetRolls.length - sunsetRollsBefore));
  }
  const rolls = sunsetRolls.slice(sunsetRollsBefore);
  if (new Set(rolls).size !== rolls.length) {
    throw new Error('two panel opens dealt the IDENTICAL sunset css — the roll is not re-dealt per open');
  }
  // How many distinct opacity values each roll's 光线 loop carries (see the
  // per-roll note inside assertSunsetRoll for why this is aggregated).
  const glowSpreads = [];
  // See assertRoll above: the @media freeze block contains `animation:none` and
  // must be stripped before rules are parsed, or it would shadow the layer
  // rules and make the source-order guard unreachable.
  const stripSunsetFreeze = (css) => css.replace(/@media \(prefers-reduced-motion:reduce\)\{[^}]*\}[^}]*\}/g, '');
  const assertSunsetRoll = (rawCss) => {
    const css = stripSunsetFreeze(rawCss);
    // Sky: 9 stops, strictly increasing, spanning 0..100, every colour on the
    // photo's palette AND in its family's allowed band.
    const sky = /\.dms-sunsetSky\{background:linear-gradient\(180deg,([^}]*)\)\}/.exec(css);
    if (!sky) throw new Error('roll has no sky gradient: ' + css.slice(0, 140));
    const stops = [...sky[1].matchAll(/#([0-9a-fA-F]{6}) ([\d.]+)%/g)].map((m) => ({ hex: m[1], at: Number(m[2]) }));
    if (stops.length !== 9) throw new Error('rolled sky has ' + stops.length + ' stops, expected 9');
    if (stops[0].at !== 0 || stops[stops.length - 1].at !== 100) {
      throw new Error('rolled sky does not span 0..100%: ' + JSON.stringify(stops.map((s) => s.at)));
    }
    for (let i = 1; i < stops.length; i += 1) {
      if (stops[i].at <= stops[i - 1].at) {
        throw new Error('rolled sky stops are not strictly increasing: ' + JSON.stringify(stops.map((s) => s.at)));
      }
    }
    for (let i = 0; i < stops.length; i += 1) {
      const c = rgbOf(stops[i].hex);
      const fam = assertInPalette('rolled sky stop ' + stops[i].at + '%', c[0], c[1], c[2]);
      // The band is indexed by the stop's OWN position on the ground, i.e. the
      // sampled family must still be in the part of the sky it belongs to.
      const t = stops[i].at / 100;
      if (t < fam.lo || t > fam.hi) {
        throw new Error('rolled sky stop ' + stops[i].at + '% is the ' + fam.name
          + ' family, which belongs in ' + (fam.lo * 100) + '–' + (fam.hi * 100) + '% of the sky');
      }
    }
    // Cloud layers: FREE vertical centres that actually vary (that is 云霭),
    // every colour on-palette, and the glow's keyframes must beat opacity.
    const cloudDepths = [];
    for (const cls of ['dms-sunsetCloudLo', 'dms-sunsetCloudHi']) {
      const rule = new RegExp('\\.' + cls + '\\{([^}]*)\\}').exec(css);
      if (!rule) throw new Error('roll is missing the layer rule: ' + cls);
      const body = rule[1];
      const blobs = [...body.matchAll(/ellipse (\d+)px (\d+)px at ([\d.]+)% ([\d.]+)%,rgba\((\d+),(\d+),(\d+),([\d.]+)\)/g)];
      if (blobs.length < 2) throw new Error('rolled ' + cls + ' has only ' + blobs.length + ' blobs');
      for (const b of blobs) {
        // Group order is rx(1), ry(2), cx(3), cy(4), r(5), g(6), b(7), a(8).
        assertInPalette('rolled ' + cls + ' blob', Number(b[5]), Number(b[6]), Number(b[7]));
        // Full-bar clouds would read as the Fluid style's horizontal strata;
        // a sunset cloud has a DEPTH. Its vertical RADIUS must stay small
        // relative to the bar, and its vertical CENTRE must be free to leave
        // the middle. Both are asserted: the radius bound is what catches a
        // blob blown up into a stratum, the depth is collected below.
        if (Number(b[2]) > 90) {
          throw new Error('rolled ' + cls + ' blob ry ' + b[2] + 'px fills the whole bar — that is a stratum, not a cloud');
        }
        cloudDepths.push(Number(b[4]));
      }
      if (!/ease-in-out/.test(body)) throw new Error('rolled ' + cls + ' lost its easing: ' + body);
      if (/\blinear\b/.test(body)) throw new Error('rolled ' + cls + ' contains `linear`: ' + body);
      const anim = /animation:(dms-sunset-drift-[ab]-g\d+) ([\d.]+)s ease-in-out (-[\d.]+)s infinite (normal|reverse)/.exec(body);
      if (!anim) throw new Error('rolled ' + cls + ' animation shorthand is not the expected form: ' + body);
      if (css.indexOf('@keyframes ' + anim[1]) === -1) throw new Error('rolled ' + cls + ' points at missing keyframes ' + anim[1]);
    }
    // The cloud centres must not all sit on the same depth, or the two layers
    // would stack into one band instead of drifting through each other.
    if (new Set(cloudDepths).size < 2) {
      throw new Error('every rolled cloud sits at the same depth (' + cloudDepths.join(', ') + ') — 云雾没有层次');
    }
    // 光线: the shimmer loop must animate opacity, in THIS roll's own keyframes.
    const glowRule = /\.dms-sunsetGlow\{([^}]*)\}/.exec(css);
    if (!glowRule) throw new Error('roll is missing the dms-sunsetGlow rule');
    const glowAnim = /animation:(dms-sunset-drift-c-g\d+) ([\d.]+)s ease-in-out (-[\d.]+)s infinite (normal|reverse)/.exec(glowRule[1]);
    if (!glowAnim) throw new Error('rolled glow animation shorthand is not the expected form: ' + glowRule[1]);
    const kfAt = css.indexOf('@keyframes ' + glowAnim[1]);
    if (kfAt === -1) throw new Error('rolled glow points at missing keyframes ' + glowAnim[1]);
    const open = css.indexOf('{', kfAt);
    let depth = 0;
    let kfBody = null;
    for (let i = open; i < css.length; i += 1) {
      if (css[i] === '{') depth += 1;
      else if (css[i] === '}') { depth -= 1; if (depth === 0) { kfBody = css.slice(open, i + 1); break; } }
    }
    if (!kfBody) throw new Error('unbalanced keyframes: ' + glowAnim[1]);
    // The 光线 beat, asserted STRUCTURALLY rather than by counting distinct
    // values. An earlier version required >= 3 distinct opacities and was
    // FLAKY: the 0% and 100% stops restate op0 by construction, so only the
    // 2–4 interior stops are free, and an honest roll can easily draw two
    // equal values (that flake killed unrelated mutations first, which is how
    // it was found). What actually matters is that EVERY stop carries an
    // opacity — so the light breathes across the whole loop instead of
    // snapping at its ends — and that the value genuinely moves.
    const kfStops = [...kfBody.matchAll(/([\d.]+)%\{([^}]*)\}/g)].map((m) => ({ at: Number(m[1]), css: m[2] }));
    if (kfStops.length < 4) throw new Error('the rolled 光线 loop has only ' + kfStops.length + ' stops');
    for (const s of kfStops) {
      if (!/opacity:/.test(s.css)) {
        throw new Error('the 光线 stop at ' + s.at + '% carries no opacity, so the light stops breathing: ' + s.css);
      }
    }
    const opacities = kfStops.map((s) => Number((/opacity:([\d.]+)/.exec(s.css) || [])[1]));
    if (opacities.some((o) => !Number.isFinite(o))) throw new Error('unreadable 光线 opacity: ' + kfBody);
    // Record the spread for the ACROSS-ROLL assertion below. Per roll this
    // value is allowed to be 1: the 0% and 100% stops must restate op0 (the loop
    // has to close), so only the 2–4 interior stops are free, and an honest roll
    // drawing the same value twice is a ~1/51² event that DOES happen (it was
    // observed once in 60 runs). Asserting variability per roll therefore made
    // this suite flaky; asserting it over all 12 rolls keeps the guard's teeth
    // (a constant-opacity implementation is all-same in EVERY roll) while
    // dropping the collision probability to ~1/51^24.
    glowSpreads.push(new Set(opacities).size);
    // THE SHIMMER LOOP MUST CLOSE: every keyframe in this roll restates its own
    // 0% at 100% (transform AND opacity), or the wrap would jump.
    for (const kf of [...css.matchAll(/@keyframes (dms-sunset-drift-[abc]-g\d+)\{/g)].map((m) => m[1])) {
      const at = css.indexOf('@keyframes ' + kf);
      const o = css.indexOf('{', at);
      let d = 0;
      let body = null;
      for (let i = o; i < css.length; i += 1) {
        if (css[i] === '{') d += 1;
        else if (css[i] === '}') { d -= 1; if (d === 0) { body = css.slice(o, i + 1); break; } }
      }
      if (!body) throw new Error('unbalanced keyframes: ' + kf);
      const kStops = [...body.matchAll(/([\d.]+)%\{([^}]*)\}/g)].map((m) => ({ at: Number(m[1]), css: m[2] }));
      if (kStops.length < 4) throw new Error(kf + ' has only ' + kStops.length + ' stops (a drift needs out/around/back/home)');
      if (kStops[0].at !== 0 || kStops[kStops.length - 1].at !== 100) throw new Error(kf + ' must span 0%..100%');
      if (kStops[0].css !== kStops[kStops.length - 1].css) {
        throw new Error(kf + ' is an OPEN loop (0% ≠ 100%): ' + kStops[0].css + ' vs ' + kStops[kStops.length - 1].css);
      }
      for (const s of kStops) {
        if (!/transform:[^;]*translate/.test(s.css)) throw new Error(kf + ' stop ' + s.at + '% does not translate');
      }
      const mids = kStops.slice(1, -1).map((s) => s.css);
      if (new Set(mids).size < 2) throw new Error(kf + ' holds still — every intermediate stop identical');
    }
  };
  for (const roll of rolls) assertSunsetRoll(roll);
  // The 光线 beat must actually breathe SOMEWHERE across the twelve rolls. A
  // constant-opacity implementation is all-same in every roll, so this fails
  // with certainty for the defect while an honest roll that happens to draw two
  // equal interior values (a real ~1/51² event, observed once in 60 runs) still
  // passes as long as any other roll varies.
  if (glowSpreads.length !== rolls.length) {
    throw new Error('a sunset roll did not report its 光线 opacity spread');
  }
  if (glowSpreads.every((n) => n < 2)) {
    throw new Error('the 光线 opacity never changes in ANY of the ' + rolls.length + ' rolls (' + glowSpreads.join(', ') + ') — 光线色调不会变化');
  }
  // EVERY roll must carry its OWN reduced-motion freeze, placed AFTER that
  // roll's animation rules. This is not belt-and-braces: the roll stylesheet is
  // appended after the static one, and a @media block adds no specificity, so
  // the static freeze LOSES on source order to the per-open animation rules and
  // a reduced-motion user would watch the layers keep moving. The freeze inside
  // the roll is the only one that can win.
  for (const css of rolls) {
    const freeze = css.indexOf('@media (prefers-reduced-motion:reduce)');
    if (freeze === -1) {
      throw new Error('a sunset roll carries no reduced-motion freeze, so it would override the static one: ' + css.slice(0, 120));
    }
    for (const layer of ['dms-sunsetCloudLo', 'dms-sunsetCloudHi', 'dms-sunsetGlow']) {
      const rule = css.indexOf('.' + layer + '{position:absolute');
      if (rule === -1) throw new Error('a sunset roll is missing the ' + layer + ' rule');
      if (rule > freeze) {
        throw new Error('the ' + layer + ' animation rule in a roll comes AFTER its reduced-motion freeze, so it would win');
      }
    }
  }
  // NOTHING may stay pinned across opens: per layer, the duration, the blob
  // COLOURS AND GEOMETRY, and the direction bits must each move from roll to
  // roll (same statistical argument as the Fluid roll: a pinned value fails
  // with certainty, an honest collision is vanishing).
  //
  // The colour and the geometry are compared SEPARATELY, not as one string.
  // They are independent randoms, and a single string comparison lets a pinned
  // palette survive whenever the geometry still moves — which is exactly what
  // the first version of this guard did (a mutation that froze every cloud
  // colour passed it).
  const rollRule = (css, cls) => (new RegExp('\\.' + cls + '\\{([^}]*)\\}').exec(stripSunsetFreeze(css)) || [])[1] || '';
  // The colour tokens of a background, geometry stripped out. RGB and ALPHA are
  // extracted SEPARATELY: comparing the whole `rgba(...)` token lets a mutation
  // that pins only the opacity (or only the hue) survive, because the other
  // half still moves — which is exactly what happened when this guard was
  // first written.
  const rgbOfBg = (bg) => [...bg.matchAll(/rgba\((\d+),(\d+),(\d+),[\d.]+\)/g)].map((m) => m[1] + ',' + m[2] + ',' + m[3]).join('|');
  const alphaOfBg = (bg) => [...bg.matchAll(/rgba\(\d+,\d+,\d+,([\d.]+)\)/g)].map((m) => m[1]).join('|');
  const skyPaletteOf = (css) => {
    const sky = /\.dms-sunsetSky\{background:linear-gradient\(180deg,([^}]*)\)\}/.exec(css);
    if (!sky) return '';
    return [...sky[1].matchAll(/#[0-9a-fA-F]{6}/g)].map((m) => m[0]).join(',');
  };
  const skyRows = rolls.map(skyPaletteOf);
  if (skyRows.some((r) => r === '')) throw new Error('a sunset roll has no readable sky palette');
  if (new Set(skyRows).size === 1) {
    throw new Error('the sky PALETTE is identical across every open — 天空色调不是随机重掷的');
  }
  for (const cls of ['dms-sunsetCloudLo', 'dms-sunsetCloudHi', 'dms-sunsetGlow']) {
    const rows = rolls.map((css) => {
      const body = rollRule(css, cls);
      const anim = /animation:dms-sunset-drift-[abc]-g\d+ ([\d.]+)s ease-in-out -[\d.]+s infinite (normal|reverse)/.exec(body) || [];
      const bg = (/(?:^|;)background:([^;]+)/.exec(body) || [])[1] || '';
      return { rgb: rgbOfBg(bg), alpha: alphaOfBg(bg), geometry: bg.replace(/rgba\([^)]*\)/g, ''), dur: anim[1] || '', dir: anim[2] || '' };
    });
    if (new Set(rows.map((r) => r.dur)).size === 1) {
      throw new Error(cls + ' kept the SAME duration across every open (' + rows[0].dur + 's) — 速度不是随机重掷的');
    }
    if (new Set(rows.map((r) => r.rgb)).size === 1) {
      throw new Error(cls + ' kept the SAME colours across every open (' + rows[0].rgb + ') — 颜色不是随机重掷的');
    }
    if (new Set(rows.map((r) => r.alpha)).size === 1) {
      throw new Error(cls + ' kept the SAME opacity across every open (' + rows[0].alpha + ') — 云雾浓淡不是随机重掷的');
    }
    if (new Set(rows.map((r) => r.geometry)).size === 1) {
      throw new Error(cls + ' kept the SAME blob geometry across every open — 云团形状不是随机重掷的');
    }
    if (new Set(rows.map((r) => r.dir)).size === 1) {
      throw new Error(cls + ' kept the SAME animation direction across every open (' + rows[0].dir + ') — 运动方向不是随机重掷的');
    }
  }
  // The three layers must ALSO differ from each other in TIME, not only in
  // path: equal durations would make them convoy rigidly.
  const perRollDurations = rolls.map((css) => ['dms-sunsetCloudLo', 'dms-sunsetCloudHi', 'dms-sunsetGlow'].map((cls) => {
    const anim = /animation:dms-sunset-drift-[abc]-g\d+ ([\d.]+)s/.exec(rollRule(css, cls));
    return anim ? Number(anim[1]) : NaN;
  }));
  for (const durs of perRollDurations) {
    if (new Set(durs).size !== durs.length) {
      throw new Error('the sunset layers all run at the same speed in one roll (' + durs.join(', ') + '); they must not convoy');
    }
  }
});

// 3. a session the client has not listed yet must NOT throw out of inject
check('inject survives a directoryFor failure (fresh-conversation race)', () => {
  const { ctx, registrations } = makeCtx({ directoryThrows: true });
  loadModule().apply(ctx);
  const seat = seatOf(registrations);
  const injected = seat.options.inject('brand-new-session');
  if (typeof injected.resolveDirectory !== 'function') throw new Error('resolveDirectory missing');
  renderNode(seat.component(injected), 0);
  if (injected.load) injected.load();
  if (injected.select) injected.select({ provider: 'p', model: 'm' });
});

// 2. The injected stylesheet must be well-formed: one stray brace would make
// the browser drop every following rule, silently un-styling the whole plugin.
check('injected stylesheet is well-formed and carries the capsule rules', () => {
  const made = makeCtx({});
  injectedCss = '';
  loadModule().apply(made.ctx);
  if (!injectedCss) throw new Error('no stylesheet was injected');
  let depth = 0;
  for (const ch of injectedCss) {
    if (ch === '{') depth += 1;
    else if (ch === '}') {
      depth -= 1;
      if (depth < 0) throw new Error('unbalanced "}" in the stylesheet');
    }
  }
  if (depth !== 0) throw new Error('unbalanced braces; depth ended at ' + depth);
  if (injectedCss.indexOf('dms-sliderCapsule') === -1) throw new Error('capsule rules missing from the stylesheet');
  if (injectedCss.indexOf('dms-switch') === -1) throw new Error('switch fallback rules missing from the stylesheet');
  // A capsule needs BOTH ends semicircular: radius >= half the 24px track height
  // on the track AND on the fill (whose width varies with the tier), plus the
  // round handle. `corner-shape:round` keeps a superellipse theme from squaring
  // the ends off against the round handle.
  const cssRule = (selector) => {
    const at = injectedCss.indexOf(selector);
    if (at === -1) throw new Error('css rule missing: ' + selector);
    return injectedCss.slice(at, injectedCss.indexOf('}', at));
  };
  for (const selector of ['.dms-sliderCapsule .dms-track', '.dms-sliderCapsule .dms-fill']) {
    const rule = cssRule(selector);
    if (!/border-radius:\s*999px/.test(rule)) throw new Error('not a capsule (no full radius): ' + selector + ' -> ' + rule);
    if (!/corner-shape:\s*round/.test(rule)) throw new Error('missing corner-shape:round: ' + selector);
  }
  const thumbRule = cssRule('.dms-sliderCapsule .dms-thumb');
  if (!/border-radius:\s*50%/.test(thumbRule)) throw new Error('handle is not a circle: ' + thumbRule);
  // The handle is a circle inside the fill's end cap, so a ring of fill colour
  // shows around it. Its size is DERIVED from the capsule bar height rather than
  // hard-coded: the cap radius is half the bar, and the ring is what is left after
  // the handle. A hard-coded pixel value here would silently stop matching the bar
  // the moment the bar is resized.
  const capsuleTrackRule = cssRule('.dms-sliderCapsule .dms-track');
  const capsuleBarH = /height:\s*(\d+)px/.exec(capsuleTrackRule);
  if (!capsuleBarH) throw new Error('the capsule track has no explicit height: ' + capsuleTrackRule);
  const barH = Number(capsuleBarH[1]);
  const capRadius = barH / 2;
  const handleSize = Number(/width:\s*(\d+)px/.exec(thumbRule)[1]);
  if (!/height:\s*(\d+)px/.test(thumbRule) || Number(/height:\s*(\d+)px/.exec(thumbRule)[1]) !== handleSize) {
    throw new Error('handle is not square: ' + thumbRule);
  }
  // The handle must be strictly smaller than the cap so the ring exists, and the
  // ring must be an even number of pixels so it renders symmetrically.
  const ring = capRadius - handleSize / 2;
  if (ring <= 0) throw new Error('the handle (' + handleSize + 'px) does not fit inside the ' + barH + 'px cap; no ring would show');
  if (ring % 1 !== 0) throw new Error('the handle ring is not a whole number of pixels: ' + ring);
  // The transform must centre the handle: exactly half its own width.
  const thumbShift = /transform:translate\((-?\d+)px,\s*-50%\)/.exec(thumbRule);
  if (!thumbShift || Math.abs(Number(thumbShift[1])) !== handleSize / 2) {
    throw new Error('the handle transform does not centre a ' + handleSize + 'px handle: ' + thumbRule);
  }
  // The bar must still be a real capsule: the ends must be semicircles. Only the
  // layers that ARE meant to be clipped to the bar are checked 鈥?the nyan rainbow
  // is deliberately NOT rounded, because it has to show its corners and its
  // up/down wave outside the bar shape.
  const undertowRound = cssRule('.dms-sliderCapsule .dms-undertow');
  if (!/border-radius:\s*999px/.test(undertowRound)) {
    throw new Error('the undertow overlay is no longer a capsule: ' + undertowRound);
  }
  // Every layer painted over the bar must match the bar's height, or it would sit
  // as a shorter slab inside the taller capsule.
  for (const sel of ['.dms-sliderCapsule .dms-fill', '.dms-sliderCapsule .dms-fillSheen', '.dms-sliderCapsule .dms-undertow']) {
    const r = cssRule(sel);
    if (r.indexOf('height:') !== -1 && !new RegExp('height:\\s*' + barH + 'px').test(r)) {
      throw new Error(sel + ' does not match the ' + barH + 'px bar height: ' + r);
    }
  }
  // GEOMETRY CONSISTENCY. The capsule bar's size is duplicated across several
  // places that must agree: the bar height (CSS), the slider row that has to
  // contain it, the handle (CSS + the JS thumbW), the travel inset (CSS + the JS
  // inset) and the JS fillCap. Each pair is checked against the other rather than
  // against a literal, so resizing the bar cannot leave one copy behind —
  // which is exactly how the first attempt at this resize failed.
  //
  // NOTE: the bar no longer carries a 4px box-shadow spread ring. That ring drew
  // a second, larger capsule around the bar and the ui asked for it to go
  // ("把滑块栏胶囊外围的那一层大胶囊去掉，只保留内层胶囊"). Its absence is asserted
  // below, so it cannot creep back in.
  const capsuleSliderRule = cssRule('.dms-sliderCapsule{');
  const capsuleRowH = Number(/height:\s*(\d+)px/.exec(capsuleSliderRule)[1]);
  if (!capsuleSliderRule.includes('--dms-bar-y:50%')) {
    throw new Error('the taller capsule bar is not re-centred in its row: ' + capsuleSliderRule);
  }
  if (barH > capsuleRowH) {
    throw new Error('the capsule bar (' + barH + 'px) does not fit its ' + capsuleRowH + 'px row');
  }
  const geomSrc = source.slice(source.indexOf('capsule: {'), source.indexOf('}', source.indexOf('capsule: {')));
  const jsGeom = {
    inset: Number(/inset:\s*(\d+)/.exec(geomSrc)[1]),
    thumbW: Number(/thumbW:\s*(\d+)/.exec(geomSrc)[1]),
    fillCap: Number(/fillCap:\s*(\d+)/.exec(geomSrc)[1])
  };
  const capR = barH / 2;
  if (jsGeom.fillCap !== capR) {
    throw new Error('JS fillCap (' + jsGeom.fillCap + ') must equal the cap radius (' + capR + ') or the fill will not reach the bar edge at MAX');
  }
  if (jsGeom.inset !== jsGeom.fillCap) {
    throw new Error('JS inset (' + jsGeom.inset + ') must equal fillCap (' + jsGeom.fillCap + ') or the handle travel will not line up with the fill cap');
  }
  if (jsGeom.thumbW !== handleSize) {
    throw new Error('the CSS handle (' + handleSize + 'px) and JS thumbW (' + jsGeom.thumbW + ') disagree');
  }
  const cssInset = Number(/left:\s*(\d+)px/.exec(cssRule('.dms-sliderCapsule .dms-dots'))[1]);
  if (cssInset !== jsGeom.inset) {
    throw new Error('the CSS dot/rainbow inset (' + cssInset + 'px) and JS inset (' + jsGeom.inset + ') disagree');
  }
  // The shape isolation rule: growing the capsule must NOT have touched the
  // default shape's original 24px bar in its 32px row.
  if (!/height:24px/.test(cssRule('.dms-track{'))) {
    throw new Error('the rounded shape\'s 24px bar was altered by the capsule resize');
  }
  if (!/height:32px/.test(cssRule('.dms-slider{'))) {
    throw new Error('the rounded shape\'s 32px row was altered by the capsule resize');
  }
  // The unfilled track must NOT be the grey gutter the default shape uses — it is
  // still painted with the well colour (the panel's own surface), now sourced
  // from the OPAQUE bg-layer alias rather than the menu token (0.1.7-rc.1 made
  // the menu token translucent; an alpha well would show the page through the
  // unfilled half of the bar).
  const trackRule = cssRule('.dms-sliderCapsule .dms-track');
  if (!/--dms-well:\s*var\(--dsw-alias-bg-layer-3\)/.test(trackRule)) {
    throw new Error('capsule track does not define the shared well paint: ' + trackRule);
  }
  if (!/background-color:\s*var\(--dms-well\)/.test(trackRule)) {
    throw new Error('the unfilled capsule track is not painted with the well colour: ' + trackRule);
  }
  // The OUTER capsule ring is REMOVED by request ("只保留内层胶囊"). It was a
  // 4px box-shadow SPREAD in the well colour: `0 0 0 4px`, i.e. FOUR lengths —
  // x, y, blur, spread. A zero-offset shadow with a spread draws the bar's own
  // silhouette inflated by that many pixels, which is a second, larger capsule.
  //
  // Only the four-length form is a ring: `0 0 3px` is a plain BLUR (three
  // lengths), which just softens the bar's own edge and must stay allowed.
  if (/box-shadow:[^;]*\b0\s+0\s+0\s+\d+px/.test(trackRule)) {
    throw new Error('the outer capsule ring is back (a `0 0 0 <spread>` box-shadow draws a second, larger capsule around the bar): ' + trackRule);
  }
  // The outer capsule draws NO boundary line 鈥?it is defined by the soft shadow
  // alone 鈥?but that shadow must survive.
  if (trackRule.indexOf('--dsw-alias-border-l2') !== -1) {
    throw new Error('the outer capsule still draws its boundary line: ' + trackRule);
  }
  // The shadows are the ONLY thing marking the capsule's edge now, so both layers
  // must be present and must not be weakened below the tuned values.
  const shadowLayers = /box-shadow:([^;}]*)/.exec(trackRule);
  const layers = shadowLayers ? shadowLayers[1] : '';
  if (!/0 0 2px rgba\(0,0,0,\.10\)/.test(layers)) {
    throw new Error('the capsule lost its tight edge shadow: ' + layers);
  }
  if (!/0 0 10px rgba\(0,0,0,\.15\)/.test(layers)) {
    throw new Error('the capsule lost (or weakened) its halo shadow: ' + layers);
  }
  // The shade must wrap the capsule on ALL sides: no layer may carry an x or y
  // offset, which is what turns a halo into a downward drop shadow. Layers are
  // split on TOP-LEVEL commas only (rgb(...)/var(...) carry their own), and the
  // offsets are parsed as NUMBERS because CSS writes a zero length as bare `0`.
  const splitLayers = (value) => {
    const out = [];
    let depth = 0;
    let start = 0;
    for (let i = 0; i < value.length; i += 1) {
      const ch = value[i];
      if (ch === '(') depth += 1;
      else if (ch === ')') depth -= 1;
      else if (ch === ',' && depth === 0) { out.push(value.slice(start, i)); start = i + 1; }
    }
    out.push(value.slice(start));
    return out.map((part) => part.trim()).filter((part) => part !== '');
  };
  const parsedLayers = splitLayers(layers);
  if (parsedLayers.length !== 2) throw new Error('expected the two shade layers and NO well ring, got: ' + layers);
  for (const layer of parsedLayers) {
    const tokens = layer.split(/\s+/);
    const x = parseFloat(tokens[0]);
    const y = parseFloat(tokens[1]);
    if (Number.isNaN(x) || Number.isNaN(y)) throw new Error('shadow layer does not start with offsets: ' + layer);
    if (x !== 0 || y !== 0) {
      throw new Error('shadow layer "' + layer + '" has an offset; the shade must be even on all four sides');
    }
  }
  if (/dsw-alias-interactive-bg-hover/.test(trackRule)) {
    throw new Error('the capsule track still falls back to the grey gutter: ' + trackRule);
  }
  // The DEFAULT shape keeps its original grey gutter untouched.
  const baseTrackRule = cssRule('.dms-track{');
  if (!/background-color:\s*var\(--dsw-alias-interactive-bg-hover\)/.test(baseTrackRule)) {
    throw new Error('the default track lost its original grey background: ' + baseTrackRule);
  }
  // Glass only redefines the variable, so it cannot desync the two.
  const glassTrackRule = cssRule('.dms-panelGlass .dms-sliderCapsule .dms-track');
  if (!/--dms-well:/.test(glassTrackRule)) throw new Error('the glass variant does not retint the well: ' + glassTrackRule);
  if (/background-color|box-shadow/.test(glassTrackRule)) {
    throw new Error('the glass variant duplicates paint instead of retinting the well: ' + glassTrackRule);
  }
  // The other 24px bar (the undertow reveal overlay) must follow the same outline.
  if (!/border-radius:\s*999px/.test(cssRule('.dms-sliderCapsule .dms-undertow'))) {
    throw new Error('undertow overlay is not a capsule');
  }
  // The Faster/Smarter end labels and the original text header belong to the
  // DEFAULT shape and must still exist in the stylesheet, the markup and both
  // dictionaries 鈥?they are only *not rendered* while the capsule shape is on.
  if (injectedCss.indexOf('dms-rangeLabels') === -1) throw new Error('range-label CSS was removed but the rounded shape still needs it');
  if (!/range\.faster/.test(source) || !/range\.smarter/.test(source)) throw new Error('range-label locale keys are missing');
  if (!/effort\.title/.test(source)) throw new Error('the effort.title locale key is missing');
  if (/dms-pillLabel/.test(injectedCss)) throw new Error('the abandoned pill label rule came back');
  // Capsule header: the pill exists, and the ORIGINAL text header rules survive
  // side by side so the rounded shape keeps them.
  if (injectedCss.indexOf('dms-effortPill') === -1) throw new Error('effort pill CSS missing');
  // The pill is a FROSTED (matte) glass chip: heavy blur + a flat translucent
  // tint + a diffuse edge, and NO gloss. All of that must hold, or it silently
  // degrades either to a flat opaque fill or back to the glossy liquid-glass look.
  const pillRule = cssRule('.dms-effortPill{');
  const frost = /backdrop-filter:blur\((\d+(?:\.\d+)?)px\)/.exec(pillRule);
  if (!frost) throw new Error('the pill lost its frosted backdrop: ' + pillRule);
  if (Number(frost[1]) < 16) throw new Error('the frost is too light to read as frosted glass: blur(' + frost[1] + 'px)');
  // A SINGLE flat tint, not a gradient: a light-to-dark falloff reads as polish.
  if (!/background:color-mix\(in srgb,var\(--dsw-alias-label-primary\)/.test(pillRule)) {
    throw new Error('the pill body is not a flat translucent tint: ' + pillRule);
  }
  if (/background:linear-gradient/.test(pillRule)) {
    throw new Error('the pill body is a gloss gradient again; matte frosted glass is flat: ' + pillRule);
  }
  if (!/transparent\)/.test(pillRule)) throw new Error('the pill body is not translucent: ' + pillRule);
  if (/background:var\(--dsw-alias-interactive-bg-hover\)/.test(pillRule)) {
    throw new Error('the pill fell back to an opaque flat fill: ' + pillRule);
  }
  // No gloss: no inset speculars, and no vibrancy boost either (both are what
  // made the previous liquid-glass version read as polished).
  if (/inset 0 -?1px 0 rgba\(255,255,255/.test(pillRule)) {
    throw new Error('the pill regained a specular highlight; frosted glass is matte: ' + pillRule);
  }
  if (/saturate\(/.test(pillRule)) {
    throw new Error('the pill regained a vibrancy boost; frosted glass does not saturate: ' + pillRule);
  }
  if (!/border-radius:999px/.test(pillRule) || !/corner-shape:round/.test(pillRule)) {
    throw new Error('the pill is no longer a capsule: ' + pillRule);
  }
  // On a GLASS panel the row must carry the panel's transparency, not its own
  // paint: a nested backdrop-filter samples the already-composited panel, so the
  // pill's own tint + blur stacked into a visibly more solid patch. The glass
  // override therefore has to cancel BOTH the tint and the nested blur.
  const glassPillRule = cssRule('.dms-panelGlass .dms-effortPill{');
  if (!/background:\s*none/.test(glassPillRule)) {
    throw new Error('the pill still tints itself on a glass panel: ' + glassPillRule);
  }
  if (!/backdrop-filter:\s*none/.test(glassPillRule)) {
    throw new Error('the pill still stacks a nested backdrop-filter on a glass panel: ' + glassPillRule);
  }
  if (injectedCss.indexOf('dms-panelTitle') === -1 || injectedCss.indexOf('dms-panelValue') === -1) {
    throw new Error('the original text-header rules were deleted');
  }
  // The DEFAULT header is byte-for-byte the original: left-aligned, with the 4px
  // nudge that aligned it to the panel content.
  const headerRule = cssRule('.dms-panelHeader');
  if (!/justify-content:\s*space-between/.test(headerRule)) throw new Error('the default header is no longer the original: ' + headerRule);
  if (!/padding-left:\s*4px/.test(headerRule)) throw new Error('the default header lost its 4px nudge: ' + headerRule);
  // ...and ONLY the capsule variant centres it, overriding that nudge.
  const capsuleHeaderRule = cssRule('.dms-panelCapsule .dms-panelHeader');
  if (!/justify-content:\s*center/.test(capsuleHeaderRule)) throw new Error('the capsule header is not centred: ' + capsuleHeaderRule);
  if (!/padding-left:\s*0/.test(capsuleHeaderRule)) throw new Error('the capsule header does not clear the nudge: ' + capsuleHeaderRule);
  // The capsule header stacks caption-over-chip, so it MUST be a column: left as
  // a row the caption would sit BESIDE the pill, which is not the design.
  if (!/flex-direction:\s*column/.test(capsuleHeaderRule)) {
    throw new Error('the capsule header is not stacking the caption above the chip: ' + capsuleHeaderRule);
  }
  // The caption sits above the chip. It is deliberately the LARGEST type in the
  // panel (14px/700) 鈥?bigger than the 12px/600 tier it labels 鈥?so the thing
  // separating "caption" from "value" is its tertiary colour, which therefore
  // has to stay tertiary.
  const captionRule = cssRule('.dms-pillCaption{');
  if (!/color:var\(--dsw-alias-label-tertiary\)/.test(captionRule)) {
    throw new Error('the caption does not use the tertiary label colour: ' + captionRule);
  }
  const captionSize = /font-size:\s*(\d+(?:\.\d+)?)px/.exec(captionRule);
  if (!captionSize || Number(captionSize[1]) !== 14) {
    throw new Error('the caption is not 14px: ' + captionRule);
  }
  const captionWeight = /font-weight:\s*(\d+)/.exec(captionRule);
  if (!captionWeight || Number(captionWeight[1]) !== 700) {
    throw new Error('the caption is not weight 700: ' + captionRule);
  }
  // The line box MUST clear the glyphs: a line-height below font-size clips the
  // ascenders/descenders. This is the regression a size bump actually invites.
  const captionLine = /line-height:\s*(\d+(?:\.\d+)?)px/.exec(captionRule);
  if (!captionLine) throw new Error('the caption has no explicit line-height: ' + captionRule);
  if (Number(captionLine[1]) < Number(captionSize[1])) {
    throw new Error('the caption line-height (' + captionLine[1] + 'px) is below its font-size (' + captionSize[1] + 'px) and would clip: ' + captionRule);
  }
  if (!/margin-bottom:/.test(captionRule)) throw new Error('the caption has no gap to the chip: ' + captionRule);
  // It is a LABEL, not a surface: no paint of its own, exactly like the pill on
  // a glass panel. A background or a nested backdrop-filter here would put a
  // second, differently-transparent patch on the row.
  if (/background:/.test(captionRule)) throw new Error('the caption paints its own background: ' + captionRule);
  if (/backdrop-filter:/.test(captionRule)) throw new Error('the caption stacks a nested backdrop-filter: ' + captionRule);
  // Both dictionaries must carry the key 鈥?a missing one renders the raw key.
  const captionKeys = source.match(/"pill\.title":\s*"[^"]*"/g) || [];
  if (captionKeys.length !== 2) throw new Error('pill.title must be defined in both dictionaries, found ' + captionKeys.length);
  for (const decl of captionKeys) {
    if (!/"Effort"/.test(decl)) throw new Error('the caption text is not "Effort": ' + decl);
  }

  // The gradient-text effect must stay intact on the glass panel too: an override
  // once forced it to a solid colour on the theory that `background-clip:text`
  // does not survive a `backdrop-filter` ancestor. Direct rendering disproved
  // that, so the override is gone and must not come back.
  const gradRule = cssRule('.dms-labelGrad{');
  if (!/-webkit-background-clip:\s*text/.test(gradRule)) {
    throw new Error('the gradient-text effect was removed: ' + gradRule);
  }
  if (!/-webkit-text-fill-color:\s*transparent/.test(gradRule)) {
    throw new Error('the gradient text is not using a transparent fill: ' + gradRule);
  }
  // The ramp must be BLUE -> PURPLE, saturated at every stop. The original ramp
  // began on #e9d5ff (rgb 233,213,255 鈥?saturation 42), a near-WHITE lavender;
  // because `background-size:200%` shows the ramp's first half at rest, that end
  // dominated the glyphs and the effect read as white-to-purple. Measure it rather
  // than trusting the literals: every stop, and every interpolated phase, has to
  // stay clear of the pale end.
  const rampStops = /linear-gradient\(90deg,(#[0-9A-Fa-f]{6}(?:,#[0-9A-Fa-f]{6})+)\)/.exec(gradRule);
  if (!rampStops) throw new Error('the gradient ramp is not a flat hex stop list: ' + gradRule);
  const stops = rampStops[1].split(',').map((h) => [
    parseInt(h.slice(1, 3), 16), parseInt(h.slice(3, 5), 16), parseInt(h.slice(5, 7), 16)
  ]);
  const satOf = (c) => Math.max(c[0], c[1], c[2]) - Math.min(c[0], c[1], c[2]);
  for (const c of stops) {
    if (satOf(c) < 100) {
      throw new Error('gradient stop rgb(' + c.join(',') + ') is too pale (saturation ' + satOf(c) + '); it will read as white, not blue');
    }
  }
  // Dense sweep: no phase of the textflow animation may wash out.
  let worstSat = Infinity;
  for (let p = 0; p <= 1.0001; p += 0.01) {
    const x = p * (stops.length - 1);
    const i = Math.min(stops.length - 2, Math.floor(x));
    const t = x - i;
    const c = stops[i].map((v, k) => v + (stops[i + 1][k] - v) * t);
    worstSat = Math.min(worstSat, satOf(c));
  }
  if (worstSat < 100) {
    throw new Error('the gradient washes out to near-white at some animation phase (worst saturation ' + Math.round(worstSat) + ')');
  }
  // It must also START blue and END purple. Channel comparison, not hue maths:
  // a blue has GREEN above RED (#3B82F6 -> g130 > r59), while a purple/magenta has
  // RED above GREEN (#A855F7 -> r168 > g85). Testing only "more blue than red"
  // would NOT discriminate, because purple is blue-dominant too 鈥?a reversed
  // purple-first ramp slipped through that weaker check.
  if (!(stops[0][1] > stops[0][0])) {
    throw new Error('the ramp does not start blue (first stop rgb(' + stops[0].join(',') + ') has red >= green)');
  }
  // ...and it must progress toward purple: red rises across the ramp.
  const last = stops[stops.length - 1];
  if (!(last[0] > stops[0][0])) {
    throw new Error('the ramp does not end more purple than it starts (red ' + stops[0][0] + ' -> ' + last[0] + ')');
  }
  // REGRESSION: the gradient must not be droppable by the cascade. `.dms-pillValue`
  // and `.dms-panelValue` both declare `color` AFTER `.dms-labelGrad` at the SAME
  // specificity, which beat `color:transparent` and left the pill (and the rounded
  // value) dependent on the prefixed `-webkit-text-fill-color` alone 鈥?lose that
  // and they render SOLID BLUE with the gradient gone. A two-class selector has to
  // out-rank the single-class `color`, so transparency is pinned by specificity.
  const pinAt = injectedCss.indexOf('.dms-pillValue.dms-labelGrad');
  if (pinAt === -1) throw new Error('the gradient transparency pin is missing; the pill value can fall back to solid blue');
  const pinRule = injectedCss.slice(pinAt, injectedCss.indexOf('}', pinAt));
  if (!/color:\s*transparent/.test(pinRule)) {
    throw new Error('the gradient transparency pin does not force a transparent fill: ' + pinRule);
  }
  // Every gradient carrier that also has a competing single-class `color` must be
  // covered, or that one element silently keeps its solid colour.
  for (const carrier of ['.dms-pillValue', '.dms-panelValue', '.dms-effortValue', '.dms-effortCaption']) {
    if (pinRule.indexOf(carrier) === -1) {
      throw new Error('the gradient carrier ' + carrier + ' is not covered by the transparency pin: ' + pinRule);
    }
    // The carrier must actually be a gradient element at MAX, or the pin is dead
    // code. Class ATTRIBUTE values carry no leading dot, the selector does.
    //
    // TWO legal spellings now, because only the carriers that show the TIER VALUE
    // roll. The tier value's carriers fold the class in through `rollCarrier`,
    // which also appends `dms-rollHost` so the carrier's own clipped paint can be
    // switched off while the text rolls (an ancestor's `background-clip:text` does
    // not follow a transformed descendant — measured in Chrome). The static
    // "推理强度" caption shows no tier value, so it keeps the inline form. Both
    // satisfy what this guard is actually for: the pin must not be dead code.
    const bare = carrier.replace(/^\./, '');
    const rolls = source.indexOf('rollCarrier("' + bare + '")') !== -1;
    const inline = source.indexOf('"' + bare + '" + gradClass') !== -1;
    if (!rolls && !inline) {
      throw new Error(carrier + ' never receives gradClass, so the pin guards nothing');
    }
  }
  // The pin must out-rank the competing rule: assert the selector really carries
  // two classes rather than relying on the string alone.
  const pinSelectors = pinRule.split('{')[0].split(',');
  for (const sel of pinSelectors) {
    const classes = (sel.match(/\.[A-Za-z][\w-]*/g) || []).length;
    if (classes < 2) throw new Error('the pin selector "' + sel.trim() + '" is not specific enough to beat a single class');
  }
  // ROOT-CAUSE GUARD: the solid colour must be gated behind `:not(.dms-labelGrad)`
  // so that at MAX nothing competes with the gradient's `color:transparent`. As a
  // plain `.dms-pillValue{color:#3b82f6}` (later, same specificity) the transparent
  // colour lost, leaving the gradient hinging on the prefixed
  // `-webkit-text-fill-color`. Verified by rendering: with that property DELETED
  // the gradient still measures 115 through `:not()`, but collapses to the
  // solid-blue value 187 without it.
  for (const carrier of ['dms-pillValue', 'dms-effortCaption']) {
    // EVERY gradient class must be excluded, not just MAX's. `:not()` adds the
    // specificity of its argument, so the carrier's colour rule is (0,2,0) and
    // outranks a single-class gradient (0,1,0) — if a gradient class is missing
    // from this chain, that tier matches the rule, wins, and renders SOLID
    // colour with no gradient. Checking only for the MAX class was a guard that
    // silently stopped covering the second tier: the new selector still
    // CONTAINED the old substring, so `indexOf` passed while the tier below MAX
    // was completely unprotected.
    //
    // Parsed as a SELECTOR, not searched as a substring. A chained
    // `:not(.a):not(.b)` never contains the literal `:not(.b)` immediately
    // after the carrier, so a naive `indexOf('.carrier:not(.b)')` reports a
    // false failure on the very shape the guard asks for.
    const carrierRule = new RegExp('\\.' + carrier + '((?::not\\(\\.[A-Za-z][\\w-]*\\))+)\\{').exec(injectedCss);
    if (!carrierRule) {
      throw new Error(carrier + ' has no :not() colour guard at all');
    }
    const excluded = [...carrierRule[1].matchAll(/:not\(\.([A-Za-z][\w-]*)\)/g)].map((m) => m[1]);
    for (const grad of ['dms-labelGrad', 'dms-labelGradHigh']) {
      if (excluded.indexOf(grad) === -1) {
        throw new Error(carrier + ' must exclude .' + grad + ' from its solid colour (excluded: ' + excluded.join(', ') + '), or that tier renders solid colour');
      }
    }
    // ...and the unguarded declaration must be gone, or it would simply win again.
    const unguarded = new RegExp('\\.' + carrier + '\\{[^}]*color:');
    const hit = unguarded.exec(injectedCss);
    if (hit) {
      throw new Error(carrier + ' still declares a plain `color` that can beat the gradient: ' + hit[0]);
    }
  }
  // The transparency pin must cover the LOWER tier as well, for the same
  // specificity reason (see the pin above): a carrier with the high class but
  // no two-class pin falls back to the solid `color`.
  for (const carrier of ['dms-pillValue', 'dms-panelValue', 'dms-effortValue', 'dms-effortCaption']) {
    if (injectedCss.indexOf('.' + carrier + '.dms-labelGradHigh') === -1) {
      throw new Error('.' + carrier + ' is not covered by the transparency pin for the tier below MAX');
    }
  }
  if (injectedCss.indexOf('.dms-panelGlass .dms-panelValue') !== -1) {
    throw new Error('the disproved glass gradient override is back');
  }
  // The glass panel's ONLY paint is its uniform translucent tint: a backdrop
  // filter and one background, nothing that could band a single row.
  const glassRule = cssRule('.dms-panel.dms-panelGlass{');
  if (!/backdrop-filter:\s*blur\(/.test(glassRule)) throw new Error('the glass panel lost its blur: ' + glassRule);
  if ((glassRule.match(/background:/g) || []).length !== 1) {
    throw new Error('the glass panel paints more than one background: ' + glassRule);
  }
  // The rounded shape's corners were deliberately softened (track/fill family
  // 7px -> 10px, handle 6px -> 9px). Two invariants keep that coherent:
  //   - every layer of the bar family must share ONE radius, or the fill's
  //     corners would peek out from under the track's (and vice versa);
  //   - the handle must stay a ROUNDED RECTANGLE, i.e. its radius must be below
  //     half its width, otherwise it would silently become the capsule handle.
  const barRadius = /border-radius:(\d+)px/.exec(cssRule('.dms-track{'));
  if (!barRadius) throw new Error('the track has no radius');
  const barLayers = ['.dms-fill{', '.dms-fillSheen{', '.dms-fillGlint{', '.dms-fillSpray{', '.dms-undertow{'];
  for (const sel of barLayers) {
    const r = /border-radius:(\d+)px/.exec(cssRule(sel));
    if (!r || r[1] !== barRadius[1]) {
      throw new Error('bar layer ' + sel + ' radius ' + (r ? r[1] : '?') + ' does not match the track\'s ' + barRadius[1]);
    }
  }
  if (Number(barRadius[1]) <= 7) throw new Error('the rounded bar was supposed to get MORE rounded, still ' + barRadius[1] + 'px');
  if (Number(barRadius[1]) * 2 >= 24) throw new Error('the rounded track has become a capsule (' + barRadius[1] + 'px at 24px tall); that is the other shape');
  const thumbRadius = /border-radius:(\d+)px/.exec(cssRule('.dms-thumb{'));
  if (!thumbRadius) throw new Error('the handle has no radius');
  if (Number(thumbRadius[1]) <= 6) throw new Error('the handle was supposed to get MORE rounded, still ' + thumbRadius[1] + 'px');
  if (Number(thumbRadius[1]) * 2 >= 22) throw new Error('the handle has become a stadium (' + thumbRadius[1] + 'px at 22px wide)');
  if (Number(thumbRadius[1]) > Number(barRadius[1])) {
    throw new Error('the handle is more rounded than the bar it sits in: ' + thumbRadius[1] + ' vs ' + barRadius[1]);
  }

  // The panel outline: the capsule variant softens it further, and it must
  // out-specify the base rule (two classes) so it cannot lose on source order.
  // Both radii were raised on request, so the invariant asserted here is the
  // RELATIONSHIP (capsule strictly rounder than the default), not a fixed number.
  const basePanelRule = cssRule('.dms-panel{');
  const baseRadius = /border-radius:\s*(\d+)px/.exec(basePanelRule);
  if (!baseRadius) throw new Error('the default panel has no radius: ' + basePanelRule);
  if (Number(baseRadius[1]) < 15) {
    throw new Error('the panel was supposed to get MORE rounded, still ' + baseRadius[1] + 'px');
  }
  const capsulePanelRule = cssRule('.dms-panel.dms-panelCapsule{');
  const capsuleRadius = /border-radius:\s*(\d+)px/.exec(capsulePanelRule);
  if (!capsuleRadius) throw new Error('the capsule panel has no radius: ' + capsulePanelRule);
  if (Number(capsuleRadius[1]) <= Number(baseRadius[1])) {
    throw new Error('the capsule panel (' + capsuleRadius[1] + 'px) must stay rounder than the default (' + baseRadius[1] + 'px)');
  }

  // Shape isolation, the important half: the 鍦嗚鐭╁舰 shape must be untouched by
  // the capsule redesign, so its ORIGINAL rules have to survive VERBATIM. A regex
  // spot-check would let a subtle edit through, so these are full-string matches.
  const ROUNDED_RULES = [
    '".dms-panelHeader{display:flex;align-items:baseline;justify-content:space-between;margin-bottom:11px;padding-left:4px}",',
    '".dms-labelGroup{display:flex;align-items:baseline}",',
    '".dms-panelTitle{font-size:12px;color:var(--dsw-alias-label-tertiary);font-weight:500}",',
    '".dms-panelValue{color:#3b82f6;font-weight:600;margin-left:5px;font-size:13px}",',
    '".dms-rangeLeft{color:#3B82F6}",',
    '".dms-rangeRight{color:#8B5CF6}",',
    '".dms-slider{--dms-bar-y:calc(50% - 8.5px);position:relative;height:32px;',
    '".dms-track{position:absolute;left:0;right:0;top:var(--dms-bar-y);transform:translateY(-50%);height:24px;border-radius:10px;',
    '".dms-thumb{position:absolute;left:0;top:var(--dms-bar-y);width:22px;height:26px;border-radius:9px;background:#fff;border:1px solid rgba(0,0,0,.12);',
    '".dms-dots{position:absolute;left:9px;right:9px;top:var(--dms-bar-y);height:0;',
  ];
  for (const rule of ROUNDED_RULES) {
    if (source.indexOf(rule) === -1) throw new Error('an original rounded-shape rule was altered or lost: ' + rule.slice(0, 60));
  }
  // Every rule that mentions a capsule class must use it as a REAL class token,
  // so a panel/bar rendered WITHOUT the class (the rounded shape) can never match
  // it. `.dms-panelCapsule .x` and `.dms-panel.dms-panelCapsule` both qualify.
  let capsuleSelectors = 0;
  for (const m of source.matchAll(/"([^"]*dms-(?:slider|panel)Capsule[^"]*?)\{/g)) {
    capsuleSelectors += 1;
    if (!/\.dms-(?:slider|panel)Capsule(?![\w-])/.test(m[1])) {
      throw new Error('capsule class used as a bare substring, not a class: ' + m[1]);
    }
  }
  if (capsuleSelectors < 10) throw new Error('expected the capsule rules to be present, found ' + capsuleSelectors);
});

// 3b-ter. Both model-picker floats must be OPAQUE (ui: "模型选择器的浮层不要有
// 透明效果"). They paint `--dsw-specific-menu` until 0.1.7-rc.1 redefined that
// token as an ALPHA colour — `#f8f9fa94` light (0x94 = 148/255 = 58%) and
// `#30313680` dark (= 50%) — where 0.1.5-rc.2 had it as `var(--dsw-alias-bg-layer-3)`,
// a solid. Merely upgrading DSH therefore made the model list see-through with no
// edit to this plugin, which is exactly the regression this pins.
//
// The fix uses `--dsw-alias-bg-layer-3`, the token the old menu colour pointed
// AT: opaque in both themes and present in BOTH DSH versions, so this is the
// original appearance restored rather than a colour invented here. An alpha
// background would be defensible for a surface composited over its own blur;
// these floats are not — the frosted look is a separate opt-in on the EFFORT
// panel (`.dms-panelGlass`), never on the model list.
check('the model picker floats paint an opaque background', () => {
  const cssNow = (() => { injectedCss = ''; loadModule().apply(makeCtx({}).ctx); return injectedCss; })();
  const ruleBody = (sel) => {
    const at = cssNow.indexOf(sel);
    if (at === -1) throw new Error('css rule missing: ' + sel);
    return cssNow.slice(at + sel.length, cssNow.indexOf('}', at));
  };
  for (const sel of ['.dms-menu{', '.dms-sub{']) {
    const body = ruleBody(sel);
    const bg = /background:([^;}]+)/.exec(body);
    if (!bg) throw new Error(sel + ' paints no background at all: ' + body);
    const paint = bg[1];
    // 1) The translucent menu token must not be used, in ANY form — plain, or
    //    through color-mix (which would multiply its alpha again).
    if (paint.indexOf('--dsw-specific-menu') !== -1) {
      throw new Error(sel + ' still paints the now-translucent menu token: ' + paint);
    }
    if (paint.indexOf('color-mix') !== -1 || paint.indexOf('transparent') !== -1) {
      throw new Error(sel + ' mixes its background with transparent: ' + paint);
    }
    // 2) It must be a real opaque alias, not an ad-hoc hex that could drift from
    //    the theme (and would not follow dark mode).
    if (!/var\(--dsw-alias-bg-layer-\d\)/.test(paint)) {
      throw new Error(sel + ' does not paint an opaque theme surface: ' + paint);
    }
    // 3) A stray `opacity` or `backdrop-filter` on the float would re-introduce
    //    see-through even with an opaque colour.
    if (/(^|;)opacity:/.test(body)) throw new Error(sel + ' carries an opacity: ' + body);
    if (body.indexOf('backdrop-filter') !== -1) {
      throw new Error(sel + ' carries a backdrop-filter, so the page shows through it: ' + body);
    }
  }
});

// 2b. The glass opacity range must not be able to switch the feature off by itself.
// At 100% the glass background is `color-mix(token 100%, transparent)`, which IS the
// opaque token the panel paints with glass OFF — so "toggling does nothing" and "the
// blur does nothing" were both literally true at the top of the range, and a saved
// 100% outlived the session as a config that defeated its own setting. Rendering the
// two states proved them pixel-identical. This pins the range, the self-heal and the
// rendered consequence.
check('glass opacity cannot reach a value that makes glass look like glass-off', () => {
  const cssNow = (() => { injectedCss = ''; loadModule().apply(makeCtx({}).ctx); return injectedCss; })();
  // The rule BODY, not the rest of the sheet: the capsule track rule carries the SAME
  // `color-mix(... var(--dms-glass-op,.62) ...)` expression further down, so a slice
  // running to the end of the stylesheet kept matching even after the panel rule
  // itself had been reduced to a solid token. A mutant proved that hole; this scopes
  // the search to the panel rule's own braces.
  const at = cssNow.indexOf('.dms-panel.dms-panelGlass{');
  if (at === -1) throw new Error('the glass panel rule is missing');
  const body = cssNow.slice(at, cssNow.indexOf('}', at));
  const mix = /color-mix\(in srgb,var\(--dsw-alias-bg-layer-3\) calc\(var\(--dms-glass-op,([\d.]+)\) \* 100%\),transparent\)/.exec(body);
  if (!mix) throw new Error('the glass background is no longer an opacity-driven color-mix over the opaque alias: ' + body);
  // A PERCEPTIBLE margin, not merely "below 100". Rendering the states over a striped
  // backdrop shows 100% and 99% are indistinguishable from glass-off, while 90% is
  // where the backdrop starts to read through — so at least a tenth of the backdrop
  // has to survive whatever opacity is configured. Compared in WHOLE PERCENT: doing
  // it as `1 - op` trips on floating point, since 1 - 0.9 is 0.09999999999999998.
  const MIN_SHOW_THROUGH_PCT = 10;
  const showThroughPct = (op) => 100 - Math.round(op * 100);
  const fallback = Number(mix[1]);
  if (showThroughPct(fallback) < MIN_SHOW_THROUGH_PCT) {
    throw new Error('the glass fallback opacity is ' + fallback + ', leaving under ' + MIN_SHOW_THROUGH_PCT + '% of the backdrop visible — indistinguishable from glass-off');
  }

  // Behavioural: the slider's ceiling and the self-heal for an already-saved 100.
  const panelFor = (settings) => {
    const made = makeCtx({ settingsValue: Object.assign({ advancedEffort: true, effortStyle: 'spray-flow', trackShape: 'capsule' }, settings) });
    loadModule().apply(made.ctx);
    const seat = seatOf(made.registrations);
    const injected = seat.options.inject('session-1');
    hookState.length = 0;
    let tree = expand(seat.component({ ...injected }));
    findAll(tree, (p) => p.className === 'dms-effortTrigger')[0].props.onClick();
    for (let i = 0; i < 4; i += 1) { runEffects(); resetHooks(); tree = expand(seat.component({ ...injected })); }
    return findAll(tree, (p) => typeof p.className === 'string' && /(^|\s)dms-panel(\s|$)/.test(p.className))[0];
  };
  const opacityOf = (settings) => {
    const panel = panelFor(settings);
    if (String(panel.props.className).indexOf('dms-panelGlass') === -1) throw new Error('the glass class is missing for ' + JSON.stringify(settings));
    const op = Number(panel.props.style['--dms-glass-op']);
    if (!(op > 0)) throw new Error('the panel got no opacity custom property: ' + JSON.stringify(panel.props.style));
    return op;
  };
  // A value already saved above the ceiling must self-heal, so a config written by an
  // earlier build cannot keep the feature defeated after this fix ships.
  const healed = opacityOf({ glassPanel: true, glassOpacity: 100, glassBlur: 6 });
  if (showThroughPct(healed) < MIN_SHOW_THROUGH_PCT) {
    throw new Error('a saved 100% still renders as ' + healed + ', leaving the panel indistinguishable from glass-off');
  }
  // ...and the ceiling itself must leave the same margin.
  const ceiling = opacityOf({ glassPanel: true, glassOpacity: 90, glassBlur: 6 });
  if (showThroughPct(ceiling) < MIN_SHOW_THROUGH_PCT) {
    throw new Error('the slider ceiling renders ' + ceiling + ', which is still visually opaque');
  }
});

// 3. The "婊戝潡鏍忓舰鐘? preference must reach the composer slider as a class.
// The slider only exists once the effort panel is open, so open it first.
check('slider bar shape reaches the composer slider as a class', () => {
  // Bar geometry is read back from the injected stylesheet so these assertions
  // track the real numbers instead of duplicating them.
  const css2 = (() => { injectedCss = ''; loadModule().apply(makeCtx({}).ctx); return injectedCss; })();
  const cssRule2 = (selector) => {
    const at = css2.indexOf(selector);
    if (at === -1) throw new Error('css rule missing: ' + selector);
    return css2.slice(at, css2.indexOf('}', at));
  };
  /** Render the open slider and return its root className plus the tree. */
  const sliderClassFor = (trackShape, effort) => {
    const made = makeCtx({ effort: effort || 'high', settingsValue: { advancedEffort: true, effortStyle: 'spray-flow', trackShape } });
    loadModule().apply(made.ctx);
    const seat = seatOf(made.registrations);
    const injected = seat.options.inject('session-1');
    hookState.length = 0;
    let tree = expand(seat.component({ ...injected }));
    const trigger = findAll(tree, (p) => p.className === 'dms-effortTrigger')[0];
    if (!trigger) throw new Error('effort trigger not found');
    trigger.props.onClick();
    tree = expand(seat.component({ ...injected }));
    const isSliderRoot = (p) => typeof p.className === 'string' && /\bdms-slider\b/.test(p.className);
    const slider = findAll(tree, isSliderRoot)[0];
    if (!slider) throw new Error('slider root not found after opening the panel');
    return { className: String(slider.props.className), tree };
  };

  const capsuleRun = sliderClassFor('capsule');
  const capsule = capsuleRun.className;
  if (capsule.indexOf('dms-sliderCapsule') === -1) throw new Error('capsule class missing: ' + capsule);
  const roundedRun = sliderClassFor('rounded');
  const rounded = roundedRun.className;
  if (rounded.indexOf('dms-sliderCapsule') !== -1) throw new Error('rounded must not carry the capsule class: ' + rounded);
  // An unknown/legacy stored value must fall back to the default shape rather
  // than produce a third, unstyled shape.
  const bogus = sliderClassFor('squircle').className;
  if (bogus.indexOf('dms-sliderCapsule') !== -1) throw new Error('unknown shape must fall back to rounded: ' + bogus);

  const countOf = (tree, cls) => findAll(tree, (p) => typeof p.className === 'string' && p.className.split(' ').indexOf(cls) !== -1).length;

  // CAPSULE panel: a single centred pill holding ONLY the tier, a caption above
  // it, and none of the original chrome.
  if (countOf(capsuleRun.tree, 'dms-effortPill') !== 1) throw new Error('capsule panel must render exactly 1 pill');
  const pillValues = findAll(capsuleRun.tree, (p) => typeof p.className === 'string' && p.className.indexOf('dms-pillValue') === 0);
  if (pillValues.length !== 1) throw new Error('pill must hold exactly the tier value, got ' + pillValues.length);
  if (countOf(capsuleRun.tree, 'dms-panelCapsule') !== 1) throw new Error('the capsule panel is not tagged dms-panelCapsule');
  // The caption row: a brand icon followed by the CURRENT MODEL NAME. The name is what
  // the row is for now — the tier is the chip right below it — and the name lives in
  // its own span so an ellipsis truncates the name and never the icon.
  const captions = findAll(capsuleRun.tree, (p) => typeof p.className === 'string' && p.className === 'dms-pillCaption');
  if (captions.length !== 1) throw new Error('capsule panel must render exactly 1 caption, got ' + captions.length);
  const captionKids = (captions[0].children || []).filter(Boolean);
  if (captionKids.length !== 2) {
    throw new Error('the caption should hold exactly the icon and the name span, got ' + captionKids.length);
  }
  const captionIcon = captionKids[0];
  if (String(captionIcon.type) !== 'svg') throw new Error('the caption does not lead with the brand icon, got ' + String(captionIcon.type));
  if (captionIcon.props['aria-hidden'] !== true) throw new Error('the caption icon is not aria-hidden decoration');
  if (!captionIcon.props.dangerouslySetInnerHTML || String(captionIcon.props.dangerouslySetInnerHTML.__html).indexOf('<path') === -1) {
    throw new Error('the caption icon carries no path data');
  }
  if (String(captionIcon.props.title || '').indexOf('DeepSeek') === -1) {
    throw new Error('the caption icon is not the current model brand, got ' + String(captionIcon.props.title));
  }
  // The caption's mark is larger than the shared default, and `size` is a per-call-site
  // argument precisely so that the model dropdown's own mark keeps its 14px. Asserted
  // because "just bump the default" is the tempting shortcut and would silently resize
  // the dropdown too.
  if (!(Number(captionIcon.props.width) > 14)) {
    throw new Error('the caption icon was not enlarged past the 14px shared default, got ' + captionIcon.props.width);
  }
  // ...but it must fit INSIDE the caption's own line box. A mark taller than the row
  // becomes the tallest flex item and grows the row, which pushes the chip and the bar
  // down and makes the whole panel taller — a layout change, not a size tweak. The
  // ceiling is therefore pinned to the row's declared line-height, read from the source
  // so it tracks the stylesheet rather than duplicating a number here.
  const captionLineHeight = Number(/\.dms-pillCaption\{[^}]*line-height:(\d+)px/.exec(source)[1]);
  if (!captionLineHeight) throw new Error('could not read the caption line-height');
  if (Number(captionIcon.props.width) > captionLineHeight) {
    throw new Error('the caption icon is ' + captionIcon.props.width + 'px against an ' + captionLineHeight + 'px line box, so it would grow the row and push the panel content down');
  }
  // Parsed rather than string-matched: the trigger gained a second per-site argument
  // (the `dy` optical offset), and pinning the whole call would report that as a size
  // change. What must not move is the 14px.
  const triggerMark = /DmiBrandIcon\(\{ brand: dmiBrandNow, size: (\d+)[^}]*\}\)/.exec(source);
  if (!triggerMark) throw new Error('the composer trigger brand mark call site changed shape');
  if (Number(triggerMark[1]) !== 14) {
    throw new Error('the model dropdown mark changed size as well; it must keep its 14px, got ' + triggerMark[1]);
  }
  const captionName = captionKids[1];
  if (!captionName || captionName.__el !== true) {
    throw new Error('the caption name is not wrapped in its own element, so an ellipsis would clip the icon: ' + JSON.stringify(captionName));
  }
  if (String(captionName.props.className) !== 'dms-pillCaptionText') {
    throw new Error('the caption name is not in its own span, so an ellipsis would clip the icon: ' + String(captionName.props.className));
  }
  if (String(captionName.children && captionName.children[0]) !== 'DeepSeek V4 Flash') {
    throw new Error('the caption does not show the current model name, got ' + JSON.stringify(captionName.children && captionName.children[0]));
  }
  // The full name rides on `title` because the row can truncate.
  if (captions[0].props.title !== 'DeepSeek V4 Flash') {
    throw new Error('the caption does not expose the untruncated name on hover: ' + String(captions[0].props.title));
  }
  const headerEl = findAll(capsuleRun.tree, (p) => String(p.className).indexOf('dms-panelHeader') !== -1)[0];
  if (!headerEl) throw new Error('capsule panel has no header');
  const headerKids = headerEl.children.map((c) => (c && typeof c.props.className === 'string' ? c.props.className : ''));
  const captionAt = headerKids.findIndex((c) => c === 'dms-pillCaption');
  const pillAt = headerKids.findIndex((c) => c === 'dms-effortPill');
  if (captionAt === -1 || pillAt === -1) throw new Error('caption and chip are not both direct children of the header: ' + headerKids.join(' | '));
  if (captionAt > pillAt) throw new Error('the caption renders BELOW the chip (caption@' + captionAt + ', chip@' + pillAt + '); it must sit above it');
  for (const gone of ['dms-panelTitle', 'dms-panelValue', 'dms-labelGroup', 'dms-rangeLabels', 'dms-rangeLeft', 'dms-rangeRight']) {
    if (countOf(capsuleRun.tree, gone) !== 0) throw new Error('capsule panel still renders: ' + gone);
  }

  // ROUNDED panel: the ORIGINAL chrome, and no pill. This is the regression that
  // matters 鈥?the capsule redesign must not leak into the default shape.
  if (countOf(roundedRun.tree, 'dms-effortPill') !== 0) throw new Error('the rounded panel must not render the pill');
  // The caption is capsule-only too: the rounded header keeps its own title.
  if (countOf(roundedRun.tree, 'dms-pillCaption') !== 0) throw new Error('the rounded panel must not render the "Effort" caption');
  if (countOf(roundedRun.tree, 'dms-panelCapsule') !== 0) throw new Error('the rounded panel must not carry the capsule tag');
  if (countOf(roundedRun.tree, 'dms-panelTitle') !== 1) throw new Error('the original "鎺ㄧ悊寮哄害" title is missing from the rounded panel');
  if (countOf(roundedRun.tree, 'dms-panelValue') !== 1) throw new Error('the original tier value is missing from the rounded panel');
  if (countOf(roundedRun.tree, 'dms-labelGroup') !== 1) throw new Error('the original label group is missing from the rounded panel');
  if (countOf(roundedRun.tree, 'dms-rangeLabels') !== 1) throw new Error('the Faster/Smarter row is missing from the rounded panel');
  if (countOf(roundedRun.tree, 'dms-rangeLeft') !== 1) throw new Error('the "Faster" label is missing from the rounded panel');
  if (countOf(roundedRun.tree, 'dms-rangeRight') !== 1) throw new Error('the "Smarter" label is missing from the rounded panel');

  // Concentricity: drive the REAL geometry by installing fake DOM nodes through
  // the element refs (each ref callback runs syncMountVisual). The fill must run
  // a full cap-radius past the handle centre for the capsule shape 鈥?which puts
  // the fill's end cap concentric with the handle and makes the fill visibly
  // contain it 鈥?and must stop at the handle centre for the default shape.
  //
  // The cap radius and handle width are READ FROM THE STYLESHEET, not hard-coded:
  // resizing the capsule bar changes both, and stale constants here would either
  // fail spuriously or (worse) pass while measuring the wrong geometry.
  const capRadiusFor = (trackShape) => {
    const rule = trackShape === 'capsule' ? cssRule2('.dms-sliderCapsule .dms-track') : cssRule2('.dms-track');
    const h = /height:\s*(\d+)px/.exec(rule);
    if (!h) throw new Error('no bar height for ' + trackShape + ': ' + rule);
    return Number(h[1]) / 2;
  };
  const handleWFor = (trackShape) => {
    const rule = trackShape === 'capsule' ? cssRule2('.dms-sliderCapsule .dms-thumb') : cssRule2('.dms-thumb{');
    const w = /width:\s*(\d+)px/.exec(rule);
    if (!w) throw new Error('no handle width for ' + trackShape + ': ' + rule);
    return Number(w[1]);
  };
  const HANDLE_W = { rounded: handleWFor('rounded'), capsule: handleWFor('capsule') };
  const CAP_RADIUS = capRadiusFor('capsule');
  const geometryFor = (trackShape) => {
    const WIDTH = 200;
    const run = sliderClassFor(trackShape);
    const isSliderRoot = (p) => typeof p.className === 'string' && /\bdms-slider\b/.test(p.className);
    // findAll yields parents before children, so index 0 is the fill itself and
    // the handle itself (not dms-fillSheen/dms-fillSpray/dms-thumbIcon).
    const slider = findAll(run.tree, isSliderRoot)[0];
    const fill = findAll(run.tree, (p) => typeof p.className === 'string' && p.className.indexOf('dms-fill') === 0)[0];
    const thumb = findAll(run.tree, (p) => typeof p.className === 'string' && p.className.indexOf('dms-thumb') === 0)[0];
    if (!slider || !fill || !thumb) throw new Error('slider parts not found');
    for (const pair of [[slider, 'slider'], [fill, 'fill'], [thumb, 'thumb']]) {
      if (typeof pair[0].props.ref !== 'function') throw new Error(pair[1] + ' ref missing');
    }
    // Order matters: syncMountVisual bails out while clientWidth is still 0.
    slider.props.ref({ clientWidth: WIDTH, getBoundingClientRect: () => ({ left: 0, width: WIDTH }) });
    const fillNode = { style: {} };
    fill.props.ref(fillNode);
    const thumbNode = { style: {} };
    thumb.props.ref(thumbNode);
    if (fillNode.style.width === undefined) throw new Error('fill width was never applied');
    const m = /translate\((-?[\d.]+)px/.exec(String(thumbNode.style.transform));
    if (!m) throw new Error('thumb transform was never applied: ' + thumbNode.style.transform);
    return {
      fillWidth: parseFloat(fillNode.style.width),
      // The handle's own centre, derived from its translate offset + half width.
      thumbCentreX: parseFloat(m[1]) + HANDLE_W[trackShape] / 2
    };
  };

  const cap = geometryFor('capsule');
  // The fill's end cap centre (fillWidth - capRadius) must land exactly on the
  // handle centre: that is what makes the two concentric.
  const capCentreX = cap.fillWidth - CAP_RADIUS;
  if (Math.abs(capCentreX - cap.thumbCentreX) > 0.001) {
    throw new Error('capsule fill cap is not concentric with the handle: capCentre=' + capCentreX + ' handleCentre=' + cap.thumbCentreX);
  }
  // ...and the handle must be strictly smaller than the cap, so the fill colour
  // shows as a ring around it.
  if (HANDLE_W.capsule / 2 >= CAP_RADIUS) throw new Error('capsule handle is not smaller than the fill cap');
  // The default shape keeps its original behaviour: fill stops at the centre.
  const round = geometryFor('rounded');
  if (Math.abs(round.fillWidth - round.thumbCentreX) > 0.001) {
    throw new Error('rounded fill must stop at the handle centre: fill=' + round.fillWidth + ' handleCentre=' + round.thumbCentreX);
  }
});

// 3b. Capsule-only chip flourish ("鏂滃悜涓嬭摑绱壂鍏? + pop) 鈥?it fires ONLY when the
// tier is switched to MAX while the panel is open, and must stay silent when the
// panel is merely re-opened without a tier change.
check('capsule chip flourishes only on a tier switch inside the panel', () => {
  const made0 = makeCtx({});
  injectedCss = '';
  loadModule().apply(made0.ctx);
  const css = injectedCss;
  const cssRule = (selector) => {
    const at = css.indexOf(selector);
    if (at === -1) throw new Error('css rule missing: ' + selector);
    return css.slice(at, css.indexOf('}', at));
  };

  const flashes = (tree) => findAll(tree, (p) => typeof p.className === 'string' && p.className.split(' ').indexOf('dms-pillFlash') !== -1);
  const pops = (tree) => findAll(tree, (p) => typeof p.className === 'string' && p.className.split(' ').indexOf('dms-pillMax') !== -1);

  /**
   * A live control whose tier can be CHANGED between renders, driven through the
   * real open/close handlers. `settle()` renders, runs the effects and renders
   * again, which is what lets a state/ref-driven effect (the arm step) be observed.
   */
  const session = (trackShape) => {
    const box = { value: 'high' };
    const made = makeCtx({ effortBox: box, settingsValue: { advancedEffort: true, effortStyle: 'spray-flow', trackShape } });
    loadModule().apply(made.ctx);
    const seat = seatOf(made.registrations);
    const injected = seat.options.inject('session-1');
    hookState.length = 0;
    const render = () => expand(seat.component({ ...injected }));
    // Several passes: the tier settles through a ref written by an effect, and the
    // arm step then reacts to THAT on a later render, so one pass is not enough to
    // reach the steady state.
    const settle = () => {
      for (let i = 0; i < 4; i += 1) { runEffects(); resetHooks(); tree = render(); }
      return tree;
    };
    const triggerOf = (tree) => findAll(tree, (p) => p.className === 'dms-effortTrigger')[0];
    const panelOf = (tree) => findAll(tree, (p) => typeof p.className === 'string' && /(^|\s)dms-panel(\s|$)/.test(p.className))[0];
    let tree = render();
    return {
      box,
      tree: () => tree,
      /** Change the tier, as the slider would, then let the effects settle. */
      setTier(value) { box.value = value; tree = settle(); tree = settle(); return tree; },
      open() { triggerOf(tree).props.onClick(); tree = settle(); return tree; },
      /** Close the way the panel really does: request close, then the pop-out ends. */
      close() {
        triggerOf(tree).props.onClick();
        tree = render();
        const panel = panelOf(tree);
        if (!panel) throw new Error('panel vanished before its close animation finished');
        panel.props.onAnimationEnd({ animationName: 'dms-pop-out' });
        tree = settle();
        if (panelOf(tree)) throw new Error('the panel did not unmount after its pop-out ended');
        return tree;
      }
    };
  };

  // --- capsule: a real switch inside the panel DOES flourish -----------------
  const cap = session('capsule');
  cap.open();
  if (flashes(cap.tree()).length !== 0) throw new Error('the flourish fired on open, before any tier switch');
  if (pops(cap.tree()).length !== 0) throw new Error('the pop was applied on open, before any tier switch');
  const toMax = cap.setTier('max');
  const capsuleMax = flashes(toMax);
  if (capsuleMax.length !== 1) throw new Error('expected exactly 1 chip sweep after switching to MAX, got ' + capsuleMax.length);
  if (capsuleMax[0].props['aria-hidden'] !== 'true') throw new Error('the sweep must be aria-hidden decoration');
  if (typeof capsuleMax[0].props.key !== 'string' || capsuleMax[0].props.key.indexOf('dms-pill-flash') !== 0) {
    throw new Error('the sweep key does not carry the replay epoch: ' + String(capsuleMax[0].props.key));
  }
  if (pops(toMax).length !== 1) throw new Error('the chip was not put into its enlarged MAX state on the switch to MAX');

  // It must be INSIDE the chip, otherwise the chip's radius cannot clip it.
  const pill = findAll(toMax, (p) => typeof p.className === 'string' && p.className.split(' ').indexOf('dms-effortPill') !== -1)[0];
  if (!pill) throw new Error('chip not found at MAX');
  if (!pill.children.some((c) => c && c.props && String(c.props.className).indexOf('dms-pillFlash') !== -1)) {
    throw new Error('the sweep is not a child of the chip, so the chip radius cannot clip it');
  }

  // --- re-opening at MAX: the one-shot sweep is silent, the STEADY-STATE marks
  // are not. The enlarged size now belongs to the second group, because the chip
  // must STAY big for as long as the tier is MAX and only ease back down when the
  // tier changes 鈥?so a re-open must show it enlarged, not at its resting size.
  cap.close();
  const reopened = cap.open();
  if (flashes(reopened).length !== 0) {
    throw new Error('the sweep replayed when the panel was re-opened without a tier change');
  }
  if (pops(reopened).length !== 1) {
    throw new Error('the enlarged MAX size must persist across a re-open, not only on the switch that entered MAX');
  }
  if (pops(reopened).length !== 1) {
    throw new Error('the enlarged MAX size must persist across a re-open, not only on the switch that entered MAX');
  }
  // The enlarged size must clear when the tier leaves MAX: the class removal IS the
  // shrink trigger (see the CSS transition), so without it the chip could never ease
  // back down to its natural size.
  cap.setTier('high');
  if (pops(cap.tree()).length !== 0) {
    throw new Error('the chip is still in its enlarged MAX state after leaving MAX, so it could never shrink back');
  }
  // ...and a genuine switch AFTER that re-open must still flourish, so the
  // disarming did not simply break the feature.
  if (flashes(cap.tree()).length !== 0) throw new Error('the flourish fired while leaving MAX');
  const again = cap.setTier('max');
  if (flashes(again).length !== 1) throw new Error('a later switch back to MAX did not flourish');
  if (pops(again).length !== 1) throw new Error('a later switch back to MAX did not pop');

  // --- a tier change that happens OUTSIDE the panel must not arm it ----------
  // (switching model can bring its own default effort with it)
  const outside = session('capsule');
  outside.setTier('max');           // switched while CLOSED
  outside.open();
  if (flashes(outside.tree()).length !== 0) {
    throw new Error('a tier change made while the panel was closed armed the flourish');
  }

  // --- isolation: the rounded shape never renders it, at any tier ------------
  const rounded = session('rounded');
  rounded.open();
  rounded.setTier('max');
  if (flashes(rounded.tree()).length !== 0) throw new Error('the rounded shape must not render the capsule chip sweep');
  if (pops(rounded.tree()).length !== 0) throw new Error('the rounded shape must not apply the capsule chip pop');

  // --- the two conditions this harness cannot distinguish behaviourally ------
  // Its React stub runs EVERY effect on every pass and ignores the deps array, so
  // the disarm-on-close effect masks both of these here. In real React the disarm
  // effect only re-runs when `effortOpen` CHANGES, which is exactly when these two
  // become load-bearing, so they are pinned at the source level instead:
  //   * the arm step must require the panel to be OPEN, or a tier change arriving
  //     from outside (switching model brings its own default effort) would arm it
  //     and the next open would play the flourish unrequested;
  //   * the baseline must start as `null`, so the very first observation records
  //     where the tier started rather than counting as a switch.
  if (source.indexOf('if (effortOpen && nowMax && !wasMaxPillRef.current) {') === -1) {
    throw new Error('the flourish is no longer gated on the panel being OPEN, so a tier change from outside could arm it');
  }
  if (source.indexOf('const wasMaxPillRef = React.useRef(null);') === -1) {
    throw new Error('the max baseline must start as null so the first observation is not read as a switch');
  }

  // Stylesheet contract: 0.8s, skewed, clipped by the chip, painted in the
  // blue->purple ramp, and idle-transparent so it never lingers after the sweep.
  const sweepRule = cssRule('.dms-pillFlash{');
  const dur = /animation:dms-pill-sweep ([\d.]+)s/.exec(sweepRule);
  if (!dur || Number(dur[1]) !== 0.8) throw new Error('the sweep is not 0.8s: ' + sweepRule);
  if (!/forwards/.test(sweepRule)) throw new Error('the sweep does not hold its final frame, so it would snap back: ' + sweepRule);
  if (!/opacity:0/.test(sweepRule)) throw new Error('the sweep does not start/rest transparent: ' + sweepRule);
  // The SLANT SIGN is load-bearing: CSS grows +y downward, so a POSITIVE skew
  // pushes the bottom rightward and leans the band like "\" (top edge leading =
  // downward sweep). The negative form leans "/" and sweeps UPWARD instead, which
  // is the opposite of the requested 鏂滃悜涓?鈥?so pin the sign, not just "a skew".
  if (!/skewX\(\+?24deg\)/.test(sweepRule)) throw new Error('the sweep is not slanted +24deg (downward): ' + sweepRule);
  if (/skewX\(-/.test(sweepRule)) throw new Error('the sweep slants the wrong way (upward): ' + sweepRule);
  // The keyframe block contains nested braces (one per stop), so bound it by the
  // next top-level rule rather than by the first `}`.
  const kfAt = css.indexOf('@keyframes dms-pill-sweep{');
  if (kfAt === -1) throw new Error('the sweep keyframes are missing');
  let depth = 0, kfEnd = kfAt;
  for (let i = css.indexOf('{', kfAt); i < css.length; i += 1) {
    if (css[i] === '{') depth += 1;
    else if (css[i] === '}') { depth -= 1; if (depth === 0) { kfEnd = i + 1; break; } }
  }
  const sweepKf = css.slice(kfAt, kfEnd);
  if (sweepKf.indexOf('}') === -1) throw new Error('the sweep keyframes are malformed');
  // Every keyframe must carry the same slant, or the band would twist as it moves.
  const kfSkews = sweepKf.match(/skewX\([^)]*\)/g) || [];
  if (kfSkews.length !== 2 || kfSkews[0] !== kfSkews[1]) {
    throw new Error('the sweep changes its slant mid-flight: ' + kfSkews.join(' / '));
  }
  // Blue -> purple: a blue stop and a purple stop, both present.
  if (!/rgba\(59,130,246/.test(sweepRule)) throw new Error('the sweep has no blue stop: ' + sweepRule);
  if (!/rgba\(168,85,247/.test(sweepRule)) throw new Error('the sweep has no purple stop: ' + sweepRule);
  // The chip must clip it, and be a positioning context for it.
  const pillRuleNow = cssRule('.dms-effortPill{');
  if (!/position:relative/.test(pillRuleNow)) throw new Error('the chip is not a positioning context for the sweep: ' + pillRuleNow);
  if (!/overflow:hidden/.test(pillRuleNow)) throw new Error('the chip does not clip the sweep: ' + pillRuleNow);
  // The chip sits 5px lower than its layout position. `top` on a relatively
  // positioned box is a VISUAL offset 鈥?it must NOT be written as a margin, which
  // would move the caption and the slider as well and change the panel's height.
  const chipTop = /[;{]top:(\d+)px/.exec(pillRuleNow);
  if (!chipTop || Number(chipTop[1]) !== 5) {
    throw new Error('the chip is not nudged down 5px via `top`: ' + pillRuleNow);
  }
  if (/margin-(top|bottom)/.test(pillRuleNow)) {
    throw new Error('the chip nudge uses a margin, which would shift the caption/slider too: ' + pillRuleNow);
  }
  // Reduced motion must suppress it.
  const rm = css.slice(css.indexOf('@media (prefers-reduced-motion:reduce)'));
  if (rm.indexOf('.dms-pillFlash{animation:none') === -1) {
    throw new Error('the sweep ignores prefers-reduced-motion');
  }
  if (rm.indexOf('.dms-effortPill{transition:none}') === -1) {
    throw new Error('the chip keeps animating its size under prefers-reduced-motion');
  }

  // --- the chip's MAX size: a TRANSITION between two steady states ------------
  // "Stay enlarged at MAX, ease back down when the tier changes" cannot be a
  // one-shot animation (an animation only runs forward, then holds or reverts), so
  // this must be a transition between a resting scale and an enlarged one. The
  // design is pinned by its consequences, each of which was a real decision:
  const maxRule = cssRule('.dms-effortPill.dms-pillMax{');
  const maxScale = /transform:scale\(([\d.]+)\)/.exec(maxRule);
  if (!maxScale) throw new Error('the enlarged MAX state has no scale: ' + maxRule);
  const peak = Number(maxScale[1]);
  if (!(peak > 1)) throw new Error('the MAX state does not enlarge the chip: ' + maxRule);
  if (peak > 1.25) throw new Error('the MAX scale ' + peak + ' is too large; the label would crowd the panel edges');
  // The grow must be DELAYED so it starts with the flash, and the delay has to be
  // the sweep's own delay 鈥?derived, not hard-coded, so retiming the flash cannot
  // silently desynchronise them.
  const sweepRuleT = cssRule('.dms-pillFlash{');
  const sweepDelay = Number(/animation-delay:([\d.]+)s/.exec(sweepRuleT)[1]);
  // NOTE: the easing sits between the two time values and contains commas, so the
  // pattern has to step over `cubic-bezier(...)` explicitly 鈥?a `[^,;]*` between
  // them can never match.
  const growDelay = /transform\s+[\d.]+s\s+cubic-bezier\([^)]*\)\s+([\d.]+)s/.exec(maxRule);
  if (!growDelay) throw new Error('the MAX grow has no delay, so it would start before the flash: ' + maxRule);
  if (Math.abs(Number(growDelay[1]) - sweepDelay) > 1e-9) {
    throw new Error('the chip grows at ' + growDelay[1] + 's but the flash starts at ' + sweepDelay + 's; they must start together');
  }
  // The delay is what makes it a TRANSITION rather than an animation, and it only
  // exists because it is the cue to grow: the shrink must fire IMMEDIATELY, and CSS
  // takes transition properties from the destination state, which is why the delay
  // lives on the MAX rule and not on the resting one. That asymmetry is the whole
  // mechanism of "grow after the flash, but shrink at once" 鈥?assert both halves.
  const restRule = cssRule('.dms-effortPill{');
  const restTransition = /transition:([^;}]*)/.exec(restRule)[1];
  if (/transform\s+[\d.]+s\s+cubic-bezier\([^)]*\)\s+[\d.]+s/.test(restTransition)) {
    throw new Error('the resting state delays the transform too, so leaving MAX would wait before shrinking: ' + restTransition);
  }
  // No keyframes and no animation: the shrink-back requirement is exactly what a
  // one-shot animation cannot express, so a leftover `dms-pill-pop` animation would
  // mean the old behaviour is still wired up somewhere.
  if (css.indexOf('@keyframes dms-pill-pop{') !== -1) {
    throw new Error('the old one-shot grow/shrink animation is still present; "shrink only when the tier changes" is a transition');
  }
  if (css.indexOf('.dms-pillPop') !== -1) {
    throw new Error('the old one-shot chip class is still present alongside the new steady-state one');
  }
  // The whole point of the state-based design: the chip must NOT be re-keyed, or it
  // would remount already at its new scale and the transition would never run.
  if (source.indexOf('key: "dms-pill-pop-"') !== -1) {
    throw new Error('the chip is re-keyed again, which makes it remount at the new scale so the grow/shrink snaps');
  }
  // ...and the class must follow the TIER (a steady state), not the one-shot arm
  // flag 鈥?otherwise the chip would snap back to its resting size on a re-open.
  const chipLine = source.slice(source.indexOf("className: \"dms-effortPill\""));
  if (chipLine.indexOf('(effMode === "max" ? " dms-pillMax" : "")') === -1) {
    throw new Error('the enlarged MAX state is not gated on the tier: ' + chipLine.slice(0, 130));
  }
  if (chipLine.indexOf('pillAnimArmed ? " dms-pillMax"') !== -1) {
    throw new Error('the enlarged MAX state is tied to the one-shot arm flag, so it would shrink on a re-open');
  }
});

// 4c. The chip pop must not be able to move the layout: it is a scale on a
// relatively positioned chip, so the caption above and slider below keep their
// boxes. Verified by rendering (caption top 16.0, slider top 72.0 and panel
// height 120.0 were constant at every sampled frame).
check('chip pop is layout-invisible (scale only)', () => {
  const cssNow = (() => {
    injectedCss = '';
    loadModule().apply(makeCtx({}).ctx);
    return injectedCss;
  })();
  const chip = /\.dms-effortPill\{([^}]*)\}/.exec(cssNow);
  if (!chip) throw new Error('the chip rule is missing');
  if (!/position:relative/.test(chip[1])) throw new Error('the chip is not relatively positioned: ' + chip[1]);
  // The 5px nudge and the scale must both survive on the chip.
  if (!/[;{]top:5px/.test(chip[1])) throw new Error('the chip lost its 5px nudge: ' + chip[1]);
  if (!/overflow:hidden/.test(chip[1])) throw new Error('the chip lost its clip, so the sweep could escape: ' + chip[1]);
  // The chip DOES declare a resting transform now, and it must be exactly scale(1):
  // it is the state the enlarged MAX size eases back to, so any other resting scale
  // would leave the chip permanently resized.
  const rest = /[;{]transform:scale\(([\d.]+)\)/.exec(chip[1]);
  if (!rest) throw new Error('the chip has no resting transform to shrink back to: ' + chip[1]);
  if (Number(rest[1]) !== 1) {
    throw new Error('the chip\'s resting scale is ' + rest[1] + ', not 1, so it would never return to its natural size');
  }
  // Both properties must actually be transitioned, or one of the two size changes
  // (following the label, growing/shrinking with the tier) would snap.
  const chipTransition = /transition:([^;}]*)/.exec(chip[1]);
  if (!chipTransition) throw new Error('the chip has no transition at all: ' + chip[1]);
  if (!/width /.test(chipTransition[1])) throw new Error('the chip does not transition width: ' + chipTransition[1]);
  if (!/transform /.test(chipTransition[1])) throw new Error('the chip does not transition transform, so the MAX grow/shrink would snap: ' + chipTransition[1]);
  // Only those two: anything layout-affecting here would move the caption/slider and
  // race the slider's cached geometry measurements. Split on TOP-LEVEL commas only 鈥?  // `cubic-bezier(.4,0,.2,1)` carries its own, so a plain split shreds it.
  const topLevel = (value) => {
    const out = [];
    let depth = 0, start = 0;
    for (let i = 0; i < value.length; i += 1) {
      const ch = value[i];
      if (ch === '(') depth += 1;
      else if (ch === ')') depth -= 1;
      else if (ch === ',' && depth === 0) { out.push(value.slice(start, i)); start = i + 1; }
    }
    out.push(value.slice(start));
    return out.map((s) => s.trim().split(/\s+/)[0]).filter(Boolean).sort();
  };
  const transitioned = topLevel(chipTransition[1]);
  if (transitioned.join('|') !== 'transform|width') {
    throw new Error('the chip transitions something other than width and transform: ' + transitioned.join('|'));
  }
});

// 4d-bis. The trigger's tier value needs the SAME smoothing as the chip, for a
// reason the chip does not have: it is a flex item in the composer row, so its
// width is what pushes the model selector and the "推理" caption sideways.
// Changing tier used to shove both of them instantly. The fix is a width
// TRANSITION on this element — there is no other lever, because the neighbours'
// positions are derived from this box's size.
//
// Two things can silently break it, and each gets its own assertion:
//   1. A transition on a box with `width:auto` never runs, so the width must be
//      pinned to a measured px value, replayed as clear/measure/restore/reflow/write.
//   2. The measurement must not fire on every render — the control re-renders per
//      drag frame, and a forced reflow there is a real cost.
check('the trigger tier value animates its width so the neighbours glide', () => {
  const box = { value: 'high' };
  const made = makeCtx({ effortBox: box, settingsValue: { advancedEffort: true, effortStyle: 'spray-flow', trackShape: 'capsule' } });
  loadModule().apply(made.ctx);
  const seat = seatOf(made.registrations);
  const injected = seat.options.inject('session-1');
  hookState.length = 0;
  let tree = expand(seat.component({ ...injected }));

  const valueEl = findAll(tree, (p) => typeof p.className === 'string' && p.className.split(' ').indexOf('dms-effortValue') !== -1)[0];
  if (!valueEl) throw new Error('the trigger tier value is missing');
  if (!valueEl.props.ref || typeof valueEl.props.ref !== 'object') {
    throw new Error('the tier value has no ref, so the width effect has nothing to measure');
  }

  // A fake node that models the browser: an explicit width beats the content
  // width. Reading `offsetWidth` is what FORCES the style flush, so recording it
  // is the only way a fake node can prove the component really forced a reflow.
  const writes = [];
  const flushes = [];
  let widthValue = '';
  const style = {};
  Object.defineProperty(style, 'width', {
    get: () => widthValue,
    set: (v) => { widthValue = v; writes.push(v); }
  });
  const fake = { style, natural: 24, getBoundingClientRect: () => ({ width: (widthValue !== '' && widthValue !== 'auto') ? parseFloat(widthValue) : fake.natural }) };
  Object.defineProperty(fake, 'offsetWidth', { get: () => { flushes.push(writes.length); return 24; } });
  valueEl.props.ref.current = fake;

  // First pass: PRIME only. There is no previous width to animate from, and
  // forcing a reflow here would be pointless work on mount.
  runEffects();
  if (writes.join('|') !== 'auto|24px') {
    throw new Error('the first pass did not pin the tier value width, writes: ' + writes.join('|'));
  }
  if (flushes.length !== 0) throw new Error('the priming pass forced a reflow it did not need');

  // A tier of a DIFFERENT length arrives (the real trigger: "Max" -> "Low"). The
  // value must be a stop the fixture's model actually declares — an id the
  // directory does not know resolves to no stop, so the label would never change
  // and the whole assertion would pass vacuously.
  writes.length = 0;
  flushes.length = 0;
  fake.natural = 47;
  box.value = 'low';
  for (let i = 0; i < 4; i += 1) { runEffects(); resetHooks(); tree = expand(seat.component({ ...injected })); }
  const labelNow = findAll(tree, (p) => typeof p.className === 'string' && p.className.split(' ').indexOf('dms-rollVal') !== -1)[0];
  if (!labelNow || String(labelNow.children[0]) === 'Max') {
    throw new Error('the tier did not actually change, so this assertion would be vacuous');
  }
  if (writes.join('|') !== 'auto|24px|47px') {
    throw new Error('the tier width change was not replayed as a transition (expected auto|24px|47px), writes: ' + writes.join('|'));
  }
  if (flushes.length !== 1 || flushes[0] !== 2) {
    throw new Error('the reflow must be forced exactly once, between the restore and the new width (write index 2); got ' + JSON.stringify(flushes));
  }

  // And with NO tier change it must do nothing: this control re-renders on every
  // drag frame, so re-measuring there would be a real per-frame cost.
  writes.length = 0;
  flushes.length = 0;
  for (let i = 0; i < 3; i += 1) { runEffects(); resetHooks(); tree = expand(seat.component({ ...injected })); }
  if (writes.length !== 0 || flushes.length !== 0) {
    throw new Error('the tier width logic re-measured without a tier change: writes ' + writes.join('|') + ', flushes ' + JSON.stringify(flushes));
  }

  // The CSS half. `width` is the property that must transition, because the width
  // is the layout input the neighbours are derived from — transitioning opacity or
  // transform here would animate the wrong thing entirely.
  const cssNow = (() => { injectedCss = ''; loadModule().apply(makeCtx({}).ctx); return injectedCss; })();
  const rule = /\.dms-effortValue\{([^}]*)\}/.exec(cssNow)[1];
  if (!/transition:width /.test(rule)) {
    throw new Error('the tier value has no width transition, so the neighbours would still snap: ' + rule);
  }
  // `top` must stay a RELATIVE offset. A margin (or a top that sizes the box)
  // would change the flex item's height and shift the caption with it — the
  // alignment regression this same rule was already fixed for.
  //
  // `top` is 0 now: the value used to ride one pixel high (`top:-1px`) and read
  // as floating above the CJK caption's line, so exactly that lift was dropped.
  // The offset stays written out because this is the spot the optical nudge
  // lives in; what must NOT come back is a non-zero lift.
  //
  // `position:relative` is load-bearing well beyond the nudge: it is the
  // containing block for `.dms-rollVal.dms-rollOutUp` (position:absolute), so
  // dropping it would send the outgoing tier to some ancestor's box and the
  // roll would visibly detach. It is asserted separately for that reason.
  if (!/position:relative/.test(rule)) {
    throw new Error('the tier value lost its relative positioning, which is also the containing block for the rolling outgoing label: ' + rule);
  }
  if (!/(^|;)top:0(;|$)/.test(rule)) {
    throw new Error('the tier value is lifted off its line again (expected top:0): ' + rule);
  }
  // The cap must survive, or a very long tier name would widen the composer row
  // instead of ellipsising inside it.
  if (!/max-width:96px/.test(rule) || !/text-overflow:ellipsis/.test(rule)) {
    throw new Error('the tier value lost its truncation: ' + rule);
  }
  // Reduced motion must disable the resize animation too.
  const rm = cssNow.slice(cssNow.indexOf('@media (prefers-reduced-motion:reduce)'));
  if (rm.indexOf('.dms-effortValue{transition:none}') === -1) {
    throw new Error('reduced motion does not neutralise the tier width transition');
  }

  // ---- The ellipsis flash, which is a CONSEQUENCE of the width glide --------
  // Reported as: switching to a longer tier shows "H..." for a moment and only
  // then the full word. It is not a separate bug — the carrier is animating its
  // width from the OLD tier's length to the NEW one, so for the first part of a
  // switch to a longer tier the box is genuinely narrower than the incoming text
  // (measured on "Low" -> "High": 23.86px of box against 26.75px of text) and
  // `text-overflow:ellipsis` reports that honestly by drawing dots.
  //
  // The fix is to stop ADVERTISING the cut while the label is rolling, so the
  // word is revealed left-to-right as the box grows. Two details carry the fix
  // and both are asserted, because each fails silently and differently:
  //
  //   * It must be scoped to the ROLLING classes. Blanket `clip` on
  //     `.dms-rollVal` would also remove the ellipsis from a genuinely
  //     over-long tier name at rest — the one case the 96px cap exists for.
  //   * The width glide must END BEFORE the roll does. The suppression lives
  //     only as long as the rolling classes, and those come off at DMS_ROLL_MS;
  //     a glide of equal length would still be a fraction of a pixel short at
  //     that instant and would flash the dots one last time. The 40ms margin is
  //     what prevents that, so it is pinned rather than left to chance.
  const rollClip = /\.dms-rollVal\.dms-rollInUp,\.dms-rollVal\.dms-rollOutUp\{([^}]*)\}/.exec(cssNow);
  if (!rollClip) {
    throw new Error('the rolling values do not suppress the ellipsis, so a longer tier flashes "H..." mid-transition');
  }
  if (!/text-overflow:clip/.test(rollClip[1])) {
    throw new Error('the rolling values do not clip instead of ellipsising: ' + rollClip[1]);
  }
  // ...and the suppression must NOT reach the resting state.
  const restingRule = /\.dms-rollVal\{([^}]*)\}/.exec(cssNow)[1];
  if (!/text-overflow:ellipsis/.test(restingRule)) {
    throw new Error('the resting value lost its ellipsis, so a genuinely over-long tier name would be cut without any indication: ' + restingRule);
  }
  // The two durations must keep the ordering that makes the suppression hold for
  // the WHOLE glide. Read them out of the sheet rather than trusting the
  // constants, since it is the emitted CSS that the browser acts on. The width
  // transition belongs to the CARRIER (`.dms-effortValue`), not to
  // `.dms-rollVal` — reading it off the roll element would find nothing, and a
  // silent `NaN` comparison would make this whole ordering check pass by accident.
  const growMatch = /transition:width ([\d.]+)s/.exec(rule);
  const rollMatch = /animation:dms-roll-in-up ([\d.]+)s/.exec(cssNow);
  if (!growMatch) throw new Error('no width duration on the tier value carrier: ' + rule);
  if (!rollMatch) throw new Error('no roll duration in the sheet');
  const growS = parseFloat(growMatch[1]);
  const rollS = parseFloat(rollMatch[1]);
  if (!(growS > 0) || !(rollS > 0)) {
    throw new Error('could not read both durations (grow=' + growS + ', roll=' + rollS + ')');
  }
  if (!(growS < rollS)) {
    throw new Error('the width glide (' + growS + 's) is not shorter than the roll (' + rollS + 's), so the last frames would still show dots');
  }
});


// This is behaviourally testable because an object ref is exactly what React
// assigns: the test grabs the ref off the rendered chip, installs a fake node whose
// `getBoundingClientRect` models the browser (an explicit width wins over the
// content), and inspects the width writes the layout effect makes.
check('chip width transitions instead of snapping when the label changes', () => {
  const box = { value: 'max' };
  const made = makeCtx({ effortBox: box, settingsValue: { advancedEffort: true, effortStyle: 'spray-flow', trackShape: 'capsule' } });
  loadModule().apply(made.ctx);
  const seat = seatOf(made.registrations);
  const injected = seat.options.inject('session-1');
  hookState.length = 0;
  let tree = expand(seat.component({ ...injected }));
  findAll(tree, (p) => p.className === 'dms-effortTrigger')[0].props.onClick();
  for (let i = 0; i < 4; i += 1) { runEffects(); resetHooks(); tree = expand(seat.component({ ...injected })); }

  const chip = findAll(tree, (p) => typeof p.className === 'string' && p.className.split(' ').indexOf('dms-effortPill') !== -1)[0];
  if (!chip) throw new Error('chip not found');
  if (!chip.props.ref || typeof chip.props.ref !== 'object') throw new Error('the chip has no ref for the width logic to measure');

  // A style object that records every write, and a node whose measured width
  // follows the browser's rule: an explicit width beats the content width. Reading
  // `offsetWidth` is what FORCES the style flush, so that read is recorded too 鈥?  // it is the only way to observe, from a fake node, that the component really did
  // force a reflow between the restore and the new width.
  const writes = [];
  const flushes = [];
  let widthValue = '';
  const style = {};
  Object.defineProperty(style, 'width', {
    get: () => widthValue,
    set: (v) => { widthValue = v; writes.push(v); }
  });
  const fake = { style, natural: 44, getBoundingClientRect: () => ({ width: (widthValue !== '' && widthValue !== 'auto') ? parseFloat(widthValue) : fake.natural }) };
  Object.defineProperty(fake, 'offsetWidth', { get: () => { flushes.push(writes.length); return 44; } });
  chip.props.ref.current = fake;

  // First pass with no explicit width yet: it must PRIME the width (no animation,
  // because there is no previous value to come from).
  runEffects();
  if (writes.join('|') !== 'auto|44px') {
    throw new Error('the first pass did not prime the width, writes: ' + writes.join('|'));
  }
  if (flushes.length !== 0) throw new Error('the priming pass forced a reflow it did not need');

  // The label changes to a LONGER one: the effect must clear, measure, restore the
  // previous width, force a reflow and only then write the new width 鈥?that
  // restore-then-write pair is what gives the transition a start value.
  writes.length = 0;
  flushes.length = 0;
  fake.natural = 52;
  box.value = 'high';
  for (let i = 0; i < 4; i += 1) { runEffects(); resetHooks(); tree = expand(seat.component({ ...injected })); }
  const label = findAll(tree, (p) => typeof p.className === 'string' && p.className.indexOf('dms-pillValue') === 0)[0];
  if (!label) throw new Error('the chip label is missing');
  if (String(label.children[0]) === 'Max') throw new Error('the tier did not change, so this assertion would be vacuous');
  if (writes.join('|') !== 'auto|44px|52px') {
    throw new Error('the width change was not replayed as a transition (expected auto|44px|52px), writes: ' + writes.join('|'));
  }
  // The reflow must land AFTER the restore and BEFORE the new width. Without it both
  // writes are collapsed into one style recalculation and the box jumps instead of
  // animating 鈥?which is exactly the defect this pins.
  if (flushes.length === 0) {
    throw new Error('the width change was written without forcing a reflow, so the transition has no start value');
  }
  if (flushes.some((at) => at !== 2)) {
    throw new Error('the reflow was forced at the wrong point (write index ' + flushes.join(',') + '); it must sit between the restore and the new width');
  }

  // And with NO label change it must do nothing at all: the control re-renders on
  // every drag frame, so a forced reflow there would be a real cost.
  writes.length = 0;
  flushes.length = 0;
  for (let i = 0; i < 3; i += 1) { runEffects(); resetHooks(); tree = expand(seat.component({ ...injected })); }
  if (writes.length !== 0) {
    throw new Error('the width logic re-measured without a label change: ' + writes.join('|'));
  }
  if (flushes.length !== 0) {
    throw new Error('the width logic forced a reflow without a label change');
  }

  // The transition itself, and the centring that keeps the label mid-chip while
  // the box stretches.
  const cssNow = (() => { injectedCss = ''; loadModule().apply(makeCtx({}).ctx); return injectedCss; })();
  const chipRule = /\.dms-effortPill\{([^}]*)\}/.exec(cssNow)[1];
  if (!/transition:width /.test(chipRule)) throw new Error('the chip has no width transition: ' + chipRule);
  if (!/justify-content:center/.test(chipRule)) {
    throw new Error('the chip content is not centred, so the label would stick to one edge while the box stretches: ' + chipRule);
  }
  // The transform transition is REQUIRED now (it is what eases the MAX grow and the
  // shrink on leaving MAX), so this asserts the opposite of what it used to: the two
  // transitions must coexist, because they drive independent size changes 鈥?the
  // width follows the label, the scale follows the tier. A single `transition`
  // declaration cannot serve both.
  if (!/transition:[^;]*transform/.test(chipRule)) {
    throw new Error('the chip does not transition transform, so the MAX grow/shrink would snap: ' + chipRule);
  }
  // The chip's length is padding + label, and the padding is a free knob (it was
  // tuned down once already), so its exact value is deliberately NOT pinned. What
  // IS pinned is that there is horizontal padding at all: at zero the label would
  // run into the capsule's curved end and read as clipped.
  const pad = /padding:(\d+)px (\d+)px/.exec(chipRule);
  if (!pad) throw new Error('the chip padding is not the expected 2-value form: ' + chipRule);
  if (Number(pad[2]) <= 0) throw new Error('the chip has no horizontal padding, so the label would touch the rounded end: ' + chipRule);
});

// 4e. Two decorations were REMOVED by request: the chip's inner halo and the panel's
// top glow. This asserts each removal is complete in BOTH halves — leaving CSS with no
// element (or the reverse) would be dead weight, and a panel still rendering a glow
// child would mean the markup was only half cleaned. Kept as an assertion rather than
// trusted to a one-off edit, because both removals touched several places.
check('the removed decorations are gone (no element, no CSS)', () => {
  const cssNow = (() => { injectedCss = ''; loadModule().apply(makeCtx({}).ctx); return injectedCss; })();
  if (cssNow.indexOf('dms-pillHalo') !== -1) throw new Error('orphan halo CSS is still being injected');
  if (cssNow.indexOf('dms-pill-halo') !== -1) throw new Error('orphan halo keyframes are still being injected');
  if (source.indexOf('dms-pillHalo') !== -1) throw new Error('the halos markup or stylesheet entry is still present');
  // The panel glow, including the tint-lift that only existed to serve it: a leftover
  // `dms-panelGlow` would leave the panel painting a lifted background with no glow.
  if (cssNow.indexOf('dms-panelMist') !== -1 || cssNow.indexOf('dms-mist-breathe') !== -1) {
    throw new Error('orphan panel-glow CSS or keyframes are still being injected');
  }
  if (source.indexOf('dms-panelMist') !== -1 || source.indexOf('dms-panelGlow') !== -1) {
    throw new Error('the panel glow is still referenced in the source');
  }
  // The chip must carry the sweep overlay and the label, and nothing else.
  const made = makeCtx({ effort: 'max', settingsValue: { advancedEffort: true, effortStyle: 'spray-flow', trackShape: 'capsule' } });
  loadModule().apply(made.ctx);
  const seat = seatOf(made.registrations);
  const injected = seat.options.inject('session-1');
  hookState.length = 0;
  let tree = expand(seat.component({ ...injected }));
  findAll(tree, (p) => p.className === 'dms-effortTrigger')[0].props.onClick();
  for (let i = 0; i < 4; i += 1) { runEffects(); resetHooks(); tree = expand(seat.component({ ...injected })); }
  const chip = findAll(tree, (p) => typeof p.className === 'string' && p.className.split(' ').indexOf('dms-effortPill') !== -1)[0];
  if (!chip) throw new Error('chip not found');
  const kinds = (chip.children || []).filter(Boolean).map((c) => String((c.props || {}).className));
  if (kinds.length !== 2) {
    throw new Error('the chip should hold exactly the sweep overlay and the label, got ' + kinds.length + ': ' + kinds.join(' / '));
  }
  if (kinds.filter((k) => k.indexOf('dms-pillValue') === 0).length !== 1) {
    throw new Error('the chip label is missing or duplicated: ' + kinds.join(' / '));
  }
  // ...and the PANEL must be back to header + bar (plus the optional error row),
  // with no glow child sitting in front of the header. This panel is opened at
  // MAX, so it also confirms the removed fluid backdrop mounts nothing there.
  const panel = findAll(tree, (p) => typeof p.className === 'string' && /(^|\s)dms-panel(\s|$)/.test(p.className))[0];
  if (!panel) throw new Error('panel not found');
  const panelKinds = (panel.children || []).filter(Boolean).map((c) => String((c.props || {}).className));
  if (panelKinds.length !== 2) {
    throw new Error('the panel should hold exactly the header and the bar, got ' + panelKinds.length + ': ' + panelKinds.join(' / '));
  }
  if (panelKinds[0].indexOf('dms-panelHeader') !== 0) {
    throw new Error('the panel no longer starts with its header: ' + panelKinds.join(' / '));
  }
  if (String(panel.props.className).indexOf('dms-panelGlow') !== -1) {
    throw new Error('the panel still carries the glow class, which lifts its background');
  }
});

// 4f. The capsule caption names the CURRENT MODEL with its brand mark in front. Two
// things have to hold around that: the row must not be able to widen the panel when a
// model name is long, and it must still say something when no model has resolved yet
// (the icon is only drawn next to a real name — a brand mark in front of the word
// "Effort" would claim a model that is not there).
check('the caption names the model and degrades safely', () => {
  const captionFor = (o) => {
    const made = makeCtx(Object.assign({
      effort: 'high',
      settingsValue: { advancedEffort: true, effortStyle: 'spray-flow', trackShape: 'capsule' }
    }, o));
    loadModule().apply(made.ctx);
    const seat = seatOf(made.registrations);
    const injected = seat.options.inject('session-1');
    hookState.length = 0;
    let tree = expand(seat.component({ ...injected }));
    findAll(tree, (p) => p.className === 'dms-effortTrigger')[0].props.onClick();
    for (let i = 0; i < 4; i += 1) { runEffects(); resetHooks(); tree = expand(seat.component({ ...injected })); }
    return findAll(tree, (p) => typeof p.className === 'string' && p.className === 'dms-pillCaption')[0];
  };
  // No model name resolvable: text-only, falling back to the localised caption.
  const bare = captionFor({ modelName: null });
  if (!bare) throw new Error('the caption disappeared when the model was unknown');
  const bareKids = (bare.children || []).filter(Boolean);
  if (bareKids.length !== 1) {
    throw new Error('a caption with no model name must render text only, got ' + bareKids.length + ' children');
  }
  if (String(bareKids[0].children && bareKids[0].children[0]) !== 'pill.title') {
    throw new Error('the caption did not fall back to the pill.title string, got ' + JSON.stringify(bareKids[0].children && bareKids[0].children[0]));
  }
  // A long name must ellipsise rather than widen the panel: the outer row bounds the
  // width and the inner span owns the ellipsis, so the ICON is never clipped.
  const cssNow = (() => { injectedCss = ''; loadModule().apply(makeCtx({}).ctx); return injectedCss; })();
  const rule = (sel) => {
    const at = cssNow.indexOf(sel);
    if (at === -1) throw new Error('css rule missing: ' + sel);
    return cssNow.slice(at, cssNow.indexOf('}', at));
  };
  const cap = rule('.dms-pillCaption{');
  if (!/display:inline-flex/.test(cap)) throw new Error('the caption is not a flex row, so icon and name cannot share a baseline: ' + cap);
  if (!/max-width:/.test(cap)) throw new Error('the caption is unbounded, so a long model name could widen the panel: ' + cap);
  // The row is nudged left by a RELATIVE offset, which must not change any box size —
  // a margin would widen the box and start eating the name's ellipsis budget.
  const shift = /position:relative;left:(-?\d+)px/.exec(cap);
  if (!shift) throw new Error('the caption is not nudged with a relative offset: ' + cap);
  const shiftPx = Math.abs(Number(shift[1]));
  if (shiftPx !== 5) throw new Error('the caption offset is ' + shiftPx + 'px, expected the 5px left nudge: ' + cap);
  // ...and `max-width` must reserve exactly that much, or a full-width name would be
  // painted over the panel's left border. The two numbers are derived from each other.
  const reserve = /max-width:calc\(100% - (\d+)px\)/.exec(cap);
  if (!reserve) throw new Error('the caption max-width does not reserve room for its own offset: ' + cap);
  if (Number(reserve[1]) !== shiftPx) {
    throw new Error('the caption reserves ' + reserve[1] + 'px but shifts ' + shiftPx + 'px; the reserve must match the offset or the row can overhang the border');
  }
  // Icon-to-name spacing is 4px wider here than in the model dropdown, and it is added
  // as a caption-local gap: the mark's own margin-right is SHARED with the dropdown, so
  // widening that instead would silently move the dropdown's icon too.
  const captionGap = /(?:^|;)gap:(\d+)px/.exec(cap);
  if (!captionGap) throw new Error('the caption adds no gap, so its icon sits no further from the name than the dropdown\'s: ' + cap);
  if (Number(captionGap[1]) !== 4) throw new Error('the caption gap is ' + captionGap[1] + 'px, expected the 4px widening: ' + cap);
  const sharedMark = /style: \{ flex: "none", display: "block", marginRight: (\d+), marginLeft: (\d+)/.exec(source);
  if (!sharedMark) throw new Error('could not read the shared brand-mark margins');
  if (Number(sharedMark[1]) !== 2 || Number(sharedMark[2]) !== 1) {
    throw new Error('the brand mark\'s shared margins changed to ' + sharedMark[1] + '/' + sharedMark[2] + '; that also moves the model dropdown, which must keep its original 2/1');
  }
  const txt = rule('.dms-pillCaptionText{');
  if (!/overflow:hidden/.test(txt) || !/text-overflow:ellipsis/.test(txt) || !/white-space:nowrap/.test(txt)) {
    throw new Error('the caption name cannot ellipsise, so a long model name would overflow the panel: ' + txt);
  }
});

// 4f-bis. The model DROPDOWN's own rows carry the same brand marks as the composer
// trigger and the capsule caption. Two things must hold at once: a row whose brand
// resolves leads with its SVG, and a row whose brand does NOT resolve still reserves
// the same slot, so every model name in the list keeps one left edge. That slot is
// deliberately left EMPTY — substituting the fallback sparkle would print a real logo
// on a model that has no such identity, which is worse than a blank gutter.
check('the model dropdown rows lead with the same brand marks as the trigger', () => {
  const menuRowsFor = (groups) => {
    const made = makeCtx({
      effort: 'high',
      groups,
      settingsValue: { advancedEffort: true, effortStyle: 'spray-flow', trackShape: 'capsule' }
    });
    loadModule().apply(made.ctx);
    const seat = seatOf(made.registrations);
    const injected = seat.options.inject('session-1');
    hookState.length = 0;
    let tree = expand(seat.component({ ...injected }));
    const trigger = findAll(tree, (p) => p.className === 'dms-trigger')[0];
    if (!trigger) throw new Error('model trigger not found');
    trigger.props.onClick();
    for (let i = 0; i < 4; i += 1) { runEffects(); resetHooks(); tree = expand(seat.component({ ...injected })); }
    return {
      tree,
      rows: findAll(tree, (p) => typeof p.className === 'string' && p.className.split(' ').indexOf('dms-option') !== -1)
    };
  };

  const run = menuRowsFor([
    { id: 'deepseek-official', name: 'DeepSeek', models: [{ id: 'deepseek-v4-flash', name: 'DeepSeek V4 Flash' }] },
    { id: 'acme-internal', name: 'Acme', models: [{ id: 'zeta-1', name: 'Zeta One' }] }
  ]);
  if (run.rows.length !== 2) throw new Error('expected 2 model rows, got ' + run.rows.length);

  // Every row — branded or not — is icon slot + copy column + check + the `>`
  // affordance, in that order. The affordance is on EVERY row, including a name
  // carried by a single provider, so the shape does not depend on how many
  // providers a name happens to have.
  for (const row of run.rows) {
    const kids = (row.children || []).filter(Boolean);
    if (kids.length !== 4) throw new Error('a model row must be slot + copy + check + arrow, got ' + kids.length + ' children');
    if (String(kids[0].props.className) !== 'dms-optionIcon') {
      throw new Error('the row does not LEAD with the brand slot, got ' + String(kids[0].props.className));
    }
    if (String(kids[kids.length - 1].props.className).split(' ').indexOf('dms-arrow') === -1) {
      throw new Error('the row does not END with the `>` affordance, got ' + String(kids[kids.length - 1].props.className));
    }
  }

  // Row 1: a resolvable brand, and it is the same mark the trigger shows.
  const knownSlot = run.rows[0].children.filter(Boolean)[0];
  const knownIcon = (knownSlot.children || []).filter(Boolean)[0];
  if (!knownIcon || String(knownIcon.type) !== 'svg') throw new Error('the DeepSeek row rendered no brand svg');
  if (String(knownIcon.props.title || '').indexOf('DeepSeek') === -1) {
    throw new Error('the row icon is not the row\'s own brand, got ' + String(knownIcon.props.title));
  }
  if (knownIcon.props['aria-hidden'] !== true) throw new Error('the row icon is not aria-hidden decoration');
  if (!knownIcon.props.dangerouslySetInnerHTML || String(knownIcon.props.dangerouslySetInnerHTML.__html).indexOf('<path') === -1) {
    throw new Error('the row icon carries no path data');
  }

  // Row 2: no brand resolvable from provider OR model id. Same slot, nothing in it.
  const unknownSlot = run.rows[1].children.filter(Boolean)[0];
  const unknownKids = (unknownSlot.children || []).filter(Boolean);
  if (unknownKids.length !== 0) {
    throw new Error('a row with no resolvable brand rendered a mark anyway: ' + String(unknownKids[0] && unknownKids[0].type));
  }
  // The slot must be the SAME element with the SAME class, which is the whole
  // mechanism that keeps the two names on one left edge.
  if (String(unknownSlot.props.className) !== String(knownSlot.props.className)) {
    throw new Error('the unbranded row slot differs from the branded one, so the names would not align');
  }

  const cssNow = (() => { injectedCss = ''; loadModule().apply(makeCtx({}).ctx); return injectedCss; })();
  const rule = (sel) => {
    const at = cssNow.indexOf(sel);
    if (at === -1) throw new Error('css rule missing: ' + sel);
    return cssNow.slice(at, cssNow.indexOf('}', at));
  };
  // The slot width must be the icon box PLUS the mark's own shared inline margins,
  // read from the source rather than retyped — otherwise the empty and branded rows
  // would start their names at different x positions.
  const sharedMark = /style: \{ flex: "none", display: "block", marginRight: (\d+), marginLeft: (\d+)/.exec(source);
  if (!sharedMark) throw new Error('could not read the shared brand-mark margins');
  const slotRule = rule('.dms-optionIcon{');
  const slotW = /(?:^|;)width:(\d+)px/.exec(slotRule);
  if (!slotW) throw new Error('the brand slot has no width: ' + slotRule);
  const expectedSlot = Number(knownIcon.props.width) + Number(sharedMark[1]) + Number(sharedMark[2]);
  if (Number(slotW[1]) !== expectedSlot) {
    throw new Error('the slot is ' + slotW[1] + 'px but the icon plus its shared margins is ' + expectedSlot + 'px, so branded and unbranded rows would not line up');
  }
  // `space-between` was correct with two children and is wrong with three: it would
  // park the copy column in the middle of the row, away from its icon.
  const option = rule('.dms-option{');
  if (/justify-content:space-between/.test(option)) {
    throw new Error('the row still uses space-between, which centres the copy column once the slot is a third child: ' + option);
  }
  const copy = rule('.dms-optionCopy{');
  if (!/flex:1 1 auto/.test(copy)) {
    throw new Error('the copy column does not absorb the slack, so the check mark would not stay flush right: ' + copy);
  }
  // The three call sites size their marks independently on purpose; the row must not
  // have reused the trigger's 14px.
  if (Number(knownIcon.props.width) === 14) {
    throw new Error('the row reused the trigger\'s 14px instead of carrying its own size');
  }
});

// 4f-bis-bis. Every StepFun generation carries the StepFun mark. The line used
// to be pinned to the literal `step-3`, which branded `step-3.7-flash` while
// this deployment's `step-5-preview` fell through to the empty slot — two rows
// side by side, one marked and one not, with nothing in the name to explain the
// difference. The match is now on the `step-` SEGMENT, which is what the two
// negative rows pin down: `megastep-3` and `timestep-x9` both CONTAIN "step-"
// but belong to other vendors, so they must stay unbranded.
check('every StepFun generation carries the StepFun mark', () => {
  const made = makeCtx({
    effort: 'high',
    groups: [
      { id: 'cli', name: 'CLIProxyAPI', models: [
        { id: 'step-5-preview', name: 'Step 5 Preview' },
        { id: 'step-3.7-flash', name: 'Step 3.7 Flash' } ] },
      { id: 'x-opencode-session', name: 'Opencode go', models: [
        { id: 'megastep-3', name: 'MegaStep 3' },
        { id: 'timestep-x9', name: 'Timestep X9' } ] },
      { id: 'stepfun', name: 'StepFun', models: [
        { id: 'step3', name: 'Step 3 (vendor route)' } ] }
    ],
    settingsValue: { advancedEffort: true, effortStyle: 'spray-flow', trackShape: 'capsule' }
  });
  loadModule().apply(made.ctx);
  const seat = seatOf(made.registrations);
  const injected = seat.options.inject('session-1');
  hookState.length = 0;
  let tree = expand(seat.component({ ...injected }));
  const trigger = findAll(tree, (p) => p.className === 'dms-trigger')[0];
  if (!trigger) throw new Error('model trigger not found');
  trigger.props.onClick();
  for (let i = 0; i < 4; i += 1) { runEffects(); resetHooks(); tree = expand(seat.component({ ...injected })); }

  const rows = findAll(tree, (p) => typeof p.className === 'string' && p.className.split(' ').indexOf('dms-option') !== -1);
  const markOf = (name) => {
    const row = rows.filter((r) => r.props.title === name)[0];
    if (!row) throw new Error('no row titled ' + JSON.stringify(name));
    const slot = (row.children || []).filter(Boolean)[0];
    if (!slot || String(slot.props.className) !== 'dms-optionIcon') {
      throw new Error(name + ' lost its brand slot, so the names would not align');
    }
    const icon = (slot.children || []).filter(Boolean)[0];
    return icon === undefined || icon === null ? null : String(icon.props.title || '');
  };
  // The three ways a Step model can be spelled: this deployment's own ids,
  // another generation, and the vendor token on its own — the catalogues spell
  // the route `stepfun/step-3.5-flash`, and a bare `step3` is reachable ONLY
  // through that token, never through the segment match.
  for (const name of ['Step 5 Preview', 'Step 3.7 Flash', 'Step 3 (vendor route)']) {
    const title = markOf(name);
    if (title === null) throw new Error(name + ' rendered no brand mark');
    if (title.indexOf('StepFun') === -1) {
      throw new Error(name + ' shows ' + title + ' instead of the StepFun mark');
    }
  }
  // A vendor whose model merely contains the substring keeps its own identity
  // (here, none at all).
  for (const name of ['MegaStep 3', 'Timestep X9']) {
    const title = markOf(name);
    if (title !== null) throw new Error(name + ' merely CONTAINS "step-" yet carries ' + title);
  }
  // The vendor token and the segment match must stay in ONE entry: split them
  // across two and one half can be dropped without any row noticing.
  const entry = source.split('\n').filter(function (l) {
    return l.indexOf(', "stepfun"]') !== -1;
  })[0];
  if (!entry) throw new Error('the StepFun model-pattern entry is gone');
  const pattern = /\[\s*\/([\s\S]*)\/\s*,\s*"stepfun"\s*\]/.exec(entry);
  if (!pattern) throw new Error('cannot read the StepFun pattern out of: ' + entry.trim());
  if (String(pattern[1]).indexOf('stepfun') === -1) {
    throw new Error('the StepFun entry lost its vendor token: ' + entry.trim());
  }
  if (String(pattern[1]).indexOf('(^|[') === -1) {
    throw new Error('the `step-` match lost its segment boundary: ' + entry.trim());
  }
  // The DRAWING must stay lobehub's `Stepfun` — the default export of
  // `@lobehub/icons`, i.e. what `import { Stepfun } from '@lobehub/icons'`
  // renders, which the vendor page labels simply "StepFun". Pinned by its exact
  // path data, copied from `es/Stepfun/components/Mono.js` (verified equal to
  // `icons/stepfun.svg` in `@lobehub/icons-static-svg`): one filled disc with
  // five square HOLES, 244 characters, no gradient and no colour of its own.
  // The repo also ships a `stepfun-color.svg` — a completely different
  // staircase wordmark carrying a blue gradient — and NOTHING in the package
  // reaches it from the default export (there is no `Stepfun.Color`), so it is
  // not the icon this row is supposed to show.
  // The entry lives inside a JS string literal, so its quotes are backslash
  // escaped in the source text; read it the way the source spells it.
  const icon = /"stepfun":\{"vb":"([^"]*)","mono":(true|false),"body":"((?:[^"\\]|\\.)*)"\}/.exec(source);
  if (!icon) throw new Error('the stepfun icon entry changed shape');
  if (icon[1] !== '0 0 24 24') throw new Error('the stepfun icon viewBox is ' + icon[1]);
  if (icon[2] !== 'true') {
    throw new Error('the stepfun icon is no longer `mono`, so it would stop following the row colour');
  }
  const body = icon[3];
  if (body.indexOf('linearGradient') !== -1 || body.indexOf('url(#') !== -1) {
    throw new Error('the stepfun icon grew a gradient: ' + body.slice(0, 80));
  }
  if (!/fill=\\"currentColor\\"/.test(body) || !/fill-rule=\\"evenodd\\"/.test(body)) {
    throw new Error('the stepfun icon lost its currentColor/evenodd paint');
  }
  const d = /d=\\"([^\\"]+)\\"/.exec(body);
  if (!d) throw new Error('the stepfun icon has no path data');
  const LOBEHUB_STEPFUN_D = 'M12 0C5.372 0 0 5.372 0 12s5.372 12 12 12 12-5.372 12-12S18.628 0 12 0z'
    + 'M8.762 19.614H4.376v-4.386h4.386v4.386zm5.423 0H9.798v-4.386h4.387v4.386z'
    + 'm0-5.42H9.798V9.81h4.387v4.386zm0-5.418H9.798V4.39h4.387v4.386z'
    + 'm5.422-.004h-4.386V4.386h4.386v4.386z';
  if (d[1] !== LOBEHUB_STEPFUN_D) {
    throw new Error('the stepfun drawing is no longer lobehub\'s `Stepfun` ('
      + d[1].length + ' chars vs ' + LOBEHUB_STEPFUN_D.length + ')');
  }
});

// 4f-bis-ter. A route whose model IDS ARE CODENAMES is branded through its
// model NAME. `dsh-provider-qoder` is a multi-vendor gateway that publishes its
// whole catalogue under internal ids — `qmodel_38max`, `dmodel`, `gfmodel`,
// `kmodel_latest` — so before the name tier existed EVERY one of its routes fell
// through to the empty brand slot while the row right next to it read
// "Qwen3.8 Max" / "DeepSeek V4 Pro" / "GLM 5.3" / "Kimi K3". Two of those names
// are carried by no other provider in this deployment, so level 1 showed them on
// a blank gutter beside twelve marked siblings (ui: "为模型选择器中的没有图标的模型
// 加上图标"). The display name is the only identity signal such a gateway leaves,
// because it is the vendor's own self-description — and it is already what level 1
// groups by.
check('a gateway with codename model ids is branded through its model names', () => {
  const helpers = loadModule().__test;
  if (!helpers || !helpers.dmiBrandFor) throw new Error('the brand resolver is not exported for testing');
  const brandOf = helpers.dmiBrandFor;

  // The deployment's REAL route table (cordis.patch.yml + the qoder gateway),
  // one row per registered route: provider route, model id, display name,
  // expected brand. Every one of them must resolve — the request is that NO model
  // in this picker is left without a mark, and a table is the only way to see a
  // single unbranded route among thirty.
  const REAL_ROUTES = [
    ['deepseek', 'deepseek-flash', 'DeepSeek V4.1 Flash', 'deepseek'],
    ['deepseek', 'deepseek-v4-pro', 'DeepSeek V4 Pro', 'deepseek'],
    ['deepseek-account', 'deepseek-flash', 'DeepSeek V4.1 Flash', 'deepseek'],
    ['workbuddy', 'deepseek-v4.1-flash', 'DeepSeek V4.1 Flash', 'deepseek'],
    ['workbuddy', 'glm-5.3', 'GLM 5.3', 'zhipu'],
    ['workbuddy', 'glm-5.3-flash', 'GLM 5.3 Flash', 'zhipu'],
    ['workbuddy', 'minimax-m3', 'Minimax M3', 'minimax'],
    ['workbuddy', 'kimi-k3-1', 'Kimi K3', 'kimi'],
    ['workbuddy', 'kimi-k2.8-preview', 'Kimi K2.8 Preview', 'kimi'],
    ['workbuddy', 'deepseek-v4-pro', 'DeepSeek V4 Pro', 'deepseek'],
    ['xiaomimimo', 'mimo-v2.6-flash', 'Mimo V2.6 Flash', 'xiaomimimo'],
    ['xiaomimimo', 'mimo-v2.6-pro', 'Mimo V2.6 Pro', 'xiaomimimo'],
    ['gemin', 'gemini-3.8-flash-high', 'Gemini 3.8 Flash', 'gemini'],
    ['gemin', 'gemini-3.7-flash-high', 'Gemini 3.7 Flash', 'gemini'],
    ['gemin', 'gemini-3.1-pro-high', 'Gemini 3.1 Pro', 'gemini'],
    ['gemin', 'gpt-oss-120b-medium', 'GPT-OSS 120B (Medium)', 'openai'],
    ['gemin', 'claude-opus-4-6-thinking', 'Claude Opus 4.6 (Thinking)', 'claude'],
    ['gemin', 'claude-sonnet-4-6-thinking', 'Claude Sonnet 4.6 (Thinking)', 'claude'],
    ['glm', 'glm-5.3', 'GLM 5.3', 'zhipu'],
    ['glm', 'glm-5.3-flash', 'GLM 5.3 Flash', 'zhipu'],
    ['glm', 'glm-5.3-flashx', 'GLM 5.3 FlashX', 'zhipu'],
    ['clip', 'kimi-k2.8-code', 'Kimi K2.8 Preview', 'kimi'],
    ['clip', 'kimi-k3', 'Kimi K3', 'kimi'],
    ['step', 'step-3.7-flash', 'Step 3.7 Flash', 'stepfun'],
    ['step', 'step-5-preview', 'Step 5 Preview', 'stepfun'],
    ['dsh-provider-qoder', 'qmodel_38max', 'Qwen3.8 Max', 'qwen'],
    ['dsh-provider-qoder', 'qfmodel', 'Qwen3.8 Flash', 'qwen'],
    ['dsh-provider-qoder', 'dmodel', 'DeepSeek V4 Pro', 'deepseek'],
    ['dsh-provider-qoder', 'dfmodel', 'DeepSeek V4.1 Flash', 'deepseek'],
    ['dsh-provider-qoder', 'gmodel', 'GLM 5.3', 'zhipu'],
    ['dsh-provider-qoder', 'gfmodel', 'GLM 5.3 Flash', 'zhipu'],
    ['dsh-provider-qoder', 'kmodel_latest', 'Kimi K3', 'kimi'],
    ['dsh-provider-qoder', 'kmodel', 'Kimi K2.8 Preview', 'kimi']
  ];
  for (const [provider, id, name, want] of REAL_ROUTES) {
    const got = brandOf(provider, id, name);
    if (got !== want) {
      throw new Error(provider + '/' + id + ' (' + name + ') resolved ' + String(got) + ', expected ' + want);
    }
    // A resolved brand is only worth anything if the table has a DRAWING for it:
    // an unknown key silently degrades to the fallback sparkle, which would put a
    // decorative mark on a row whose vendor is already known.
    if (source.indexOf('"' + want + '":{"vb":') === -1) {
      throw new Error('the ' + want + ' key has no drawing in the icon table');
    }
  }

  // The tiers, in the order they must be consulted. The id is the most specific
  // evidence and the provider the least, so a name may never overrule an id, and a
  // provider-level entry may never overrule a name — otherwise a gateway's own
  // single logo would be stamped on every vendor line it carries.
  if (brandOf('acme-internal', 'deepseek-v4-pro', 'GLM 5.3') !== 'deepseek') {
    throw new Error('the display name overruled the model id');
  }
  if (brandOf('openai', 'qmodel_38max', 'Qwen3.8 Max') !== 'qwen') {
    throw new Error('the provider table overruled the display name');
  }
  if (brandOf('xiaomimimo', 'opaque-1', 'Watch S1') !== 'xiaomimimo') {
    throw new Error('a route whose id and name say nothing stopped using its provider');
  }
  // No signal at all stays unmarked: the empty slot is deliberate (see 4f-bis),
  // and an omitted name must not change any result.
  if (brandOf('acme-internal', 'zeta-1', 'Zeta One') !== null) {
    throw new Error('a route with no brand signal resolved a brand');
  }
  if (brandOf('acme-internal', 'zeta-1') !== null) {
    throw new Error('an omitted display name changed the result');
  }

  // No call site may drop the name tier. Every `dmiBrandFor(...)` in the file is
  // either its own three-parameter declaration or the helper's three-argument
  // call, so a two-argument lookup anywhere is a render path that would draw the
  // blank row again.
  for (const call of source.match(/dmiBrandFor\(([^)]*)\)/g) || []) {
    const args = call.slice('dmiBrandFor('.length, -1).trim();
    if (args.split(',').length !== 3) {
      throw new Error('a brand lookup dropped the display-name argument: ' + call);
    }
  }

  // ---- and the same thing through the real render path ---------------------
  const QODER = [
    { id: 'qmodel_38max', name: 'Qwen3.8 Max', want: 'Qwen' },
    { id: 'qfmodel', name: 'Qwen3.8 Flash', want: 'Qwen' },
    { id: 'dmodel', name: 'DeepSeek V4 Pro', want: 'DeepSeek' },
    { id: 'dfmodel', name: 'DeepSeek V4.1 Flash', want: 'DeepSeek' },
    { id: 'gmodel', name: 'GLM 5.3', want: 'Zhipu' },
    { id: 'gfmodel', name: 'GLM 5.3 Flash', want: 'Zhipu' },
    { id: 'kmodel_latest', name: 'Kimi K3', want: 'Kimi' },
    { id: 'kmodel', name: 'Kimi K2.8 Preview', want: 'Kimi' }
  ];
  const mount = (groups, open, settings, extra) => {
    const made = makeCtx(Object.assign({
      effort: 'high',
      groups: groups,
      settingsValue: Object.assign(
        { advancedEffort: true, effortStyle: 'spray-flow', trackShape: 'capsule' },
        settings || {}
      )
    }, extra || {}));
    loadModule().apply(made.ctx);
    const seat = seatOf(made.registrations);
    const injected = seat.options.inject('session-1');
    hookState.length = 0;
    let tree = expand(seat.component({ ...injected }));
    for (const cls of open) {
      const el = findAll(tree, (p) => typeof p.className === 'string' && p.className.split(' ').indexOf(cls) !== -1)[0];
      if (!el) throw new Error('could not find ' + cls + ' to open');
      el.props.onClick();
      for (let i = 0; i < 4; i += 1) { runEffects(); resetHooks(); tree = expand(seat.component({ ...injected })); }
    }
    return tree;
  };
  /** Every `.dms-option` row, keyed by its title, mapped to its mark's title. */
  const marksOf = (tree) => {
    const out = {};
    const rows = findAll(tree, (p) => typeof p.className === 'string' && p.className.split(' ').indexOf('dms-option') !== -1);
    for (const row of rows) {
      const slot = (row.children || []).filter(Boolean)[0];
      const icon = slot ? (slot.children || []).filter(Boolean)[0] : null;
      out[String(row.props.title)] = icon === undefined || icon === null ? null : String(icon.props.title || '');
    }
    return out;
  };

  // The gateway ON ITS OWN first: every name below is then carried by exactly ONE
  // provider, which is the shape that produced the blank level-1 rows.
  const QODER_GROUPS = [{
    id: 'dsh-provider-qoder',
    name: 'Qoder',
    models: QODER.map((m) => ({
      id: m.id,
      name: m.name,
      reasoning: { defaultEffort: 'high', efforts: [{ id: 'high', name: 'High' }] }
    }))
  }];

  // Level 1 (the aggregated rows) and flat mode (one row per provider model) are
  // TWO separate brand call sites; the codename gateway has to come out marked on
  // both, or one of the two menus still reads as half-empty.
  for (const [label, settings, open] of [
    ['level 1', undefined, ['dms-trigger']],
    ['flat mode', { collapseProviders: false }, ['dms-trigger']]
  ]) {
    const marks = marksOf(mount(QODER_GROUPS, open, settings));
    for (const m of QODER) {
      const title = marks[m.name];
      if (title === undefined) throw new Error(label + ': no row titled ' + m.name);
      if (!title) throw new Error(label + ': ' + m.name + ' (' + m.id + ') still renders no brand mark');
      if (title.indexOf(m.want) === -1) {
        throw new Error(label + ': ' + m.name + ' shows ' + title + ' instead of the ' + m.want + ' mark');
      }
    }
  }

  // The WHOLE deployment through the menu, which is where the requirement is
  // visible: level 1 folds the 33 routes into one row per distinct name, and NOT
  // ONE of those rows may be left with an empty gutter. (Before the name tier,
  // Qwen3.8 Max and Qwen3.8 Flash were exactly those two rows.)
  const REAL_GROUPS = [];
  for (const [provider, id, name] of REAL_ROUTES) {
    let group = REAL_GROUPS.filter((g) => g.id === provider)[0];
    if (!group) {
      group = { id: provider, name: provider, models: [] };
      REAL_GROUPS.push(group);
    }
    group.models.push({ id: id, name: name, reasoning: { defaultEffort: 'high', efforts: [{ id: 'high', name: 'High' }] } });
  }
  const realMarks = marksOf(mount(REAL_GROUPS, ['dms-trigger']));
  const distinctNames = [];
  for (const [, , name] of REAL_ROUTES) if (distinctNames.indexOf(name) === -1) distinctNames.push(name);
  if (Object.keys(realMarks).length !== distinctNames.length) {
    throw new Error('the whole-deployment menu folded ' + Object.keys(realMarks).length
      + ' rows out of ' + distinctNames.length + ' distinct names');
  }
  for (const name of distinctNames) {
    if (!realMarks[name]) throw new Error('the real menu leaves ' + name + ' without a mark');
  }

  // The composer trigger and the capsule caption resolve the brand of the
  // SELECTED model, so a codename route used to leave the composer itself
  // unmarked. `current` therefore has to name one of those routes.
  const onQwen = { current: { provider: 'dsh-provider-qoder', model: 'qmodel_38max', reasoningEffort: 'high' } };
  const triggerTree = mount(QODER_GROUPS, [], undefined, onQwen);
  const trigger = findAll(triggerTree, (p) => p.className === 'dms-trigger')[0];
  const triggerIcon = (trigger.children || []).filter(Boolean)[0];
  if (!triggerIcon || String(triggerIcon.type) !== 'svg') {
    throw new Error('the composer trigger renders no mark for a codename-id selection');
  }
  if (String(triggerIcon.props.title || '').indexOf('Qwen') === -1) {
    throw new Error('the composer trigger shows ' + triggerIcon.props.title + ' for Qwen3.8 Max');
  }
  const captionTree = mount(QODER_GROUPS, ['dms-effortTrigger'], undefined, onQwen);
  const caption = findAll(captionTree, (p) => typeof p.className === 'string' && p.className.split(' ').indexOf('dms-pillCaption') !== -1)[0];
  if (!caption) throw new Error('the capsule caption was not rendered');
  const captionIcon = (caption.children || []).filter(Boolean)[0];
  if (!captionIcon || String(captionIcon.type) !== 'svg') {
    throw new Error('the capsule caption renders no mark for a codename-id selection');
  }
  if (String(captionIcon.props.title || '').indexOf('Qwen') === -1) {
    throw new Error('the capsule caption shows ' + captionIcon.props.title + ' for Qwen3.8 Max');
  }
});

// 4f-quater. SELECTED row = normal icon, every other row = faded icon
// (ui: "选择的图标显示正常，不选择的则淡化"). The list mixes two kinds of mark —
// `mono` glyphs that paint with `fill:currentColor`, and branded glyphs carrying
// their own hard-coded fills — and the row's text colour does NOT change with
// selection, so neither kind reacted on its own. The fade therefore has to ride
// the SLOT and key off the row's selected class, which also makes the rule
// generic: nothing here names a vendor.
check('the selected row keeps its icon, unselected rows fade theirs', () => {
  const cssNow = (() => { injectedCss = ''; loadModule().apply(makeCtx({}).ctx); return injectedCss; })();
  const rule = (sel) => {
    const at = cssNow.indexOf(sel);
    if (at === -1) throw new Error('css rule missing: ' + sel);
    return cssNow.slice(at, cssNow.indexOf('}', at));
  };

  // 1. The resting state of the slot is the FADED one — that is the state every
  //    unselected row gets, so it must be the base declaration.
  const slot = rule('.dms-optionIcon{');
  const restOpacity = /(?:^|;|\{)opacity:([\d.]+)/.exec(slot);
  if (!restOpacity) {
    throw new Error('the brand slot has no resting opacity, so unselected rows cannot be faded: ' + slot);
  }
  const faded = Number(restOpacity[1]);
  if (!(faded > 0 && faded < 1)) {
    throw new Error('the unselected icon opacity is ' + faded + '; it must be strictly between 0 and 1, otherwise unselected marks are either invisible or as loud as the selected one');
  }
  // Faded but still legible: below ~0.4 the mark reads as broken rather than muted.
  if (faded < 0.4) {
    throw new Error('the unselected icon opacity is ' + faded + ', which reads as a broken mark rather than a muted one (expected >= 0.4)');
  }

  // 2. The selected row restores it to fully opaque. Keyed on the ROW's class, so
  //    the rule is about selection and not about any particular brand.
  const selected = rule('.dms-optionSelected .dms-optionIcon');
  // The rule body starts right after `{`, so the first declaration has no leading
  // `;` — allow the start of the string (or `{`) as well as `;`.
  const selOpacity = /(?:^|;|\{)opacity:([\d.]+)/.exec(selected);
  if (!selOpacity) throw new Error('the selected row does not restore its icon opacity: ' + selected);
  if (Number(selOpacity[1]) !== 1) {
    throw new Error('the selected row\'s icon opacity is ' + selOpacity[1] + ', not 1 — the selected mark must read at full strength');
  }
  // A vendor must never be singled out by this rule.
  for (const vendor of ['workbuddy', 'deepseek', 'kimi', 'qwen', 'zhipu', 'minimax']) {
    if (new RegExp('dms-optionIcon[^{]*' + vendor, 'i').test(cssNow)) {
      throw new Error('the icon fade names the vendor "' + vendor + '"; it must apply to every row alike');
    }
  }

  // 3. The fade must actually reach the rendered rows: the selected row in the
  //    tree is the one whose class carries `dms-optionSelected`, and the CSS has
  //    to reach its slot. Assert the class is present on the selected fixture row
  //    and absent on the others, so the selector can do its job.
  //
  //    The fixture deliberately mixes the two KINDS of mark, because that is the
  //    whole reason the fade rides the slot: DeepSeek/Zhipu carry hard-coded
  //    fills while Kimi paints with `currentColor`, and the rule must treat them
  //    identically.
  const FIX = [
    // The current model lives here, so this row is the SELECTED one.
    { id: 'deepseek-official', name: 'DeepSeek', models: [{ id: 'deepseek-v4-flash', name: 'DeepSeek V4 Flash' }] },
    // A self-coloured mark (hard-coded fills).
    { id: 'zai', name: 'Zhipu', models: [{ id: 'glm-5.3', name: 'GLM 5.3' }] },
    // A `mono` mark that paints with currentColor.
    { id: 'moonshot', name: 'Moonshot', models: [{ id: 'kimi-k3', name: 'Kimi K3' }] }
  ];
  const made = makeCtx({
    effort: 'high',
    groups: FIX,
    settingsValue: { advancedEffort: true, effortStyle: 'spray-flow', trackShape: 'capsule' }
  });
  loadModule().apply(made.ctx);
  const seat = seatOf(made.registrations);
  const injected = seat.options.inject('session-1');
  hookState.length = 0;
  resetHooks();
  let tree = expand(seat.component({ ...injected }));
  const trigger = findAll(tree, (p) => p && p.className === 'dms-trigger')[0];
  trigger.props.onClick();
  for (let i = 0; i < 4; i += 1) { runEffects(); resetHooks(); tree = expand(seat.component({ ...injected })); }

  const rows = findAll(tree, (p) => typeof p.className === 'string' && p.className.split(' ').indexOf('dms-option') !== -1);
  if (rows.length < 2) throw new Error('need at least two rows to tell selected from unselected, got ' + rows.length);
  const isSelected = (r) => String(r.props.className).split(' ').indexOf('dms-optionSelected') !== -1;
  const sel = rows.filter(isSelected);
  const unsel = rows.filter((r) => !isSelected(r));
  if (sel.length === 0) throw new Error('no row in the list is marked selected, so the fade would never lift');
  if (unsel.length === 0) throw new Error('every row is marked selected, so the fade would never show');
  // Both kinds must carry the same slot class, or one kind would escape the rule.
  for (const row of rows) {
    const slotEl = (row.children || []).find((c) => c && c.props && c.props.className === 'dms-optionIcon');
    if (!slotEl) throw new Error('a row has no brand slot, so the fade cannot apply to it: ' + String(row.props.title));
  }
});

// 4f-ter. The brand mark's optical correction is PER CALL SITE, the same way its `size`
// is. The composer trigger overrides it (ui: "对话框中的模型加载器的图标下移2px", since
// nudged again by "上移1px"), while the capsule caption and the dropdown rows must keep
// the shared 0.8px exactly.
// Read from the RENDERED inline transform rather than from the source text, because
// that string is what the browser actually receives: a source-only assertion would
// still pass if the shared default moved and dragged the other two sites with it.
check('each brand mark keeps its own optical offset', () => {
  const dyOf = (svg, where) => {
    const style = svg && svg.props && svg.props.style;
    const m = /^translateY\((-?[\d.]+)px\)$/.exec(String(style && style.transform));
    if (!m) throw new Error('could not read the ' + where + ' mark offset: ' + JSON.stringify(style));
    return Number(m[1]);
  };
  // The shared default is the thing the two untouched sites inherit, so pin it first.
  const shared = /const dy = typeof props\.dy === "number" \? props\.dy : (-?[\d.]+);/.exec(source);
  if (!shared) throw new Error('the brand mark lost its per-site offset argument');
  const SHARED_DY = 0.8;
  if (Number(shared[1]) !== SHARED_DY) {
    throw new Error('the SHARED default offset moved to ' + shared[1] + 'px; that also moves the caption and the dropdown rows, which must keep ' + SHARED_DY + 'px');
  }
  // The composer trigger's own offset. This site has been nudged twice, and each
  // request was relative to where the mark ALREADY sat — never to the shared 0.8px
  // default (which belongs to the caption and the dropdown rows).
  //
  //    -0.7  original hand-tuned offset
  //     1.3  "下移2px"  → -0.7 + 2
  //     0.3  "上移1px"  →  1.3 - 1   ← current
  //
  // CSS `+y` is downward, so a drop ADDS and a lift SUBTRACTS. The expectation is
  // derived step by step from the previous value so that a future nudge only has
  // to append one line; writing it as `shared ± n` would be wrong (and did fail
  // here once), because the trigger's offset was never the shared 0.8.
  const TRIGGER_DY_STEPS = [
    { from: -0.7, to: 1.3, why: '下移2px' },  // -0.7 + 2
    { from: 1.3, to: 0.3, why: '上移1px' }    //  1.3 - 1
  ];
  const EXPECTED_TRIGGER_DY = TRIGGER_DY_STEPS[TRIGGER_DY_STEPS.length - 1].to;
  // Guard the chain itself: each step must actually land on the next one, so a
  // stale pair cannot leave the expectation pointing at an unrelated number.
  for (let i = 1; i < TRIGGER_DY_STEPS.length; i += 1) {
    if (TRIGGER_DY_STEPS[i].from !== TRIGGER_DY_STEPS[i - 1].to) {
      throw new Error('the trigger offset history is broken at "' + TRIGGER_DY_STEPS[i].why
        + '": it starts from ' + TRIGGER_DY_STEPS[i].from + ' but the previous step ended at '
        + TRIGGER_DY_STEPS[i - 1].to);
    }
  }

  /** Mount the composer control, click through `open`, return the expanded tree.
   * `settings` overrides the settings the control reads — the flat-mode case
   * needs 「折叠模型供应商」 off, which is a different row call site. */
  const mountTree = (open, settings) => {
    const made = makeCtx({
      effort: 'high',
      settingsValue: Object.assign(
        { advancedEffort: true, effortStyle: 'spray-flow', trackShape: 'capsule' },
        settings || {}
      )
    });
    loadModule().apply(made.ctx);
    const seat = seatOf(made.registrations);
    const injected = seat.options.inject('session-1');
    hookState.length = 0;
    let tree = expand(seat.component({ ...injected }));
    for (const cls of open) {
      const el = findAll(tree, (p) => typeof p.className === 'string' && p.className.split(' ').indexOf(cls) !== -1)[0];
      if (!el) throw new Error('could not find ' + cls + ' to open');
      el.props.onClick();
      for (let i = 0; i < 4; i += 1) { runEffects(); resetHooks(); tree = expand(seat.component({ ...injected })); }
    }
    return tree;
  };
  const onlyChild = (tree, cls, where) => {
    const host = findAll(tree, (p) => typeof p.className === 'string' && p.className.split(' ').indexOf(cls) !== -1)[0];
    if (!host) throw new Error(where + ' not found (' + cls + ')');
    const kids = (host.children || []).filter(Boolean);
    if (!kids.length) throw new Error(where + ' rendered no children at all');
    return kids[0];
  };

  // 1. Composer trigger — the ONE site that overrides the shared offset.
  const triggerIcon = onlyChild(mountTree([]), 'dms-trigger', 'the composer model trigger');
  if (String(triggerIcon.type) !== 'svg') {
    throw new Error('the composer trigger does not lead with the brand mark, got ' + String(triggerIcon.type));
  }
  const triggerDy = dyOf(triggerIcon, 'composer trigger');
  if (triggerDy !== EXPECTED_TRIGGER_DY) {
    const last = TRIGGER_DY_STEPS[TRIGGER_DY_STEPS.length - 1];
    throw new Error('the composer trigger mark sits at ' + triggerDy + 'px; expected ' + EXPECTED_TRIGGER_DY
      + 'px = its previous ' + last.from + 'px after "' + last.why + '"');
  }
  if (Number(triggerIcon.props.width) !== 14) {
    throw new Error('the composer trigger mark changed size: ' + triggerIcon.props.width);
  }

  // 2. Capsule caption — shared offset, untouched.
  const captionDy = dyOf(onlyChild(mountTree(['dms-effortTrigger']), 'dms-pillCaption', 'the capsule caption'), 'capsule caption');
  if (captionDy !== SHARED_DY) {
    throw new Error('the capsule caption mark moved to ' + captionDy + 'px; it must keep the shared ' + SHARED_DY + 'px, so only the composer trigger was meant to change');
  }

  // 3. Level-1 rows (the two-level picker) — shared offset, untouched.
  const rowDy = dyOf(onlyChild(mountTree(['dms-trigger']), 'dms-optionIcon', 'a dropdown row brand slot'), 'dropdown row');
  if (rowDy !== SHARED_DY) {
    throw new Error('the dropdown row mark moved to ' + rowDy + 'px; it must keep the shared ' + SHARED_DY + 'px, so only the composer trigger was meant to change');
  }

  // 4. Flat-mode rows (「折叠模型供应商」 off) — a SEPARATE call site with its
  // own `rowBrand`, and it must keep the shared offset too. Probing only the
  // level-1 row left this one uncovered: a mutation that leaked the trigger's
  // offset onto `rowBrand` passed the whole suite until this case existed.
  const flatDy = dyOf(
    onlyChild(mountTree(['dms-trigger'], { collapseProviders: false }), 'dms-optionIcon', 'a flat-mode row brand slot'),
    'flat row'
  );
  if (flatDy !== SHARED_DY) {
    throw new Error('the flat-mode row mark moved to ' + flatDy + 'px; it must keep the shared ' + SHARED_DY + 'px');
  }
});

// 4f-quater. The model list is TWO LEVELS. Level 1 aggregates by model NAME: two
// providers whose names are identical fold into ONE row no matter how different
// their ids are, while a name differing by even one character (case included)
// stays a row of its own. The provider choice moves to a panel behind the row's
// `>` affordance, which sits AFTER the tick so it can never be read as "this one
// is selected". These checks pin the aggregation rule, the affordance's
// placement, the panel's contents, and what a click on each level selects.
check('the model list aggregates by name and opens a provider panel beside it', () => {
  const SETTINGS = { advancedEffort: true, effortStyle: 'spray-flow', trackShape: 'capsule' };
  /**
   * Mount the seat, open the menu, apply `clicks`, return the live tree.
   * `reuse` mounts the SAME module instance again — a seat remount, which is
   * what a feature toggle or a re-created session does — and is how the memory
   * tests reach "the user comes back later".
   */
  const drive = (groups, clicks, win, doc, reuse) => {
    const made = reuse ? reuse.made : makeCtx({ effort: 'high', groups, settingsValue: SETTINGS });
    if (!reuse) loadModule({ window: win, document: doc }).apply(made.ctx);
    const seat = reuse ? reuse.seat : seatOf(made.registrations);
    const injected = reuse ? reuse.injected : seat.options.inject('session-1');
    hookState.length = 0;
    resetHooks();
    let tree = expand(seat.component({ ...injected }));
    const settle = () => {
      for (let i = 0; i < 4; i += 1) { runEffects(); resetHooks(); tree = expand(seat.component({ ...injected })); }
      return tree;
    };
    for (const step of clicks) {
      const found = findAll(tree, (p) => typeof p.className === 'string' && p.className.split(' ').indexOf(step[0]) !== -1);
      const el = found[step[1] || 0];
      if (!el) throw new Error('could not find ' + step[0] + ' #' + (step[1] || 0) + ' to click');
      el.props.onClick({ stopPropagation() {}, preventDefault() {} });
      settle();
    }
    return { tree: () => tree, settle, made, mount: { made, seat, injected } };
  };
  const rowsOf = (tree) => findAll(tree, (p) => typeof p.className === 'string' && p.className.split(' ').indexOf('dms-option') !== -1);
  const menuCount = (tree) => findAll(tree, (p) => p.className === 'dms-menu').length;
  const panelCount = (tree) => findAll(tree, (p) => p.className === 'dms-sub').length;
  // The fixture from the requirement: two providers sharing ONE name, plus a
  // third whose name differs only in CASE.
  const CROWDED = [
    { id: 'provider-a', name: 'Provider A', models: [{ id: 'deepseek-v4-pro', name: 'DeepSeek-V4-Pro' }] },
    { id: 'provider-b', name: 'Provider B', models: [{ id: 'deepseek-v4-pro-0813', name: 'DeepSeek-V4-Pro' }] },
    { id: 'provider-c', name: 'Provider C', models: [{ id: 'deepseek-v4-pro', name: 'Deepseek-v4-pro' }] }
  ];

  // --- Level 1: aggregation by name -----------------------------------------
  const runA = drive(CROWDED, [['dms-trigger']]);
  const rows = rowsOf(runA.tree());
  if (rows.length !== 2) {
    throw new Error('same-named providers must fold and different names must not: expected 2 rows, got ' + rows.length + ' [' + rows.map((r) => r.props.title).join(' | ') + ']');
  }
  if (rows[0].props.title !== 'DeepSeek-V4-Pro' || rows[1].props.title !== 'Deepseek-v4-pro') {
    throw new Error('the two rows are not the two distinct names in directory order: [' + rows.map((r) => JSON.stringify(r.props.title)).join(' | ') + ']');
  }
  // The affordance is LAST, i.e. after the tick, and only where there is a choice.
  const kids0 = rows[0].children.filter(Boolean);
  if (kids0.length !== 4) throw new Error('a multi-provider row must be icon + copy + tick + arrow, got ' + kids0.length + ' children');
  if (String(kids0[2].props.className) !== 'dms-check') throw new Error('the tick is no longer the third element: ' + String(kids0[2].props.className));
  if (String(kids0[3].props.className).split(' ').indexOf('dms-arrow') === -1) {
    throw new Error('the expand affordance does not sit AFTER the tick: ' + String(kids0[3].props.className));
  }
  const arrowSvg = (kids0[3].children || []).filter(Boolean)[0];
  if (!arrowSvg || String(arrowSvg.type) !== 'svg') throw new Error('the expand affordance carries no svg');
  const arrowPath = (arrowSvg.children || []).filter(Boolean)[0];
  if (!arrowPath || String(arrowPath.props.d).indexOf('M9 5l7 7-7 7') !== 0) {
    throw new Error('the affordance is not a `>` chevron: ' + String(arrowPath && arrowPath.props.d));
  }
  // The single-provider name carries the SAME affordance as the multi-provider
  // one: opening it must show a panel holding that one entry, rather than the
  // row being silently shaped differently.
  const kids1 = rows[1].children.filter(Boolean);
  if (kids1.length !== 4) throw new Error('a single-provider name must still offer `>`: children ' + kids1.length);
  if (String(kids1[3].props.className).split(' ').indexOf('dms-arrow') === -1) {
    throw new Error('the single-provider row does not end with the `>` affordance: ' + String(kids1[3].props.className));
  }
  const solo = drive(CROWDED, [['dms-trigger'], ['dms-arrow', 1]]);
  const soloEntries = findAll(solo.tree(), (p) => typeof p.className === 'string' && p.className.split(' ').indexOf('dms-subOption') !== -1);
  if (panelCount(solo.tree()) !== 1) throw new Error('the single-provider row did not open a panel');
  if (soloEntries.length !== 1) {
    throw new Error('the single-provider panel must hold exactly that one entry, got ' + soloEntries.length);
  }
  const soloLabel = String(soloEntries[0].children.filter(Boolean)[0].children.filter(Boolean)[0].children.filter(Boolean)[0]);
  if (soloLabel !== 'Provider C') {
    throw new Error('the single-provider panel shows the wrong provider: ' + JSON.stringify(soloLabel));
  }
  // The tick reserves its room with a FIXED-SIZE BOX now, not with a no-break
  // space: an empty tick renders no child at all and the 14px square in CSS is
  // what keeps the tick (and the `>` after it) in a stable column.
  if ((kids0[2].children || []).filter(Boolean).length !== 0) {
    throw new Error('the unselected tick rendered a child, so its width would come from that child: ' + JSON.stringify(kids0[2].children));
  }
  const tickRule = /\.dms-check\{[^}]*\}/.exec((() => { injectedCss = ''; loadModule().apply(makeCtx({}).ctx); return injectedCss; })());
  if (!tickRule) throw new Error('the tick lost its css rule');
  if (!/width:14px/.test(tickRule[0]) || !/height:14px/.test(tickRule[0])) {
    throw new Error('the tick box is not a fixed 14px square, so an empty tick would collapse: ' + tickRule[0]);
  }
  if (/font-size/.test(tickRule[0])) {
    throw new Error('the tick still sizes itself from a font, which is what the SVG replaced: ' + tickRule[0]);
  }
  // …and the SELECTED tick is an inline SVG, not the "✓" glyph.
  const chosen = drive([{ id: 'deepseek-official', name: 'DeepSeek', models: [{ id: 'deepseek-v4-flash', name: 'DeepSeek V4 Flash' }] }], [['dms-trigger']]).tree();
  const chosenTick = rowsOf(chosen)[0].children.filter(Boolean)[2];
  const tickSvg = (chosenTick.children || []).filter(Boolean)[0];
  if (!tickSvg || String(tickSvg.type) !== 'svg') throw new Error('the selected tick is not an svg: ' + String(tickSvg && tickSvg.type));
  const tickPath = (tickSvg.children || []).filter(Boolean)[0];
  if (!tickPath || tickPath.type !== 'path') throw new Error('the tick svg has no path');
  if (tickPath.props.stroke !== 'currentColor') throw new Error('the tick does not inherit the brand colour: ' + String(tickPath.props.stroke));
  if (tickPath.props.fill !== 'none') throw new Error('the tick path must be stroked, not filled');
  if (tickPath.props['strokeLinecap'] !== 'round' || tickPath.props['strokeLinejoin'] !== 'round') {
    throw new Error('the tick path has unrounded ends: ' + JSON.stringify(tickPath.props));
  }
  if (String(tickSvg.props['aria-hidden']) !== 'true') throw new Error('the tick svg is not aria-hidden decoration');
  if (rows[0].props['aria-haspopup'] !== 'menu') throw new Error('a multi-provider row does not advertise the provider menu it opens');
  if (rows[0].props['aria-expanded'] !== false) throw new Error('a closed row reports itself expanded: ' + String(rows[0].props['aria-expanded']));
  if (rows[1].props['aria-haspopup'] !== 'menu') throw new Error('a single-provider row does not advertise the panel it opens');

  // --- Level 2: the provider panel ------------------------------------------
  const runB = drive(CROWDED, [['dms-trigger'], ['dms-arrow']]);
  const treeB = runB.tree();
  if (panelCount(treeB) !== 1) throw new Error('clicking `>` did not open exactly one provider panel, got ' + panelCount(treeB));
  if (runB.made.selects.length !== 0) throw new Error('expanding the provider list selected a model by itself: ' + JSON.stringify(runB.made.selects));
  const openRow = rowsOf(treeB)[0];
  if (openRow.props['aria-expanded'] !== true) throw new Error('the expanded row does not report itself expanded');
  const entries = findAll(treeB, (p) => typeof p.className === 'string' && p.className.split(' ').indexOf('dms-subOption') !== -1);
  if (entries.length !== 2) throw new Error('the panel must list every provider carrying the name: expected 2, got ' + entries.length);
  const labels = entries.map((e) => {
    const copy = e.children.filter(Boolean)[0];
    if (String(copy.props.className) !== 'dms-subCopy') {
      throw new Error('the provider entry does not use its own copy class: ' + String(copy.props.className));
    }
    const lines = copy.children.filter(Boolean);
    const classes = lines.map((line) => String(line.props.className));
    if (classes[0] !== 'dms-subProvider' || classes[1] !== 'dms-subName') {
      throw new Error('a provider entry is not provider-line over model-line: ' + JSON.stringify(classes));
    }
    return lines.map((line) => String(line.children.filter(Boolean)[0])).join(' / ');
  });
  if (labels[0] !== 'Provider A / DeepSeek-V4-Pro' || labels[1] !== 'Provider B / DeepSeek-V4-Pro') {
    throw new Error('panel rows are not provider-over-model-name: ' + JSON.stringify(labels));
  }

  // A click on a provider entry selects THAT provider, not the row's default.
  const runD = drive(CROWDED, [['dms-trigger'], ['dms-arrow'], ['dms-subOption', 1]]);
  if (runD.made.selects.length !== 1) throw new Error('clicking a provider entry did not select it: ' + JSON.stringify(runD.made.selects));
  if (runD.made.selects[0].provider !== 'provider-b' || runD.made.selects[0].model !== 'deepseek-v4-pro-0813') {
    throw new Error('the provider entry selected the wrong pair: ' + JSON.stringify(runD.made.selects[0]));
  }

  // --- What a click on the NAME row itself does -----------------------------
  const runE = drive(CROWDED, [['dms-trigger'], ['dms-option']]);
  if (runE.made.selects.length !== 1 || runE.made.selects[0].provider !== 'provider-a') {
    throw new Error('clicking a name row must fall back to the first provider: ' + JSON.stringify(runE.made.selects));
  }
  // When the current model already carries this name, clicking the row re-picks
  // THAT provider (a no-op) instead of jumping to whoever is listed first.
  const SAME = [
    { id: 'provider-a', name: 'Provider A', models: [{ id: 'deepseek-v4-pro', name: 'DeepSeek-V4-Pro' }] },
    { id: 'deepseek-official', name: 'DeepSeek', models: [{ id: 'deepseek-v4-flash', name: 'DeepSeek-V4-Pro' }] }
  ];
  const runF = drive(SAME, [['dms-trigger'], ['dms-option']]);
  if (runF.made.selects.length !== 0) {
    throw new Error('clicking the already-current name switched provider: ' + JSON.stringify(runF.made.selects));
  }
  if (menuCount(runF.tree()) !== 0) throw new Error('the menu stayed open after re-picking the current model');

  // --- Escape unwinds one level at a time -----------------------------------
  // A FRESH mount: `hookState` is a single module-level array, so settling a
  // mount that was driven earlier would re-render it against whatever slot
  // values the mounts in between left behind.
  const runG = drive(CROWDED, [['dms-trigger'], ['dms-arrow']]);
  const rootEl = findAll(runG.tree(), (p) => p.className === 'dms-root')[0];
  if (!rootEl) throw new Error('the composer seat root was not rendered');
  rootEl.props.onKeyDown({ key: 'Escape', preventDefault() {} });
  const treeEsc = runG.settle();
  if (panelCount(treeEsc) !== 0) throw new Error('Escape left the provider panel open');
  if (menuCount(treeEsc) !== 1) throw new Error('Escape closed the whole menu instead of the panel');

  // --- The keyboard reaches the second level too ----------------------------
  // `->` opens the panel for the FOCUSED row and `<-` closes it again. Both
  // compare the focused element against `document.activeElement`, so the test
  // supplies that node itself and hands the module the same document object.
  const doc = {
    createElement: () => ({ dataset: {}, style: {}, textContent: '' }),
    head: { appendChild: () => {} },
    querySelector: () => null,
    addEventListener: () => {}, removeEventListener: () => {},
    activeElement: null, body: {}
  };
  const runH = drive(CROWDED, [['dms-trigger']], undefined, doc);
  const cards = rowsOf(runH.tree());
  const focused = { focus() {} };
  cards[0].props.ref(focused);
  doc.activeElement = focused;
  const rootH = findAll(runH.tree(), (p) => p.className === 'dms-root')[0];
  rootH.props.onKeyDown({ key: 'ArrowRight', preventDefault() {} });
  const afterRight = runH.settle();
  if (panelCount(afterRight) !== 1) throw new Error('ArrowRight did not open the provider panel for the focused row');

  // --- ArrowRight must map the focused row through the ORDER THE USER SEES --
  // With no saved order the rendered list and the directory list are identical,
  // so this case cannot tell them apart. It has to run with a saved order that
  // REVERSES the rows: the row at visual position 0 is then the directory's
  // LAST name, and ArrowRight must open THAT name's panel. Reading the
  // directory order here instead opened the wrong panel — a real bug this
  // mutation only exposed once the fixture had a non-default order.
  {
    const orderStore = {
      data: { 'dsh-modef.row-order.v1': JSON.stringify(['Deepseek-v4-pro', 'DeepSeek-V4-Pro']) },
      getItem(k) { return Object.prototype.hasOwnProperty.call(this.data, k) ? this.data[k] : null; },
      setItem(k, v) { this.data[k] = String(v); },
      removeItem(k) { delete this.data[k]; }
    };
    const doc2 = {
      createElement: () => ({ dataset: {}, style: {}, textContent: '' }),
      head: { appendChild: () => {} },
      querySelector: () => null,
      addEventListener: () => {}, removeEventListener: () => {},
      activeElement: null, body: {}
    };
    const runK = drive(CROWDED, [['dms-trigger']], { localStorage: orderStore }, doc2);
    const cardsK = rowsOf(runK.tree());
    // The saved order puts the lowercase name first, so visual row 0 is that one.
    if (cardsK[0].props.title !== 'Deepseek-v4-pro') {
      throw new Error('the saved order did not reorder the fixture: ' + cardsK.map((c) => c.props.title).join(','));
    }
    const focusedK = { focus() {} };
    cardsK[0].props.ref(focusedK);
    doc2.activeElement = focusedK;
    const rootK = findAll(runK.tree(), (p) => p.className === 'dms-root')[0];
    rootK.props.onKeyDown({ key: 'ArrowRight', preventDefault() {} });
    const afterK = runK.settle();
    if (panelCount(afterK) !== 1) throw new Error('ArrowRight did not open a panel with a saved order in play');
    // The panel must belong to the FOCUSED (first) row: its provider is C, which
    // is the only provider under the lowercase name.
    const providersK = findAll(afterK, (p) => typeof p.className === 'string' && p.className.split(' ').indexOf('dms-subProvider') !== -1)
      .map((p) => String(p.children.filter(Boolean)[0]));
    if (providersK.length !== 1 || providersK[0] !== 'Provider C') {
      throw new Error('ArrowRight opened the wrong row\'s panel: ' + JSON.stringify(providersK));
    }
  }
  const rightLabels = findAll(afterRight, (p) => typeof p.className === 'string' && p.className.split(' ').indexOf('dms-subOption') !== -1)
    .map((e) => String(e.children.filter(Boolean)[0].children.filter(Boolean)[0].children.filter(Boolean)[0]));
  if (rightLabels.join('|') !== 'Provider A|Provider B') {
    throw new Error('ArrowRight opened the wrong name\'s providers: ' + JSON.stringify(rightLabels));
  }
  // The handler must come from the LATEST tree: `onRootKeyDown` closes over the
  // state of the render it was created in, so keying the old element would test
  // a handler that still believes no panel is open.
  findAll(afterRight, (p) => p.className === 'dms-root')[0].props.onKeyDown({ key: 'ArrowLeft', preventDefault() {} });
  const afterLeft = runH.settle();
  if (panelCount(afterLeft) !== 0) throw new Error('ArrowLeft did not close the provider panel');
  if (menuCount(afterLeft) !== 1) throw new Error('ArrowLeft closed the whole menu instead of the panel');
  // …and `->` steps into a SINGLE-provider row's panel too: the keyboard path
  // must not be narrower than the pointer path.
  // EVERY row registers its ref here: `itemRefs` is a fresh array each render
  // whose holes `filter` drops, so registering only row 1 would collapse the
  // index to 0 and silently address row 0.
  const afterLeftRows = rowsOf(afterLeft);
  const focusFirst = { focus() {} };
  const focusSecond = { focus() {} };
  afterLeftRows[0].props.ref(focusFirst);
  afterLeftRows[1].props.ref(focusSecond);
  doc.activeElement = focusSecond;
  findAll(afterLeft, (p) => p.className === 'dms-root')[0].props.onKeyDown({ key: 'ArrowRight', preventDefault() {} });
  const afterSoloRight = runH.settle();
  const soloRight = findAll(afterSoloRight, (p) => typeof p.className === 'string' && p.className.split(' ').indexOf('dms-subOption') !== -1);
  if (panelCount(afterSoloRight) !== 1) throw new Error('ArrowRight did not open the single-provider row\'s panel');
  if (soloRight.length !== 1) throw new Error('the single-provider panel holds ' + soloRight.length + ' entries, expected 1');
  const soloRightLabel = String(soloRight[0].children.filter(Boolean)[0].children.filter(Boolean)[0].children.filter(Boolean)[0]);
  if (soloRightLabel !== 'Provider C') throw new Error('ArrowRight opened the wrong row\'s panel: ' + JSON.stringify(soloRightLabel));

  // --- The secondary line survives only when every provider agrees -----------
  // A description describes ONE model; the row now stands for several. Printing
  // whichever provider happened to be first would misdescribe the others, and
  // dropping it unconditionally would throw away real information.
  const PRO_WITH = (a, b) => [
    { id: 'provider-a', name: 'Provider A', models: [{ id: 'deepseek-v4-pro', name: 'DeepSeek-V4-Pro', description: a }] },
    { id: 'provider-b', name: 'Provider B', models: [{ id: 'deepseek-v4-pro-0813', name: 'DeepSeek-V4-Pro', description: b }] }
  ];
  const secondaryOf = (groups) => {
    const row = rowsOf(drive(groups, [['dms-trigger']]).tree())[0];
    const copy = row.children.filter(Boolean)[1];
    if (String(copy.props.className) !== 'dms-optionCopy') throw new Error('the level-1 row lost its copy column');
    return copy.children.filter(Boolean).slice(1).map((line) => String(line.children.filter(Boolean)[0]));
  };
  const agreed = secondaryOf(PRO_WITH('1M context', '1M context'));
  if (agreed.length !== 1 || agreed[0] !== '1M context') {
    throw new Error('a description every provider agrees on was dropped: ' + JSON.stringify(agreed));
  }
  const disagreed = secondaryOf(PRO_WITH('1M context', '128k context'));
  if (disagreed.length !== 0) {
    throw new Error('a description that differs between providers was printed as if it covered all of them: ' + JSON.stringify(disagreed));
  }

  // --- The chosen provider is REMEMBERED per name ---------------------------
  // Coming back to a name must land on the provider last chosen for it, not on
  // whichever provider the directory lists first. Four things are pinned: the
  // memory is written by a real choice, it survives a seat remount, it survives
  // a whole new module instance (the browser store), and it degrades safely —
  // both when the remembered provider is gone and when the store is hostile.
  const fakeStore = (initial) => {
    const data = Object.assign({}, initial || {});
    return {
      getItem: (k) => (Object.prototype.hasOwnProperty.call(data, k) ? data[k] : null),
      setItem: (k, v) => { data[k] = String(v); },
      removeItem: (k) => { delete data[k]; },
      dump: () => data
    };
  };
  const MEMORY_KEY = 'dsh-modef.provider-memory.v1';
  // A choice made from the panel is remembered…
  const choser = drive(CROWDED, [['dms-trigger'], ['dms-arrow'], ['dms-subOption', 1]]);
  if (choser.made.selects.length !== 1 || choser.made.selects[0].provider !== 'provider-b') {
    throw new Error('the memory fixture did not choose provider B first: ' + JSON.stringify(choser.made.selects));
  }
  // …and a REMOUNT (same module, fresh hooks) then lands on B instead of A. The
  // mock directory reports the default current model again after a remount, so
  // no name is selected and the click has to consult the memory.
  const again = drive(CROWDED, [['dms-trigger'], ['dms-option']], undefined, undefined, choser.mount);
  const picks = again.made.selects;
  if (picks.length !== 2) throw new Error('the remounted seat did not choose anything: ' + JSON.stringify(picks));
  if (picks[1].provider !== 'provider-b' || picks[1].model !== 'deepseek-v4-pro-0813') {
    throw new Error('the remembered provider was not reused after a remount: ' + JSON.stringify(picks[1]));
  }
  // A fresh module instance with the same browser store remembers too, and the
  // store really holds the pair (not just the in-page cache).
  const store = fakeStore();
  const win = { localStorage: store };
  drive(CROWDED, [['dms-trigger'], ['dms-arrow'], ['dms-subOption', 0]], win);
  const wrote = store.dump()[MEMORY_KEY];
  if (typeof wrote !== 'string' || wrote.indexOf('provider-a') === -1) {
    throw new Error('the choice never reached the browser store: ' + JSON.stringify(wrote));
  }
  const freshModule = drive(CROWDED, [['dms-trigger'], ['dms-option']], win);
  if (freshModule.made.selects[0].provider !== 'provider-a') {
    throw new Error('a new module instance ignored the stored memory: ' + JSON.stringify(freshModule.made.selects[0]));
  }
  const storedB = fakeStore({ [MEMORY_KEY]: JSON.stringify({ 'DeepSeek-V4-Pro': 'provider-b\u0000deepseek-v4-pro-0813' }) });
  const fromStoreB = drive(CROWDED, [['dms-trigger'], ['dms-option']], { localStorage: storedB });
  if (fromStoreB.made.selects[0].provider !== 'provider-b') {
    throw new Error('a memory written by an earlier page load was not honoured: ' + JSON.stringify(fromStoreB.made.selects[0]));
  }
  // A remembered provider that no longer exists must fall back to the old
  // default (first listed) rather than selecting nothing.
  const gone = fakeStore({ [MEMORY_KEY]: JSON.stringify({ 'DeepSeek-V4-Pro': 'provider-zzz\u0000removed-model' }) });
  const fallback = drive(CROWDED, [['dms-trigger'], ['dms-option']], { localStorage: gone });
  if (fallback.made.selects.length !== 1 || fallback.made.selects[0].provider !== 'provider-a') {
    throw new Error('a stale memory did not fall back to the directory\'s first provider: ' + JSON.stringify(fallback.made.selects));
  }
  // Hostile and malformed stores: the picker must keep working either way.
  const boom = () => { throw new Error('storage blocked'); };
  const hostile = drive(CROWDED, [['dms-trigger'], ['dms-arrow'], ['dms-subOption', 1]], { localStorage: { getItem: boom, setItem: boom, removeItem: boom } });
  if (hostile.made.selects.length !== 1 || hostile.made.selects[0].provider !== 'provider-b') {
    throw new Error('a store that throws on every access broke the picker: ' + JSON.stringify(hostile.made.selects));
  }
  const malformed = drive(CROWDED, [['dms-trigger'], ['dms-option']], { localStorage: fakeStore({ [MEMORY_KEY]: '{not json' }) });
  if (malformed.made.selects.length !== 1 || malformed.made.selects[0].provider !== 'provider-a') {
    throw new Error('a malformed stored value broke the picker: ' + JSON.stringify(malformed.made.selects));
  }

  // --- The CSS ordering trap -------------------------------------------------
  // The suite reads BASE selectors with `indexOf`, i.e. it takes the first
  // occurrence in the joined sheet, so a level-2 rule whose selector merely
  // CONTAINS a base selector would shadow it. Level-2 elements therefore carry
  // their own class names and no descendant overrides of level-1 classes.
  const cssNow = (() => { injectedCss = ''; loadModule().apply(makeCtx({}).ctx); return injectedCss; })();
  if (cssNow.indexOf('.dms-sub .dms-') !== -1) {
    throw new Error('a level-2 rule overrides a level-1 class by descendant selector, which shadows the base rule for the suite\'s indexOf lookups');
  }
  for (const sel of ['.dms-arrow{', '.dms-sub{', '.dms-subTitle{', '.dms-subOption{', '.dms-subCopy{', '.dms-subName{', '.dms-subProvider{']) {
    if (cssNow.indexOf(sel) === -1) throw new Error('css rule missing: ' + sel);
  }
  const baseAt = cssNow.indexOf('.dms-optionCopy{');
  if (baseAt === -1 || !/flex:1 1 auto/.test(cssNow.slice(baseAt, cssNow.indexOf('}', baseAt)))) {
    throw new Error('the first `.dms-optionCopy{` in the sheet is no longer the base rule, so the brand-slot check would read a level-2 override');
  }
  // The level-2 block must sit AFTER the last base rule of the menu family, so
  // any future override here cannot shadow a base selector for `indexOf`.
  if (cssNow.indexOf('.dms-sub{') < cssNow.indexOf('.dms-check{')) {
    throw new Error('the level-2 rules crept in above the base menu rules again');
  }

  // --- The panel opens right, and flips left only when it would overflow ------
  // `menuRect`/`rootRect` model the real geometry: the menu is `right:0` on the
  // root and floats ABOVE it, so a root-relative top is legitimately negative.
  const place = (innerWidth, clickArrow) => {
    const run = drive(CROWDED, clickArrow ? [['dms-trigger'], ['dms-arrow']] : [['dms-trigger']], { innerWidth, innerHeight: 800 });
    const tree = run.tree();
    const menuEl = findAll(tree, (p) => p.className === 'dms-menu')[0];
    const root = findAll(tree, (p) => p.className === 'dms-root')[0];
    if (!menuEl || !root) throw new Error('could not find the menu and root to measure');
    menuEl.props.ref.current = { getBoundingClientRect: () => ({ left: 460, right: 700, top: 300, bottom: 520, width: 240, height: 220 }) };
    root.props.ref.current = { getBoundingClientRect: () => ({ left: 600, right: 700, top: 528, bottom: 556, width: 100, height: 28 }) };
    const after = run.settle();
    const panel = findAll(after, (p) => p.className === 'dms-sub')[0];
    if (!panel) throw new Error('the provider panel vanished once the anchor became measurable');
    return panel.props.style;
  };
  const right = place(1280, true);
  if (!right || right.left !== '108px' || right.top !== '-228px' || right.maxHeight !== '320px') {
    throw new Error('the default anchor is not 8px right of the menu, top-aligned: ' + JSON.stringify(right));
  }
  const flipped = place(800, true);
  if (!flipped || flipped.left !== '-388px' || flipped.maxHeight !== '320px') {
    throw new Error('a panel that would leave the viewport did not flip to the menu\'s left: ' + JSON.stringify(flipped));
  }
  // Unmeasurable host: no inline anchor at all, and the CSS fallback still puts
  // the panel just right of the control.
  const fb = /\.dms-sub\{[^}]*left:calc\(100% \+ 8px\)/.exec(cssNow);
  if (!fb) throw new Error('the level-2 panel lost its CSS fallback anchor');
  if (flipped.left === right.left) throw new Error('the flip changed nothing, so the measurement is not driving the anchor');
  // A host that cannot be measured (no viewport, or a ref that was never
  // attached) must keep the CSS fallback rather than guess an anchor.
  const blind = drive(CROWDED, [['dms-trigger'], ['dms-arrow']]);
  const blindPanel = findAll(blind.tree(), (p) => p.className === 'dms-sub')[0];
  if (!blindPanel) throw new Error('the provider panel needs the measurement to render at all');
  if (blindPanel.props.style !== undefined) {
    throw new Error('the panel invented an anchor without a measurement: ' + JSON.stringify(blindPanel.props.style));
  }
});

// 4f-quinquies. 「折叠模型供应商」 must be a REAL either/or: ON renders the
// name-aggregated list, OFF renders the previous flat provider-grouped one —
// provider headers back, one row per provider entry, no `>` affordance, no side
// panel, and the arrow keys inert. Both directions are asserted against the same
// directory so neither can drift into the other.
check('turning folding off restores the flat provider-grouped list', () => {
  const FIX = [
    { id: 'provider-a', name: 'Provider A', models: [{ id: 'deepseek-v4-pro', name: 'DeepSeek-V4-Pro', description: 'Pro' }] },
    { id: 'provider-b', name: 'Provider B', models: [{ id: 'deepseek-v4-pro-0813', name: 'DeepSeek-V4-Pro' }] },
    { id: 'deepseek-official', name: 'DeepSeek', models: [{ id: 'deepseek-v4-flash', name: 'DeepSeek V4 Flash' }] }
  ];
  const openMenu = (collapse) => {
    const made = makeCtx({
      effort: 'high',
      groups: FIX,
      settingsValue: { advancedEffort: true, effortStyle: 'spray-flow', trackShape: 'capsule', collapseProviders: collapse }
    });
    loadModule().apply(made.ctx);
    const seat = seatOf(made.registrations);
    const injected = seat.options.inject('session-1');
    hookState.length = 0;
    resetHooks();
    let tree = expand(seat.component({ ...injected }));
    const settle = () => {
      for (let i = 0; i < 4; i += 1) { runEffects(); resetHooks(); tree = expand(seat.component({ ...injected })); }
      return tree;
    };
    const click = (cls, at) => {
      const el = findAll(tree, (p) => typeof p.className === 'string' && p.className.split(' ').indexOf(cls) !== -1)[at || 0];
      if (!el) throw new Error('could not find ' + cls + ' to click');
      el.props.onClick({ stopPropagation() {}, preventDefault() {} });
      return settle();
    };
    click('dms-trigger');
    return {
      tree: () => tree,
      settle: settle,
      click: click,
      made: made,
      root: () => findAll(tree, (p) => p.className === 'dms-root')[0],
      of: (cls) => findAll(tree, (p) => typeof p.className === 'string' && p.className.split(' ').indexOf(cls) !== -1)
    };
  };

  // ---- OFF: the previous list -------------------------------------------
  const flat = openMenu(false);
  const titles = flat.of('dms-groupTitle').map((n) => String((n.children || [])[0]));
  if (titles.join('|') !== 'Provider A|Provider B|DeepSeek') {
    throw new Error('the flat list lost its provider headers: ' + JSON.stringify(titles));
  }
  const flatRows = flat.of('dms-option');
  if (flatRows.length !== 3) throw new Error('the flat list must show one row per provider entry: got ' + flatRows.length);
  if (flat.of('dms-arrow').length !== 0) throw new Error('the flat list still shows the `>` affordance');
  if (flat.of('dms-sub').length !== 0) throw new Error('the flat list rendered a provider panel');
  // A flat row leads with the slot and carries the tick as the third child,
  // exactly like a folded row: the two modes share that markup on purpose.
  for (const row of flatRows) {
    const kids = (row.children || []).filter(Boolean);
    if (kids.length !== 3) throw new Error('a flat row must be slot + copy + tick, got ' + kids.length);
    if (String(kids[0].props.className) !== 'dms-optionIcon') throw new Error('a flat row does not lead with the brand slot');
    if (String(kids[2].props.className) !== 'dms-check') throw new Error('a flat row has no trailing tick column');
  }
  // The default provider entry IS the current model here, so its tick is drawn.
  const selectedFlat = flatRows.filter((row) => String(row.props.className).indexOf('dms-optionSelected') !== -1);
  if (selectedFlat.length !== 1) throw new Error('expected exactly one selected flat row, got ' + selectedFlat.length);
  const flatTick = selectedFlat[0].children.filter(Boolean)[2].children.filter(Boolean)[0];
  if (!flatTick || String(flatTick.type) !== 'svg') throw new Error('the flat selected tick is not an svg: ' + String(flatTick && flatTick.type));
  if (String(selectedFlat[0].props.title) !== 'DeepSeek V4 Flash') {
    throw new Error('the tick landed on the wrong entry: ' + String(selectedFlat[0].props.title));
  }
  // A flat click selects THAT provider entry, and `->` must do nothing: there is
  // no second level to step into.
  flat.click('dms-option', 0);
  if (flat.made.selects.length !== 1 || flat.made.selects[0].provider !== 'provider-a' || flat.made.selects[0].model !== 'deepseek-v4-pro') {
    throw new Error('a flat row did not select its own provider entry: ' + JSON.stringify(flat.made.selects));
  }
  const flatRoot = flat.root();
  flatRoot.props.onKeyDown({ key: 'ArrowRight', preventDefault() {} });
  if (flat.of('dms-sub').length !== 0) throw new Error('ArrowRight opened a panel while folding is off');
  const afterArrowDown = (() => { flatRoot.props.onKeyDown({ key: 'ArrowDown', preventDefault() {} }); return flat.settle(); })();
  if (findAll(afterArrowDown, (p) => p.className === 'dms-menu').length !== 1) {
    throw new Error('ArrowDown closed the menu instead of moving inside it');
  }
  // Escape has ONE level to unwind here, so it closes the menu outright — the
  // folded mode's two-step Escape must not leak into the flat list.
  findAll(afterArrowDown, (p) => p.className === 'dms-root')[0].props.onKeyDown({ key: 'Escape', preventDefault() {} });
  if (findAll(flat.settle(), (p) => p.className === 'dms-menu').length !== 0) {
    throw new Error('Escape did not close the menu while folding is off');
  }

  // ---- ON: the aggregated list, as the contrast ------------------------
  const folded = openMenu(true);
  if (folded.of('dms-groupTitle').length !== 0) throw new Error('the folded list still prints provider headers');
  if (folded.of('dms-option').length !== 2) {
    throw new Error('the folded list must fold same-named providers into one row: got ' + folded.of('dms-option').length);
  }
  if (folded.of('dms-arrow').length !== 2) {
    throw new Error('every folded row must offer `>`, whatever the provider count: got ' + folded.of('dms-arrow').length);
  }
});

// 4f-octies. ONE vendor's provider panel is labelled by MODEL ID. WorkBuddy AI
// registers two models under a single display name in this deployment
// (`deepseek-v4.1-flash` and `deepseek-v4.1-flash-sg` are both "DeepSeek V4.1
// Flash"), so name aggregation folds them into one level-1 row and the panel
// behind it would show two rows that read identically. The exception has to be
// SCOPED, so this check pins all four halves: it fires for a provider matched by
// ID, for one matched by NAME, it is confined to the level-2 model line, and
// every other provider keeps showing names.
check('the workbuddy vendor labels its provider panel by model id', () => {
  const FIX = [
    // Matched by ID only: its display name carries no "workbuddy".
    { id: 'workbuddy-ai', name: 'WB AI', models: [
      { id: 'deepseek-v4.1-flash', name: 'DeepSeek V4.1 Flash' },
      { id: 'deepseek-v4.1-flash-sg', name: 'DeepSeek V4.1 Flash' }
    ] },
    // Matched by NAME only: its id carries no "workbuddy". This is the second
    // registration of the same vendor, which the deployment really does have.
    { id: 'wb-secondary', name: 'WorkBuddy', models: [
      { id: 'hy3', name: 'Hy3' },
      { id: 'hy3-x', name: 'Hy3' }
    ] },
    // An ordinary provider with the same name collision: must keep NAMES.
    { id: 'plain-official', name: 'Plain', models: [
      { id: 'pro', name: 'Same Name' },
      { id: 'pro-sg', name: 'Same Name' }
    ] }
  ];
  /** Open the model menu, then the provider panel of level-1 row `at`. */
  const openPanel = (at) => {
    const made = makeCtx({
      effort: 'high',
      groups: FIX,
      settingsValue: { advancedEffort: true, effortStyle: 'spray-flow', trackShape: 'capsule' }
    });
    loadModule().apply(made.ctx);
    const seat = seatOf(made.registrations);
    const injected = seat.options.inject('session-1');
    hookState.length = 0;
    resetHooks();
    let tree = expand(seat.component({ ...injected }));
    const click = (cls, index) => {
      const el = findAll(tree, (p) => typeof p.className === 'string' && p.className.split(' ').indexOf(cls) !== -1)[index || 0];
      if (!el) throw new Error('could not find ' + cls + ' #' + (index || 0) + ' to click');
      el.props.onClick({ stopPropagation() {}, preventDefault() {} });
      for (let i = 0; i < 4; i += 1) { runEffects(); resetHooks(); tree = expand(seat.component({ ...injected })); }
    };
    click('dms-trigger');
    click('dms-arrow', at);
    return tree;
  };
  const linesOf = (tree, cls) => findAll(tree, (p) => p.className === cls).map((n) => String((n.children || [])[0]));

  // Level 1 is untouched: three distinct names, one row each, still by NAME.
  const menu = openPanel(0);
  const titles = findAll(menu, (p) => typeof p.className === 'string' && p.className.split(' ').indexOf('dms-option') !== -1)
    .map((r) => String(r.props.title));
  if (titles.join('|') !== 'DeepSeek V4.1 Flash|Hy3|Same Name') {
    throw new Error('the level-1 list changed: ' + JSON.stringify(titles));
  }
  // Matched by provider ID: the two rows are told apart by their ids.
  const byId = linesOf(menu, 'dms-subName');
  if (byId.join('|') !== 'deepseek-v4.1-flash|deepseek-v4.1-flash-sg') {
    throw new Error('a provider matched by ID did not label its rows with model ids: ' + JSON.stringify(byId));
  }
  // The provider line above it keeps the DISPLAY name.
  const providerLines = linesOf(menu, 'dms-subProvider');
  if (providerLines.join('|') !== 'WB AI|WB AI') {
    throw new Error('the provider line stopped showing the display name: ' + JSON.stringify(providerLines));
  }
  // Matched by display NAME instead.
  const byName = linesOf(openPanel(1), 'dms-subName');
  if (byName.join('|') !== 'hy3|hy3-x') {
    throw new Error('a provider matched by NAME did not label its rows with model ids: ' + JSON.stringify(byName));
  }
  // Every other provider is untouched — the exception is scoped, not global.
  const plain = linesOf(openPanel(2), 'dms-subName');
  if (plain.join('|') !== 'Same Name|Same Name') {
    throw new Error('an unrelated provider was switched to ids: ' + JSON.stringify(plain));
  }
});

// 4f-nonies. The billing rate rides along with the id. `dsh-workbuddy-connect`
// appends the credits multiplier to the model NAME (` · x6.67`), so the rate
// reaches the picker only as a name tail — and a model whose name the user
// OVERRODE has no tail at all, because an override replaces the name and its
// suffix. The provider's own loopback status route carries the rate for every
// model, so the line falls back to it, and the route is picked by OVERLAP: the
// two routes are per variant and the variants disagree about rates for shared
// ids, which this check pins with a deliberately divergent shared id.
check('the id-labelled rows carry the billing rate', () => {
  const AI_PATH = '/plugins/dsh-workbuddy-connect/ai/status';
  const CN_PATH = '/plugins/dsh-workbuddy-connect/status';
  const AI_STATUS = { status: 'signed-in', models: [
    { id: 'deepseek-v4.1-flash', name: 'Deepseek-V4.1-Flash', displayName: 'DeepSeek V4.1 Flash', credits: 'x0.00' },
    { id: 'deepseek-v4.1-flash-sg', name: 'Deepseek-V4.1-Flash', displayName: 'DeepSeek V4.1 Flash', credits: 'x0.03' },
    { id: 'gpt-6-astra', name: 'GPT-6-Astra', displayName: 'GPT-6 Astra', credits: 'x6.67' }
  ] };
  // The SAME `deepseek-v4.1-flash` id at a DIFFERENT rate: if the tables were
  // merged by model id instead of matched per provider, the AI panel would show
  // x0.03 here.
  const CN_STATUS = { status: 'signed-in', models: [
    { id: 'deepseek-v4.1-flash', name: 'Deepseek-V4.1-Flash', displayName: 'Deepseek-V4.1-Flash', credits: 'x0.03' },
    { id: 'deepseek-v4-pro', name: 'Deepseek-V4-Pro', displayName: 'Deepseek-V4-Pro', credits: 'x0.51' },
    { id: 'deepseek-v4-pro-x', name: 'Deepseek-V4-Pro', displayName: 'Deepseek-V4-Pro', credits: 'x0.55' }
  ] };
  const FIX = [
    // Renamed by the user, so the delivered names carry NO rate tail.
    { id: 'workbuddy-ai', name: 'WorkBuddy AI', models: [
      { id: 'deepseek-v4.1-flash', name: 'DeepSeek V4.1 Flash' },
      { id: 'deepseek-v4.1-flash-sg', name: 'DeepSeek V4.1 Flash' },
      { id: 'gpt-6-astra', name: 'GPT-6 Astra' }
    ] },
    { id: 'workbuddy', name: 'WorkBuddy', models: [
      { id: 'deepseek-v4-pro', name: 'Deepseek-V4-Pro' },
      { id: 'deepseek-v4-pro-x', name: 'Deepseek-V4-Pro' }
    ] },
    // Not an id-labelled provider: the rate lookup must never touch it.
    { id: 'plain-official', name: 'Plain', models: [
      { id: 'pro', name: 'Same Name' },
      { id: 'pro-sg', name: 'Same Name' }
    ] }
  ];
  // A thenable whose callbacks run SYNCHRONOUSLY, so the whole fetch path settles
  // inside the click that opened the menu: a real promise resolves on a
  // microtask, which a synchronous check can never observe. It has to ADOPT a
  // thenable returned by a callback, exactly as a real promise does — without
  // that, the next step would be handed the thenable instead of its value.
  const fast = (value) => ({
    then: (onValue, onError) => {
      if (typeof onValue !== 'function') return fast(value);
      let out;
      try { out = onValue(value); }
      catch (error) {
        if (typeof onError === 'function') return fast(onError(error));
        throw error;
      }
      return out !== null && typeof out === 'object' && typeof out.then === 'function' ? out : fast(out);
    }
  });
  const routeFetch = (routes, log) => (url) => {
    if (log) log.push(String(url));
    const body = Object.prototype.hasOwnProperty.call(routes, url) ? routes[url] : undefined;
    if (body === undefined) return fast({ ok: false, status: 404, json: () => fast(null) });
    return fast({ ok: true, status: 200, json: () => fast(body) });
  };
  /**
   * Open the menu and then the panel of the level-1 row named `name`.
   *
   * Addressed by NAME, not by arrow index: every row carries the affordance now,
   * so an index would silently start meaning a different row the moment a fixture
   * gains one. This also asserts the shape it depends on — the row ends with the
   * `>` affordance.
   */
  const openPanel = (groups, name, fetchImpl) => {
    const made = makeCtx({ effort: 'high', groups: groups, settingsValue: { advancedEffort: true, effortStyle: 'spray-flow', trackShape: 'capsule' } });
    loadModule({ fetch: fetchImpl }).apply(made.ctx);
    const seat = seatOf(made.registrations);
    const injected = seat.options.inject('session-1');
    hookState.length = 0;
    resetHooks();
    let tree = expand(seat.component({ ...injected }));
    const settle = () => {
      for (let i = 0; i < 4; i += 1) { runEffects(); resetHooks(); tree = expand(seat.component({ ...injected })); }
      return tree;
    };
    const click = (cls) => {
      const el = findAll(tree, (p) => typeof p.className === 'string' && p.className.split(' ').indexOf(cls) !== -1)[0];
      if (!el) throw new Error('could not find ' + cls + ' to click');
      el.props.onClick({ stopPropagation() {}, preventDefault() {} });
      return settle();
    };
    click('dms-trigger');
    const row = findAll(tree, (p) => typeof p.className === 'string' && p.className.split(' ').indexOf('dms-option') !== -1 && p.title === name)[0];
    if (!row) throw new Error('no level-1 row named ' + JSON.stringify(name));
    const kids = (row.children || []).filter(Boolean);
    const arrow = kids[kids.length - 1];
    if (!arrow || String(arrow.props.className).split(' ').indexOf('dms-arrow') === -1) {
      throw new Error('the row named ' + JSON.stringify(name) + ' has no `>` affordance');
    }
    arrow.props.onClick({ stopPropagation() {}, preventDefault() {} });
    return settle();
  };
  const lines = (tree) => findAll(tree, (p) => p.className === 'dms-subName').map((n) => String((n.children || [])[0]));

  // 1. Both routes fetched; the AI panel takes the AI route's rates.
  const log = [];
  const aiPanel = lines(openPanel(FIX, 'DeepSeek V4.1 Flash', routeFetch({ [AI_PATH]: AI_STATUS, [CN_PATH]: CN_STATUS }, log)));
  if (aiPanel.join('|') !== 'deepseek-v4.1-flash \u00b7 x0.00|deepseek-v4.1-flash-sg \u00b7 x0.03') {
    throw new Error('the AI panel does not show the AI route\'s rates: ' + JSON.stringify(aiPanel));
  }
  if (log.length !== 2 || log.indexOf(AI_PATH) === -1 || log.indexOf(CN_PATH) === -1) {
    throw new Error('the status routes were not both asked for: ' + JSON.stringify(log));
  }
  // 2. The other variant's provider takes ITS route's rates, including the shared
  //    id whose rate differs between the two.
  const cnPanel = lines(openPanel(FIX, 'Deepseek-V4-Pro', routeFetch({ [AI_PATH]: AI_STATUS, [CN_PATH]: CN_STATUS })));
  if (cnPanel.join('|') !== 'deepseek-v4-pro \u00b7 x0.51|deepseek-v4-pro-x \u00b7 x0.55') {
    throw new Error('the CN panel does not show the CN route\'s rates: ' + JSON.stringify(cnPanel));
  }
  // 3. A menu with no id-labelled provider must not touch the network at all.
  const quiet = [];
  openPanel([FIX[2]], 'Same Name', routeFetch({ [AI_PATH]: AI_STATUS, [CN_PATH]: CN_STATUS }, quiet));
  if (quiet.length !== 0) throw new Error('a menu with no id-labelled provider still fetched: ' + JSON.stringify(quiet));
  // 4. No usable route: fall back to whatever tail the delivered name carries,
  //    and to the bare id when it carries none. Nothing may throw.
  const broken = routeFetch({});
  const fallback = lines(openPanel([
    { id: 'workbuddy-ai', name: 'WorkBuddy AI', models: [
      { id: 'gpt-6-astra', name: 'GPT-6-Astra \u00b7 x6.67' },
      { id: 'gpt-6-astra-alt', name: 'GPT-6-Astra \u00b7 x6.67' }
    ] }
  ], 'GPT-6-Astra \u00b7 x6.67', broken));
  if (fallback.join('|') !== 'gpt-6-astra \u00b7 x6.67|gpt-6-astra-alt \u00b7 x6.67') {
    throw new Error('the name tail is not the fallback when no route answers: ' + JSON.stringify(fallback));
  }
  // The real renamed case: no tail in the data, so the line is the bare id.
  const bare = lines(openPanel([
    { id: 'workbuddy', name: 'WorkBuddy', models: [
      { id: 'deepseek-v4-pro', name: 'Deepseek-V4-Pro' },
      { id: 'deepseek-v4-pro-x', name: 'Deepseek-V4-Pro' }
    ] }
  ], 'Deepseek-V4-Pro', broken));
  if (bare.join('|') !== 'deepseek-v4-pro|deepseek-v4-pro-x') {
    throw new Error('a renamed model without a delivered rate should carry its bare id: ' + JSON.stringify(bare));
  }
  // 5. A fetch that throws synchronously is survivable too.
  const hostile = () => { throw new Error('no network'); };
  const survived = lines(openPanel(FIX, 'DeepSeek V4.1 Flash', hostile));
  if (survived.join('|') !== 'deepseek-v4.1-flash|deepseek-v4.1-flash-sg') {
    throw new Error('a throwing fetch did not degrade to the bare ids: ' + JSON.stringify(survived));
  }
});

// 4f-sexies. The list scrolls but paints NO scrollbar. Both floating panels
// share the single scroll container, so this covers the model menu and the
// level-2 provider panel at once — and it pins BOTH halves of the request: the
// overflow is still `auto` (wheel, trackpad, touch and the browser's
// scroll-into-view on focus all keep working) and the chrome is hidden in the
// two spellings the engines need.
check('the model list scrolls without painting a scrollbar', () => {
  injectedCss = '';
  loadModule().apply(makeCtx({}).ctx);
  const css = injectedCss;
  /** The declaration block of the FIRST rule matching `sel`. */
  const ruleAt = (sel) => {
    const at = css.indexOf(sel);
    if (at === -1) throw new Error('css rule missing: ' + sel);
    return css.slice(at, css.indexOf('}', at));
  };
  // Exactly ONE scroll container, so no other surface can grow a scrollbar of
  // its own behind this check's back.
  const scrollers = css.match(/overflow-y:auto/g) || [];
  if (scrollers.length !== 1) throw new Error('expected exactly one scroll container, got ' + scrollers.length);
  const groups = ruleAt('.dms-groups{');
  if (!/overflow-y:auto/.test(groups)) {
    throw new Error('the list stopped scrolling: hiding a scrollbar must never hide the overflow: ' + groups);
  }
  if (!/scrollbar-width:none/.test(groups)) {
    throw new Error('the standard `scrollbar-width:none` is missing from the scroll container: ' + groups);
  }
  // The engine inside the desktop client needs its own spelling, and it has to
  // be `display:none` on the PSEUDO-ELEMENT — `overflow:hidden` on the box would
  // have removed the scrolling itself.
  const webkit = ruleAt('.dms-groups::-webkit-scrollbar{');
  if (!/display:none/.test(webkit)) throw new Error('the webkit scrollbar is still painted: ' + webkit);
  if (/scrollbar-width:(thin|auto)/.test(css)) throw new Error('a visible scrollbar was requested somewhere');
  // The hiding must not have cost a panel its scrolling list: the open menu
  // still mounts the same scrolling container.
  const made = makeCtx({});
  loadModule().apply(made.ctx);
  const seat = seatOf(made.registrations);
  const injected = seat.options.inject('session-1');
  hookState.length = 0;
  resetHooks();
  let tree = expand(seat.component({ ...injected }));
  const trigger = findAll(tree, (p) => p.className === 'dms-trigger')[0];
  if (!trigger) throw new Error('model trigger not found');
  trigger.props.onClick();
  for (let i = 0; i < 4; i += 1) { runEffects(); resetHooks(); tree = expand(seat.component({ ...injected })); }
  if (findAll(tree, (p) => p.className === 'dms-groups').length !== 1) {
    throw new Error('the open menu no longer renders its scrolling list');
  }
});

// 4f-septies. The `>` affordance must be EASIER TO HIT without looking any
// different. The assertion is geometric and reads its numbers out of the
// stylesheet, so the ring and the row cannot drift apart: the visual box stays
// 18px, an out-of-flow `::after` grows the target, and that target has to stay
// inside the row it lives in — a ring that spilled out would steal clicks from
// the neighbouring rows and give the scroll container something to scroll
// horizontally.
check('the `>` affordance keeps its looks but grows its hit area', () => {
  injectedCss = '';
  loadModule().apply(makeCtx({}).ctx);
  const css = injectedCss;
  const ruleAt = (sel) => {
    const at = css.indexOf(sel);
    if (at === -1) throw new Error('css rule missing: ' + sel);
    return css.slice(at, css.indexOf('}', at));
  };
  const num = (re, where) => {
    const m = re.exec(where);
    if (!m) throw new Error('could not read ' + String(re) + ' from: ' + where);
    return Number(m[1]);
  };
  const arrow = ruleAt('.dms-arrow{');
  const box = num(/(?:^|;)width:(\d+)px/, arrow);
  if (box !== 18) throw new Error('the arrow\'s VISUAL box changed size (' + box + 'px); only the hit area was meant to grow');
  if (num(/(?:^|;)height:(\d+)px/, arrow) !== box) throw new Error('the arrow box is no longer square');
  if (!/position:relative/.test(arrow)) throw new Error('the arrow is not a positioning context for its hit ring');
  if (!/cursor:pointer/.test(arrow)) throw new Error('the arrow lost its pointer cursor');
  if (css.indexOf('.dms-arrow:hover{') === -1) throw new Error('the arrow lost its hover feedback');

  // `0` is legal without a unit, so normalise it before parsing: otherwise a
  // ZERO inset would report itself as an unparseable rule instead of as a zero
  // inset, which is exactly the mistake this check exists to catch.
  const ring = ruleAt('.dms-arrow::after{').replace(/:0(?=;|$)/g, ':0px');
  if (!/content:/.test(ring)) throw new Error('a pseudo-element without content is not rendered, so it could not be hit');
  if (!/position:absolute/.test(ring)) {
    throw new Error('the hit ring takes part in layout, so it would change the row\'s height: ' + ring);
  }
  // An invisible ring: the request was a bigger TARGET, not a bigger arrow.
  if (/(?:^|;)background/.test(ring) || /(?:^|;)border/.test(ring) || /(?:^|;)box-shadow/.test(ring)) {
    throw new Error('the hit ring paints, which would change how the arrow looks: ' + ring);
  }
  const left = Math.abs(num(/left:(-?\d+)px/, ring));
  const right = Math.abs(num(/right:(-?\d+)px/, ring));
  const top = Math.abs(num(/top:(-?\d+)px/, ring));
  const bottom = Math.abs(num(/bottom:(-?\d+)px/, ring));
  if (left !== right || top !== bottom) {
    throw new Error('the hit ring is lopsided: ' + JSON.stringify({ left, right, top, bottom }));
  }
  const target = box + left + right;
  if (target < 28) {
    throw new Error('the hit target is ' + target + 'px; the point was a comfortably bigger target than the ' + box + 'px box');
  }
  // …and it must still fit the row it lives in, on both axes.
  const option = ruleAt('.dms-option{');
  const pad = /(?:^|;)padding:(\d+)px (\d+)px/.exec(option);
  if (!pad) throw new Error('could not read the row padding: ' + option);
  const padY = Number(pad[1]);
  const padX = Number(pad[2]);
  const rowHeight = num(/(?:^|;)line-height:(\d+)px/, option) + padY * 2;
  if (box + top + bottom > rowHeight) {
    throw new Error('the ' + (box + top + bottom) + 'px tall target exceeds the ' + rowHeight + 'px row, so it would steal clicks from the row above or below');
  }
  if (left > padX) {
    throw new Error('the ring reaches ' + left + 'px past the box while the row keeps only ' + padX + 'px of padding, so it would spill out and make the list scroll sideways');
  }
});

// 4g. The composer seat is the one surface where this plugin prints a model name that
// DSH's own selector also prints, so it must give the name at least as much room. The
// shipped trigger (@deepseek-ai/dsh-client-ui-model-selection) is capped at
// `min(360px,45cqw)` inside the composer row, which declares `container-type:inline-size`.
// This one was a flat 180px — half of that — leaving the label 129px. Five names from the
// shipped provider catalogs did not fit; the longest, "DeepSeek V4 Flash Vision Exp",
// needs 176px, so the built-in selector showed it in full while this one ellipsised it.
// Rendered in a real 736px composer row the new cap resolves to 324px and the label
// budget to 273px: 0 of 38 real names clip.
check('the composer model name is not capped at half of DSH own budget', () => {
  const longest = 'DeepSeek V4 Flash Vision Exp';
  const made = makeCtx({ modelName: longest });
  loadModule().apply(made.ctx);
  const seat = seatOf(made.registrations);
  const injected = seat.options.inject('session-1');
  hookState.length = 0;
  const tree = expand(seat.component({ ...injected }));
  const trigger = findAll(tree, (p) => p.className === 'dms-trigger')[0];
  if (!trigger) throw new Error('composer model trigger not found');
  // Whatever CSS does, the string itself is never truncated in the tree, and `title`
  // always carries the whole name for a hover read-out.
  if (trigger.props.title !== longest) {
    throw new Error('the trigger title is ' + JSON.stringify(trigger.props.title) + ', not the full model name');
  }
  const label = findAll(tree, (p) => p.className === 'dms-triggerLabel')[0];
  if (!label || label.children[0] !== longest) {
    throw new Error('the trigger label is not the untruncated model name: ' + JSON.stringify(label && label.children[0]));
  }
  const cssNow = (() => { injectedCss = ''; loadModule().apply(makeCtx({}).ctx); return injectedCss; })();
  const rule = (sel) => {
    const at = cssNow.indexOf(sel);
    if (at === -1) throw new Error('css rule missing: ' + sel);
    return cssNow.slice(at, cssNow.indexOf('}', at));
  };
  const cap = /max-width:([^;}]+)/.exec(rule('.dms-trigger{'));
  if (!cap) throw new Error('the trigger has no width cap, so a long name could push the composer row around');
  // The cap must scale with the composer rather than being a flat pixel count, and it
  // must be the shipped selector's number — not a second, smaller budget invented here.
  if (cap[1] !== 'min(360px,45cqw)') {
    throw new Error('the trigger cap is ' + cap[1] + ", not the shipped selector's min(360px,45cqw)");
  }
  const lab = rule('.dms-triggerLabel{');
  if (!/overflow:hidden/.test(lab) || !/text-overflow:ellipsis/.test(lab)
    || !/white-space:nowrap/.test(lab) || !/min-width:0/.test(lab)) {
    throw new Error('the label lost its last-resort clamp, so a name past the cap would spill out of the button: ' + lab);
  }
  // The composer row's two buttons are one visual unit, so both must carry the
  // NORMAL weight (ui: "把字母的自重变细体"). Pinned as a PAIR rather than one
  // rule at a time: a weight restored on only one of them is exactly the defect
  // that makes the other look bold, and it would survive a per-rule assertion.
  //
  // The expected value is 400 and not something thinner, because 400 is what the
  // shipped selector sets in this same spot — the control this seat shadows must
  // not read heavier than the original. `Max`, the model name and `推理` all
  // inherit these declarations (neither child declares a weight), so this one
  // number governs the whole row.
  const WEIGHTS = {
    '.dms-trigger{': /font-weight:(\d+)/.exec(rule('.dms-trigger{')),
    '.dms-effortTrigger{': /font-weight:(\d+)/.exec(rule('.dms-effortTrigger{'))
  };
  for (const sel of Object.keys(WEIGHTS)) {
    const m = WEIGHTS[sel];
    if (!m) throw new Error('the composer button ' + sel + ' declares no font-weight, so it falls back to the browser default (bolder than the shipped selector)');
    if (Number(m[1]) !== 400) {
      throw new Error('the composer button ' + sel + ' is weight ' + m[1] + ', not the normal 400 the shipped selector uses in this spot');
    }
  }
  // …and the two children must NOT re-declare a weight, or they would silently
  // re-bolden exactly the letters the request is about while the pair check above
  // still passed.
  for (const sel of ['.dms-triggerLabel{', '.dms-effortCaption{', '.dms-effortValue{']) {
    if (/font-weight/.test(rule(sel))) {
      throw new Error('the child ' + sel + ' declares its own font-weight, so it no longer inherits the row\'s normal weight: ' + rule(sel));
    }
  }
});

// 4-pr. The synthetic "Default" tier is GONE (ui: "滑块栏去掉'Default'这个挡位").
// It used to be prepended when a model declared no `defaultEffort`, which put a
// tier on the bar that selected nothing. Two things must hold: the label is gone
// from both dictionaries and from the stop builder, and a model with no real
// effort list now renders NO reasoning control at all — the same posture a model
// with no `reasoning` block already had. A model WITH efforts is unaffected.
check('the Default tier is gone, and a model with no tiers shows no effort control', () => {
  // 1. The label may not survive anywhere: both dictionaries defined it, and the
  //    stop builder must no longer synthesise a stop for a missing defaultEffort.
  if (/"effort\.default"/.test(source)) {
    throw new Error('the effort.default label is still in a dictionary');
  }
  if (source.indexOf('if (reasoning.defaultEffort === undefined) stops.push') !== -1) {
    throw new Error('the synthetic Default stop is still being pushed');
  }
  const renderSeat = (groups) => {
    // The effort control renders for the CURRENT model, so the synthetic
    // directory has to contain the selection the harness reports as current.
    const made = makeCtx({
      groups,
      current: { provider: 'g', model: 'm', reasoningEffort: 'high' }
    });
    loadModule().apply(made.ctx);
    const seat = seatOf(made.registrations);
    const injected = seat.options.inject('session-1');
    hookState.length = 0;
    let tree = expand(seat.component({ ...injected }));
    for (let i = 0; i < 4; i += 1) { runEffects(); resetHooks(); tree = expand(seat.component({ ...injected })); }
    return tree;
  };
  const TIERLESS = [{
    id: 'g', name: 'G',
    // A reasoning block WITHOUT efforts and WITHOUT defaultEffort — exactly the
    // shape that used to get a lone "Default" tier.
    models: [{ id: 'm', name: 'M', reasoning: { efforts: [] } }]
  }];
  const bare = renderSeat(TIERLESS);
  if (findAll(bare, (p) => p && p.className === 'dms-effortTrigger').length !== 0) {
    throw new Error('a model with no reasoning tiers still rendered an effort control');
  }
  if (findAll(bare, (p) => p && typeof p.className === 'string' && p.className.indexOf('dms-effortValue') === 0).length !== 0) {
    throw new Error('a model with no reasoning tiers still rendered an effort value label');
  }
  // …and the same for a model whose reasoning block is missing entirely, so the
  // two "no tiers" shapes stay indistinguishable.
  const noReasoning = renderSeat([{ id: 'g', name: 'G', models: [{ id: 'm', name: 'M' }] }]);
  if (findAll(noReasoning, (p) => p && p.className === 'dms-effortTrigger').length !== 0) {
    throw new Error('a model without a reasoning block changed posture');
  }
  // 2. A model WITH tiers keeps its control and shows a REAL tier name, never
  //    "Default".
  const withTiers = renderSeat([{
    id: 'g', name: 'G',
    models: [{ id: 'm', name: 'M', reasoning: { defaultEffort: 'high', efforts: [{ id: 'low', name: 'Low' }, { id: 'high', name: 'High' }] } }]
  }]);
  const trigger = findAll(withTiers, (p) => p && p.className === 'dms-effortTrigger')[0];
  if (!trigger) throw new Error('a model WITH tiers lost its effort control');
  const shown = findAll(withTiers, (p) => p && typeof p.className === 'string' && p.className.indexOf('dms-effortValue') === 0)[0];
  if (!shown) throw new Error('a model WITH tiers lost its effort value label');
  if (String((shown.children || [])[0]) === 'effort.default') {
    throw new Error('a real model still renders the Default tier label');
  }
});

// 4-pr2. Tier gradients (ui: "对话框里思考强度为最高档时，思考强度字体为蓝紫渐变，
// 现在给最高档之前的一个档也加上效果，淡蓝到蓝色的渐变动效").
//
// Three separate things can each silently produce a working-looking screen with
// no gradient, and each needs its own guard:
//   1. THE FLOW DID NOT EXIST. Both gradient rules asked for
//      `animation:dms-textflow ...` while NO such @keyframes was defined
//      anywhere — the browser drops an animation whose name it cannot resolve,
//      with no error and no visible break, so every "animated" gradient text
//      was in fact a STATIC gradient. The keyframes must exist AND the ramp
//      must actually be wider than the box, or the animation would slide
//      nothing.
//   2. THE CLASS MUST REACH ALL THREE TIERS: MAX gets the blue->purple ramp,
//      the tier below gets the pale-blue->blue one, everything lower gets
//      nothing.
//   3. THE SOLID-COLOUR RULES MUST NOT WIN. The carrier's colour rule is a
//      `:not()` chain at (0,2,0) and outranks a single-class gradient; missing
//      either gradient class from that chain paints the tier SOLID.
check('the effort label is gradient-animated at MAX and at the tier below it', () => {
  // 1. Root cause: the keyframes the rules reference really exist.
  const rgb = (h) => [parseInt(h.slice(1, 3), 16), parseInt(h.slice(3, 5), 16), parseInt(h.slice(5, 7), 16)];
  const satOf = (c) => Math.max(c[0], c[1], c[2]) - Math.min(c[0], c[1], c[2]);
  const flowAt = injectedCss.indexOf('@keyframes dms-textflow');
  if (flowAt === -1) {
    throw new Error('dms-textflow is referenced by the gradient rules but never defined — the gradients would be static');
  }
  // Read the block properly (a body of nested `%{...}` stops, so the closing
  // brace has to be matched by depth rather than by regex).
  const open = injectedCss.indexOf('{', flowAt);
  let depth = 0;
  let flowBody = null;
  for (let i = open; i < injectedCss.length; i += 1) {
    if (injectedCss[i] === '{') depth += 1;
    else if (injectedCss[i] === '}') { depth -= 1; if (depth === 0) { flowBody = injectedCss.slice(open, i + 1); break; } }
  }
  if (!flowBody) throw new Error('unbalanced @keyframes dms-textflow');
  const flowStops = [...flowBody.matchAll(/([\d.]+)%\{([^}]*)\}/g)].map((m) => ({ at: Number(m[1]), css: m[2] }));
  if (flowStops.length < 2) throw new Error('dms-textflow has no stop pairs: ' + flowBody);
  if (flowStops[0].at !== 0 || flowStops[flowStops.length - 1].at !== 100) {
    throw new Error('dms-textflow must span 0%..100%: ' + flowBody);
  }
  // It must move `background-position`, and the loop must CLOSE, or the ramp
  // would jump back to its start on every iteration.
  for (const s of flowStops) {
    if (!/background-position:/.test(s.css)) {
      throw new Error('the dms-textflow stop at ' + s.at + '% does not move background-position: ' + s.css);
    }
  }
  if (flowStops[0].css !== flowStops[flowStops.length - 1].css) {
    throw new Error('dms-textflow is an open loop (0% != 100%), so it would visibly jump: ' + flowStops[0].css + ' vs ' + flowStops[flowStops.length - 1].css);
  }
  const positions = [...flowBody.matchAll(/background-position:([\d.]+)%/g)].map((m) => Number(m[1]));
  if (new Set(positions).size < 2) {
    throw new Error('dms-textflow never actually moves the ramp: ' + positions.join(', '));
  }
  // Every gradient rule must point at those keyframes, and its ramp must be
  // WIDER than the element (background-size > 100%), or there is nothing to slide.
  for (const [cls, minStops] of [['dms-labelGrad', 4], ['dms-labelGradHigh', 3]]) {
    const rule = new RegExp('\\.' + cls + '\\{([^}]*)\\}').exec(injectedCss);
    if (!rule) throw new Error('the ' + cls + ' rule is missing');
    if (!/animation:dms-textflow\b/.test(rule[1])) {
      throw new Error(cls + ' does not use the dms-textflow animation: ' + rule[1]);
    }
    if (!/-webkit-background-clip:text/.test(rule[1]) || !/background-clip:text/.test(rule[1])) {
      throw new Error(cls + ' does not clip its background to the glyphs: ' + rule[1]);
    }
    if (!/-webkit-text-fill-color:transparent/.test(rule[1])) {
      throw new Error(cls + ' does not make the fill transparent: ' + rule[1]);
    }
    const size = /background-size:(\d+)%/.exec(rule[1]);
    if (!size || Number(size[1]) <= 100) {
      throw new Error(cls + ' has a background-size that does not exceed the box, so the flow would be invisible: ' + rule[1]);
    }
    const ramp = /linear-gradient\(90deg,(#[0-9A-Fa-f]{6}(?:,#[0-9A-Fa-f]{6})+)\)/.exec(rule[1]);
    if (!ramp) throw new Error(cls + ' has no flat hex ramp: ' + rule[1]);
    const stops = ramp[1].split(',');
    if (stops.length < minStops) {
      throw new Error(cls + ' has only ' + stops.length + ' stops, expected at least ' + minStops);
    }
    // SATURATION, measured rather than trusted: the whole reason the MAX ramp
    // was rewritten is that a near-white stop reads as white text. A pale
    // "淡蓝" is exactly the risk here, so every stop AND every interpolated
    // phase must stay clear of the washed-out end.
    const cols = stops.map(rgb);
    for (const c of cols) {
      if (satOf(c) < 100) throw new Error(cls + ' stop rgb(' + c.join(',') + ') is too pale (saturation ' + satOf(c) + ') and will read as white');
    }
    let worst = Infinity;
    for (let p = 0; p <= 1.0001; p += 0.01) {
      const x = p * (cols.length - 1);
      const i = Math.min(cols.length - 2, Math.floor(x));
      const t = x - i;
      const c = cols[i].map((v, k) => v + (cols[i + 1][k] - v) * t);
      worst = Math.min(worst, satOf(c));
    }
    if (worst < 100) {
      throw new Error(cls + ' washes out to near-white at some animation phase (worst saturation ' + Math.round(worst) + ')');
    }
  }
  // The high ramp must be BLUER and LIGHTER than the MAX ramp, not a second
  // purple: the request is 淡蓝到蓝, and a lower tier must never out-shout MAX.
  //
  // Ordering alone was NOT enough: substituting MAX's own ramp for the high one
  // still passed, because it is blue-dominant and its mean is a hair lighter
  // (measured: blue bias 145.3 vs 128.8, luminance 115.9 vs 115.5 — the second
  // margin is 0.4). Two colour-shape facts separate the tiers for real:
  //   * the high ramp never leaves the CYAN-BLUE family: red stays low at
  //     EVERY stop, so it cannot turn purple partway;
  //   * MAX's ramp is a blue->PURPLE journey, i.e. red must RISE across it.
  // Together they pin "淡蓝到蓝" against "blue to purple", which no ordering of
  // means can do.
  const highRule = /\.dms-labelGradHigh\{([^}]*)\}/.exec(injectedCss)[1];
  const maxRule = /\.dms-labelGrad\{([^}]*)\}/.exec(injectedCss)[1];
  const highBlues = [...highRule.matchAll(/#([0-9A-Fa-f]{6})/g)].map((m) => rgb('#' + m[1]));
  const maxBlues = [...maxRule.matchAll(/#([0-9A-Fa-f]{6})/g)].map((m) => rgb('#' + m[1]));
  const mean = (list) => list.reduce((a, c) => [a[0] + c[0], a[1] + c[1], a[2] + c[2]], [0, 0, 0]).map((v) => v / list.length);
  const highMean = mean(highBlues);
  const maxMean = mean(maxBlues);
  const blueBias = (c) => c[2] - c[0];
  if (blueBias(highMean) <= blueBias(maxMean)) {
    throw new Error('the lower tier is not bluer than MAX (blue bias ' + blueBias(highMean).toFixed(0) + ' vs ' + blueBias(maxMean).toFixed(0) + ') — 淡蓝到蓝 must stay blue');
  }
  const lum = (c) => 0.2126 * c[0] + 0.7152 * c[1] + 0.0722 * c[2];
  if (lum(highMean) <= lum(maxMean)) {
    throw new Error('the lower tier is not LIGHTER than MAX (luminance ' + lum(highMean).toFixed(0) + ' vs ' + lum(maxMean).toFixed(0) + ') — the lower tier must not out-shout MAX');
  }
  // Colour SHAPE, which is what actually separates 淡蓝到蓝 from 蓝到紫.
  // Every stop of the lower ramp must be a blue/cyan: blue is the dominant
  // channel and red stays clearly below green. A ramp that turns purple at any
  // stop fails here even though its MEAN can still look bluer and lighter.
  for (const c of highBlues) {
    if (!(c[2] > c[1] && c[1] > c[0])) {
      throw new Error('the lower tier stop rgb(' + c.join(',') + ') is not a cyan-blue (needs blue > green > red) — 淡蓝到蓝 must stay in the blue family');
    }
  }
  // …and MAX must be the one that travels toward purple: red RISES across it.
  // Asserted on the ramp's own first/last stop, so a "blue to blue" MAX would
  // fail here while a genuine blue->purple passes.
  const maxFirst = maxBlues[0];
  const maxLast = maxBlues[maxBlues.length - 1];
  if (!(maxLast[0] > maxFirst[0])) {
    throw new Error('the MAX ramp no longer travels toward purple (red ' + maxFirst[0] + ' -> ' + maxLast[0] + ')');
  }

  // 2 + 3. Behaviour: the class must follow the TIER, on every carrier.
  const renderAt = (effort) => {
    const made = makeCtx({
      effort,
      groups: [{ id: 'g', name: 'G', models: [{ id: 'm', name: 'M', reasoning: { defaultEffort: 'high', efforts: [{ id: 'low', name: 'Low' }, { id: 'high', name: 'High' }, { id: 'max', name: 'Max' }] } }] }],
      current: { provider: 'g', model: 'm', reasoningEffort: effort }
    });
    loadModule().apply(made.ctx);
    const seat = seatOf(made.registrations);
    const injected = seat.options.inject('session-1');
    hookState.length = 0;
    let tree = expand(seat.component({ ...injected }));
    // Open the panel so BOTH shapes' carriers exist, then settle.
    const trigger = findAll(tree, (p) => p && p.className === 'dms-effortTrigger')[0];
    if (trigger && trigger.props && trigger.props.onClick) trigger.props.onClick();
    for (let i = 0; i < 4; i += 1) { runEffects(); resetHooks(); tree = expand(seat.component({ ...injected })); }
    return tree;
  };
  const carriersAt = (tree) => findAll(tree, (p) => p && typeof p.className === 'string'
    && /^dms-(effortValue|effortCaption|pillValue|panelValue)(\s|$)/.test(p.className))
    .map((p) => p.props.className);
  const expectClass = (effort, wanted) => {
    const list = carriersAt(renderAt(effort));
    if (list.length === 0) throw new Error('no gradient carriers rendered at "' + effort + '"');
    for (const cn of list) {
      if (wanted === null) {
        if (/dms-labelGrad/.test(cn)) {
          throw new Error('the lower tier "' + effort + '" got a gradient class it must not have: ' + cn);
        }
      } else if (cn.indexOf(wanted) === -1) {
        throw new Error('the "' + effort + '" tier carrier is missing ' + wanted + ': ' + cn);
      }
    }
  };
  expectClass('max', 'dms-labelGrad');
  expectClass('high', 'dms-labelGradHigh');
  expectClass('low', null);
  // The two gradient classes are mutually exclusive: a carrier must never hold
  // both, or the cascade order between them would silently decide the colour.
  // Compared as CLASS TOKENS, not substrings — `dms-labelGrad` is a prefix of
  // `dms-labelGradHigh`, so a naive `indexOf` cannot tell them apart.
  for (const effort of ['max', 'high', 'low']) {
    for (const cn of carriersAt(renderAt(effort))) {
      const tokens = cn.split(/\s+/);
      if (tokens.indexOf('dms-labelGrad') !== -1 && tokens.indexOf('dms-labelGradHigh') !== -1) {
        throw new Error('a carrier holds both gradient classes at "' + effort + '": ' + cn);
      }
    }
  }
});

// 4. Drag cost. The bar's geometry used to be read from the DOM once per pointer
// event and again per animation frame, with a fill-width WRITE in between — so
// every read forced a synchronous layout flush of the bar subtree, twice a frame.
// This pins the fixed behaviour: one measurement per drag, and at most one tier
// update per animation frame no matter how fast the pointer reports.
check('a drag measures the bar once and coalesces pointer moves per frame', () => {
  const made = makeCtx({});
  loadModule().apply(made.ctx);
  const seat = seatOf(made.registrations);
  const injected = seat.options.inject('session-1');
  hookState.length = 0;
  let tree = expand(seat.component({ ...injected }));
  const trigger = findAll(tree, (p) => p.className === 'dms-effortTrigger')[0];
  if (!trigger) throw new Error('effort trigger not found');
  trigger.props.onClick();
  tree = expand(seat.component({ ...injected }));

  const isSliderRoot = (p) => typeof p.className === 'string' && /\bdms-slider\b/.test(p.className);
  const slider = findAll(tree, isSliderRoot)[0];
  const fill = findAll(tree, (p) => typeof p.className === 'string' && p.className.indexOf('dms-fill') === 0)[0];
  const thumb = findAll(tree, (p) => typeof p.className === 'string' && p.className.indexOf('dms-thumb') === 0)[0];
  if (!slider || !fill || !thumb) throw new Error('slider parts not found');

  const WIDTH = 200;
  let rectCalls = 0;
  const sliderNode = {
    clientWidth: WIDTH,
    getBoundingClientRect: () => { rectCalls += 1; return { left: 0, width: WIDTH }; },
    setPointerCapture: () => {},
    releasePointerCapture: () => {}
  };
  slider.props.ref(sliderNode);
  const fillNode = { style: {} };
  fill.props.ref(fillNode);
  const thumbNode = { style: {} };
  thumb.props.ref(thumbNode);

  const afterMount = rectCalls;
  slider.props.onPointerDown({ clientX: 4, pointerId: 1, preventDefault() {} });
  // The geometry must be applied from the cached measurement, with no DOM read.
  if (fillNode.style.width === undefined) throw new Error('pointerdown did not write the fill width');
  if (thumbNode.style.transform === undefined) throw new Error('pointerdown did not write the handle transform');
  if (rectCalls !== afterMount + 1) {
    throw new Error('pointerdown measured the bar ' + (rectCalls - afterMount) + ' times; expected exactly 1');
  }

  // A fast drag: 50 positions inside one frame must not schedule 50 updates.
  rafScheduled = 0;
  const before = rectCalls;
  for (let i = 0; i < 50; i += 1) slider.props.onPointerMove({ clientX: 4 + i * 4 });
  if (rafScheduled !== 1) {
    throw new Error('50 pointer moves scheduled ' + rafScheduled + ' frames; they must coalesce to 1');
  }
  if (rectCalls !== before) {
    throw new Error('pointermove read the DOM ' + (rectCalls - before) + ' times; the cached rect must be reused');
  }

  // Run one frame: the coalesced update must consume the LAST position, not an
  // intermediate one. The move kicks off a snap animation, so instead of waiting
  // on that animation the end-to-end proof is the commit below: pointerup at the
  // far right must select the MAX tier.
  const ran = flushRaf();
  if (ran === 0) throw new Error('no captured frame ran; the coalesced move was lost');
  slider.props.onPointerUp({ clientX: 4 + 49 * 4, pointerId: 1 });
  const committed = made.selects[made.selects.length - 1];
  if (!committed) throw new Error('the drag never committed a selection');
  if (committed.reasoningEffort !== 'max') {
    throw new Error('the drag committed ' + JSON.stringify(committed) + '; the last position must select MAX');
  }
});

// 5. a crash inside the control is contained (entry is NOT retired)
check('entry boundary contains a render crash and records telemetry', () => {
  const { ctx, registrations, writes } = makeCtx({});
  loadModule().apply(ctx);
  const seat = seatOf(registrations);
  const injected = seat.options.inject('session-1');
  const boom = () => { throw new Error('boom'); };
  renderNode(seat.component({ ...injected, t: boom }), 0);
  const telemetry = writes.find(([k]) => k === 'lastSeatError');
  if (!telemetry) throw new Error('lastSeatError telemetry not written');
  if (!String(telemetry[1]).includes('boom')) throw new Error('telemetry missing the message');
});

// 5. A failing registration must cost only its own surface. 0.2.0-rc.1 made
// `slots.register` a HARD error (an undeclared slot, or a second entry in one
// cell at the same priority) and stopped swallowing a throwing `slots.inject`
// callback: the service re-throws it from a microtask, so it lands as an
// UNCAUGHT error in the page instead of a console line. The settings card is
// decoration beside the composer control, so the seat must survive its
// registration failing — and the failure must still be reported, not eaten.
check('a failed settings-card registration costs only the card', () => {
  clientErrors.length = 0;
  const failed = makeCtx({ registerThrows: 'plugins.item' });
  loadModule().apply(failed.ctx);   // must not throw out of apply
  if (!failed.injectedSlotNames.includes('plugins.item')) {
    throw new Error('the card stopped asking for the Plugins page slot');
  }
  if (failed.registrations.some((r) => r.options.name === 'plugins.item')) {
    throw new Error('the throwing registration was recorded anyway; the mock did not exercise the failure');
  }
  if (!seatOf(failed.registrations)) {
    throw new Error('the composer seat was lost with the card registration');
  }
  if (clientErrors.length === 0) {
    throw new Error('the card registration failed silently; nothing was reported');
  }
  // And with a healthy registry the card is still registered, so the containment
  // cannot be passing by never registering at all.
  const ok = makeCtx({});
  loadModule().apply(ok.ctx);
  if (!ok.registrations.some((r) => r.options.name === 'plugins.item')) {
    throw new Error('the card is no longer registered when the slot accepts it');
  }
});

// The same containment for the 可选提供商 panel: it is the LAST registration, so a
// throwing one must cost the panel alone — the card and the composer seat that
// were registered before it have to survive, and the failure must still be
// reported. This is the failure mode that motivated the inner try/catch: a
// `slots.register` throw inside a 0.2.0-rc.1 `slots.inject` callback surfaces as
// an uncaught global error and can take the entry (and the seat) with it.
check('a failed optional-provider registration costs only the panel', () => {
  clientErrors.length = 0;
  const failed = makeCtx({ registerThrows: 'settings.models.footer' });
  loadModule().apply(failed.ctx);   // must not throw out of apply
  if (!failed.injectedSlotNames.includes('settings.models.footer')) {
    throw new Error('the panel stopped asking for the Models footer slot');
  }
  if (failed.registrations.some((r) => r.options.name === 'settings.models.footer')) {
    throw new Error('the throwing registration was recorded anyway; the mock did not exercise the failure');
  }
  if (!failed.registrations.some((r) => r.options.name === 'plugins.item')) {
    throw new Error('the settings card was lost with the panel registration');
  }
  if (!seatOf(failed.registrations)) {
    throw new Error('the composer seat was lost with the panel registration');
  }
  if (clientErrors.length === 0) {
    throw new Error('the panel registration failed silently; nothing was reported');
  }
});

// 4. REGRESSION: an unaddressable session (a subagent) must render nothing
// WITHOUT crashing. Returning early above the last few hooks used to (a) skip
// hooks 鈥?React then saw a changing hook count 鈥?and (b) leave
// `committedRatio`/`stops`/`stopIndex` uninitialized, so the mount effect threw
// a TDZ ReferenceError, the boundary latched seatFatal, and the composer lost
// its model selector entirely.
check('unavailable session renders nothing without a hook-order or TDZ crash', () => {
  const made = makeCtx({ subagent: true });
  loadModule().apply(made.ctx);
  const seat = seatOf(made.registrations);
  const injected = seat.options.inject('subagent-session');
  if (injected.available !== false) throw new Error('expected an unavailable seat, got available=' + injected.available);
  // Two consecutive renders must both succeed: a changing hook count only
  // shows up on the second render.
  renderNode(seat.component({ ...injected }), 0);
  renderNode(seat.component({ ...injected }), 0);
  if (capturedEffects.length === 0) throw new Error('no effects captured; the TDZ path was not exercised');
  runEffects();   // the effects that used to hit the TDZ
  const crash = made.writes.find(([k]) => k === 'lastSeatError');
  if (crash) throw new Error('seat reported a crash: ' + String(crash[1]).slice(0, 160));
});

// 4b. 样式显示名 (ui: "把思考强度浮层中的滑块栏样式『宇宙』改为『流体』，只改名称").
// ONLY the label moves: the style id is the value persisted in the settings
// document, so renaming it would silently invalidate a saved choice. The stub
// locale returns the KEY, so the real copy is read out of the source.
check('the cosmos style is labelled 流体, and its id is unchanged', () => {
  // Both dictionaries define the key; read them all rather than anchoring on one.
  const all = [...source.matchAll(/"style\.cosmos":\s*"([^"]*)"/g)].map((m) => m[1]);
  if (all.length !== 2) throw new Error('expected the label in exactly 2 dictionaries, found ' + JSON.stringify(all));
  if (all.indexOf('流体') === -1 || all.indexOf('Fluid') === -1) {
    throw new Error('the two labels are ' + JSON.stringify(all) + ', expected [流体, Fluid]');
  }
  // 名称改了，id 没改：下拉的 option value 与 EFFECT_STYLES 的条目都还是 "cosmos"。
  if (!/\{ id: "cosmos", titleKey: "style\.cosmos", kind: "fill" \}/.test(source)) {
    throw new Error('the cosmos EFFECT_STYLES entry changed; a saved effortStyle would stop resolving');
  }
  // 也不能有别的样式被顺手改名。
  if (/"style\.sprayFlow": "喷射流光"/.test(source) === false) throw new Error('spray-flow label changed');
  if (/"style\.undertow": "暗流涌动"/.test(source) === false) throw new Error('undertow label changed');
  if (/"style\.sunset": "晚霞"/.test(source) === false) throw new Error('sunset label changed');
  // 旧名不该在任何字典里残留（注释里可以提，文案不行）。
  if (/"style\.cosmos": "宇宙"/.test(source)) throw new Error('the old label 宇宙 is still in a dictionary');
  // 彩虹猫已删除：实现残留（样式表类名、常量、字典键）一个都不许剩。注意这里
  // 刻意不查裸 id 字符串 `"nyancat"` —— 那是行为断言的地盘（上面的「saved style
  // falls back」检查会看到下拉里多出一项、以及 MAX 档没回落到默认样式），
  // 在这里再查一遍只会让那条行为断言永远不可达。
  for (const dead of ['style.nyanCat', 'dms-rainbow', 'dms-nyanCat', 'dms-nyanPix', 'dms-thumbNyan', 'dms-sliderNyan', 'dms-rangeNyan', 'NT_CAT_CSS', 'NYAN_BOXES', 'NYAN_FRAMES', 'dms-wave-swap']) {
    if (source.indexOf(dead) !== -1) throw new Error('the removed 彩虹猫 style still leaves ' + dead + ' behind');
  }
  // 剩下的样式必须正好是这四个，且注册表与字典一一对应。
  const ids = [...source.matchAll(/\{ id: "([^"]+)", titleKey: "([^"]+)", kind: "(fill|overlay)" \}/g)].map((m) => m[1]);
  if (ids.join(',') !== 'spray-flow,undertow,cosmos,sunset') throw new Error('EFFECT_STYLES is ' + JSON.stringify(ids));
  for (const key of [...source.matchAll(/\{ id: "[^"]+", titleKey: "([^"]+)", kind: "/g)].map((m) => m[1])) {
    const labels = [...source.matchAll(new RegExp('"' + key.replace('.', '\\.') + '":\\s*"([^"]*)"', 'g'))].map((m) => m[1]);
    if (labels.length !== 2) throw new Error(key + ' has ' + labels.length + ' labels, expected 2 (zh + en)');
  }
});

// 5. toggle off -> no seat claimed; toggle on -> claimed
check('seat is claimed only while advancedEffort is on', () => {
  const off = makeCtx({ settingsValue: { advancedEffort: false } });
  loadModule().apply(off.ctx);
  if (seatOf(off.registrations)) throw new Error('seat claimed while the toggle is off');
  const on = makeCtx({ settingsValue: { advancedEffort: true, effortStyle: 'undertow' } });
  loadModule().apply(on.ctx);
  if (!seatOf(on.registrations)) throw new Error('seat not claimed while the toggle is on');
  const seat = seatOf(on.registrations);
  renderNode(seat.component(seat.options.inject('session-1')), 0);
});

// 6. settings document not ready yet -> rows render, nothing throws
check('rows render while the settings document is still loading', () => {
  const { ctx, registrations } = makeCtx({ settingsStatus: 'loading' });
  loadModule().apply(ctx);
  for (const reg of registrations) {
    const injected = typeof reg.options.inject === 'function' ? reg.options.inject('session-1') : {};
    renderNode(reg.component({ ...injected }), 0);
  }
});

// 8. The HOST half must satisfy the 0.1.7-rc.1 loader contract, which changed
// under it: a plugin now owns settings by EXPORTING a schemastery `Config`
// (the loader reads `fiber.runtime.Config` and the settings service derives its
// writable form from it), and `ctx.settings.register(ns, Config)` — the old
// mechanism this file used — no longer exists. Three things must hold, and all
// three are silent failures when they break:
//
//   * the module still exports `Config` and `apply`;
//   * `inject` is GONE, because this half no longer talks to the settings
//     service — and an `inject` naming a service nobody provides is precisely
//     what leaves a fiber stuck at "pending" on this upgrade;
//   * every field is `.volatile()`, because `volatileForm(schema)` returns
//     undefined for a schema with no volatile field and `settings.write()` then
//     refuses the whole namespace ("has no volatile fields") — the card would
//     render and never save.
check('the host half exports a volatile Config and needs no settings service', () => {
  if (!/export\s*\{[^}]*\bConfig\b[^}]*\}/.test(hostSource)) {
    throw new Error('lib/index.js no longer exports Config, so the Host would serve no settings form');
  }
  if (!/export\s*\{[^}]*\bapply\b[^}]*\}/.test(hostSource)) {
    throw new Error('lib/index.js no longer exports apply');
  }
  // A DECLARATION, not the word: the explanatory comments mention `inject` on
  // purpose, so match the export/const forms the loader actually reads.
  if (/^\s*(export\s+)?(const|let|var)\s+inject\s*=/m.test(hostSource) || /export\s*\{[^}]*\binject\b[^}]*\}/.test(hostSource)) {
    throw new Error('lib/index.js declares `inject` again — nothing here consumes a service, and a missing one stalls activation');
  }
  // The seven preferences the card edits, plus the two telemetry keys the
  // browser half writes; each must be volatile or the write is refused. The
  // match is anchored to a DECLARATION at the start of a line (`  field: z.…`),
  // because the explanatory comments above name these fields in prose — and a
  // capture that ran to the first comma or newline could otherwise borrow the
  // `.volatile()` of the next field, which is how this check once passed a
  // mutation that had dropped one.
  const fields = ['advancedEffort', 'effortStyle', 'trackShape', 'collapseProviders',
    'glassPanel', 'glassOpacity', 'glassBlur', 'diag', 'lastSeatError'];
  for (const field of fields) {
    const decl = new RegExp('^\\s{2}' + field + '\\s*:\\s*([^,\\n]*)', 'm');
    const m = decl.exec(hostSource);
    if (!m) throw new Error('host field `' + field + '` is not declared at all');
    if (m[1].indexOf('.volatile()') === -1) {
      throw new Error('host field `' + field + '` is not declared `.volatile()`: ' + m[1].trim());
    }
  }
  // The telemetry keys must not materialise a default: a default is what the
  // settings document would then carry for every profile that never crashed.
  for (const field of ['diag', 'lastSeatError']) {
    const decl = new RegExp('^\\s{2}' + field + '\\s*:\\s*([^,\\n]*)', 'm');
    const m = decl.exec(hostSource);
    if (!m || m[1].indexOf('.default(undefined)') === -1) {
      throw new Error('host field `' + field + '` carries a default, so every profile would gain it: '
        + (m ? m[1].trim() : 'not found'));
    }
  }
  // `settingsNamespace` was removed from @deepseek-ai/dsh-settings in
  // 0.1.7-rc.1; importing it again would fail at module load. Again: a real
  // import statement, not the mention in the comments above.
  if (/^\s*import[\s\S]*?\bsettingsNamespace\b[\s\S]*?from\s+['"]/m.test(hostSource)) {
    throw new Error('lib/index.js still imports settingsNamespace, which no longer exists');
  }
});

// 9. The declared peers must ADMIT every runtime this plugin ships against, and
// the check has to test the rule the LOADER applies rather than a substring.
// 0.2.0-rc.1 made that rule load-bearing: `dsh-app-boot` evaluates every
// `@deepseek-ai/dsh*` peer against the running version
// (`evaluatePluginCompatibility`: semver with `includePrerelease`) and SKIPS THE
// WHOLE BUNDLE when one range misses. Nothing partial survives: the row never
// enters the composition, the settings card and the composer seat are simply
// absent, and the only trace is one stderr line at boot that a desktop launch
// throws away. That is exactly how 0.2.0-rc.1 switched this plugin off — every
// peer stopped at `^0.1.7-rc.1`, whose caret ceiling is 0.2.0, so the new
// prerelease satisfied none of them.
//
// The caret model below is the one that era needs: for 0.x, `^0.1.7-rc.1` means
// `>=0.1.7-rc.1 <0.2.0`, so an alternative admits a runtime only when MAJOR and
// MINOR match. The two sanity assertions at the top keep the model honest by
// encoding the failure this check exists to catch.
check('the declared peers admit every supported DSH runtime', () => {
  const SUPPORTED_RUNTIMES = ['0.1.1-rc.2', '0.1.5-rc.1', '0.1.7-rc.1', '0.2.0-rc.1'];
  const CURRENT_RUNTIME = '0.2.0-rc.1';
  const caretAdmits = (range, version) => {
    const parts = String(version).split('.');
    return String(range).split('||').some((alt) => {
      const m = /^\s*\^(\d+)\.(\d+)\./.exec(alt);
      return m !== null && m[1] === parts[0] && m[2] === parts[1];
    });
  };
  // Self-validation, both directions: the pre-0.2 union must NOT admit the new
  // prerelease (that skip is the bug), and a caret on the new line must admit it.
  if (caretAdmits('^0.1.1-rc.2 || ^0.1.5-rc.1 || ^0.1.7-rc.1', CURRENT_RUNTIME)) {
    throw new Error('the caret model is wrong: the pre-0.2 peer union must not admit ' + CURRENT_RUNTIME);
  }
  if (!caretAdmits('^' + CURRENT_RUNTIME, CURRENT_RUNTIME)) {
    throw new Error('the caret model is wrong: ^' + CURRENT_RUNTIME + ' must admit itself');
  }
  // The same predicate the loader uses to decide whether a name is a dsh peer at
  // all (`@deepseek-ai/dsh` and `@deepseek-ai/dsh-*`; schemastery and React are
  // deliberately outside it).
  const isDshPeer = (name) => name === '@deepseek-ai/dsh' || name.startsWith('@deepseek-ai/dsh-');
  const peers = pkg.peerDependencies || {};
  let checked = 0;
  for (const [name, range] of Object.entries(peers)) {
    if (!isDshPeer(name)) continue;
    checked += 1;
    for (const runtime of SUPPORTED_RUNTIMES) {
      if (!caretAdmits(range, runtime)) {
        throw new Error(name + ' peer range drops ' + runtime + ': ' + range
          + (runtime === CURRENT_RUNTIME ? ' — dsh-app-boot skips the whole bundle for this, silently' : ''));
      }
    }
  }
  if (checked < 6) throw new Error('only ' + checked + ' dsh peer ranges were checked; the manifest lost one');
  // `engines.dsh` is where 0.2.0-rc.1 documents the same declaration, and the two
  // must not be able to drift apart.
  const enginesDsh = pkg.engines && pkg.engines.dsh;
  if (typeof enginesDsh !== 'string') throw new Error('engines.dsh is not declared');
  for (const runtime of SUPPORTED_RUNTIMES) {
    if (!caretAdmits(enginesDsh, runtime)) throw new Error('engines.dsh drops ' + runtime + ': ' + enginesDsh);
  }
  if (peers['@deepseek-ai/dsh-client-ui-slots'] !== enginesDsh) {
    throw new Error('engines.dsh and the peer union disagree: ' + enginesDsh + ' vs ' + peers['@deepseek-ai/dsh-client-ui-slots']);
  }
  if (!pkg.dsh || pkg.dsh.manifestVersion !== 1) {
    throw new Error('dsh.manifestVersion is not the declared format 1');
  }
  const zRange = peers['@deepseek-ai/schemastery'];
  if (!zRange) throw new Error('schemastery peer dependency is missing');
  // `^3.18.1` accepts 3.18.1/3.18.2, which have no `.volatile()`.
  const min = /^\^(\d+)\.(\d+)\.(\d+)/.exec(zRange);
  if (!min) throw new Error('cannot read a lower bound out of the schemastery range: ' + zRange);
  const atLeast = (a, b, c) => (Number(min[1]) > a)
    || (Number(min[1]) === a && Number(min[2]) > b)
    || (Number(min[1]) === a && Number(min[2]) === b && Number(min[3]) >= c);
  if (!atLeast(3, 18, 3)) {
    throw new Error('schemastery peer range starts below 3.18.3, where `.volatile()` was added: ' + zRange);
  }
});

// 10. The settings document must never be written on a TIMER. The old `diag`
// telemetry flushed its buffer into the plugin's own settings on a 1.5s
// interval, and in 0.1.7-rc.1 that closed a loop the user could see:
//
//   settings write → the Host's describe() sees a new `entry.options.config`
//   → emit "settings/document-updated" → ui-model-selection's
//   `$on("settings/document-updated", () => catalog.refresh())` →
//   `catalog.load()` sets status "loading" → the model menu flashed
//   "正在刷新模型列表" every ~1930ms over a list that never changed.
//
// Measured live: `status=loading` → `status=ready` every ~1.93s with
// `models=39 fails=0`. So: no `setInterval`, and no timer that writes to the
// settings scope.
check('the settings document is never written on a timer', () => {
  if (/setInterval\s*\(/.test(source)) {
    throw new Error('the module schedules a repeating timer; a periodic settings write re-triggers the Host catalog reload');
  }
  // Any `scope.set(...)` must be reachable from a user gesture or a real event,
  // never from inside a setTimeout callback. Cheap and precise check: no
  // `scope.set` may appear between a `setTimeout(function () {` and its closing
  // brace within the same small window.
  const windows = source.split('setTimeout(');
  for (let i = 1; i < windows.length; i += 1) {
    const body = windows[i].slice(0, 700);
    if (/scope\.set\(|settingsScope\.set\(|\.mutate\(/.test(body)) {
      throw new Error('a setTimeout callback writes to the settings document, which re-triggers the catalog reload: '
        + body.slice(0, 120).replace(/\s+/g, ' '));
    }
  }
  // The telemetry itself must be gone, not merely quieted: its own comment said
  // "removed once the root cause is confirmed", and by the time it was removed
  // the 80-entry buffer held nothing but 78 copies of its own loop output.
  if (/\bDIAG_LIMIT\b/.test(source) || /diagState/.test(source)) {
    throw new Error('the diag telemetry buffer is back; it writes to the settings document on a timer');
  }
  if (/scope\.set\("diag"/.test(source)) {
    throw new Error('the diag telemetry still writes into the settings document');
  }
});

// 11. The loading banner is for an EMPTY menu, not for a refresh. A refresh
// flips `status` to "loading" while the PREVIOUS snapshot is still perfectly
// good (its `groups` stay populated), so keying the banner on status alone
// flashes it over a full list — the second half of the reported flicker.
check('the loading banner only shows while the menu has nothing to show', () => {
  const at = source.indexOf('const modelsMissing');
  if (at === -1) throw new Error('the modelsMissing gate is gone; the banner is keyed on status alone again');
  const decl = source.slice(at, at + 400);
  if (!/choices\.length === 0/.test(decl) || !/state\.current === null/.test(decl)) {
    throw new Error('modelsMissing no longer means "no rows AND no current model": ' + decl.split('\n')[0]);
  }
  // The banner and aria-busy must both go through the gate.
  const banner = /modelsMissing && state\.status === "loading"\s*\?\s*React\.createElement\("div", \{ className: "dms-status" \}/.exec(source);
  if (!banner) {
    throw new Error('the banner is no longer gated on modelsMissing, so a background refresh would flash it');
  }
  const busy = /"aria-busy":\s*\(modelsMissing && state\.status === "loading"\)\s*\|\|\s*busy/.exec(source);
  if (!busy) throw new Error('aria-busy is no longer gated with the banner');
  // And the behavioural check: with rows present, a "loading" status must render
  // the rows and NO status line.
  const made = makeCtx({
    groups: [{ id: 'g', name: 'G', models: [{ id: 'm', name: 'M', reasoning: { defaultEffort: 'high', efforts: [{ id: 'high', name: 'High' }] } }] }]
  });
  loadModule().apply(made.ctx);
  const seat = seatOf(made.registrations);
  const injected = seat.options.inject('session-1');
  hookState.length = 0;
  let tree = expand(seat.component({ ...injected }));
  const trigger = findAll(tree, (p) => p.className === 'dms-trigger')[0];
  trigger.props.onClick();
  // Render the menu while the store reports "loading" but still carries groups.
  made.ctx.modelDirectories && null;
  for (let i = 0; i < 4; i += 1) { runEffects(); resetHooks(); tree = expand(seat.component({ ...injected })); }
  const status = findAll(tree, (p) => p.className === 'dms-status');
  if (status.length !== 0) {
    throw new Error('a populated menu still rendered a status line: ' + status.length);
  }
});

// 12. Long-press drag reorder (ui: "长按一个模型后，可以拖动位置，然后排序").
// The pure helpers carry the logic, so they are pinned directly; the gesture
// itself is then driven through the real row handlers.
check('the drop-slot maths finds the row under the pointer', () => {
  const helpers = loadModule().__test;
  if (!helpers) throw new Error('the drag helpers are not exported for testing');
  const rects = [
    { top: 0, height: 34 },
    { top: 34, height: 34 },
    { top: 68, height: 34 }
  ];
  // Midpoints are 17, 51, 85. Before the first midpoint -> slot 0; between the
  // first and second -> 1; past the last -> rects.length (append at the end).
  const cases = [
    [-10, 0], [0, 0], [16, 0],
    [17, 1], [50, 1],
    [51, 2], [84, 2],
    [85, 3], [1000, 3]
  ];
  for (const [y, want] of cases) {
    const got = helpers.dmsDropIndexFromRects(rects, y);
    if (got !== want) throw new Error('pointer at y=' + y + ' mapped to slot ' + got + ', expected ' + want);
  }
  // Unmeasurable rows are SKIPPED, not treated as zero-height: a zero-height row
  // at the top would swallow every drop. The scan is in ARRAY order (the rows are
  // in DOM order in real use), so the fixture is ordered by position — putting
  // them out of order would test a shape the browser never produces.
  const holed = [null, { top: 0, height: 10 }, undefined, { top: 100, height: 20 }];
  // Usable: index1 (mid 5) and index3 (mid 110). Below 5 -> slot 1 (the first
  // MEASURABLE row, not slot 0 which is invisible); between them -> 3; past the
  // end -> the array length.
  if (helpers.dmsDropIndexFromRects(holed, 1) !== 1) {
    throw new Error('a hidden leading row was not skipped: got ' + helpers.dmsDropIndexFromRects(holed, 1));
  }
  if (helpers.dmsDropIndexFromRects(holed, 50) !== 3) {
    throw new Error('a hidden row was not skipped: got ' + helpers.dmsDropIndexFromRects(holed, 50));
  }
  if (helpers.dmsDropIndexFromRects(holed, 999) !== 4) {
    throw new Error('a hidden trailing row broke the append slot: got ' + helpers.dmsDropIndexFromRects(holed, 999));
  }
  // Degenerate inputs must not throw.
  if (helpers.dmsDropIndexFromRects([], 5) !== 0) throw new Error('an empty list produced a slot');
  if (helpers.dmsDropIndexFromRects([{ top: 0, height: 0 }], 5) !== 1) {
    throw new Error('a zero-height row was counted as a slot');
  }
  // A row box that is present but UNMEASURABLE (NaN/Infinity, or a negative
  // height) must be skipped like a missing one. Every comparison against NaN is
  // false, so without the guard the scan would run off the end and report the
  // append slot for a pointer that is nowhere near the end.
  const nan = [{ top: NaN, height: 34 }, { top: 10, height: 34 }, { top: Infinity, height: -4 }];
  if (helpers.dmsDropIndexFromRects(nan, 5) !== 1) {
    throw new Error('an unmeasurable row was counted: slot ' + helpers.dmsDropIndexFromRects(nan, 5));
  }
});

check('moving a row lands where the drop slot says', () => {
  const helpers = loadModule().__test;
  const mk = (keys) => keys.map((k) => ({ key: k }));
  const keysOf = (gs) => gs.map((g) => g.key).join(',');
  const list = mk(['a', 'b', 'c', 'd']);
  // Drag 'a' down to slot 2 (between b and c) -> b, a, c, d.
  if (keysOf(helpers.dmsMoveKey(list, 'a', 2)) !== 'b,a,c,d') {
    throw new Error('dragging down overshot: ' + keysOf(helpers.dmsMoveKey(list, 'a', 2)));
  }
  // Drag 'd' up to slot 1 (between a and b) -> a, d, b, c.
  if (keysOf(helpers.dmsMoveKey(list, 'd', 1)) !== 'a,d,b,c') {
    throw new Error('dragging up landed wrong: ' + keysOf(helpers.dmsMoveKey(list, 'd', 1)));
  }
  // The off-by-one: dropping at slot 2 must move DOWN by exactly one, not stay
  // put. This is the case that a naive splice-without-adjust gets wrong.
  if (keysOf(helpers.dmsMoveKey(list, 'a', 1)) !== 'a,b,c,d') {
    throw new Error('a one-slot drop must be a no-op here: ' + keysOf(helpers.dmsMoveKey(list, 'a', 1)));
  }
  if (keysOf(helpers.dmsMoveKey(list, 'a', 0)) !== 'a,b,c,d') {
    throw new Error('dropping at slot 0 left the row somewhere else');
  }
  // Past either end clamps rather than truncating.
  if (keysOf(helpers.dmsMoveKey(list, 'a', 99)) !== 'b,c,d,a') {
    throw new Error('dropping past the end must append: ' + keysOf(helpers.dmsMoveKey(list, 'a', 99)));
  }
  if (keysOf(helpers.dmsMoveKey(list, 'd', -5)) !== 'd,a,b,c') {
    throw new Error('dropping before the start must prepend: ' + keysOf(helpers.dmsMoveKey(list, 'd', -5)));
  }
  // An unknown key is returned unchanged, and the INPUT is never mutated.
  if (keysOf(helpers.dmsMoveKey(list, 'zz', 1)) !== 'a,b,c,d') throw new Error('an unknown key moved something');
  if (keysOf(list) !== 'a,b,c,d') throw new Error('dmsMoveKey mutated its input array');
});

check('the saved order sorts the list and keeps unlisted names in place', () => {
  const helpers = loadModule().__test;
  const mk = (keys) => keys.map((k) => ({ key: k }));
  const keysOf = (gs) => gs.map((g) => g.key).join(',');
  // No saved order -> untouched, and the SAME array is returned (no pointless
  // copy on the common path).
  const dir = mk(['a', 'b', 'c']);
  if (helpers.dmsApplyRowOrder(dir) !== dir) throw new Error('an empty saved order copied the list anyway');
  // A saved order puts the named rows first, in saved order.
  helpers.dmsOrderSave(['c', 'a']);
  const sorted = helpers.dmsApplyRowOrder(mk(['a', 'b', 'c']));
  if (keysOf(sorted) !== 'c,a,b') {
    throw new Error('the saved order was not applied: ' + keysOf(sorted));
  }
  // Names NOT in the saved order keep the directory's own RELATIVE order (this is
  // what a stable sort buys) and sort after every named one.
  helpers.dmsOrderSave(['d']);
  const partial = helpers.dmsApplyRowOrder(mk(['a', 'b', 'c', 'd', 'e']));
  if (keysOf(partial) !== 'd,a,b,c,e') {
    throw new Error('unlisted names did not keep their directory order: ' + keysOf(partial));
  }
  // A saved order naming rows that no longer exist must not break the sort.
  helpers.dmsOrderSave(['gone', 'also-gone', 'b']);
  const stale = helpers.dmsApplyRowOrder(mk(['a', 'b', 'c']));
  if (keysOf(stale) !== 'b,a,c') {
    throw new Error('a stale saved order broke the sort: ' + keysOf(stale));
  }
  // The comparator must be TOTAL: two unlisted names compare equal (0), which is
  // what makes the sort stable and their directory order survive. The fixture
  // uses names of DIFFERENT lengths on purpose — with equal-length keys a broken
  // comparator like `a.key.length - b.key.length` would be a no-op and this check
  // would pass while the order was engine-dependent.
  helpers.dmsOrderSave(['zzzzz']);
  const cmpList = helpers.dmsApplyRowOrder(mk(['qq', 'aaaa', 'mmm']));
  if (keysOf(cmpList) !== 'qq,aaaa,mmm') {
    throw new Error('the unlisted comparator is not stable (expected the directory order back): ' + keysOf(cmpList));
  }
});

// Renders a shift array for assertion messages. Declared here, before both
// reorder-geometry checks below, because a `const` is not hoisted.
const dmsShiftStr = (arr) => arr.join(',');

check('the displaced rows flow out of the way and back', () => {
  const helpers = loadModule().__test;
  if (!helpers.dmsRowShifts) throw new Error('the row-shift helper is not exported for testing');
  const shift = helpers.dmsRowShifts;
  const show = dmsShiftStr;
  const H = [34, 34, 34, 34];   // four rows, uniform height

  // Dragging row 0 DOWN past row 1 (slot 2): rows 1..1 step UP by one row.
  if (show(shift(H, 0, 2)) !== '0,-34,0,0') {
    throw new Error('dragging down one slot: ' + show(shift(H, 0, 2)));
  }
  // Dragging row 0 to the END (slot 4): rows 1..3 all step up.
  if (show(shift(H, 0, 4)) !== '0,-34,-34,-34') {
    throw new Error('dragging down to the end: ' + show(shift(H, 0, 4)));
  }
  // Dragging row 3 UP to the top (slot 0): rows 0..2 all step down.
  if (show(shift(H, 3, 0)) !== '34,34,34,0') {
    throw new Error('dragging up to the top: ' + show(shift(H, 3, 0)));
  }
  // Dragging row 2 UP one place (slot 1): only row 1 steps down.
  if (show(shift(H, 2, 1)) !== '0,34,0,0') {
    throw new Error('dragging up one slot: ' + show(shift(H, 2, 1)));
  }
  // The two "no movement" slots: the row's own slot and the one right after it.
  // Both describe the resting order, so NOTHING may move. A drag that returns to
  // where it started therefore leaves no trace.
  if (show(shift(H, 1, 1)) !== '0,0,0,0') throw new Error('slot == from moved something: ' + show(shift(H, 1, 1)));
  if (show(shift(H, 1, 2)) !== '0,0,0,0') throw new Error('slot == from+1 moved something: ' + show(shift(H, 1, 2)));
  // The dragged row's own entry is always 0: it is carried by the pointer, not by
  // this function. A non-zero value here would double-apply its motion.
  for (const to of [0, 1, 2, 3, 4]) {
    if (shift(H, 2, to)[2] !== 0) throw new Error('the dragged row was shifted by the helper at slot ' + to);
  }
  // Non-uniform heights: the shift is the DRAGGED row's height (that is what
  // leaves and what must be made room for), not each neighbour's own.
  if (show(shift([50, 30, 30, 30], 0, 3)) !== '0,-50,-50,0') {
    throw new Error('non-uniform heights used the wrong reference: ' + show(shift([50, 30, 30, 30], 0, 3)));
  }
  // Degenerate input must not throw or move anything.
  if (show(shift([], 0, 0)) !== '') throw new Error('an empty list produced shifts');
  if (show(shift(H, -1, 2)) !== '0,0,0,0') throw new Error('an out-of-range index moved rows');
  if (show(shift(H, 9, 2)) !== '0,0,0,0') throw new Error('an out-of-range index moved rows');
  // Out-of-range slots clamp instead of producing undefined gaps.
  if (show(shift(H, 0, 99)) !== '0,-34,-34,-34') throw new Error('a huge slot did not clamp: ' + show(shift(H, 0, 99)));
  if (show(shift(H, 3, -5)) !== '34,34,34,0') throw new Error('a negative slot did not clamp: ' + show(shift(H, 3, -5)));
  // A row with no measurable height cannot define a gap, so nothing moves — the
  // alternative (a NaN or Infinity shift) would blank the list.
  if (show(shift([0, 34, 34], 0, 2)) !== '0,0,0') {
    throw new Error('a zero-height dragged row produced a shift: ' + show(shift([0, 34, 34], 0, 2)));
  }
});

check('the landing offset puts the lifted row over its slot', () => {
  const helpers = loadModule().__test;
  const shift = helpers.dmsRowShifts;
  const show = dmsShiftStr;
  const H = [34, 34, 34, 34];
  // Non-uniform heights: a displaced neighbour must move by the DRAGGED row's
  // height, because that is the amount of space the removal freed and the
  // insertion needs back. Using each neighbour's own height would leave the rows
  // overlapping (or gapped) whenever the list is not perfectly uniform — which in
  // a real list it never is, because a row with a description line is taller.
  const mixed = [50, 20, 20, 30];
  if (show(shift(mixed, 0, 2)) !== '0,-50,0,0') {
    throw new Error('a displaced row used its own height: ' + show(shift(mixed, 0, 2)));
  }
  // Row 3 (height 30) dragged UP to slot 1: rows 1 and 2 slide DOWN by 30.
  if (show(shift(mixed, 3, 1)) !== '0,30,30,0') {
    throw new Error('dragging a tall row up used the wrong height: ' + show(shift(mixed, 3, 1)));
  }
  // The invariant that makes the landing seamless: the dragged row's travel must
  // equal the distance its neighbours moved, with the OPPOSITE sign, times the
  // number of rows it crossed. Stated as a property so the formula in the
  // component and the one here cannot drift apart.
  for (const from of [0, 1, 2, 3]) {
    for (let slot = 0; slot <= 4; slot++) {
      const target = slot > from ? slot - 1 : slot;
      if (target === from) continue;
      const landing = (target - from) * H[from];
      const moved = shift(H, from, slot).filter((v) => v !== 0);
      // Every displaced row moved by exactly one row height…
      for (const v of moved) {
        if (Math.abs(Math.abs(v) - H[from]) > 0.001) {
          throw new Error('a displaced row moved by ' + v + ', expected one row height (' + H[from] + ')');
        }
      }
      // …in the direction OPPOSITE to the dragged row's own travel.
      const neighbourSign = moved.length ? Math.sign(moved[0]) : 0;
      if (neighbourSign !== 0 && Math.sign(landing) !== -neighbourSign) {
        throw new Error('from=' + from + ' slot=' + slot + ': the dragged row travels ' + landing
          + ' but its neighbours shift ' + neighbourSign);
      }
      // …and there are exactly as many of them as the row crossed.
      if (moved.length !== Math.abs(target - from)) {
        throw new Error('from=' + from + ' slot=' + slot + ': ' + moved.length
          + ' rows displaced, expected ' + Math.abs(target - from));
      }
      // The dragged row itself is NEVER displaced by this helper: it is carried
      // by the pointer, and shifting it here as well would move it twice.
      const dragShift = shift(H, from, slot)[from];
      if (dragShift !== 0) {
        throw new Error('the dragged row was shifted too (it would move twice): ' + dragShift);
      }
    }
  }
});

// 12a'. Edge auto-scroll: holding a dragged row near the top or bottom edge of
// the list scrolls the list by itself, faster the deeper into the zone.
check('the list auto-scrolls when the dragged row nears an edge', () => {
  const helpers = loadModule().__test;
  if (!helpers.dmsAutoScrollStep) throw new Error('the auto-scroll helper is not exported for testing');
  const step = helpers.dmsAutoScrollStep;
  const TOP = 100, BOTTOM = 400, ZONE = 30, MAX = 10;

  // Outside both zones: no scroll at all. This is the common case and must stay
  // a strict zero — any drift here would scroll the list during ordinary drags.
  for (const y of [131, 200, 300, 369]) {
    if (step(y, TOP, BOTTOM, ZONE, MAX) !== 0) {
      throw new Error('y=' + y + ' is outside both zones but scrolled: ' + step(y, TOP, BOTTOM, ZONE, MAX));
    }
  }
  // The zone boundaries are EXCLUSIVE: exactly at the inner edge there is nothing
  // to do, and one pixel inside it starts to move.
  if (step(TOP + ZONE, TOP, BOTTOM, ZONE, MAX) !== 0) {
    throw new Error('the top zone started at its own boundary');
  }
  if (step(TOP + ZONE - 1, TOP, BOTTOM, ZONE, MAX) !== -1) {
    throw new Error('one pixel inside the top zone did not scroll: ' + step(TOP + ZONE - 1, TOP, BOTTOM, ZONE, MAX));
  }
  if (step(BOTTOM - ZONE, TOP, BOTTOM, ZONE, MAX) !== 0) {
    throw new Error('the bottom zone started at its own boundary');
  }
  if (step(BOTTOM - ZONE + 1, TOP, BOTTOM, ZONE, MAX) !== 1) {
    throw new Error('one pixel inside the bottom zone did not scroll: ' + step(BOTTOM - ZONE + 1, TOP, BOTTOM, ZONE, MAX));
  }
  // The ramp: speed grows with depth into the zone, and reaches MAX at the edge.
  const nearEdge = step(BOTTOM - 1, TOP, BOTTOM, ZONE, MAX);
  const midZone = step(BOTTOM - ZONE / 2, TOP, BOTTOM, ZONE, MAX);
  const atEdge = step(BOTTOM, TOP, BOTTOM, ZONE, MAX);
  if (!(nearEdge > midZone && midZone > 0)) {
    throw new Error('the bottom ramp is not monotonic: edge=' + nearEdge + ' mid=' + midZone);
  }
  if (atEdge !== MAX) throw new Error('the bottom edge is not at full speed: ' + atEdge);
  // SIGN is what makes it work at all: up is negative, down is positive.
  if (step(TOP, TOP, BOTTOM, ZONE, MAX) !== -MAX) {
    throw new Error('the top edge is not at full upward speed: ' + step(TOP, TOP, BOTTOM, ZONE, MAX));
  }
  // Past the edge entirely — which happens constantly, because the pointer is free
  // to leave the box — the speed is CLAMPED, not extrapolated. Unclamped, a
  // pointer 300px above the list would scroll it 100x too fast.
  if (step(TOP - 300, TOP, BOTTOM, ZONE, MAX) !== -MAX) {
    throw new Error('above the box the speed is not clamped: ' + step(TOP - 300, TOP, BOTTOM, ZONE, MAX));
  }
  if (step(BOTTOM + 300, TOP, BOTTOM, ZONE, MAX) !== MAX) {
    throw new Error('below the box the speed is not clamped: ' + step(BOTTOM + 300, TOP, BOTTOM, ZONE, MAX));
  }
  // A box shorter than two zones puts the pointer in BOTH; the result must still
  // be a real direction rather than a sum or a crash.
  const tiny = step(10, 0, 20, ZONE, MAX);
  if (tiny !== -MAX && tiny !== MAX) throw new Error('overlapping zones produced ' + tiny);
  // Degenerate inputs must be inert: no measurements means no scrolling, never a
  // NaN written to `scrollTop` (which would silently do nothing, or throw).
  for (const bad of [[NaN, TOP, BOTTOM], [TOP, NaN, BOTTOM], [TOP, TOP, NaN], [Infinity, TOP, BOTTOM]]) {
    const args = bad.length === 4 ? bad : [bad[0], bad[1], bad[2], ZONE, MAX];
    const r = step(args[0], args[1], args[2], ZONE, MAX);
    if (r !== 0) throw new Error('degenerate input ' + JSON.stringify(bad) + ' produced ' + r);
  }
  if (step(200, TOP, BOTTOM, 0, MAX) !== 0) throw new Error('a zero zone scrolled anyway');
  if (step(200, BOTTOM, TOP, ZONE, MAX) !== 0) throw new Error('an inverted box scrolled anyway');
  // Integer output: a fractional scrollTop is legal but makes the slot arithmetic
  // harder to reason about, and the callers assume whole pixels.
  for (const y of [TOP, TOP + 7, BOTTOM - 3, BOTTOM]) {
    const r = step(y, TOP, BOTTOM, ZONE, MAX);
    if (!Number.isInteger(r)) throw new Error('a fractional step came out of y=' + y + ': ' + r);
  }
});

check('auto-scroll is wired into the drag, and compensated everywhere', () => {
  // The loop must be SELF-SUSTAINING: a `pointermove`-driven implementation stops
  // as soon as the pointer is held still against the edge, which is the exact
  // gesture this feature exists for. The re-arm must live INSIDE the tick's own
  // body — an arm in `dmsStartAutoScroll` alone starts the loop once but never
  // keeps it running, and a regex over the whole file cannot tell the two apart.
  const tickBody = /const dmsAutoScrollTick = function \(st\) \{([\s\S]*?)\n\t\t\t\};/.exec(source);
  if (!tickBody || tickBody[1].indexOf('st.scrollFrame = dmsNextFrame(') === -1) {
    throw new Error('the auto-scroll loop does not re-arm itself inside the tick, so holding the row at the edge would stop scrolling');
  }
  // It must be stopped on every exit, or a cancelled drag keeps scrolling a list
  // nobody is holding.
  const cancelBody = /const dmsDragCancel = function \(\) \{([\s\S]*?)\n\t\t\t\};/.exec(source);
  if (!cancelBody || cancelBody[1].indexOf('dmsStopAutoScroll(st)') === -1) {
    throw new Error('dmsDragCancel no longer stops the auto-scroll loop');
  }
  // The landing must be skipped while settling: a tick during the drop animation
  // would move the list out from under a row that is already on its way.
  if (!/if \(dragRef\.current !== st \|\| !st\.started \|\| st\.settling\) return;/.test(source)) {
    throw new Error('the auto-scroll loop does not stop during the landing animation');
  }
  // The scroll box must actually be wired: without the ref, `scrollTop` has no
  // element to move and the feature is a silent no-op.
  if (!/className: "dms-groups", ref: listBoxRef/.test(source)) {
    throw new Error('the level-1 scroll container is not wired to listBoxRef, so auto-scroll can do nothing');
  }
  if (!/scrollTop = before \+ step/.test(source)) {
    throw new Error('the auto-scroll tick no longer writes scrollTop');
  }
  // READ BACK the clamped value. The box clamps at both ends, and a delta it did
  // not actually take would offset the drop slot away from the pointer.
  if (!/st\.scrollDelta = box\.scrollTop - st\.startScrollTop/.test(source)) {
    throw new Error('the actual scrolled distance is not read back, so a clamped scroll would misplace the drop slot');
  }
  // THE pointer-following compensation. Three places consume the row offset as
  // "pointer travel plus whatever the list scrolled" and all three must use the
  // SAME expression, so a version missing the scroll term cannot hide in one of
  // them. Two further writes are deliberately EXEMPT: `= 0` (gesture start) and
  // `= landing` (the settle target), which are anchored to LAYOUT, not the
  // pointer, and cancel the scroll term by construction.
  const followExpr = 'st.offsetY = st.pointerY - st.startY + (st.scrollDelta || 0);';
  const followCount = source.split(followExpr).length - 1;
  if (followCount !== 3) {
    throw new Error('the pointer-following offsetY expression appears ' + followCount
      + ' times, expected exactly 3 (move frame, auto-scroll tick, release)');
  }
  const allOffsetWrites = (source.match(/st\.offsetY = [^;]+;/g) || []);
  if (allOffsetWrites.length !== 5) {
    throw new Error('expected 3 pointer-following writes plus 2 layout-anchored ones (start, landing); found ' + allOffsetWrites.length);
  }
  // And the drop slot must measure against the scrolled frame, or it drifts by
  // exactly the scrolled distance.
  if (!/rects\.push\(\{ top: st\.tops\[i\] - shift, height: st\.heights\[i\] \}\)/.test(source)) {
    throw new Error('the drop slot is not compensated for scrolling, so it would drift as the list auto-scrolls');
  }
});


// 12b. The gesture itself: a long press lifts the row and a drop reorders it,
// while a press that wanders past the slop stays a scroll.
check('the drag gesture disarms on scroll, and commits after a long press', () => {
  // The gesture is driven through the REAL row handlers, with the hold timer
  // captured instead of slept through. The capture has to happen INSIDE the
  // harness rather than by swapping the test's own `global.setTimeout`: the
  // sandbox snapshots `setTimeout` by VALUE when `loadModule()` builds it, so a
  // swap made afterwards would never reach the module. `runHold` therefore fires
  // only the module's own pending timers.
  const pending = [];
  let now = 0;
  const fakeTimers = (fn, ms) => { const id = pending.length + 1; pending.push({ id, fn, ms, at: now + (ms || 0) }); return id; };
  const fakeClear = (id) => { for (let i = 0; i < pending.length; i++) if (pending[i] !== null && pending[i].id === id) pending[i] = null; };
  const runHold = () => {
    // Fire ONLY the drag hold, selected by its own delay. Picking "the longest
    // pending timer" was wrong: mount() also schedules the 400ms/1500ms seat
    // rechecks, so the longest is the recheck — which then ran INSTEAD of the
    // hold and left the gesture un-started (the drop silently did nothing).
    // The delay is read from the source so this cannot drift from the constant.
    const holdMs = Number(/DMS_DRAG_HOLD_MS = (\d+)/.exec(source)[1]);
    let pick = null;
    for (const t of pending) if (t !== null && t.ms === holdMs) { pick = t; break; }
    if (pick === null) throw new Error('the long-press hold timer was never scheduled at ' + holdMs + 'ms');
    fakeClear(pick.id);
    now = pick.at;
    pick.fn();
  };
  /** Fire every pending timer, as the passage of time would. */
  const runAllTimers = () => {
    const due = pending.filter((t) => t !== null);
    for (const t of due) { fakeClear(t.id); now = t.at; t.fn(); }
  };
  /**
   * Fire the trailing settle timer, if one is pending.
   *
   * The redesigned drag does not commit on pointerup: it first ANIMATES the
   * lifted row into its slot (a CSS transition) and commits when that animation
   * is done, so the drop is only persisted after the settle timer fires. The
   * delay is read from the source so the test follows the constant.
   */
  const runSettle = () => {
    const settleMs = Number(/DMS_DRAG_SETTLE_MS = (\d+)/.exec(source)[1]);
    let pick = null;
    for (const t of pending) if (t !== null && t.ms === settleMs) { pick = t; break; }
    if (pick === null) throw new Error('no settle timer was scheduled at ' + settleMs + 'ms');
    fakeClear(pick.id);
    now = pick.at;
    pick.fn();
  };

  const store = {
    data: {},
    getItem(k) { return Object.prototype.hasOwnProperty.call(this.data, k) ? this.data[k] : null; },
    setItem(k, v) { this.data[k] = String(v); },
    removeItem(k) { delete this.data[k]; }
  };
  const ORDER_KEY = 'dsh-modef.row-order.v1';
  let tree = null;
  let rows = null;
  // The most recent mount, so a check can assert against the SAME instance the
  // gesture ran on (see the swallow-latch test below).
  let mountRef = null;
  const mount = () => {
    const made = makeCtx({
      effort: 'high',
      groups: [
        { id: 'pa', name: 'PA', models: [{ id: 'ma', name: 'Alpha', reasoning: { defaultEffort: 'high', efforts: [{ id: 'high', name: 'High' }] } }] },
        { id: 'pb', name: 'PB', models: [{ id: 'mb', name: 'Beta', reasoning: { defaultEffort: 'high', efforts: [{ id: 'high', name: 'High' }] } }] },
        { id: 'pc', name: 'PC', models: [{ id: 'mc', name: 'Gamma', reasoning: { defaultEffort: 'high', efforts: [{ id: 'high', name: 'High' }] } }] }
      ],
      settingsValue: { advancedEffort: true, effortStyle: 'spray-flow', trackShape: 'capsule' }
    });
    loadModule({ window: { localStorage: store }, timers: { setTimeout: fakeTimers, clearTimeout: fakeClear } }).apply(made.ctx);
    const seat = seatOf(made.registrations);
    const injected = seat.options.inject('session-1');
    hookState.length = 0;
    let t = expand(seat.component({ ...injected }));
    const trig = findAll(t, (p) => p.className === 'dms-trigger')[0];
    trig.props.onClick();
    for (let i = 0; i < 4; i += 1) { runEffects(); resetHooks(); t = expand(seat.component({ ...injected })); }
    tree = t;
    rows = findAll(t, (p) => typeof p.className === 'string' && p.className.split(' ').indexOf('dms-option') !== -1);
    // The harness does not run React, so REF CALLBACKS never fire on their own.
    // The drag measures the rows through exactly those refs, so the test has to
    // register them the way React would — otherwise the row list stays empty and
    // every drop collapses to a no-op at slot 0. Each node reports the position
    // it occupies in the list, which is what the real layout provides.
    for (let i = 0; i < rows.length; i += 1) {
      if (typeof rows[i].props.ref === 'function') rows[i].props.ref(fakeRowNode(i * 34));
    }
    mountRef = { made, injected, seat, tree: t, rows };
    return mountRef;
  };
  /** Re-render a mount and refresh its rows, so classes reflect current state. */
  const settleTree = (info) => {
    let t = info.tree;
    for (let i = 0; i < 4; i += 1) { runEffects(); resetHooks(); t = expand(info.seat.component({ ...info.injected })); }
    info.tree = t;
    info.rows = findAll(t, (p) => typeof p.className === 'string' && p.className.split(' ').indexOf('dms-option') !== -1);
    for (let i = 0; i < info.rows.length; i += 1) {
      if (typeof info.rows[i].props.ref === 'function') info.rows[i].props.ref(fakeRowNode(i * 34));
    }
    if (info === mountRef) rows = info.rows;
    return info.rows;
  };
  /** The className of row `i` in a settled tree. */
  const rowClassAt = (info, i) => {
    const rs = info === mountRef ? rows : info.rows;
    return String((rs[i] && rs[i].props.className) || '');
  };
  const names = () => rows.map((r) => r.props.title).join(',');

  // --- a press that moves past the slop is a SCROLL, not a drag -----------
  mount();
  if (names() !== 'Alpha,Beta,Gamma') throw new Error('the fixture order changed: ' + names());
  rows[0].props.onPointerDown({ clientY: 100, pointerId: 1, currentTarget: fakeRowNode() });
  rows[0].props.onPointerMove({ clientY: 130, preventDefault() {} });
  rows[0].props.onPointerUp({ clientY: 130 });
  if (Object.prototype.hasOwnProperty.call(store.data, ORDER_KEY)) {
    throw new Error('a scroll saved an order: ' + store.data[ORDER_KEY]);
  }
  if (names() !== 'Alpha,Beta,Gamma') throw new Error('a scroll reordered the list: ' + names());

  // --- the slop must cancel the ARMED gesture, not merely fail to commit ----
  // The previous case cannot tell those apart: with the gesture never started,
  // the pointerup cancels it anyway. This one moves past the slop and THEN lets
  // the timer fire — if the timer had been cleared the row would never enter its
  // dragging class, and if it had NOT been cleared the row would be left marked.
  // The assertion therefore reads the class AFTER a re-render, because the class
  // is produced by render, not by the handler.
  pending.length = 0;
  const slopMount = mount();
  rows[0].props.onPointerDown({ clientY: 100, pointerId: 7, currentTarget: fakeRowNode() });
  rows[0].props.onPointerMove({ clientY: 109, preventDefault() {} });   // 9px > the 8px slop
  runAllTimers();
  settleTree(slopMount);
  if (rowClassAt(slopMount, 0).indexOf('dms-optionDragging') !== -1) {
    throw new Error('a pointer that moved past the slop still armed the drag');
  }
  if (rowClassAt(slopMount, 0).indexOf('dms-optionArmed') !== -1) {
    throw new Error('the row was left marked as armed after the gesture was cancelled');
  }

  // --- a secondary button must not arm a drag ------------------------------
  pending.length = 0;
  const btnMount = mount();
  rows[0].props.onPointerDown({ clientY: 100, pointerId: 8, button: 2, currentTarget: fakeRowNode() });
  runAllTimers();
  settleTree(btnMount);
  if (rowClassAt(btnMount, 0).indexOf('dms-optionDragging') !== -1) {
    throw new Error('a right-click armed the drag');
  }
  if (Object.prototype.hasOwnProperty.call(store.data, ORDER_KEY)) {
    throw new Error('a right-click drag persisted an order');
  }

  // --- a long press then a drop reorders and persists ---------------------
  // The pointer must also MOVE before release: the row's travel is derived from
  // the pointer, so a hold-and-release with no movement is a no-op by design.
  // The move goes through the rAF-coalescing path, so the captured frame is
  // flushed the way the harness does it for the slider.
  pending.length = 0;
  mount();
  // Re-register the refs with CAPTURED fake nodes: in a real browser the row's
  // `currentTarget` and its ref-registered element are the SAME node, and the
  // settle block classifies the ref node — the assertions below need a handle
  // on exactly the element the module touched.
  const rowNodes = [];
  for (let i = 0; i < rows.length; i += 1) {
    rowNodes[i] = fakeRowNode(i * 34);
    if (typeof rows[i].props.ref === 'function') rows[i].props.ref(rowNodes[i]);
  }
  rows[0].props.onPointerDown({ clientY: 100, pointerId: 2, currentTarget: rowNodes[0] });
  runHold();   // the hold elapses with the pointer still
  // Drag down past the midpoint of the LAST row -> append at the end.
  // The move's rAF frame is deliberately left PENDING across the release and
  // flushed after it: that is exactly the race the settling guard exists for,
  // and the no-scale assertion below is what catches the guard breaking.
  rows[0].props.onPointerMove({ clientY: 500, preventDefault() {} });
  rows[0].props.onPointerUp({ clientY: 500 });
  flushRaf();
  // The de-lift is part of the glide, not a post-commit snap: the drag class
  // must already be off, the settle class on, and the landing transform must
  // carry the travel WITHOUT the inflated scale.
  if (rowNodes[0].classList.contains('dms-optionDragging')) {
    throw new Error('the drag class survives into the settle, so the lift pops off at commit instead of fading during the glide');
  }
  if (!rowNodes[0].classList.contains('dms-optionSettling')) {
    throw new Error('the settle class was not applied on drop');
  }
  if (!/^translateY\(-?[\d.]+px\)$/.test(rowNodes[0].style.transform || '')) {
    throw new Error('the landing transform is not a bare translate (a scale here would keep the row inflated): ' + rowNodes[0].style.transform);
  }
  // Nothing is persisted until the landing animation finishes.
  if (Object.prototype.hasOwnProperty.call(store.data, ORDER_KEY)) {
    throw new Error('the order was committed before the landing animation finished');
  }
  runSettle();
  const saved = store.data[ORDER_KEY];
  if (typeof saved !== 'string') {
    // Diagnose from the state the module actually holds, rather than guessing:
    // report what the gesture left behind.
    throw new Error('the drop did not persist an order'
      + ' [rows=' + names()
      + '; pending=' + pending.filter(Boolean).map((t) => t.ms).join('/')
      + '; store=' + JSON.stringify(store.data)
      + '; props=' + Object.keys(rows[0].props).filter((k) => k.indexOf('on') === 0).join('/') + ']');
  }
  const parsed = JSON.parse(saved);
  if (parsed.join(',') !== 'Beta,Gamma,Alpha') {
    throw new Error('the persisted order is ' + parsed.join(',') + ', expected Beta,Gamma,Alpha');
  }
  // The click browsers deliver right after a drop must NOT select a model. This
  // is checked on the SAME mount that performed the drop: the latch lives in a
  // per-instance ref, and re-mounting first would test a sequence the browser
  // never produces — the drop and its trailing click are one gesture on one
  // instance.
  const beforeClick = mountRef.made.selects.length;
  rows[0].props.onClick();
  if (mountRef.made.selects.length !== beforeClick) {
    throw new Error('a click right after the drop still selected a model: ' + JSON.stringify(mountRef.made.selects));
  }
  // …but the NEXT click works normally: the swallow latch must not stick.
  rows[1].props.onClick();
  if (mountRef.made.selects.length !== beforeClick + 1) {
    throw new Error('the swallow latch ate a legitimate click');
  }

  // A separate mount proves the SAVED ORDER is applied when the list is opened
  // again — the persistence half of the feature.
  pending.length = 0;
  mount();
  if (names() !== 'Beta,Gamma,Alpha') {
    throw new Error('the saved order was not applied on mount: ' + names());
  }
});

function fakeRowNode(top) {
  const t = typeof top === 'number' ? top : 0;
  // The drag writes inline styles, adds the settle class and forces a style flush
  // by reading a layout property — so the fake node carries every part of that
  // surface a real element exposes.
  const classes = new Set();
  return {
    setPointerCapture() {}, releasePointerCapture() {}, focus() {}, contains: () => false,
    // A 34px row at the given offset, matching `.dms-option`'s real box
    // (20px line-height + 7px padding top and bottom).
    getBoundingClientRect: () => ({ top: t, height: 34 }),
    offsetHeight: 34,
    style: {},
    classList: {
      add: (c) => classes.add(c),
      remove: (c) => classes.delete(c),
      contains: (c) => classes.has(c)
    }
  };
}

check('the reorder surfaces are wired and the flat list is excluded', () => {
  // Source-level contract for the parts the gesture test cannot see: the row
  // renders the drag classes, the lift carries its elevation, and reordering is
  // NOT offered in flat mode (a provider-grouped list has no row order).
  for (const needle of ['dms-optionDragging', 'dms-optionArmed', 'dms-optionSettling']) {
    if (source.indexOf(needle) === -1) throw new Error('the drag surface is missing: ' + needle);
  }
  // The lifted row must be a TWO-CLASS selector, not a single class.
  //
  // The base `.dms-option` rule carries `transition:transform .18s` for the
  // neighbour glide, it appears LATER in the sheet, and it has the same
  // specificity — so as `.dms-optionDragging` alone this declaration was
  // silently OVERRIDDEN and the lifted row animated along behind the pointer
  // instead of tracking it. A real browser measuring the computed style found
  // it; this assertion pins the fix. (The smoke suite alone could not: every
  // declaration in the sheet was individually correct, and a source scan does
  // not resolve the cascade.)
  const dragRule = /\.dms-option\.dms-optionDragging\{([^}]*)\}/.exec(source);
  if (!dragRule) {
    throw new Error('the lifted-row rule is no longer two-class, so the later base rule would override its transition:none');
  }
  if (dragRule[1].indexOf('box-shadow') === -1) throw new Error('the lifted row has no elevation: ' + dragRule[1]);
  if (dragRule[1].indexOf('transition:none') === -1) {
    throw new Error('the lifted row transitions its transform, so it would lag the pointer: ' + dragRule[1]);
  }
  // The settle rule needs the extra specificity for the same reason: it has to
  // outrank BOTH the base rule and the drag rule's `transition:none`.
  const settleRule = /\.dms-option\.dms-optionSettling\{([^}]*)\}/.exec(source);
  if (!settleRule) throw new Error('the settle rule is no longer two-class');
  if (settleRule[1].indexOf('transition:transform') === -1) {
    throw new Error('the settle rule no longer restores a transform transition: ' + settleRule[1]);
  }
  // The landing polish rides the glide: while settling, the row keeps its
  // stacking and hit-test immunity from its OWN rule (the drag class is off by
  // then), and the lift styles fade via transitions instead of snapping off at
  // commit. Each declaration is pinned because dropping any one of them
  // re-creates a visible seam at the end of the drop.
  for (const part of ['position:relative', 'z-index:5', 'pointer-events:none',
    'box-shadow .14s', 'background-color .14s', 'border-radius .14s', 'opacity .14s']) {
    if (settleRule[1].indexOf(part) === -1) throw new Error('the settle rule lost the landing polish: ' + part);
  }
  // The extra class is only MEANINGFUL because the base rule comes later in the
  // sheet; if that ordering ever flips, the two-class selectors are no longer
  // carrying the cascade and this whole arrangement should be re-checked.
  const baseAt = source.indexOf('.dms-option{display:flex');
  const dragAt = source.indexOf('.dms-option.dms-optionDragging{');
  if (baseAt < 0 || dragAt < 0) throw new Error('cannot locate the base and drag rules in the sheet');
  if (baseAt < dragAt) {
    throw new Error('the base rule now PRECEDES the drag rules, so the cascade was re-ordered — re-verify that transition:none still wins');
  }
  // The scale itself lives in the JS, applied to the lifted row's transform.
  if (source.indexOf('DMS_DRAG_SCALE') === -1 || !/scale\(" \+ DMS_DRAG_SCALE/.test(source)) {
    throw new Error('the lifted row is no longer scaled, so it would not read as a floating layer');
  }
  // The landing must be ANIMATED, which needs (a) the settle class, (b) the class
  // applied BEFORE the transform is written — a class change and a transform
  // change in one style recalculation start no transition — and (c) a forced
  // style flush between them. Each of the three is checked, because dropping any
  // one leaves a row that teleports into place.
  if (source.indexOf('dms-optionSettling') === -1) throw new Error('the settle class is gone');
  const settleSeq = /node\.classList\.remove\("dms-optionDragging"\);\s*\n\s*node\.classList\.add\("dms-optionSettling"\);\s*\n\s*\}\s*\n\s*void node\.offsetHeight;/.exec(source);
  if (!settleSeq) {
    throw new Error('the settle class swap is no longer followed by a forced style flush, so the landing would teleport');
  }
  // The lift fades out DURING the glide, not at commit: the settle block must
  // remove the drag class — its `transition:none` and its lift styles leave
  // with it, and the settle rule's fades take over while the row still moves.
  if (!/const dmsDragUp = function \(event\) \{[\s\S]*?node\.classList\.remove\("dms-optionDragging"\);/.test(source)) {
    throw new Error('the drag class is not removed on drop, so the shadow and scale pop off only when commit lands');
  }
  if (!/dmsSettlePaint\(st\);\s*\n\s*st\.settleTimer = setTimeout\(commit/.test(source)) {
    throw new Error('the landing transform is not written before the settle timer is armed');
  }
  // The landing write is `dmsSettlePaint` — the travel WITHOUT the lifted
  // scale — so the deflate interpolates with the glide. `dmsPaint` would
  // re-add `scale(1.04)` and freeze the row inflated until commit.
  const settlePaint = /const dmsSettlePaint = function \(st\) \{([\s\S]*?)\n\t\t\t\};/.exec(source);
  if (!settlePaint) throw new Error('dmsSettlePaint is gone; the landing write fell back to dmsPaint');
  if (settlePaint[1].indexOf('scale(') !== -1) throw new Error('dmsSettlePaint re-adds the lifted scale, so the row stays inflated');
  if (settlePaint[1].indexOf('translateY(" + st.offsetY + "px)') === -1) throw new Error('dmsSettlePaint no longer writes the plain translate');
  // A pointer frame scheduled before the release fires AFTER the settle write;
  // ungated, it repaints the lifted scale over the deflating glide.
  if (!/if \(live !== st \|\| !st\.started \|\| st\.settling\) return;/.test(source)) {
    throw new Error('a stale pointer frame is not gated on settling, so it can repaint the lifted scale mid-glide');
  }
  // EVERY drop settles, even an in-place one: the deflate IS a transition, and
  // an instant commit would snap the row flat with no animation.
  if (!/if \(node === null \|\| node === undefined \|\| !node\.style\) \{\s*\n\s*commit\(\);/.test(source)) {
    throw new Error('an in-place drop no longer settles — it would snap flat instead of deflating');
  }
  // Every exit must clear the transforms, or a cancelled drag leaves a row drawn
  // away from its box (the stuck-row bug). `dmsDragCancel` is the single exit.
  const cancelBody = /const dmsDragCancel = function \(\) \{([\s\S]*?)\n\t\t\t\};/.exec(source);
  if (!cancelBody) throw new Error('could not read dmsDragCancel');
  if (cancelBody[1].indexOf('dmsClearShifts()') === -1) {
    throw new Error('dmsDragCancel no longer clears the transforms, so a cancelled drag leaves rows displaced');
  }
  if (cancelBody[1].indexOf('node.style.transform') !== -1) {
    throw new Error('dmsDragCancel clears one row directly instead of the whole list');
  }
  const clearBody = /const dmsClearShifts = function \(\) \{([\s\S]*?)\n\t\t\t\};/.exec(source);
  if (!clearBody || clearBody[1].indexOf('dmsWriteShift(i, 0)') === -1) {
    throw new Error('dmsClearShifts no longer resets every row');
  }
  // The displaced-row pass must SKIP the dragged row: that row's motion comes
  // from the pointer, and shifting it here too would apply its travel twice.
  const applyBody = /const dmsApplyShifts = function \(st\) \{([\s\S]*?)\n\t\t\t\};/.exec(source);
  if (!applyBody) throw new Error('could not read dmsApplyShifts');
  if (applyBody[1].indexOf('continue') === -1) {
    throw new Error('dmsApplyShifts no longer skips the dragged row, so it would move twice');
  }
  if (!/if \(i === st\.fromIdx\) continue;/.test(applyBody[1])) {
    throw new Error('dmsApplyShifts skips something other than the dragged row');
  }
  // The neighbours' glide is the base rule's transition — that declaration IS the
  // "flow out of the way" animation.
  const baseRule = /"\.dms-option\{([^"]*)\}"/.exec(source);
  if (!baseRule || baseRule[1].indexOf('transition:transform') === -1) {
    throw new Error('the base row no longer transitions its transform, so the gaps would snap open: ' + String(baseRule && baseRule[1]));
  }
  // The long press must be a real hold, not an immediate drag: a zero delay
  // would turn every click into a drag. 300ms is the requested value.
  const hold = /DMS_DRAG_HOLD_MS = (\d+)/.exec(source);
  if (!hold || Number(hold[1]) !== 300) {
    throw new Error('the hold delay is ' + (hold ? hold[1] : 'missing') + 'ms, expected 300');
  }
  // And the slop must hand the gesture back to the scroller.
  if (!/DMS_DRAG_SLOP = (\d+)/.test(source)) throw new Error('the scroll slop is gone');
  // The row must carry every pointer handler.
  for (const h of ['onPointerDown', 'onPointerMove', 'onPointerUp', 'onPointerCancel']) {
    if (source.indexOf(h + ':') === -1) throw new Error('the row is missing ' + h);
  }
  // Flat mode must NOT render the drag handlers: check that the handler block
  // appears only inside the collapsed-mode branch by counting the sites.
  const downSites = (source.match(/onPointerDown: function \(event\) \{ dmsDragDown\(/g) || []).length;
  if (downSites !== 1) {
    throw new Error('expected exactly 1 row to arm the drag, found ' + downSites + ' (flat mode must not)');
  }
  // The gap is now the drop indicator, so the old 2px rule must be GONE — it was
  // positioned from live rectangles, which are displaced by the very transforms
  // this design introduces, so it could only ever have been drawn in the wrong
  // place.
  if (source.indexOf('dms-dropIndicator') !== -1 || source.indexOf('dmsDropLine') !== -1) {
    throw new Error('the drop rule came back; the gap is the indicator now');
  }
});

// 13. 可选提供商 (ui: "在 设置-模型 内除了 DeepSeek账号 和 DeepSeek 两个模型提供商外，
// 其余的模型提供商加一个滑块开关，控制当前提供商是否启用，这样我就不用删除提供商但
// 还能保留提供商配置"). Four things have to hold together, and each is pinned
// below: the host half declares the field, the switch is registered on every
// provider card once per served namespace, the switch edits exactly that field (and
// refuses the two first-party DeepSeek routes), and the picker leaves a switched-off
// provider's models out of the list while keeping the CURRENT one reachable.
check('the host half declares the optional-provider list as a volatile field', () => {
  const decl = /disabledProviders:\s*z\.array\(z\.string\(\)\)([\s\S]{0,120}?)\.volatile\(\)/.exec(hostSource);
  if (!decl) throw new Error('disabledProviders is not declared as a volatile string array');
  if (decl[1].indexOf('.required(false)') === -1) {
    throw new Error('disabledProviders is required, so a profile that never used the switch would not validate');
  }
  if (decl[1].indexOf('.default(undefined)') === -1) {
    throw new Error('disabledProviders carries a default, which would materialise an empty list into every profile');
  }
});

check('the provider panel lists every routable provider, minus the two DeepSeek routes', async () => {
  const CATALOG = {
    groups: [
      { id: 'deepseek-account', models: [{ id: 'm1' }] },
      { id: 'deepseek-official', models: [{ id: 'm2' }] },
      { id: 'workbuddy', name: 'Workbuddy API', models: [{ id: 'm3' }] },
      { id: 'clip', name: 'CLIP', models: [{ id: 'm4' }] },
      // A provider the picker is currently HIDING must still be listed — that is
      // the whole point of building this list from the Host catalog rather than
      // from the directory the switches filter.
      { id: 'gemin', name: 'Antigravity', models: [{ id: 'm5' }] },
      // A route with no display name of its own falls back to its id.
      { id: 'dsh-provider-qoder', models: [{ id: 'm6' }] },
      // Two groups cannot carry one id, but a duplicate must not render twice.
      { id: 'clip', name: 'CLIP', models: [{ id: 'm7' }] },
      // A row with no route id is not a provider: it must not become a switch.
      { id: '', name: 'Bogus', models: [{ id: 'm8' }] },
      { models: [{ id: 'm9' }] }
    ]
  };
  const made = makeCtx({ catalog: CATALOG });
  loadModule().apply(made.ctx);
  const reg = made.registrations.filter((r) => r.options.name === 'settings.models.footer')[0];
  if (!reg) throw new Error('no provider panel was registered');
  const read = () => {
    hookState.length = 0;
    const tree = expand(reg.component(reg.options.inject()));
    return {
      tree,
      names: findAll(tree, (p) => typeof p.className === 'string' && p.className.split(' ').indexOf('dms-providerPanelName') !== -1)
        .map((n) => String(n.children[0])),
      switches: findAll(tree, (p) => p.role === 'switch')
    };
  };
  // 1. Before the mount effect runs there is nothing to show but the "loading"
  // sentence: the panel must never render an empty provider list as if the
  // deployment had none.
  const before = read();
  if (before.switches.length !== 0) throw new Error('the panel rendered switches before the catalog arrived');
  // 2. The mount effect asks for the catalog; once the Host answers, the panel
  // lists one row per UNIQUE, unprotected route, in catalog order.
  hookState.length = 0;
  expand(reg.component(reg.options.inject()));
  runEffects();
  await new Promise((resolve) => setTimeout(resolve, 0));
  const ready = read();
  if (ready.names.join('|') !== 'Workbuddy API|CLIP|Antigravity|dsh-provider-qoder') {
    throw new Error('the panel lists ' + JSON.stringify(ready.names));
  }
  if (ready.switches.length !== 4) throw new Error('the panel rendered ' + ready.switches.length + ' switches, expected 4');
  for (const sw of ready.switches) {
    if (sw.props['aria-checked'] !== true) throw new Error('a switch rendered OFF with an empty list');
  }

  // 3. A catalog that never loads is a sentence, not a broken panel — the panel
  // must say why rather than render a silently empty list.
  const broken = makeCtx({ catalog: CATALOG, noCatalog: true });
  loadModule().apply(broken.ctx);
  const regB = broken.registrations.filter((r) => r.options.name === 'settings.models.footer')[0];
  hookState.length = 0;
  expand(regB.component(regB.options.inject()));
  runEffects();
  await new Promise((resolve) => setTimeout(resolve, 0));
  hookState.length = 0;
  localeCalls.length = 0;
  const brokenTree = expand(regB.component(regB.options.inject()));
  if (findAll(brokenTree, (p) => p.role === 'switch').length !== 0) {
    throw new Error('a throwing catalog still rendered switches');
  }
  if (localeCalls.map((call) => call.key).indexOf('provider.panel.failed') === -1) {
    throw new Error('a failed catalog rendered no explanation: ' + JSON.stringify(localeCalls));
  }

  // 4. The panel refreshes when the Host announces an adapter change — that is
  // the one event that can move the provider set while the page stays open — and
  // a provider that appears then is immediately usable.
  const refreshed = makeCtx({ catalog: { groups: [{ id: 'workbuddy', name: 'Workbuddy API', models: [{ id: 'm1' }] }] } });
  loadModule().apply(refreshed.ctx);
  const regR = refreshed.registrations.filter((r) => r.options.name === 'settings.models.footer')[0];
  hookState.length = 0;
  expand(regR.component(regR.options.inject()));
  runEffects();
  await new Promise((resolve) => setTimeout(resolve, 0));
  if (refreshed.adapterSubscriptions().indexOf('llm/adapters-updated') === -1) {
    throw new Error('the panel never subscribed to adapter changes: ' + JSON.stringify(refreshed.adapterSubscriptions()));
  }
  refreshed.ctx.remote.session.modelCatalog = () => Promise.resolve({
    ok: true,
    value: { groups: [{ id: 'workbuddy', name: 'Workbuddy API', models: [{ id: 'm1' }] }, { id: 'clip', name: 'CLIP', models: [{ id: 'm2' }] }] }
  });
  refreshed.fireAdaptersUpdated();
  await new Promise((resolve) => setTimeout(resolve, 0));
  hookState.length = 0;
  const refreshedTree = expand(regR.component(regR.options.inject()));
  const refreshedNames = findAll(refreshedTree, (p) => typeof p.className === 'string' && p.className.split(' ').indexOf('dms-providerPanelName') !== -1)
    .map((node) => String(node.children[0]));
  if (refreshedNames.join('|') !== 'Workbuddy API|CLIP') {
    throw new Error('an adapter change did not refresh the panel: ' + JSON.stringify(refreshedNames));
  }
});

check('the provider switches edit the list, in both of its homes', async () => {
  const DISABLED_KEY = 'dsh-modef.disabled-providers.v1';
  const CATALOG = {
    groups: [
      { id: 'deepseek-official', models: [{ id: 'm1' }] },
      { id: 'workbuddy', name: 'Workbuddy API', models: [{ id: 'm2' }] },
      { id: 'clip', name: 'CLIP', models: [{ id: 'm3' }] }
    ]
  };
  /** The per-machine store the switch writes first (and the picker reads last). */
  const storeStub = (initial) => {
    const data = Object.assign({}, initial || {});
    return {
      getItem: (k) => (Object.prototype.hasOwnProperty.call(data, k) ? data[k] : null),
      setItem: (k, v) => { data[k] = String(v); },
      removeItem: (k) => { delete data[k]; },
      dump: () => data
    };
  };
  const withStore = (store, opts) => {
    const made = makeCtx(Object.assign({ catalog: CATALOG }, opts || {}));
    loadModule({ window: { localStorage: store } }).apply(made.ctx);
    const reg = made.registrations.filter((r) => r.options.name === 'settings.models.footer')[0];
    if (!reg) throw new Error('no provider panel was registered');
    return { made, reg };
  };
  /** Mount the panel, run its catalog read, settle, and read the switches by row. */
  const switchesOf = async (reg) => {
    hookState.length = 0;
    expand(reg.component(reg.options.inject()));
    runEffects();
    await new Promise((resolve) => setTimeout(resolve, 0));
    hookState.length = 0;
    const tree = expand(reg.component(reg.options.inject()));
    const rows = findAll(tree, (p) => typeof p.className === 'string' && p.className.split(' ').indexOf('dms-providerPanelRow') !== -1);
    return rows.map((row) => ({
      name: String(findAll(row, (p) => typeof p.className === 'string' && p.className.split(' ').indexOf('dms-providerPanelName') !== -1)[0].children[0]),
      sw: findAll(row, (p) => p.role === 'switch')[0]
    }));
  };

  // 1. Flipping a switch lands in the PER-MACHINE store immediately — that is
  // what makes it work before the Host has projected the field — and is mirrored
  // into the settings document, which is what survives a profile backup.
  const storeA = storeStub();
  const first = withStore(storeA);
  const rowsA = await switchesOf(first.reg);
  if (rowsA.length !== 2 || rowsA[0].name !== 'Workbuddy API' || rowsA[1].name !== 'CLIP') {
    throw new Error('the panel rows are ' + JSON.stringify(rowsA.map((r) => r.name)));
  }
  if (rowsA[0].sw.props['aria-checked'] !== true) throw new Error('a provider that is not in the list rendered as OFF');
  rowsA[0].sw.props.onClick();
  if (JSON.stringify(storeA.dump()[DISABLED_KEY]) !== JSON.stringify(JSON.stringify(['workbuddy']))) {
    throw new Error('the switch never reached the per-machine store: ' + JSON.stringify(storeA.dump()));
  }
  if (JSON.stringify(first.made.mutations[0]) !== JSON.stringify([{ op: 'set', path: ['disabledProviders'], value: ['workbuddy'] }])) {
    throw new Error('turning a provider off mirrored ' + JSON.stringify(first.made.mutations[0]) + ', expected one set op carrying the new list');
  }

  // 2. With the provider listed, its switch renders OFF, and turning it back on
  // UNSETS the field once the list empties (an empty array would materialise
  // `disabledProviders: []` into a profile that never used the feature) AND
  // removes the store key rather than leaving an empty husk behind.
  const storeB = storeStub({ [DISABLED_KEY]: JSON.stringify(['workbuddy']) });
  const listed = withStore(storeB, { settingsValue: { advancedEffort: true, disabledProviders: ['workbuddy'] } });
  const rowsB = await switchesOf(listed.reg);
  if (rowsB[0].sw.props['aria-checked'] !== false) throw new Error('a listed provider rendered as ON');
  rowsB[0].sw.props.onClick();
  if (JSON.stringify(listed.made.mutations[0]) !== JSON.stringify([{ op: 'unset', path: ['disabledProviders'] }])) {
    throw new Error('turning the last provider back on mirrored ' + JSON.stringify(listed.made.mutations[0]) + ', expected one unset');
  }
  if (Object.prototype.hasOwnProperty.call(storeB.dump(), DISABLED_KEY)) {
    throw new Error('the emptied list was left in the store as ' + JSON.stringify(storeB.dump()[DISABLED_KEY]));
  }

  // 3. The two first-party DeepSeek routes are absent from the panel entirely:
  // this is an absence, not a disabled control.
  const guard = withStore(storeStub());
  const guardNames = (await switchesOf(guard.reg)).map((r) => r.name);
  for (const route of ['deepseek-official', 'deepseek-account']) {
    if (guardNames.indexOf(route) !== -1) throw new Error(route + ' got a switch');
  }

  // 4. A REFUSED document write must still leave a working switch: the store
  // write comes first and is unconditional, so a read-only settings document (or
  // a Host half that has not projected the field yet) costs the durable copy only.
  const storeC = storeStub();
  const refused = makeCtx({ catalog: CATALOG });
  refused.ctx.configForms.get = () => ({
    getSnapshot: () => ({ status: 'ready', writable: false, value: { advancedEffort: true } }),
    subscribe: () => () => {},
    set: () => Promise.reject(new Error('read-only')),
    unset: () => Promise.reject(new Error('read-only')),
    mutate: () => Promise.reject(new Error('settings document is read-only'))
  });
  loadModule({ window: { localStorage: storeC } }).apply(refused.ctx);
  const regC = refused.registrations.filter((r) => r.options.name === 'settings.models.footer')[0];
  const rowsC = await switchesOf(regC);
  const clipRow = rowsC.filter((r) => r.name === 'CLIP')[0];
  clipRow.sw.props.onClick();
  if (JSON.stringify(storeC.dump()[DISABLED_KEY]) !== JSON.stringify(JSON.stringify(['clip']))) {
    throw new Error('a refused document write also lost the local switch: ' + JSON.stringify(storeC.dump()));
  }

  // 5. A deployment with no `remote.session` at all must degrade to a sentence,
  // never to a throw (a throwing entry is retired by the slot ledger).
  const blind = makeCtx({ noCatalog: true });
  loadModule().apply(blind.ctx);
  const regBlind = blind.registrations.filter((r) => r.options.name === 'settings.models.footer')[0];
  hookState.length = 0;
  expand(regBlind.component(regBlind.options.inject()));
  runEffects();
  await new Promise((resolve) => setTimeout(resolve, 0));
  hookState.length = 0;
  if (findAll(expand(regBlind.component(regBlind.options.inject())), (p) => p.role === 'switch').length !== 0) {
    throw new Error('a missing remote catalog still rendered switches');
  }
});

check('the picker leaves a switched-off provider out, and keeps the current one', () => {
  const PROVIDERS = [
    { id: 'workbuddy', name: 'Workbuddy', models: [{ id: 'kimi-k3-1', name: 'Kimi K3' }] },
    { id: 'clip', name: 'CLIP', models: [{ id: 'kimi-k3', name: 'Kimi K3' }] },
    { id: 'step', name: 'Step', models: [{ id: 'step-5-preview', name: 'Step 5 Preview' }] }
  ];
  /** Open the model menu and return { rows, hint, panel(name), clickRow(title) }. */
  const open = (settingsValue, current, win) => {
    const made = makeCtx({
      effort: 'high',
      groups: PROVIDERS,
      settingsValue: Object.assign({ advancedEffort: true, effortStyle: 'spray-flow', trackShape: 'capsule' }, settingsValue),
      current: current
    });
    loadModule({ window: win }).apply(made.ctx);
    const seat = seatOf(made.registrations);
    const injected = seat.options.inject('session-1');
    hookState.length = 0;
    localeCalls.length = 0;
    let tree = expand(seat.component({ ...injected }));
    const settle = () => {
      for (let i = 0; i < 4; i += 1) { runEffects(); resetHooks(); tree = expand(seat.component({ ...injected })); }
      return tree;
    };
    const trigger = findAll(tree, (p) => p.className === 'dms-trigger')[0];
    if (!trigger) throw new Error('model trigger not found');
    trigger.props.onClick();
    settle();
    const rows = findAll(tree, (p) => typeof p.className === 'string' && p.className.split(' ').indexOf('dms-option') !== -1);
    // 可选提供商 deliberately renders NO footer in the menu: a switched-off
    // provider leaves silently, and the menu never advertises the count. This is
    // read here (not asserted per case) so the check below can prove its ABSENCE
    // in every state, including the ones that hide two providers.
    const hint = findAll(tree, (p) => p.className === 'dms-hiddenHint')[0];
    /** Click a level-1 row by title, the way a user picks the name. */
    const clickRow = (title) => {
      const row = rows.filter((r) => String(r.props.title) === title)[0];
      if (!row) throw new Error('no row titled ' + JSON.stringify(title));
      row.props.onClick({ stopPropagation() {}, preventDefault() {} });
      settle();
    };
    /** Open the provider panel of the row whose title matches, then read its rows. */
    let openPanel = null;
    const panel = (title) => {
      const row = rows.filter((r) => String(r.props.title) === title)[0];
      if (!row) throw new Error('no row titled ' + JSON.stringify(title));
      // The arrow TOGGLES, so a second call for the title already on screen must
      // re-read instead of clicking again — the assertions below call `panel()`
      // once more inside their failure message to print what they saw, and that
      // message must not close the very panel it is reporting on.
      if (openPanel !== title) {
        const arrow = findAll(row, (p) => typeof p.className === 'string' && p.className.split(' ').indexOf('dms-arrow') !== -1)[0];
        arrow.props.onClick({ stopPropagation() {}, preventDefault() {} });
        for (let i = 0; i < 4; i += 1) { runEffects(); resetHooks(); tree = expand(seat.component({ ...injected })); }
        openPanel = title;
      }
      const options = findAll(tree, (p) => typeof p.className === 'string' && p.className.split(' ').indexOf('dms-subOption') !== -1);
      // An empty panel means the arrow click did not land (stale tree, wrong row)
      // — that must fail loudly, not read as "the provider was hidden".
      if (options.length === 0) throw new Error('the provider panel of ' + JSON.stringify(title) + ' never opened');
      return options.map((r) => String((findAll(r, (p) => p.className === 'dms-subProvider')[0] || { children: [] }).children[0]));
    };
    return {
      rows,
      made,
      clickRow,
      panel,
      hint: hint ? String((hint.children || [])[0]) : null,
      // The locale keys the menu asked for, so a check can prove the removed
      // footer string is never requested either (the stub answers with its key).
      hints: localeCalls.filter((c) => c.key === 'provider.hidden').length,
      titles: rows.map((r) => String(r.props.title))
    };
  };

  // Nothing switched off: one row per distinct NAME, and the panel offers both
  // providers carrying "Kimi K3".
  const all = open({});
  if (all.titles.join('|') !== 'Kimi K3|Step 5 Preview') throw new Error('baseline rows are ' + JSON.stringify(all.titles));
  if (all.panel('Kimi K3').join('|') !== 'Workbuddy|CLIP') throw new Error('baseline panel is ' + JSON.stringify(all.panel('Kimi K3')));

  // One provider off: its models leave BOTH levels and the name survives on the
  // provider that is still on — in SILENCE. The menu must not grow a footer, a
  // caption or a badge about it (the request removed exactly that line), so every
  // case below asserts the absence rather than a count.
  const one = open({ disabledProviders: ['workbuddy'] });
  if (one.titles.join('|') !== 'Kimi K3|Step 5 Preview') throw new Error('one-off rows are ' + JSON.stringify(one.titles));
  if (one.panel('Kimi K3').join('|') !== 'CLIP') throw new Error('a switched-off provider stayed in the panel: ' + JSON.stringify(one.panel('Kimi K3')));
  if (one.hint !== null || one.hints !== 0) {
    throw new Error('the menu still renders the hidden-provider footer: ' + JSON.stringify(one.hint) + ' x' + one.hints);
  }

  // …and the same thing with the list ONLY in the per-machine store, which is the
  // state of the world before the Host has projected `disabledProviders` (and the
  // reason the store is the primary home). The document here says nothing about
  // providers at all.
  const storeOnly = open({}, undefined, {
    localStorage: {
      getItem: (k) => (k === 'dsh-modef.disabled-providers.v1' ? JSON.stringify(['workbuddy']) : null),
      setItem: () => {}, removeItem: () => {}
    }
  });
  if (storeOnly.titles.join('|') !== 'Kimi K3|Step 5 Preview') {
    throw new Error('a store-only disabled list was ignored: ' + JSON.stringify(storeOnly.titles));
  }
  if (storeOnly.panel('Kimi K3').join('|') !== 'CLIP') {
    throw new Error('a store-only disabled provider stayed in the panel: ' + JSON.stringify(storeOnly.panel('Kimi K3')));
  }

  // The name's ONLY provider off: the row disappears at level 1 too, still with
  // no footer about it.
  const two = open({ disabledProviders: ['workbuddy', 'clip'] });
  if (two.titles.join('|') !== 'Step 5 Preview') throw new Error('two-off rows are ' + JSON.stringify(two.titles));
  if (two.hint !== null || two.hints !== 0) {
    throw new Error('two hidden providers still produced a footer: ' + JSON.stringify(two.hint) + ' x' + two.hints);
  }

  // The CURRENT model is the exception: the composer already shows it, so its
  // provider's row must stay reachable even while switched off — otherwise the
  // menu could not display (or re-select) what the composer says.
  const currentOff = open({ disabledProviders: ['workbuddy', 'clip'] }, { provider: 'workbuddy', model: 'kimi-k3-1', reasoningEffort: 'high' });
  if (currentOff.titles.join('|') !== 'Kimi K3|Step 5 Preview') {
    throw new Error('the current model vanished from its own menu: ' + JSON.stringify(currentOff.titles));
  }
  // …and only that one: the other provider of the same name stays hidden.
  if (currentOff.panel('Kimi K3').join('|') !== 'Workbuddy') {
    throw new Error('the exception leaked to the sibling provider: ' + JSON.stringify(currentOff.panel('Kimi K3')));
  }

  // The remembered provider is a THIRD path into a provider, and it has to honour
  // the switch too: memory says "Kimi K3 was last chosen on workbuddy", workbuddy
  // is switched off, so a plain click on the row must land on the provider that is
  // still on — otherwise one click would quietly undo the switch.
  const memoryKey = 'dsh-modef.provider-memory.v1';
  const data = {};
  data[memoryKey] = JSON.stringify({ 'Kimi K3': 'workbuddy\u0000kimi-k3-1' });
  const memoryStore = {
    getItem: (k) => (Object.prototype.hasOwnProperty.call(data, k) ? data[k] : null),
    setItem: (k, v) => { data[k] = String(v); },
    removeItem: (k) => { delete data[k]; }
  };
  const rememberedOff = open({ disabledProviders: ['workbuddy'] }, undefined, { localStorage: memoryStore });
  rememberedOff.clickRow('Kimi K3');
  if (rememberedOff.made.selects.length !== 1 || rememberedOff.made.selects[0].provider !== 'clip') {
    throw new Error('a plain click revived a switched-off provider: ' + JSON.stringify(rememberedOff.made.selects));
  }
  // With the provider ON, the very same memory is honoured — so the assertion
  // above pins the switch, not a broken memory read.
  const memoryData = {};
  memoryData[memoryKey] = JSON.stringify({ 'Kimi K3': 'workbuddy\u0000kimi-k3-1' });
  const rememberedOn = open({}, undefined, {
    localStorage: {
      getItem: (k) => (Object.prototype.hasOwnProperty.call(memoryData, k) ? memoryData[k] : null),
      setItem: (k, v) => { memoryData[k] = String(v); },
      removeItem: (k) => { delete memoryData[k]; }
    }
  });
  rememberedOn.clickRow('Kimi K3');
  if (rememberedOn.made.selects.length !== 1 || rememberedOn.made.selects[0].provider !== 'workbuddy') {
    throw new Error('the provider memory stopped working: ' + JSON.stringify(rememberedOn.made.selects));
  }
});

// 14. The model catalog must still be loaded for a session whose directory was
// not available at mount time (the fresh-conversation race): the seat resolves it
// late through `resolveDirectory`, so the FIRST render must not throw and the
// load must still happen once the directory appears.
const state = { directoryThrows: true, loadCalls: 0, storeStatus: 'loading' };
const ctx7 = makeCtx({ state });
loadModule().apply(ctx7.ctx);
// 4-pr3. Tier text roll (ui: "给思考强度的文字切换加一个过渡动画，是渐隐加上下
// 滚动的样子"). The three things that can each silently produce a working-looking
// screen with no animation at all, and each needs its own guard:
//
//   1. THE ROLL NEVER STARTS. The value must actually be observed changing, and
//      a re-render at the SAME tier must not re-trigger it — the control
//      re-renders on every drag frame, so an event-driven roll would replay at
//      pointer rate instead of once per tier change.
//   2. THE GRADIENT AND THE ROLL SILENTLY CANCEL EACH OTHER. `animation` is a
//      SHORTHAND, so the tier's `dms-textflow` slide and the roll keyframes must
//      be declared TOGETHER on a gradient tier; either rule written alone kills
//      the other. This is asserted as a rendered class shape AND as CSS.
//   3. THE PAINT OWNER IS WRONG, so the roll is invisible on precisely the two
//      tiers it decorates. Measured in Chrome: an ancestor's `background-clip:text`
//      does NOT follow a transformed/opacity-faded descendant (ink identical at
//      1198px vs 1198px; the same transform on the gradient OWNER moved it
//      1198 -> 204). The animated element must therefore be the one that owns the
//      background, and the carrier's own clipped paint must be handed off.
check('the tier text rolls with a fade and vertical travel on every change', () => {
  const css = (() => { injectedCss = ''; loadModule().apply(makeCtx({}).ctx); return injectedCss; })();
  const ruleOf = (sel) => {
    const at = css.indexOf(sel);
    if (at === -1) throw new Error('css rule missing: ' + sel);
    return css.slice(at, css.indexOf('}', at));
  };

  // --- (3) the paint owner: the ANIMATED element carries the ramp -------------
  const inKf = css.indexOf('@keyframes dms-roll-in-up');
  const outKf = css.indexOf('@keyframes dms-roll-out-up');
  if (inKf === -1 || outKf === -1) {
    throw new Error('the roll keyframes are missing, so the roll would be a silent no-op');
  }
  // Both keyframes must move AND fade: "渐隐加上下滚动" is the whole request.
  const kfBody = (at) => {
    let depth = 0, i = css.indexOf('{', at);
    const start = i;
    for (; i < css.length; i += 1) {
      if (css[i] === '{') depth += 1;
      else if (css[i] === '}') { depth -= 1; if (depth === 0) break; }
    }
    return css.slice(start, i + 1);
  };
  for (const [name, at] of [['dms-roll-in-up', inKf], ['dms-roll-out-up', outKf]]) {
    const body = kfBody(at);
    if (!/translateY\(/.test(body)) throw new Error(name + ' does not travel vertically: ' + body);
    if (!/opacity:/.test(body)) throw new Error(name + ' does not fade: ' + body);
  }
  // The animated element must be the one that owns the gradient. Asserted as a
  // rendered shape below; here the CSS must not animate a bare wrapper.
  if (css.indexOf('.dms-rollVal.dms-rollInUp') === -1 || css.indexOf('.dms-rollVal.dms-rollOutUp') === -1) {
    throw new Error('the roll animation does not target .dms-rollVal, so it would animate a wrapper the gradient cannot follow');
  }
  // The box clips the travelling text, or it would collide with the row above.
  const boxRule = ruleOf('.dms-rollBox{');
  if (!/clip-path:inset\(/.test(boxRule) && !/overflow:hidden/.test(boxRule)) {
    throw new Error('the roll box does not clip its travelling text: ' + boxRule);
  }
  // `clip-path`, not `overflow:hidden`: the latter replaces an inline-block's
  // baseline with its bottom margin edge, which would lift the tier value off the
  // title's baseline in the rounded header.
  if (!/clip-path:inset\(/.test(boxRule)) {
    throw new Error('the roll box clips with overflow, which moves the inline-block baseline and misaligns the tier value: ' + boxRule);
  }

  // --- (2) the gradient and the roll must coexist ----------------------------
  // A gradient tier needs BOTH animations on the same element. `animation` is a
  // shorthand, so each combined rule must name BOTH keyframes.
  for (const [tier, flow] of [['dms-labelGrad', '3.5s'], ['dms-labelGradHigh', '4.5s']]) {
    for (const [state, kf] of [['dms-rollInUp', 'dms-roll-in-up'], ['dms-rollOutUp', 'dms-roll-out-up']]) {
      const sel = '.dms-rollVal.' + tier + '.' + state + '{';
      const rule = ruleOf(sel);
      const anim = /animation:([^}]*)/.exec(rule);
      if (!anim) throw new Error(sel + ' declares no animation: ' + rule);
      if (anim[1].indexOf(kf) === -1) {
        throw new Error(sel + ' lost the roll keyframes (the shorthand was overwritten): ' + anim[1]);
      }
      if (anim[1].indexOf('dms-textflow') === -1) {
        throw new Error(sel + ' lost the tier gradient flow (the shorthand was overwritten): ' + anim[1]);
      }
      if (anim[1].indexOf(flow) === -1) {
        throw new Error(sel + ' runs the wrong textflow period for its tier: ' + anim[1]);
      }
    }
    // The ramp itself must be painted by the moving element while rolling.
    if (css.indexOf('.dms-rollVal.' + tier + '{') === -1) {
      throw new Error('.dms-rollVal.' + tier + ' is missing, so a rolling gradient tier would paint nothing');
    }
  }
  // ...and the carrier's own clipped paint must be switched OFF for the roll, or
  // the ink is stranded at the resting position (measured: 0 ink drawn).
  const host = ruleOf('.dms-rollHost.dms-labelGrad');
  if (!/background:none/.test(host)) {
    throw new Error('the rolling carrier keeps its own clipped background, so the ink cannot follow the text: ' + host);
  }
  if (!/background-clip:border-box/.test(host)) {
    throw new Error('the rolling carrier keeps background-clip:text, so the ramp would clip to nothing: ' + host);
  }
  // --- (4) the box must not disturb the line box it sits in ------------------
  // REGRESSION, reported from a screenshot: "推理 Max" rendered with the tier
  // value a few px HIGHER than the "推理" caption beside it. Root cause was the
  // box's DISPLAY, not its font or padding:
  //
  //   `.dms-rollVal` is `display:block`, so an `inline-block` box establishes no
  //   in-flow line box of its own and takes the CSS 2.1 fallback baseline — its
  //   BOTTOM MARGIN EDGE. In the trigger's line box that inflated the line from
  //   20px to 26px and lifted the glyphs ~3px. Measured in Chrome:
  //   caption->value offset was 2px in the pre-roll markup, 5px with
  //   `inline-block`, and 2px again with `inline-flex`.
  //
  // `inline-flex` takes its baseline from its first flex item, i.e. the glyphs,
  // so every carrier aligns exactly as it did before the roll existed. This is
  // pinned as a ROOT-CAUSE assertion on the property itself, because the
  // symptom (a few px of drift) is far too easy to reintroduce unnoticed.
  const boxDisplay = /display:([a-z-]+)/.exec(boxRule);
  if (!boxDisplay) throw new Error('the roll box has no display: ' + boxRule);
  if (boxDisplay[1] !== 'inline-flex') {
    throw new Error('the roll box is `' + boxDisplay[1] + '`, not `inline-flex`. With a block child '
      + '(.dms-rollVal is display:block) any inline-block fallback baseline is its BOTTOM EDGE, which '
      + 'inflates the line box and lifts the tier value off the caption\'s line (26px vs 20px measured)');
  }
  // The flex conversion must not cost the 96px ellipsis cap: the box is now a
  // flex container, so `.dms-rollVal` is a flex item and its automatic minimum
  // size would otherwise stop it shrinking below the text — the cap on
  // `.dms-effortValue` would then clip nothing. `min-width:0` on the item is what
  // keeps the truncation working.
  const valRule = ruleOf('.dms-rollVal{');
  if (!/min-width:0/.test(valRule)) {
    throw new Error('the roll item cannot shrink, so a long tier name would stop truncating: ' + valRule);
  }

  // Reduced motion must freeze the roll (and keep the tier flow, which is the
  // existing gradient behaviour and must not be regressed by the freeze).
  const rm = css.slice(css.indexOf('@media (prefers-reduced-motion:reduce)'));
  if (!/\.dms-rollVal\.dms-rollInUp/.test(rm) || !/\.dms-rollVal\.dms-rollOutUp/.test(rm)) {
    throw new Error('the roll ignores prefers-reduced-motion');
  }
  if (rm.indexOf('animation:dms-textflow 3.5s') === -1) {
    throw new Error('the reduced-motion freeze also killed the tier gradient flow');
  }

  // --- (1) the roll is driven by the LABEL, once per change -------------------
  const box = { value: 'high' };
  const made = makeCtx({
    effortBox: box,
    settingsValue: { advancedEffort: true, effortStyle: 'spray-flow', trackShape: 'capsule' }
  });
  loadModule().apply(made.ctx);
  const seat = seatOf(made.registrations);
  const injected = seat.options.inject('session-1');
  hookState.length = 0;
  let tree = expand(seat.component({ ...injected }));
  findAll(tree, (p) => p.className === 'dms-effortTrigger')[0].props.onClick();
  for (let i = 0; i < 4; i += 1) { runEffects(); resetHooks(); tree = expand(seat.component({ ...injected })); }

  const rollBoxes = () => findAll(tree, (p) => typeof p.className === 'string' && p.className === 'dms-rollBox');
  const legs = () => findAll(tree, (p) => typeof p.className === 'string' && p.className.indexOf('dms-rollVal') === 0);
  // The populated panel renders one box per tier-value carrier (chip + rounded
  // header are shape-exclusive, so exactly one is mounted) plus the composer
  // trigger's own value.
  if (rollBoxes().length === 0) throw new Error('no roll box is rendered, so the tier value cannot roll');
  if (legs().length === 0) throw new Error('no roll leg is rendered');

  // A re-render at the SAME tier must not roll: no outgoing leg, no state class.
  for (let i = 0; i < 3; i += 1) { runEffects(); resetHooks(); tree = expand(seat.component({ ...injected })); }
  if (findAll(tree, (p) => typeof p.className === 'string' && /dms-rollOutUp|dms-rollInUp/.test(p.className)).length !== 0) {
    throw new Error('a re-render at the same tier started a roll');
  }

  // A real tier change must produce BOTH legs: the departing value with its OWN
  // ramp (not the incoming tier's), and the arriving one.
  box.value = 'max';
  for (let i = 0; i < 4; i += 1) { runEffects(); resetHooks(); tree = expand(seat.component({ ...injected })); }
  const outgoing = findAll(tree, (p) => typeof p.className === 'string' && p.className.indexOf('dms-rollOutUp') !== -1);
  const incoming = findAll(tree, (p) => typeof p.className === 'string' && p.className.indexOf('dms-rollInUp') !== -1);
  if (outgoing.length === 0) throw new Error('changing the tier produced no outgoing leg, so nothing rolls out');
  if (incoming.length === 0) throw new Error('changing the tier produced no incoming leg, so nothing rolls in');
  if (outgoing.length !== incoming.length) {
    throw new Error('the roll legs are unbalanced: ' + outgoing.length + ' out vs ' + incoming.length + ' in');
  }
  // The departing value keeps the ramp it HAD (High = the paler high ramp); it
  // must not be repainted in the incoming MAX ramp.
  for (const node of outgoing) {
    const cn = String(node.props.className);
    if (cn.indexOf('dms-labelGradHigh') === -1) {
      throw new Error('the departing value did not keep its own tier ramp: ' + cn);
    }
    if (cn.indexOf('dms-labelGrad ') !== -1 || / dms-labelGrad$/.test(cn)) {
      throw new Error('the departing value was repainted in the incoming tier ramp: ' + cn);
    }
    if (String(node.children[0]) !== 'High') {
      throw new Error('the departing leg does not carry the previous value, got ' + JSON.stringify(node.children[0]));
    }
  }
  // The arriving leg carries the new value AND receives the tier ramp, since it
  // is the element that owns the paint while rolling.
  for (const node of incoming) {
    const cn = String(node.props.className);
    if (cn.indexOf('dms-labelGrad') === -1) {
      throw new Error('the arriving value does not own the tier ramp, so a rolling MAX would paint no gradient: ' + cn);
    }
    if (String(node.children[0]) !== 'Max') {
      throw new Error('the arriving leg does not carry the new value, got ' + JSON.stringify(node.children[0]));
    }
  }
  // ...and the carrier must have handed its own paint off while rolling.
  if (findAll(tree, (p) => typeof p.className === 'string' && p.className.indexOf('dms-rollHost') !== -1).length === 0) {
    throw new Error('the carrier kept its own clipped background during the roll, so the ink would be stranded');
  }

  // The roll must END: once its timer fires the outgoing leg unmounts and the
  // arriving value settles at its resting class.
  //
  // The timer is captured rather than waited on. `hookState` is module-level and
  // shared by every check, so a real `setTimeout` here would let the remaining
  // checks re-render the control and overwrite this component's hook slots before
  // the assertion ran — the failure then reports a value the roll never produced.
  // Firing the captured callback synchronously keeps the assertion inside this
  // check's own render sequence.
  const scheduled = [];
  const made2 = makeCtx({
    effortBox: box,
    settingsValue: { advancedEffort: true, effortStyle: 'spray-flow', trackShape: 'capsule' }
  });
  // The timer stub is handed to `loadModule`, not `makeCtx`: the sandbox
  // snapshots `setTimeout` by value, so the module only sees an injected
  // implementation when the sandbox is built.
  loadModule({
    timers: {
      setTimeout: (fn, delay) => { const h = { fn, delay, cleared: false }; scheduled.push(h); return h; },
      clearTimeout: (h) => { if (h && typeof h === 'object') h.cleared = true; }
    }
  }).apply(made2.ctx);
  const seat2 = seatOf(made2.registrations);
  const injected2 = seat2.options.inject('session-1');
  box.value = 'high';
  hookState.length = 0;
  let tree2 = expand(seat2.component({ ...injected2 }));
  findAll(tree2, (p) => p.className === 'dms-effortTrigger')[0].props.onClick();
  for (let i = 0; i < 4; i += 1) { runEffects(); resetHooks(); tree2 = expand(seat2.component({ ...injected2 })); }
  scheduled.length = 0;
  box.value = 'max';
  for (let i = 0; i < 4; i += 1) { runEffects(); resetHooks(); tree2 = expand(seat2.component({ ...injected2 })); }
  if (findAll(tree2, (p) => typeof p.className === 'string' && /dms-rollInUp|dms-rollOutUp/.test(p.className)).length === 0) {
    throw new Error('no roll was running, so the settle assertion below would be vacuous');
  }
  // Exactly ONE roll timer must be pending — a roll that schedules two would
  // clear the outgoing leg early on the first fire.
  const rollTimers = scheduled.filter((h) => h.delay === 260);
  if (rollTimers.length !== 1) {
    throw new Error('expected exactly one pending roll timer, got ' + rollTimers.length);
  }
  rollTimers[0].fn();
  runEffects(); resetHooks(); tree2 = expand(seat2.component({ ...injected2 }));
  if (findAll(tree2, (p) => typeof p.className === 'string' && /dms-rollInUp|dms-rollOutUp/.test(p.className)).length !== 0) {
    throw new Error('the roll never ended, so the outgoing value stays parked in the box');
  }
  const settled = findAll(tree2, (p) => typeof p.className === 'string' && p.className.indexOf('dms-rollVal') === 0);
  if (settled.length === 0) throw new Error('the tier value disappeared after the roll');
  for (const node of settled) {
    if (String(node.children[0]) !== 'Max') {
      throw new Error('after the roll the carrier shows ' + JSON.stringify(node.children[0]) + ', not the new tier');
    }
  }
  // ...and the carrier must have taken its own paint BACK once the roll ended:
  // the hand-off is scoped to the roll, so the settled DOM is the published
  // shape (carrier paints the ramp, inner span carries no class of its own). A
  // permanent `dms-rollHost` would mean the at-rest MAX was rendering through a
  // neutralised, `background-clip:border-box` carrier — a different look from the
  // one this plugin shipped before the roll existed.
  if (findAll(tree2, (p) => typeof p.className === 'string' && p.className.indexOf('dms-rollHost') !== -1).length !== 0) {
    throw new Error('the carrier still suppresses its own gradient after the roll ended');
  }
  for (const node of settled) {
    if (String(node.props.className).indexOf('dms-labelGrad') !== -1) {
      throw new Error('the settled inner value carries the tier ramp, so the at-rest look differs from the published one: ' + node.props.className);
    }
  }
  // The carrier itself must still hold the tier ramp, or the settled MAX would
  // have no gradient at all.
  const settledCarriers = findAll(tree2, (p) => typeof p.className === 'string'
    && /^dms-(effortValue|pillValue|panelValue)/.test(p.className));
  if (settledCarriers.length === 0) throw new Error('no tier-value carrier survived the roll');
  for (const node of settledCarriers) {
    if (String(node.props.className).indexOf('dms-labelGrad') === -1) {
      throw new Error('the settled carrier lost its tier ramp: ' + node.props.className);
    }
  }
});

// 4-pr4. Model picker float animation (ui: "给模型选择器的浮层也加一个出现和关闭
// 动画，参考思考强度的浮层"). The effort panel could always animate because its
// close is driven by a dedicated `effortClosing` state; the model menu had no
// such state and unmounted on the spot. Mirroring the panel means the menu must
// stay MOUNTED for the length of its exit — and that is exactly where the subtle
// failures live, so each one gets its own assertion:
//
//   1. THE EXIT IS UNREACHABLE. Unmounting on `setModelOpen(false)` would make
//      the closing animation dead code that still passes a CSS-only check.
//   2. THE MENU NEVER COMES BACK. While fading, `modelOpen` is still true, so a
//      trigger click that branches only on `modelOpen` calls close AGAIN —
//      reopening mid-fade would look like the click was ignored.
//   3. A LOST `animationend` STRANDS IT. The unmount is event-driven, so a
//      dropped event (interrupted animation, host quirk) needs a timer backstop.
//   4. THE PROVIDER PANEL IS A SIBLING. It does not inherit the menu's closing
//      class, so without its own it would sit at full opacity beside a fading
//      menu and then blink out when the menu unmounts.
check('the model float plays an enter and an exit, like the effort panel', () => {
  const css = (() => { injectedCss = ''; loadModule().apply(makeCtx({}).ctx); return injectedCss; })();
  const ruleOf = (sel) => {
    const at = css.indexOf(sel);
    if (at === -1) throw new Error('css rule missing: ' + sel);
    return css.slice(at, css.indexOf('}', at));
  };

  // --- the CSS half ----------------------------------------------------------
  for (const kf of ['dms-menu-in', 'dms-menu-out']) {
    const at = css.indexOf('@keyframes ' + kf);
    if (at === -1) throw new Error('missing keyframes: ' + kf);
    let depth = 0, i = css.indexOf('{', at);
    const start = i;
    for (; i < css.length; i += 1) {
      if (css[i] === '{') depth += 1;
      else if (css[i] === '}') { depth -= 1; if (depth === 0) break; }
    }
    const body = css.slice(start, i + 1);
    if (!/opacity:/.test(body)) throw new Error(kf + ' does not fade: ' + body);
    if (!/translateY\(/.test(body)) throw new Error(kf + ' does not travel: ' + body);
  }
  // The enter animation rides the base rule; the exit must OVERRIDE it. Both
  // selectors are single-class, so source order decides: the closing rule has to
  // come after its base rule or the menu would keep playing "in" while leaving.
  const menuAt = css.indexOf('.dms-menu{');
  const menuCloseAt = css.indexOf('.dms-menuClosing{');
  const subAt = css.indexOf('.dms-sub{');
  const subCloseAt = css.indexOf('.dms-subClosing{');
  if (menuCloseAt === -1) throw new Error('the menu has no closing rule, so it cannot animate out');
  if (subCloseAt === -1) throw new Error('the provider panel has no closing rule, so it would blink out instead of following the menu');
  if (!(menuCloseAt > menuAt)) throw new Error('the menu closing rule precedes its base rule; the enter animation would win the cascade');
  if (!(subCloseAt > subAt)) throw new Error('the panel closing rule precedes its base rule; the enter animation would win the cascade');
  if (!/animation:dms-menu-in/.test(ruleOf('.dms-menu{'))) {
    throw new Error('the menu has no enter animation');
  }
  // `forwards` holds the final transparent frame, or the float flashes back to
  // full opacity between the animation ending and the unmount.
  for (const sel of ['.dms-menuClosing{', '.dms-subClosing{']) {
    const body = ruleOf(sel);
    if (!/animation:dms-menu-out/.test(body)) throw new Error(sel + ' does not play the exit: ' + body);
    if (!/forwards/.test(body)) throw new Error(sel + ' does not hold its final frame, so it would flash before unmounting: ' + body);
    if (!/pointer-events:none/.test(body)) {
      throw new Error(sel + ' stays clickable while leaving: ' + body);
    }
  }
  // Reduced motion must neutralise BOTH directions.
  const rm = css.slice(css.indexOf('@media (prefers-reduced-motion:reduce)'));
  for (const sel of ['.dms-menu,', '.dms-menuClosing', '.dms-subClosing']) {
    if (rm.indexOf(sel) === -1) throw new Error('reduced motion does not cover ' + sel);
  }

  // --- the lifecycle half ----------------------------------------------------
  const timers = [];
  const made = makeCtx({});
  loadModule({
    timers: {
      setTimeout: (fn, delay) => { const h = { fn, delay, cleared: false }; timers.push(h); return h; },
      clearTimeout: (h) => { if (h && typeof h === 'object') h.cleared = true; }
    }
  }).apply(made.ctx);
  const seat2 = seatOf(made.registrations);
  const injected2 = seat2.options.inject('session-1');
  hookState.length = 0;
  let tree = expand(seat2.component({ ...injected2 }));
  const find = (t, cls) => findAll(t, (p) => typeof p.className === 'string' && p.className.split(' ').indexOf(cls) !== -1);
  const menuEl = (t) => find(t, 'dms-menu')[0];
  const settle = () => {
    for (let i = 0; i < 3; i += 1) { runEffects(); resetHooks(); tree = expand(seat2.component({ ...injected2 })); }
    return tree;
  };

  // Open with BOTH levels showing, so the sibling panel is in play.
  find(tree, 'dms-trigger')[0].props.onClick();
  settle();
  if (!menuEl(tree)) throw new Error('the menu did not open');
  find(tree, 'dms-arrow')[0].props.onClick({ stopPropagation() {}, preventDefault() {} });
  settle();
  if (!find(tree, 'dms-sub')[0]) throw new Error('the provider panel did not open');

  // (1) The exit must keep the float mounted, with the closing class. Timers are
  // cleared FIRST so the count below describes this close alone.
  timers.length = 0;
  find(tree, 'dms-trigger')[0].props.onClick();
  settle();
  const closing = menuEl(tree);
  if (!closing) throw new Error('the menu unmounted immediately, so the exit animation can never play');
  if (closing.props.className.indexOf('dms-menuClosing') === -1) {
    throw new Error('the menu is still mounted but not marked as closing: ' + closing.props.className);
  }
  const panelClosing = find(tree, 'dms-sub')[0];
  if (!panelClosing) throw new Error('the provider panel vanished before its exit could play');
  if (String(panelClosing.props.className).indexOf('dms-subClosing') === -1) {
    throw new Error('the provider panel is not marked as closing, so it would sit at full opacity beside the fading menu: ' + panelClosing.props.className);
  }
  // (3) A backstop timer must be armed while the animation is in flight. Count
  // only what THIS close armed: the array also holds timers from the opens and
  // closes driven above, and the effort panel / seat re-checks arm their own.
  const backstops = timers.filter((h) => h.delay === 380 && !h.cleared);
  if (backstops.length !== 1) {
    throw new Error('expected exactly one pending close backstop, got ' + backstops.length
      + ' (' + timers.map((h) => h.delay + (h.cleared ? 'c' : '')).join(',') + ')');
  }
  // An unrelated animation end (children bubble through here) must be ignored.
  menuEl(tree).props.onAnimationEnd({ animationName: 'dms-sheen' });
  settle();
  if (!menuEl(tree)) throw new Error('an unrelated animation end tore the menu down');
  // The real one unmounts both floats.
  menuEl(tree).props.onAnimationEnd({ animationName: 'dms-menu-out' });
  settle();
  if (menuEl(tree)) throw new Error('the menu ignored its own exit finishing');
  if (find(tree, 'dms-sub')[0]) throw new Error('the provider panel outlived the menu');

  // (2) Reopening mid-fade must CANCEL the exit, not race it. `modelOpen` is
  // still true during the fade, so a trigger handler that only checks it would
  // call close a second time — and the pending backstop would then remove the
  // menu the user just asked for.
  timers.length = 0;
  find(tree, 'dms-trigger')[0].props.onClick();
  settle();
  find(tree, 'dms-trigger')[0].props.onClick();      // begin the exit
  settle();
  if (String(menuEl(tree).props.className).indexOf('dms-menuClosing') === -1) {
    throw new Error('the exit did not start, so the reopen assertion below would be vacuous');
  }
  find(tree, 'dms-trigger')[0].props.onClick();      // reopen DURING the fade
  settle();
  const reopened = menuEl(tree);
  if (!reopened) throw new Error('reopening during the exit lost the menu entirely');
  if (reopened.props.className !== 'dms-menu') {
    throw new Error('reopened mid-fade, the menu kept a stale closing class (it would stay invisible): ' + reopened.props.className);
  }
  const leftover = timers.filter((h) => h.delay >= 300 && !h.cleared);
  if (leftover.length !== 0) {
    throw new Error('reopening left ' + leftover.length + ' stale close timer(s), which would tear the menu down ' + leftover[0].delay + 'ms after the user opened it');
  }
  // And the trigger must advertise the OPEN state again, not the fading one.
  const trigger = find(tree, 'dms-trigger')[0];
  if (trigger.props['aria-expanded'] !== true) {
    throw new Error('the trigger does not report the menu as expanded after reopening: ' + trigger.props['aria-expanded']);
  }
});

// 4g. 推理档位记忆: every model route keeps its OWN last-used effort tier.
//
// ui: "给模型选择器中选择的模型记住他最后的模型强度" — set DeepSeek V4.1 Flash to
// Max, switch to GLM 5.3 and set Low, come back to Flash and it must be Max again,
// and back to GLM and it must be Low. The two memories must not bleed into each
// other, and the tier must ride the SAME select call that changes the model (the
// contract the shipped directory already offers), not a second round-trip that
// would flash the model's default tier first.
check('each model route remembers its own last effort tier', () => {
  const helpers = loadModule().__test;
  if (!helpers || !helpers.dmsEffortRestore) throw new Error('the effort memory is not exported for testing');
  const EFFORT_KEY = helpers.DMS_EFFORT_KEY;

  const fakeStore = (initial) => {
    const data = Object.assign({}, initial || {});
    return {
      getItem: (k) => (Object.prototype.hasOwnProperty.call(data, k) ? data[k] : null),
      setItem: (k, v) => { data[k] = String(v); },
      removeItem: (k) => { delete data[k]; },
      dump: () => data
    };
  };

  // A two-model fixture with DIFFERENT ladders, which is what makes the routing
  // decision observable: Flash offers high/max, GLM offers low/high.
  const FLASH = { id: 'deepseek-v4-flash', name: 'DeepSeek V4.1 Flash', reasoning: { defaultEffort: 'high', efforts: [{ id: 'high', name: 'High' }, { id: 'max', name: 'Max' }] } };
  const GLM = { id: 'glm-5-3', name: 'GLM 5.3', reasoning: { defaultEffort: 'low', efforts: [{ id: 'low', name: 'Low' }, { id: 'high', name: 'High' }] } };
  const NO_REASONING = { id: 'plain-model', name: 'Plain Model' };
  const TWO = [
    { id: 'provider-a', name: 'Provider A', models: [FLASH] },
    { id: 'provider-b', name: 'Provider B', models: [GLM] },
    { id: 'provider-c', name: 'Provider C', models: [NO_REASONING] }
  ];

  // --- the key is the ROUTE, never the display name -------------------------
  // Both providers can publish the same NAME; a name-keyed tier would hand one
  // route's ladder position to another. The key must therefore differ.
  if (helpers.dmsEffortKey('provider-a', 'deepseek-v4-flash') === helpers.dmsEffortKey('provider-b', 'deepseek-v4-flash')) {
    throw new Error('the effort key ignores the provider, so two routes sharing a model id would share one tier');
  }
  if (helpers.dmsEffortKey('provider-a', 'deepseek-v4-flash') === helpers.dmsEffortKey('provider-a', 'glm-5-3')) {
    throw new Error('the effort key ignores the model id');
  }

  // --- dmsEffortRestore validates against the TARGET model's ladder ---------
  // A stored tier that the model no longer offers must NOT be handed back: a
  // provider can re-publish its list with a shorter ladder, and sending a stale
  // id would ask the host for a tier the model cannot mean.
  const store = fakeStore();
  const scope = { localStorage: store };
  // Drive the store through the exported seam with a fresh module instance.
  loadModule({ window: scope });
  const remembered = loadModule({ window: scope }).__test;
  remembered.dmsEffortRemember('provider-a', 'deepseek-v4-flash', 'max');
  if (remembered.dmsEffortRecall('provider-a', 'deepseek-v4-flash') !== 'max') {
    throw new Error('a recorded tier did not come back');
  }
  if (remembered.dmsEffortRestore('provider-a', FLASH) !== 'max') {
    throw new Error('a tier that IS on the model ladder was not restored');
  }
  if (remembered.dmsEffortRestore('provider-a', GLM) !== null) {
    throw new Error('a tier from another ladder was restored: the ladder check is not applied');
  }
  if (remembered.dmsEffortRestore('provider-c', NO_REASONING) !== null) {
    throw new Error('a model with no reasoning block was handed a tier');
  }
  if (remembered.dmsEffortRestore('provider-b', GLM) !== null) {
    throw new Error('a route with no memory of its own answered for another route');
  }
  // The stored pair really reached the browser store under its own key, and it is
  // a route map — not the provider memory's name map.
  const wrote = store.dump()[EFFORT_KEY];
  if (typeof wrote !== 'string' || wrote.indexOf('max') === -1 || wrote.indexOf('deepseek-v4-flash') === -1) {
    throw new Error('the tier never reached the browser store: ' + JSON.stringify(wrote));
  }
  if (store.dump()['dsh-modef.provider-memory.v1'] !== undefined) {
    throw new Error('the tier was written into the PROVIDER memory key, which is keyed by name and would cross routes');
  }
  // Re-recording the SAME tier must be a no-op rather than a redundant write:
  // `localStorage.setItem` is synchronous and this is called on a tier commit,
  // so the guard is what keeps an unchanged value from re-serialising the whole
  // map. Counted on the real store, not inferred from the source.
  let setCalls = 0;
  const countingStore = {
    data: {},
    getItem(k) { return Object.prototype.hasOwnProperty.call(this.data, k) ? this.data[k] : null; },
    setItem(k, v) { setCalls += 1; this.data[k] = String(v); },
    removeItem(k) { delete this.data[k]; }
  };
  const counted = loadModule({ window: { localStorage: countingStore } }).__test;
  counted.dmsEffortRemember('provider-a', 'deepseek-v4-flash', 'max');
  const afterFirst = setCalls;
  counted.dmsEffortRemember('provider-a', 'deepseek-v4-flash', 'max');
  if (setCalls !== afterFirst) {
    throw new Error('re-recording the same tier wrote to the store again (' + afterFirst + ' -> ' + setCalls + '), which is a needless synchronous write on every commit');
  }
  // …while a DIFFERENT tier on the same route must still be written.
  counted.dmsEffortRemember('provider-a', 'deepseek-v4-flash', 'high');
  if (setCalls !== afterFirst + 1) {
    throw new Error('changing a route\'s tier did not reach the store (' + afterFirst + ' -> ' + setCalls + ')');
  }
  if (counted.dmsEffortRecall('provider-a', 'deepseek-v4-flash') !== 'high') {
    throw new Error('the changed tier did not replace the old one');
  }
  // An empty / non-string tier id is refused outright rather than stored.
  const beforeJunk = setCalls;
  counted.dmsEffortRemember('provider-a', 'deepseek-v4-flash', '');
  counted.dmsEffortRemember('provider-a', 'deepseek-v4-flash', undefined);
  if (setCalls !== beforeJunk) {
    throw new Error('a junk tier id was written into the store');
  }
  if (counted.dmsEffortRecall('provider-a', 'deepseek-v4-flash') !== 'high') {
    throw new Error('a junk tier id overwrote a real one');
  }

  // --- the ladder check runs on every REcall, so a shorter ladder wins -------
  // `max` is remembered for Flash, then Flash is re-published WITHOUT it: the
  // restore must fall to null (the host's own defaultEffort takes over) rather
  // than send a tier that no longer exists.
  const SHORTER = { id: 'deepseek-v4-flash', name: 'DeepSeek V4.1 Flash', reasoning: { defaultEffort: 'high', efforts: [{ id: 'high', name: 'High' }] } };
  if (remembered.dmsEffortRestore('provider-a', SHORTER) !== null) {
    throw new Error('a tier that vanished from the ladder was still restored');
  }

  // --- end to end: the two halves the user actually sees --------------------
  // Part A: committing a tier from the open panel RECORDS it against the current
  // route. Part B: a fresh mount hands each route its own tier back on the very
  // select call that changes the model.
  //
  // `current` is a MUTABLE holder the mock re-reads on every snapshot, so a test
  // can make one route current and then another — the only way to drive "commit a
  // tier for this model" through the real panel.
  const mountFresh = (win, cur) => {
    const made = makeCtx({ current: cur, groups: TWO, settingsValue: { advancedEffort: true, effortStyle: 'spray-flow' } });
    loadModule({ window: win }).apply(made.ctx);
    const seat = seatOf(made.registrations);
    const injected = seat.options.inject('session-1');
    hookState.length = 0;
    let tree = expand(seat.component({ ...injected }));
    const settle = () => {
      for (let i = 0; i < 4; i += 1) { runEffects(); resetHooks(); tree = expand(seat.component({ ...injected })); }
      return tree;
    };
    const click = (cls, match) => {
      const found = findAll(tree, (p) => typeof p.className === 'string' && p.className.split(' ').indexOf(cls) !== -1);
      const el = match ? found.find(match) : found[0];
      if (!el) throw new Error('could not find ' + cls + ' in the fixture tree');
      el.props.onClick({ stopPropagation() {}, preventDefault() {} });
      settle();
      return el;
    };
    return { made, tree: () => tree, settle, click };
  };
  const sliderIn = (t) => findAll(t, (p) => typeof p.className === 'string' && /\bdms-slider\b/.test(p.className))[0];

  // --- Part A: a committed tier is remembered for the CURRENT route ---------
  // `current` must name a route that EXISTS in the fixture: the effort control is
  // driven by `currentChoice.model.reasoning` (the ladder comes from the model),
  // so a current route the directory does not list renders no slider at all.
  const liveStore = fakeStore();
  const win = { localStorage: liveStore };
  const curA = { provider: 'provider-a', model: 'deepseek-v4-flash', reasoningEffort: 'high' };
  const A = mountFresh(win, curA);
  A.click('dms-effortTrigger');
  const sliderA = sliderIn(A.tree());
  if (!sliderA) throw new Error('the effort slider did not open, so no tier can be committed');
  sliderA.props.ref({ clientWidth: 200, getBoundingClientRect: () => ({ left: 0, width: 200 }) });
  sliderA.props.onKeyDown({ key: 'End', preventDefault() {} });
  const committed = A.made.selects[A.made.selects.length - 1];
  if (!committed || committed.reasoningEffort !== 'max') {
    throw new Error('driving to the last tier did not commit Max: ' + JSON.stringify(committed));
  }
  const afterCommit = liveStore.dump()[EFFORT_KEY];
  if (typeof afterCommit !== 'string' || afterCommit.indexOf('max') === -1) {
    throw new Error('committing a tier did not remember it against the route: ' + JSON.stringify(afterCommit));
  }
  if (afterCommit.indexOf('deepseek-v4-flash') === -1) {
    throw new Error('the tier was stored without the model id, so two routes could collide: ' + JSON.stringify(afterCommit));
  }
  // The memory is keyed by the ROUTE, so the record must carry provider-a — the
  // provider that actually owns this model in the fixture.
  if (afterCommit.indexOf('provider-a') === -1) {
    throw new Error('the tier was stored without the provider, so two providers sharing a model id would collide: ' + JSON.stringify(afterCommit));
  }

  // --- Part B: each route restores its OWN tier on switch-back --------------
  // The user's exact scenario: Flash=Max, GLM=Low, and switching between them
  // must land on each model's own rung instead of one shared global effort.
  const seeded = loadModule({ window: win }).__test;
  seeded.dmsEffortRemember('provider-b', 'glm-5-3', 'low');
  // Current is a THIRD route, so both clicks below are real switches.
  const curB = { provider: 'provider-c', model: 'plain-model', reasoningEffort: undefined };

  const B = mountFresh(win, curB);
  B.click('dms-trigger');                       // the rows only exist once open
  B.click('dms-option', (r) => r.props.title === 'DeepSeek V4.1 Flash');
  const backToFlash = B.made.selects[B.made.selects.length - 1];
  if (!backToFlash || backToFlash.model !== 'deepseek-v4-flash') {
    throw new Error('clicking the Flash row did not select it: ' + JSON.stringify(backToFlash));
  }
  if (backToFlash.reasoningEffort !== 'max') {
    throw new Error('coming back to Flash did not restore its own Max: ' + JSON.stringify(backToFlash));
  }

  const C = mountFresh(win, curB);
  C.click('dms-trigger');
  C.click('dms-option', (r) => r.props.title === 'GLM 5.3');
  const backToGlm = C.made.selects[C.made.selects.length - 1];
  if (!backToGlm || backToGlm.model !== 'glm-5-3') {
    throw new Error('clicking the GLM row did not select it: ' + JSON.stringify(backToGlm));
  }
  if (backToGlm.reasoningEffort !== 'low') {
    throw new Error('coming back to GLM did not restore ITS Low, not Flash\'s Max: ' + JSON.stringify(backToGlm));
  }
  // The isolation, stated as an inequality too: the two routes must not have
  // answered with the same tier, which is exactly the bug this feature fixes.
  if (backToGlm.reasoningEffort === backToFlash.reasoningEffort) {
    throw new Error('both routes restored the SAME tier, so the memory is not per-model');
  }
});

// 4h. The effort memory degrades safely: a hostile, absent or malformed store
// must cost persistence only. The picker is a composer control — a convenience
// feature must never be able to kill the seat.
check('the effort memory survives a hostile or malformed store', () => {
  const FLASH = { id: 'deepseek-v4-flash', name: 'DeepSeek V4.1 Flash', reasoning: { defaultEffort: 'high', efforts: [{ id: 'high', name: 'High' }, { id: 'max', name: 'Max' }] } };
  const TWO = [
    { id: 'provider-a', name: 'Provider A', models: [FLASH] },
    { id: 'provider-b', name: 'Provider B', models: [{ id: 'glm-5-3', name: 'GLM 5.3', reasoning: { defaultEffort: 'low', efforts: [{ id: 'low', name: 'Low' }] } }] }
  ];
  // A route that is neither of the two rows below, so both clicks are real
  // switches rather than the "already current" no-op.
  const CUR = { provider: 'provider-z', model: 'other', reasoningEffort: 'low' };
  const pickGlm = (win) => {
    const made = makeCtx({ current: CUR, groups: TWO, settingsValue: { advancedEffort: true, effortStyle: 'spray-flow' } });
    loadModule({ window: win }).apply(made.ctx);
    const seat = seatOf(made.registrations);
    const injected = seat.options.inject('session-1');
    hookState.length = 0;
    let tree = expand(seat.component({ ...injected }));
    const settle = () => { for (let i = 0; i < 4; i += 1) { runEffects(); resetHooks(); tree = expand(seat.component({ ...injected })); } };
    const byClass = (cls) => findAll(tree, (p) => typeof p.className === 'string' && p.className.split(' ').indexOf(cls) !== -1);
    // The rows only exist once the menu is open.
    const trigger = byClass('dms-trigger')[0];
    if (!trigger) throw new Error('the model trigger never rendered, so the store was fatal before selection');
    trigger.props.onClick({ stopPropagation() {}, preventDefault() {} });
    settle();
    const row = byClass('dms-option').find((r) => r.props.title === 'GLM 5.3');
    if (!row) throw new Error('the GLM row never rendered, so the store was fatal before selection');
    row.props.onClick({ stopPropagation() {}, preventDefault() {} });
    return made;
  };
  // A store that throws on EVERY access must still let the user pick a model.
  const boom = () => { throw new Error('storage blocked'); };
  const hostile = pickGlm({ localStorage: { getItem: boom, setItem: boom, removeItem: boom } });
  const hostileSel = hostile.selects[hostile.selects.length - 1];
  if (!hostileSel || hostileSel.model !== 'glm-5-3') {
    throw new Error('a hostile store broke model selection: ' + JSON.stringify(hostile.selects));
  }
  // A malformed value must be IGNORED, not thrown on, and must not invent a tier.
  const malformed = pickGlm({ localStorage: { getItem: () => '{not json', setItem: () => {}, removeItem: () => {} } });
  const malformedSel = malformed.selects[malformed.selects.length - 1];
  if (!malformedSel || malformedSel.model !== 'glm-5-3') {
    throw new Error('a malformed stored value broke model selection: ' + JSON.stringify(malformed.selects));
  }
  if (malformedSel.reasoningEffort !== undefined) {
    throw new Error('a malformed stored value produced a tier: ' + JSON.stringify(malformedSel));
  }
  // And with NO store at all (a non-browser/degraded host), selection still works.
  const absent = pickGlm({});
  const absentSel = absent.selects[absent.selects.length - 1];
  if (!absentSel || absentSel.model !== 'glm-5-3') {
    throw new Error('an absent store broke model selection: ' + JSON.stringify(absent.selects));
  }
});

const seat7 = seatOf(ctx7.registrations);
const injected7 = seat7.options.inject('session-1');


// commit 1: no directory yet 鈥?the control must render, not throw
renderNode(seat7.component(injected7), 0);
let cleanups = runEffects();
for (const c of cleanups) c();
if (state.loadCalls !== 0) throw new Error('unexpected load before the directory existed');

setTimeout(() => {
  state.directoryThrows = false;      // the session is now addressable
  renderNode(seat7.component(injected7), 0);
  const cleanups2 = runEffects();
  for (const c of cleanups2) c();
  check('late directory still triggers the model-catalog load', () => {
    if (state.loadCalls < 1) throw new Error('load() was never called after the directory resolved');
  });
  check('the control reads the resolved directory store', () => {
    if (injected7.resolveDirectory() === null) throw new Error('resolveDirectory still failing');
  });
  // Wait for the async checks before reporting: a check that settles after the
  // summary would be counted nowhere.
  Promise.all(pending).then(() => {
    console.log(failures === 0 ? 'SMOKE OK (' + total + '/' + total + ')' : 'SMOKE FAILED: ' + failures + '/' + total);
    process.exit(failures === 0 ? 0 : 1);
  });
}, 300);
