# Реестр ошибок и уточнений контракта

Каждое новое сообщение пользователя об ошибке получает отдельный ID. Запись создаётся до изменения кода.

## Статусы

`NEW` → `CONTRACTED` → `IMPLEMENTED` → `VERIFIED` → `CLOSED`.

## Записи

### GOV-001 — контракт не передавался каждому исполнителю как обязательный вход

- Дата: `27.08.2026`
- Статус: `IMPLEMENTED`
- Сообщил: пользователь
- Наблюдаемое поведение: требования находились в диалоге и DOCX, но передача каждой задаче Codex/Spark/агенту не была формально обязательной.
- Ожидаемое поведение: перед любой задачей исполнитель получает текущий контракт, версию, SHA-256, применимые пункты и критерии PASS; каждое новое замечание пополняет реестр и новую версию контракта.
- Доказательство: запрос пользователя от 27.08.2026.
- Контракт: приложение B версии 0.2.
- Реализация: `AGENTS.md`, `contracts/CURRENT.md`, шаблон карточки в `SPARK_TASKS.md`.
- Регрессионная проверка: каждая карточка со статусом `READY` содержит блок `Контракт`; задача без него считается `BLOCKED`.

### UI-001 — быстрый повторный запуск использует занятый порт

- Дата: `27.08.2026`
- Статус: `VERIFIED`
- Сообщил: пользователь
- Наблюдаемое поведение: при слишком быстром повторном открытии движка порт предыдущего процесса ещё занят; новый интерфейс не запускается либо подключается к старому процессу.
- Ожидаемое поведение: до открытия нового интерфейса launcher определяет свой порт, завершает только принадлежащий OPIU процесс-держатель, дожидается подтверждения освобождения порта и лишь затем запускает новый экземпляр.
- Доказательство: сообщение пользователя от 27.08.2026; ранее наблюдавшиеся ошибки быстрого открытия файла/интерфейса.
- Затронутые пункты контракта: запуск интерфейса, завершение процесса, тестирование и приёмка.
- Новое или уточнённое требование: закрытие порта является обязательным preflight; запрещено завершать посторонний процесс только по номеру порта без проверки владельца; при неосвобождённом порте запуск блокируется понятной ошибкой.
- Обязательный регрессионный тест: занять тестовый порт старым экземпляром OPIU, выполнить повторный запуск, проверить освобождение порта, запуск ровно одного нового процесса и завершение всего дерева процессов после закрытия/формирования результата.
- Реализация: S06-FIX/S06-HARDENING, commit `9cb5a86`.
- Протокол проверки: focused critical `-count=10` — PASS; targeted S06 `-count=3` — PASS; подтверждены exact endpoint, три последовательных restart, завершение дерева, UI/result shutdown и освобождение порта.

### UI-002 — preflight не доказывает точный endpoint и не освобождает порт текущего процесса после результата

- Дата: `27.08.2026`
- Статус: `VERIFIED`
- Сообщил: независимый review S06-R.
- Наблюдаемое поведение: PID определяется только по номеру порта без точного host/IP; health допускает отсутствующие safety-ключи; после формирования результата текущий сервер остаётся в `Serve`; triple-тест проверяет только один успешный restart и не проверяет дерево процессов.
- Ожидаемое поведение: владелец привязан к точному loopback endpoint; executable и полный exact REPORT_ONLY health принадлежат одному PID; после закрытия интерфейса или формирования результата текущий процесс и порт освобождаются; 2–3 последовательных запуска оставляют ровно один новый экземпляр, а затем ноль процессов.
- Доказательство / файл / скриншот: независимый S06-R review от 27.08.2026; `service/source/main.go`, `existing_service.go`, `port_owner*.go`, `existing_service_test.go`.
- Затронутые пункты контракта: UI-001, A16, §§11, 13–14, приложение B.
- Новое или уточнённое требование: запрещено связывать PID и health только по номеру порта; отсутствующий safety-ключ не равен безопасному `false/0`; результат расчёта обязан инициировать контролируемый shutdown текущего сервера.
- Обязательный регрессионный тест: разные listeners на одинаковом port разных IP не смешиваются; missing/trailing health JSON блокируется; три последовательных подтверждённых restart завершают каждого predecessor; child/grandchild завершаются; после результата порт свободен и процессное дерево отсутствует.
- Реализация: S06-FIX/S06-HARDENING, commit `9cb5a86`.
- Протокол проверки: strict missing/trailing/second-object health, redirect isolation, same-port/different-IP, IPv6, foreign owner, result/UI shutdown и process tree — PASS; полный Go и `go vet` — PASS.

### APPROVAL-001 — пользовательские решения по статьям не загружаются обратно в движок

- Дата: `27.08.2026`
- Статус: `IMPLEMENTED`
- Сообщил: пользователь
- Наблюдаемое поведение: R16 формирует Excel-реестр предположений, но утверждения пользователя из него ещё не фиксируются как версионированный вход следующего запуска.
- Ожидаемое поведение: движок максимально заполняет лист `01_Правила`, пользователь проверяет только остаток `НУЖНА ПРОВЕРКА`, выбирает одно из пяти решений и фиксирует решения кнопкой интерфейса; после проверок создаётся версионированный approved-файл для точной организации и периода действия.
- Доказательство: сообщение пользователя от 27.08.2026 с описанием семи этапов утверждения и отдельного окна интерфейса.
- Затронутые пункты контракта: разделы 9, 11, 12, 14 и приложение B.
- Новое или уточнённое требование: решения `УТВЕРЖДАЮ`, `ИЗМЕНИТЬ`, `ЗАПРЕТИТЬ`, `НУЖНА ПРОВЕРКА`, `ПРЕДЛОЖЕНО ДВИЖКОМ`; при `ИЗМЕНИТЬ` обязательны правильный блок, статья, код ERP и комментарий; фиксация проверяет конфликты, существование кода, принадлежность блоку, организацию и дату начала действия; approved JSON хранит пользователя, дату, область, решение, источники и SHA-256.
- Обязательный регрессионный тест: экспорт заранее заполненного `01_Правила`; обратная загрузка пяти решений; отклонение конфликтов/неверного кода/чужого блока/пустой организации/периода; создание следующей версии approved JSON; применение приоритета только в совпадающей области; запрет финансовой строки без физического доказательства ERP.
- Реализация: ожидается в отдельных задачах `S04` (ядро/хранилище утверждений) и `S05` (интерфейс утверждения).
- Протокол проверки: ожидается.

### CORR-001 — одностороннее STORNO ошибочно повышается до READY или исчезает при ошибке физического доказательства

- Дата: `27.08.2026`
- Статус: `VERIFIED`
- Сообщил: независимая проверка C02 по требованиям пользователя к безопасным корректировкам.
- Наблюдаемое поведение: после повторного открытия физической строки ERP одностороннее STORNO могло попасть в подтверждённый результат `READY`; при несовпадении повторного открытия или повторном использовании источника доказанное экономическое направление скрывалось только за записью `BLOCKED`.
- Ожидаемое поведение: односторонняя корректировка всегда остаётся `СПОРНО`; в `READY` допускается только сбалансированная пара STORNO/REPOST с нулевым итогом. Если физическая строка не прошла повторную проверку либо уже использована, пользователь всё равно видит одну разреженную строку `СПОРНО` с понятной причиной, но без недоказанных физических реквизитов.
- Доказательство / файл / скриншот: независимое C02-review от 27.08.2026; `modules/corrections/source/r001_standalone_storno_materialization.mjs`.
- Затронутые пункты контракта: §§ 7–9, 12.3–12.4, 14; D04; A07, A10, A11, A22.
- Новое или уточнённое требование: повторное открытие источника подтверждает только физические реквизиты, но не меняет класс односторонней операции со `СПОРНО` на `READY`; ошибки доказательства не должны скрывать экономическое предложение от пользователя.
- Обязательный регрессионный тест: доказанное одностороннее STORNO после reopen остаётся `СПОРНО`; несовпадение reopen и `PHYSICAL_SOURCE_ALREADY_USED` дают одну sparse-SPORNO строку с пустыми физическими полями и ясной причиной; несбалансированная пара отклоняется финальным барьером.
- Реализация: задача `C02`, исправление standalone/materialization/canonical-барьеров.
- Протокол проверки: полный прогон 25 R001 test-файлов — 256/256 PASS; отдельные standalone-тесты — 31/31 PASS; `git diff --check` — PASS.

### R005-001 — отсутствует профиль верхнего уровня «Управленческая организация»

- Дата: `27.08.2026`
- Статус: `VERIFIED`
- Сообщил: диагностика S07-A.
- Наблюдаемое поведение: production registry содержит 12 разрешённых корневых профилей вместо подтверждённых 13; отсутствует `ROOT_MANAGEMENT_ORGANIZATION_REVIEW`.
- Ожидаемое поведение: профиль восстанавливается дословно из подтверждённого R16 без изменения detector и без влияния на фактические расходные блоки.
- Доказательство / файл / скриншот: `reports/S07A_R005_DIAGNOSIS.md`, раздел 1.
- Затронутые пункты контракта: §§3–4, A02.
- Новое или уточнённое требование: production registry обязан сохранять полный утверждённый набор верхнеуровневых организаций.
- Обязательный регрессионный тест: `profile_detector_12_test.mjs` — 13/13 профилей, 1/1 PASS.
- Реализация: S07-B.
- Протокол проверки: `profile_detector_12_test.mjs` — `PROFILE_DETECTOR_13_13=PASS`; commit `c2f5a2f`.

### R005-002 — acceptance Сахалина запускался без обязательного ERP-журнала

- Дата: `27.08.2026`
- Статус: `VERIFIED`
- Сообщил: диагностика S07-A.
- Наблюдаемое поведение: тест завершался до расчёта, потому что не был передан путь к извлечённому ERP-журналу.
- Ожидаемое поведение: acceptance-команда явно получает правильный ERP journal через аргумент или `SAKHALIN_JOURNAL_XLSX`; другой XLSX не подставляется.
- Доказательство / файл / скриншот: `reports/S07A_R005_DIAGNOSIS.md`, раздел 2.
- Затронутые пункты контракта: §§3, 6, 11, 13; A06, A10.
- Новое или уточнённое требование: отсутствие внешнего журнала блокирует финансовое доказательство понятной ошибкой, но не исправляется подстановкой неподходящего файла.
- Обязательный регрессионный тест: Сахалин январь 2025 с точным внешним журналом — `PASS_SAKHALIN_OPERATION_EVIDENCE_SCOPE`, `posting_rows=0` до доказанных корректировок.
- Реализация: acceptance harness/input, без production patch.
- Протокол проверки: точный журнал SHA-256 `776D566495175191D1B394C2545FE10B11173C755A51879FD18726A91A40A504`; `PASS_SAKHALIN_OPERATION_EVIDENCE_SCOPE`, 4033/39/21 строк, `posting_rows=0`.

### R005-003 — wrapper потерял authoritative projection и period binding

- Дата: `27.08.2026`
- Статус: `VERIFIED`
- Сообщил: диагностика S07-A.
- Наблюдаемое поведение: `service_r005_owner_wrapper.mjs` передаёт сырой `payload.hierarchy_periods` и не экспортирует authoritative helper.
- Ожидаемое поведение: wrapper строит authoritative hierarchy periods из точного совпадения периода, `period_rows` и уникальных ERP trace paths; drift блокируется.
- Доказательство / файл / скриншот: `reports/S07A_R005_DIAGNOSIS.md`, раздел 3.
- Затронутые пункты контракта: §§4–6, 10, 13; A01, A02, A04, A07.
- Новое или уточнённое требование: сырое отображение не заменяет authoritative projection двух независимых деревьев.
- Обязательный регрессионный тест: `service_r005_owner_wrapper_inventory.test.mjs` — 3/3 PASS, включая production numeric shape и fail-closed period drift.
- Реализация: S07-C.
- Протокол проверки: wrapper production-shape — 3/3 PASS; authoritative period projection и scope drift подтверждены; commit `c2f5a2f`.

### R005-004 — бизнес-детали structural control не добавляются в `07_Контроли`

- Дата: `27.08.2026`
- Статус: `VERIFIED`
- Сообщил: диагностика S07-A.
- Наблюдаемое поведение: detail-builder существует, но production `opiu_reconcile.mjs` не вызывает его и не дописывает таблицу деталей к summary.
- Ожидаемое поведение: `07_Контроли` сохраняет summary и добавляет выбранные участники Инталев/ERP и дельту; `financial_rows=0`, `posting_rows=0`.
- Доказательство / файл / скриншот: `reports/S07A_R005_DIAGNOSIS.md`, раздел 4.
- Затронутые пункты контракта: §§4–6, 10–11, 13; A01, A02, A04, A09, A11, A12.
- Новое или уточнённое требование: контроль нулевой дельты диагностический и не скрывает фактические дочерние строки и блоки расходов.
- Обязательный регрессионный тест: `structural_control_report_detail.test.mjs` — 3/3 PASS и нулевые финансовые/posting rows.
- Реализация: после отделения S04, отдельный production patch в `opiu_reconcile.mjs`.
- Протокол проверки: `structural_control_report_detail.test.mjs` — 3/3 PASS; интеграция в `07_Контроли`, `financial_rows=0`, `posting_rows=0`; commit `7dbf792`.

### R005-005 — профиль Сахалина потерял подтверждённый alias

- Дата: `27.08.2026`
- Статус: `VERIFIED`
- Сообщил: регрессионный прогон S07-B.
- Наблюдаемое поведение: после восстановления 13-го профиля `profile_detector_12_test.mjs` обнаружил отсутствие `aliases: ["Сахалин"]` у `ROOT_SAKHALIN_REVIEW`; detector не распознаёт пользовательское верхнеуровневое имя.
- Ожидаемое поведение: профиль Сахалина дословно сохраняет подтверждённый R16 alias без изменения detector и остальных профилей.
- Доказательство / файл / скриншот: `profile_detector_12_test.mjs`, проверка alias; exact R16 comparison.
- Затронутые пункты контракта: §§3–4, 14; A02; контроль Сахалина за январь 2025.
- Новое или уточнённое требование: верхнеуровневые пользовательские названия организаций входят в authoritative profile registry, а не подменяются эвристикой.
- Обязательный регрессионный тест: `profile_detector_12_test.mjs` — 1/1 PASS после 13 профилей и alias Сахалина.
- Реализация: расширение S07-B только на объект `ROOT_SAKHALIN_REVIEW`.
- Протокол проверки: профильный контур — 13/13 PASS; alias `Сахалин` разрешается в `3 Сахалин`; commit `c2f5a2f`.

### R005-006 — wrapper теряет числовые суммы реального `period_rows`

- Дата: `27.08.2026`
- Статус: `VERIFIED`
- Сообщил: независимый review S07-BC.
- Наблюдаемое поведение: authoritative projection читает только `row.intalev.amount`/`row.erp.amount`, тогда как production payload передаёт числовые `row.intalev`/`row.erp`; группы получают нулевые counts и причины неполной привязки.
- Ожидаемое поведение: wrapper принимает точный production-shape с числовыми суммами, сохраняет суммы в копейках и не делает коммерческие, транспортные, складские и другие фактические блоки невыбираемыми.
- Доказательство / файл / скриншот: S07-BC review; `service_r005_owner_wrapper.mjs`, реальный payload из `opiu_reconcile.mjs`.
- Затронутые пункты контракта: §§4–6, 10, 13–14; A01, A02, A04, A07.
- Новое или уточнённое требование: тест wrapper обязан использовать фактический сериализованный production-shape, а не только вложенные тестовые `{amount}`.
- Обязательный регрессионный тест: числовые `intalev/erp` сохраняют counts, exact cents и selectable group flags; коммерческие/транспортные/складские блоки не исчезают.
- Реализация: S07-C2, отдельная задача Codex.
- Протокол проверки: wrapper production numeric shape — 3/3 PASS; exact cents и selectable group flags сохранены; commit `c2f5a2f`.

### R005-007 — strict Node-loader отклоняет усиленный REPORT_ONLY snapshot Go-сервиса

- Дата: `27.08.2026`
- Статус: `VERIFIED`
- Сообщил: диагностика S08 полного Go-прогона.
- Наблюдаемое поведение: `TestServiceMaterializedSnapshotLoadsInStrictNodeEngine` падает с `BLOCKED_EMPTY_ARTICLE_BINDING_SETTINGS_SAFETY_KEYS_INVALID`, потому что Go-сервис материализует 15 safety-ключей, а strict Node-loader принимает старый набор из 11 ключей.
- Ожидаемое поведение: strict Node-loader принимает только точный усиленный набор из 15 safety-ключей и требует безопасные значения `REPORT_ONLY`, `report_only=true`, `executed_posting_rows=0`, `live_posting_rows=0`, `live_delete_allowed=false`, `execution_allowed=false`, `ready_to_upload=false`, `release_allowed=false`.
- Доказательство / файл / скриншот: полный и targeted Go-прогоны S08; `service/source/empty_article_binding_pipeline.go`, `service/source/empty_article_binding_pipeline_test.go`, `modules/reconciliation/source/empty_article_binding_settings.mjs`.
- Затронутые пункты контракта: §§3.1, 9.5–9.6, 13–14; A06, A10, A17–A22.
- Новое или уточнённое требование: межъязыковой snapshot использует одну строгую fail-closed safety-схему; дополнительные запретительные поля нельзя удалять или игнорировать.
- Обязательный регрессионный тест: Node unit проверяет точные 15 ключей и отклоняет каждое небезопасное значение; `TestServiceMaterializedSnapshotLoadsInStrictNodeEngine` принимает Go-snapshot и подтверждает active audit без финансового, загрузочного, execution или release допуска.
- Реализация: S08, синхронизация strict Node-loader без изменения Go producer.
- Протокол проверки: Node unit — 8/8 PASS; targeted cross-runtime Go — PASS; полный Go — PASS; commit `9891481`.

### UI-003 — lifecycle завершает процесс по отсутствию request-start во время активной работы

- Дата: `27.08.2026`
- Статус: `VERIFIED`
- Сообщил: независимый review S06-ACCEPTANCE.
- Наблюдаемое поведение: общий idle-таймер запускается от начала HTTP-запроса и через 10 секунд может инициировать shutdown при долгом запросе, активном расчёте или редактировании формы без фонового polling.
- Ожидаемое поведение: активный запрос или незавершённый run никогда не прерывается idle-механизмом; shutdown разрешён после завершённого результата либо доказанного закрытия/истечения heartbeat UI при отсутствии активного run.
- Доказательство / файл / скриншот: `service/source/main.go`, `service/source/existing_service.go`, review S06-ACCEPTANCE.
- Затронутые пункты контракта: §§11, 13–14; UI-001, UI-002, A13, A16.
- Новое или уточнённое требование: отсутствие нового request-start само по себе не доказывает закрытие интерфейса; lifecycle учитывает in-flight работу и активные run.
- Обязательный регрессионный тест: долгий active request и active run не закрываются; completed result и доказанное UI-close/heartbeat expiry закрывают сервис только после исчезновения in-flight/active-run.
- Реализация: S06-HARDENING.
- Протокол проверки: lifecycle/in-flight/active-run/reconnect targeted `-count=3` — PASS; focused critical `-count=10` — PASS; commit `9cb5a86`.

### UI-004 — exact loopback проверяется только после неудачного bind

- Дата: `27.08.2026`
- Статус: `VERIFIED`
- Сообщил: независимый review S06-ACCEPTANCE.
- Наблюдаемое поведение: при свободном адресе первый `net.Listen` принимает hostname, wildcard или non-loopback до вызова строгой проверки endpoint.
- Ожидаемое поведение: до любого bind адрес обязан быть точным literal loopback IPv4/IPv6; `localhost`, wildcard, hostname ambiguity, non-loopback и нулевой порт блокируются.
- Доказательство / файл / скриншот: `service/source/existing_service.go`, review S06-ACCEPTANCE.
- Затронутые пункты контракта: §11; UI-001, UI-002, A16.
- Новое или уточнённое требование: проверка exact loopback является pre-bind барьером, а bind использует подтверждённую сеть и канонический адрес.
- Обязательный регрессионный тест: свободные `localhost`, wildcard и non-loopback не создают listener; точные `127.0.0.1` и `::1` разрешены.
- Реализация: S06-HARDENING.
- Протокол проверки: free wildcard/hostname/non-loopback reject и exact IPv4/IPv6 bind — PASS; commit `9cb5a86`.

### UI-005 — owner identity не защищена от повторного использования PID перед tree kill

