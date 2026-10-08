# Замер свежести: claude-workload-low

- Профиль нагрузки зафиксирован 2026-10-07T20:31:55.081Z, замер начат 2026-10-07T20:32:07.931Z и длился 3001,5 с.
- Окно замера 120,0 с, масштаб времени записей 1.
- Демон 0.0.0.

## Записи

| Запись | Рантайм | Старт, с |
| --- | --- | --- |
| claude/2.1.292/claude_cli/macos/workload-logstats | claude | 0,0 |
| claude/2.1.293/claude_cli/macos/workload-mdlinks | claude | 1318,2 |

## Итог по backend

Нарушение — ожидание не выполнено в окне замера. p95 считается по оценённым событиям, невыполненные события стоят в нём за окном. Выполненные до события и не соответствующие записи события — дефекты разметки, в p95 они не входят. Полная задержка идёт от времени самого события; в скобках — число событий с известным временем. Доля дозапросов — доля времени `needs` в задержке выполненных событий; в скобках — число событий с дозапросом.

| Backend | CLI | Модель | Effort | Ориентир p95 | p95 | Ориентир выполнен | В пределах ориентира | Выполнено | Нарушения | Без оценки | Выполнено до события | Не соответствует записи | Полная задержка p95 | Доля дозапросов |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| claude | 2.1.293 | claude-opus-5-5 | low | 30,0 с | за окном (нарушение) | нет | 91 % | 33 из 35 | 2 | 0 | 3 | 6 | — | 0 % (0) |

## Контрольные события

| Запись | Событие | Способ | Итог | Задержка, с | Полная, с | Дозапросы, с | Версия | Автор |
| --- | --- | --- | --- | --- | --- | --- | --- | --- |
| claude/2.1.292/claude_cli/macos/workload-logstats | triage-tested | предикат | выполнено | 9,1 | — | 0,0 | 3 | наблюдатель |
| claude/2.1.292/claude_cli/macos/workload-logstats | triage-done | предикат | выполнено | 5,5 | — | 0,0 | 3 | наблюдатель |
| claude/2.1.292/claude_cli/macos/workload-logstats | plan-written | предикат | выполнено | 32,8 | — | 0,0 | 7 | наблюдатель |
| claude/2.1.292/claude_cli/macos/workload-logstats | plan-ready | разметчик | не выполнено, нарушение | — | — | — | — | — |
| claude/2.1.292/claude_cli/macos/workload-logstats | aggregate-tested | предикат | выполнено | 22,2 | — | 0,0 | 16 | наблюдатель |
| claude/2.1.292/claude_cli/macos/workload-logstats | aggregate-done | предикат | выполнено | 13,9 | — | 0,0 | 16 | наблюдатель |
| claude/2.1.292/claude_cli/macos/workload-logstats | big-log | разметчик | выполнено | 16,9 | — | 0,0 | 24 | наблюдатель |
| claude/2.1.292/claude_cli/macos/workload-logstats | generator-done | предикат | выполнено | 13,2 | — | 0,0 | 25 | наблюдатель |
| claude/2.1.292/claude_cli/macos/workload-logstats | cli-tested | предикат | выполнено | 13,7 | — | 0,0 | 34 | наблюдатель |
| claude/2.1.292/claude_cli/macos/workload-logstats | cli-done | предикат | выполнено | 6,4 | — | 0,0 | 34 | наблюдатель |
| claude/2.1.292/claude_cli/macos/workload-logstats | format-answered | разметчик | выполнено | 11,0 | — | 0,0 | 44 | наблюдатель |
| claude/2.1.292/claude_cli/macos/workload-logstats | report-tested | предикат | выполнено | 13,8 | — | 0,0 | 49 | наблюдатель |
| claude/2.1.292/claude_cli/macos/workload-logstats | report-done | предикат | выполнено | 3,0 | — | 0,0 | 49 | наблюдатель |
| claude/2.1.292/claude_cli/macos/workload-logstats | review-reported | разметчик | выполнено | 19,7 | — | 0,0 | 83 | наблюдатель |
| claude/2.1.292/claude_cli/macos/workload-logstats | review-fixed | разметчик | выполнено | 22,9 | — | 0,0 | 108 | наблюдатель |
| claude/2.1.292/claude_cli/macos/workload-logstats | streaming-tested | предикат | выполнено | 12,6 | — | 0,0 | 118 | наблюдатель |
| claude/2.1.292/claude_cli/macos/workload-logstats | streaming-done | предикат | выполнено до события, разметка некорректна | — | — | — | 118 | — |
| claude/2.1.292/claude_cli/macos/workload-logstats | docs-reported | разметчик | выполнено | 14,4 | — | 0,0 | 143 | наблюдатель |
| claude/2.1.292/claude_cli/macos/workload-logstats | docs-done | разметчик | описание не соответствует записи, разметка некорректна | — | — | — | — | — |
| claude/2.1.292/claude_cli/macos/workload-logstats | committed | разметчик | выполнено | 10,2 | — | 0,0 | 161 | наблюдатель |
| claude/2.1.292/claude_cli/macos/workload-logstats | commit-done | разметчик | выполнено | 5,0 | — | 0,0 | 161 | наблюдатель |
| claude/2.1.292/claude_cli/macos/workload-logstats | final-tested | разметчик | описание не соответствует записи, разметка некорректна | — | — | — | — | — |
| claude/2.1.292/claude_cli/macos/workload-logstats | final-done | разметчик | выполнено | 11,5 | — | 0,0 | 166 | наблюдатель |
| claude/2.1.293/claude_cli/macos/workload-mdlinks | explore-done | разметчик | выполнено | 19,7 | — | 0,0 | 5 | наблюдатель |
| claude/2.1.293/claude_cli/macos/workload-mdlinks | plan-written | предикат | выполнено | 29,2 | — | 0,0 | 8 | наблюдатель |
| claude/2.1.293/claude_cli/macos/workload-mdlinks | plan-ready | разметчик | не выполнено, нарушение | — | — | — | — | — |
| claude/2.1.293/claude_cli/macos/workload-mdlinks | extract-tested | предикат | выполнено | 21,7 | — | 0,0 | 14 | наблюдатель |
| claude/2.1.293/claude_cli/macos/workload-mdlinks | extract-done | предикат | выполнено | 10,0 | — | 0,0 | 14 | наблюдатель |
| claude/2.1.293/claude_cli/macos/workload-mdlinks | check-tested | предикат | выполнено до события, разметка некорректна | — | — | — | 28 | — |
| claude/2.1.293/claude_cli/macos/workload-mdlinks | check-done | предикат | выполнено | 6,2 | — | 0,0 | 33 | наблюдатель |
| claude/2.1.293/claude_cli/macos/workload-mdlinks | slugs-answered | разметчик | описание не соответствует записи, разметка некорректна | — | — | — | — | — |
| claude/2.1.293/claude_cli/macos/workload-mdlinks | report-tested | предикат | выполнено | 7,9 | — | 0,0 | 52 | наблюдатель |
| claude/2.1.293/claude_cli/macos/workload-mdlinks | report-done | предикат | выполнено | 9,3 | — | 0,0 | 54 | наблюдатель |
| claude/2.1.293/claude_cli/macos/workload-mdlinks | review-reported | разметчик | выполнено | 9,0 | — | 0,0 | 92 | наблюдатель |
| claude/2.1.293/claude_cli/macos/workload-mdlinks | review-fixed | разметчик | выполнено | 12,1 | — | 0,0 | 107 | наблюдатель |
| claude/2.1.293/claude_cli/macos/workload-mdlinks | fix-tested | предикат | выполнено до события, разметка некорректна | — | — | — | 140 | — |
| claude/2.1.293/claude_cli/macos/workload-mdlinks | fix-done | предикат | выполнено | 5,5 | — | 0,0 | 149 | наблюдатель |
| claude/2.1.293/claude_cli/macos/workload-mdlinks | json-done | предикат | выполнено | 8,7 | — | 0,0 | 175 | наблюдатель |
| claude/2.1.293/claude_cli/macos/workload-mdlinks | docs-reported | разметчик | описание не соответствует записи, разметка некорректна | — | — | — | — | — |
| claude/2.1.293/claude_cli/macos/workload-mdlinks | docs-done | разметчик | описание не соответствует записи, разметка некорректна | — | — | — | — | — |
| claude/2.1.293/claude_cli/macos/workload-mdlinks | committed | разметчик | выполнено | 22,8 | — | 0,0 | 235 | наблюдатель |
| claude/2.1.293/claude_cli/macos/workload-mdlinks | commit-done | разметчик | выполнено | 19,1 | — | 0,0 | 235 | наблюдатель |
| claude/2.1.293/claude_cli/macos/workload-mdlinks | final-tested | разметчик | описание не соответствует записи, разметка некорректна | — | — | — | — | — |
| claude/2.1.293/claude_cli/macos/workload-mdlinks | final-done | разметчик | выполнено | 29,7 | — | 0,0 | 243 | наблюдатель |

