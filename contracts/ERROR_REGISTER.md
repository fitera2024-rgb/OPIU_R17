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
- Статус: `CONTRACTED`
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
- Статус: `NEW`
- Сообщил: независимый downstream review S04.
- Наблюдаемое поведение: R005 загружает approved JSON и добавляет metadata, но downstream target selection её не читает; `evaluateArticleApprovalFinancialGate` вызывается только unit-тестами.
- Ожидаемое поведение: exact-scope `УТВЕРЖДАЮ/ИЗМЕНИТЬ` меняет целевую ERP-статью только после production A22 physical gate; `ЗАПРЕТИТЬ` терминально блокирует, остальные состояния не дают authority.
- Затронутые пункты контракта: §§9.5–9.6, 12.2–12.4, 13–14; A07, A10, A11, A21, A22.
- Допустимый scope: article approval resolver, R005 cross-journal target selection, production integration tests; R001 сохраняет независимый current-run proof и one-row-once.
- Обязательный регрессионный тест: wrong-block override, change, forbid, composite consistency, missing/duplicate/stale/reused ERP row, одна доказанная balanced pair; полный C02 `256/256`.
- Реализация: ожидается.
- Протокол проверки: ожидается.

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
- Статус: `NEW`
- Сообщил: авторитетный acceptance и S09 architecture audit.
- Наблюдаемое поведение: Service выполняет обязательную цепочку `R005 → RULES → R001`, читает mutable registry/legacy defaults и содержит WAIT_USER_RULES/review contour, хотя контракт требует `rules_service=false` и прямой доказательный R005→R001.
- Ожидаемое поведение: Service-owned immutable handoff с SHA/scope/period/proof передаёт R005 напрямую R001; старые 177 rules, registry, `OPIU_RULES_CMD_JSON`, Rules UI/state и defaults не являются runtime dependency.
- Затронутые пункты контракта: §§1, 1.2, 3–7, 9–10, 12–14, 16; A01–A12, A17–A22.
- Допустимый scope: S09 migration по отдельной принятой карте; S04/S06 safety сохраняется, Rules не заменяется скрытым эквивалентом.
- Обязательный регрессионный тест: ровно два stages R005/R001; corrupt SHA/scope/proof блокирует; без physical proof только СПОРНО; package не содержит legacy Rules runtime/defaults.
- Реализация: ожидается.
- Протокол проверки: ожидается.

### R005-008 — у UK отсутствует обязательный лист `08_Операции_журнала`

- Дата: `27.08.2026`
- Статус: `NEW`
- Сообщил: авторитетный acceptance exact HEAD `4e34cc9`.
- Наблюдаемое поведение: UK Oct/Nov создаёт `09_Доказанные_операции`, но не точный обязательный `08_Операции_журнала`; Сахалин формирует required set.
- Ожидаемое поведение: точный обязательный лист существует всегда, включая ноль доказанных операций; старое имя не подменяет контрактное.
- Затронутые пункты контракта: §§10, 13–14; A05, A10, A12–A15.
- Допустимый scope: workbook writer и mandatory-sheet contract tests; consumers мигрируются явно.
- Обязательный регрессионный тест: exact sheet name/order на UK/Sakhalin и пустой run, без формульных ошибок.
- Реализация: ожидается.
- Протокол проверки: ожидается.

### CORR-002 — owner wrapper передаёт запрещённый core-параметр `--decisions`

- Дата: `27.08.2026`
- Статус: `NEW`
- Сообщил: независимый S04 downstream review.
- Наблюдаемое поведение: `service_r001_owner_wrapper.mjs` добавляет `--decisions`, а `correction_engine_r001.mjs` безусловно отклоняет этот параметр; штатный production E2E не может быть доказан.
- Ожидаемое поведение: wrapper и core используют одну contract-bound схему immutable handoff; произвольные решения не получают authority.
- Затронутые пункты контракта: §§7, 9, 12–14; A07–A12, A22.
- Допустимый scope: определяется отдельным audit; safety/proof gates не ослабляются.
- Обязательный регрессионный тест: production wrapper запускает core, exact handoff принят, legacy/arbitrary decisions блокируются, C02 `256/256`.
- Реализация: ожидается.
- Протокол проверки: ожидается.

### R005-009 — октябрьский `R036` расходится с подтверждённым r13

- Дата: `27.08.2026`
- Статус: `CONTRACTED`
- Сообщил: авторитетный acceptance exact HEAD `4e34cc9`.
- Наблюдаемое поведение: golden r13 `R036 Инталев = 10 756 935,99`, delta `+831 254,00`; current `9 560 865,99`, delta `−364 816,00`; exact operations `21 → 16`, остальные 64 top-кода совпали.
- Ожидаемое поведение: при тех же утверждённых входах и scope R036 и физические операции совпадают с golden либо расхождение полностью объяснено доказанной сменой входа/контракта.
- Затронутые пункты контракта: §§4–7, 10, 12–14; A01–A12, A15.
- Допустимый scope: удалить вычитание НДФЛ из исходного контейнера R036 и сохранить доказанный `exact_parent_component` через presentation rollup/coverage; никаких ручных сумм, Rules или бизнес-fixtures.
- Обязательный регрессионный тест: точные physical row identities и суммы пяти операций, source SHA/scope/profile; current R005 восстанавливает golden при неизменных входах либо fail-closed фиксирует доказанный input drift.
- Реализация: диагностика exact detached `4e34cc9` доказала две регрессии commit `8a63606`: `R036=fzpContainer−NDFL` и потерю physical proof через `normalization_trace`; исправление выполняется отдельно.
- Протокол проверки: journal SHA и source inputs совпали; идентифицированы ровно пять physical rows, экономически `19 623,00` consumed once, closing `19 623,00` non-additive; ожидается post-fix real run.

### R005-010 — итоговая книга не соблюдает обязательный состав и порядок листов §12.1

- Дата: `27.08.2026`
- Статус: `NEW`
- Сообщил: независимый workbook-contract review.
- Наблюдаемое поведение: обязательные листы создаются условно и в разном порядке: `01_Правила` раньше дерева, `04A/04B/08_Операции` могут отсутствовать, wrapper добавляет `08_Решения_обоснование` после optional `09`.
- Ожидаемое поведение: все 15 обязательных листов существуют ровно один раз и в порядке §12.1 даже при нуле business rows; optional `09_Доказанные_операции` располагается только после них.
- Затронутые пункты контракта: §§4.2, 6, 9, 10, 12.1, 13–14; A05–A12, A15, A17.
- Допустимый scope: `opiu_reconcile.mjs`, `owner_decision_xlsx.mjs`, focused mandatory-sheets test; суммы, matching, C02 и safety не меняются.
- Обязательный регрессионный тест: UK Oct/Nov, Сахалин и zero-run имеют exact 15 names/order; пустые 04A/04B/08 листы содержат headers и 0 business rows; wrapper заполняет placeholder на месте, optional 09 после обязательного набора; reopen без formula/relationship errors.
- Реализация: ожидается после объединения R005-009 и узкого R005-008.
- Протокол проверки: ожидается.