- Дата: `27.08.2026`
- Статус: `VERIFIED`
- Сообщил: независимый review S06-ACCEPTANCE.
- Наблюдаемое поведение: после проверки endpoint/health/path дерево завершается по числовому PID; creation identity не входит в owner и drift непосредственно перед kill не блокируется.
- Ожидаемое поведение: Windows owner включает creation identity, полученную вместе с executable из одного process handle; непосредственно перед завершением endpoint, PID, executable и creation identity подтверждаются повторно, любой drift блокирует kill.
- Доказательство / файл / скриншот: `service/source/port_owner*.go`, `service/source/existing_service.go`, review S06-ACCEPTANCE.
- Затронутые пункты контракта: §11; UI-001, UI-002, A16.
- Новое или уточнённое требование: совпадение одного PID недостаточно; подтверждённая process identity удерживается до завершения и ожидания освобождения дерева.
- Обязательный регрессионный тест: изменение creation identity при том же PID блокирует завершение; подтверждённый owner и его дерево завершаются; replacement/foreign процесс остаётся жив.
- Реализация: S06-HARDENING.
- Протокол проверки: creation-time drift block, exact owner recheck, replacement/foreign survival и verified tree termination — PASS; commit `9cb5a86`.

## Шаблон новой записи

```text
### ERR-NNN — краткое название

- Дата:
- Статус: NEW
- Сообщил: пользователь
- Наблюдаемое поведение:
- Ожидаемое поведение:
- Доказательство / файл / скриншот:
- Затронутые пункты контракта:
- Новое или уточнённое требование:
- Обязательный регрессионный тест:
- Реализация:
- Протокол проверки:
```

### PERF-001 — discovery полностью открывает каждый XLSX архива Инталев

- Дата: `27.08.2026`
- Статус: `IMPLEMENTED`
- Сообщил: пользователь по результатам profiling R005.
- Наблюдаемое поведение: discovery справочника Инталев последовательно выполняет полный workbook probe для всех XLSX-кандидатов: 67 файлов на входе 9 УК и 7 файлов на входе 3 Сахалин. Измеренный profiling baseline R005: 9 УК 2025-10 — `120.704 с`, 9 УК 2025-11 — `120.983 с`, 3 Сахалин 2025-01 — `188.933 с`.
- Ожидаемое поведение: дешёвый tri-state OOXML preflight без изменения семантики выбора исключает полный probe только для полностью декодированного XLSX, в котором доказанно отсутствует требуемая schema; malformed или unsupported XLSX обязательно передаётся существующему полному probe.
- Доказательство / файл / скриншот: profiling контрольных входов с точными SHA-256; `modules/reconciliation/source/intalev_catalog_binding.mjs`, полный probe каждого `.xlsx` при archive/directory discovery.
- Затронутые пункты контракта: §§3.1, 4, 13–14; A01, A02, A06, A07, A10, A12–A15.
- Новое или уточнённое требование: имя файла не является authority; сканируются все кандидаты; ordinal, provenance, source drift и fail-closed ambiguity не меняются; preflight не ослабляет physical-proof, `REPORT_ONLY` или safety.
- Обязательный регрессионный тест: synthetic inventory `67→2` и `7→2` полных probe; malformed/unsupported→full probe; fully decoded no-schema→skip; classifier с произвольным именем выбирается; два валидных классификатора остаются ambiguous; real-input semantic smoke запускается только при наличии входа с точным ожидаемым SHA-256.
- Реализация: PERF-001 в `intalev_catalog_binding.mjs`: tri-state OOXML preflight использует канонический `detectIntalevCatalogHeaders`, пропускает только полностью декодированный no-schema и сохраняет полный probe для possible, malformed и unsupported.
- Протокол проверки: scoped `18/18 PASS`; synthetic `67→2` и `7→2`; real exact-SHA smoke сохраняет ordinal `66/6`, SHA classifier, `TDSheet`, `220/219` узлов; R005 after `51.681/43.634/42.897 с`; полный R005 `212 PASS / 7` известных несвязанных падений.

### TEST-001 — fixture empty-article binding отстал от строгой схемы safety

- Дата: `27.08.2026`
- Статус: `IMPLEMENTED`
- Сообщил: полный post-commit regression.
- Наблюдаемое поведение: `empty_article_binding_application.test.mjs` передаёт 11 safety-ключей; строгий production-loader после `R005-007` требует 15 и блокирует шесть тестов кодом `BLOCKED_EMPTY_ARTICLE_BINDING_SETTINGS_SAFETY_KEYS_INVALID`.
- Ожидаемое поведение: test fixture содержит ровно 15 безопасных ключей, включая `report_only`, `executed_posting_rows`, `live_posting_rows`, `live_delete_allowed`; production-validator не ослабляется.
- Затронутые пункты контракта: §§3.1, 9.5–9.6, 13–14; A06, A10, A17–A22.
- Допустимый scope: только `modules/reconciliation/source/empty_article_binding_application.test.mjs`.
- Обязательный регрессионный тест: targeted `7/7`, полный reconciliation `198/198`, corrections `256/256`.
- Реализация: test-only fixture дополнен четырьмя строгими запретительными полями; production-validator не изменён.
- Протокол проверки: targeted `empty_article_binding_application.test.mjs` — `7/7 PASS`; полный reconciliation/C02 выполняется после объединения параллельных непересекающихся исправлений.

### APPROVAL-002 — API не отдаёт authoritative очередь `01_Правила` текущего запуска

- Дата: `27.08.2026`
- Статус: `IMPLEMENTED`
- Сообщил: независимый review S04/S05.
- Наблюдаемое поведение: GET возвращает только последнюю approved-версию, а POST требует от браузера server path, SHA и полные исходные строки; server-bound `row_id`, `queue_revision` и `bulk_approvable` отсутствуют.
- Ожидаемое поведение: queue-mode по `run_id` сам привязывает exact R005 XLSX, scope, actor, 21 колонку и ERP-каталог; браузер передаёт только opaque row/revision и редактируемые решения.
- Затронутые пункты контракта: §§9.5–9.6, 11, 13–14; A17–A24.
- Допустимый scope: `service/source/article_approvals.go`, `article_approvals_test.go`; UI — отдельная S05-задача.
- Обязательный регрессионный тест: stale SHA/revision, чужой scope и client authority блокируются; bulk только для server-proven однозначных строк; fix публикует атомарную immutable JSON+SHA пару.
- Реализация: queue-mode GET по `run_id` повторно проверяет completed anchored R005 и его SHA/size, сам извлекает точные 21 колонку `01_Правила`, scope, actor и ERP-каталог; выдаёт opaque `row_id`, `queue_revision` и server-owned `bulk_approvable`. POST принимает только exact полный набор строк и revision, повторно гидратирует immutable source rows, отклоняет stale/missing/extra/duplicate/client-authority, проверяет конфликты и публикует новую version без перезаписи под общим publication lock; JSON публикуется последним как commit marker.
- Протокол проверки: targeted APPROVAL-002/A18–A22 `count=3` — PASS (`44.456s`); полный `go test ./...` — PASS (`207.667s`); `go vet .` — PASS; `git diff --check` — PASS; независимый peer review и targeted Go — PASS (`9.611s`). Неблокирующий test-gap: filesystem failure-injection между sidecar и JSON не добавлен, атомарный инвариант подтверждён статическим review.

### APPROVAL-003 — approved-решение не применяется production mapping и A22 gate

- Дата: `27.08.2026`
- Статус: `IMPLEMENTED`
- Сообщил: независимый downstream review S04.
- Наблюдаемое поведение: R005 загружает approved JSON и добавляет metadata, но downstream target selection её не читает; `evaluateArticleApprovalFinancialGate` вызывается только unit-тестами.
- Ожидаемое поведение: exact-scope `УТВЕРЖДАЮ/ИЗМЕНИТЬ` меняет целевую ERP-статью только после production A22 physical gate; `ЗАПРЕТИТЬ` терминально блокирует, остальные состояния не дают authority.
- Затронутые пункты контракта: §§9.5–9.6, 12.2–12.4, 13–14; A07, A10, A11, A21, A22.
- Допустимый scope: article approval resolver, R005 cross-journal target selection, production integration tests; R001 сохраняет независимый current-run proof и one-row-once.
- Обязательный регрессионный тест: wrong-block override, change, forbid, composite consistency, missing/duplicate/stale/reused ERP row, одна доказанная balanced pair; полный C02 `256/256`.
- Реализация: exact-scope approved загружается до automatic target selection. `УТВЕРЖДАЮ` применяет предложенную, `ИЗМЕНИТЬ` — исправленную exact ERP-цель; `ЗАПРЕТИТЬ` терминально возвращает пустую blocked-цель без автоматического подтверждения; незавершённые решения остаются только диагностикой. Production A22 повторно открывает ровно одну физическую строку ERP, проверяет cross-journal proof, period/org/amount/unique/reuse и общий набор SourceRowID для direct/composite. Успех создаёт только сбалансированную пару STORNO/REPOST, ошибка — видимое `СПОРНО` и 0 финансовых строк; `04B` получает только успешные gate-строки. Все posting/live/executed gates равны 0 в REPORT_ONLY.
- Протокол проверки: targeted APPROVAL-003/S04 — `38/38 PASS`; полный reconciliation/R005 — `223 PASS`, `0 FAIL`, `1` ожидаемый external-golden skip; C02 baseline без параллельного S09 handoff — `256/256 PASS`; syntax/scoped diff-check PASS. Независимый review повторил `38/38`, `223+1 skip`, C02 `256/256` и отдельно воспроизвёл terminal `ЗАПРЕТИТЬ`: пустые target fields, `APPROVAL_FORBIDDEN`, точное пользовательское объяснение и 0 пары/authority.

### STR-001 — wrapper оставляет raw structural plan при authoritative inventory

- Дата: `27.08.2026`
- Статус: `IMPLEMENTED`
- Сообщил: авторитетный acceptance и независимый structural review.
- Наблюдаемое поведение: core plan строится по raw hierarchy, wrapper материализует inventory по другой authoritative projection, но raw plan остаётся в Codex input и manifest; возникают оба `*_STRUCTURAL_PLAN_SCOPE_MISMATCH` и `CURRENT_RUN_SCOPE_NOT_VERIFIED`.
- Ожидаемое поведение: wrapper один раз строит authoritative hierarchy/plan и записывает один exact inventory ID и hashes в Codex input, manifest и materialized inventory; validators не ослабляются.
- Затронутые пункты контракта: §§4–6, 10, 13–14; A01, A02, A04, A07, A09.
- Допустимый scope: `service_r005_owner_wrapper.mjs` и `service_r005_owner_wrapper_inventory.test.mjs`.
- Обязательный регрессионный тест: production-shape raw plan переписывается authoritative plan; stale/foreign/scope drift остаются BLOCKED; Сахалин NOT_PASS не обходится.
- Реализация: wrapper вычисляет authoritative hierarchy/input/plan один раз, связывает один exact plan с Codex input и manifest и передаёт тот же frozen input materializer; validators не изменены.
- Протокол проверки: wrapper `5/5 PASS`; wrapper+inventory+settings `17/17 PASS`; полный relevant R005 исполнителя `221/221 PASS`; independent targeted `17/17 PASS`; foreign scope и NOT_PASS остаются BLOCKED.

### ARCH-001 — production pipeline всё ещё требует Rules stage

- Дата: `27.08.2026`
- Статус: `IMPLEMENTED`
- Сообщил: авторитетный acceptance и S09 architecture audit.
- Наблюдаемое поведение: Service выполняет обязательную цепочку `R005 → RULES → R001`, читает mutable registry/legacy defaults и содержит WAIT_USER_RULES/review contour, хотя контракт требует `rules_service=false` и прямой доказательный R005→R001.
- Ожидаемое поведение: Service-owned immutable handoff с SHA/scope/period/proof передаёт R005 напрямую R001; старые 177 rules, registry, `OPIU_RULES_CMD_JSON`, Rules UI/state и defaults не являются runtime dependency.
- Затронутые пункты контракта: §§1, 1.2, 3–7, 9–10, 12–14, 16; A01–A12, A17–A22.
- Допустимый scope: S09 migration по отдельной принятой карте; S04/S06 safety сохраняется, Rules не заменяется скрытым эквивалентом.
- Обязательный регрессионный тест: ровно два stages R005/R001; corrupt SHA/scope/proof блокирует; без physical proof только СПОРНО; package не содержит legacy Rules runtime/defaults.
- Реализация: production Service выполняет только `R005 → immutable handoff → R001`. Handoff связывает точные организацию, период, входы, доказательства и SHA; R001 повторно проверяет его до формирования строк. Legacy Rules runtime/defaults и произвольные решения не участвуют в штатном маршруте. Некорректная или несбалансированная пара не создаёт финансовые A:AA-строки, но сохраняется одной видимой записью проверки с суммами, физическими источниками, блокером и причиной.
- Протокол проверки: independent exact-chain review `PASS`; полный C02 `256/256 PASS`; полный Go `PASS`; critical Go `-count=3 PASS`; `go vet ./... PASS`; focused JS `39/39 PASS`. В отдельном cleanup удалены legacy Rules runtime/backend/status/UI без policy-исключений. На чистом detached-снимке строгие repository/package gates дали `PASS`, violations `0`; dependency closure `135`; reconciliation+corrections JS `483 PASS`, `1` штатный skip; web `46/46 PASS`; Go `PASS`; packaging `61 PASS`, `2` штатных Windows-skip. Source inventory: `272` файла, SHA-256 `0A3025F7314B866EA5967276FC51DA3B862062777CF4F249E6F78B39B1A1F7AB`; runtime inventory: `123` файла, SHA-256 `1E1B5FE7ED27F70028946996045EA4D67A5FA2ABAFC830F9512D6EBF7BE906D7`.

### R005-008 — у UK отсутствует обязательный лист `08_Операции_журнала`

- Дата: `27.08.2026`
- Статус: `IMPLEMENTED`
- Сообщил: авторитетный acceptance exact HEAD `4e34cc9`.
- Наблюдаемое поведение: UK Oct/Nov создаёт `09_Доказанные_операции`, но не точный обязательный `08_Операции_журнала`; Сахалин формирует required set.
- Ожидаемое поведение: точный обязательный лист существует всегда, включая ноль доказанных операций; старое имя не подменяет контрактное.
- Затронутые пункты контракта: §§10, 13–14; A05, A10, A12–A15.
- Допустимый scope: workbook writer и mandatory-sheet contract tests; consumers мигрируются явно.
- Реализация: writer всегда создаёт точный обязательный лист `08_Операции_журнала` с заголовком, пометкой `REPORT_ONLY`, строкой заголовков и диагностической `INFO_NO_JOURNAL_OPERATION_ROWS`, если business rows отсутствуют. INFO-строка не учитывается в счётчике операций. Доказанные операции остаются на отдельном optional-листе `09_Доказанные_операции` только после обязательного набора.
- Протокол проверки: focused mandatory workbook `4/4 PASS`; полный R005 `227 PASS`, `0 FAIL`, `1` штатный external-golden skip. UK Oct/Nov содержат `08_Операции_журнала` и optional `09` под номером 16; Сахалин содержит обязательный `08` и не создаёт пустой optional `09`. XML relationships/Targets/content-types, active tree tab и reopen проверены независимо; формульных ошибок нет.
- Обязательный регрессионный тест: exact sheet name/order на UK/Sakhalin и пустой run, без формульных ошибок.
- Реализация: ожидается.
- Протокол проверки: ожидается.

### CORR-002 — owner wrapper передаёт запрещённый core-параметр `--decisions`

- Дата: `27.08.2026`
- Статус: `IMPLEMENTED`
- Сообщил: независимый S04 downstream review.
- Наблюдаемое поведение: `service_r001_owner_wrapper.mjs` добавляет `--decisions`, а `correction_engine_r001.mjs` безусловно отклоняет этот параметр; штатный production E2E не может быть доказан.
- Ожидаемое поведение: wrapper и core используют одну contract-bound схему immutable handoff; произвольные решения не получают authority.
- Затронутые пункты контракта: §§7, 9, 12–14; A07–A12, A22.
- Допустимый scope: определяется отдельным audit; safety/proof gates не ослабляются.
- Обязательный регрессионный тест: production wrapper запускает core, exact handoff принят, legacy/arbitrary decisions блокируются, C02 `256/256`.
- Реализация: owner wrapper и core переведены на единственный contract-bound immutable handoff. Параметр `--decisions` не используется для выдачи полномочий; exact handoff принимается только после повторной проверки scope, SHA, доказательств и полной пары. Legacy/arbitrary decisions остаются заблокированными.
- Протокол проверки: production wrapper→core входит в focused JS `39/39 PASS`; полный C02 `256/256 PASS`; полный Go и `go vet` — `PASS`; independent review подтвердил exact valid pair `READY`, а missing/outside/reused/mixed/malformed пары — только видимый `СПОРНО` без финансовых строк.

### R005-009 — октябрьский `R036` расходится с подтверждённым r13

- Дата: `27.08.2026`
- Статус: `VERIFIED`
- Сообщил: авторитетный acceptance exact HEAD `4e34cc9`.
- Наблюдаемое поведение: golden r13 `R036 Инталев = 10 756 935,99`, delta `+831 254,00`; current `9 560 865,99`, delta `−364 816,00`; exact operations `21 → 16`, остальные 64 top-кода совпали.
- Ожидаемое поведение: при тех же утверждённых входах и scope R036 и физические операции совпадают с golden либо расхождение полностью объяснено доказанной сменой входа/контракта.
- Затронутые пункты контракта: §§4–7, 10, 12–14; A01–A12, A15.
- Допустимый scope: удалить вычитание НДФЛ из исходного контейнера R036 и сохранить доказанный `exact_parent_component` через presentation rollup/coverage; никаких ручных сумм, Rules или бизнес-fixtures.
- Обязательный регрессионный тест: точные physical row identities и суммы пяти операций, source SHA/scope/profile; current R005 восстанавливает golden при неизменных входах либо fail-closed фиксирует доказанный input drift.
- Реализация: удалено ошибочное вычитание НДФЛ из исходного контейнера `R036`. До presentation rollup добавлено fail-closed восстановление exact ERP parent/alias composition: уникальный summary, единый catalog prefix, полный source-tree proof, одинаковые period/source scope и additive closure; исходный proven trace сохраняется при rollup. `normalization_trace` не получает classifier authority, а доказанные literal ERP totals не переопределяются.
- Протокол проверки: real October golden/current — `2/2 PASS`; финансовая signature `65/65`, `R036 Инталев = 10 756 935,99`, ERP `9 925 681,99`, delta `+831 254,00`, status `MATCHED`; exact operations `21`, восстановлены 5 unique physical rows, reuse `0`, operational/consumed once `19 623,00`, closing excluded `19 623,00`. Полный R005 исполнителя — `209 PASS`, `0 FAIL`, `1` ожидаемый skip; независимый post-patch review: все локальные `*r005*.test.mjs` `57 PASS`, `0 FAIL`, `1` ожидаемый skip, focused artifact `2/2 PASS`, syntax/diff-check PASS.

### R005-010 — итоговая книга не соблюдает обязательный состав и порядок листов §12.1

- Дата: `27.08.2026`
- Статус: `IMPLEMENTED`
- Сообщил: независимый workbook-contract review.
- Наблюдаемое поведение: обязательные листы создаются условно и в разном порядке: `01_Правила` раньше дерева, `04A/04B/08_Операции` могут отсутствовать, wrapper добавляет `08_Решения_обоснование` после optional `09`.
- Ожидаемое поведение: все 15 обязательных листов существуют ровно один раз и в порядке §12.1 даже при нуле business rows; optional `09_Доказанные_операции` располагается только после них.
- Затронутые пункты контракта: §§4.2, 6, 9, 10, 12.1, 13–14; A05–A12, A15, A17.
- Допустимый scope: `opiu_reconcile.mjs`, `owner_decision_xlsx.mjs`, focused mandatory-sheets test; суммы, matching, C02 и safety не меняются.
- Обязательный регрессионный тест: UK Oct/Nov, Сахалин и zero-run имеют exact 15 names/order; пустые 04A/04B/08 листы содержат headers и 0 business rows; wrapper заполняет placeholder на месте, optional 09 после обязательного набора; reopen без formula/relationship errors.
- Реализация: core создаёт ровно 15 обязательных листов в порядке §12.1; `04A`, `04B`, `08_Операции_журнала` и `08_Решения_обоснование` существуют даже при нуле business rows и имеют фиксированные заголовки. Owner wrapper заменяет XML заранее созданного placeholder-листа на месте, сохраняя имя, позицию, `r:id`, Target и content-type; повторное применение идемпотентно. Optional `09_Доказанные_операции` допускается только листом №16. Активный лист — `01_Сверка_дерево` (`activeTab=1`).
- Протокол проверки: focused contract `4/4 PASS`; real October golden/current `2/2 PASS`; APPROVAL-003 `38/38 PASS`; полный R005 `227 PASS`, `0 FAIL`, `1` штатный skip. Независимый реальный прогон UK Oct/Nov/Sakh: exact first 15 order; финансовые сигнатуры `65/65`, `R036` и physical-ID bags совпадают с baseline `c21788a`; exact operations `21/21/0`. Дублей names/sheetIds/rIds/Targets нет, все worksheet content-types корректны, formula-error scan пуст, INFO-строки не включены в business counts, `git diff --check` PASS.

