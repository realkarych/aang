# Замер свежести: claude-workload-low-parallel

- Профиль нагрузки зафиксирован 2026-10-08T18:10:22.380Z, замер начат 2026-10-08T18:29:28.770Z и длился 3782,2 с.
- Окно замера 120,0 с, масштаб времени записей 1.
- Демон 0.0.0.

## Записи

| Запись | Рантайм | Старт, с |
| --- | --- | --- |
| claude/2.1.292/claude_cli/macos/workload-ledger | claude | 0,0 |
| claude/2.1.292/claude_cli/macos/workload-logstats | claude | 300,0 |
| claude/2.1.292/claude_cli/macos/workload-kvstore | claude | 1407,9 |
| claude/2.1.293/claude_cli/macos/workload-mdlinks | claude | 1618,2 |

## Итог по backend

Нарушение — ожидание не выполнено в окне замера. p95 считается по оценённым событиям, невыполненные события стоят в нём за окном. Выполненные до события и не соответствующие записи события — дефекты разметки, в p95 они не входят. Полная задержка идёт от времени самого события; в скобках — число событий с известным временем. Доля дозапросов — доля времени `needs` в задержке выполненных событий; в скобках — число событий с дозапросом.

| Backend | CLI | Модель | Effort | Ориентир p95 | p95 | Ориентир выполнен | В пределах ориентира | Выполнено | Нарушения | Без оценки | Выполнено до события | Не соответствует записи | Полная задержка p95 | Доля дозапросов |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| claude | 2.1.293 | claude-opus-5-5 | low | 30,0 с | 34,9 с | нет | 90 % | 67 из 67 | 0 | 0 | 11 | 11 | — | 2 % (1) |

## Контрольные события

