# aang

`/aang` is a skill for Claude Code and Codex, run **deliberately, inside a long session**. It turns
the conversation you are already having into a verifiable map of what that conversation decided —
including the two things nobody writes down — opens a local viewer on it, and leaves a file behind.
With the hook installed (see «Live») the session keeps the map current and carries your answers
from the viewer back to the agent.

## The problem

A long session is a keyhole: a large information space seen through a narrow viewport. Content
scrolls away, so you cannot remember *where* something was, because it is no longer there. What is
settled, what was assumed silently, and what is still open all live only in your head — and there
is more of it than a head holds. You cannot point at a decision from an hour ago; you can only
restate it.

The expensive part is not the decisions you made on purpose. It is:

- **tacit decisions** — a value that arrived from a previous run, a default, an example or an
  offhand line, and started mattering without anyone choosing it;
- **orphaned consequences** — something that follows from a decision, that nobody thought about
  when the decision was made, and that nobody came back to.

`/aang` exists to surface those two, with an ordinary decision record around them.

## How it works

When you type `/aang` — or when the hook asks for a refresh — the model that has been in the
conversation the whole time writes the map from its own context, not a summarizer reading a log
afterwards. It writes a **candidate** (`.aang/candidate.json`), then runs `aang merge`, which does
the one thing the model cannot do: find every quoted line in the session transcript and pin it to a
turn. Then it opens the viewer.

The transcript — under `~/.claude/projects` in Claude Code, `~/.codex/sessions` in Codex — is read
for exactly one purpose: verifying citations. Nothing leaves the machine: the viewer binds
`127.0.0.1` only and refuses any other `Host`, and only the viewer's own origin may write the map —
a page on another site cannot POST into it.

## Install

Python 3.9, standard library only. No dependencies, no build.

```sh
git clone <this repo> ~/src/aang
ln -s ~/src/aang/bin/aang ~/.local/bin/aang            # `aang` on PATH (any directory on PATH works)
ln -s ~/src/aang/.claude/skills/aang ~/.claude/skills/aang   # `/aang` available in every project
ln -s ~/src/aang/.claude/skills/aang ~/.agents/skills/aang   # `$aang` in Codex
aang install                                           # live updates: hooks for Claude Code and Codex
aang --help                                            # proves `~/.local/bin` is on PATH
```

`aang` on PATH is the normal case: `/aang` runs `aang merge`, `aang check`, `aang view` by that
name. Without it the skill falls back to `bin/aang` in the checkout it lives in, found through the
skill's own directory, which works but leaves the first run to a path lookup.

Inside this repository the skill is already picked up from `.claude/skills/aang/`.

## Use

In a session, when enough has happened to be worth mapping — `/aang` in Claude Code, `$aang` in
Codex:

```
/aang
```

The model writes the candidate, merges it, checks it, starts the viewer and gives you the URL
(`http://127.0.0.1:8790/`). Run it again later in the same session: the map is updated, not
replaced — your hand edits stay, decisions that changed are superseded rather than rewritten.

### The commands

The four that work on a map take `--root DIR` (where `.aang/` lives, default `.`), and
`--transcript PATH`, `--session ID`, `--transcript-root DIR` to say which transcript to check
against. Either explicit flag wins outright; with neither, the transcript is the one
`.aang/session.json` names — the hook writes it — else the session id recorded in the map, else
the newest transcript under `~/.claude/projects` and `~/.codex/sessions`. `hook` and `install` take neither: the hook is told the project by the
harness, and `install` works on your home directory.

| command | what it does |
|---|---|
| `aang merge [--candidate PATH] [--keep]` | Validate `.aang/candidate.json`, resolve every quote to a turn, fold it into `.aang/map.json` preserving hand edits, delete the candidate. Exit 1 and nothing written when the candidate is invalid. A quote that is not found is saved with `turn: null` — the node stays, marked unverified. Prints which transcript it read and how it knew: `из .aang/session.json`, `по --transcript`, `по --session`, or `самый свежий`. |
| `aang check` | Validate the map and resolve every citation; print ✓/✗ per node and per quote with the reason, △ for a node with no citations at all. **Exit 1** when the map is invalid, any citation fails, or the transcript cannot be found. After the verdict, remarks (△) for node ids mentioned in prose with no edge to them — a nudge, never a failure. This is the command a human trusts. |
| `aang view [--port 8790]` | Serve the viewer on `127.0.0.1` until Ctrl-C. When the port is already held by an `aang view` on the same map, it prints `уже запущен` with that URL and exits 0 instead of starting a second server. |
| `aang export [--out docs/decisions.md]` | Write the Markdown decision record — the human copy that gets committed. Superseded decisions kept and marked; unverified nodes marked. Grouped by the viewer's cells. |
| `aang hook` | Called by the harness on `SessionStart`, `UserPromptSubmit` and `Stop`; reads the event as JSON on stdin. Not for humans. Always exits 0 and says nothing when there is nothing to say, so a broken aang cannot break a session. |
| `aang install [--claude] [--codex] [--print]` | Register `aang hook` in `~/.claude/settings.json` and `~/.codex/hooks.json` for those three events, idempotently: an aang entry that is already there is left alone, and so is everyone else's. Without a flag, every harness whose directory exists. `--print` shows the resulting JSON and writes nothing. |