### PACK-001 — переносимый EXE не получает authoritative каталог организаций

- Дата: `28.08.2026`
- Статус: `IMPLEMENTED`
- Сообщил: независимая read-only проверка финальной упаковки.
- Наблюдаемое поведение: `NewPipeline` в packaged-runtime без внешних adapters всегда открывает `runtime/data/defaults/organizations.json`, но `r17_portable_policy.json` и builder переносят только source-модули и `resources/reference`; каталога в Git нет. Такой EXE должен завершиться до `/api/health` и `/api/organizations` ошибкой `load authoritative organization catalog`.
- Ожидаемое поведение: exact authoritative каталог организаций входит в подписанный runtime, учитывается source/runtime inventory и доступен по `runtime/data/defaults/organizations.json` после распаковки в любой короткий путь; `/api/organizations` возвращает selectable `ERP-000000224` и `ERP-000000076` с их верхними уровнями.
- Затронутые пункты контракта: §§1, 3.1, 11, 13–14; A01, A03, A10, A13–A14.
- Допустимый scope: exact resource `data/defaults/organizations.json`, packaging policy/builder/verifier/tests и production smoke; финансовая логика R005/R001, Rules Service и safety gates не меняются.
- Обязательный регрессионный тест: чистый A/B build включает каталог с exact SHA-256; independent verifier и два relocation-smoke запуска проходят; `/api/health` и `/api/bootstrap` подтверждают `REPORT_ONLY`, `rules_service=false`, posting/live/executed `0`; `/api/organizations` содержит оба контрольных selectable узла.
- Реализация: commit `5478aae7fe2258b826d9ed911b7d49364ba795a3` добавил exact `data/defaults/organizations.json`, включил его в policy/builder/source+runtime inventory и independent verifier. Каталог устанавливается в `runtime/data/defaults/organizations.json`; verifier требует контрольные selectable `ERP-000000224` и `ERP-000000076`.
- Протокол проверки: packaging unit/integration suite commit прошёл; детерминированная A/B-сборка `a8820e9` ранее дала побайтово одинаковые архивы и `2/2` relocation smoke, `/api/organizations` содержал обе контрольные организации. Повторный package-smoke выполняется для итогового commit.

### R005-011 — допустимые уровни Excel и `/` внутри статьи ошибочно блокируют иерархию Сахалина

- Дата: `28.08.2026`
- Статус: `IMPLEMENTED`
- Сообщил: packaged-EXE acceptance Сахалина за январь 2025.
- Наблюдаемое поведение: R005 сохраняет все `357` узлов Инталев и `259` узлов ERP, но Service останавливает цепочку на `R005_INVENTORY` со статусом `BLOCKED_STRUCTURAL_INVENTORY`. В источнике выявлены `16` ложных `BROKEN_PATH` и `15` ложных `ORPHAN_NODE`: часть строк использует допустимый скачок outline-level через отсутствующий промежуточный уровень, а статья `Контур.Edi / тариф Общий (для остальных ТС)` содержит разделитель `/` как часть собственного наименования.
- Ожидаемое поведение: путь строится по ближайшему предыдущему фактическому родителю меньшего outline-level, пустые уровни не создают пустых сегментов, а наименование с `/` остаётся одним сегментом. Проверенная структура проходит inventory; все фактические блоки и детали сохраняются. Неоднозначная физическая связь Сахалина остаётся `СПОРНО`, не получает READY/posting authority.
- Затронутые пункты контракта: §§4–6, 9–11, 13–14; A01–A04, A10–A12, A14.1.
- Допустимый scope: нормализация path segments/parent identity при чтении фактического дерева Инталев, focused regression и повторный packaged acceptance; финансовое сопоставление, Rules Service, approved mappings и safety gates не меняются.
- Обязательный регрессионный тест: скачок outline-level `0→2` связывается с ближайшим фактическим родителем; label с ` / ` не расщепляется; Сахалин создаёт verified structural inventory, продолжает R005→R001, сохраняет четыре контрольных блока и остаётся `READY=0` без утверждённого реестра.
- Реализация: outline хранится массивом атомарных сегментов и связывается точным identity ближайшего предшествующего фактического родителя меньшего уровня; допустимый gap помечается `outline_gap_collapsed` и входит в compact hierarchy/inventory SHA. Наименование с `/` не разбирается как путь. Реальный ведущий неродительский уровень без предшественника остаётся `ORPHAN_NODE`.
- Протокол проверки: focused outline/compact/wrapper `9/9 PASS`; полный R005 `231 PASS`, `0 FAIL`, `1` штатный skip. Реальный Сахалин `2025-01`: structural inventory v3 `VERIFIED`, blocker codes `0`, четыре расходных блока сохранены, финансовые строки `0`, статус по-прежнему безопасный `BLOCKED_PROFILE_REVIEW_REQUIRED` до пользовательского утверждения.

### R005-012 — Codex input не содержит обязательную связь с итоговым XLSX

- Дата: `28.08.2026`
- Статус: `IMPLEMENTED`
- Сообщил: packaged-EXE acceptance 9 УК за октябрь 2025.
- Наблюдаемое поведение: R005 формирует `VERIFIED` structural inventory v3 без blocker-кодов, но Service останавливает цепочку на `R005_INVENTORY`. Первый отказ `validateStructuralPlanCrossLinks`: в `reconciliation.codex-input.json` отсутствуют верхнеуровневые `output_path` и `output_sha256`, хотя manifest содержит корректную пару и все предыдущие проверки scope/SHA/provenance проходят.
- Ожидаемое поведение: Codex input и manifest оба связывают один и тот же итоговый XLSX точным каноническим путём и SHA-256 после финального изменения книги owner-wrapper; Service принимает current-run anchor и продолжает прямой R005→R001.
- Затронутые пункты контракта: §§3.1, 4–7, 10–14; A01–A04, A07, A10–A14.
- Допустимый scope: `opiu_reconcile.mjs`, `service_r005_owner_wrapper.mjs`, focused current-run cross-link tests; structural validator, финансовая логика, Rules Service и safety gates не ослабляются.
- Обязательный регрессионный тест: Codex input и manifest содержат одинаковые `output_path`/`output_sha256`; SHA соответствует финальной книге; Codex SHA в manifest соответствует финальному Codex input; UK и Сахалин проходят current-run anchor, а stale/missing/wrong path/SHA блокируются.
- Реализация: core создаёт обе пары `report_*`/`output_*`; owner-wrapper после финального изменения XLSX повторно вычисляет SHA и атомарно перепривязывает Codex input, затем вычисляет SHA Codex input и перепривязывает manifest. Только после этого материализуются inventory/binding; строгий Go-validator не изменён.
- Протокол проверки: helper/inventory regression `6/6 PASS`; полный R005 `231 PASS`, `0 FAIL`, `1` штатный skip; полный R001 `256/256 PASS`; полный Go service `PASS`. На реальном Сахалине Codex/manifest paths совпали с финальными файлами, обе report/output SHA совпали с фактическим XLSX, manifest Codex SHA совпал с фактическим Codex input; inventory v3 `VERIFIED` и `verification_blockers=[]`.

### R005-013 — Node и Go по-разному вычисляют SHA структурного инвентаря с `<пустое значение>`

- Дата: `28.08.2026`
- Статус: `IMPLEMENTED`
- Сообщил: независимый packaged-EXE acceptance 9 УК за ноябрь и 3 Сахалин за январь.
- Наблюдаемое поведение: R005 создаёт structural inventory v3 со статусом `VERIFIED`, но Service блокирует его как `member digest mismatch`. JavaScript сохраняет символы `<` и `>` в canonical JSON, а Go `encoding/json` по умолчанию кодирует их как `\u003c` и `\u003e`; одинаковый member `<пустое значение>` получает разные SHA-256.
- Ожидаемое поведение: Node и Go вычисляют один SHA-256 для одного canonical JSON независимо от наличия HTML-символов; фактическое изменение member по-прежнему блокируется.
- Затронутые пункты контракта: §§4–6, 10–14; A01–A04, A10–A14.
- Допустимый scope: Go canonical JSON helper и focused regressions; hierarchy, authority, Rules Service, финансовая логика и safety gates не меняются.
- Обязательный регрессионный тест: member с `<пустое значение>` проходит JS↔Go SHA и v3 anchor; изменение любого поля даёт digest mismatch; packaged UK November и Сахалин проходят `R005_INVENTORY`.
- Реализация: Go canonical JSON encoder использует `SetEscapeHTML(false)` и нормализует ровно один завершающий перевод строки, совпадая с Node для `<пустое значение>`; изменение member по-прежнему приводит к digest mismatch.
- Протокол проверки: независимый Node↔Go SHA для `<пустое значение>` — `19B235E5449644998949069786D5056E5DE3474F1A150128022BD74724253ABB`; focused parity/tamper `-count=3` PASS; полный R005 `238 PASS`, `0 FAIL`, `1` штатный skip; Windows amd64 test compile PASS.

### R005-014 — Service manifest и R005 используют разные источники настройки группировки

- Дата: `28.08.2026`
- Статус: `IMPLEMENTED`
- Сообщил: независимый packaged-EXE acceptance 9 УК за октябрь.
- Наблюдаемое поведение: Service фиксирует в run manifest `NO_ACTIVE_UI_FIXED_SETS/0`, но owner-wrapper без переданного settings-файла самостоятельно применяет пакетный CSV как `ACTIVE_EXACT_ORGANIZATION_MONTH/1`. Проверка proof закономерно блокирует несовпадающие authorities до R001.
- Ожидаемое поведение: Service manifest, фактический аргумент R005 и Codex proof описывают один и тот же неизменяемый источник настройки; скрытый fallback не может изменить authority после фиксации manifest.
- Затронутые пункты контракта: §§4–6, 10–14; A01–A04, A09–A14.
- Допустимый scope: exact materialization/argument/binding path настройки structural control и focused regressions; экономические суммы, Rules Service, корректировки и safety validators не ослабляются.
- Обязательный регрессионный тест: отсутствие активной UI-версии сохраняет один default state без неявного применения CSV либо пакетный CSV заранее материализуется и точно привязывается Service; active exact-scope версия остаётся единственной authority; drift/mismatch блокируется; packaged October проходит `R005_PROOF` и запускает R001.
- Реализация: Service заранее копирует CSV в private run-dir, материализует канонический settings JSON и отдельный semantic verifier artifact, связывает их exact path/SHA/size в immutable manifest и передаёт wrapper явный `service-json`. Wrapper не использует скрытый fallback в Service-режиме. Exact `service-none` фиксирует отсутствие настроек. Proof требует совпадение канонической семантики CSV, settings/verifier SHA и ровно один уникальный безопасный control result на каждый активный set; missing/duplicate/foreign/tampered данные блокируются. Чтение bounded, handle-stable и reparse-aware.
- Протокол проверки: scoped focused Go `11/11 PASS`; wrapper syntax и `7/7 PASS`; same-count tamper `name/member/split/id`, неверный selection path, missing/duplicate/foreign result и неверный service-none отклоняются; полный R005 `238 PASS`, `0 FAIL`, `1` штатный skip; полный R001 `256/256 PASS`; independent focused Go `-count=3` и Windows amd64 compile PASS; `git diff --check` PASS. Path-sensitive baseline-тесты в sandbox отдельно блокируются системным `EvalSymlinks: Access is denied` до вызова R005-014 и повторяются в package-smoke на чистом коротком пути.

### UI-006 — двойной щелчок молча закрывает OPIU, если порт занят чужим процессом

- Дата: `28.08.2026`
- Статус: `IMPLEMENTED`
- Сообщил: пользовательский запуск переносимого `OPIU_R17.exe` из `C:\OPIU_R17_TEST\OPIU_R17\OPIU_R17`.
- Наблюдаемое поведение: окно запуска появляется и сразу закрывается. Runtime-журнал фиксирует, что `127.0.0.1:8765` занят чужим `HAT\.hat-runtime\python.exe`, PID `23636`; OPIU безопасно не завершает чужой процесс, но пользователь не видит причины и пути к журналу.
- Ожидаемое поведение: доказанный старый OPIU завершается и освобождает точный endpoint; чужой владелец порта никогда не завершается. Если точный порт безопасно освободить нельзя, запуск останавливается с устойчивым понятным окном, в котором указаны endpoint, PID, executable и журнал диагностики.
- Затронутые пункты контракта: §§11, 13–14; UI-001, UI-002; A13–A14, A16.
- Допустимый scope: Windows startup/fatal UX и focused integration test; правила определения/завершения владельца endpoint, финансовая логика, R005/R001 и REPORT_ONLY safety не ослабляются.
- Обязательный регрессионный тест: чужой процесс занимает exact endpoint; OPIU не завершает его, возвращает ошибку с PID/path/journal и показывает устойчивый пользовательский диалог. Доказанный предыдущий OPIU по-прежнему корректно завершается; свободный порт запускается штатно; panic главного startup-потока также не закрывается без объяснения.
- Реализация: строгая проверка exact endpoint и владельца сохранена: завершается только повторно подтверждённый OPIU с безопасным health и process identity; чужой процесс блокирует запуск и остаётся жив. Все контролируемые fatal-ошибки и panic главного startup-потока дополнительно показываются через системный Windows-диалог с первопричиной и журналом. HTTP panic обрабатывается middleware внутри продолжающего работать сервиса и не открывает системный startup-диалог.
- Протокол проверки: focused Go `TestFatalServiceUserMessage*` — `2/2 PASS`; S06 foreign/unsafe owner, exact health и old-OPIU replacement regressions входят в обязательный полный Windows прогон. Полный package-smoke ожидается.

### TEST-002 — S06 cleanup бесконечно ожидает helper после отказа taskkill

- Дата: `28.08.2026`
- Статус: `IMPLEMENTED`
- Наблюдаемое поведение: в ограниченной Windows-среде `taskkill /T /F` возвращает `Access denied`, после чего cleanup теста безусловно вызывает `command.Wait()` и полный Go-набор зависает до внешнего тайм-аута.
- Ожидаемое поведение: ошибка завершения остаётся явным FAIL, но cleanup никогда не вызывает неограниченный `Wait()` для живого процесса.
- Затронутые пункты контракта: §11; UI-001, UI-002; A13–A16.
- Допустимый scope: только тестовая обвязка S06; продуктовая идентификация владельца, fail-closed и запрет завершения чужого процесса не меняются.
- Реализация: после неудачного `terminateProcessTree` ожидание не запускается; после успешного завершения `Wait()` ограничен двумя секундами. Добавлены прямые регрессии обоих путей.
- Протокол проверки: focused Go `TestS06FixHelperCleanup*` — `2/2 PASS`; `gofmt` и `git diff --check` — PASS. Полный Windows package build ожидается.

### PACK-002 — synthetic executable может зависнуть до включения subprocess timeout

- Дата: `28.08.2026`
- Статус: `IMPLEMENTED`
- Наблюдаемое поведение: Windows зависает внутри `CreateProcess` на 14-байтовом synthetic `node.exe`; `subprocess.run(timeout=2)` ещё не успевает начать отсчёт.
- Ожидаемое поведение: переносимый verifier до запуска fail-closed проверяет, что Node и Service являются исполняемыми Windows amd64 PE, а ошибки запуска сервиса имеют отдельный понятный код.
- Затронутые пункты контракта: §§11, 13–14; A13–A16.
- Допустимый scope: verifier и его тест; состав пакета и продуктовая финансовая логика не меняются.
- Реализация: добавлена bounded header-only проверка DOS/PE, AMD64, PE32+, полного optional header и таблицы секций, executable и not-DLL; неверный файл отклоняется до `CreateProcess`. Ошибка `Popen` нормализуется как `SMOKE_SERVICE_START_FAILED`.
- Протокол проверки: packaging verifier `47 PASS`, `1` штатный skip; portable builder `35 PASS`, `1` штатный skip; обрезанные PE отклонены, настоящий pinned Node принят. Real-package relocation smoke ожидается.

### WINPROC-001 — безопасная замена старого OPIU зависит от внешнего `taskkill`

- Дата: `28.08.2026`
- Статус: `IMPLEMENTED`
- Сообщил: Windows package-build/S06 acceptance exact HEAD `c97fcb3`.
- Наблюдаемое поведение: внешний `taskkill /T /F /PID` возвращает `Access denied` даже для helper, созданного самим S06-тестом. Доказанный старый OPIU не завершается, быстрый перезапуск и build-test блокируются; helper-процессы могут остаться живы.
- Ожидаемое поведение: Windows-завершение не зависит от `taskkill`/`tasklist`. Toolhelp-snapshot фиксирует точные PID корня и потомков; до первого изменения все доступные handles открываются, повторно идентифицируются и связываются по creation-lineage. После повторного preflight-snapshot проверенный root-handle завершается первым, чтобы остановить создание новых потомков; остальные handle-bound потомки завершаются от глубоких к ближним. Повторные snapshots доводят замыкание поздних потомков до пустого под одним общим deadline. Любая ошибка snapshot/access/identity/lineage/terminate/wait видимо блокирует операцию. Поиск и завершение по имени запрещены.
- Затронутые пункты контракта: §§11, 13–14; UI-001, UI-002; A13–A16.
- Допустимый scope: `service/source/port_owner_windows.go`, общая process-owner обвязка только при необходимости, focused Windows-тесты и этот реестр. Non-Windows поведение, R005/R001, финансовые правила, packaging и REPORT_ONLY safety не меняются.
- Обязательный регрессионный тест: root получает terminate-request первым, затем потомки deepest-first; поздний child находится вторым snapshot; для всего дерева действует один deadline; preflight access/identity/lineage failure даёт ноль terminate-calls; `Access denied` после TerminateProcess допустим только для уже signaled того же handle; exact child завершается, handles закрыты; rapid triple restart оставляет ровно один новый listener; foreign owner остаётся жив.
- Реализация: Windows-путь завершения переведён с `taskkill`/`tasklist` на прямые Win32 API `CreateToolhelp32Snapshot`, `OpenProcess`, `QueryFullProcessImageNameW`, `GetProcessTimes`, `TerminateProcess` и `WaitForSingleObject`. До первого terminate-call все достижимые PID открываются с terminate/query/synchronize rights, дважды идентифицируются и проверяются по creation-lineage; повторный preflight-snapshot закрывает race. Verified root-handle получает terminate-request первым, остальные handles — deepest-first; поздние потомки повторно собираются до пустого замыкания под одним трёхсекундным deadline. Все destructive/wait calls идут только по уже удерживаемым exact handles; name-wide completion отсутствует. Non-Windows файл не изменён.
- Протокол проверки: deterministic WINPROC root/order/late-child/access-denied/lineage/deadline/handle-close — `7/7 PASS`; реальные Windows exact-process/identity-drift/verified-replacement/foreign-owner/rapid-triple/root-child-grandchild — `7/7 PASS`. `gofmt`, compile и `git diff --check` — `PASS`. Полный Go-набор в длинном checkout запущен: WINPROC/S06 падений нет; остались внеобластные baseline-падения canonical structural inventory и missing `jszip`, поэтому полный repository PASS не объявляется.

### PACK-003 — Git-bound test tree не содержит проверенный `node_modules`

