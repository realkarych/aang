# Связи, поиск и триаж карты — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Сделать связи между узлами карты первоклассными данными и показать их в списке — вместе с поиском, границей покрытия и триажем открытых узлов.

**Architecture:** Новое поле `relates: [{to, rel}]` с закрытым словарём из трёх значений плюс существующее `superseded_by`; валидатор проверяет цели, направление и потолок; `merge` штампует `added_at`; вьюер считает обратный индекс, рисует чипы соседей, дуги только у выбранного узла, поиск и строку покрытия. Ни канваса, ни графовой библиотеки, ни сохранённых позиций.

**Tech Stack:** Python 3.9 (только стандартная библиотека), один самодостаточный `ui/index.html` без сборки и без внешних запросов.

**Spec:** `docs/superpowers/specs/2026-09-11-map-relations-and-search-design.md` — план аргументирует от неё; исполнители читают обе.

## Global Constraints

- Python 3.9.6, **только стандартная библиотека**. Ни pip, ни сторонних импортов.
- **Никакого синтаксиса 3.10+**: ни `match`, ни `X | None`, ни встроенных генериков (`dict[str,int]`), вычисляемых в рантайме. Только `typing.Optional` / `Dict` / `List` или комментарии-типы.
- Пакет — `src/aang/`. Тесты в `tests/`, весь набор зелёный из корня репозитория: `python3 -m unittest discover -s tests -t .` (167 тестов на старте).
- **Ни один тест не читает настоящий `~/.claude`.** Фикстуры в `tests/fixtures/`, корни передаются явно.
- Сервер слушает только `127.0.0.1`; проверки `Host`, `Origin` и `Content-Type` не трогать.
- `ui/index.html` остаётся одним файлом без сборки, без CDN и без единого внешнего запроса.
- Пользовательские строки — русские; идентификаторы, ключи и комментарии в коде — английские.
- Обратная совместимость: карта без `relates` и без `added_at` обязана открываться и проверяться.

---

### Task 1: Схема — словарь связей и валидация

**Files:**
- Modify: `src/aang/schema.py` (константы рядом с `KINDS`/`STATUSES` на строках 14-16; `_validate_node` со строки 85; `normalize` со строки 206; `empty_map` со строки 245)
- Test: `tests/test_schema.py`

**Interfaces:**
- Consumes: `validate(map_dict) -> List[str]`, `normalize(map_dict) -> Dict[str, Any]`, `KINDS`, `STATUSES`.
- Produces: `RELS = ("orphaned_by", "rests_on", "moots")`; `MAX_RELATES = 3`; каждый узел после `normalize` имеет ключ `relates` (список, возможно пустой) и ключ `added_at` (строка, возможно пустая); `validate` возвращает ошибки для плохих связей и **предупреждения** для id, упомянутых в прозе без ребра.

- [ ] **Step 1: Написать падающие тесты валидации связей**

```python
def test_relates_rejects_unknown_rel(self):
    m = _map([_node("d1"), _node("d2", relates=[{"to": "d1", "rel": "зависит"}])])
    self.assertTrue(any("rel" in e and "d2" in e for e in schema.validate(m)))

def test_relates_rejects_missing_target(self):
    m = _map([_node("d1", relates=[{"to": "d9", "rel": "rests_on"}])])
    self.assertTrue(any("d9" in e for e in schema.validate(m)))

def test_relates_rejects_self_reference(self):
    m = _map([_node("d1", relates=[{"to": "d1", "rel": "rests_on"}])])
    self.assertTrue(any("d1" in e for e in schema.validate(m)))

def test_relates_rejects_forward_reference(self):
    # d1 стоит в списке раньше d2, поэтому d1 -> d2 это ссылка вперёд
    m = _map([_node("d1", relates=[{"to": "d2", "rel": "rests_on"}]), _node("d2")])
    self.assertTrue(any("вперёд" in e for e in schema.validate(m)))

def test_relates_caps_fan_out_at_three_total(self):
    nodes = [_node("d1"), _node("d2"), _node("d3"), _node("d4")]
    nodes.append(_node("d5", relates=[
        {"to": "d1", "rel": "rests_on"}, {"to": "d2", "rel": "rests_on"},
        {"to": "d3", "rel": "moots"}, {"to": "d4", "rel": "moots"}]))
    self.assertTrue(any("не более трёх" in e for e in schema.validate(_map(nodes))))

def test_relates_allows_three(self):
    nodes = [_node("d1"), _node("d2"), _node("d3")]
    nodes.append(_node("d4", relates=[
        {"to": "d1", "rel": "rests_on"}, {"to": "d2", "rel": "rests_on"},
        {"to": "d3", "rel": "moots"}]))
    self.assertEqual([], schema.validate(_map(nodes)))

def test_map_without_relates_still_valid(self):
    self.assertEqual([], schema.validate(_map([_node("d1"), _node("d2")])))
```

