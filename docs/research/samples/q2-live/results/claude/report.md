# Замер свежести: claude-workload

- Профиль нагрузки зафиксирован 2026-10-07T19:24:28.585Z, замер начат 2026-10-07T19:24:41.525Z и длился 3782,2 с.
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
| claude | 2.1.293 | claude-opus-5-5 | умолчание CLI | 30,0 с | 730,5 с | нет | 66 % | 60 из 65 | 5 | 0 | 13 | 11 | — | 0 % (0) |

## Контрольные события

| Запись | Событие | Способ | Итог | Задержка, с | Полная, с | Дозапросы, с | Версия | Автор |
| --- | --- | --- | --- | --- | --- | --- | --- | --- |
| claude/2.1.292/claude_cli/macos/workload-ledger | plan-written | предикат | после окна, нарушение | 534,8 | — | 0,0 | 60 | наблюдатель |
| claude/2.1.292/claude_cli/macos/workload-ledger | plan-ready | разметчик | выполнено | 29,8 | — | 0,0 | 5 | наблюдатель |
| claude/2.1.292/claude_cli/macos/workload-ledger | parse-tested | предикат | выполнено | 39,5 | — | 0,0 | 11 | наблюдатель |
| claude/2.1.292/claude_cli/macos/workload-ledger | parse-done | предикат | выполнено | 32,2 | — | 0,0 | 11 | наблюдатель |
| claude/2.1.292/claude_cli/macos/workload-ledger | balances-tested | предикат | выполнено | 26,9 | — | 0,0 | 14 | наблюдатель |
| claude/2.1.292/claude_cli/macos/workload-ledger | balances-done | предикат | выполнено | 20,6 | — | 0,0 | 14 | наблюдатель |
| claude/2.1.292/claude_cli/macos/workload-ledger | rounding-answered | разметчик | выполнено | 21,7 | — | 0,0 | 24 | наблюдатель |
| claude/2.1.292/claude_cli/macos/workload-ledger | conversion-tested | предикат | выполнено до события, разметка некорректна | — | — | — | 24 | — |
| claude/2.1.292/claude_cli/macos/workload-ledger | conversion-done | предикат | выполнено до события, разметка некорректна | — | — | — | 25 | — |
| claude/2.1.292/claude_cli/macos/workload-ledger | review-reported | разметчик | выполнено | 19,0 | — | 0,0 | 46 | наблюдатель |
| claude/2.1.292/claude_cli/macos/workload-ledger | review-fixed | разметчик | выполнено | 57,4 | — | 0,0 | 58 | наблюдатель |
| claude/2.1.292/claude_cli/macos/workload-ledger | cli-tested | предикат | выполнено | 23,6 | — | 0,0 | 72 | наблюдатель |
| claude/2.1.292/claude_cli/macos/workload-ledger | cli-done | предикат | выполнено | 41,2 | — | 0,0 | 73 | наблюдатель |
| claude/2.1.292/claude_cli/macos/workload-ledger | export-tested | предикат | выполнено до события, разметка некорректна | — | — | — | 89 | — |
| claude/2.1.292/claude_cli/macos/workload-ledger | export-done | предикат | выполнено до события, разметка некорректна | — | — | — | 92 | — |
| claude/2.1.292/claude_cli/macos/workload-ledger | cents-done | предикат | выполнено до события, разметка некорректна | — | — | — | 113 | — |
| claude/2.1.292/claude_cli/macos/workload-ledger | parallel-reported | разметчик | описание не соответствует записи, разметка некорректна | — | — | — | — | — |
| claude/2.1.292/claude_cli/macos/workload-ledger | parallel-done | разметчик | выполнено | 43,2 | — | 0,0 | 137 | наблюдатель |
| claude/2.1.292/claude_cli/macos/workload-ledger | committed | разметчик | выполнено | 29,1 | — | 0,0 | 153 | наблюдатель |
| claude/2.1.292/claude_cli/macos/workload-ledger | commit-done | разметчик | выполнено | 25,5 | — | 0,0 | 153 | наблюдатель |
| claude/2.1.292/claude_cli/macos/workload-ledger | final-tested | разметчик | описание не соответствует записи, разметка некорректна | — | — | — | — | — |
| claude/2.1.292/claude_cli/macos/workload-ledger | final-done | разметчик | выполнено | 18,7 | — | 0,0 | 162 | наблюдатель |
| claude/2.1.292/claude_cli/macos/workload-logstats | triage-tested | предикат | выполнено | 13,8 | — | 0,0 | 3 | наблюдатель |
| claude/2.1.292/claude_cli/macos/workload-logstats | triage-done | предикат | выполнено | 10,2 | — | 0,0 | 3 | наблюдатель |
| claude/2.1.292/claude_cli/macos/workload-logstats | plan-written | предикат | выполнено | 42,6 | — | 0,0 | 6 | наблюдатель |
| claude/2.1.292/claude_cli/macos/workload-logstats | plan-ready | разметчик | не выполнено, нарушение | — | — | — | — | — |
| claude/2.1.292/claude_cli/macos/workload-logstats | aggregate-tested | предикат | выполнено | 18,0 | — | 0,0 | 10 | наблюдатель |
| claude/2.1.292/claude_cli/macos/workload-logstats | aggregate-done | предикат | выполнено | 27,8 | — | 0,0 | 11 | наблюдатель |
| claude/2.1.292/claude_cli/macos/workload-logstats | big-log | разметчик | выполнено | 14,5 | — | 0,0 | 17 | наблюдатель |
| claude/2.1.292/claude_cli/macos/workload-logstats | generator-done | предикат | выполнено | 21,0 | — | 0,0 | 19 | наблюдатель |
| claude/2.1.292/claude_cli/macos/workload-logstats | cli-tested | предикат | выполнено | 39,0 | — | 0,0 | 28 | наблюдатель |
| claude/2.1.292/claude_cli/macos/workload-logstats | cli-done | предикат | выполнено | 31,7 | — | 0,0 | 28 | наблюдатель |
| claude/2.1.292/claude_cli/macos/workload-logstats | format-answered | разметчик | выполнено | 11,4 | — | 0,0 | 37 | наблюдатель |
| claude/2.1.292/claude_cli/macos/workload-logstats | report-tested | предикат | выполнено до события, разметка некорректна | — | — | — | 40 | — |
| claude/2.1.292/claude_cli/macos/workload-logstats | report-done | предикат | выполнено | 34,4 | — | 0,0 | 44 | наблюдатель |
| claude/2.1.292/claude_cli/macos/workload-logstats | review-reported | разметчик | выполнено | 14,1 | — | 0,0 | 75 | наблюдатель |
| claude/2.1.292/claude_cli/macos/workload-logstats | review-fixed | разметчик | описание не соответствует записи, разметка некорректна | — | — | — | — | — |
| claude/2.1.292/claude_cli/macos/workload-logstats | streaming-tested | предикат | выполнено | 19,0 | — | 0,0 | 107 | наблюдатель |
| claude/2.1.292/claude_cli/macos/workload-logstats | streaming-done | предикат | выполнено | 18,1 | — | 0,0 | 108 | наблюдатель |
| claude/2.1.292/claude_cli/macos/workload-logstats | docs-reported | разметчик | выполнено | 23,3 | — | 0,0 | 134 | наблюдатель |
| claude/2.1.292/claude_cli/macos/workload-logstats | docs-done | разметчик | описание не соответствует записи, разметка некорректна | — | — | — | — | — |
| claude/2.1.292/claude_cli/macos/workload-logstats | committed | разметчик | выполнено | 22,0 | — | 0,0 | 149 | наблюдатель |
| claude/2.1.292/claude_cli/macos/workload-logstats | commit-done | разметчик | выполнено | 16,9 | — | 0,0 | 149 | наблюдатель |
| claude/2.1.292/claude_cli/macos/workload-logstats | final-tested | разметчик | описание не соответствует записи, разметка некорректна | — | — | — | — | — |
| claude/2.1.292/claude_cli/macos/workload-logstats | final-done | разметчик | выполнено | 16,9 | — | 0,0 | 154 | наблюдатель |
| claude/2.1.292/claude_cli/macos/workload-kvstore | plan-written | предикат | после окна, нарушение | 730,5 | — | 0,0 | 80 | наблюдатель |
| claude/2.1.292/claude_cli/macos/workload-kvstore | plan-ready | разметчик | не выполнено, нарушение | — | — | — | — | — |
| claude/2.1.292/claude_cli/macos/workload-kvstore | log-tested | предикат | выполнено | 16,8 | — | 0,0 | 9 | наблюдатель |
| claude/2.1.292/claude_cli/macos/workload-kvstore | log-done | предикат | выполнено | 32,6 | — | 0,0 | 10 | наблюдатель |
| claude/2.1.292/claude_cli/macos/workload-kvstore | crash-tested | предикат | выполнено до события, разметка некорректна | — | — | — | 11 | — |
| claude/2.1.292/claude_cli/macos/workload-kvstore | crash-done | предикат | выполнено | 23,1 | — | 0,0 | 13 | наблюдатель |
| claude/2.1.292/claude_cli/macos/workload-kvstore | durability-answered | разметчик | выполнено | 11,3 | — | 0,0 | 21 | наблюдатель |
| claude/2.1.292/claude_cli/macos/workload-kvstore | compaction-tested | предикат | выполнено до события, разметка некорректна | — | — | — | 22 | — |
| claude/2.1.292/claude_cli/macos/workload-kvstore | compaction-done | предикат | выполнено | 22,9 | — | 0,0 | 25 | наблюдатель |
| claude/2.1.292/claude_cli/macos/workload-kvstore | batch-tested | предикат | выполнено | 19,7 | — | 0,0 | 29 | наблюдатель |
| claude/2.1.292/claude_cli/macos/workload-kvstore | batch-done | предикат | выполнено | 27,7 | — | 0,0 | 30 | наблюдатель |
| claude/2.1.292/claude_cli/macos/workload-kvstore | review-reported | разметчик | выполнено | 13,6 | — | 0,0 | 53 | наблюдатель |
| claude/2.1.292/claude_cli/macos/workload-kvstore | review-fixed | разметчик | выполнено | 30,7 | — | 0,0 | 78 | наблюдатель |
| claude/2.1.292/claude_cli/macos/workload-kvstore | cli-tested | предикат | выполнено | 24,2 | — | 0,0 | 90 | наблюдатель |
| claude/2.1.292/claude_cli/macos/workload-kvstore | cli-done | предикат | выполнено | 29,4 | — | 0,0 | 91 | наблюдатель |
| claude/2.1.292/claude_cli/macos/workload-kvstore | ttl-planned | предикат | выполнено до события, разметка некорректна | — | — | — | 97 | — |
| claude/2.1.292/claude_cli/macos/workload-kvstore | ttl-done | предикат | выполнено до события, разметка некорректна | — | — | — | 112 | — |
| claude/2.1.292/claude_cli/macos/workload-kvstore | parallel-reported | разметчик | описание не соответствует записи, разметка некорректна | — | — | — | — | — |
| claude/2.1.292/claude_cli/macos/workload-kvstore | parallel-done | разметчик | выполнено | 5,5 | — | 0,0 | 196 | наблюдатель |
| claude/2.1.292/claude_cli/macos/workload-kvstore | committed | разметчик | выполнено | 30,8 | — | 0,0 | 206 | наблюдатель |
| claude/2.1.292/claude_cli/macos/workload-kvstore | commit-done | разметчик | выполнено | 24,9 | — | 0,0 | 206 | наблюдатель |
| claude/2.1.292/claude_cli/macos/workload-kvstore | final-tested | разметчик | описание не соответствует записи, разметка некорректна | — | — | — | — | — |
| claude/2.1.292/claude_cli/macos/workload-kvstore | final-done | разметчик | выполнено | 18,0 | — | 0,0 | 217 | наблюдатель |
| claude/2.1.293/claude_cli/macos/workload-mdlinks | explore-done | разметчик | выполнено | 31,8 | — | 0,0 | 4 | наблюдатель |
| claude/2.1.293/claude_cli/macos/workload-mdlinks | plan-written | предикат | выполнено | 51,0 | — | 0,0 | 8 | наблюдатель |
| claude/2.1.293/claude_cli/macos/workload-mdlinks | plan-ready | разметчик | не выполнено, нарушение | — | — | — | — | — |
| claude/2.1.293/claude_cli/macos/workload-mdlinks | extract-tested | предикат | выполнено | 28,4 | — | 0,0 | 14 | наблюдатель |
| claude/2.1.293/claude_cli/macos/workload-mdlinks | extract-done | предикат | выполнено | 16,7 | — | 0,0 | 14 | наблюдатель |
| claude/2.1.293/claude_cli/macos/workload-mdlinks | check-tested | предикат | выполнено до события, разметка некорректна | — | — | — | 24 | — |
| claude/2.1.293/claude_cli/macos/workload-mdlinks | check-done | предикат | выполнено | 22,6 | — | 0,0 | 29 | наблюдатель |
| claude/2.1.293/claude_cli/macos/workload-mdlinks | slugs-answered | разметчик | описание не соответствует записи, разметка некорректна | — | — | — | — | — |
| claude/2.1.293/claude_cli/macos/workload-mdlinks | report-tested | предикат | выполнено | 29,2 | — | 0,0 | 46 | наблюдатель |
| claude/2.1.293/claude_cli/macos/workload-mdlinks | report-done | предикат | выполнено | 19,8 | — | 0,0 | 46 | наблюдатель |
| claude/2.1.293/claude_cli/macos/workload-mdlinks | review-reported | разметчик | выполнено | 16,7 | — | 0,0 | 85 | наблюдатель |
| claude/2.1.293/claude_cli/macos/workload-mdlinks | review-fixed | разметчик | выполнено | 27,3 | — | 0,0 | 99 | наблюдатель |
| claude/2.1.293/claude_cli/macos/workload-mdlinks | fix-tested | предикат | выполнено до события, разметка некорректна | — | — | — | 132 | — |
| claude/2.1.293/claude_cli/macos/workload-mdlinks | fix-done | предикат | выполнено | 12,6 | — | 0,0 | 139 | наблюдатель |
| claude/2.1.293/claude_cli/macos/workload-mdlinks | json-done | предикат | выполнено до события, разметка некорректна | — | — | — | 162 | — |
| claude/2.1.293/claude_cli/macos/workload-mdlinks | docs-reported | разметчик | описание не соответствует записи, разметка некорректна | — | — | — | — | — |
| claude/2.1.293/claude_cli/macos/workload-mdlinks | docs-done | разметчик | описание не соответствует записи, разметка некорректна | — | — | — | — | — |
| claude/2.1.293/claude_cli/macos/workload-mdlinks | committed | разметчик | выполнено | 96,1 | — | 0,0 | 226 | наблюдатель |
| claude/2.1.293/claude_cli/macos/workload-mdlinks | commit-done | разметчик | выполнено | 92,3 | — | 0,0 | 226 | наблюдатель |
| claude/2.1.293/claude_cli/macos/workload-mdlinks | final-tested | разметчик | описание не соответствует записи, разметка некорректна | — | — | — | — | — |
| claude/2.1.293/claude_cli/macos/workload-mdlinks | final-done | разметчик | выполнено | 38,2 | — | 0,0 | 228 | наблюдатель |

