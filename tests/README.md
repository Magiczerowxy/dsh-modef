# tests/ — historical regression files

**These files are not part of the current test gate.** They are kept verbatim as a
record of the contributor's PR #2 ("fix: DSH 0.1.2-alpha compatibility + cold-boot
blank seat", against the 0.2.x architecture).

| File | Written against | Status |
| --- | --- | --- |
| `dsh-modef-coldboot-test.mjs` | 0.2.4 | historical |
| `dsh-modef-livestore-test.mjs` | 0.2.4 | historical |

They mirror `makeLiveDirectoryStore` / `liveStore`, which **no longer exist** in
`lib/client.js` since the v0.9.0 rebuild (`configForms` instead of
`settingsScope`, `plugins.item` instead of `settings.plugin.item`).

The cold-boot concern they guard is still handled — by a different mechanism: the
composer seat resolves its directory **lazily on every render** and retries with a
bounded 500 ms loop (`resolveDirectory` / `seatRetryRef.current >= 40`) in
`lib/client.js`.

## The real gate

```bash
node test/smoke.cjs     # 65 checks, 62 passing
```

The 3 failures are known and unrelated to the runtime: two assert the settings
card has exactly 3 switches (a 4th, TPS, was added later) and one rejects any
`setInterval` outright (the TPS sampler legitimately uses one; it does not write
the settings document).

So: a **PASS** in this directory is not evidence about v0.9.0, and a **FAIL** is
not a regression.