Вспомогательные `_map` и `_node` уже есть в `tests/test_schema.py` — расширить `_node` необязательным `relates=None` и `added_at=""`, ничего больше не меняя.

- [ ] **Step 2: Запустить, убедиться что падают**

Выполнить: `python3 -m unittest tests.test_schema -v`
Ожидается: FAIL — `validate` не знает про `relates`.

- [ ] **Step 3: Реализовать словарь и проверки**

В `src/aang/schema.py` рядом с `STATUSES`:

```python
RELS = ("orphaned_by", "rests_on", "moots")
MAX_RELATES = 3
```

В `_validate_node` добавить проверку `relates`. Позиция узла в списке уже приходит параметром `pos`, а `ids` — словарь `id -> позиция`, поэтому направление проверяется сравнением позиций: цель обязана стоять **раньше**.

```python
def _validate_relates(node, pos, ids, label):  # type: (Dict[str, Any], int, Dict[str, int], str) -> List[str]
    errors = []  # type: List[str]
    relates = node.get("relates")
    if relates is None:
        return errors
    if not isinstance(relates, list):
        return ["%s: relates должен быть списком" % label]
    if len(relates) > MAX_RELATES:
        errors.append("%s: relates — не более трёх связей на узел, найдено %d"
                      % (label, len(relates)))
    node_id = node.get("id")
    for i, rel in enumerate(relates):
        where = "%s: relates[%d]" % (label, i)
        if not isinstance(rel, dict):
            errors.append("%s: должен быть объектом {to, rel}" % where)
            continue
        target = rel.get("to")
        kind = rel.get("rel")
        if kind not in RELS:
            errors.append("%s: неизвестный rel %r, допустимы %s"
                          % (where, kind, ", ".join(RELS)))
        if not _is_str(target) or not target:
            errors.append("%s: to должен быть непустой строкой" % where)
            continue
        if target == node_id:
            errors.append("%s: узел %s ссылается сам на себя" % (where, node_id))
            continue
        if target not in ids:
            errors.append("%s: цель %s не существует" % (where, target))
            continue
        if ids[target] > pos:
            errors.append("%s: ссылка вперёд на %s — связи указывают только назад"
                          % (where, target))
    return errors
```

Вызвать её из `_validate_node` и добавить результат к остальным ошибкам.

Отдельной проверки на циклы не нужно: если каждое ребро указывает строго назад по позиции в
списке, цикл построить невозможно. Спека требует «циклов нет» — требование выполняется
проверкой направления, а не вторым проходом.

- [ ] **Step 4: Запустить тесты**

Выполнить: `python3 -m unittest tests.test_schema -v`
Ожидается: PASS.

- [ ] **Step 5: Тест на предупреждения о прозе**

```python
def test_prose_id_without_edge_is_a_warning_not_an_error(self):
    m = _map([_node("d1"), _node("o1", kind="open", status="proposed",
                                 why="Осиротело решением d1: продукт развернулся")])
    self.assertEqual([], schema.validate(m))
    self.assertTrue(any("d1" in w and "o1" in w for w in schema.warnings(m)))

def test_prose_id_with_edge_is_not_warned(self):
    m = _map([_node("d1"), _node("o1", kind="open", status="proposed",
                                 why="Осиротело решением d1",
                                 relates=[{"to": "d1", "rel": "orphaned_by"}])])
    self.assertEqual([], schema.warnings(m))

def test_prose_mention_of_nonexistent_id_is_not_warned(self):
    m = _map([_node("d1", why="как в d99")])
    self.assertEqual([], schema.warnings(m))
```

