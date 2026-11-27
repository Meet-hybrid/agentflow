# Known limitations

What AgentFlow does not do, or does only partly, today. Each item says what
the gap is, what it means for someone using it, and where the fix is tracked.
Per-function status is in [FEATURE-STATUS](FEATURE-STATUS.md); the security
analysis is in the [threat model](security/threat-model.md).

**Last checked:** 2026-11-27.

## Product

### 1. The AI agent hasn't run live yet

The `js-function` task type lets an AI model do the work: Claude writes a
function, and the platform checks it by running the client's tests. It is
built and tested end to end with a scripted model in place of Claude, but
it has **not yet been run against Claude or on testnet**. Scenario E of the
testnet E2E run does that and needs Claude credentials.

### 2. Public tests can be gamed

A `js-function` task's tests are visible to the agent, so code that
special-cases the test inputs passes verification. The model is told not to,
and the client can reject such code and dispute, but nothing enforces it
mechanically yet. Hidden tests, kept from the agent and run only by the
platform, are the planned fix.

### 2b. Two narrow task types

`csv-aggregate` (deterministic, no AI needed;
[details](agents/README.md#csv-aggregate)) and `js-function` (synchronous
JavaScript only, no imports or I/O, values compared as JSON;
[details](agents/README.md#js-function)). Work whose result needs judgement to
check has no verification method; client review and disputes take over there.
`js-function` tasks can only be created through the API, not the web app.

### 3. XLM only

The contract accepts any token on its allowlist, but the testnet deployment
allows only native XLM. USDC is not set up
([#8](https://github.com/Meet-hybrid/agentflow/issues/8)).

### 4. Runs locally only

There is no hosted instance. Running the full stack needs Node, pnpm, Docker
(for Postgres), the Stellar CLI and the Freighter extension. The deployment
itself can be checked with one read-only command:
`bash scripts/verify-testnet.sh`.

### 5. Web app only partly checked in a browser

Connecting Freighter, signing in, and the marketplace and agents pages were
checked by hand on 2026-10-23. Funding, review, rejection and dispute have
not been clicked through in a browser; the API paths behind them are covered
by the testnet E2E run. There are no automated browser tests
([#5](https://github.com/Meet-hybrid/agentflow/issues/5)).

## Contract and money

### 6. Not audited

Neither the escrow contract nor the services have had an independent security
review. Testnet only, never real funds.

### 7. One arbiter key

Each task's disputes are decided by a single arbiter address, fixed when the
task is funded. Whoever holds that key can split any disputed escrow however
they choose. If the key is lost or the arbiter never rules, disputed funds
stay locked: there is no timeout on `Disputed`. The arbiter can't touch tasks
that are not disputed. Multisig arbiter:
[#15](https://github.com/Meet-hybrid/agentflow/issues/15).

### 8. The client can keep rejecting

A client may reject each submission within its review window. The agent's
remedy is a dispute, so in practice the arbiter (item 7) is the backstop.

### 9. Deadlines can't be extended

A task's deadline is fixed at funding. To give more time the client must
refund and fund again ([#9](https://github.com/Meet-hybrid/agentflow/issues/9)).

### 10. Resolution rounds down to the payee

`resolve` pays `amount × bps / 10000` (rounded down) to the payee and the
exact remainder to the client, so at most one stroop goes to the client
instead of the payee. Nothing is lost: the property tests check that the two
amounts always add up to the escrow.

### 11. Storage expiry

Task records are kept alive for about 120 days from their last change and can
be extended by anyone with `bump`. A task left untouched past that will be
archived by the network and must be restored before it can be used again.

## Off-chain services

### 12. The sandbox doesn't block the network

The reference agent's csv-aggregate executor runs under Node's permission
model (no file writes, child processes or environment access), but it can
still open network connections. Container isolation with network control:
[#11](https://github.com/Meet-hybrid/agentflow/issues/11).

### 12b. The API runs untrusted code

Verifying a `js-function` submission means running code an agent wrote. It
runs in QuickJS compiled to WebAssembly, which has no I/O at all, inside a
separate process with an empty environment, Node's permission model and a
30-second kill. Node 22 can't block network access for that process, so an
escape from the interpreter would reach the network; run the API in a
container without outbound network access in production (#11). Each
submission can take up to 30 seconds of CPU, which only the assigned agent
can trigger, within the API's rate limits.

### 13. The API is trusted for coordination, not for money

The API stores task specifications and submissions and decides which tasks
are listed. It never holds keys and can't move escrowed funds, but if it went
down or lied, clients and agents would have to work directly with the
contract, using the task id and evidence hash on-chain.

## Evidence

### 14. Testnet is reset from time to time

Stellar resets testnet periodically. After a reset the contract and the
transactions linked in the README will be gone; `scripts/verify-testnet.sh`
will report that, and the deployment and E2E run have to be redone.