- Дата: `28.08.2026`
- Статус: `IMPLEMENTED`
- Сообщил: полный Go-прогон portable builder после WINPROC-001.
- Наблюдаемое поведение: builder извлекает во временное дерево exact Git sources для Go tests, но не материализует рядом обязательный shared `node_modules`; cross-runtime тесты завершаются ошибкой `shared verified node_modules payload is missing`/missing `jszip`, хотя `--node-modules` уже прошёл точную inventory-проверку.
- Ожидаемое поведение: только на время `go test` проверенный pinned `node_modules` материализуется в точном временном repository topology, сеть остаётся выключенной, исходный Git/source inventory не меняется, а в portable ZIP dependency попадает ровно один раз по каноническому `runtime/node_modules` path.
- Затронутые пункты контракта: §§1, 13–14, 16; A13–A15.
- Допустимый scope: `build_r17_portable.py`, test-staging `build_clean_source_service_candidate.py`, focused packaging tests и этот реестр. Production Go/JS, финансовая логика, Rules Service, package policy и REPORT_ONLY safety не меняются.
- Обязательный регрессионный тест: verified modules доступны по временному shared-root path во время Go test, отсутствуют при deterministic Go builds и вне test topology; collision/unsafe input блокируются; staging не меняет service source inventory и не создаёт второй packaged `node_modules`.
- Реализация: portable builder передаёт уже policy-проверенный `--node-modules` и его exact inventory в общий Go test-staging. Перед `go test` payload физически копируется только в sibling `node_modules` временного Git-bound topology, сверяется по `file_count=294`, `total_size=50570254`, `inventory_sha256=9A31C6F4FCCA4DDDB93DFC1E50DC06B03F2EBAB5B7575DDF7EF6CCE5502F1059`, повторно сверяется после теста и удаляется до обоих deterministic Go builds. Collision, reparse/unsafe input и любой post-test tamper блокируются fail-closed; исходный service inventory и канонический package stage не меняются.
- Протокол проверки: focused staging/collision/tamper/reparse/propagation `5/5 PASS`; оба затронутых packaging-файла `55 PASS`, `1` штатный Windows skip; Python compile и `git diff --check` — `PASS`. A/B package build не запускался.

### UI-007 — загрузка зависает, а иерархия организаций недоступна в TEST-пакете

- Дата: `28.08.2026`
- Статус: `IMPLEMENTED`
- Сообщил: пользовательский запуск TEST-пакета с ERP и Инталев ZIP.
- Наблюдаемое поведение: после нажатия «Загрузить файлы» интерфейс долго остаётся в состоянии «Загружаем файлы…» и не даёт продолжить; выбор организации показывает «Иерархия организаций недоступна». ERP-файл фактически зарегистрирован за `34 ms`, но второй POST не начался. Запущенный TEST runtime не подключён, потому что в emergency-пакете отсутствует обязательный `runtime/SAFETY.json`. Одновременно `refresh()` и диагностика каждые три секунды создают параллельные `/api/bootstrap` и `/api/runs`; каждый запрос повторно проверяет всю историю из 57 запусков, а UI повторно загружает результаты каждого запуска.
- Ожидаемое поведение: переносимый пакет всегда содержит и проверяет канонический `runtime/SAFETY.json`; runtime и каталог организаций подключаются fail-closed. Загрузка ERP и Инталев завершается последовательно с понятным прогрессом. В один момент выполняется не более одного refresh/diagnostics-запроса; исторические результаты загружаются лениво и не блокируют форму.
- Затронутые пункты контракта: §§3.1, 4.2, 11, 13–14; A01, A03, A10, A13–A14, A16. Финансовая логика R005/R001 и `REPORT_ONLY` не меняются.
- Допустимый scope: package staging/verifier для `runtime/SAFETY.json`; autodiscovery exact portable Node/runtime; single-flight UI refresh, polling и lazy results; bounded bootstrap/history; логирование и focused regressions. Клиентские источники и ранее созданные результаты не удаляются.
- Обязательный регрессионный тест: TEST ZIP содержит канонический `runtime/SAFETY.json` с ожидаемым SHA; запуск из нового короткого пути даёт `/api/health=200` и `/api/organizations=200` с верхними организациями; два выбранных ZIP дают два успешных POST и статус «Файлы загружены»; одновременно нет более одного `/api/bootstrap` и `/api/runs`; начальная форма становится доступна без полного чтения всех исторических результатов.
- Реализация: portable builder материализует канонический `runtime/SAFETY.json`, independent verifier требует его точные bytes/size/SHA. Service подключает только соседний portable runtime и каталог организаций fail-closed; bootstrap ограничивает тяжёлую проекцию истории, а полные результаты подгружаются только по запросу пользователя. UI выполняет ERP и Инталев upload последовательно с отдельными стадиями и использует single-flight refresh без параллельного polling.
- Протокол проверки: packaging `86 PASS`, `2` штатных skip; focused UI-007 `4/4 PASS`; полный web-набор вместе с UI-009 `54/54 PASS`; Go runtime/catalog и structural-control targeted tests, `go vet`, Windows build и `git diff --check` — PASS. Итоговый relocation package-smoke выполняется на TEST3.

### UI-008 — выбор организации показывает всю вложенную иерархию вместо верхнего уровня

- Дата: `28.08.2026`
- Статус: `IMPLEMENTED`
- Сообщил: пользовательская проверка TEST2 после восстановления каталога организаций.
- Наблюдаемое поведение: `/api/organizations` возвращает 592 узла и помечает selectable все 592, хотя верхнеуровневых организаций только 13. В списке выбора смешиваются `1 Хабаровск`, `3 Сахалин`, `9 Управляющая компания` и их дочерние подразделения.
- Ожидаемое поведение: каталог и полный путь сохраняются целиком, но в поле «Организация» доступны только фактические узлы верхнего уровня (`depth=0`); выбранный ID/name/path по-прежнему точны.
- Затронутые пункты контракта: §§3.1, 4.2, 11, 14; A01, A03, A10, A13–A14.
- Обязательный регрессионный тест: authoritative каталог содержит 592 узла, API сохраняет полные пути, но selectable=true ровно у 13 узлов depth=0; контрольные `1 Хабаровск`, `3 Сахалин`, `9 Управляющая компания` выбираются, дочерний узел не выбирается.
- Реализация: authoritative каталог и `/api/organizations` сохраняют все `592` узла и exact path. Только `13` узлов `depth=0` получают `selectable=true`; вложенные узлы сохраняются для иерархии, но `CreateContext` отклоняет их как область сверки.
- Протокол проверки: focused root/catalog/context `-count=3` PASS; расширенный `Organization|EmptyArticleBinding`, `go vet` и `git diff --check` — PASS. Контрольные верхние организации присутствуют, дочерняя организация сохраняет путь и не получает selection authority.

### UI-009 — статус запуска остаётся `QUEUED` после фактического завершения

- Дата: `28.08.2026`
- Статус: `IMPLEMENTED`
- Сообщил: пользовательский прогон 9 Управляющей компании за 2025-10.
- Наблюдаемое поведение: под кнопкой остаётся «Запуск QUEUED», хотя API уже содержит конечный `BLOCKED_STRUCTURAL_INVENTORY` и время завершения; пользователь не понимает, идёт расчёт или нет. Повторное нажатие создало второй дублирующий запуск.
- Ожидаемое поведение: один активный запуск показывает понятные этапы `В очереди → R005 → проверка структуры → R001 → готово` либо конечную блокировку с причиной и временем. Пока запуск активен, повторная кнопка отключена. После завершения устаревший `QUEUED` невозможен.
- Затронутые пункты контракта: §11; A13–A16.
- Обязательный регрессионный тест: после POST run UI получает run ID, отслеживает именно его, отключает повторный запуск, обновляет этап и конечный статус из bootstrap; BLOCKED показывает русскую причину и finished_at, READY показывает ссылку на результат; polling single-flight и завершается для terminal status.
- Реализация: UI сохраняет exact ID из ответа POST, опрашивает только `/api/runs/{id}` одним single-flight запросом, отключает повторный запуск до terminal status и переводит внутренние этапы в понятные русские статусы. В terminal состоянии polling прекращается; BLOCKED показывает причину и время, READY — устойчивую ссылку на результат.
- Протокол проверки: focused UI-007/UI-009 `8/8 PASS`; полный web-набор `54/54 PASS`; `node --check` и `git diff --check` — PASS. Итоговый runtime-smoke выполняется на TEST3.

### S10 — реальный Codex input превышает общий лимит 64 MiB

- Дата: `28.08.2026`
- Статус: `IMPLEMENTED`
- Сообщил: независимый real-run acceptance 9 УК и Сахалина перед сборкой TEST3.
- Наблюдаемое поведение: verified v3 inventory и binding SHA корректны, но Service отклоняет `reconciliation.codex-input.json` размером `67 730 152`–`67 750 010` байт из-за общего ограничения `64 MiB` и маскирует причину сообщением `artifact digest mismatch`.
- Ожидаемое поведение: полный доказательный Codex input до `128 MiB` принимается только после всех прежних SHA/cross-link проверок; файл свыше `128 MiB` блокируется. Лимиты manifest и XLSX не меняются.
- Затронутые пункты контракта: §§10–14; A01–A04, A07, A10–A14.
- Допустимый scope: два bounded-read лимита только для `reconciliation.codex-input.json`, focused boundary regressions и эта запись; финансовая логика, hierarchy, authority, manifest/report limits и safety gates не меняются.
- Реализация: введён отдельный `structuralControlCodexInputMaxBytes = 128 MiB` и применён в SHA-проверке current-run artifacts и cross-link JSON reader. Manifest сохраняет лимит `64 MiB`, отчёт — `1 GiB`. Ошибка bounded-read сохраняется через `%w` отдельно от SHA mismatch, поэтому превышение лимита больше не маскируется общей ошибкой digest/JSON.
- Протокол проверки: `64 MiB + 1` и exact `128 MiB` проходят полный SHA/cross-link validator; `128 MiB + 1` блокируется обеими проверками с сохранённой причиной `structural artifact is not a bounded regular file`; прежний manifest boundary не расширен. Focused `TestS10* -count=3`, structural artifact/inventory tests, `go vet` и `git diff --check` — PASS; изолированный validator трёх реальных runs после узкого изменения — PASS.

### UI-010 — подтверждённая старая группировка ошибочно считается повреждённой

- Дата: `28.08.2026`
- Статус: `IMPLEMENTED`
- Сообщил: пользовательский запуск TEST3, организация `9 Управляющая компания`, период `2025-10`.
- Наблюдаемое поведение: запуск `run_c64049f2fe200493d5d59d61` завершается на стадии `R005_SETTINGS` сообщением «Настройка группировки блоков недоступна или повреждена». Пакетный файл `user-settings/Настройка_группировки_блоков.csv` существует, имеет точные bytes/SHA из manifest и корректную UTF-8 кодировку, но до него выполнение не доходит: Go cross-link validator ошибочно требует поля manifest-роли `output_path` и `output_sha256` также у `reconciliation.codex-input.json`. Authoritative Codex input корректно содержит собственные role-specific поля `report_path` и `report_sha256`; manifest отдельно содержит `output_path`/`output_sha256` и точную привязку Codex artifact.
- Ожидаемое поведение: cross-link validator проверяет поля по роли документа: Codex input — только exact `report_path`/`report_sha256`, manifest — exact `output_path`/`output_sha256` и `codex_input_path`/`codex_input_sha256`. Организация, период, run/context, binding/inventory/artifact SHA и состав участников по-прежнему проверяются fail-closed; глобальная current-run anchor-проверка не ослабляется.
- Затронутые пункты контракта: §§4.2, 10–14; A01–A04, A07, A10–A14.
- Допустимый scope: role-specific cross-link validation, точная передача первопричины в pipeline message/log, focused regression и эта запись. Финансовая логика R005/R001, current-run anchor, authority и REPORT_ONLY safety не меняются.
- Обязательный регрессионный тест: Codex fixture без `output_*`, но с exact `report_path`/`report_sha256`, проходит; неверные либо подменённые role-specific path/SHA блокируются; manifest без exact `output_*` или Codex binding блокируется; прежний документ с обоими наборами полей продолжает проходить; pipeline показывает точную вложенную причину вместо общего сообщения о повреждении.
- Реализация: Go cross-link validator всегда проверяет role-specific поля: Codex input связывает exact отчёт через `report_path`/`report_sha256`, manifest связывает отчёт через `output_path`/`output_sha256` и отдельно exact Codex input. Специальные legacy/null исключения отсутствуют. Публичный код `STRUCTURAL_CONTROL_INVENTORY_UNVERIFIED` сохраняется в цепочке ошибки вместе с точной вложенной причиной; pipeline показывает только разрешённое понятное объяснение без путей и технических данных.
- Протокол проверки: focused `TestUI010* -count=3`, весь `TestStructuralControl`, `go vet` и `git diff --check` — PASS. Независимый review подтвердил exact role keys, отсутствие bypass и rejection подмен. Полный Go-набор остаётся FAIL из-за старых test fixtures без обязательных `report_*` и baseline missing `jszip`; TEST4 может иметь только статус `EMERGENCY_USER_TEST_ONLY`, release PASS не объявляется.

### UI-011 — R005 не принимает зафиксированную UI-группировку с типизированными путями

- Дата: `28.08.2026`
- Статус: `IMPLEMENTED`
- Сообщил: пользовательский запуск TEST4, `run_beae4114afe4291ec116ba73`, организация `9 Управляющая компания`, период `2025-10`.
- Наблюдаемое поведение: Service успешно материализует и привязывает одну активную UI-fixed группу, затем R005 завершается `BLOCKED_STRUCTURAL_CONTROL_SETTINGS_SOURCE_INVALID`. Go формирует `source.format=UI_FIXED_TYPED_SELECTOR_CSV_SEMICOLON_UTF8_V1` и CSV с раздельными колонками `Пути блоков Инталев`/`Пути блоков ERP`, а Node loader принимает только старый `BUSINESS_CSV_SEMICOLON_UTF8` и code-only заголовки. Простая замена строки формата не решает ошибку: старый CSV parser интерпретирует полные пути как набор кодов.
- Ожидаемое поведение: Node нативно и строго принимает UI-fixed typed-selector формат, проверяет точные пять заголовков, организацию, название, активность и упорядоченные пути обеих сторон, а затем связывает их с exact `hierarchy_path`, `origin_identity`, `origin_inventory_id` и code в уже материализованном JSON. Любое несовпадение format/header/path/member/binding/organization/period/SHA блокируется. Старые BUSINESS legacy/split форматы продолжают работать без изменения семантики.
- Затронутые пункты контракта: §§4.2, 10–14; A01–A04, A07, A10–A14.
- Допустимый scope: `modules/reconciliation/source/structural_control_settings_binding.mjs`, focused JS tests, безопасное отображение точной причины R005 в Service и эта запись. Финансовая логика, authority, current-run anchor, Go materializer и REPORT_ONLY safety не меняются.
- Обязательный регрессионный тест: реальная форма UI-fixed JSON+CSV проходит и сохраняет exact typed bindings; подмена формата, любого заголовка, пути, identity/inventory/code, SHA/size или scope блокируется; перестановка/дублирование/пересечение членов блокируется; BUSINESS legacy и split fixtures остаются PASS; run больше не завершается `SOURCE_INVALID` и доходит дальше стадии чтения structural settings. Пользователь видит точную безопасную причину R005 без раскрытия локальных путей.
- Реализация: восстановлена строгая ветка `UI_FIXED_TYPED_SELECTOR_CSV_SEMICOLON_UTF8_V1` с повторной проверкой CSV, registry, lifecycle/latest FIXED, exact scope и member bindings; полный scope передаётся из R005, активные typed selectors повторно связываются с текущей иерархией, а enriched audit попадает в Codex input и manifest. Service показывает разрешённую точную причину structural-settings blocker без локального пути.
- Протокол проверки: focused Node — 10/10 PASS; focused Go message mapping `-count=3` — PASS; `node --check` и `git diff --check` — PASS; независимый review — PASS. Точный повтор R005 для исходного `run_beae...` из production cwd завершился exit 0, создал XLSX/Codex input/manifest и verified inventory; `posting_rows=0`, `financial_rows=0`, `ready_to_upload=false`, `REPORT_ONLY`.

### UI-012 — Переносимый R005 ищет канонический справочник относительно рабочего каталога процесса

- Дата: `28.08.2026`
- Статус: `CLOSED_HARNESS_ONLY`
- Обнаружено: контрольный повтор `run_beae4114afe4291ec116ba73` после устранения UI-011 прошёл строгую проверку UI-fixed settings и остановился позже с `BLOCKED_REFERENCE_CATALOG_MANIFEST_MISSING`.
- Наблюдаемое поведение: `reference_catalog_manifest_path=reference_catalog_manifest.current.json` разрешается через текущий рабочий каталог процесса и указывает на прежнюю workspace-папку, а не на неизменяемый каталог установленного runtime. Переносимый пакет поэтому зависит от каталога, из которого его запустили.
- Ожидаемое поведение: относительный путь канонического manifest разрешается только относительно доверенного packaged runtime/source root; сам manifest и все перечисленные неклиентские справочники обязательно включены в ZIP/Setup и проверяются по точным size/SHA до R005. Абсолютный workspace fallback и молчаливое ослабление проверки запрещены.
- Затронутые пункты контракта: §§3.1, 4.2, 10–14; A01–A04, A10–A16.
- Допустимый scope: resolver/loader канонического reference manifest, package allowlist/manifest/verifier и focused relocation tests. Финансовая логика, пользовательские данные и REPORT_ONLY safety не меняются.
- Обязательный регрессионный тест: один и тот же пакет запускается из двух произвольных рабочих каталогов и использует один exact bundled manifest; отсутствующий, внешний, подменённый либо не совпадающий по SHA manifest/член блокируется с безопасной точной причиной; package inventory подтверждает все обязательные файлы; исходный `run_beae...` проходит эту стадию без чтения workspace-пути.
- Закрытие: продуктовый дефект не подтвердился. Service штатно задаёт child cwd равным каталогу runtime-модуля, где находится exact bundled manifest; независимая проверка подтвердила 8 ролей, SHA manifest и всех 7 присутствующих справочников, а `intalev_uid` остаётся явно объявленным отсутствующим. Ошибка воспроизводилась только в ручном harness, запущенном из workspace cwd. Повтор с production cwd прошёл manifest stage и полностью сформировал безопасный R005-комплект. Код продукта и пакет по UI-012 не менялись.

### UI-013 — аварийно прерванный запуск навсегда остаётся `RUNNING`

- Дата: `29.08.2026`
- Статус: `IMPLEMENTED`
- Сообщил: пользовательская проверка TEST5, запуск `run_611763c01a9cc0ef3cf3673d`, организация `9 Управляющая компания`, период `2025-11`.
- Наблюдаемое поведение: временный staging-экземпляр Service был завершён извне во время R005. Сервис исчез без штатного shutdown/crash-события, а сохранённый запуск остался `RUNNING / R005` без `finished_at`. R005 успел создать промежуточный XLSX и inspect NDJSON, но не создал Codex input, manifest, structural proof, handoff или R001. Браузер показал потерю соединения и при последующем открытии не получил терминального объяснения.
- Ожидаемое поведение: после запуска нового экземпляра Service все сохранённые `QUEUED`, `PREFLIGHT` и `RUNNING`, принадлежавшие уже завершившемуся процессу, одной записью под durable lock переводятся в терминальный `FAILED / INTERRUPTED_SERVICE_RESTART` с понятным русским сообщением и временем завершения. Промежуточный XLSX или иной неполный артефакт не считается готовым результатом. Уже терминальные запуски не изменяются.
- Доказательство: `service-runtime.log` содержит `SERVICE_START pid=25384` и успешный polling exact run до `29.08.2026 05:59:51.593`, после чего обрывается без `Завершение текущего OPIU`, `SERVICE_STOP`, `FATAL` или `PANIC`; `service-crash.log` и Windows Application/System не содержат соответствующего crash-события. State остаётся `RUNNING`, тогда как промежуточный XLSX записан позже, в `05:59:55.365`, без обязательных proof/handoff-файлов. Runtime-path указывает на staging `C:\O\R17T5\...`, а не на установленный `C:\OPIU_R17_TEST5`.
- Затронутые пункты контракта: §§11, 13–14; A13–A16. Режим `REPORT_ONLY` и запрет признания неполного результата готовым сохраняются.
- Допустимый scope: `service/source/store.go`, focused `store_test.go` и эта запись. Lifecycle/port logic, R005/R001, финансовая логика, web UI и упаковка не меняются.
- Обязательный регрессионный тест: persisted `QUEUED`, `PREFLIGHT` и `RUNNING` при `OpenStore` становятся `FAILED / INTERRUPTED_SERVICE_RESTART`, получают непустое `finished_at`, а даже подменённый safety нормализуется к точному `REPORT_ONLY`; completed/blocked/failed остаются побайтово эквивалентны по бизнес-полям; наличие orphan XLSX не повышает статус; второе открытие хранилища идемпотентно; `hasActiveRuns=false`.
- Реализация: `OpenStore` под существующей durable-state блокировкой одним сохранением переводит только прежние `QUEUED`, `PREFLIGHT` и `RUNNING` в `FAILED / INTERRUPTED_SERVICE_RESTART`, ставит единое UTC-время завершения, понятное русское сообщение и точный безопасный `REPORT_ONLY`. Остальные поля сохраняются; каталоги запуска не сканируются, поэтому orphan XLSX не получает статуса готового результата. Повторное открытие идемпотентно.
- Протокол проверки: focused recovery с подменённым unsafe-safety `-count=10` — PASS; recovery вместе с R001/R005 result guards `-count=3` — PASS; расширенный Store/OpenStore набор — PASS; `go vet ./...` и `git diff --check` — PASS. Независимая итоговая проверка и проверка собранного PATCH1 выполняются отдельно до передачи пользователю.