- [ ] **Step 6: Запустить, убедиться что падают**

Выполнить: `python3 -m unittest tests.test_schema -v`
Ожидается: FAIL — `warnings` не существует.

- [ ] **Step 7: Реализовать `warnings`**

Отдельная публичная функция: предупреждение — не ошибка, карта с ним остаётся валидной и рисуется.

```python
_PROSE_ID_RE = re.compile(r"\b([dto]\d+)\b")
_PROSE_FIELDS = ("why", "consequence", "question", "decision")


def warnings(map_dict):  # type: (Any) -> List[str]
    """Непроверяемые замечания: карта валидна, но кое-что стоит поправить."""
    out = []  # type: List[str]
    data = normalize(map_dict)
    nodes = data["nodes"]
    ids = set(n.get("id") for n in nodes)
    for pos, node in enumerate(nodes):
        node_id = node.get("id")
        linked = set(r.get("to") for r in node.get("relates") or [])
        sup = node.get("superseded_by")
        if sup:
            linked.add(sup)
        mentioned = set()
        for field in _PROSE_FIELDS:
            for found in _PROSE_ID_RE.findall(node.get(field) or ""):
                if found in ids and found != node_id:
                    mentioned.add(found)
        for missing in sorted(mentioned - linked):
            out.append("%s: в тексте упомянут %s, но связи на него нет"
                       % (_node_label(node, pos), missing))
    return out
```

`import re` в начало файла, если его там ещё нет.

- [ ] **Step 8: Запустить тесты**

Выполнить: `python3 -m unittest tests.test_schema -v`
Ожидается: PASS.

- [ ] **Step 9: Нормализация новых полей**

```python
def test_normalize_fills_relates_and_added_at(self):
    out = schema.normalize(_map([_node("d1")]))
    self.assertEqual([], out["nodes"][0]["relates"])
    self.assertEqual("", out["nodes"][0]["added_at"])
```

В `normalize` добавить `relates` (список, по умолчанию `[]`, каждая запись приводится к `{"to": str, "rel": str}`) и `added_at` (строка, по умолчанию `""`). В `empty_map` ничего менять не нужно — она возвращает карту без узлов.

- [ ] **Step 10: Запустить весь набор**

Выполнить: `python3 -m unittest discover -s tests -t .`
Ожидается: OK, тестов больше 167.

- [ ] **Step 11: Закоммитить**

```bash
git add src/aang/schema.py tests/test_schema.py
git commit -m "schema: typed node relations, fan-out cap, prose-mention warnings"
```

---

### Task 2: Хранилище — `added_at`, слияние связей, экспорт

**Files:**
- Modify: `src/aang/store.py` (`merge` со строки 107, `_merge_hand_edited` со строки 185, `export_markdown` со строки 263, `_node_markdown` со строки 305)
- Modify: `src/aang/cli.py` (`cmd_merge` со строки 229, `cmd_check` со строки 102)
- Test: `tests/test_store.py`, `tests/test_cli.py`

**Interfaces:**
- Consumes: `schema.normalize`, `schema.validate`, `schema.warnings`, `schema.RELS` из Task 1.
- Produces: `store.stamp_added_at(map_dict, now_iso) -> Dict[str, Any]` — проставляет `added_at` узлам, у которых его нет; `merge` сохраняет `added_at` и `relates` по правилам ниже; `cmd_check` печатает предупреждения `schema.warnings` отдельным блоком и **не** меняет из-за них код возврата.

- [ ] **Step 1: Написать падающие тесты `added_at`**

