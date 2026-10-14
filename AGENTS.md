# catacomb — project rules

The source of requirements is `rfc.md` (approved). Architectural decisions are recorded in `docs/adr/` and take effect only after approval by the project owner.

## Code

- Any comments and docstrings in source code are forbidden — in all languages and files (`//`, `/* */`, `#`, `/** */`, JSDoc, docstring). Code documents itself through names, types and structure. Explanations belong in ADRs, READMEs and PR descriptions.
- The only exceptions are syntactically significant constructs that are not explanations: shebangs, tool directives where they cannot be avoided (for example, `/// <reference>`), and generated code.

## Testing

- Massive unit testing is forbidden. A unit test is written only for a truly important fragment that must be checked atomically and cannot be adequately covered by an E2E or integration test.
- The goal is 100% coverage of business logic and user scenarios through E2E, functional and integration tests. The rule is the same for backend and frontend.
- A test checks behavior visible to the user or to a neighboring component, not implementation details. Mocks only at external boundaries (LLM, third-party processes); our own modules are not mocked.

## Process

- Each PR is logically cohesive and reviewable: usually one or two plan items. There is no hard line limit. A large task is delivered as a stack of sequential PRs.
- Implementation and fixes are done by Claude Code agents on Opus; before merge, each PR goes through a cross-review by a Codex agent on gpt-6-astra (reasoning xhigh) in a separate fresh session.
- Key architectural decisions are written up as ADRs and are not implemented until approved by the owner.
- The MVP boundaries are set by section 4 of `rfc.md`; changing the scope requires a separate decision by the owner.