### UI-014 — доказанный R005 отклоняется при привязке большого Codex input

- Дата: `29.08.2026`
- Статус: `IMPLEMENTED`
- Сообщил: пользовательский запуск TEST5/PATCH1, `run_52ccff541b18b667ae472743`, организация `9 Управляющая компания`, период `2025-10`.
- Наблюдаемое поведение: R005 успешно сформировал отчёт и `structural-control-proof.json` со статусом `ACTIVE_VERIFIED`, одной применённой группой и закрытой безопасностью, но Service завершил запуск на стадии `R005_PROOF` сообщением «R005 не подтвердил применённую настройку группировки блоков». Файл `structural-control-proof.binding.json` не создан.
- Ожидаемое поведение: доказанный `reconciliation.codex-input.json` принимается в proof-binding с тем же отдельным пределом `128 MiB`, который уже действует для его проверенной инвентаризации. Общий лимит JSON-настроек `4 MiB` применяется только к малым settings/proof JSON и не отклоняет точный Codex input. Файл свыше `128 MiB`, произвольный большой JSON, подмена SHA/scope и небезопасная authority по-прежнему блокируются fail-closed.
- Доказательство: Codex input запуска имеет размер `65 735 058` байт и SHA-256 `7EF680354DC82FCB68E94C4A6716B02C345F0A2641ADE40219A0FC367E7D98C2`. `materializeStructuralControlProof` записал proof, затем `structuralControlManifestArtifact` ошибочно применил к exact `reconciliation.codex-input.json` `structuralControlSettingsJSONMaxBytes = 4 MiB`; выполнение остановилось до записи binding. Scope run/context/organization/period, settings/CSV/registry/version SHA и REPORT_ONLY совпадают.
- Затронутые пункты контракта: §§10–14; A01–A04, A07, A10–A14. Финансовая логика и режим `REPORT_ONLY` не меняются.
- Допустимый scope: role-aware bounded read в `service/source/structural_control_proof_pipeline.go`, focused Go-регрессии и эта запись. R005/R001 JS, бизнес-правила групп, authority, package policy и пользовательские данные не меняются.
- Обязательный регрессионный тест: exact `reconciliation.codex-input.json` размером больше `4 MiB`, но не больше `128 MiB`, проходит materialize/verify и создаёт immutable proof binding; размер `128 MiB + 1` блокируется; произвольный JSON больше `4 MiB` остаётся заблокирован; неправильные SHA/scope/safety остаются заблокированы.
- Реализация: proof pipeline назначает предел `128 MiB` только точной run-owned роли `r005/reconciliation.codex-input.json`; совпавшее имя в другой подпапке остаётся под пределом `4 MiB`. Materialize и повторная verify читают Codex input сразу через bounded secure reader, поэтому файл свыше `128 MiB` не загружается и не разбирается до блокировки. CSV и остальные JSON-лимиты не расширены.
- Протокол проверки: focused materialize/binding/verify и прежняя immutable chain с `-count=3` — PASS; расширенный `TestStructuralControl|TestUI014` — PASS; `go vet ./...` и `git diff --check` — PASS. Полный Go-набор остаётся FAIL на ранее зафиксированных внеобластных approval/fixture и missing `jszip` baseline; новых UI-014 падений нет. Независимый review точного role/path и bounded-read — PASS. Сборка и SHA PATCH2 фиксируются отдельно.

### R005-015 — временный workDir удаляет физический ERP-журнал до handoff R005→R001

- Дата: `29.08.2026`
- Статус: `IMPLEMENTED`
- Сообщил: пользовательский запуск `run_9305f613983d686179da2d7d`, организация `9 Управляющая компания`, период `2025-10`.
- Наблюдаемое поведение: R005 успешно создаёт reconciliation package, Codex input, manifest, inventory, structural proof и proof binding, но физический ERP-журнал остаётся в `workDir` reconciliation. После завершения R005 движок удаляет временный `workDir`; Service формирует R005→R001 handoff по сохранённому пути журнала, получает отсутствие файла на стадии `R005_HANDOFF`, и R001 не запускается.
- Ожидаемое поведение: до удаления временного `workDir` создаётся точная проверенная immutable-копия физического ERP-журнала в каталоге конкретного Service run. Handoff и R001 используют только эту persistent run-owned копию; при повторной проверке подтверждаются существование файла, точный лист, SHA-256, связь с тем же run/scope и отсутствие подмены исходного proof.
- Доказательство / файл / скриншот: проблемный run `run_9305f613983d686179da2d7d`; `modules/reconciliation/source/opiu_reconcile.mjs` удаляет `workDir` после `buildReportWorkbook`, а `service/source/r001_service_handoff.go` строит `physical_evidence.erp_journal` из старого пути и проверяет его только после удаления.
- Затронутые пункты контракта: §§1, 3.1, 4.2, 6, 8.1, 10–14; A05–A07, A10–A15. Режим `REPORT_ONLY` и запрет загрузки/проведения в 1С сохраняются.
- Новое или уточнённое требование: физический ERP-журнал, использованный как доказательство, до удаления временного workDir атомарно фиксируется в immutable-каталоге конкретного Service run; downstream handoff не имеет права зависеть от временного пути и обязан повторно проверить exact sheet, size/SHA, run/scope и неизменность proof.
- Обязательный регрессионный тест: R005 создаёт физический журнал; Service фиксирует persistent immutable copy; временный R005 workDir удаляется; Service создаёт и повторно валидирует R005→R001 handoff; persistent journal доступен, exact sheet и SHA совпадают; R001 запускается. Подмена, неверный лист, scope drift, SHA drift и повторная перезапись блокируются.
- Реализация: перед `buildReportWorkbook` R005 атомарно фиксирует проверенные байты ERP-журнала в `runDir/r005/physical-evidence/erp-journal.xlsx`, принимает существующую копию только при полном совпадении байтов и rebinding-ит доказательные пути с временного `workDir` на этот run-owned файл. Service handoff принимает только точный persistent path, проверяет regular file, размер/SHA-256 и фактический exact worksheet через OOXML workbook relationships; run/context/organization/period и REPORT_ONLY cross-checks сохранены. Финансовая математика, delta, группировки, matching, rules service и 1С не изменялись.
- Протокол проверки: до исправления добавленная lifecycle-регрессия ожидаемо FAIL на отсутствующем persistence export; после исправления Node lifecycle — PASS (1/1), релевантный R005/Service Node-набор — PASS 70, FAIL 0, SKIP 1 (существующий symlink regression получил `EPERM`). `node --check` и `git diff --check` — PASS. Go lifecycle/Service tests не выполнены: в окружении отсутствуют `go.exe` и `gofmt.exe`; это остаётся явным verification blocker, а не скрытым успехом.

- Диагностическое переоткрытие: `30.08.2026`, статус `REOPENED_REAL_CASE`. Новый запуск через реальный Service `run_fc6c5696503344d44d8f3f26`, context `ctx_e00f84a0320429dc543ddbf7`, организация `9 Управляющая компания` (`ERP-000000224`), период `2025-10`, завершён `FAILED / R005_HANDOFF`. R005 создал полный отчётный комплект и `structural-control-proof.binding.json`, но `r005/physical-evidence/erp-journal.xlsx` и `handoff/r005-r001-service-handoff.json` отсутствуют; R001 не запускался.
- Доказанная причина реального прогона: Service использовал фактически протестированный EXE `C:\OPIU_R17_TEST5\OPIU_R17_PATCH2.exe` (SHA-256 `BC5FC3024B4F7FB42C158F63CDF7AFF11C53D0DC0CDDDB295C1D115E5F50387B`), чей runtime `run_workdir.mjs` и `opiu_reconcile.mjs` совпадают с коммитом `d3a4eb2` и не содержат persistence export до удаления `workDir`. Пакет не содержит persistence implementation, введённую коммитом `701f2ee8`, завершённую на `45777c2`; текущий source fix уже смержен в `release/r17` через PR #1, но EXE/runtime не были пересобраны и не содержат этот commit. После удаления `C:\OPIU_R17_TEST5\runtime\modules\reconciliation\source\work\20260830T042903962Z_29552_5b0c20aa-aacc-4d0c-9244-d5f729ee2a52` R005 оставил в manifest/codex journal path на удалённый файл; `physicalEvidenceFromR005` передал его в `handoffJournal`, где `handoffArtifact` не нашёл файл и исходный error был `R005 physical ERP journal SHA-256 mismatch`. Service не сохранил этот raw error и показал только безопасное `R005_HANDOFF`-сообщение.
- Это подтверждает ранее зарегистрированный дефект и stale package/runtime, а не новый defect ID. Источник ZIP не изменялся; `REPORT_ONLY=true`, `rules_service=false`, `posting_rows=0`, no upload/posting to 1С сохранены.
- Повторная диагностика тем же реальным путём: `30.08.2026`, статус `CONFIRMED_REALCASE_STALE_RUNTIME`. Новый запуск `run_cd64739e3221c98754d2e970`, context `ctx_b6c2e99ba1c2ed24444543e0`, организация `9 Управляющая компания` (`ERP-000000224`), период `2025-10`, завершён `FAILED / R005_HANDOFF`; Service PID `6612`, фактически протестированный EXE `C:\OPIU_R17_TEST5\OPIU_R17_PATCH2.exe`, runtime `C:\OPIU_R17_TEST5\runtime`.
- Факты запуска: R005 создал `reconciliation.xlsx` SHA-256 `8716FCB9CD5E8333EC6638FC3823301B25902F7FBAD98CA35DF337AA1EE37FA5`, Codex input SHA-256 `5E8EF95A6A3EAAC77C792E8323B241B8EE2F3F830001A239982D3E200E199488`, manifest, inventory, inventory binding, structural proof и proof binding. Старый workDir `C:\OPIU_R17_TEST5\runtime\modules\reconciliation\source\work\20260830T055216966Z_35400_a9c53ad6-670c-479c-b960-d77ed0991f9d` удалён; journal path в R005 evidence указывает на удалённый файл с ожидаемым SHA-256 `1ECB8A056716810735C6D08B5C2CBED5AE9FAEB061CB5471455046B7210FC5CB`; persistent journal, handoff JSON и R001-артефакты отсутствуют.
- Точная причина подтверждена сопоставлением package/runtime с `d3a4eb2` и текущего `HEAD`: пакет не содержит persistence export/call из `701f2ee`. `materializeServiceR001Handoff` достигает `handoffJournal`; `handoffArtifact` не находит удалённый journal и возвращает raw guard error `R005 physical ERP journal SHA-256 mismatch`, после чего handoff не записывается и verifier/R001 не вызываются. В runtime-логах нового прогона raw exception не сохранён; безопасно отображён только `R005_HANDOFF`, поэтому raw текст зафиксирован как source-correlated guard error, а не как отдельная строка лога.
- Источник ZIP не изменялся; `REPORT_ONLY=true`, `rules_service=false`, `posting_rows=0`, `ready_to_upload=false`, `release_allowed=false`, `live_1c_allowed=false`, no upload/posting to 1С сохранены. Нового defect ID нет; запись подтверждает R005-015 и stale package/runtime.

### R005-020 — Service validator не принимает канонический R001 workbook `Сверка.xlsx`

- Дата: `30.08.2026`
- Статус: `IMPLEMENTED`
- Обнаружено: итоговый комбинированный source-Service QA-прогон `run_4d6b0a08a4c48b96687a1c88`, организация `9 Управляющая компания` (`ERP-000000224`), период `2025-10`, после R005-016…R005-019.
- Наблюдаемое поведение: R001 wrapper/core формирует полный безопасный комплект, включая `Сверка.xlsx`, но Service завершает `FAILED / R001` сообщением `R001 не сформировал полный безопасный диагностический комплект`; Go validator не считает `Сверка.xlsx` reconciliation workbook.
- Подтверждённая первопричина: общий `validateR001ReportOnlyPackage` уже проверяет manifest registry, SHA-256, OOXML и принимает root-level `Сверка.xlsx`/`reconciliation.xlsx`, но `validateR001ReportOnlyPackageForRun` при повторном чтении materialization audit отбрасывал проверенный registry path и жёстко открывал `packageDir/reconciliation.xlsx`. Поэтому зарегистрированный и прошедший integrity-проверки canonical `Сверка.xlsx` отклонялся только на run-scoped этапе.
- Ожидаемое поведение: Service принимает exact canonical `Сверка.xlsx` и сохраняет поддержку прежнего `reconciliation.xlsx`; missing/unregistered/invalid workbook, неверный SHA, unsafe path и zero-route loader workbooks остаются fail-closed.
- Затронутые пункты контракта: §§10–13; A01–A04, A10–A15.
- Обязательный регрессионный тест: package с `Сверка.xlsx` проходит текущие manifest/SHA/OOXML/safety checks; прежний `reconciliation.xlsx` проходит; отсутствующий/unsafe/loader case блокируется. Сквозной R005→R001 остаётся `REPORT_ONLY`, без posting/upload.
- Допустимый scope фикса: имя canonical reconciliation workbook в Go R001 package validator и focused regression; финансовая логика, BOM/OOXML validation, physical journal persistence, authority, R005/R001 semantics, rules service и 1С не меняются.
- Реализация: run-scoped validator получает reconciliation workbook только из уже проверенного `manifest.outputs`; детерминированно поддерживаются exact root-level `Сверка.xlsx` и backward-compatible `reconciliation.xlsx`, без filesystem scan и без выбора незарегистрированного файла. Общие manifest/SHA/path/OOXML/safety guards не ослаблены.
- Изменённые файлы: `service/source/fail_soft_report_package.go`, `service/source/fail_soft_report_package_test.go`, `contracts/ERROR_REGISTER.md` (только R005-020).
- Регрессионное доказательство: до production-фикса новый run-scoped `Сверка.xlsx` test воспроизвёл FAIL на hardcoded `reconciliation.xlsx`; после фикса 2 positive name cases, 6 negative path/registration/integrity/OOXML cases и существующий zero-route loader guard — PASS. Весь `fail_soft_report_package` — 30 PASS, 0 FAIL, 0 SKIP; `go test -count=1 ./...` — PASS, exit `0`; `go vet ./...` — PASS, exit `0`; service/web Node — 21 PASS; полный R001 Node — 263 PASS; полный R005 Node — 242 PASS, 0 FAIL, 1 штатный external-golden SKIP; production JS/MJS syntax — 99 PASS; `git diff --check` — PASS.
- Implementation commit: `9e707450d55b1b87e6e5a14dbcf3de9c95f92939`. Ветка `fix/r005-service-canonical-sverka-run-validator`; merge/release запрещены до coordinator review.

### R005-019 — Service validator не принимает канонический R001 workbook `Решения.xlsx`

- Дата: `30.08.2026`
- Статус: `OPEN_FIX_PR`
- Обнаружено: комбинированный source-Service QA-прогон после R005-016, R005-017 и R005-018, `run_9daeafe1b19f1c08f05cc52f`, организация `9 Управляющая компания` (`ERP-000000224`), период `2025-10`.
- Наблюдаемое поведение: R001 wrapper принимает handoff и core формирует пять безопасных XLSX/manifest, но Service завершает `FAILED / R001` сообщением `R001 не сформировал полный безопасный диагностический комплект`; полный R001 output package отвергнут Go validator.
- Доказательство: R001 `technical/manifest.json` регистрирует `Решения.xlsx`, два `РЕЕСТР/*.xlsx`, `Сверка.xlsx` и `УДАЛЕНИЕ/*.xlsx`; `validateR001ReportOnlyPackage` ищет только имя, содержащее `решения_корректировок_ввод_r001`, поэтому реальный canonical `Решения.xlsx` не засчитывается как decision workbook. R001 core сам завершил с `posting_rows=0`, `materialized_posting_rows=0`, `execution_allowed=false`, `ready_to_upload=false`, `release_allowed=false`, `live_1c_allowed=false`.
- Ожидаемое поведение: Service принимает ровно зарегистрированный canonical R001 decision workbook `Решения.xlsx` и сохраняет поддержку прежнего безопасного имени; отсутствующий/не-XLSX/не зарегистрированный decision workbook, неверный SHA, unsafe output path или loader workbook при zero-route по-прежнему блокируются.
- Затронутые пункты контракта: §§10–13; A01–A04, A10–A15.
- Обязательный регрессионный тест: package с `Решения.xlsx` проходит все текущие manifest/SHA/OOXML/safety checks; прежний synthetic long name проходит; missing/unsafe/loader cases остаются fail-closed. Сквозной R005→R001 остаётся `REPORT_ONLY`, без posting/upload.
- Допустимый scope фикса: имя canonical decision workbook в Go R001 package validator и focused regression; финансовая логика, BOM/OOXML validation, physical journal persistence, authority, R005/R001 semantics, rules service и 1С не меняются.
- Регрессионная фиксация: независимая ветка `fix/r001-canonical-decision-workbook-name`, отдельный Issue/PR; merge/release запрещены до coordinator review.

### R005-018 — R001 wrapper неверно разрешает relative proof-binding paths

- Дата: `30.08.2026`
- Статус: `OPEN_FIX_PR`
- Обнаружено: комбинированный source-Service QA-прогон после R005-016 и R005-017, `run_c4230052d9062afcc9edf98f`, организация `9 Управляющая компания` (`ERP-000000224`), период `2025-10`.
- Наблюдаемое поведение: R005, persistent journal и Go handoff успешно завершены; R001 wrapper отклоняет корректный proof binding с `SERVICE_HANDOFF_STRUCTURAL_PROOF_BINDING_MISMATCH` на относительных путях `r005/reconciliation.codex-input.json` и `r005/structural-control-proof.json`.
- Доказательство: Go `materializeStructuralControlProof` формирует proof-binding с canonical run-relative paths; handoff содержит абсолютные run-owned paths и их точные SHA. `service_r001_owner_wrapper.mjs` запускается с runtime root, поэтому текущий `samePath(relative, absolute)` разрешает relative path от process cwd и сравнение ошибочно не совпадает с run root.
- Ожидаемое поведение: R001 разрешает relative proof-binding artifact paths только относительно canonical Service run root (`dirname(dirname(handoffPath))`), принимает exact canonical `r005/...` paths и отвергает traversal, чужой run root, absolute drift, SHA/scope/proof mismatch.
- Затронутые пункты контракта: §§6, 8.1, 10–13; A01–A07, A10–A15.
- Обязательный регрессионный тест: service handoff с relative `proof_binding.codex_input.path`/`proof.path` проходит; `../`, чужой run, absolute подмена, неверный SHA и scope по-прежнему блокируются; полный R005→R001 остаётся `REPORT_ONLY`, без posting/upload.
- Допустимый scope фикса: run-root-aware path resolution только для двух proof-binding references в Node handoff verifier и focused regression; финансовая логика, BOM/OOXML validation, physical journal persistence, authority, R005/R001 semantics, rules service и 1С не меняются.
- Регрессионная фиксация: независимая ветка `fix/r001-proof-binding-relative-path`, отдельный Issue/PR; merge/release запрещены до coordinator review.

### R005-017 — Service handoff не содержит обязательный `execution_allowed=false`

