---
name: aang
description: Map what this session decided — the decisions, the values that started mattering without anyone choosing them, and the questions and consequences left hanging — as a verifiable file with a local viewer. Run when the user types /aang, or when the aang hook tells you to refresh the map; never on your own initiative.
---

# /aang — write down what this session decided

You are recording what this conversation settled, what it assumed without deciding, and what it
left open. The result is `.aang/map.json`: merged from a candidate you write, verified against the
session transcript by `aang`, shown in a local viewer.

## Write it from memory. You were there.

You have the whole conversation in context. That is the entire reason this map can be good: the
participant writes it, not a summarizer reading a log afterwards.

- Do not open, grep or index the transcript under `~/.claude/projects` or `~/.codex/sessions`. Do
  not re-read project files "to refresh". Do not hand this to a subagent — it was not here, it
  would have to read the log, and that is precisely the post-hoc summary this tool exists to avoid.
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
why it hangs; for an orphaned consequence, **the decision that orphaned it is an edge** —
`relates: [{"to": "d6", "rel": "orphaned_by"}]` (see "Relations") — and `why` may name the id
again if the sentence needs it, but the edge is the record, the prose is not; `status: proposed`.
Cite the line that raised it. For a consequence you derive now, there is no line that raised it —
cite the decision it follows from: **quote the line where that decision was made, the same quote
its node carries** (copy it from that node's `cites`), and put the edge in `relates`. A cite has
no field for a node id; `{"quote": "d3"}` is not a citation. Only consequences you can trace to a
specific node; a generic risk with no decision behind it is not part of the record.

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
  neither agreed to nor objected to; `superseded` when a later node replaced it; `rejected` when
  the user said no — keep the node, put the reason in `against`.
- `decided_by` — `user` when the user chose or agreed in words or by acting; `agent` when you chose
  and the user has not yet weighed in — then `status: proposed`.
- `triage` — `research` / `discuss` when the user said «изучи» / «обсудим»; `null` otherwise. Only
  on `proposed` decisions and `open` nodes.

## Пачка в конце шага

A long step ends in a batch: a few things you settled yourself, a couple of things you are handing
to the user to look at, one thing you want confirmed. That batch is the map's raw material, and
each part of it has a shape. Lay it out like this.

- **What you decided yourself** is a `decision` with `status: proposed` and `decided_by: agent`.
  Never `accepted` — that is for after the user agreed, in words or by acting on it. The call was
  real and belongs on the map; the status is what says nobody else has weighed in yet, and the
  viewer keeps it in «Входящем» until someone does.
- **«Обрати внимание на X», «запусти Z»** — something you are handing over — is an `open` node
  with `orphaned_by` on the decision it follows from, and a `why` that says whom it is addressed
  to. You did not answer it, you passed it on; that is what makes it open and not a decision.
- **«Уточни, правильно ли ABC»** is an `open` node whose `why` says the question is addressed to
  the user. A question with an addressee gets answered; a question with none reads as a musing and
  hangs on the map forever.
- **A verdict the user gave in the chat** — «нет», «давай изучим», «обсудим потом», «да, так» — is
  not prose to record. It is `status` / `triage` / `decided_by`, written on the next refresh:
  «да, так» → `status: accepted`, `decided_by: user`; «нет» → `status: rejected`, with what they
  said in `against`; «давай изучим» → `triage: research`; «обсудим потом» → `triage: discuss` —
  and either of those last two also puts the node back to `status: proposed`, because a thing
  under question is not a settled thing. A verdict on an `open` node answers it instead: what the
  user said becomes its `decision`, `decided_by: user`, and the node is a decision from then on —
  an open question is the one thing that can be neither accepted nor rejected. The same four
  verdicts arrive from the viewer through `.aang/outbox.jsonl` (Procedure, step 0); they mean the
  same thing and are written the same way.
- **Rejected stays as `rejected`, never deleted.** The node remains with the reason in `against`.
  That is what stops the next session from proposing the same thing again; deleting it throws away
  the only thing the rejection bought.

## The grammar

IBIS, deliberately poor: positions answer questions; arguments attach to positions; anything may be
questioned. In this file that means: one node is one question with at most one position and its
arguments. Two positions on the same question are two nodes with the same `question`, at most one
of them `accepted`. A questioned decision is an `open` node that points at it (`orphaned_by`,
below).

**A decision is never edited.** If the conclusion changed, add a new node and set the old one's
`status` to `superseded` with `superseded_by` pointing at the new id; leave its text as it was.
The old node stays visible, struck through, next to what replaced it. That is what stops the
argument from being re-litigated: the next reader sees that A was decided, why, and that B then
replaced it — instead of finding only B and proposing A again.

## Relations — an edge, not a sentence

«Осиротело решением d6» inside `why` is true and invisible: the reader who does not read that
field never learns it, and the viewer cannot show what holds on `t5`, or sort the open questions
into the ones a decision orphaned and the ones that merely hang, from words. A relation between
two nodes is written as an edge; the prose may repeat it, and never replaces it:

```json
"relates": [{"to": "d7", "rel": "orphaned_by"}, {"to": "t5", "rel": "rests_on"}]
```

Three values of `rel`, on three kinds of node:

| `rel` | on which node | means |
|---|---|---|
| `orphaned_by` | the `open` node | that decision left this question hanging — it would not exist without it |
| `rests_on` | the dependent node | this holds on that decision or tacit value; if that moves, this moves |
| `moots` | the newer decision | that decision stopped mattering because of this one — and nothing replaced it |

`superseded_by` is the fourth relation and **stays its own field on the old node**. It does not
move into `relates`; it is the one edge that points at a later node, kept as it is for that reason.

**Backward only.** An edge sits on the node that comes later in `nodes` and points at one above
it. Not a limitation to be clever around, a guarantee: you can only point at what you have already
written, so an edge to a node that does not exist cannot be typed — and since no edge points down
the list, no cycle is possible, which is why the validator checks direction and needs no cycle
check. `merge` refuses a forward edge (`ссылка вперёд`) and writes nothing.

**So the list order follows the dependency, not the discovery.** A tacit value is noticed late —
it surfaces when something built on it goes wrong, long after the decisions that rest on it were
made — but it was depended on early, and the edge has to be able to say so. The real case: `d7`
(proof by verbatim quote) rests on `t5` (the three-word evidence threshold); with `t5` written
eight nodes below `d7`, `d7 rests_on t5` cannot be typed, and «на этом держатся» under `t5` reads
`d11, o6` — silently missing the one dependent the user selected `t5` to find. Do not invert the
edge to get past the rule: `t5 rests_on d7` is a false statement, and the viewer would then tell
the reader that changing `d7` breaks the threshold. Instead, **place a node in `nodes` before the
first node that rests on it.** Its position is when it began to matter, not when you noticed it.
Ids are permanent labels and carry no order — `t5` standing above `d7` is fine, and its id does
not change — only the list position is checked, and `merge` takes the candidate's order, so on a
repeat run a foundation moves up the moment you see what depends on it. The same holds for any
foundation noticed late, not only a tacit one: whatever is depended on stands above whatever
depends on it.

**At most three per node, in total** — not three of each kind. The cap is on fan-out. Wanting a
fourth means you are listing context, not dependency: keep the three whose change would move this
node, and tell the user what you left out. For the same reason do not point every later node at
the decision that started the work: «everything rests on the product» is not information.
`rests_on` names a specific value or mechanism, not the project a node belongs to.

**`moots` against `superseded_by`.** Both are about a decision no longer in force. The question
that tells them apart: *did a new decision answer the same question differently?* Then the old one
is `status: superseded` with `superseded_by` pointing at the new one. *Or did the question itself
stop mattering, so that nobody answers it any more?* Then the new decision `moots` the old one,
and the old one keeps its status — there is no replacement to point at, and it was never wrong.
The real case: `d4`, the 72-hour threshold after which a waiting task stops claiming attention,
was never replaced by another threshold. It died when the product turned into `/aang` (`d6`), a
tool invoked by hand that watches nothing and so has no queue to age. `d4` is not superseded;
`d6` `moots` it. Without that edge the map showed `d4` as `accepted` and alive, and the next reader
would have defended a number nothing uses.

**`orphaned_by` against `rests_on`, on an `open` node.** *Would this question exist at all
without that decision?* `orphaned_by`. *Does what happens to it depend on a value that could
move?* `rests_on`. One node may carry both: `o6` (a quote that begins right after a standalone
«не» passes and inverts the meaning) is `orphaned_by` `d7` — proof by verbatim quote is what lets
a fragment inside a negation through — and `rests_on` `t5`, because how often it bites is set by
the three-word threshold.

**Every `open` node carries `orphaned_by`, or says in `why` that nothing did.** This is what the
viewer's triage is drawn from: an open node with `orphaned_by` is filed under «осиротело
решениями», one without under «просто висит», and nothing else decides it. So for every open node
either name the decision in `relates`, or write, in a sentence, that no decision caused it — it
was raised and dropped, offered and not answered. If the decision that orphaned it is not in the
map, that is usually a tacit you missed — your own silent choice while implementing — so add it
with its citation and point at it; if it cannot earn a node, say in `why` that the cause is not on
the map. An open node with neither edge nor sentence is a question you did not finish asking.
`aang check` prints `△ узел o3: открытый вопрос без orphaned_by — укажите решение или скажите в
why, что его нет` for every open node without the edge. The checker cannot read your sentence, so
the remark stands on an honestly hanging question too; do not invent an edge to silence it — make
sure the sentence is in `why`, and let it stand.

**Write the edge where you would write the words.** When `why` or `consequence` is about to say
«следствие d7», «держится на t2», «из-за d6», the edge is already in your head: put it in
`relates` and let the prose keep the id if the sentence reads better with it. An id in prose with
no edge is caught — `aang check` prints, after its verdict, a remark of the form
`△ узел o1: в тексте упомянут d6, но связи на него нет`, or `… — d6 ниже по списку: связь
ставится на нём, или d6 поднимается выше` when the mentioned node is later in the list — either
the later node is the one that depends (`d6 moots …`, `o6 orphaned_by …`: the edge goes on it), or
this node rests on the later one, and then the later one moves up the list, as in «Backward only».
It is a remark, not a failure: the exit code does not change. Add the edge when the relation is real. When
the id is merely mentioned — an example, a «см. также», a «расходится с» that none of the three
names — leave the prose as it is and let the remark stand; the vocabulary is poor on purpose, and
bending `rests_on` into «связано с» would make every edge mean less.

**You never write `related_by`.** «На этом держатся: d7, d11, o6» is the reverse of everyone
else's `relates`, computed by the server when the map is shown; `merge` strips it from every node.
Writing it is work thrown away, and a stored copy would be wrong the moment one node changed.

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
      "decided_by": "user",
      "triage": null,
      "superseded_by": null,
      "question": "Чем мерить качество прогона?",
      "decision": "pass@1 на отложенном наборе",
      "why": "k>1 маскирует нестабильность промпта",
      "against": ["Дисперсия выше, нужен набор существеннее"],
      "consequence": "500 примеров вместо 100, прогон дорожает втрое",
      "cites": [{"quote": "давай pass@1 на отложенном наборе"}],
      "relates": [],
      "hand_edited": false
    }
  ]
}
```

- `kind`: `decision` | `tacit` | `open`. `status`: `accepted` | `superseded` | `proposed` |
  `rejected`. `superseded_by` is an existing node id, or `null`; `status: superseded` requires it
  and it requires `status: superseded`.
- `decided_by`: only on a `decision` — on a `tacit` or an `open` the validator refuses it. `null`
  (or absent) when you genuinely cannot tell who decided; the viewer then shows «решил: ?», which
  is honest, and «agent» would not be.
- `triage`: `research` | `discuss` | `null`, and only on a `proposed` decision or an `open` node —
  on `accepted`, `rejected` and `superseded` the validator refuses it, because a thing under
  question is not a settled thing.
- `relates`: the edges (see "Relations"), each `{"to": <id above in the list>, "rel": ...}`, at
  most three. `[]` when none — and on an `open`, `[]` means `why` says that no decision caused it.
- `added_at`: never write it. `merge` stamps it when a node first enters the map and never
  rewrites it; the viewer's «новое» marks come from it. A value from you would be a guess, like a
  turn number, and is dropped the same way. `related_by`: never — the server derives it.
- `id`: `d1, d2…` for decisions, `t1…` tacit, `o1…` open, numbered in order of first appearance.
  Ids are permanent — never renumber, never reuse. If a node's kind changes later (a tacit the user
  then confirmed becomes a decision), keep its id; the prefix is a hint from birth, not a rule.
- `nodes` in the order the conversation reached them, with one override: a node stands above the
  first node that rests on it, even when the conversation reached it later (see «Backward only»).
  The viewer shows newest first.
- `session_id`: leave it `""`. You do not know your own session id and must not guess one; the
  hook does — it writes `.aang/session.json`, and `merge` (step 6) resolves the transcript from
  there, stamps the session into the map and prints which file it read, so confirm it is this
  session. On a repeat run the map already records it.
- `generated_at`: now, ISO 8601 UTC (`date -u +%Y-%m-%dT%H:%M:%SZ`).
- `title`: `<project> · <what this session was about>`, short.
- Text fields in the language the conversation was held in. A sentence or two each; the map is a
  spine, not prose.
- `hand_edited` is always `false` from you. You never set it.

## Procedure

0. If `.aang/outbox.jsonl` exists and is not empty, read it: each line is a verdict the user gave
   in the viewer (`confirmed` / `rejected` / `research` / `discuss` on a node, with an optional
   text). Carry every verdict into the candidate — `status: rejected`, `triage: research|discuss`,
   an answered `open` becomes a `decision` with `decided_by: user` — and after a successful merge
   empty the file (`: > .aang/outbox.jsonl`). The user already told you this; arriving at the
   opposite answer without saying why is the one thing that makes the viewer's buttons useless.
1. If `.aang/map.json` exists, read it. Note every id and every `hand_edited: true`.
2. Think through the tacit questions, then the open questions, then the decisions. Apply the
   selectivity test to each node.
3. With the nodes in order, walk them once more for edges: every `open` gets `orphaned_by` or its
   sentence in `why`; every id you typed into prose gets its edge or a reason it has none;
   `moots` on any decision that killed an older one without replacing it. An edge points only
   upward in the list: when one would point down — a tacit value under the decision that rests on
   it — move the foundation up, above its first dependent, and then write the edge.
4. Write `.aang/candidate.json` (create the directory if needed).
5. Find the CLI, once, in a Bash call. It is `aang` on PATH when installed as the README says;
   otherwise it is `bin/aang` in the aang checkout, three levels up from this skill's directory —
   the harness printed `Base directory for this skill: <dir>` when this skill loaded, and that
   directory is usually a symlink into the checkout, hence `pwd -P`. This prints the path, trying
   PATH, then the base directory, then the parents of the current directory; replace `<dir>`:

   ```sh
   command -v aang 2>/dev/null \
     || ls "$(cd "$(cd "<dir>" 2>/dev/null && pwd -P)/../../.." 2>/dev/null && pwd -P)/bin/aang" 2>/dev/null \
     || { d="$PWD"; while [ "$d" != / ] && [ ! -x "$d/bin/aang" ]; do d="$(dirname "$d")"; done; ls "$d/bin/aang" 2>/dev/null; }
   ```

   Use the absolute path it printed as `aang` in every command below — shell variables do not
   survive between Bash calls, so do not store it in one. If it printed nothing, stop and tell the
   user `aang` is not installed (README, Install).
6. Run `aang merge` — no `--session`: merge knows the session from `.aang/session.json`, written by
   the hook; without that file it falls back to the session id the map already records, and only a
   map that names none takes the newest transcript under `~/.claude/projects` or
   `~/.codex/sessions`. It prints which file it read and how it knew — read that line and confirm
   it is this session. It validates the candidate, finds each quote in the transcript, fills in
   turns, merges into `.aang/map.json` preserving hand edits, and prints what it kept, added,
   dropped, and which quotes it could not find.
   - Exit 1 with `невалиден`: the candidate broke the schema; the errors name node and field.
     Nothing was written. Fix the candidate and run again.
   - Exit 0 with `не найдено: N`: those nodes are in the map, unverified. See step 7.
7. Run `aang check` — no `--session` either: it finds the transcript exactly as `merge` did, and
   prints which file that was; confirm again that it is this session. It prints every node with
   ✓/✗ and the reason for each failing quote, and exits 1 if any citation failed. For each ✗: if
   you misquoted a line you clearly remember, write a corrected candidate (same ids, all nodes)
   and merge again — **once**. Do not iterate hunting for
   a quote that resolves; after one correction pass, whatever is still ✗ stays unverified, and you
   say so. Then the check the tool cannot do: **for every ✓, re-read the quote and ask whether it
   says what the node says** — the number, the name, the position. If it does not, replace it with
   the line that does (this counts as the one correction pass) or drop it and let the node stand
   unverified. A ✓ beside a quote that does not support the node is worse than a ✗.
   After the verdict `check` may print `Замечания` — ids mentioned in prose with no edge. They
   fail nothing; fold them into the same correction pass: add the edge where the relation is real
   (on the later node, when the remark says so), and leave a bare mention alone.
8. Start the viewer in the background: `aang view` — again no `--session`; it finds the transcript
   the same way, and its header names the file, so the user can confirm it is this session too. It
   serves until stopped — use the Bash tool's background mode. Its output carries the URL,
   `http://127.0.0.1:8790/` by default. If `aang view` prints
   `уже запущен`, the viewer is already open on that URL — do not start another. If the port is
   held by something else it exits 1 — retry with `--port 8791`.