```python
def test_stamp_added_at_only_fills_missing(self):
    m = {"version": 1, "nodes": [{"id": "d1", "added_at": "2026-01-01T00:00:00Z"},
                                 {"id": "d2"}]}
    out = store.stamp_added_at(m, "2026-09-11T12:00:00Z")
    self.assertEqual("2026-01-01T00:00:00Z", out["nodes"][0]["added_at"])
    self.assertEqual("2026-09-11T12:00:00Z", out["nodes"][1]["added_at"])

def test_merge_preserves_added_at_of_existing_node(self):
    old = _map([_node("d1", added_at="2026-01-01T00:00:00Z")])
    new = _map([_node("d1", why="переписано моделью")])
    out = store.merge(old, new)
    self.assertEqual("2026-01-01T00:00:00Z", out["nodes"][0]["added_at"])
```

- [ ] **Step 2: Запустить, убедиться что падают**

Выполнить: `python3 -m unittest tests.test_store -v`
Ожидается: FAIL — `stamp_added_at` не существует.

- [ ] **Step 3: Реализовать `stamp_added_at` и сохранение в `merge`**

```python
def stamp_added_at(map_dict, now_iso):  # type: (Dict[str, Any], str) -> Dict[str, Any]
    """Проставить `added_at` узлам, у которых его нет. Существующий не трогается."""
    for node in map_dict.get("nodes") or []:
        if not node.get("added_at"):
            node["added_at"] = now_iso
    return map_dict
```

В `merge`: узел, существовавший в `old`, сохраняет свой `added_at` независимо от того, что написала модель — рядом с тем местом, где уже сохраняются поля правленных руками узлов.

- [ ] **Step 4: Запустить тесты**

Выполнить: `python3 -m unittest tests.test_store -v`
Ожидается: PASS.

- [ ] **Step 5: Тесты слияния связей**

```python
def test_merge_keeps_relates_of_frozen_superseded_node(self):
    old = _map([_node("d1", status="superseded", superseded_by="d2",
                      relates=[{"to": "d0", "rel": "rests_on"}]),
                _node("d0"), _node("d2")])
    new = _map([_node("d1", status="superseded", superseded_by="d2", relates=[]),
                _node("d0"), _node("d2")])
    out = store.merge(old, new)
    frozen = [n for n in out["nodes"] if n["id"] == "d1"][0]
    self.assertEqual([{"to": "d0", "rel": "rests_on"}], frozen["relates"])

def test_merge_keeps_relates_of_hand_edited_node(self):
    old = _map([_node("d0"), _node("d1", hand_edited=True,
                                   relates=[{"to": "d0", "rel": "rests_on"}])])
    new = _map([_node("d0"), _node("d1", relates=[])])
    out = store.merge(old, new)
    kept = [n for n in out["nodes"] if n["id"] == "d1"][0]
    self.assertEqual([{"to": "d0", "rel": "rests_on"}], kept["relates"])

def test_merge_takes_relates_from_candidate_for_ordinary_node(self):
    old = _map([_node("d0"), _node("d1")])
    new = _map([_node("d0"), _node("d1", relates=[{"to": "d0", "rel": "rests_on"}])])
    out = store.merge(old, new)
    updated = [n for n in out["nodes"] if n["id"] == "d1"][0]
    self.assertEqual([{"to": "d0", "rel": "rests_on"}], updated["relates"])
```

- [ ] **Step 6: Запустить, реализовать, запустить**

Выполнить: `python3 -m unittest tests.test_store -v` — FAIL, затем провести `relates` через те же ветки, что уже защищают текст замороженных и правленных руками узлов, затем снова `python3 -m unittest tests.test_store -v` — PASS.

- [ ] **Step 7: Экспорт печатает связи**

```python
def test_export_lists_relations_in_words(self):
    m = _map([_node("d1", question="Порог?"),
              _node("o1", kind="open", status="proposed", question="Что с хвостом?",
                    relates=[{"to": "d1", "rel": "orphaned_by"}])])
    md = store.export_markdown(m)
    self.assertIn("осиротело решением d1", md)

def test_export_says_nothing_when_there_are_no_relations(self):
    md = store.export_markdown(_map([_node("d1")]))
    self.assertNotIn("осиротело", md)
```

Русские подписи отношений — один словарь, он же пригодится вьюеру:

