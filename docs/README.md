# Lumora — Engineering Design Document

Chat with your documents. Grounded answers, real citations.

**Status:** Planning. No implementation yet. Phase 1 scope = Homepage, Auth, Chat.

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

## Non-goals for this document

Infrastructure excluded on purpose: no Docker, CI/CD, Kubernetes, Terraform, cloud, or deployment topology. Architecture stays deployment-agnostic so infra can be layered on later without rewrite.

## Reading order

New engineer: 00 → 01 → 06. Building frontend: 01 → 02 → 04. Building backend: 03 → 04 → 05.
