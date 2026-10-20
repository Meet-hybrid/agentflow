# ADR 0004: `csv-aggregate` as the first task type

Status: accepted

**Context.** The MVP must show an agent genuinely executing work that can be independently verified, without depending on a paid AI service or running untrusted code.

**Decision.** Grouped count/sum/avg/min/max over an inline CSV, computed with exact decimal (BigInt) arithmetic and canonical JSON hashing. The API recomputes every submission; the agent executes in a locked-down subprocess.

**Consequences.** Verifiable and deterministic, but narrow. LLM-backed task types will need a different verification approach (client review plus rubric, or test suites) and are on the roadmap behind the executor interface.
