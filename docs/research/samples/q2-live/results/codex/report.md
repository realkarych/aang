# Замер свежести: codex-workload

- Профиль нагрузки зафиксирован 2026-10-07T20:51:05.952Z, замер начат 2026-10-07T20:51:11.791Z и длился 3524,4 с.
- Окно замера 120,0 с, масштаб времени записей 1.
- Демон 0.0.0.

## Записи

| Запись | Рантайм | Старт, с |
| --- | --- | --- |
| codex/0.160.0/codex_exec/macos/workload-ledger | codex | 0,0 |
| codex/0.160.0/codex_exec/macos/workload-logstats | codex | 300,0 |
| codex/0.160.0/codex_exec/macos/workload-kvstore | codex | 1531,5 |

## Итог по backend

Нарушение — ожидание не выполнено в окне замера. p95 считается по оценённым событиям, невыполненные события стоят в нём за окном. Выполненные до события и не соответствующие записи события — дефекты разметки, в p95 они не входят. Полная задержка идёт от времени самого события; в скобках — число событий с известным временем. Доля дозапросов — доля времени `needs` в задержке выполненных событий; в скобках — число событий с дозапросом.

| Backend | CLI | Модель | Effort | Ориентир p95 | p95 | Ориентир выполнен | В пределах ориентира | Выполнено | Нарушения | Без оценки | Выполнено до события | Не соответствует записи | Полная задержка p95 | Доля дозапросов |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| codex | 0.160.0 | gpt-6.1-sol | умолчание CLI | 40,0 с | за окном (нарушение) | нет | 88 % | 42 из 48 | 6 | 0 | 6 | 4 | 646,3 с (45) | 0 % (0) |

## Контрольные события