```python
REL_LABELS = {
    "orphaned_by": "осиротело решением",
    "rests_on": "опирается на",
    "moots": "сделало неактуальным",
}
```

- [ ] **Step 8: `cmd_merge` штампует время, `cmd_check` печатает предупреждения**

```python
def test_check_prints_warnings_but_still_exits_zero(self):
    # карта валидна, но в why упомянут id без связи
    ...
    self.assertEqual(0, code)
    self.assertIn("в тексте упомянут", out.getvalue())
```

В `cmd_merge` вызвать `store.stamp_added_at(merged, _now_iso())` перед сохранением — рядом с местом, где уже проставляется `generated_at`. В `cmd_check` после основного отчёта напечатать блок `schema.warnings(map_dict)` под заголовком `Замечания:`; **код возврата не меняется** — предупреждение не ошибка.

- [ ] **Step 9: Весь набор и коммит**

Выполнить: `python3 -m unittest discover -s tests -t .` → OK.

```bash
git add src/aang/store.py src/aang/cli.py tests/test_store.py tests/test_cli.py
git commit -m "store: added_at stamping, relation merge rules, relations in export"
```

---

### Task 3: Сервер — обратный индекс и покрытие

**Files:**
- Modify: `src/aang/server.py` (`annotate` со строки 93)
- Test: `tests/test_server.py`

**Interfaces:**
- Consumes: `schema.normalize`, `schema.warnings`, `transcript.index` из Tasks 1-2. Русские подписи отношений сервер не использует — он отдаёт сырые `rel`, а подписывает их вьюер.
- Produces: в ответе `/api/map` у каждого узла появляется `related_by: [{"from": id, "rel": rel}]` — обратный индекс, посчитанный сервером; на верхнем уровне — `coverage: {"covered_to": int|None, "turns": int}` и `warnings: [str]`.

- [ ] **Step 1: Написать падающие тесты**

```python
def test_annotate_builds_reverse_index(self):
    m = _map([_node("d1"), _node("o1", kind="open", status="proposed",
                                 relates=[{"to": "d1", "rel": "orphaned_by"}])])
    view = server.annotate(m, _turns(3))
    d1 = [n for n in view["nodes"] if n["id"] == "d1"][0]
    self.assertEqual([{"from": "o1", "rel": "orphaned_by"}], d1["related_by"])

def test_annotate_reverse_index_is_empty_list_not_missing(self):
    view = server.annotate(_map([_node("d1")]), _turns(3))
    self.assertEqual([], view["nodes"][0]["related_by"])

def test_annotate_reports_coverage(self):
    m = _map([_node("d1", cites=[{"quote": "живая цитата отсюда", "turn": 5}])])
    view = server.annotate(m, _turns(12))
    self.assertEqual({"covered_to": 5, "turns": 12}, view["coverage"])

def test_coverage_is_none_when_nothing_resolved(self):
    view = server.annotate(_map([_node("d1")]), _turns(12))
    self.assertIsNone(view["coverage"]["covered_to"])
```

- [ ] **Step 2: Запустить, убедиться что падают**

Выполнить: `python3 -m unittest tests.test_server -v`
Ожидается: FAIL — ключей `related_by` и `coverage` нет.

- [ ] **Step 3: Реализовать**

В `annotate`, после цикла, который уже проходит по узлам и резолвит цитаты:

```python
    reverse = {}  # type: Dict[str, List[Dict[str, str]]]
    for node in view["nodes"]:
        for rel in node.get("relates") or []:
            target = rel.get("to")
            if target:
                reverse.setdefault(target, []).append(
                    {"from": node["id"], "rel": rel.get("rel", "")})
    for node in view["nodes"]:
        node["related_by"] = reverse.get(node["id"], [])

    covered = [c["turn"] for n in view["nodes"] for c in n.get("cites") or []
               if c.get("turn")]
    view["coverage"] = {"covered_to": max(covered) if covered else None,
                        "turns": len(turns)}
    view["warnings"] = schema.warnings(map_dict)
```

`covered_to` считается по **разрешённым** цитатам: неразрешённая ничего не покрывает.