- Дата: `30.08.2026`
- Статус: `OPEN_FIX_PR`
- Обнаружено: после исправления R005-016 новый изолированный source-Service прогон `run_8968c2a8e934b48b2bb333c7`, организация `9 Управляющая компания` (`ERP-000000224`), период `2025-10`.
- Наблюдаемое поведение: Go Service создаёт persistent journal и полный `handoff/r005-r001-service-handoff.json`, но R001 wrapper отклоняет handoff на exact schema: `SERVICE_HANDOFF_EXACT_SCHEMA_MISMATCH:safety:live_1c_allowed,mode,posting_rows,ready_to_upload,release_allowed`; запуск завершается `FAILED / R001`, диагностический комплект R001 не создан.
- Доказательство: JSON handoff содержит в `safety` только `mode`, `posting_rows`, `ready_to_upload`, `release_allowed`, `live_1c_allowed`; `modules/corrections/source/service_r005_r001_handoff.mjs` требует также `execution_allowed=false`. Причина — `SafetyState`/`reportOnlySafety()` в Go не сериализуют этот обязательный ключ.
- Ожидаемое поведение: Service handoff сериализует ровно закрытый safety-набор с `execution_allowed=false`; R001 wrapper принимает только этот набор и сохраняет `REPORT_ONLY`, нулевые posting rows, запрет upload/release/live 1С.
- Затронутые пункты контракта: §§9.5, 10–13; A01–A04, A10–A15.
- Обязательный регрессионный тест: Go handoff содержит `execution_allowed=false`; R001 exact-schema wrapper принимает handoff и формирует безопасный комплект; unsafe/missing/extra safety keys по-прежнему блокируются.
- Допустимый scope фикса: `SafetyState`/`reportOnlySafety()` и focused handoff integration test; финансовая логика, BOM/OOXML validation, physical journal persistence, authority, R005/R001 semantics, rules service и 1С не меняются.
- Регрессионная фиксация: независимая ветка `fix/r005-r001-handoff-safety`, отдельный Issue/PR; merge/release запрещены до coordinator review.

### R005-016 — Service handoff ошибочно отклоняет OOXML-журнал с UTF-8 BOM

- Дата: `30.08.2026`
- Статус: `OPEN_FIX_PR`
- Обнаружено: новый изолированный source-Service прогон `run_8c9d08ec126532923d875ed6`, организация `9 Управляющая компания` (`ERP-000000224`), период `2025-10`, с исходными ZIP-копиями без изменений.
- Наблюдаемое поведение: R005 создаёт полный безопасный комплект, включая persistent `r005/physical-evidence/erp-journal.xlsx` и точные SHA/лист `Лист_1`, но Service останавливается на `FAILED / R005_HANDOFF`; `materializeServiceR001Handoff` возвращает `R005 physical ERP journal sheet mismatch: OOXML member xl/workbook.xml has content before root element`, R001 не запускается.
- Доказательство: в `xl/workbook.xml` persistent журнала первые байты `EF BB BF 3C 3F 78 6D 6C` — UTF-8 BOM перед XML declaration; после BOM документ содержит единственный корень `workbook`, лист `Лист_1`, `r:id=rId1`, relationship типа worksheet и существующую часть `xl/worksheets/sheet1.xml`. Ошибка воспроизведена прямым вызовом `materializeServiceR001Handoff` на реальном комплекте; synthetic OOXML tests проходят.
- Ожидаемое поведение: валидный UTF-8 BOM допускается перед XML declaration/root element; exact worksheet name, relationship type/target, content type, root namespace и все текущие fail-closed checks должны сохраняться. Невалидное содержимое после BOM/до корня по-прежнему блокируется.
- Затронутые пункты контракта: §§6, 8.1, 10–14; A05–A07, A10–A15.
- Обязательный регрессионный тест: `validateExactXLSXSheet` принимает workbook/relationships/content-types/worksheet XML с UTF-8 BOM; тот же guard отвергает неизвестный non-whitespace prefix, неверный корень, wrong worksheet relationship/type/target и недостающую часть. Сквозной R005→R001 handoff на данном журнале должен пройти только в `REPORT_ONLY`, без posting/upload.
- Допустимый scope фикса: tolerant handling только BOM в XML decoder для OOXML package parts и focused regression; финансовая логика, physical journal persistence, authority, R005/R001 semantics, rules service и 1С не меняются.
- Регрессионная фиксация: независимая ветка `fix/xlsx-bom-worksheet-validation`, отдельный Issue/PR; merge/release запрещены до coordinator review.

### APPROVAL-004 — article-approval fixture оставляет устаревший `report_sha256` после замены XLSX

- Дата: `30.08.2026`
- Статус: `VERIFIED`
- Сообщил: пользовательская диагностика stale test fixture
- Наблюдаемое поведение: целевые Go-тесты article approvals завершаются безопасной ошибкой `ARTICLE_APPROVAL_R005_ANCHOR_INVALID` во время подготовки фикстуры. Фикстура заменяет `reconciliation.xlsx`, обновляет `codex["output_sha256"]`, но оставляет `codex["report_sha256"]` от прежнего placeholder report.
- Ожидаемое поведение: после замены итогового XLSX Codex input должен содержать актуальные `report_path` и `report_sha256`; последующая rebinding-цепочка должна оставаться валидной и позволять тесту дойти до проверяемого поведения.
- Доказательство: независимые свежие прогоны в двух временных исходных деревьях воспроизводят одинаковый `ARTICLE_APPROVAL_R005_ANCHOR_INVALID`; строгий валидатор проверяет `report_path`/`report_sha256` против фактического `reconciliation.xlsx` в `service/source/structural_control_inventory_anchor.go`.
- Затронутые пункты контракта: §§6–7, 9.5–9.6, 13–14, 16; приложение B. Финансовый барьер, `REPORT_ONLY=true` и `rules_service=false` не изменяются.
- Обязательный регрессионный тест: article-approval fixture synchronizes Codex `report_sha256` with the replaced report, then targeted approval tests and the canonical Go test gate no longer fail at stale R005 anchor setup.
- Реализация: `service/source/article_approvals_test.go` синхронизирует `codex["report_sha256"]` с хэшем заменённого XLSX перед сохранением Codex input; существующая rebinding-цепочка `output_sha256`/manifest/inventory/binding сохранена.
- Протокол проверки: targeted article approvals — `12` top-level tests / `15` cases including subtests, all `PASS`; `TestUI010StructuralCrossLinksUseRoleSpecificReportFields` — `PASS`; canonical staged `go test -count=1 ./...` с pinned Go `go1.22.12`, Node `v24.14.0` и verified `node_modules` — `ok`, exit code `0`. `git diff --check` — `PASS`.

### R001-001 — октябрьские доказанные корректировки не материализуются в owner-visible draft-файлы

- Дата: `31.08.2026`
- Статус: `IMPLEMENTED`
- Сообщил: пользовательская карточка `R001_RESTORE_OCTOBER_OWNER_GOLDEN_DRAFTS`
- BUG: новый реальный Service-прогон `run_16911279d6f885bba5247c8f`, организация `9 Управляющая компания` (`ERP-000000224`), период `2025-10`, завершился `COMPLETED_REPORT_ONLY / DONE`; `Решения.xlsx` и `Сверка.xlsx` созданы, но owner-visible финансовые draft STORNO/REPOST отсутствуют.
- EXPECTED: при доказанных canonical financial rows создаются ровно `32` draft-строки (`16` STORNO и `16` REPOST), `16` пар, сумма STORNO `-364066.00`, REPOST `+364066.00`, net `0.00`, в трёх `_СПОРНО` книгах с распределением по организациям `10/14/8`; live posting остаётся запрещённым.
- EVIDENCE: exact acceptance run `run_16911279d6f885bba5247c8f`; зафиксированный October owner/physical golden из карточки задачи; наблюдение `posting_rows=0` при ожидаемом ненулевом `draft_posting_rows`.
- ROOT CAUSE: первая доказанная потеря происходила на границе `R005 workbook → R001`: workbook adapter не нормализовал текущие иерархические labels/levels R005 в каноническую схему R001, поэтому доказанные source-строки не доходили до group-scoped materialization; paired-liability authority дополнительно искала физический источник только в direct-parent узле, а не во всём доказанном business block.
- SCOPE: R001 service handoff, decision/canonical materialization, draft workbook routing/registry/manifest и регрессионные проверки только в части подтверждённого первого места потери строк.
- OUT OF SCOPE: изменение контракта и October golden, hardcode сумм, R005 без доказательства потери до handoff, `rules_service`, upload/posting/1С, `REPORT_ONLY` safety, packaging/EXE и unrelated defects.
- REGRESSION TEST: exact October input на базовом HEAD должен быть RED до исправления; после исправления — `canonical_financial_rows_total=32`, `draft_posting_rows=32`, `materialized_posting_rows=32`, `16/16` STORNO/REPOST, `16` пар, суммы и per-org `10/14/8`, zero SourceRowID reuse, exact A:AA headers, workbook=registry=manifest row set, при `posting_rows=0` и всех execution/upload/release/live flags `false`.
- PASS: новый независимый тестовый контур доказывает RED до фикса, затем GREEN на exact October golden и сохраняет REPORT_ONLY safety.
- Реализация: adapter нормализует текущие R005 hierarchy labels/levels на границе workbook → R001; correction engine допускает только source-bearing hierarchy roles и выдаёт physical-source reuse proof лишь для уникального source текущего run; paired-liability authority ищет единственный exact source в доказанном business block и fail-closed отклоняет неоднозначные либо cross-block источники; group-scoped materialization сохраняет physical proof.
- Протокол проверки: новые paired-liability negative regressions — `2/2 PASS`; focused hierarchy/materialization — `16/16 PASS`; exact October golden — `1/1 PASS`; полный R001 Node — `269/269 PASS`; полный R005 Node — `242 PASS / 1 SKIP / 0 FAIL`; service/web Node — `54/54 PASS` (дополнительно UI overlay — `21/21 PASS`); pinned Go `go1.22.12` `go test -count=1 ./...` и `go vet ./...` — `PASS`; production syntax `99` files — `PASS`; `git diff --check` — `PASS`.
- Acceptance: exact October R001 golden подтверждает `32` canonical/draft/materialized, `16/16` STORNO/REPOST, `16` пар, суммы `-364066/+364066/net 0`, три `_СПОРНО` workbook `10/14/8`, R005 `21/21` unique proven physical source rows, canonical workbook/registry/manifest integrity и REPORT_ONLY safety. Полная source-Service acceptance остаётся `BLOCKED` отдельным дефектом `R005-020` Service-validator и не закрывается этой записью.

### APPROVAL-005 — production R005 XLSX OPC relationship target is rejected by article-approval parser

- Дата: `31.08.2026`
- Статус: `IMPLEMENTED`
- Сообщил: пользователь
- BUG: real production R005 XLSX cannot populate article approval queue; ERP catalog read fails.
- EXPECTED: valid production XLSX generated by artifact-tool must load `01_Правила` and `04_ERP_статьи` and allow the normal approval round-trip.
- EVIDENCE: production workbook relationship `Target` may be package-absolute: `/xl/worksheets/sheetN.xml`. До исправления parser распознавал только target, начинающийся точно с `xl/`, и иначе добавлял `xl/`.
- ROOT CAUSE: до исправления `articleApprovalXLSXRowsData` некорректно разрешал валидные package-absolute OPC Relationship `Target` values.
- Затронутые пункты контракта: §§9.5–9.6, 13–14, 16; A17–A22. `REPORT_ONLY=true` и `rules_service=false` не изменяются.
- Обязательный регрессионный тест: production-form `Target="/xl/worksheets/sheet8.xml"` fails on exact base before the fix and passes after it; legacy relative `Target="worksheets/sheet8.xml"` remains accepted; missing target/member, traversal and external/URL targets remain blocked.
- Допустимый scope фикса: only OPC worksheet relationship target resolution used by article approvals; source SHA/path/run/scope validation, duplicate-entry rejection, approval authority, financial evidence and live 1C safety are unchanged.
- RED: дефект воспроизведён на exact base `d55a7edcdfb456df704e3699f7ffeffe12b69d23`: package-absolute OPC target `/xl/worksheets/sheet8.xml` отклонялся article-approval parser.
- Реализация: package-absolute `/xl/...` теперь принимается; relative `worksheets/...` и canonical `xl/worksheets/...` targets остаются принятыми. Traversal, external/URL target, wrong relationship type, missing target/member и duplicate package entry остаются заблокированными fail-closed.
- Протокол проверки: focused article-approval regressions и полный `go test -count=1 ./...` — `PASS`; `go vet ./...` — `PASS`; полный R005 — `242 PASS / 1 known SKIP / 0 FAIL`; полный R001 — `269/269 PASS`; service/web — `54/54 PASS`; production syntax — `99/99 PASS`; `git diff --check` — `PASS`.
- Ограничение acceptance: полный реальный A20/A21 round-trip не заявляется. Он заблокирован вновь обнаруженным независимым production approval-scope defect, который должен быть обработан отдельно как `APPROVAL-006`; этот defect не добавляется и не исправляется в данной ветке.

### APPROVAL-006 — production `01_Правила` содержит строки без доказанной области Инталев

- Дата: `31.08.2026`
- Статус: `IMPLEMENTED`
- Сообщил: пользователь
- BUG: real production `01_Правила` reaches approval parser after APPROVAL-005, but queue is rejected because nine production rows do not contain required `БлокИнталев` / `ПутьИнталев`.
- EXPECTED: every row that is actually an article-approval candidate has an exact proven Intalev scope. A row which is not semantically an approval candidate must not be silently represented as an incomplete approval rule.
- EVIDENCE: run `run_9f835adf666ec52047e9704f`; source workbook SHA-256 `138817593685E3546845F49B2B5D8A712D4F2A73E68F5539AB0D5A66805504FC`; problem rows `13`, `19`, `20`, `25`, `27`, `29`, `32`, `61`, `63`; observed error `ARTICLE_APPROVAL_SOURCE_RULES_INVALID: REQUIRED_FIELD_MISSING`.
- ROOT CAUSE: все девять строк уже в raw monthly projection, перед построением `01_Правила`, имеют явные `intalev_live_hierarchy_status=UNPROVEN` и `hierarchy_status=BLOCKED_TEMPLATE_CATALOG_MISMATCH`; последующая R005 decision projection подтверждает ту же семантику как `classification=HIERARCHY_REPAIR` / `priority_stage=HIERARCHY_REPAIR`, которую decision engine присваивает при недоказанной иерархии (`!row.hierarchy_proven`). Первая потеря находится в `buildArticleApprovalRows`: он без semantic selection преобразовывал все monthly reconciliation rows в правила `01_Правила`, представляя records без доказанной live Intalev hierarchy как article-approval candidates. XLSX writer и Go parser сохраняли/валидировали уже неверно выбранный набор строк; parser корректно блокировал его fail-closed.
- Затронутые пункты контракта: §§9.5–9.6, 13–14, 16; A17–A22. `REPORT_ONLY=true` и `rules_service=false` не изменяются.
- Обязательный регрессионный тест: genuine approval row with valid exact Intalev scope passes; missing `БлокИнталев` or `ПутьИнталев` remains fail-closed; any proven non-approval row type is excluded only by positive semantic type/role/status, never by blank fields; an approval row of the same shape cannot evade validation; organization/period/scope mismatch remains blocked; APPROVAL-005 OPC target cases remain PASS.
- Допустимый scope фикса: production construction of `01_Правила`, or positive semantic selection for the article-approval queue only if production provenance proves a row is outside the approval domain; focused tests and this APPROVAL-006 entry. Blank required scope is not made valid, guessed or hardcoded values are forbidden, and row numbers are not production logic.
- Реализация: на первой доказанной границе production construction строки с явным `intalev_live_hierarchy_status=UNPROVEN` (либо уже спроецированные как одновременные `classification=HIERARCHY_REPAIR` / `priority_stage=HIERARCHY_REPAIR`) исключаются из article-approval row construction по их положительной семантике; blank fields не являются условием исключения, а genuine approval candidates с неполной scope по-прежнему доходят до валидатора и блокируются.
- Протокол проверки: focused APPROVAL-006 — `2/2 PASS`; article approval Node — `20/20 PASS`; APPROVAL-005 OPC — `10/10 subcases PASS`; новый production October run `run_c637fc3f1dadf8505cc18815` — `COMPLETED_REPORT_ONLY`, workbook SHA-256 `F15F19AADF822DD23D06EC496BCBE6F1E3D6A6D47A7FFB3C1CB52BF8041B48B2`, `01_Правила=53`, queue `53/53 PASS`, R005 physical evidence `21/21` unique `SourceRowID`, R001 `32/32/32`, `16` STORNO / `16` REPOST, `16` pairs, `-364066/+364066/net 0`, `_СПОРНО 10/14/8`; real A20 approval `article_approval_c5be81964125b12916d29de4` v1, approved JSON SHA-256 `3BB2089F856807108AD98C31916D0ED4A35D528D6BB9586FD67F4096986E1975`; A21 run `run_902fb698d4d01d27eaabc7f7` recorded `ACTIVE_EXACT_SCOPE` / approved version `1` and consumed the byte-identical approved JSON from its run input. Full R005 Node — `244 PASS / 1 known SKIP / 0 FAIL`; full R001 Node — `268 PASS / 1 pinned-input SKIP / 0 FAIL`; service/web — `54/54 PASS`; UI overlay — `21/21 PASS`; pinned Go `go1.22.12` `go test -count=1 ./...` and `go vet ./...` — `PASS`; production syntax — `99/99 PASS`; `git diff --check` — `PASS`. Throughout both runs: `REPORT_ONLY=true`, `rules_service=false`, posting/executed/live rows `0`, execution/upload/release/live/delete flags `false`.

### APPROVAL-007 — утверждение статьи другой организации-месяца блокирует новый месяц

- Дата: `31.08.2026`
- Статус: `IMPLEMENTED`
- Сообщил: пользователь
- BUG: production discovery утверждений ограничивает имя и поиск только организацией. Валидное утверждение октября той же организации обнаруживается при запуске ноября; несовпадение периода сохраняется как ошибка и блокирует стадию `R005_SETTINGS` вместо отсутствия активного утверждения.
- EXPECTED: authoritative approval scope является точной парой `organization + YYYY-MM`. Валидное утверждение другого месяца игнорируется; при отсутствии exact-scope утверждения возвращается `NO ACTIVE APPROVAL`. Повреждённое, SHA-invalid, malformed, unsafe, internally scope-inconsistent или содержащее недопустимые решения утверждение точной области остаётся fail-closed.
- EVIDENCE: организация `ERP-000000224` / `9 Управляющая компания`; October approval `2025-10`, approved version `v002`; same-store November run `run_9f3b952205505e5c1daf4506` падает на `R005_SETTINGS`; идентичный November run в чистом store `run_bcee30f53426c6af93d6a8de` завершается успешно. Итог source audit: `A21=FAIL`, `A30=FAIL`, `SOURCE_RELEASE_BLOCKED`.
- ROOT CAUSE: `service/source/article_approvals.go` строит historical filename/version discovery по `articleApprovalOrganizationSlug(scope)` и pattern `article_registry_<organization-slug>_vNNN.approved.json` без периода. `articleApprovalLatest` перечисляет все версии организации, валидирует документы других месяцев против requested scope и сохраняет unrelated-period mismatch как `firstError`; если exact-period документа нет, эта ошибка возвращается вместо отсутствия активного утверждения. `materializeActiveArticleApprovalSettings` передаёт ошибку в `R005_SETTINGS`.
- SCOPE: exact-scope discovery в `service/source/article_approvals.go`; узкие approval period-isolation regressions под `service/source/`; эта запись реестра. Backward read compatibility organization-only historical filenames и immutable approved history сохраняются.
- OUT OF SCOPE: R005 financial matching, R001 correction semantics, STORNO/REPOST, physical ERP evidence, structural control, empty-article binding, `YYYY-MM` contract, annual fan-out, Service JSON limits, DOCX/CURRENT.md, A25–A32 definitions, UI и EXE/packaging.
- REGRESSION TEST: доказать: other-month approval даёт NONE без ошибки; exact month возвращает exact ID/version/SHA; two-month store не допускает leakage; exact-scope corruption/SHA mismatch блокируется; other-month approval не блокирует `materializeActiveArticleApprovalSettings`; same-store October→November pipeline проходит `R005_SETTINGS` без October settings; следующий October снова использует latest exact October approval; exact November API при наличии только October возвращает `NONE`, не conflict/`VERSION_REJECTED`.
- PASS: A21 — approved mappings применяются исключительно к exact organization + exact month, другой месяц не блокирует и не потребляет их. A30 — последовательные October/November runs одного persistent store не смешивают organization, period, R005 evidence, SourceRowID/provenance, handoff, R001 result или approval scope. Исторические October v001/v002 остаются byte-identical; `REPORT_ONLY=true`, `rules_service=false`, posting/executed/live rows `0`, execution/upload/release/live 1C flags `false`.
- Реализация: `articleApprovalLatest` сохраняет backward-compatible organization-only filename/version discovery, но отделяет exact requested scope от доказанно валидного другого месяца. Кандидат другой организации-месяца игнорируется только после полной проверки собственной exact scope, validity, решений, safety, SHA sidecar и canonical stored source. Exact-scope либо неидентифицируемый malformed/corrupt candidate сохраняет fail-closed ошибку; исторические файлы не переписываются и global organization version sequence не меняется.
- Протокол проверки: APPROVAL-007 RED на exact base: `5 FAIL / 3 PASS` из восьми новых top-level regressions; после production fix: `8/8 PASS`; focused approval Go — `22/22 top-level PASS`, `0 FAIL`, `0 SKIP`. Real same-store C01 acceptance с pinned annual containers: первоначальный October run `run_7a417751443ea5626dc1078c` — `COMPLETED_REPORT_ONLY` / `DONE`; неизменённая audit-последовательность October `v001` / `v002` сохранена byte-identical (`v001` SHA-256 `4903FADC18A3891DFD8CE36B1C840B71702F5B4D279101B58A0CC14066D436D2`, `v002` approval `article_approval_3109e955d06e0a48d1f123a0`, approved JSON SHA-256 `6CCDA8EEF9B01EF02C44AC575DE10045C20DC67829B57F5EB4F359562BF15EB3`, source SHA-256 `AD8B404FD7537A47E27C2BDDDD8C8D86D8C2A33556656FE1710A71B5AC58AACC`). Без сброса store November run `run_e825bef4c4516de85d2bd54b` для `2025-11` прошёл `R005_SETTINGS` → R005 → exact handoff → R001 и завершился `COMPLETED_REPORT_ONLY` / `DONE`; API exact November вернул `NONE`, `r005-input/article-approval-settings.json` отсутствует, October approval ID/version/source SHA не встречаются в November artifacts, а intersections October/November для `source_row_id`, `erp_source_row_id`, `intalev_source_row_id` равны `0`. Следующий October run `run_29121cd82500e9d99aabe1eb` завершился `COMPLETED_REPORT_ONLY` / `DONE` и потребил byte-identical `v002` как `r005-input/article-approval-settings.json` с тем же SHA-256 `6CCDA8EEF9B01EF02C44AC575DE10045C20DC67829B57F5EB4F359562BF15EB3`. October owner golden: R005 `21/21` unique `SourceRowID`; R001 `32/32/32`, `16` STORNO / `16` REPOST, `16` pairs, `-364066/+364066/net 0`, `_СПОРНО 10/14/8`; каждая loader book имеет единственный лист `Загрузка_A_AA` и `27` колонок A:AA. Full service/web — `55/55 PASS`; UI overlay — `21/21 PASS`; pinned Go `go1.22.12` `go test -count=1 ./...` и `go vet ./...` — `PASS`; full R005 Node — `244 PASS / 1 existing external-golden SKIP / 0 FAIL`; full R001 Node — `268 PASS / 1 existing pinned-input SKIP / 0 FAIL`; production JS/MJS syntax — `99/99 PASS`; `git diff --check` — `PASS`. A21=`PASS`; A30=`PASS`; safety на всех трёх runs: `REPORT_ONLY=true`, `rules_service=false`, posting/executed/live rows `0`, execution/upload/release/live/delete flags `false`. Статус остаётся `IMPLEMENTED`, запись не закрыта.