9. Tell the user, briefly: the URL; how many tacit / open / decision nodes; how many of the open
   ones a decision orphaned and how many merely hang; how many nodes are waiting in «Входящем» —
   your own proposals (`proposed`, `decided_by: agent`) plus the open questions the user has not
   marked seen; which nodes are unverified and, in one line each, why. Do not paste the map — the
   viewer is for that. Mention that `aang export` writes `docs/decisions.md` if they want the
   record committed. On a repeat run — there was a map before this one — no `.aang/session.json`
   (or a `merge` line saying it took the newest transcript) means the hook is not installed: add
   one line, `aang install` connects live updates. On the first run in a project, say nothing: the
   hook does nothing until `.aang/map.json` exists, so even an installed one has had nothing to
   record yet and starts at the next event.

## Running again in the same session

`/aang` is usually run more than once. Merge matches nodes by id:

- **Re-emit every node in `.aang/map.json`** that is still true, with its existing id, superseded
  ones included — a node you leave out is dropped (unless hand-edited or superseded; merge keeps
  those). Then add the new ones.
- **Only nodes present in `.aang/map.json`.** A node you emitted in an earlier run that is no longer
  in the file was removed by the user. That is a hand edit — the most basic one. Do not bring it
  back, however true it still seems; if you believe it matters, say so to the user instead.
