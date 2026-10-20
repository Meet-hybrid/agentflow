# ADR 0002: Fastify with Zod, and plain SQL with `pg` instead of an ORM

Status: accepted

**Context.** We need validated REST endpoints, explicit transaction boundaries and row locks to prevent races, and few dependencies (the project is open to outside contributors, and a recent supply-chain incident hit a sister repo).

**Decision.** Fastify 5 with request validation through the shared Zod schemas (the same schemas generate `/openapi.json`). Persistence uses `pg` with SQL migrations and explicit `select … for update`, partial unique indexes and advisory-locked migrations. NestJS was rejected as heavier to learn; Prisma because its current `latest` tag was a release candidate, it needs install scripts and engine binaries, and its abstractions hide the locking this design relies on.

**Consequences.** SQL is visible and reviewable; no ORM-level type generation, so row types are declared by hand.