- [ ] **Step 4: Запустить тесты**

Выполнить: `python3 -m unittest tests.test_server -v`
Ожидается: PASS.

- [ ] **Step 5: Весь набор и коммит**

Выполнить: `python3 -m unittest discover -s tests -t .` → OK.

```bash
git add src/aang/server.py tests/test_server.py
git commit -m "server: reverse relation index, coverage line, warnings in /api/map"
```

---

### Task 4: Вьюер — поиск, чипы, окрестность, дуги, триаж

**Files:**
- Modify: `ui/index.html` (`renderHeader` строка 571, `renderSpine` строка 621, `renderDetail` строка 660, `select` строка 947, `load` строка 1020)
- Test: `tests/test_server.py` (расширить `ViewerStringsTest` — автотестов DOM нет, проверяется наличие строк в отдаваемом файле)

**Interfaces:**
- Consumes: `/api/map` из Task 3 — поля узла `relates`, `related_by`, `added_at`; верхнеуровневые `coverage`, `warnings`.
- Produces: интерфейс. Ничего программного дальше по цепочке не потребляется.

Шаги этой задачи заданы **контрактом поведения, а не кодом**: точные строки, поля и правила
приведены, а разметку и стиль исполнитель пишет по уже сложившимся в файле соглашениям. Одно
исключение ниже — функция индекса поиска: ошибиться в ней легко, а провал будет тихим.

- [ ] **Step 1: Поиск**

Индекс строится ровно так, и `excerpt` в него не попадает:

```js
  function searchIndex(n) {
    var parts = [n.question, n.decision, n.why, n.consequence];
    (n.against || []).forEach(function (a) { parts.push(a); });
    (n.cites || []).forEach(function (c) { parts.push(c.quote); });   // quote, не excerpt
    return parts.join(" ").toLowerCase().replace(/\s+/g, " ");
  }
```

Поле над списком. Фильтрует строки по подстроке (регистронезависимо, после нормализации пробелов) в полях `question`, `decision`, `why`, `against`, `consequence` и в `cites[].quote`. **Выдержки `cites[].excerpt` в индекс не входят.** Ввод, целиком совпадающий с id (`d4`, `t5`, `o1`), не фильтрует, а выбирает узел и прокручивает к нему. Под полем — счётчик `скрыто N из M`, когда фильтр активен. `Esc` очищает.

- [ ] **Step 2: Фильтры-переключатели**

Три группы кнопок: вид (`решение` / `неявное` / `открытое`), статус (`принято` / `заменено` / `предложено`), проверенность (`проверено` / `не проверено`). Комбинируются с поиском. Активные подсвечены; сброс — одной кнопкой.

- [ ] **Step 3: Чипы соседей в строке**

Под текстом строки — по чипу на каждую запись `relates` и `related_by`: подпись отношения из того же словаря, что в `store.REL_LABELS`, плюс id цели, кликабельно (выбирает тот узел). Для `related_by` направление читается обратно: `← o1 осиротело`. Если `relates` и `related_by` пусты — строка «ни с чем не связано» приглушённым.

- [ ] **Step 4: Окрестность в панели**

Секция «Связи» в детальной панели: сначала объявленные (`relates`) с вопросом узла-цели, затем обратные (`related_by`) под заголовком «На этом держатся». Каждая запись кликабельна. Пусто — та же честная строка.

- [ ] **Step 5: Дуги только у выбранного узла**

При выборе узла — SVG-дуги в левом жёлобе от его строки к строкам соседей, и подсветка самих строк. Дуги перерисовываются при смене выбора и исчезают при сбросе. **Для невыбранных узлов дуги не рисуются никогда.**

- [ ] **Step 6: Шапка — покрытие и дельта**

В шапке строка `покрыто до хода N из M` из `coverage`. Если `covered_to` пуст — `ни одна цитата не разрешена`. Узлы, у которых `added_at` совпадает с максимальным `added_at` по карте, помечаются как `новое`; если `added_at` пуст у всех — пометка не показывается вовсе.

- [ ] **Step 7: Триаж открытых**