### APPROVAL-008 — fallback утверждений не оставляет наблюдаемой диагностики отклонённой версии

- Дата: `01.09.2026`
- Статус: `IMPLEMENTED`
- Сообщил: пользователь
- BUG: при наличии новой невалидной публикации и предыдущей валидной публикации `articleApprovalLatest` правильно выбирает предыдущую версию, но наружу возвращает обычный успешный результат. Идентичность отклонённой публикации и причина отклонения остаются только во внутренней переменной ошибки и не наблюдаемы через Approval GET API, run/materialization или сохраняемый диагностический артефакт.
- EXPECTED: fallback сам по себе обязателен и разрешён контрактом §9.6. Каждая отклонённая exact-scope публикация, после которой выбрана предыдущая валидная версия, оставляет детерминированную машинно-читаемую диагностику `ARTICLE_APPROVAL_VERSION_REJECTED_FALLBACK` с идентичностью и определимой версией отклонённой публикации, кодом причины, выбранными approval ID/version, точными организацией и `YYYY-MM` и явным признаком fallback. HTTP и run могут успешно продолжаться; при отсутствии предыдущей валидной версии сохраняется существующее fail-closed поведение без ложного сообщения об успешном fallback.
- EVIDENCE: карточка `APPROVAL008_FALLBACK_DIAGNOSTIC_TRANSPARENCY`; canonical v0.5 §9.6 прямо требует отклонять повреждённую или чужую версию «с диагностикой» и использовать последнюю предыдущую валидную версию, если она существует. Текущая selector-граница сохраняет только `firstError`, не возвращая его вместе с выбранной предыдущей версией.
- ROOT CAUSE: результат выбора утверждения не содержит структурированных warnings/diagnostics; Approval GET сериализует только выбранную запись, а materialization не сохраняет evidence об отклонённых кандидатах в существующей архитектуре диагностики run.
- SCOPE: узкое расширение результата selector, Approval GET response и Service-owned run/materialization diagnostics/artifacts; deterministic rejection reason codes; focused regressions D1–D8. Exact organization + `YYYY-MM`, immutable history и approved bytes сохраняются.
- OUT OF SCOPE: изменение §9.6 или выпуск v0.6; превращение разрешённого fallback в fatal при наличии предыдущей валидной версии; изменение APPROVAL-007, FY-001, UI, R005/R001 финансовой логики, physical ERP evidence, posting/upload/live authority или approved-файлов.
- REGRESSION TEST: SHA-invalid, malformed JSON, missing sidecar, unsafe metadata и invalid stored-source binding у v003 при валидной exact v002 выбирают byte-identical v002 и дают наблюдаемую диагностику на selector/API/run/artifact boundaries; валидная v003 не даёт warning; доказанно валидная публикация другого месяца изолируется без ложной corrupt-диагностики; invalid candidate без предыдущей valid версии остаётся fail-closed; диагностика содержит exact scope и не содержит финансовой authority либо абсолютных локальных путей; approved history не изменяется.
- PASS: focused тест RED на exact base, затем GREEN; новые APPROVAL-008 tests и APPROVAL-005/006/007, approval queue/API/materialization, immutable publication, source SHA/safety проходят; APPROVAL-008 `-count=50` имеет 0 intermittent failures; реальный изолированный fallback выбирает v002, показывает отклонённую v003 с exact reason, сохраняет byte-identical settings и REPORT_ONLY; A21/A30, October owner golden, полный regression, contract SHA и clean local/remote branch подтверждены.
- Реализация: selector возвращает выбранную публикацию вместе со всеми отклонёнными более новыми кандидатами в descending version order и стабильными reason codes. Filename version связан с `document.version`; публикация, sidecar и canonical stored source повторно проверяются непосредственно перед materialization, а non-regular/reparse files отклоняются. GET показывает безопасную fallback-диагностику без абсолютных путей и финансовой authority. Run сначала сохраняет byte-identical approved settings, затем обязательную Service-owned diagnostic JSON/SHA pair, связанную с exact run/context; diagnostics endpoint проверяет SHA, run/context, settings ID/version/SHA и exact organization/month перед проекцией. Неудачная запись settings не может оставить ложный fallback artifact. Валидная версия другого месяца после полной собственной проверки остаётся isolation, а не rejection; без предыдущей valid версии сохраняется fail-closed.
- Протокол проверки: identical focused test на exact base `6c09109a820a5d92e3917c45279037da289b9c05`: RED `1 FAIL / 0 PASS`, после реализации GREEN `1/1 PASS`. Финальный APPROVAL-008: `12` top-level / `19` test+subtest PASS events, `0 FAIL`, `0 SKIP`; `-count=50` — `PASS`, `0` intermittent failures. APPROVAL-007 — `8/8 PASS`; APPROVAL-005 OPC — `10/10` subcases PASS; APPROVAL-006 — `2/2` focused и `15/15` full article core PASS; approval queue/API/materialization/source SHA/safety matrix — PASS. Real disposable C01 fallback: seed `run_08ca7f41d93852f16158b0c0`, SHA-invalid v003, fallback run `run_03c04b903ea86b4b6604a8a8` — `COMPLETED_REPORT_ONLY` / `DONE`, rejection `SHA256_MISMATCH`, selected approval `article_approval_3109e955d06e0a48d1f123a0` v2, selected/materialized SHA-256 `6CCDA8EEF9B01EF02C44AC575DE10045C20DC67829B57F5EB4F359562BF15EB3`, one verified diagnostic; v001/v002 JSON и sidecars неизменны. Persistent isolation: October `run_9694c8a21690fa7b37827b0a` → November `run_284e06d5102e211c892a14f4` → October `run_95209e916106d409e3561587`, все `COMPLETED_REPORT_ONLY` / `DONE`; October `ACTIVE_EXACT_SCOPE`, November `NO_APPROVED_VERSION`, A21=`PASS`, A30=`PASS`, intersections `source_row_id` / `erp_source_row_id` / `intalev_source_row_id` = `0/0/0`. October golden: R005 `2/2 PASS`, `21` physical rows / `21` unique `SourceRowID`; R001 `1/1 PASS`, `32/32/32`, `16` STORNO / `16` REPOST, `16` pairs, `-364066/+364066/net 0`, distribution `10/14/8`, one `Загрузка_A_AA`, `27` columns A:AA. Full pinned regression: Go `go test -count=1 ./...` и `go vet ./...` — PASS; Service/web `55/55 PASS`; UI overlay `21/21 PASS`; R005 `244 PASS / 1 existing external-golden SKIP / 0 FAIL` (`real October golden retains all top rows and its five exact physical account-flow rows`, отдельно с pinned input `PASS`); R001 `268 PASS / 1 existing pinned-input SKIP / 0 FAIL` (`October owner golden restores exact 16 report-only correction pairs`, отдельно с pinned handoff `PASS`); production syntax `99/99 PASS`; `git diff --check` — PASS. Canonical v0.5 SHA-256 остаётся `B2C7D11B8373E603D0FA0C9B9AF090CF3026085A4E80457B228336CEA3DFAB5A`; безопасность: `REPORT_ONLY=true`, `rules_service=false`, posting/executed/live rows `0`, execution/upload/release/live flags `false`.

### FY-001 — ожидание годового Service fan-out заменено контрактом v0.5

- Дата решения: `31.08.2026`
- Статус: `CLOSED`
- Причина закрытия: `SUPERSEDED_BY_CONTRACT_V0.5`
- Решение пользователя: OPIU R17 выполняет один расчёт только за одну организацию и один полный календарный месяц `YYYY-MM`. Год, квартал и произвольный многомесячный диапазон больше не являются поддерживаемой областью одного расчёта.
- Диспозиция прежнего ожидания: годовой Service fan-out удалён из продуктового требования контрактом v0.5.
- Технический результат: annual execution не был технически исправлен и не заявляется работоспособным.
- Сохраняемое требование: существующий месячный режим остаётся обязательным. Для года пользователь запускает независимые `YYYY-01` … `YYYY-12` последовательно; автоматического fan-out нет.
- Источники: годовой ERP/Инталев файл или ZIP разрешён только как контейнер. Выбранный месяц должен детерминированно доказываться из источника, а все результаты и evidence ограничиваются этим месяцем.
- Изоляция: каждый месяц имеет независимые organization/period, R005 evidence, `SourceRowID`/provenance, handoff, R001 result и approval scope. Межмесячное смешение, неттирование и повторное использование физического ERP evidence запрещены.
- Исторические материалы: диагностика FY-001 остаётся историческим evidence и не становится доказательством поддерживаемого annual mode.
- Pull request: draft PR #19 `FY-001: register blocked annual structural-control fan-out` никогда не должен быть объединён. После объединения контракта v0.5 в `release/r17` PR #19 должен быть закрыт без merge как superseded.
- Контракт и регрессия: v0.5, критерии `A25–A32` проверяют валидный месячный запуск, отклонение `YYYY`/`YYYY-QN`/диапазона, годовой source-container, изоляцию последовательных месяцев, запрет повторного evidence и неизменную безопасность.
- Безопасность: `REPORT_ONLY=true`, `rules_service=false`, `posting_rows=0`, `executed_posting_rows=0`, `live_posting_rows=0`; автоматическая загрузка и проведение в 1С запрещены.

### PERIOD-002 — Service продолжает принимать год и квартал после контракта v0.5

- Дата: `31.08.2026`
- Статус: `IMPLEMENTED`
- Сообщил: пользовательская карточка `PERIOD002_MONTHLY_ONLY_SERVICE_ENFORCEMENT`.
- Наблюдаемое поведение: production Service принимает при создании контекста период `YYYY`, `YYYY-Q1`…`YYYY-Q4` и `YYYY-MM`; существующая store-регрессия прямо закрепляет все три формы как допустимые. `CreateRun` доверяет уже сохранённому контексту и не проверяет повторно, что его период является конкретным месяцем.
- Ожидаемое поведение: единственная допустимая область одного расчёта — одна организация и один полный календарный месяц `YYYY-MM`, где `MM=01..12`. `YYYY`, `YYYY-QN`, многомесячный или произвольный диапазон и произвольный текст отклоняются до сохранения контекста; ранее сохранённый контекст с годом или кварталом не может создать новый запуск и не изменяется автоматически.
- Доказательство exact base: на `b46c297af58f582b4a259c311dbd23900c14e95c` `service/source/store.go` содержит `acceptedPeriod = ^\d{4}(?:-(?:0[1-9]|1[0-2])|-Q[1-4])?$`; `TestPeriodContractSupportsMonthQuarterAndYear` требует принятия месяца, квартала и года; `CreateRun` после чтения persisted context не валидирует `context.Period` до создания `QUEUED` run.
- Подтверждённая первопричина: Service сохранил pre-v0.5 regexp и regression contract; run preflight не получил независимого monthly-only guard для legacy persisted contexts.
- Затронутые пункты контракта: §§1, 3.2, 6.1, 10.1, 11, 13–14; A25–A32.
- Обязательный регрессионный тест: A25 принимает валидные `YYYY-MM`; A26 отклоняет `YYYY`; A27 отклоняет `YYYY-QN`; A28 отклоняет диапазон и произвольный текст; `POST /api/contexts` отвечает fail-closed понятной русской ошибкой; persisted legacy context с годом или кварталом не создаёт run; UI сохраняет `type=month` и подпись «Месяц расчёта»; annual XLSX/ZIP не блокируется на уровне файла только из-за нескольких месяцев.
- Допустимый scope фикса: server-side проверка области периода при `CreateContext` и `CreateRun`, минимальная подпись UI, focused Go/API/UI regressions и эта запись. Исторические контексты не переписываются; annual source-container, structural inventory concrete-month guards, JSON limits, R005/R001 semantics, Rules Service и 1С не меняются.
- Безопасность: `REPORT_ONLY=true`, `rules_service=false`, `posting_rows=0`, `executed_posting_rows=0`, `live_posting_rows=0`; `execution=false`, `upload=false`, `release=false`, `live_1c=false` остаются неизменными.
- Реализация: единый authoritative regexp принимает только `YYYY-MM` с `MM=01..12`; `CreateContext` отклоняет неподдерживаемый период до записи, а `CreateRun` повторно валидирует persisted `context.Period` до создания run и не изменяет legacy context. HTTP API возвращает `400` с сообщением «Поддерживается расчёт только за один календарный месяц в формате YYYY-MM». UI сохраняет единственный `input type=month` с подписью «Месяц расчёта». Annual XLSX/ZIP остаётся допустимым source-container.
- Протокол проверки: focused PERIOD-002 Go/API — `6/6 top-level PASS`; focused UI — `1/1 PASS`; full service web — `55/55 PASS`; pinned Go `go1.22.12` `go test -count=1 ./...` и `go vet ./...` — `PASS`; full R005 Node — `244 PASS / 1 existing SKIP / 0 FAIL`; full R001 Node — `268 PASS / 1 existing SKIP / 0 FAIL`; production JS/MJS syntax — `99/99 PASS`; `git diff --check` — `PASS`. Real isolated acceptance `run_6d2fc8e41660afa44bf7911c` для `ERP-000000224` / «9 Управляющая компания» / `2025-10` завершён как `COMPLETED_REPORT_ONLY` / `DONE`: annual ERP ZIP SHA-256 `6A2DA2EAA1560918826A340828D736E3532FF5F0602559BC7B9FACA1A1A523B2` и annual Intalev ZIP SHA-256 `3FA5D75ECA20920BC70DE59F17EDF19F4A1720D9B675EE8AAAEEDACA0BE5A340` прошли R005 → Service handoff → R001; все `649` period/periods fields пяти scope manifests равны только `2025-10`. Safety: `REPORT_ONLY=true`, `rules_service=false`, posting/executed/live rows `0`, execution/upload/release/live/delete flags `false`.

### PACK-004 — portable packaging remains bound to contract v0.4

- Дата: `01.09.2026`
- Статус: `IMPLEMENTED`
- Сообщил: пользовательская карточка `PACK004_PORTABLE_V05_CONTRACT_BINDING`.
- BUG: каноническая portable-policy, builder, independent verifier и regression оставались привязаны к контракту v0.4 после фиксации текущего контракта v0.5.
- EXPECTED: текущий portable R17 получает exact Git bytes `contracts/Контракт_ОПИУ_v0.5_зафиксированный.docx`, кладёт их в `contract/OPIU_v0.5.docx` и везде требует SHA-256 `B2C7D11B8373E603D0FA0C9B9AF090CF3026085A4E80457B228336CEA3DFAB5A`; v0.4 как current contract отклоняется.
- EVIDENCE: `contracts/CURRENT.md` и канонический DOCX фиксируют v0.5; до исправления `r17_portable_policy.json`, оба Python-барьера и builder regression содержали exact v0.4 path/SHA `09AB635802E436C2C33E2FD39D8B35E62631376AB9AE8DA6F6EFC23EAF844BCD`.
- ROOT CAUSE: при переходе release-контракта с v0.4 на v0.5 не были синхронно обновлены exact policy-value, builder и independent verifier pins, поэтому два барьера разделяли одно устаревшее предположение.
- SCOPE: каноническая portable-policy, builder/verifier contract checks, package contract metadata, focused packaging regressions, README и эта запись. `baseline_source_commit` сохранён как историческая provenance-метка; release authority остаются exact `--source-head` и Git blob inventory.
- OUT OF SCOPE: изменение DOCX/CURRENT.md, production Service/R005/R001, approval/period/process/financial semantics, safety gates, сборка EXE/ZIP, release publication и любое изменение disposition FY-001.
- REGRESSION TEST: policy требует exact v0.5; builder отклоняет rebind на v0.4; staged v0.5 равен Git blob и canonical SHA; manifest, provenance и sidecar совпадают; verifier отклоняет v0.4 вместо/вместе с v0.5, v0.4 bytes под v0.5 path, wrong sidecar/manifest/provenance, missing и tampered canonical contract; исторический v0.4 DOCX сохраняет exact SHA.
- PASS: focused builder contract regression — `4/4 PASS`; focused independent verifier contract regression — `9/9 PASS`; напрямую затронутые builder/verifier — `97 PASS / 0 FAIL / 2 explained SKIP`; применимый broader portable packaging — `116 PASS / 0 FAIL / 2 explained SKIP`. Оба skip не скрывают регрессию: Windows symlink fixture недоступна этой учётной записи, real relocation smoke требует запрещённый в PACK-004 final archive. Полный исторический `service/packaging` на ветке — `178 PASS / 15 baseline FAIL / 2 explained SKIP`, на exact base SHA — `167 PASS / те же 15 FAIL / 2 SKIP`; существующие carrier/overlay failures вне scope. Pinned Go test/vet, Service/web `55/55`, UI `21/21`, production syntax `98/98` и `git diff --check` проходят; safety побайтово не меняется; v0.5/v0.4 SHA совпадают с каноническими; ветка и PR остаются несмерженными до review.

### UI-012 — завершённый канонический результат R001 не открывает все пользовательские артефакты