- Superseded nodes are history: merge keeps them even if you forget them, and keeps their stored
  text, status and `superseded_by` whatever you write — it will not reword, revive or repoint one.
  Re-emit them anyway, unchanged, so the record and the candidate agree.
- Nodes marked `hand_edited: true` are the user's: merge keeps their text regardless of what you
  write, and you cannot overwrite them. You may still supersede one — write it with
  `status: superseded` and `superseded_by`, and merge applies exactly that and nothing else.
- **Edges are part of the node** and travel with it. Re-emit each node with its `relates`; an
  ordinary node re-emitted without them loses them, because it was regenerated — that is what
  re-emitting means. Adding an edge to an old node is the usual second-run gain: an `open` from
  the first run that a decision since then orphaned, a decision that mooted an older one.
- Frozen (superseded) and hand-edited nodes keep the edges they have, whatever you write — merge
  will not add, drop or repoint one. If a hand-edited node needs an edge, tell the user. A node
  such a kept edge points at is kept too, even when you leave it out, and merge says so
  (`сохранены (нет в кандидате, но на них ссылаются сохранённые узлы)`).
- A conclusion that changed since the last map: new node, old one superseded. Never rewrite the
  old one's text.
- A node you now think was wrong (not superseded — wrong): leave it out, and tell the user you
  dropped it and why. If it was hand-edited, tell the user; only they can remove it.

## Never

- Write `.aang/map.json` directly. It bypasses the merge and silently destroys the user's hand
  edits on the next run.
- Guess a turn number. Invent, tidy or translate a quote.
- Write `related_by` or `added_at`, or an edge that points down the list.
- Write `seen_at`. It records when the user last looked at the node — the server stamps it when
  they press «видел», and `merge` drops it from a candidate like a turn number.
- Mark an `open` node `accepted` or `rejected`: answer it (it becomes a decision) or leave it. The
  validator refuses both, because an open question with a verdict on it is a decision nobody wrote
  down.
- Mark a mooted decision `superseded`: nothing replaced it, and `superseded_by` would have nothing
  to point at. The edge is `moots`, on the decision that killed it.
- Delegate to a subagent.
- Record the conversation. Record what it decided, assumed and left hanging.
