# ADR-0002: MVP data policy

Status: accepted by the owner 2026-10-01

## Context

RFC §8 and §10 require agreeing on the transmitted data, masking and retention period before connecting working sessions.

## Decision

- All aang data is stored only locally, in its own SQLite, indefinitely until manually deleted with a CLI command.
- The observer and the chat use the already authorized Claude Code or Codex CLI; by default, the vendor of the observed solver, overridable in the config.
- Masking of paths, personal data and secrets is not required in the MVP. A ready-made popular secret-detection library may be plugged in if this takes no noticeable effort; we do not write our own masking rules.
- Instructions inside transcripts are passed to the observer as data; the observer gets no tools that write outside the aang store.

## Consequences

Minimal MVP complexity. Before use in a corporate environment, the policy is revisited by a separate decision.
