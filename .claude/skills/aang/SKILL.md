---
name: aang
description: Map what this session decided — the decisions, the values that started mattering without anyone choosing them, and the questions and consequences left hanging — as a verifiable file with a local viewer. Run when the user types /aang, usually deep into a long session.
disable-model-invocation: true
---

# /aang — write down what this session decided

You are recording what this conversation settled, what it assumed without deciding, and what it
left open. The result is `.aang/map.json`: merged from a candidate you write, verified against the
session transcript by `aang`, shown in a local viewer.

## Write it from memory. You were there.

You have the whole conversation in context. That is the entire reason this map can be good: the
participant writes it, not a summarizer reading a log afterwards.

- Do not open, grep or index the transcript under `~/.claude/projects`. Do not re-read project
  files "to refresh". Do not hand this to a subagent — it was not here, it would have to read the
  log, and that is precisely the post-hoc summary this tool exists to avoid.
- The one thing you do not know is **turn numbers**. You never counted them. Never write one. You
  cite by verbatim quote (below) and `aang merge` finds the turn.
- Do read `.aang/map.json` if it exists. That is the previous map, not the transcript, and you need
  its ids (see "Running again").

## Selectivity: what earns a node

A map that records everything is a new keyhole. Apply this test to every candidate node:

> Someone returns to this project in a week with the code and the git log but without this
> conversation. Are they worse off not knowing this? Would they re-propose something rejected,
> re-argue something settled, keep leaning on something nobody chose, or walk past something left
> hanging?

If no, it is not a node. These do not earn a node:

- restatements, confirmations, summaries of what is already in the map
- tool mechanics: which commands ran, which tests passed, what was read, permission prompts, retries
- small clarifications, wording, typos, formatting
- your own narration of a plan that was then carried out as stated
- anything the diff or the commit messages already say, including the why
- a question raised and answered within the same exchange, unless the answer was itself a decision

Size: a two-hour session usually yields 5–15 nodes. Past 20 you are summarizing — cut. Under 3,
either the session was short or you only recorded what was chosen on purpose — run the tacit and
open questions again.

## Three kinds. Hunt the hard two first.

Ordinary decisions are easy to spot and you will find them anyway. Do them last. Start with the two
classes nobody wrote down; they are why this tool exists.

### `tacit` — it started mattering and nobody chose it

A value, constraint or assumption that arrived from somewhere — a previous run, a tool default, an
example, an existing file, a line said in passing, your own silent choice while implementing — and
that things downstream now depend on. Nobody weighed it, so nobody knows it is load-bearing.

Ask, concretely:

- Which **numbers** in this conversation were never argued for? Ports, timeouts, sample sizes,
  thresholds, versions, limits, dates. For each: where did it come from?
- Which **names and shapes** were adopted because they were already there — a file layout, a field
  name, a data format, a library, a branch, a merge method, a CI convention?
- What came from **outside this session** and is now load-bearing: a CLAUDE.md rule, a memory, a
  previous session's output, the way an existing example was written, a default nobody looked at?
- What did **I** choose silently while implementing — a data structure, a naming, an error policy,
  a scope cut, an ordering, a "for now" — that the user never saw as a choice?
- What did the user say **offhand** ("keep it simple", "use what's there", "like last time") that
  then ruled out alternatives nobody discussed?
- Which option became *the* option because it was **mentioned first**?
- Which "temporary" became permanent?

The test: if someone asked "why X?" tomorrow, is the honest answer "nobody chose it, it was just
there"? Then it is `tacit`. If the answer is "we discussed it and picked it", it is a `decision`.

Fields: `question` is the question nobody asked ("What sample size are we evaluating on?");
`decision` is the value in force; `why` is **where it came from** (the viewer labels this field
"origin" on tacit nodes); `consequence` is what now depends on it. `status: accepted` — it is in
force, that is the point. Cite the line that **states the value** — the number, the name, the
version — if anyone ever said it aloud. Most tacit values were never said: then cite the line where
it was first *relied on* (the reply that used it, the offhand remark it came from) and say in `why`
that the value itself was never stated in the conversation. That is an honest weak citation. A line
that merely shows the topic came up is not a citation at all.

