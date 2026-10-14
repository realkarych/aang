# ADR-0001: MVP stack

Status: accepted by the owner 2026-10-01

## Context

RFC §7 requires a daemon with an event collector, a journal, an LLM observer, local storage, an update stream and a web interface. The MVP supports Claude Code and Codex, including the Claude Agent SDK and the Codex SDK, which ship in TypeScript.

## Decision

- Language — TypeScript (strict) on Node 26 for the daemon, CLI and UI; a pnpm monorepo.
  - Exception — the hook handler `catacomb-hook`: a native Go binary for all OSes (ADR-0013, accepted by the owner 2026-10-01). The exception is limited to this component.
- Storage — SQLite via the built-in `node:sqlite`.
- Update stream to the UI — SSE; UI commands — HTTP JSON.
- UI — React, Vite, React Flow (xyflow), ELK auto-layout.
- Tests — Playwright for UI E2E and scenarios, integration and functional tests of the daemon on Vitest with real SQLite and real processes; unit tests only per the AGENTS.md rule.

## Consequences

One language across all layers and direct use of the SDKs. VM/Docker needs the Node 26 runtime. SQLite and SSE remain reversible decisions behind their own module boundaries.