| Запись | Событие | Способ | Итог | Задержка, с | Полная, с | Дозапросы, с | Версия | Автор |
| --- | --- | --- | --- | --- | --- | --- | --- | --- |
| claude/2.1.292/claude_cli/macos/workload-ledger | plan-written | предикат | выполнено | 36,1 | — | 0,0 | 5 | наблюдатель |
| claude/2.1.292/claude_cli/macos/workload-ledger | plan-ready | разметчик | выполнено | 29,6 | — | 0,0 | 5 | наблюдатель |
| claude/2.1.292/claude_cli/macos/workload-ledger | parse-tested | предикат | выполнено | 34,9 | — | 0,0 | 10 | наблюдатель |
| claude/2.1.292/claude_cli/macos/workload-ledger | parse-done | предикат | выполнено | 27,6 | — | 0,0 | 10 | наблюдатель |
| claude/2.1.292/claude_cli/macos/workload-ledger | balances-tested | предикат | выполнено | 32,1 | — | 0,0 | 12 | наблюдатель |
| claude/2.1.292/claude_cli/macos/workload-ledger | balances-done | предикат | выполнено | 25,8 | — | 0,0 | 12 | наблюдатель |
| claude/2.1.292/claude_cli/macos/workload-ledger | rounding-answered | разметчик | выполнено | 11,7 | — | 0,0 | 22 | наблюдатель |
| claude/2.1.292/claude_cli/macos/workload-ledger | conversion-tested | предикат | выполнено до события, разметка некорректна | — | — | — | 24 | — |
| claude/2.1.292/claude_cli/macos/workload-ledger | conversion-done | предикат | выполнено до события, разметка некорректна | — | — | — | 25 | — |
| claude/2.1.292/claude_cli/macos/workload-ledger | review-reported | разметчик | выполнено | 12,3 | — | 0,0 | 46 | наблюдатель |
| claude/2.1.292/claude_cli/macos/workload-ledger | review-fixed | разметчик | выполнено | 10,5 | — | 0,0 | 61 | наблюдатель |
| claude/2.1.292/claude_cli/macos/workload-ledger | cli-tested | предикат | выполнено | 14,7 | — | 0,0 | 77 | наблюдатель |
| claude/2.1.292/claude_cli/macos/workload-ledger | cli-done | предикат | выполнено | 14,0 | — | 0,0 | 78 | наблюдатель |
| claude/2.1.292/claude_cli/macos/workload-ledger | export-tested | предикат | выполнено до события, разметка некорректна | — | — | — | 94 | — |
| claude/2.1.292/claude_cli/macos/workload-ledger | export-done | предикат | выполнено до события, разметка некорректна | — | — | — | 98 | — |
| claude/2.1.292/claude_cli/macos/workload-ledger | cents-done | предикат | выполнено | 17,7 | — | 0,0 | 122 | наблюдатель |
| claude/2.1.292/claude_cli/macos/workload-ledger | parallel-reported | разметчик | описание не соответствует записи, разметка некорректна | — | — | — | — | — |
| claude/2.1.292/claude_cli/macos/workload-ledger | parallel-done | разметчик | выполнено | 2,9 | — | 0,0 | 146 | наблюдатель |
| claude/2.1.292/claude_cli/macos/workload-ledger | committed | разметчик | выполнено | 22,4 | — | 0,0 | 165 | наблюдатель |
| claude/2.1.292/claude_cli/macos/workload-ledger | commit-done | разметчик | выполнено | 18,8 | — | 0,0 | 165 | наблюдатель |
| claude/2.1.292/claude_cli/macos/workload-ledger | final-tested | разметчик | описание не соответствует записи, разметка некорректна | — | — | — | — | — |
| claude/2.1.292/claude_cli/macos/workload-ledger | final-done | разметчик | выполнено | 13,3 | — | 0,0 | 174 | наблюдатель |
| claude/2.1.292/claude_cli/macos/workload-logstats | triage-tested | предикат | выполнено | 9,7 | — | 0,0 | 3 | наблюдатель |
| claude/2.1.292/claude_cli/macos/workload-logstats | triage-done | предикат | выполнено | 6,1 | — | 0,0 | 3 | наблюдатель |
| claude/2.1.292/claude_cli/macos/workload-logstats | plan-written | предикат | выполнено | 22,7 | — | 17,9 | 6 | наблюдатель |
| claude/2.1.292/claude_cli/macos/workload-logstats | plan-ready | разметчик | выполнено | 16,4 | — | 0,0 | 7 | наблюдатель |
| claude/2.1.292/claude_cli/macos/workload-logstats | aggregate-tested | предикат | выполнено | 20,1 | — | 0,0 | 14 | наблюдатель |
| claude/2.1.292/claude_cli/macos/workload-logstats | aggregate-done | предикат | выполнено | 11,8 | — | 0,0 | 14 | наблюдатель |
| claude/2.1.292/claude_cli/macos/workload-logstats | big-log | разметчик | выполнено | 16,8 | — | 0,0 | 22 | наблюдатель |
| claude/2.1.292/claude_cli/macos/workload-logstats | generator-done | предикат | выполнено | 4,8 | — | 0,0 | 22 | наблюдатель |
| claude/2.1.292/claude_cli/macos/workload-logstats | cli-tested | предикат | выполнено | 28,5 | — | 0,0 | 32 | наблюдатель |
| claude/2.1.292/claude_cli/macos/workload-logstats | cli-done | предикат | выполнено | 21,3 | — | 0,0 | 32 | наблюдатель |
| claude/2.1.292/claude_cli/macos/workload-logstats | format-answered | разметчик | выполнено | 11,4 | — | 0,0 | 43 | наблюдатель |
| claude/2.1.292/claude_cli/macos/workload-logstats | report-tested | предикат | выполнено | 18,1 | — | 0,0 | 47 | наблюдатель |
| claude/2.1.292/claude_cli/macos/workload-logstats | report-done | предикат | выполнено | 7,3 | — | 0,0 | 47 | наблюдатель |
| claude/2.1.292/claude_cli/macos/workload-logstats | review-reported | разметчик | выполнено | 6,0 | — | 0,0 | 84 | наблюдатель |
| claude/2.1.292/claude_cli/macos/workload-logstats | review-fixed | разметчик | описание не соответствует записи, разметка некорректна | — | — | — | — | — |
| claude/2.1.292/claude_cli/macos/workload-logstats | streaming-tested | предикат | выполнено | 34,8 | — | 0,0 | 124 | наблюдатель |
| claude/2.1.292/claude_cli/macos/workload-logstats | streaming-done | предикат | выполнено | 17,1 | — | 0,0 | 124 | наблюдатель |
| claude/2.1.292/claude_cli/macos/workload-logstats | docs-reported | разметчик | выполнено | 4,2 | — | 0,0 | 145 | наблюдатель |
| claude/2.1.292/claude_cli/macos/workload-logstats | docs-done | разметчик | описание не соответствует записи, разметка некорректна | — | — | — | — | — |
| claude/2.1.292/claude_cli/macos/workload-logstats | committed | разметчик | выполнено | 9,4 | — | 0,0 | 166 | наблюдатель |
| claude/2.1.292/claude_cli/macos/workload-logstats | commit-done | разметчик | выполнено | 4,2 | — | 0,0 | 166 | наблюдатель |
| claude/2.1.292/claude_cli/macos/workload-logstats | final-tested | разметчик | описание не соответствует записи, разметка некорректна | — | — | — | — | — |
| claude/2.1.292/claude_cli/macos/workload-logstats | final-done | разметчик | выполнено | 17,2 | — | 0,0 | 171 | наблюдатель |
| claude/2.1.292/claude_cli/macos/workload-kvstore | plan-written | предикат | выполнено | 33,4 | — | 0,0 | 5 | наблюдатель |
| claude/2.1.292/claude_cli/macos/workload-kvstore | plan-ready | разметчик | выполнено | 26,8 | — | 0,0 | 5 | наблюдатель |
| claude/2.1.292/claude_cli/macos/workload-kvstore | log-tested | предикат | выполнено | 13,7 | — | 0,0 | 9 | наблюдатель |
| claude/2.1.292/claude_cli/macos/workload-kvstore | log-done | предикат | выполнено | 7,8 | — | 0,0 | 9 | наблюдатель |
| claude/2.1.292/claude_cli/macos/workload-kvstore | crash-tested | предикат | выполнено до события, разметка некорректна | — | — | — | 11 | — |
| claude/2.1.292/claude_cli/macos/workload-kvstore | crash-done | предикат | выполнено | 11,4 | — | 0,0 | 13 | наблюдатель |
| claude/2.1.292/claude_cli/macos/workload-kvstore | durability-answered | разметчик | выполнено | 12,4 | — | 0,0 | 22 | наблюдатель |
| claude/2.1.292/claude_cli/macos/workload-kvstore | compaction-tested | предикат | выполнено | 13,0 | — | 0,0 | 26 | наблюдатель |
| claude/2.1.292/claude_cli/macos/workload-kvstore | compaction-done | предикат | выполнено | 6,3 | — | 0,0 | 26 | наблюдатель |
| claude/2.1.292/claude_cli/macos/workload-kvstore | batch-tested | предикат | выполнено | 13,4 | — | 0,0 | 31 | наблюдатель |
| claude/2.1.292/claude_cli/macos/workload-kvstore | batch-done | предикат | выполнено | 7,9 | — | 0,0 | 31 | наблюдатель |
| claude/2.1.292/claude_cli/macos/workload-kvstore | review-reported | разметчик | выполнено | 11,5 | — | 0,0 | 57 | наблюдатель |
| claude/2.1.292/claude_cli/macos/workload-kvstore | review-fixed | разметчик | выполнено | 26,3 | — | 0,0 | 83 | наблюдатель |
| claude/2.1.292/claude_cli/macos/workload-kvstore | cli-tested | предикат | выполнено | 13,1 | — | 0,0 | 94 | наблюдатель |
| claude/2.1.292/claude_cli/macos/workload-kvstore | cli-done | предикат | выполнено | 0,5 | — | 0,0 | 94 | наблюдатель |
| claude/2.1.292/claude_cli/macos/workload-kvstore | ttl-planned | предикат | выполнено до события, разметка некорректна | — | — | — | 101 | — |
| claude/2.1.292/claude_cli/macos/workload-kvstore | ttl-done | предикат | выполнено до события, разметка некорректна | — | — | — | 117 | — |
| claude/2.1.292/claude_cli/macos/workload-kvstore | parallel-reported | разметчик | описание не соответствует записи, разметка некорректна | — | — | — | — | — |
| claude/2.1.292/claude_cli/macos/workload-kvstore | parallel-done | разметчик | выполнено до события, разметка некорректна | — | — | — | — | — |
| claude/2.1.292/claude_cli/macos/workload-kvstore | committed | разметчик | выполнено | 12,7 | — | 0,0 | 217 | наблюдатель |
| claude/2.1.292/claude_cli/macos/workload-kvstore | commit-done | разметчик | выполнено | 6,8 | — | 0,0 | 217 | наблюдатель |
| claude/2.1.292/claude_cli/macos/workload-kvstore | final-tested | разметчик | описание не соответствует записи, разметка некорректна | — | — | — | — | — |
| claude/2.1.292/claude_cli/macos/workload-kvstore | final-done | разметчик | выполнено | 11,9 | — | 0,0 | 229 | наблюдатель |
| claude/2.1.293/claude_cli/macos/workload-mdlinks | explore-done | разметчик | выполнено | 12,7 | — | 0,0 | 4 | наблюдатель |
| claude/2.1.293/claude_cli/macos/workload-mdlinks | plan-written | предикат | выполнено | 57,6 | — | 0,0 | 8 | наблюдатель |
| claude/2.1.293/claude_cli/macos/workload-mdlinks | plan-ready | разметчик | выполнено | 52,1 | — | 0,0 | 9 | наблюдатель |
| claude/2.1.293/claude_cli/macos/workload-mdlinks | extract-tested | предикат | выполнено | 17,3 | — | 0,0 | 14 | наблюдатель |
| claude/2.1.293/claude_cli/macos/workload-mdlinks | extract-done | предикат | выполнено | 5,6 | — | 0,0 | 14 | наблюдатель |
| claude/2.1.293/claude_cli/macos/workload-mdlinks | check-tested | предикат | выполнено до события, разметка некорректна | — | — | — | 27 | — |
| claude/2.1.293/claude_cli/macos/workload-mdlinks | check-done | предикат | выполнено | 10,1 | — | 0,0 | 32 | наблюдатель |
| claude/2.1.293/claude_cli/macos/workload-mdlinks | slugs-answered | разметчик | описание не соответствует записи, разметка некорректна | — | — | — | — | — |
| claude/2.1.293/claude_cli/macos/workload-mdlinks | report-tested | предикат | выполнено до события, разметка некорректна | — | — | — | 47 | — |
| claude/2.1.293/claude_cli/macos/workload-mdlinks | report-done | предикат | выполнено до события, разметка некорректна | — | — | — | 52 | — |
| claude/2.1.293/claude_cli/macos/workload-mdlinks | review-reported | разметчик | выполнено | 10,2 | — | 0,0 | 91 | наблюдатель |
| claude/2.1.293/claude_cli/macos/workload-mdlinks | review-fixed | разметчик | выполнено | 9,3 | — | 0,0 | 106 | наблюдатель |
| claude/2.1.293/claude_cli/macos/workload-mdlinks | fix-tested | предикат | выполнено | 23,6 | — | 0,0 | 147 | наблюдатель |
| claude/2.1.293/claude_cli/macos/workload-mdlinks | fix-done | предикат | выполнено | 5,7 | — | 0,0 | 147 | наблюдатель |
| claude/2.1.293/claude_cli/macos/workload-mdlinks | json-done | предикат | выполнено | 14,8 | — | 0,0 | 173 | наблюдатель |
| claude/2.1.293/claude_cli/macos/workload-mdlinks | docs-reported | разметчик | описание не соответствует записи, разметка некорректна | — | — | — | — | — |
| claude/2.1.293/claude_cli/macos/workload-mdlinks | docs-done | разметчик | описание не соответствует записи, разметка некорректна | — | — | — | — | — |
| claude/2.1.293/claude_cli/macos/workload-mdlinks | committed | разметчик | выполнено | 20,4 | — | 0,0 | 231 | наблюдатель |
| claude/2.1.293/claude_cli/macos/workload-mdlinks | commit-done | разметчик | выполнено | 16,6 | — | 0,0 | 231 | наблюдатель |
| claude/2.1.293/claude_cli/macos/workload-mdlinks | final-tested | разметчик | описание не соответствует записи, разметка некорректна | — | — | — | — | — |
| claude/2.1.293/claude_cli/macos/workload-mdlinks | final-done | разметчик | выполнено | 7,6 | — | 0,0 | 240 | наблюдатель |

