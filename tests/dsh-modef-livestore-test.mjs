// =============================================================================
// STATUS: HISTORICAL — DOES NOT EXERCISE THE CURRENT IMPLEMENTATION.
//
// These two files were added by the contributor's PR #2 ("fix: DSH 0.1.2-alpha
// compatibility + cold-boot blank seat") against the 0.2.x architecture, and are
// kept verbatim as a record of that work.
//
// As of v0.9.0 the client was rebuilt on the newer plugin contract
// (`configForms` instead of `settingsScope`, `plugins.item` instead of
// `settings.plugin.item`), and the per-session live-store helper these tests
// mirror (`makeLiveDirectoryStore` / `liveStore`) NO LONGER EXISTS in
// `lib/client.js`. The cold-boot concern they guard is still covered, by a
// different mechanism: the seat resolves its directory LAZILY on every render
// and retries with a bounded 500ms loop (`resolveDirectory` /
// `seatRetryRef.current >= 40`) instead of subscribing to a live store.
//
// Do not read a PASS here as evidence about v0.9.0, and do not read a FAIL as a
// regression. The current gate is `node test/smoke.cjs` (65 checks).
// =============================================================================
// 0.2.4 live-store cold-boot regression harness.
// Simulates: component subscribes to a live store BEFORE the session directory
// resolves (cold boot), then the directory materializes later, poke fires, and
// the subscriber must observe the real snapshot. Also tests multi-session
// isolation (two sessionIds never cross-contaminate).
"use strict";

const SAFE_SNAPSHOT = { current: null, groups: [], failures: [], status: "idle", error: null };

function makeDirStore(label) {
  const listeners = new Set();
  let snap = { current: null, groups: [], failures: [], status: "loading", error: null, label };
  return {
    label,
    subscribe(fn) { listeners.add(fn); return () => listeners.delete(fn); },
    getSnapshot() { return snap; },
    _set(next) { snap = next; for (const fn of listeners) fn(); }
  };
}

// Mirror of makeLiveDirectoryStore from client.js (minus the DOM bits)
// NOTE: CURRENT_DIRECTORIES holds ModelDirectory-like objects { store } —
// the real code stores `directoryFor()` results which expose `.store`.
function makeLiveDirectoryStore(sessionId, currentDirs) {
  let lastSnapshot = SAFE_SNAPSHOT;
  let lastDirectory = void 0;
  let lastSubscription = null;
  const listeners = new Set();
  const notify = function () { for (const fn of Array.from(listeners)) fn(); };
  const dirOf = function () { const d = currentDirs.get(sessionId); return d !== void 0 ? d.store : void 0; };
  const refresh = function () {
    const store = dirOf();
    lastDirectory = store;
    lastSnapshot = store !== void 0 ? store.getSnapshot() : SAFE_SNAPSHOT;
  };
  const store = {
    subscribe(fn) {
      listeners.add(fn);
      const real = dirOf();
      if (real !== void 0) {
        if (lastSubscription !== null) lastSubscription();
        lastSubscription = real.subscribe(fn);
      }
      return function () {
        listeners.delete(fn);
        if (lastSubscription !== null) { lastSubscription(); lastSubscription = null; }
      };
    },
    getSnapshot() { refresh(); return lastSnapshot; }
  };
  store.poke = function () {
    refresh();
    const real = dirOf();
    if (real !== void 0 && lastSubscription === null && listeners.size > 0) {
      const forward = function () { notify(); };
      lastSubscription = real.subscribe(forward);
    }
    notify();
  };
  return store;
}

let pass = 0, fail = 0;
function assert(name, cond) {
  if (cond) { pass++; console.log("  PASS", name); }
  else { fail++; console.log("  FAIL", name); }
}

// ---- Test 1: cold boot — subscribe before directory resolves ----
console.log("Test 1: cold-boot wakeup");
{
  const dirs = new Map();
  const store = makeLiveDirectoryStore("s1", dirs);
  let renders = 0, lastSeen = null;
  // component subscribes (like useDirectoryState)
  const sub = store.subscribe(() => { renders++; lastSeen = store.getSnapshot(); });
  assert("initial snapshot is SAFE", store.getSnapshot() === SAFE_SNAPSHOT);

  // directory materializes later (modelDirectories.directoryFor succeeds)
  const realDir = makeDirStore("real-s1");
  dirs.set("s1", {store: realDir});
  // inject factory retry tick calls poke
  store.poke();

  assert("poke notified subscriber (renders=1)", renders === 1);
  assert("subscriber saw real snapshot", lastSeen === realDir.getSnapshot());
  assert("getSnapshot now returns real snapshot", store.getSnapshot() === realDir.getSnapshot());

  // real directory store changes must now flow through the forwarded subscription
  realDir._set({ current: null, groups: [{ id: "g", models: [{ id: "m" }] }], failures: [], status: "ready", error: null, label: "real-s1" });
  assert("real store event flows through (renders=2)", renders === 2);
  assert("subscriber saw updated snapshot", lastSeen && lastSeen.status === "ready");
  sub();
}

// ---- Test 2: multi-session isolation ----
console.log("Test 2: multi-session isolation");
{
  const dirs = new Map();
  const s1 = makeLiveDirectoryStore("s1", dirs);
  const s2 = makeLiveDirectoryStore("s2", dirs);
  let s1renders = 0, s2renders = 0;
  const sub1 = s1.subscribe(() => { s1renders++; });
  const sub2 = s2.subscribe(() => { s2renders++; });

  const d1 = makeDirStore("d1"); dirs.set("s1", {store: d1});
  const d2 = makeDirStore("d2"); dirs.set("s2", {store: d2});
  s1.poke(); s2.poke();
  assert("s1 woke", s1renders === 1);
  assert("s2 woke", s2renders === 1);
  assert("s1 sees d1 snapshot", s1.getSnapshot() === d1.getSnapshot());
  assert("s2 sees d2 snapshot", s2.getSnapshot() === d2.getSnapshot());

  d1._set({ current: null, groups: [{ id: "x" }], failures: [], status: "ready", error: null });
  assert("d1 event only woke s1 (s1=2, s2=1)", s1renders === 2 && s2renders === 1);
  sub1(); sub2();
}

// ---- Test 3: subscribe AFTER resolution works directly ----
console.log("Test 3: subscribe after resolution");
{
  const dirs = new Map();
  const d = makeDirStore("d"); dirs.set("s9", {store: d});
  const store = makeLiveDirectoryStore("s9", dirs);
  let n = 0;
  const sub = store.subscribe(() => n++);
  assert("sees real snapshot immediately", store.getSnapshot() === d.getSnapshot());
  d._set({ current: null, groups: [], failures: [], status: "ready", error: null });
  assert("event flows (n=1)", n === 1);
  sub();
}

// ---- Test 4: poke with no listeners is safe ----
console.log("Test 4: poke without listeners");
{
  const dirs = new Map();
  const store = makeLiveDirectoryStore("s0", dirs);
  const d = makeDirStore("d"); dirs.set("s0", {store: d});
  store.poke(); // no listeners — must not throw
  assert("no-throw poke", true);
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail === 0 ? 0 : 1);
