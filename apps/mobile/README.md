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

The real fixes are all structural:

1. **Take the mobile app out of the workspace**, so its dependencies are never
   hoisted, and install it on its own when somebody picks it up. Cleanest, and
   the usual answer.
2. **Drop `node-linker=hoisted`** so pnpm's isolated layout gives each app its
   own `@types/react`. Metro then needs careful `resolver` configuration and
   tends to break in ways that are tedious to diagnose.
3. **Wait for Expo to support React 19** and move everything to one version.

None of that changes what a student can do, which is why the browser app came
first.

## Fix 1 has been applied, and it was not optional

`pnpm-workspace.yaml` now excludes `apps/mobile`. That was not tidiness. While
this app was a workspace member, React 18.3 won the single hoisted copy at the
repository root, and **every Next.js build broke** — not just this app's
typecheck:

```
[TypeError: Cannot read properties of null (reading 'useRef')]
Error occurred prerendering page "/404"
```

The shop dashboard built cleanly at the end of Phase 1E and failed after this
app was added, with nothing of its own changed. Excluding it from the scripts
was not enough, because the scripts were never the problem: the *install* was.
One unbuildable app in a hoisted workspace is a problem for every app in it.

## Running this app again

It is no longer installed by the repository root, so:

```bash
cd apps/mobile
npm install          # or pnpm install --ignore-workspace
npx expo start
```

`@hoppo/shared` and `@hoppo/api-client` are workspace links in its
`package.json` and will not resolve from outside the workspace. They have to
become file references, a published package, or copied source — which is the
first thing to deal with, before the React version question.

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

The web app is the reference for behaviour. Two pieces of reasoning in here are
worth keeping even if this app never runs, and `apps/web` reuses both: the
socket client drops an offer whose window has already closed, and the token
store keeps an in-memory cache because `SecureStore` is async while the
client's `get()` is synchronous.
