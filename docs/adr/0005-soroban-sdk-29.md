# ADR 0005: Target soroban-sdk 29 and stellar-sdk (JS) 17

Status: accepted

**Context.** In October 2026 testnet runs protocol 29; `soroban-sdk` 29.0.1 and `@stellar/stellar-sdk` 17.2.1 are the current releases. JS SDK 17 moved XDR accessors to properties.

**Decision.** Pin `soroban-sdk = "=29.0.1"` and `@stellar/stellar-sdk 17.2.1` exactly. Use the constructor (`__constructor`) for configuration and `#[contractevent]` for events.

**Consequences.** Upgrades are deliberate and reviewed; contributors must use matching CLI/toolchain versions (documented in CONTRIBUTING).