### `open` — raised and never answered, or orphaned by a decision

Two sources. The first is easy: a question, yours or the user's, that the conversation moved past;
a "let's come back to that" that never came back; an "I'll check" that was never checked; a
disagreement dropped rather than resolved; an offer ("I can add X — say if you want it") that got no
answer.

The second is harder and worth more: **a consequence that follows from a decision nobody
revisited.** A decision changed the shape of something; something else assumed the old shape;
nobody went back. For each decision in your map, ask:

- What did this change the shape of? Who still reads the old shape? What was tuned for the old
  number, named for the old name, built for the feature that was cut?
- What did "not in v1", "out of scope", "later" silently leave needed by what *is* in v1?
- What was declared "should be fine", "verify later", or left untested?
- Which alternative was rejected on a premise that a later decision then removed?
- What did the user push back on that I went along with (or the reverse) without anyone actually
  deciding?
- What did we fix once by hand that the cause will produce again?

Fields: `question` is the hanging thing phrased as a question; `decision` stays empty — it has no
answer, that is what makes it open (the validator rejects an `open` with a decision); `why` says
why it hangs and, for an orphaned consequence, **which decision orphaned it** (name the node id);
`status: proposed`. Cite the line that raised it. For a consequence you derive now, there is no
line that raised it — cite the decision it follows from: **quote the line where that decision was
made, the same quote its node carries** (copy it from that node's `cites`), and name the node id in
`why`. A cite has no field for a node id; `{"quote": "d3"}` is not a citation. Only consequences you
can trace to a specific node; a generic risk with no decision behind it is not part of the record.

### `decision` — chosen on purpose

A question that was answered, and acted on or agreed to. Fields (ADR):

- `question` — what was being decided, as a question. If you cannot phrase the question, it is a
  fact, not a decision.
- `decision` — the position taken, one sentence, concrete: the number, the name, the mechanism.
- `why` — the argument that carried it. Not a restatement of the decision.
- `against` — objections actually raised, and alternatives actually rejected (with why), one string
  each. Record only what was said; do not invent objections. `[]` when none.
- `consequence` — what it committed us to, what it cost, what it changed downstream. `""` when
  genuinely nothing.
- `status` — `accepted` when the user agreed or acted on it; `proposed` when it was put forward and
  neither agreed to nor objected to; `superseded` when a later node replaced it.

## The grammar

IBIS, deliberately poor: positions answer questions; arguments attach to positions; anything may be
questioned. In this file that means: one node is one question with at most one position and its
arguments. Two positions on the same question are two nodes with the same `question`, at most one
of them `accepted`. A questioned decision is an `open` node whose `why` names it.

**A decision is never edited.** If the conclusion changed, add a new node and set the old one's
`status` to `superseded` with `superseded_by` pointing at the new id; leave its text as it was.
The old node stays visible, struck through, next to what replaced it. That is what stops the
argument from being re-litigated: the next reader sees that A was decided, why, and that B then
replaced it — instead of finding only B and proposing A again.

## Citations — the only defense

A wrong map is worse than no map: it launders a guess into a record. The citation is the only thing
standing between the two. Every node cites at least one verbatim quote from the conversation
(`open` may carry the quote of the decision that orphaned it, or nothing).

```json
"cites": [{"quote": "давай pass@1 на отложенном наборе"}]
```

Quote only. No `turn` (you do not know it; merge discards it anyway). No `role` (merge fills it
from the turn it finds; a slipped role would fail the check).

What resolves — this is how the checker works:

- **Copy it exactly as it was said.** Do not tidy grammar, fix typos, translate, or complete a
  sentence. Case, whitespace, punctuation, quotation marks, dashes, markdown `**` and backticks are
  forgiven. A changed word, a changed number, a changed operator (`<` vs `>`), a dropped word, a
  reordered phrase are not.
- **At least three real words and twelve characters.** Symbols and bare numbers do not count as
  words. `pass@1` fails; so does `давай pass@1` (two words and a number); `давай pass@1 на отложенном`
  passes. Aim for a full clause, 6–20 words — enough to carry the meaning, including the negation if
  there is one (`не надо` and `надо` are different decisions).
- **One contiguous run, whole words at both ends.** Do not stitch scattered fragments with `...`.
  If you must elide, every fragment needs at least four words, the gap at most 50 words, and the
  citation is shown as "with omissions" — verbatim is always better. Avoid quoting text that itself
  contains `...` or `…`; the checker reads those as elisions.
- **From the conversation only**: what the user typed and what you wrote in your replies. Tool
  calls, tool output, file contents you read, your own thinking, a subagent's report, a task
  notification, slash-command output and text injected by skills or the system are not the
  conversation. The indexer strips them, so they will not resolve — and if one ever did, it would
  be a ✓ beside words the user never said. Do not cite them.
- Prefer the user's words for something the user decided; your proposal plus the user's reply when
  the user agreed to yours. A node may carry several cites — the decision, and where its consequence
  surfaced.

When a quote does not resolve, the node still merges; it is saved with `turn: null` and shown as
**unverified**. That is the correct outcome for an uncertain memory. Never polish a quote into
something that sounds right.

### The quote must contain what the node states

The checker proves that the words were said. It cannot prove that they mean what the node says —
that is your job, and it is the rule that matters most:

- **The quote contains the thing the node states.** A `decision` of "72 hours" cites a line with
  "72" in it. A `decision` naming a mechanism cites the sentence that names it. A `tacit` value
  cites the line that states the value, or — when nobody ever said it — the line it was relied on,
  with `why` saying so. A `why` cites the argument, not the conclusion.
- **A line proving the topic was discussed is not a citation.** "Let's talk about thresholds" does
  not support "the threshold is 24 hours". The first words of the message that started the topic
  do not support what the topic concluded.
- **A user's question is never the support for the assistant's answer.** "What should the
  principles be?" does not verify "it is supervisory control, not visualization" — the sentence
  that says so is in the reply. Cite the reply; cite the question only for a node about the
  question (an `open` it raised, a `tacit` it introduced).
- **Prefer the line that says it over the line that resolves easily.** The sentence that actually
  states the position is usually longer, further away and harder to remember exactly than a short
  nearby line on the same topic. Cite it anyway. If you cannot recall it verbatim, the node is
  unverified — that is honest. A short line that resolves but does not say it is a ✓ next to a
  guess, the one failure the checker cannot catch and the worst one available.
- **Weak and honest beats strong-looking and wrong.** When no line states what the node states,
  cite what you have and say in `why` that it was never stated. The reader then knows exactly how
  much the ✓ means.

## The file

Write `.aang/candidate.json` — never `.aang/map.json`. Exactly this shape:

```json
{
  "version": 1,
  "session_id": "",
  "generated_at": "2026-09-11T12:00:00Z",
  "title": "aang · пайплайн оценки",
  "nodes": [
    {
      "id": "d1",
      "kind": "decision",
      "status": "accepted",
      "superseded_by": null,
      "question": "Чем мерить качество прогона?",
      "decision": "pass@1 на отложенном наборе",
      "why": "k>1 маскирует нестабильность промпта",
      "against": ["Дисперсия выше, нужен набор существеннее"],
      "consequence": "500 примеров вместо 100, прогон дорожает втрое",
      "cites": [{"quote": "давай pass@1 на отложенном наборе"}],
      "hand_edited": false
    }
  ]
}
```

- `kind`: `decision` | `tacit` | `open`. `status`: `accepted` | `superseded` | `proposed`.
  `superseded_by` is an existing node id, or `null`; `status: superseded` requires it and it
  requires `status: superseded`.
- `id`: `d1, d2…` for decisions, `t1…` tacit, `o1…` open, numbered in order of first appearance.
  Ids are permanent — never renumber, never reuse. If a node's kind changes later (a tacit the user
  then confirmed becomes a decision), keep its id; the prefix is a hint from birth, not a rule.
