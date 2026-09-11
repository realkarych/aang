# Scenario challenge — `aang view` on the real 20-node map

Method: `aang view --port 8801`, driven with Playwright (accessibility snapshots + DOM measurements at 1200×762), plus `ui/index.html` read in full, plus a script over `.aang/map.json`. Transcript tail read to see what the map does not cover. No code changed.

Baseline facts that every scenario runs into:

- Spine order is kind-grouped (tacit → open → decision), newest-first *by array position*, not by turn. No timeline anywhere.
- At 1200×762: 4 of 20 rows above the fold; "Решения" heading at y=1705 (2.2 screens down); page is 3076px ≈ 4 screens.
- Every row's `why` is one line, `nowrap` + ellipsis: **~47 visible chars** of 60–340. Full text only on hover (title) or by clicking the row.
- Structure in the map: **1 typed edge** (`d3 superseded_by d4`). Prose references to node ids: exactly 4 — `o1.why→d6`, `o6.why→d7`, `d11.why→d5`, `t6.consequence→t1`. None of them is a link (`textVal` escapes; `detailLinks` in the pane = 0 except the supersede notice).
- Of the 4 prose refs, 2 are visible in the truncated spine line (`o6` at char 10, `o1` at char 19), 1 is hidden (`d11` at char 96), 1 is in `consequence`, which the spine never shows.
- Transcript: 68 turns. Last cited turn: 52. `generated_at` 13:29. The session kept going (turns 65–78 include the user asking for search and a graph view). Nothing in the header says "covers turns 2–52".

---

## 1. «Вернулся — что решено» — PARTLY WORKS; the half it fails is the half that was asked for

What I did: opened `/`, read the spine top to bottom. 0 clicks to see t6–t3; 3 full scrolls to reach d1; 20 row-clicks (or 20 hovers) to read any `why` past 47 chars. Header gives counts (6/6/8, 1 superseded, all verified) — good, that is the one-glance state.

What I had to hold in my head: the turn order. The spine shows no turn per row, so "d5 came before d6 came before d7" is recoverable only by opening each and reading the citation's `ход N`. To rebuild the *sequence* of the session I opened 8 decision rows and wrote the turns down myself: d1(2) d2(5) d3(20) d4(22) d5(27) d6(34) d7(40) d11(49). That is 8 clicks and a notepad to get what one column would give.

Where it breaks — "where work stopped": nowhere on the surface. The map ends at turn 52; the transcript has 68 turns; the header shows only a wall-clock `generated_at`. A returning reader cannot tell whether the map is current. In this session it is not: turns 53–78 contain the user's next request (search + graph) and the whole brainstorm that followed. The reader would trust a picture that is 16 turns stale with no signal.

Cost: the picture is rebuilt (works), the "where did I stop" is answered wrongly-by-omission (fails). Note also that o4/o5 ("branch not merged", "folder not in git") are the only nodes that resemble "where work stopped" — and they are repo housekeeping that `git status` answers better.

## 2. «Почему пришли к X» (d4) — WORKS for the one edge that exists; gives a verified answer that is wrong in effect

Sequence: `#d4` (or 1 click) → pane shows `Заменяет: [d3]` → 1 click → d3 pane shows `Заменено узлом [d4]`, strikethrough, `why` = why 24h was chosen. Back: 1 click. Excerpt: +1 click per citation. **Total 2–4 clicks.** This is the best-served path in the tool, because it is the only relationship that is structure.

What the structure delivers: what d4 replaced (d3) and d3's reason. What the reader gets only from prose: the arguments that carried 72h ("трое суток переживают выходные") live in `d4.why` and are **not in the quote** — the ✓ proves "Поднял до 72" was said (turn-22 excerpt is one sentence), not the weekend argument. Fine per the trust model, but the reader should know the "why" is the model's gloss.

What the reader **misses entirely**: d4 is moot. d6 (turn 34) says the invoked tool «снимает тревоги, протухание и бдительность» — the attention-queue staleness threshold is the thing d4 sets, and the product that had a queue is now subagent-flow, whose fate is o1 ("Что теперь с subagent-flow?"). So the honest answer to "why 72h" is: "because 24h killed yesterday's tasks — and then 12 turns later the whole mechanism left the product." Nothing on d4 says this: status `принято`, no link, no notice. To discover it you must read `d6.why` and `o1.why` and *know* that «протухание» is d4's subject. Two prose reads plus domain memory, versus zero structure.

Verdict: traversal backwards works because `superseded_by` exists. Traversal forwards ("what happened to this later") does not exist, and here it inverts the answer.

## 3. «Что сломается, если поменять» (t2, t5) — DOES NOT WORK; served entirely by Ctrl+F and memory

**t2 (Python 3.9, stdlib-only).** Open `#t2`: pane shows no dependents (no reverse index; the pane only computes `replaces`). Spine search for `Python`/`3.9`/`зависим` → 1 hit each, all t2 itself. Structural dependents found: **0**. Prose dependents found: **0 in the map** — t2's own `why` lists what rests on it ("комментарии-типы, http.server, отсутствие зависимостей"), but those are code facts, not nodes. In-map nodes that actually rest on t2: d7 (the matcher — "граница безопасности" — is hand-rolled under stdlib), d6 (viewer = `http.server`). Found by: knowing the codebase. Miss rate for a reader who does not: 100%. Changing t2 looks free.