## Наблюдатель

| Backend | Вызовы | Приняты | Отклонены | Ошибки | С дозапросом |
| --- | --- | --- | --- | --- | --- |
| claude | 316 | 313 | 3 | 0 | 0 |

| Backend | Состояние | Время, с | Доля |
| --- | --- | --- | --- |
| claude | ok | 11801,0 | 100 % |

## Расход

Расход вызовов — по данным CLI в журнале вызовов демона. Час прогона — сумма длительностей проигранных прогонов backend, активный час — время, когда шёл хотя бы один его прогон. Деньги — только у Claude, по прейскуранту; при подписке это не списание.

| Backend | Прогоны | Часы прогонов | Активные часы |
| --- | --- | --- | --- |
| claude | 4 | 1,77 | 1,02 |

| Backend | Журнал | Вызовы | Вход без кэша | Чтение кэша | Запись кэша | Вывод | Рассуждения | Всего токенов | Стоимость |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| claude | наблюдатель | 316 | 632 | 2 853 164 | 4 709 051 | 386 049 | 66 211 | 7 948 896 | $46,46 |
| claude | чат | 12 | 22 | 57 430 | 282 880 | 22 298 | 3 409 | 362 630 | $2,75 |
| claude | пробы и auth status | 0 | 0 | 0 | 0 | 0 | 0 | 0 | — |

| Backend | Журнал | Вызовов на час прогона | Токенов на час прогона | Стоимость часа прогона | Вызовов на активный час | Токенов на активный час | Стоимость активного часа |
| --- | --- | --- | --- | --- | --- | --- | --- |
| claude | наблюдатель | 178,8 | 4 497 272 | $26,28 | 310,7 | 7 815 078 | $45,67 |
| claude | чат | 6,8 | 205 166 | $1,56 | 11,8 | 356 525 | $2,70 |

| Backend | Вопросы | Ответы | Ошибки | Не заданы | Недостаточно данных | p50 ответа, с | p95 ответа, с | Токенов на ответ | Стоимость ответа |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| claude | 12 | 11 | 1 | 0 | 0 | 21,2 | 36,0 | 32 966 | $0,25 |

По учёту расхода демона (U.1) активных часов — 2: это календарные часы, в которых была активность решателя.
