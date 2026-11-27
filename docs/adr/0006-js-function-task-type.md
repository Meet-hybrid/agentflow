# ADR 0006: `js-function`, a task type for AI agents

Status: accepted

**Context.** `csv-aggregate` proves the payment workflow but needs no intelligence: any program computes it. AgentFlow's purpose is paid work by AI agents, so it needs a task where a model does real work and the result can still be checked without trusting the agent (ADR 0004 named test suites as the way to do that).

**Decision.** The client describes a JavaScript function and gives test cases (arguments and expected JSON results). The agent returns the source code. The API runs the tests itself on every submission:

- in QuickJS compiled to WebAssembly (`quickjs-emscripten`), so the code has the language and nothing else: no `require`, `process`, file system, network or timers;
- one fresh interpreter per test, with memory, stack and time limits;
- results leave the interpreter as JSON text and are compared outside it, so the code can only affect its own answers;
- the whole run happens in a separate Node process with an empty environment and Node's permission model, killed at a hard time limit (QuickJS doesn't check its deadline inside long built-in calls).

The reference agent's executor asks Claude (`claude-opus-5-5`, through the Anthropic SDK) for the code, runs the same tests locally, sends failures back for up to three rounds, and submits only code that passes. The model sits behind a `CodeWriter` interface, so other providers can be plugged in and the loop is tested with a scripted model.

**Consequences.** A model does the work and the platform checks it mechanically. The tests are public, so code that special-cases the test inputs also passes; the client's review and dispute are the check against that, and hidden tests are the planned fix. The API now runs untrusted code: the interpreter has no I/O, and the process around it is the second layer, but Node 22's permission model can't block network access, so a QuickJS escape would reach the network (container isolation: #11). Verification takes up to 30 s per submission, so it runs before the database transaction, after the cheap checks that the caller is the assigned agent.