**t5 (3 words / 12 chars / 50-word gap).** Open `#t5`: no dependents. Spine search `t5` → 1 (itself). Search `цитат` → 7 rows; read each `why` in full (7 clicks, since the spine cuts them). Dependents recovered by reading sentences:
- d7.against — «часть честных цитат прочтётся как непроверенные»: that sensitivity is exactly t5's numbers.
- o6 — the negation hole passes *because* a contiguous ≥3-word fragment passes; o6.why says «Следствие d7», so a reader following the only pointer lands on d7 and never on t5, which is the actual knob.
- d11 — the rule "quote must contain the claim" exists because a 3-word floor makes a passing quote cheap.

Count: **3 dependents, 0 via structure, 3 via reading 7 full `why` fields, 1 of them (o6) actively mis-pointed.** A reader who follows pointers instead of reading everything finds nothing and concludes t5 is a leaf.

Cost: scenario 3 on this map is `grep -i цитат .aang/map.json` with a nicer font. The viewer adds nothing over the file for it.

## 4. «Что я не выбирал и что висит» — WORKS as placement; fails as triage

What works: tacit first, open second, both above the decisions; header counts; 4 tacit rows in the first screen with no clicks. Findable: yes. The surface honours R3.

What it does not do:
- For tacit nodes the payload is «откуда взялось», and the spine shows 47 chars of it. t1's row shows «Нигде в разговоре не произнесено: ни пользователь, ни …» — the actual origin (first user message was in Russian) is behind a click. All 6 need a click each.
- The six open rows are visually identical: `□ question / без ответа / 47 chars / предложено ✓`. But they wait on different things: o1, o5 wait on the **user** (o5: «Я дважды сказал, что это решение пользователя»); o2, o3 are research items; o6 is an engineering choice; o4 is repo housekeeping. No "waits on whom / since turn N" — the reader re-derives it from prose six times.
- `предложено` on every open node is noise: an open question proposes nothing. Same tag on all six = zero information.
- Nothing marks "seen". t1–t6 will sit at the top on every run forever; after the second look the highest-value band becomes wallpaper. The spec's own vigilance argument (d5) applies to this band.
- o4/o5 are not orphaned consequences of *decisions*; they are unfinished chores. They dilute the group the tool exists for (o1, o6 are the real thing).

---

## Challenge to the four scenarios

**Two of them are one.** S1 and S4 collapse: the returning reader's first question *is* "what is hanging"; the spine already merges them by putting open/tacit on top. What is left of S1 after S4 is "where did I stop", which the map cannot answer (no as-of turn) and which the last three transcript turns or `git log -3` answer better. Keep S4, fold S1 into it, and give S1's residual to a one-line "covers turns 2–52 of 68 — 16 turns unmapped" in the header.

**S2 is real, and it is the tool's only proven path.** Two clicks, verified, with the losing side kept. But this session shows the chain needs more than `superseded_by`: a decision can be made moot without being replaced (d4 by d6). Without a "made moot by / orphaned by" edge, the backward walk is clean and misleading.

**S3 is the story people tell.** On a 20-node map nobody traverses; they Ctrl+F. The scenario is real only when edges exist, and today there is one. It is also the only scenario a graph view would serve — which means a graph drawn today is 20 dots and one line (the lead already saw this). S3 should be the *reason* to add edges, not a claim the viewer serves now.

**Fifth job nobody named: hand-off.** The map was the only data given to me, a fresh agent, to do this task; and it is the input the next `/aang` reads to decide what to supersede. The map is read more by agents and by the next run than by the returning human. That job wants ids, edges and as-of-turn — machine-readable structure — more than it wants prose. The `#d4` URL is also the only deixis the spec promised ("you cannot point at anything") and no scenario names it.

**What the tool should refuse:** "where did work stop" (transcript tail / git log), and open nodes that are chores (o4, o5 — `git status`). Also S3 at the code level: t2's list of what rests on it in *code* belongs to grep; the map should hold only in-map edges.

---

## The one change for the worst scenario (S3)

Add typed node→node edges to the schema, written by the model in the candidate, validated against existing ids, and rendered as **links with a reverse index** in the pane ("На этом держится: d7, d11, o6") and as chips in the spine. Minimum vocabulary, matching what the prose already says:

- `rests_on: [id]` — this node assumes that one (t5 → d7; o6 → t5; d6 → t2).
- `raised_by: id` — for `open`: which decision orphaned it (o1 → d6; o6 → d7/t5; o4 → its own decision).
- `moots: [id]` — this decision made that one irrelevant without replacing it (d6 → d4). The pane shows it on d4 as a notice, like `Заменено узлом`.

Prompt rule: every `open` names `raised_by`; every `tacit` names at least one `rests_on` in reverse (or the model lists what rests on it); an id mentioned in prose without an edge is a validator warning. Cheap stopgap that is *not* enough: linkifying `\b[dto]\d+\b` in prose + auto-reverse index gets the 4 existing refs and does nothing for t2/t5, which are mentioned nowhere. Real cost today: 3 of 3 t5 dependents invisible, 1 mis-pointed; d4 shown as live when it is dead.