| Запись | Событие | Способ | Итог | Задержка, с | Полная, с | Дозапросы, с | Версия | Автор |
| --- | --- | --- | --- | --- | --- | --- | --- | --- |
| codex/0.160.0/codex_exec/macos/workload-ledger | plan-written | предикат | после окна, нарушение | 646,3 | 646,3 | 0,0 | 27 | наблюдатель |
| codex/0.160.0/codex_exec/macos/workload-ledger | plan-ready | разметчик | не выполнено, нарушение | — | — | — | — | — |
| codex/0.160.0/codex_exec/macos/workload-ledger | parse-tested | предикат | выполнено | 26,0 | 26,0 | 0,0 | 8 | наблюдатель |
| codex/0.160.0/codex_exec/macos/workload-ledger | parse-done | предикат | выполнено | 20,8 | 20,8 | 0,0 | 8 | наблюдатель |
| codex/0.160.0/codex_exec/macos/workload-ledger | balances-tested | предикат | выполнено | 20,8 | 20,8 | 0,0 | 12 | наблюдатель |
| codex/0.160.0/codex_exec/macos/workload-ledger | balances-done | предикат | выполнено | 18,0 | 18,0 | 0,0 | 12 | наблюдатель |
| codex/0.160.0/codex_exec/macos/workload-ledger | conversion-tested | предикат | выполнено | 23,6 | 23,7 | 0,0 | 16 | наблюдатель |
| codex/0.160.0/codex_exec/macos/workload-ledger | conversion-done | предикат | выполнено | 19,4 | 19,4 | 0,0 | 16 | наблюдатель |
| codex/0.160.0/codex_exec/macos/workload-ledger | review-fixed | разметчик | выполнено | 15,1 | 15,1 | 0,0 | 25 | наблюдатель |
| codex/0.160.0/codex_exec/macos/workload-ledger | cli-tested | предикат | выполнено | 19,2 | 19,3 | 0,0 | 29 | наблюдатель |
| codex/0.160.0/codex_exec/macos/workload-ledger | cli-done | предикат | выполнено | 15,9 | 15,9 | 0,0 | 29 | наблюдатель |
| codex/0.160.0/codex_exec/macos/workload-ledger | export-tested | предикат | выполнено до события, разметка некорректна | — | — | — | 35 | — |
| codex/0.160.0/codex_exec/macos/workload-ledger | export-done | предикат | выполнено до события, разметка некорректна | — | — | — | 36 | — |
| codex/0.160.0/codex_exec/macos/workload-ledger | cents-planned | предикат | выполнено до события, разметка некорректна | — | — | — | 41 | — |
| codex/0.160.0/codex_exec/macos/workload-ledger | cents-done | предикат | выполнено | 20,6 | 20,6 | 0,0 | 44 | наблюдатель |
| codex/0.160.0/codex_exec/macos/workload-ledger | parallel-done | разметчик | выполнено | 31,5 | 31,5 | 0,0 | 52 | наблюдатель |
| codex/0.160.0/codex_exec/macos/workload-ledger | commit-done | разметчик | описание не соответствует записи, разметка некорректна | — | — | — | — | — |
| codex/0.160.0/codex_exec/macos/workload-ledger | final-tested | разметчик | выполнено | 22,6 | 22,6 | 0,0 | 59 | наблюдатель |
| codex/0.160.0/codex_exec/macos/workload-ledger | final-done | разметчик | выполнено | 12,7 | 12,7 | 0,0 | 60 | наблюдатель |
| codex/0.160.0/codex_exec/macos/workload-logstats | triage-tested | предикат | выполнено | 18,9 | 18,9 | 0,0 | 4 | наблюдатель |
| codex/0.160.0/codex_exec/macos/workload-logstats | triage-done | предикат | выполнено | 23,4 | 23,4 | 0,0 | 5 | наблюдатель |
| codex/0.160.0/codex_exec/macos/workload-logstats | plan-written | предикат | после окна, нарушение | 1024,4 | 1024,4 | 0,0 | 43 | наблюдатель |
| codex/0.160.0/codex_exec/macos/workload-logstats | plan-ready | разметчик | не выполнено, нарушение | — | — | — | — | — |
| codex/0.160.0/codex_exec/macos/workload-logstats | aggregate-tested | предикат | выполнено | 24,8 | 24,8 | 0,0 | 12 | наблюдатель |
| codex/0.160.0/codex_exec/macos/workload-logstats | aggregate-done | предикат | выполнено | 8,8 | 8,8 | 0,0 | 12 | наблюдатель |
| codex/0.160.0/codex_exec/macos/workload-logstats | big-log | разметчик | выполнено | 21,6 | 21,7 | 0,0 | 16 | наблюдатель |
| codex/0.160.0/codex_exec/macos/workload-logstats | generator-done | предикат | выполнено | 14,5 | 14,5 | 0,0 | 16 | наблюдатель |
| codex/0.160.0/codex_exec/macos/workload-logstats | cli-tested | предикат | выполнено | 8,7 | 8,7 | 0,0 | 20 | наблюдатель |
| codex/0.160.0/codex_exec/macos/workload-logstats | cli-done | предикат | выполнено | 5,1 | 5,1 | 0,0 | 20 | наблюдатель |
| codex/0.160.0/codex_exec/macos/workload-logstats | report-tested | предикат | выполнено до события, разметка некорректна | — | — | — | 24 | — |
| codex/0.160.0/codex_exec/macos/workload-logstats | report-done | предикат | выполнено | 7,9 | 7,9 | 0,0 | 25 | наблюдатель |
| codex/0.160.0/codex_exec/macos/workload-logstats | review-fixed | разметчик | выполнено | 13,4 | 13,4 | 0,0 | 40 | наблюдатель |
| codex/0.160.0/codex_exec/macos/workload-logstats | streaming-tested | предикат | выполнено | 28,1 | 28,1 | 0,0 | 49 | наблюдатель |
| codex/0.160.0/codex_exec/macos/workload-logstats | streaming-done | предикат | выполнено | 21,5 | 21,5 | 0,0 | 49 | наблюдатель |
| codex/0.160.0/codex_exec/macos/workload-logstats | docs-done | разметчик | выполнено | 9,6 | 9,6 | 0,0 | 65 | наблюдатель |
| codex/0.160.0/codex_exec/macos/workload-logstats | commit-done | разметчик | описание не соответствует записи, разметка некорректна | — | — | — | — | — |
| codex/0.160.0/codex_exec/macos/workload-logstats | final-tested | разметчик | выполнено | 23,9 | 23,9 | 0,0 | 72 | наблюдатель |
| codex/0.160.0/codex_exec/macos/workload-logstats | final-done | разметчик | выполнено | 14,3 | 14,4 | 0,0 | 74 | наблюдатель |
| codex/0.160.0/codex_exec/macos/workload-kvstore | plan-written | предикат | после окна, нарушение | 817,2 | 817,3 | 0,0 | 33 | наблюдатель |
| codex/0.160.0/codex_exec/macos/workload-kvstore | plan-ready | разметчик | не выполнено, нарушение | — | — | — | — | — |
| codex/0.160.0/codex_exec/macos/workload-kvstore | log-tested | предикат | выполнено | 22,0 | 22,0 | 0,0 | 9 | наблюдатель |
| codex/0.160.0/codex_exec/macos/workload-kvstore | log-done | предикат | выполнено | 16,5 | 16,5 | 0,0 | 9 | наблюдатель |
| codex/0.160.0/codex_exec/macos/workload-kvstore | crash-tested | предикат | выполнено до события, разметка некорректна | — | — | — | 11 | — |
| codex/0.160.0/codex_exec/macos/workload-kvstore | crash-done | предикат | выполнено | 18,8 | 18,9 | 0,0 | 13 | наблюдатель |
| codex/0.160.0/codex_exec/macos/workload-kvstore | compaction-tested | предикат | выполнено | 0,7 | 0,7 | 0,0 | 17 | наблюдатель |
| codex/0.160.0/codex_exec/macos/workload-kvstore | compaction-done | предикат | выполнено | 11,4 | 11,4 | 0,0 | 18 | наблюдатель |
| codex/0.160.0/codex_exec/macos/workload-kvstore | batch-tested | предикат | выполнено | 24,0 | 24,0 | 0,0 | 23 | наблюдатель |
| codex/0.160.0/codex_exec/macos/workload-kvstore | batch-done | предикат | выполнено | 19,4 | 19,4 | 0,0 | 23 | наблюдатель |
| codex/0.160.0/codex_exec/macos/workload-kvstore | review-reported | разметчик | выполнено | 26,4 | 26,4 | 0,0 | 30 | наблюдатель |
| codex/0.160.0/codex_exec/macos/workload-kvstore | review-fixed | разметчик | выполнено | 16,6 | 16,6 | 0,0 | 31 | наблюдатель |
| codex/0.160.0/codex_exec/macos/workload-kvstore | cli-tested | предикат | выполнено | 20,5 | 20,5 | 0,0 | 34 | наблюдатель |
| codex/0.160.0/codex_exec/macos/workload-kvstore | cli-done | предикат | выполнено | 17,9 | 17,9 | 0,0 | 34 | наблюдатель |
| codex/0.160.0/codex_exec/macos/workload-kvstore | ttl-done | предикат | выполнено | 22,0 | 22,0 | 0,0 | 43 | наблюдатель |
| codex/0.160.0/codex_exec/macos/workload-kvstore | parallel-reported | разметчик | выполнено | 24,7 | 24,7 | 0,0 | 51 | наблюдатель |
| codex/0.160.0/codex_exec/macos/workload-kvstore | parallel-done | разметчик | выполнено до события, разметка некорректна | — | — | — | — | — |
| codex/0.160.0/codex_exec/macos/workload-kvstore | commit-done | разметчик | описание не соответствует записи, разметка некорректна | — | — | — | — | — |
| codex/0.160.0/codex_exec/macos/workload-kvstore | final-tested | разметчик | описание не соответствует записи, разметка некорректна | — | — | — | — | — |
| codex/0.160.0/codex_exec/macos/workload-kvstore | final-done | разметчик | выполнено | 12,6 | 12,6 | 0,0 | 89 | наблюдатель |