## Live

`aang install` connects `aang hook` to three events; each of them records which transcript this
session is writing into `.aang/session.json`, so `merge`, `check` and the viewer stop guessing. In
a project with no `.aang/map.json` the hook does nothing at all — it starts at the first event
after `/aang` has written a map — which is what makes installing it once, globally, safe. On
`UserPromptSubmit` the hook adds to your prompt whatever the viewer has to say — the verdicts you
pressed since the last turn, and, when you name a node by id («что с d4?»), that node in full:
question, status, author, its relations and what rests on it. On `Stop` it asks the agent to
refresh the map once it has fallen behind — five of your turns past the last one the map cites, or
fifteen minutes and at least one turn — and never twice at the same point in the transcript;
`.aang/config.json` (`{"nudge_turns": 5, "nudge_minutes": 15}`) changes those two numbers, and
there is no command for it.

In the viewer every node sits in a cell — Входящее, Ресерч, Обсудить, Подтверждено, Отвергнуто,
then the tacit values, the open questions and whatever is none of those — and carries the verdicts
that apply to it, **подтвердить · в ресерч · обсудить · отвергнуть**, with an optional comment:
pressing one edits the map at once and writes a line to `.aang/outbox.jsonl`, which the hook hands
to the agent with your next prompt. The page follows the files by itself, so a merge, a verdict or
a new turn in the transcript redraws it without losing your selection, your scroll or a half-typed
edit.
`.aang/map.json` is the record and belongs in git; `.aang/session.json`, `.aang/outbox.jsonl` and
`.aang/candidate.json` are this machine's working state and belong in `.gitignore` — `merge` says
so in one line while they are not there, and never edits the file itself.

## The map

`.aang/map.json`:

```json
{
  "version": 1,
  "session_id": "7df13757-…",
  "generated_at": "2026-09-11T12:00:00Z",
  "title": "aang · пайплайн оценки",
  "nodes": [
    {
      "id": "d1",
      "kind": "decision",
      "status": "accepted",
      "decided_by": "user",
      "triage": null,
      "seen_at": null,
      "superseded_by": null,
      "question": "Чем мерить качество прогона?",
      "decision": "pass@1 на отложенном наборе",
      "why": "k>1 маскирует нестабильность промпта",
      "against": ["Дисперсия выше, нужен набор существеннее"],
      "consequence": "500 примеров вместо 100, прогон дорожает втрое",
      "cites": [{"turn": 47, "role": "user", "quote": "давай pass@1 на отложенном наборе"}],
      "relates": [],
      "added_at": "2026-09-11T12:00:00Z",
      "hand_edited": false
    }
  ]
}
```

Three kinds of node:

- **`decision`** — chosen on purpose. Carries the ADR fields: the question, the position taken,
  why, what was said against it, what it committed us to, and a status.
- **`tacit`** — in force, but nobody chose it. `why` says where the value came from. The viewer
  shows these first.
- **`open`** — a question nobody answered, or a consequence of a decision nobody came back to.
  `decision` is empty; `relates` names the decision that orphaned it, or `why` says nothing did.

Statuses: `accepted`, `proposed`, `superseded`, `rejected`. `rejected` is the one the user pressed
«отвергнуть» on, or said no to: the node stays in the map with the reason in `against`, because a
record of what was turned down is what stops the next session from proposing it again. An `open`
node can be neither `accepted` nor `rejected` — answering it makes it a decision.

Three more fields carry state around the ADR text. `decided_by` is `user` or `agent`, on a
`decision` and nowhere else; absent means «unknown», and the viewer shows «решил: ?» rather than
blame the agent for it. `triage` is `research` or `discuss` — «under question» — and is valid only
on a `proposed` decision or an `open` node. `seen_at` is the server's stamp of when you last
pressed «видел» on a node: nothing else writes it, `merge` keeps it as it keeps `added_at`, and the
export leaves it out. From these, and from `kind`, the viewer derives each node's **cell** — the
group it is filed under, Входящее first, as «Live» lists them — and the export groups by the same
rule. The cell is a rule, never a stored field.

**A decision is never edited.** When a conclusion changes, a new node is added and the old one gets
`status: superseded` and `superseded_by: <id>`; it stays in the map, struck through, next to what
replaced it — so the next reader sees the argument was had, and does not have it again.

