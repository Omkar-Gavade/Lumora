# Lumora — Engineering Design Document

Chat with your documents. Grounded answers, real citations.

**Status:** Phase 1 is implemented — auth, document ingestion, hybrid retrieval,
grounded streaming chat with citations, conversation history, and the responsive
app shell are all built and covered by tests. Documents 00–06 are the design
these were built from and remain the source of truth for intent.

Documents 07, 08, and 09 are different in kind: they are **plans for work that
has not started** — a feature specification, a deployment architecture, and a
delivery/DevOps architecture. Each is marked as such in its own header. The
system runs only on local Docker today: no cloud infrastructure, no Dockerfile,
and no CI/CD exist.

## Document set

| Doc | Contents |
|---|---|
| [00-product.md](00-product.md) | Vision, functional + non-functional requirements, personas, user journeys, information architecture, sitemap, screen-by-screen specs |
| [01-design-system.md](01-design-system.md) | Design philosophy, tokens, typography, color, spacing, motion, accessibility, component inventory |
| [02-frontend.md](02-frontend.md) | Frontend architecture, folder structure, component hierarchy, routing, state management, API layer, performance |
| [03-backend.md](03-backend.md) | Backend layered architecture, folder structure, middleware chain, error model, config, logging |
| [04-data-and-api.md](04-data-and-api.md) | Database schema, indexes, API surface, auth flow, security model |
| [05-rag-and-chat.md](05-rag-and-chat.md) | Ingestion pipeline, chunking, embedding, retrieval, prompt assembly, citations, streaming chat, provider abstraction |
| [06-roadmap.md](06-roadmap.md) | Milestones, feature priorities, coding standards, risks, trade-offs, future roadmap |
| [07-knowledge-base.md](07-knowledge-base.md) | **Specification only — not implemented.** FR-18 collections: product semantics, UX, data model, retrieval scoping, API, security, tests, phased plan |
| [08-production-architecture.md](08-production-architecture.md) | **Plan only — not deployed.** Local → cloud: data mapping and source of truth, object storage, managed Postgres, vector-store decision, compute and worker split, secrets, tenancy, backups, DR, cost, migration |
| [09-devops-cicd-deployment.md](09-devops-cicd-deployment.md) | **Plan only — not built.** CI/CD pipeline, container strategy, registry, the Kubernetes decision, IaC, environments, deployment and rollback, secrets, observability, scaling blockers, phased roadmap |

## Non-goals for this document

Infrastructure excluded on purpose: no Docker, CI/CD, Kubernetes, Terraform, cloud, or deployment topology. Architecture stays deployment-agnostic so infra can be layered on later without rewrite.

## Reading order

New engineer: 00 → 01 → 06. Building frontend: 01 → 02 → 04. Building backend: 03 → 04 → 05. Implementing Knowledge Base: 00 §2 (FR-18) → 05 → 07.
