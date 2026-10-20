# ADR 0003: Vite + React single-page app instead of Next.js

Status: accepted

**Context.** The backend is a separate API; the web app needs no server rendering. Development hardware for the MVP had under 1 GB of free memory.

**Decision.** React 19 with Vite and React Router, statically buildable and hostable anywhere. Freighter is integrated through `@stellar/freighter-api` (no multi-wallet kit yet, to keep the bundle and dependency tree small).

**Consequences.** Simple static hosting; SEO for task pages is limited. Adding Stellar Wallets Kit later is isolated to `src/wallet.ts`.