Открытые узлы разделяются на два блока: с ребром `orphaned_by` — «Осиротело решениями», без него — «Просто висит». Первый блок идёт выше. Тег `предложено` с открытых узлов **убирается** — открытый вопрос ничего не предлагает; статус остаётся в детальной панели.

- [ ] **Step 8: Проверить глазами**

Запустить `aang view --port 8802 &` на настоящей карте репозитория, открыть в браузере Playwright, посмотреть при 1380px и 400px, в светлой и тёмной теме. Проверить руками: поиск по слову и по id; каждый фильтр; клик по чипу; дуги появляются и исчезают; строка покрытия; оба блока открытых. Починить то, что покажут скриншоты, и посмотреть ещё один раз. Не строить цикл из скриншотов. Убить сервер (`timeout` в системе нет — `&` и `kill`).

- [ ] **Step 9: Тест на строки интерфейса**

Расширить `ViewerStringsTest`: отдаваемый `GET /` содержит `скрыто`, `ни с чем не связано`, `На этом держатся`, `покрыто до хода`, `Осиротело решениями`, `Просто висит`. Это ловит случайное переименование слов, на которых держится модель доверия.

- [ ] **Step 10: Весь набор и коммит**

Выполнить: `python3 -m unittest discover -s tests -t .` → OK.

```bash
git add ui/index.html tests/test_server.py
git commit -m "viewer: search, relation chips, neighbourhood, selection arcs, coverage, open-node triage"
```

---

### Task 5: Промпт — модель ставит связи

**Files:**
- Modify: `.claude/skills/aang/SKILL.md`
- Modify: `README.md`

**Interfaces:**
- Consumes: словарь `RELS` и правила из Task 1; поведение `merge` и `check` из Task 2.
- Produces: ничего программного. Это последняя задача: промпт описывает то, что уже работает.

- [ ] **Step 1: Раздел про связи в SKILL.md**

Добавить после раздела про грамматику. Содержание:

- Поле `relates: [{"to": "d6", "rel": "orphaned_by"}]`, три значения `rel`, не более трёх записей на узел.
- **Ссылка только назад** — на узел, который уже есть. Сослаться вперёд нельзя, и это не ограничение, а защита: модель ссылается только на то, что у неё уже написано.
- `superseded_by` остаётся отдельным полем и в `relates` не переезжает.
- Различающий вопрос для `moots` против `superseded_by`, а не определение: *«Появилось ли решение, которое отвечает на тот же вопрос по-другому? Тогда `superseded_by`. Или вопрос просто перестал иметь смысл, и никто на него больше не отвечает? Тогда `moots`.»* Пример из реальной карты: `d4` (порог 72 часа) не заменён — он умер, когда продукт развернулся на `/aang`.
- У каждого `open` — либо `orphaned_by`, либо явная строка в `why` о том, что источника нет.
- Обратный индекс модель **не пишет**: его считает вьюер.
- Если id упомянут в `why` словами, на него должно быть ребро; `aang check` про это предупреждает.

- [ ] **Step 2: Обновить раздел «Running again»**

Связи — часть узла: при повторном запуске узел перевыпускается вместе со своими `relates`. У замороженных (заменённых) и правленных руками узлов связи сохраняются, что бы модель ни написала.

- [ ] **Step 3: Обновить README**

В описание формата карты — `relates` и `added_at`; в раздел про правку руками — что связи правятся так же, как остальные поля, и переживают регенерацию.

- [ ] **Step 4: Проверить промпт на себе**

Написать кандидата по собственному обновлённому SKILL.md для настоящей сессии этого репозитория, прогнать `aang merge` и `aang check` на временном `--root`, и убедиться, что четыре прозаические ссылки настоящей карты (`o1→d6`, `o6→d7`, `t6→t1`, `d11→d5`) стали рёбрами, а `check` не ругается. Отчитаться, сколько связей модель поставила и на скольких узлах предупреждение осталось.

- [ ] **Step 5: Коммит**

```bash
git add .claude/skills/aang/SKILL.md README.md
git commit -m "skill: teach the model to write typed relations"
```
