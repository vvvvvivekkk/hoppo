# Student app (Expo) — parked, partially built

**Status: not working. Do not expect this to run.** Parked deliberately in
favour of `apps/web`, which delivers the same student flow in a browser and
runs today.

## Why it is parked

Two React versions cannot coexist in this monorepo's current layout.

Expo 52 pins React 18.3. The Next.js consoles (`apps/dashboard`, `apps/admin`)
are on React 19. `.npmrc` sets `node-linker=hoisted`, which pnpm needs for
Metro to resolve modules reliably — and hoisting means exactly one copy of
`@types/react` at the repo root. React 19's types win, and every Expo
component then fails to typecheck:

```
app/(tabs)/_layout.tsx: error TS2786: 'Tabs' cannot be used as a JSX component.
  Type 'bigint' is not assignable to type 'ReactNode'.
```

That `bigint` is the giveaway: React 19 widened `ReactNode` to include it, so
React 18's narrower `ReactNode` no longer satisfies it.

The real fixes are all structural, and none is a five-minute change:

1. **Move the mobile app out of the workspace** into its own repo or a nested
   install, consuming `@hoppo/api-client` as a published package rather than a
   workspace link. Cleanest, and the usual answer.
2. **Drop `node-linker=hoisted`** so pnpm's isolated layout gives each app its
   own `@types/react`. Metro then needs careful `resolver` configuration and
   tends to break in ways that are tedious to diagnose.
3. **Wait for Expo to support React 19** and move everything to one version.

None of that changes what a student can do, which is why the browser app came
first.

## What is here

Written and worth keeping, but unverified:

| File | What it is |
|---|---|
| `src/lib/theme.ts` | Colours, spacing, the 48 px touch target floor |
| `src/lib/tokens.ts` | Tokens in `expo-secure-store` — Keychain / Keystore, not a plain file |
| `src/lib/api.tsx` | Provider over `@hoppo/api-client`, with the async-token startup problem handled |
| `src/lib/socket.ts` | Socket.IO client for task offers, with stale-offer dropping |
| `src/components/ui.tsx` | Button, Field, Card, Chip, Banner — all above the `NFR-U-04` floor |
| `app/index.tsx` | `S-01` auth gate, routing by verification status |
| `app/(auth)/*` | `S-02`–`S-06`: welcome, phone with OTP, college picker, profile |
| `app/(verify)/status.tsx` | `S-08`/`S-09`: waiting and rejected, with attempts left |
| `app/(tabs)/*` | `UI-1` bottom navigation, and `S-10`/`S-11` shop browse |

Two pieces of reasoning in here are worth reading even if the app never runs,
because `apps/web` reuses both: the socket client drops an offer whose window
has already closed (a reconnect can deliver a stale one, and a countdown
starting at zero invites a tap that fails), and the token store keeps an
in-memory cache because `SecureStore` is async while the client's `get()` is
synchronous.

## Resuming it

The web app is the reference for behaviour — it covers the same screens and
is tested against the live API. Pick a structural fix above, then port the
flows across rather than rebuilding them.

Excluded from the root `typecheck` and `build` scripts so it cannot fail CI
while parked. That exclusion is the thing to remove first.
