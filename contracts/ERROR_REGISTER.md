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
