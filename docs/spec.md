# aang — Spec (v1)

`/aang` is a Claude Code skill you invoke **deliberately, inside a long session**. It turns the
conversation you are already having into a verifiable map of what that conversation decided, opens
a local UI on it, and leaves a file behind.

## The problem it exists for

A long session is a keyhole (Woods, 1984): a large information space viewed through a narrow
viewport. Three consequences, all measured:

- **Content displacement.** The stream pushes everything upward, so spatial memory stops working —
  you cannot recall *where* something was, because it is no longer there.
- **Hidden state.** What is settled, what was assumed silently, what is still open — all of it is
  held in the head, and exceeds the ~4 chunks working memory has under load (Cowan, 2001).
- **No deixis.** You cannot point at anything. To refer to a decision from the middle of the
  session you must restate it in words.

What a long session produces invisibly, and what costs the most later, is not the decisions — those
you at least made on purpose. It is **tacit decisions** (a value that arrived from somewhere and
started mattering without anyone choosing it) and **orphaned consequences** (a fact that follows
from a decision and that nobody thought about when the decision was made).

## The architectural call that makes v1 small

When `/aang` runs, the model **already has the conversation in its context**. Extraction is
therefore not a transcript-parsing problem — it is a *write down what you already know* problem.

So: the skill instructs the live model to emit the map directly. The on-disk transcript is needed
for exactly one thing — **verifying citations**. This is what keeps v1 to four small pieces, and it
is also what makes the map good: the model that was in the conversation writes it, not a
post-hoc summarizer reading a log.

## Requirements

- **R1 The map is IBIS-shaped.** Nodes are Question / Position / Argument. Three link rules, and only
  these: a position answers only a question; an argument attaches only to a position; anything may
  be questioned. The grammar is deliberately poor so the map cannot become a diagram of everything.
- **R2 Decisions carry ADR fields** (Nygard, 2011): question, decision, why, arguments against,
  consequence, status. **A decision is never edited.** If the conclusion changed, a new decision
  supersedes it and the old one's status becomes `superseded`, staying visible. Re-litigation is the
  failure this prevents.
- **R3 Two node classes are first-class, not afterthoughts**: `tacit` (decided without anyone
  choosing) and `open` (a consequence or question left hanging). These are the highest-value output;
  the UI must surface them above ordinary decisions.
- **R4 Every claim cites a turn.** Each node carries a turn reference into the session transcript. A
  citation that does not resolve makes the node **unverified**, and the UI must say so. A wrong map
  is worse than no map because it launders a guess into a record; the citation is the only defense.
- **R5 The map persists as a file.** `.aang/map.json` is the machine copy; an exported Markdown
  decision record is the human copy that gets committed. The point is that the next session reads
  what was already rejected, so nobody re-proposes it.
- **R6 The map is correctable.** The file is plain and hand-editable, and hand edits survive
  regeneration of everything else.
- **R7 Local and dependency-free.** Python 3.9 stdlib only. Server binds `127.0.0.1` only — a
  session transcript is as private as it gets.
- **R8 Selectivity.** Not every turn is a decision. A map that records everything is a new keyhole.
  The skill must carry an explicit threshold for what earns a node.

## Non-goals for v1

Watching anything. Fleet overview across sessions. Alarms, attention queues, decay. `/aang` is
invoked, renders, and gets closed — it has no unattended mode and therefore none of that machinery.
