# ADR 0001: The chain is the source of truth for money; the API never signs for funds

Status: accepted

**Context.** A database and a Stellar transaction cannot commit atomically. Holding user keys server-side would make the platform a custodian.

**Decision.** Every money-moving action is a contract call signed by the party the contract requires. The API prepares and simulates transactions, verifies that the signed envelope is exactly the prepared one, submits it and tracks it in `chain_ops`. Task status for funded/paid/refunded/resolved is derived from the contract (`statusFromChain`) after confirmation; a worker reconciles continuously.

**Consequences.** No server-side fund keys; users sign every money action in their wallet. Failed and ambiguous transactions are visible and recoverable. More round trips per action than a custodial design.