- `nodes` in the order the conversation reached them; the viewer shows newest first.
- `session_id`: this session is `${CLAUDE_SESSION_ID}` — use that. If the previous line shows
  the literal text `${CLAUDE_SESSION_ID}` rather than an id, leave `""`: merge then takes the
  newest transcript and records its id, and `aang check` prints which file it used, so confirm it
  is this one.
- `generated_at`: now, ISO 8601 UTC (`date -u +%Y-%m-%dT%H:%M:%SZ`).
- `title`: `<project> · <what this session was about>`, short.
- Text fields in the language the conversation was held in. A sentence or two each; the map is a
  spine, not prose.
- `hand_edited` is always `false` from you. You never set it.

## Procedure

1. If `.aang/map.json` exists, read it. Note every id and every `hand_edited: true`.
2. Think through the tacit questions, then the open questions, then the decisions. Apply the
   selectivity test to each node.
3. Write `.aang/candidate.json` (create the directory if needed).
4. Run `aang merge --session <session_id>` (omit `--session` if you left `session_id` empty). If
   `aang` is not on PATH, it is `bin/aang` in the aang checkout, which this skill lives in:
   `"$(cd "${CLAUDE_SKILL_DIR}" && pwd -P)/../../../bin/aang"`.
   It validates the candidate, finds each quote in the transcript, fills in turns,
   merges into `.aang/map.json` preserving hand edits, and prints what it kept, added, dropped, and
   which quotes it could not find.
   - Exit 1 with `невалиден`: the candidate broke the schema; the errors name node and field.
     Nothing was written. Fix the candidate and run again.
   - Exit 0 with `не найдено: N`: those nodes are in the map, unverified. See step 5.