## Наблюдатель

| Backend | Вызовы | Приняты | Отклонены | Ошибки | С дозапросом |
| --- | --- | --- | --- | --- | --- |
| claude | 369 | 358 | 11 | 0 | 4 |

| Backend | Состояние | Время, с | Доля |
| --- | --- | --- | --- |
| claude | ok | 11800,6 | 100 % |

## Расход

Расход вызовов — по данным CLI в журнале вызовов демона. Час прогона — сумма длительностей проигранных прогонов backend, активный час — время, когда шёл хотя бы один его прогон. Деньги — только у Claude, по прейскуранту; при подписке это не списание.

| Backend | Прогоны | Часы прогонов | Активные часы |
| --- | --- | --- | --- |
| claude | 4 | 1,77 | 1,02 |

| Backend | Журнал | Вызовы | Вход без кэша | Чтение кэша | Запись кэша | Вывод | Рассуждения | Всего токенов | Стоимость |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| claude | наблюдатель | 369 | 752 | 3 530 729 | 4 426 079 | 247 552 | 7 111 | 8 205 112 | $41,53 |
| claude | чат | 12 | 24 | 63 173 | 291 441 | 13 239 | 647 | 367 877 | $2,64 |
| claude | пробы и auth status | 0 | 0 | 0 | 0 | 0 | 0 | 0 | — |

| Backend | Журнал | Вызовов на час прогона | Токенов на час прогона | Стоимость часа прогона | Вызовов на активный час | Токенов на активный час | Стоимость активного часа |
| --- | --- | --- | --- | --- | --- | --- | --- |
| claude | наблюдатель | 208,8 | 4 642 259 | $23,50 | 362,8 | 8 067 023 | $40,83 |
| claude | чат | 6,8 | 208 136 | $1,49 | 11,8 | 361 686 | $2,60 |

| Backend | Вопросы | Ответы | Ошибки | Не заданы | Недостаточно данных | p50 ответа, с | p95 ответа, с | Токенов на ответ | Стоимость ответа |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| claude | 12 | 12 | 0 | 0 | 0 | 12,6 | 19,4 | 30 656 | $0,22 |

По учёту расхода демона (U.1) активных часов — 2: это календарные часы, в которых была активность решателя.