Relations between nodes are edges, not sentences. A node's `relates` holds up to three
`{"to": <id>, "rel": ...}` entries, each pointing at a node **earlier in the list** — so an edge
can only name something already written, and no cycle is possible; a foundation noticed late (a
tacit value, usually) is therefore placed above the first node that rests on it. Three values of `rel`:
`orphaned_by` (on an open node: that decision left this question hanging), `rests_on` (this holds
on that decision or tacit value), `moots` (on the newer decision: that one stopped mattering
without being replaced — `superseded` is for a decision that *was* replaced). `superseded_by` is
the fourth relation and stays its own field. The reverse side — «на этом держатся: d7, d11, o6» —
is never stored: the server derives it for the viewer and the export, so the two sides cannot
drift. The viewer files open nodes under «осиротело решениями» or «просто висит» by the presence
of an `orphaned_by` edge, and nothing else; `check` remarks on every open node without one, so a
skipped edge cannot pass for an honestly hanging question.

`added_at` is stamped by `merge` when a node first enters the map and never rewritten; the viewer
marks nodes added since the previous run from it. A map written before the field existed has no
stamp: that is "unknown", not "old", and the viewer shows no mark rather than a wrong one.

The grammar is deliberately poor (IBIS): a position answers a question, arguments attach to a
position, anything may be questioned. Every node is one question with at most one position.

Citations: every `decision` and `tacit` node cites at least one **verbatim quote** from the
conversation. The model writes only `quote`; `merge` fills `turn` and `role` by finding the quote
in the transcript. A turn number in the file therefore always means "found by aang", never
"guessed". The viewer shows the surrounding transcript excerpt for each citation, so you can see
the quote in context rather than trust it.

## Correcting a map by hand

The file is plain JSON, written with `indent=2` and real Unicode. Two ways to correct it:

- **In the viewer** — every field has an edit button. Saving marks the node `hand_edited: true`
  and re-resolves its citations immediately, so a corrected quote turns verified on the spot.
- **In an editor** — edit `.aang/map.json` directly and set `"hand_edited": true` on the node you
  changed. Run `aang check` afterwards: a typo that breaks the schema makes the viewer show the
  errors instead of the map until it is fixed (a half-valid map is never rendered).

What `hand_edited: true` buys you: the next `/aang` **cannot overwrite that node's text** and
cannot drop it. The model's candidate is merged around it. The one thing a later run may still do
to a hand-edited node is mark it superseded when the conversation genuinely moved past it — the
words stay yours, the bookkeeping follows the conversation.

Nodes the model wrote and you did not touch belong to the model: a later run replaces them or, if
it no longer emits them, drops them. Two exceptions: a `superseded` node is history and survives a
run that forgot it, and a node you **deleted** from the file stays deleted — the skill re-emits only
what is in `.aang/map.json`, so a deletion is a hand edit like any other. To add a node, add it with
`hand_edited: true` and at least one verbatim quote.

Relations are corrected like any other field — in the viewer (`relates` is editable, as is
`superseded_by`) or in the file. A bad edge — an unknown id, a pointer down the list, a fourth
entry, a `rel` outside the three — is refused with the schema error naming the node and the entry,
in the viewer as in `aang check`. A hand-edited node keeps its edges across regeneration, and a
node its edges point at is kept with it even when the next run forgets that target.

Never edit a decision's conclusion in place. Add the new decision and supersede the old one.

## Trust model

- **A ✓ means the words were said, not that they mean this.** The checker proves that the quote
  occurs in the transcript; whether it supports the claim beside it is for you to read. The skill's
  rule is that the quote must contain what the node states — the number, the name, the position —
  and the viewer shows the excerpt around every quote so you can see for yourself. Read it.
- **Every claim cites a quote.** A node without a resolving citation is shown as **unverified** in
  the viewer, in `check`, and in the export — it is the model's claim, not a record.
- A quote verifies only if those words occur, whole and in that order, in one turn of the
  transcript. Case, punctuation and markdown are forgiven; a changed word, number or operator is
  not. Three-word minimum (a word has a letter in it — symbols and bare numbers do not count); an
  elided quote (`…`) is accepted only in bounded form and is labelled "with omissions".
- Only the conversation is indexed: what the user typed and what the model replied. Slash-command
  output, relayed subagent reports, task notifications and system reminders arrive in the
  transcript as `user` records, and the indexer drops them — a quote from one never resolves.
- The transcript is the most private thing on the machine. It is read locally, never copied, and
  the server that shows excerpts from it answers loopback only.

## Files

| path | what |
|---|---|
| `.aang/map.json` | the map — machine copy, hand-editable |
| `.aang/candidate.json` | what the model wrote this run; consumed by `merge` |
| `.aang/session.json` | which transcript this session writes — the hook writes it, `merge`, `check` and `view` read it |
| `.aang/outbox.jsonl` | the verdicts you pressed in the viewer, one per line, until the hook hands them to the agent |
| `.aang/config.json` | yours, optional: `nudge_turns` and `nudge_minutes` for the `Stop` hook |
| `docs/decisions.md` | `aang export` — the human copy to commit |
| `.claude/skills/aang/SKILL.md` | the skill — the prompt that writes the map |
| `docs/spec.md`, `docs/plan.md` | why it is shaped this way |

Tests: `python3 -m unittest discover -s tests -t .`