- Дата: `01.09.2026`
- Статус: `IMPLEMENTED`
- Сообщил: пользовательская карточка `UI012_CANONICAL_R001_RESULT_DISCOVERY` и финальная packaged-приёмка.
- Наблюдаемое поведение: завершённый запуск `run_b11e1112489b8d2b7aa8cdbd` имеет статус `COMPLETED_REPORT_ONLY / DONE` и полный проверенный R001 report package, но `GET /api/runs/<run>/result/r001` возвращает `ready=false`, `verified_package_available=true`, только `7` технических/реестровых файлов и не выдаёт archive URL. Физически существующие и проверенные `CORR_20260901-104356/Решения.xlsx` и три `CORR_20260901-104356/СПОРНО/*.xlsx` отсутствуют в API/UI.
- Ожидаемое поведение: A13 требует завершённый пользовательский lifecycle и доступные файл/папку результата. Все канонические, проверенные, принадлежащие точному run пользовательские артефакты R001 должны быть перечислены, скачиваться побайтово и входить ровно один раз в архив результата; произвольные либо незарегистрированные XLSX не получают видимости.
- Доказательство / файл / скриншот: `C:\O\R17_FINAL_AUDIT\agent-e\run_20260901_103903\result-discovery-defect.json`, SHA-256 `CD8F87AB145EEB84838F78323DF78653395ADD276A38BA62BA29FDAED7BCC1E8`; исходный API response SHA-256 `E26A75E7C72A20AD45838E4AEFCB79EBC8B4F8BC21F27B7895DFBCA75C129FE5`. Канонические артефакты: `Решения.xlsx` — `23726` байт, SHA-256 `1177C922F6BA9B34DC41133A9A83296A31B1C86227BAC13C9169F430C088C17B`; `[ГК][31.10.2025]_ОПИУ_ГОТОВО_СПОРНО.xlsx` — `6456`, `907583061C4EEF2A0DFF47D1532253D75B8B03A3ECDA9071952FC08038DFD1DB`; `[ООО Группа компаний Планета][31.10.2025]_ОПИУ_ГОТОВО_СПОРНО.xlsx` — `7147`, `673BB56FDD6B353C891D706D440C26BB54473E026587EA9CF52754BC22BA000E`; `[ООО Планета Инноваций][31.10.2025]_ОПИУ_ГОТОВО_СПОРНО.xlsx` — `6146`, `87BBB492579BD232E946CE8EC4311E870BE1B598FCFEED1B2F27C2522AAC58BF`.
- Затронутые пункты контракта: §§11–14; A13 и A32. A13 не является optional: «Интерфейс завершает работу»; PASS — «Индикатор останавливается; файл и папка открываются».
- Подтверждённая первопричина: `service/source/results_api.go` в `collectStageResultFiles` и `resultKind` использует legacy display-name/directory эвристики, включая префикс `Решения_корректировок_ввод_R001`, вместо канонического проверенного реестра артефактов. Поэтому `stageResultReady` не видит decisions workbook и оставляет результат неготовым.
- Новое или уточнённое требование: discovery опирается на канонический проверенный R001 artifact authority с точными run/scope/path/size/SHA; regular-file, containment, symlink/reparse и tamper guards сохраняются. Нельзя принимать все `*.xlsx`, broad substring `_СПОРНО` или незарегистрированный похожий файл.
- Обязательный регрессионный тест: реальная каноническая форма имён (`Решения.xlsx` и три точных `_ОПИУ_ГОТОВО_СПОРНО.xlsx`) на завершённом verified package до исправления воспроизводит `ready=false`, `0` decisions и `0` loaders; после исправления API возвращает все ожидаемые exact relative names/kinds/sizes/stable URLs, direct download даёт byte-identical SHA, архив содержит exact allowlist без дублей/private-файлов. Отдельно блокируются unlisted XLSX, foreign run, traversal, symlink/reparse, tamper, size/SHA mismatch и fake похожее имя; допустимый legacy verified package сохраняется.
- Реализация: R001 listing теперь строится из `artifact-registry.json`, побайтово закреплённого непосредственно перед этим полной `validateVisibleReportPackage` и повторной проверкой SHA реестра против `report-package.manifest.json`, а не из обхода файловой системы по display-name. Для каждой записи сохраняются exact allowlist, run-root containment, regular-file/reparse и size guards; direct download и archive независимо повторяют полную manifest/registry/size/SHA-проверку и snapshot guard, поэтому произвольные, изменённые и foreign-run файлы не выдаются. Канонические роли `Решения.xlsx`, `ЗАГРУЗКА/`, `СПОРНО/`, `УДАЛЕНИЕ/`, `Сверка.xlsx` определяются по точной форме зарегистрированного пути без broad `_СПОРНО`-matching; readiness доверяет полной `validateVisibleReportPackage` и не зависит от legacy display-name. UI сохраняет archive action и дополнительно выводит каждую проверенную file-ссылку API.
- Протокол проверки: mandatory RED на exact base — `ready=false`, `verified_package_available=true`, archive отсутствует, API `7` файлов, decisions `0`, disputed `0`, missing `4`; после production fix canonical discovery/direct download/SHA/exact archive — `PASS`. Финальный `-count=50` одновременно для canonical discovery и N1–N10 security matrix — `PASS`, `50/50` каждого теста, `544.137s`, ноль intermittent failure; допустимый N4 symlink subcase имеет `SKIP` из-за отсутствия Windows symlink privilege, N5 junction/reparse — `PASS`. Полный focused result-API запуск — `PASS`; существующий symlink regression имеет ту же объяснённую privilege-зависимость. UI-012 DOM regression входит в полный Service/web `56/56 PASS`; UI overlay — `21/21 PASS`.
- Реальная приёмка: новый isolated source-run `run_809a68963619eba099e36160`, `ERP-000000224` / `9 Управляющая компания` / `2025-10`, завершён `COMPLETED_REPORT_ONLY / DONE`; indicator остановлен, terminal status отображён, false `QUEUED` отсутствует, Service штатно завершился с code `0` и освободил порт. R005 сохранил `21` доказанную физическую строку и `21` unique `SourceRowID`; R001 сохранил `32/32/32` draft/materialized/canonical, `16` STORNO + `16` REPOST, `16` пар, суммы `-364066/+364066/net 0`, распределение `10/14/8`. API вернул `ready=true`, `verified_package_available=true`, `13` exact registered files и archive URL.
- Канонические owner-файлы реальной приёмки: `CORR_20260901-131648/Решения.xlsx` — `23740` байт, SHA-256 physical/download `DD7E53696E390D9C05FD9B498D6A363CAF7AEC33679577850D559C1FD8D053C6`; `CORR_20260901-131648/СПОРНО/[ГК][31.10.2025]_ОПИУ_ГОТОВО_СПОРНО.xlsx` — `6456`, `486C7CCCF75E0C5FFD6947B42A8AAF7EB4507D1D78E3271626E5181D452945FD`; `CORR_20260901-131648/СПОРНО/[ООО Группа компаний Планета][31.10.2025]_ОПИУ_ГОТОВО_СПОРНО.xlsx` — `7149`, `DF607F4C8C6ED91FBFEC44FFBF701C6521532EB8438F82AB37497544EE046D51`; `CORR_20260901-131648/СПОРНО/[ООО Планета Инноваций][31.10.2025]_ОПИУ_ГОТОВО_СПОРНО.xlsx` — `6147`, `C76A9E37FC51540422AB3B4A6DF16E604DF155DEA9804BB2B7433752268BB26C`. Archive SHA-256 `2A1045EE5CC0818174A9EF820D75EE3A9EE070BC76FE63F98AFC1FA0054810FF`, ровно `13` записей, exact API set, без дублей/private-файлов; SHA каждой записи совпал с физическим артефактом. A13 = `PASS`: terminal/indicator/result/direct file/archive/lifecycle доказаны.
- Полный regression: pinned Go `go1.22.12` `go test -count=1 ./...` — `PASS` (`113.095s`), `go vet ./...` — `PASS`; R005 Node — `244 PASS / 1 existing opt-in SKIP / 0 FAIL` (`real October golden retains all top rows and its five exact physical account-flow rows`); R001 Node — `268 PASS / 1 existing opt-in SKIP / 0 FAIL` (`October owner golden restores exact 16 report-only correction pairs`); production syntax — `98/98 PASS`. Safety неизменна: `REPORT_ONLY=true`, `rules_service=false`, posting/executed/live rows `0`, execution/upload/release/live-1C flags `false`, взаимодействия с 1С нет. Канонический v0.5 SHA-256 остаётся `B2C7D11B8373E603D0FA0C9B9AF090CF3026085A4E80457B228336CEA3DFAB5A`; исходный evidence ZIP до и после внутренней приёмки остаётся `115D7B70BEF56D5E79538C03794A6E9FD9A0F0432F553CA5A4ED4B98CCBDE4F1` и не изменялся.

### UI-013-RDL — активный интерфейс теряет Service до скачивания результата

- Дата: `01.09.2026`
- Статус: `IMPLEMENTED`
- Сообщил: пользовательская карточка `UI013_KEEP_LOCAL_SERVICE_ALIVE_FOR_RESULT_DOWNLOADS`.
- Идентификатор: суффикс `-RDL` отличает эту карточку от уже существующей в реестре несвязанной записи `UI-013` про восстановление прерванного запуска; task/branch identifier остаётся `UI013`.
- Наблюдаемое поведение: после нового завершённого packaged-run браузер продолжает показывать действия скачивания, но Service примерно через четыре секунды автоматически завершает работу; localhost endpoints результата становятся недоступны, хотя UI-сессия остаётся активной.
- Ожидаемое поведение: активная UI-сессия удерживает exact OPIU Service доступным для проверки и скачивания R005/R001 результатов без Internet. После фактического закрытия UI сохраняется существующий reconnect grace, затем допускается контролируемое безопасное завершение и освобождение порта.
- Затронутые пункты контракта: §§11–14; A13 и A16. A13 требует остановившийся индикатор и открывающиеся файл/папку; A16 сохраняет безопасное завершение точного дерева OPIU, незатронутый посторонний процесс, освобождение порта и немедленный повторный запуск.
- Доказательство exact base: обязательный RED должен показать вызов `shutdown("result-completed")` после `serviceResultShutdownGrace` при `UISessions > 0`, отсутствии активного расчёта и нового завершённого результата. Packaged evidence-кандидат при локальной доступности должен отдельно подтвердить время потери `/api/health` и отказ скачивания.
- Подтверждённая первопричина: в `monitorServiceLifecycle` ветка `resultPending` выполнялась раньше UI-lifecycle и не учитывала `UISessionSeen`. Новый завершённый результат запускал `resultReadyAt` и затем `shutdown("result-completed")` при `InFlight == 0`, даже когда `UISessions > 0`; поэтому живой интерфейс не мог удержать Service для последующих result-запросов.
- Обязательный регрессионный тест: активная UI-сессия удерживает Service не менее `3 * serviceResultShutdownGrace`; `/api/health`, `/api/bootstrap`, verified R005 и R001 direct/archive downloads остаются доступны и побайтово совпадают. Краткий разрыв UI с reconnect внутри `serviceUIReconnectGrace` не завершает Service. Постоянное закрытие UI разрешает shutdown только после grace, отсутствия active run/request и завершения уже начатого verified download; затем exact порт освобождён и немедленный restart успешен.
- Безопасность: `REPORT_ONLY=true`, `rules_service=false`, `posting_rows=0`, `executed_posting_rows=0`, `live_posting_rows=0`, `execution_allowed=false`, `ready_to_upload=false`, `release_allowed=false`, `live_1c_allowed=false`; lifecycle-изменение не выдаёт бизнес- или финансовых полномочий и не выполняет действий в 1С.
- Обязательный RED на exact base `4aef7eb78a465991823731546e7805f56ae125a7`: новый `TestUI013CompletedResultKeepsServiceAliveWhileUISessionActive` получил `shutdown("result-completed")` через `40.4995ms` при snapshot `{InFlight:0 UISessions:1 UISessionSeen:true}` и требуемом окне `90ms`. До production-фикса exact packaged candidate ZIP SHA-256 `F6AA187168136C460F2A6CBEBEDD7BFFB58478A141E5206210842431ABBF1345` / EXE SHA-256 `AC80C62212E475C0F1CA9C7344D65C9D2761AF17CF6A7103FDE5C01E463356C8`, run `run_9fa299c94d7a7a40b56f0a34`, завершился `COMPLETED_REPORT_ONLY / DONE`; после окончания result-запроса Service вызвал `result-completed` через `4.076s`, `/api/health` стал недоступен к `10.695s` после `DONE`, дальнейшие direct/archive downloads отказали при остававшейся UI-сессии.
- Реализация: при `resultPending && UISessionSeen` result-only таймер сбрасывается, а решение полностью передаётся существующей UI-close/reconnect ветке. Headless result shutdown не изменён; постоянного сервиса не создаётся. Существующий `safeToStop = InFlight == 0 && !hasActiveRun` сохранён, поэтому уже начатые verified-downloads не обрываются.
- Новые регрессии: active UI удерживает completed Service; disconnect/reconnect внутри grace отменяет shutdown; реальные verified `/api/health`, `/api/bootstrap`, terminal run, R005 direct, R001 direct/archive, in-flight completion, controlled shutdown, освобождение и немедленный rebind exact порта проверяются в `existing_service_test.go`. Focused `3/3 PASS` (`5.931s`); `go test -count=50 -run '^TestUI013'` — `PASS` (`143.866s`, 150/150 выполнений). Финальный UI-013/S06/A16 focused, включая foreign-owner fail-closed и exact process tree, — `12/12 PASS` (`9.566s`).
- Полный regression: Go `go1.26.6 windows/amd64` `go test -count=1 ./...` — `PASS` (`96.509s`), `go vet ./...` — `PASS`; загрузка дополнительного pinned `go1.22.12` в этой среде не завершилась и была прервана без изменения репозитория. Service/web — `56/56 PASS`; UI overlay — `21/21 PASS`; R005 — `244 PASS / 1 existing opt-in SKIP / 0 FAIL`; R001 — `268 PASS / 1 existing opt-in SKIP / 0 FAIL`; production JS/MJS syntax — `98/98 PASS`; `git diff --check` — `PASS`.
- Одноразовый green EXE дважды детерминированно собран из текущего исходника с portable ldflags: `9 220 608` байт, SHA-256 обоих build и подставленного test-package `6546BA4F4AECC6982FB2870919935EFDB5C55D83ADDE381FB39609493628AE3F`. Это только disposable acceptance package, не публикация финального релиза; исходные blocked ZIP/EXE не изменялись.
- Реальная приёмка: новый isolated packaged-run `run_4dca1ef08e25615886c7e4cb`, `ERP-000000224` / «9 Управляющая компания» / `2025-10`, завершён `COMPLETED_REPORT_ONLY / DONE`; false terminal `QUEUED` отсутствует. Активная UI SSE удерживала `/api/health` и result endpoints около `180s` после `DONE`, то есть существенно дольше обязательных `30s` и `3 * serviceResultShutdownGrace`.
- Real downloads: R005 `reconciliation.xlsx` — `745151` байт, SHA-256 physical/download `5590CB84D7844A74BD5DDDA620876755AFABE7DBC10D8A9E0493EBDCEE44DCDC`; R001 `Решения.xlsx` — `23806`, `116BE53B2B665032F77EFD86DC8A6D06F03A4939269BE8EE773A8475A39A6F01`; один `_СПОРНО` — `6457`, `AA0656AD68299F909E8ABEEA259A50458999DA7F3E14F84E1060496DF17A8D2B`. Скачанный `R001.zip` — `891502`, SHA-256 `AA3F220651E84B77081B9CC9B44DD6586E45E8D6277DF83EB1EEA38A746BD55A`, ровно `13/13` registered entries; SHA каждого entry совпал с физическим owner-артефактом.
- In-flight acceptance: verified `Решения.xlsx` download начат при открытом UI, UI закрыт через `561ms`; через `5000ms` (за reconnect grace) запрос ещё был in-flight и `/api/health=ok`. Download завершился через `9934ms` побайтово идентично; затем Service вызвал только `ui-session-closed`, через `4379ms` exact порт был свободен. Последующий packaged restart успешно занял `127.0.0.1:8765`; unit regression дополнительно делает немедленный `net.Listen` rebind. A13=`PASS`; A16=`PASS`.
- Safety неизменна во всём run/package evidence: `REPORT_ONLY=true`, `rules_service=false`, posting/executed/live rows `0`, `execution_allowed=false`, `ready_to_upload=false`, `release_allowed=false`, `live_1c_allowed=false`, `live_delete_allowed=false`; взаимодействия с 1С не было. Канонический v0.5 SHA-256 остаётся `B2C7D11B8373E603D0FA0C9B9AF090CF3026085A4E80457B228336CEA3DFAB5A`.

### R005-021 — детерминированная цель внутри группы Инталев ошибочно требует manual approved registry

- Дата: `02.09.2026`
- Статус: `IMPLEMENTED`
- Сообщил: пользовательская карточка `R005-021_DETERMINISTIC_INTALEV_GROUP_TARGET`.
- Наблюдаемое поведение: R005 доказывает физическую ERP-операцию, целевую группу Инталев и ровно одну валидную ERP-статью внутри этой группы со статусом `PROVEN_UNIQUE_TARGET_IN_INTALEV_BLOCK`, но downstream financial gate блокирует REPORT_ONLY-кандидат только из-за отсутствия manual `article_registry_*.approved.json`: `article_approval_status=NO_APPROVED_VERSION`, `financial_gate_reason=APPROVAL_NOT_FINAL`, `correction_rows=[]`.
- Ожидаемое поведение: точная группа из доказанной иерархии Инталев является authority области поиска. Если authoritative ERP-каталог содержит внутри неё ровно одну совпадающую статью/код/путь и нет явного `ЗАПРЕТИТЬ` либо конфликтующего ручного решения, детерминированная машинно доказанная цель допускается как классификационная authority для REPORT_ONLY draft; одноимённая статья другой ERP-группы целью не является.
- Доказательство: `ERP-000000076` / `3 Сахалин` / `2025-01`, run `run_a200d33dade032c7e720d4ad`, физическая строка `1617`, `SourceRowID=2748C4E6F44E8C9273AFE32A3D5B36DE99C1D6FD39FA972B3976D7550059C825`, сумма `1854`, цель `Расходы на складскую логистику / Проезд/доставка сотрудников`, код `ЦБ-000279`, счёт `44.3`.
- Затронутые пункты контракта: §§7, 9.3–9.6, 10.1, 12.2–12.4, 13–14; A07, A08, A10, A17, A21, A22, A32.
- Новое или уточнённое требование: manual approval сохраняет приоритет для override, forbid, ambiguity и unresolved target, но не является обязательным только ради допуска уже уникально доказанной внутри exact Intalev-группы цели к REPORT_ONLY draft. После установления authority все существующие проверки physical ERP row, exact `SourceRowID`, organization/month, uniqueness, amount, reuse и balance выполняются без ослабления.
- Обязательный регрессионный тест: GROUP_A содержит физическую source-статью `ARTICLE_X`, GROUP_B является target group Инталев и содержит ровно одну entry-bound `ARTICLE_X`, manual approved document отсутствует; результат выбирает только GROUP_B, не блокируется `APPROVAL_NOT_FINAL`, расходует `SourceRowID` один раз и создаёт сбалансированную REPORT_ONLY STORNO/REPOST-пару при нулевых posting/live/executed counters. Ноль/несколько целей GROUP_B, missing/non-unique/mismatched/reused physical row и explicit `FORBIDDEN` остаются blocked.
- Реализация: downstream financial gate принимает две classification authority: manual `APPROVED_EXACT_SCOPE` либо exact `PROVEN_UNIQUE_TARGET_IN_INTALEV_BLOCK` при `NO_APPROVED_VERSION`, отсутствии `FORBIDDEN`/конфликта и повторном уникальном разрешении статьи/кода/пути authoritative ERP-каталогом строго внутри proven Intalev block. Затем без перестановки или ослабления выполняются прежние проверки exact organization/month, единственной физической ERP-строки, `SourceRowID`, суммы, reuse и balance; manual approval не синтезируется.
- Протокол проверки: focused R005-021 — `4/4 PASS`; полностью затронутые test files — `39/39 PASS`; production syntax checks — `PASS`. Реальный Sakhalin smoke `run_r005021_20260902_105403` на тех же known-good ZIP для `ERP-000000076` / `3 Сахалин` / `2025-01` сохранил exact сумму `1854`, target block `Расходы на складскую логистику`, article `Проезд/доставка сотрудников`, code `ЦБ-000279`, account `44.3`, status `PROVEN_UNIQUE_TARGET_IN_INTALEV_BLOCK` и больше не остановился на `APPROVAL_NOT_FINAL`; следующий независимый physical guard корректно остановил draft с `PHYSICAL_ORGANIZATION_SCOPE_MISMATCH`. Для этой строки correction/financial pair rows `0`; глобальные posting/executed/live rows `0`, execution/upload/release/live/delete flags `false`, `REPORT_ONLY=true`.