5. Run `aang check` (same `--session`). It prints every node with ✓/✗ and the reason for each failing quote, and exits
   1 if any citation failed. For each ✗: if you misquoted a line you clearly remember, write a
   corrected candidate (same ids, all nodes) and merge again — **once**. Do not iterate hunting for
   a quote that resolves; after one correction pass, whatever is still ✗ stays unverified, and you
   say so. Then the check the tool cannot do: **for every ✓, re-read the quote and ask whether it
   says what the node says** — the number, the name, the position. If it does not, replace it with
   the line that does (this counts as the one correction pass) or drop it and let the node stand
   unverified. A ✓ beside a quote that does not support the node is worse than a ✗.
6. Start the viewer in the background: `aang view` (same `--session`; it serves until stopped —
   use the Bash tool's background mode). Its output carries the URL, `http://127.0.0.1:8790/` by default; if the port is
   taken it exits 1 — retry with `--port 8791`.
7. Tell the user, briefly: the URL; how many tacit / open / decision nodes; which nodes are
   unverified and, in one line each, why. Do not paste the map — the viewer is for that. Mention
   that `aang export` writes `docs/decisions.md` if they want the record committed.

## Running again in the same session

`/aang` is usually run more than once. Merge matches nodes by id:

- **Re-emit every node in `.aang/map.json`** that is still true, with its existing id, superseded
  ones included — a node you leave out is dropped (unless hand-edited or superseded; merge keeps
  those). Then add the new ones.
- **Only nodes present in `.aang/map.json`.** A node you emitted in an earlier run that is no longer
  in the file was removed by the user. That is a hand edit — the most basic one. Do not bring it
  back, however true it still seems; if you believe it matters, say so to the user instead.
- Superseded nodes are history: merge keeps them even if you forget them, but re-emit them anyway,
  text unchanged, so the record and the candidate agree.
- Nodes marked `hand_edited: true` are the user's: merge keeps their text regardless of what you
  write, and you cannot overwrite them. You may still supersede one — write it with
  `status: superseded` and `superseded_by`, and merge applies exactly that and nothing else.
- A conclusion that changed since the last map: new node, old one superseded. Never rewrite the
  old one's text.
- A node you now think was wrong (not superseded — wrong): leave it out, and tell the user you
  dropped it and why. If it was hand-edited, tell the user; only they can remove it.

## Never

- Write `.aang/map.json` directly. It bypasses the merge and silently destroys the user's hand
  edits on the next run.
- Guess a turn number. Invent, tidy or translate a quote.
- Delegate to a subagent.
- Record the conversation. Record what it decided, assumed and left hanging.
