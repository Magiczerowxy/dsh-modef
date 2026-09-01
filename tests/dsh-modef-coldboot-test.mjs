// 0.2.4 cold-boot regression — mirrors the REAL client.js live-store logic
// with a ModelDirectory-shaped contract:
//   directoryFor(sessionId) THROWS until the session scope materializes,
//   then returns { store: ObservableStore }.
"use strict";

// ---- Observable store (shaped like dsh's observable) ----
function createStore(initial) {
  let snap = initial;
  const listeners = new Set();
  return {
    getSnapshot: () => snap,
    subscribe(fn) { listeners.add(fn); return () => listeners.delete(fn); },
    set(next) { snap = next; for (const f of listeners) f(); }
  };
}

const SAFE_SNAPSHOT = { current: null, groups: [], failures: [], status: "idle", error: null };

// ---- THE REAL makeLiveDirectoryStore (copied verbatim from client.js 0.2.4) ----
function makeLiveDirectoryStore(sessionId, CURRENT_DIRECTORIES) {
  let lastSnapshot = SAFE_SNAPSHOT;
  let lastDirectory = void 0;
  let lastSubscription = null;
  const listeners = new Set();
  const notify = function () { for (const fn of Array.from(listeners)) fn(); };
  const refresh = function () {
    const dir = CURRENT_DIRECTORIES.get(sessionId);
    lastDirectory = dir;
    lastSnapshot = dir !== void 0 ? dir.store.getSnapshot() : SAFE_SNAPSHOT;
  };
  const store = {
    subscribe: function (fn) {
      listeners.add(fn);
      const dir = CURRENT_DIRECTORIES.get(sessionId);
      if (dir !== void 0) {
        if (lastSubscription !== null) lastSubscription();
        lastSubscription = dir.store.subscribe(fn);
      }
      return function () {
        listeners.delete(fn);
        if (lastSubscription !== null) { lastSubscription(); lastSubscription = null; }
      };
    },
    getSnapshot: function () { refresh(); return lastSnapshot; }
  };
  store.poke = function () {
    refresh();
    const dir = CURRENT_DIRECTORIES.get(sessionId);
    if (dir !== void 0 && lastSubscription === null && listeners.size > 0) {
      const forward = function () { notify(); };
      lastSubscription = dir.store.subscribe(forward);
    }
    notify();
  };
  return store;
}

// ---- Simulate the inject factory's cold-boot path (from client.js) ----
function coldBootSim() {
  const CURRENT_DIRECTORIES = new Map();
  const logs = [];
  let scopeReady = false; // session scope materializes after 1.2s

  // modelDirectories.directoryFor — throws until scope ready
  const directoryFor = (sessionId) => {
    if (!scopeReady) throw new Error(`session "${sessionId}" resolved no scope`);
    const existing = CURRENT_DIRECTORIES.get(sessionId);
    if (existing) return existing;
    const store = createStore({ current: null, groups: [], failures: [], status: "loading", error: null });
    const dir = { store };
    CURRENT_DIRECTORIES.set(sessionId, dir);
    return dir;
  };

  // ---- THE INJECT FACTORY (0.2.4 logic, verbatim shape) ----
  function injectFactory(sessionId) {
    const liveStore = makeLiveDirectoryStore(sessionId, CURRENT_DIRECTORIES);
    const resolve = function () {
      let dir = CURRENT_DIRECTORIES.get(sessionId);
      if (dir !== void 0) return dir;
      try { dir = directoryFor(sessionId); } catch (err) { return void 0; }
      if (dir !== void 0) CURRENT_DIRECTORIES.set(sessionId, dir);
      return dir;
    };
    const firstAvailable = resolve() !== void 0;
    const notSubagent = true; // sessions.subagentAddress(sessionId) === undefined
    if (!firstAvailable) {
      let tries = 0;
      const tick = function () {
        const dir = resolve();
        if (dir !== void 0) { liveStore.poke(); return; }
        if (++tries < 240) setTimeout(tick, 500);
      };
      setTimeout(tick, 500);
    } else {
      liveStore.poke();
    }
    return { available: notSubagent, directory: liveStore };
  }

  // ---- THE COMPONENT (0.2.4 logic, simplified) ----
  let renders = 0, states = [];
  const face = injectFactory("sess-1");

  // component render loop
  function render() {
    renders++;
    const state = face.directory.getSnapshot();
    const resolved = state && state !== SAFE_SNAPSHOT;
    const liveAvailable = resolved && face.available;
    states.push({ renders, resolved, liveAvailable, status: state.status });
    if (liveAvailable) { /* control renders */ } else { /* renders null */ }
  }
  // subscribe like useDirectoryState
  face.directory.subscribe(render);
  render(); // mount

  // ---- timeline ----
  // t=0: mount, scope not ready
  setTimeout(() => {
    console.log("t≈0.5s:", JSON.stringify(states[states.length-1]));
    // t=1.2s: scope materializes — the retry tick resolves + pokes
    setTimeout(() => {
      scopeReady = true;
      // the retry tick (armed at mount, fires every 500ms) will now succeed
      // and poke the live store → render() fires with resolved=true
      setTimeout(() => {
        console.log("t≈1.8s (after scope):", JSON.stringify(states[states.length-1]));
        // Now simulate the directory store loading models
        const dir = CURRENT_DIRECTORIES.get("sess-1");
        dir.store.set({ current: null, groups: [{ id: "deepseek", models: [{ id: "flash", name: "DeepSeek-V4-Flash" }] }], failures: [], status: "ready", error: null });
        setTimeout(() => {
          console.log("t≈2s (models loaded):", JSON.stringify(states[states.length-1]));
          const last = states[states.length-1];
          const ok = last.liveAvailable === true && last.status === "ready" && last.resolved === true;
          console.log(ok ? "\n=== COLD BOOT OK: control renders without re-toggle ===" : "\n=== COLD BOOT FAILED ===");
          console.log("total renders:", renders);
          process.exit(ok ? 0 : 1);
        }, 100);
      }, 600);
    }, 1200);
  }, 500);
}

coldBootSim();