## Наблюдатель

| Backend | Вызовы | Приняты | Отклонены | Ошибки | С дозапросом |
| --- | --- | --- | --- | --- | --- |
| claude | 175 | 170 | 5 | 0 | 0 |

| Backend | Состояние | Время, с | Доля |
| --- | --- | --- | --- |
| claude | ok | 4683,8 | 100 % |

## Расход

Расход вызовов — по данным CLI в журнале вызовов демона. Час прогона — сумма длительностей проигранных прогонов backend, активный час — время, когда шёл хотя бы один его прогон. Деньги — только у Claude, по прейскуранту; при подписке это не списание.

| Backend | Прогоны | Часы прогонов | Активные часы |
| --- | --- | --- | --- |
| claude | 2 | 0,78 | 0,78 |

| Backend | Журнал | Вызовы | Вход без кэша | Чтение кэша | Запись кэша | Вывод | Рассуждения | Всего токенов | Стоимость |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| claude | наблюдатель | 175 | 350 | 1 580 075 | 2 207 838 | 117 551 | 2 965 | 3 905 814 | $20,56 |
| claude | чат | 6 | 16 | 63 337 | 146 264 | 6 738 | 207 | 216 355 | $1,33 |
| claude | пробы и auth status | 0 | 0 | 0 | 0 | 0 | 0 | 0 | — |

| Backend | Журнал | Вызовов на час прогона | Токенов на час прогона | Стоимость часа прогона | Вызовов на активный час | Токенов на активный час | Стоимость активного часа |
| --- | --- | --- | --- | --- | --- | --- | --- |
| claude | наблюдатель | 225,7 | 5 037 380 | $26,52 | 225,7 | 5 037 380 | $26,52 |
| claude | чат | 7,7 | 279 036 | $1,72 | 7,7 | 279 036 | $1,72 |

| Backend | Вопросы | Ответы | Ошибки | Не заданы | Недостаточно данных | p50 ответа, с | p95 ответа, с | Токенов на ответ | Стоимость ответа |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| claude | 6 | 6 | 0 | 0 | 0 | 11,9 | 14,6 | 36 059 | $0,22 |

По учёту расхода демона (U.1) активных часов — 2: это календарные часы, в которых была активность решателя.