## Наблюдатель

| Backend | Вызовы | Приняты | Отклонены | Ошибки | С дозапросом |
| --- | --- | --- | --- | --- | --- |
| codex | 213 | 212 | 1 | 0 | 0 |

| Backend | Состояние | Время, с | Доля |
| --- | --- | --- | --- |
| codex | ok | 8739,3 | 100 % |

## Расход

Расход вызовов — по данным CLI в журнале вызовов демона. Час прогона — сумма длительностей проигранных прогонов backend, активный час — время, когда шёл хотя бы один его прогон. Деньги — только у Claude, по прейскуранту; при подписке это не списание.

| Backend | Прогоны | Часы прогонов | Активные часы |
| --- | --- | --- | --- |
| codex | 3 | 1,36 | 0,95 |

| Backend | Журнал | Вызовы | Вход без кэша | Чтение кэша | Запись кэша | Вывод | Рассуждения | Всего токенов | Стоимость |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| codex | наблюдатель | 213 | 1 553 161 | 299 904 | 0 | 73 463 | 273 | 1 926 528 | — |
| codex | чат | 13 | 234 428 | 0 | 0 | 2 971 | 102 | 237 399 | — |
| codex | пробы и auth status | 0 | 0 | 0 | 0 | 0 | 0 | 0 | — |

| Backend | Журнал | Вызовов на час прогона | Токенов на час прогона | Стоимость часа прогона | Вызовов на активный час | Токенов на активный час | Стоимость активного часа |
| --- | --- | --- | --- | --- | --- | --- | --- |
| codex | наблюдатель | 157,0 | 1 419 738 | — | 225,3 | 2 037 328 | — |
| codex | чат | 9,6 | 174 949 | — | 13,7 | 251 052 | — |

| Backend | Вопросы | Ответы | Ошибки | Не заданы | Недостаточно данных | p50 ответа, с | p95 ответа, с | Токенов на ответ | Стоимость ответа |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| codex | 9 | 9 | 0 | 0 | 4 | 11,4 | 21,6 | 26 378 | — |

По учёту расхода демона (U.1) активных часов — 2: это календарные часы, в которых была активность решателя.
