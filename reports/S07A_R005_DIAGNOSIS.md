# S07-A - диагностика четырёх оставшихся падений R005

Дата: 27.08.2026

Репозиторий: `C:\Users\NB-FIT\Documents\OPIU_R17`

Контракт: `contracts/Контракт_ОПИУ_v0.4_зафиксированный.docx`, версия `0.4`
SHA-256: `09AB635802E436C2C33E2FD39D8B35E62631376AB9AE8DA6F6EFC23EAF844BCD`

## Итог

Все четыре падения разделяются на независимые области. Исправления в этом отчёте не применялись.

| # | Тест | Root cause | Что исправлять | Минимальный scope |
|---|---|---|---|---|
| 1 | `profile_detector_12_test.mjs` | Production-справочник R17 отстаёт от подтверждённого R16 на один allowed root profile | Production data | Один профиль в `modules/reconciliation/source/organization_profiles.json` |
| 2 | `sakhalin_operation_evidence_test.mjs` | Не передан обязательный внешний XLSX журнала | Test harness / внешний acceptance input | Передать путь журнала аргументом 1 или `SAKHALIN_JOURNAL_XLSX` |
| 3 | `service_r005_owner_wrapper_inventory.test.mjs` | В production-wrapper удалён authoritative projection и заменён сырым payload | Production | Восстановить один helper, его import и одну передачу в v3 materializer |
| 4 | `structural_control_report_detail.test.mjs` | В R17 production отсутствует интеграция detail-builder в `07_Контроли`, а не только устарела форма вызова | Production | Восстановить import и существующий detail append в `opiu_reconcile.mjs` |

Scopes не пересекаются: `organization_profiles.json`, внешний input, `service_r005_owner_wrapper.mjs` и `opiu_reconcile.mjs` соответственно. Тесты менять не требуется.

## Контрактная рамка

Проверены §§3-6, 9-11, 13-14, критерии A01-A07, A09-A12 и приложение B.

- §3 требует точную организацию и период, обязательные колонки журнала и сохранение диагностического результата при неоднозначности.
- §4 требует независимые деревья Инталев и ERP, запрещает перенос к случайному родителю и запрещает закрытый список расходных блоков.
- §4.3 прямо требует сохранять административные, коммерческие, транспортные, складские, финансовые и другие фактические блоки, а также дочерние детали.
- §§5-6 требуют раскрывать дельту внутри, использовать конкретные физические строки журнала и не использовать одну строку повторно.
- §§9-10 требуют сохранять фактическую структуру, заранее формировать диагностический реестр и продолжать проверку дочерних строк даже при нулевой групповой дельте.
- §11 требует понятную причину ошибки и завершение расчёта; §13 сохраняет `REPORT_ONLY`, физическое доказательство и нулевой posting без доказательства.
- §14 фиксирует контрольные прогоны для 9 УК, изменённой структуры и 3 Сахалина за январь 2025.
- A01, A02 и A04 защищают наличие всех блоков, независимость деревьев и раскрытие дельты; A06 и A07 - привязку журнала и отсутствие повторного использования строк; A09-A12 - заранее заполненный реестр, физическое доказательство, понятное содержание и отсутствие ошибок Excel.
- Приложение B подтверждает, что журнал ERP обязателен для корректировок, физическая операция - это конкретная строка, а `СТОРНО/РЕПОСТ` не создаются по одной статье или догадке.

## 1. `profile_detector_12_test.mjs`

### Наблюдение и root cause

`modules/reconciliation/source/profile_detector_12_test.mjs:31` требует ровно 13 `allowed_root` профилей и включает `Управленческая организация` с id `ROOT_MANAGEMENT_ORGANIZATION_REVIEW` в ожидаемый список.

В R17 `modules/reconciliation/source/organization_profiles.json` фактически 12 профилей с `allowed_root: true`; записи `ROOT_MANAGEMENT_ORGANIZATION_REVIEW` там нет. В подтверждённом R16 тот же тест и тот же registry дают 13 профилей; отсутствующая запись находится в R16 на строках 120-121. Хэши registry: R17 `B8E2348C196977FF8FD7D900F5AFBE1BE4EB690DBEA4EA4D20275C5AEF1E8E9E`, R16 `389C444B31B2AB2BA8BFB9820F58EE1CB7737A329AB33FAA89A176B81C7F174C`.

`organization_profile_registry.mjs` не содержит ограничения «12» и корректно ищет только профили с `allowed_root: true`. Следовательно, причина - production reference-data drift, а не ошибка detector и не повод менять ожидаемое число в тесте.

### Contract classification

Production configuration / R16 inventory compatibility; §§3-4, A02. Это область организаций и профилей, не каталог расходных блоков. Добавление профиля не должно менять суммы или фильтрацию дерева расходов.

### Минимальный patch scope

Изменить только `modules/reconciliation/source/organization_profiles.json`: дословно восстановить один authoritative R16 object `ROOT_MANAGEMENT_ORGANIZATION_REVIEW` для `Управленческая организация`, включая его `organization_code`, `allowed_root`, fail-closed `status`, `profile_kind` и `rules_path`. Не менять detector, список `expected` в тесте или другие профили.

### Тест до/после

- До, R17: `profile_detector_12_test.mjs`, `exit=1`, assertion `12 !== 13`.
- Контроль после на R16: `1 test / 1 pass / 0 fail`, `PROFILE_DETECTOR_13_13=PASS`.
- После будущего точечного data patch в R17: тот же Node 24 test должен дать `1 pass / 0 fail`; production patch в этой задаче намеренно не выполнялся.

## 2. `sakhalin_operation_evidence_test.mjs`

### Наблюдение и root cause

Тест в `modules/reconciliation/source/sakhalin_operation_evidence_test.mjs:16` получает `journalPath` только из `process.argv[2]` или `SAKHALIN_JOURNAL_XLSX`; на строке 24 он fail-closed проверяет обязательность этого значения. Без input тест завершается до чтения журнала с ошибкой `Pass the extracted Sakhalin journal XLSX as argument 1`.

Это не production-расчётная ошибка. При корректном внешнем журнале текущий R17 production-контур успешно прочитал `4033` строки, выбрал `39` строк точной организации, нашёл `21` строку `ПРР внешние`, получил debit/credit по `144000` и сохранил `posting_rows=0`.

Попытка с файлом `ЦМД Сахалин_Проводки_УправленческийПланСчетов_2025-01.xlsx` из R16 дала честный `BLOCKED_JOURNAL_SHEET_DRIFT: Лист_1`, потому что это Intalev `TDSheet`, а не требуемый ERP-журнал. Значит, нужен не любой XLSX, а извлечённый ERP journal с ожидаемым листом и колонками.

### Contract classification

Test harness / external acceptance input; §§3 и 6, §§11 и 13, A06 и A10. Контракт требует журнал как доказательство и разрешает блокировать финансовую часть при его отсутствии; он не разрешает скрыто подставлять другой источник.

### Минимальный patch scope

Не менять `sakhalin_operation_evidence_test.mjs` и production. В acceptance command передавать извлечённый ERP-журнал Сахалина аргументом 1 либо задать `SAKHALIN_JOURNAL_XLSX`. Для полного data-driven варианта сохранить порядок опциональных аргументов 2-5: UK companion, ERP OPIU и ERP archive. Внешний путь не является файлом репозитория.

Пример фактически прошедшего контроля:

```text
node --experimental-loader file:///C:/Users/NB-FIT/Documents/OPIU_R17/.qa/s03-r16-deps-loader.mjs \
  modules/reconciliation/source/sakhalin_operation_evidence_test.mjs \
  "C:\Users\NB-FIT\Documents\Codex\2026-08-25\c-users-nb-fit-documents-chatgpt\work\erp_clean_sim_20260826\sakh_before\1С_ERP_Управление_холдингом_3 Сахалин_2025-01_01_Журнал_проводок_МСФО.xlsx"
```

### Тест до/после

- До, R17 без аргумента: `exit=1`, `Pass the extracted Sakhalin journal XLSX as argument 1`.
- Контроль после с корректным внешним input: `exit=0`, `PASS_SAKHALIN_OPERATION_EVIDENCE_SCOPE`, `selected_exact_organization_rows=39`, `posting_rows=0`.
- После будущего acceptance rerun с тем же корректным input должен оставаться `exit=0`; production/test patch не нужен.

## 3. `service_r005_owner_wrapper_inventory.test.mjs`

### Наблюдение и root cause

На `modules/reconciliation/source/service_r005_owner_wrapper_inventory.test.mjs:9` происходит ESM named-export failure: R17 `service_r005_owner_wrapper.mjs` не экспортирует `authoritativeStructuralInventoryHierarchyPeriodsFromPayload`.

В R17 wrapper импортирует `materializeStructuralControlInventoryV3` на строке 10 и на строке 295 передаёт в него `hierarchyPeriods: payload.hierarchy_periods` напрямую. В подтверждённом baseline wrapper есть authoritative projection на строках 49-71: он выравнивает `period_rows` с `hierarchy_periods`, переносит суммы `intalev/erp`, извлекает уникальные `erp.trace` paths и вызывает `buildAuthoritativeStructuralControlInventoryHierarchyPeriod`. На строке 326 baseline передаёт результат этого helper в v3 materializer.

Это реальный production-wrapper gap, а не устаревший тест: projection защищает exact period binding и отличает authoritative hierarchy nodes от сырого отображения. Удаление проверки или экспорт пустой заглушки ослабит fail-closed поведение.

### Contract classification

Production API/projection gap; §§4-6, §§10 и 13, A01, A02, A04 и A07. Нужны две независимые иерархии, точный период, раскрытая дельта и отсутствие повторного использования физических строк.

### Минимальный patch scope

Изменить только `modules/reconciliation/source/service_r005_owner_wrapper.mjs`:

1. Восстановить import `buildAuthoritativeStructuralControlInventoryHierarchyPeriod` из `structural_control_authoritative_candidates.mjs`.
2. Восстановить локальные `normalizedText` и `uniqueTracePaths`, если они ещё отсутствуют.
3. Восстановить экспорт `authoritativeStructuralInventoryHierarchyPeriodsFromPayload(payload)` с проверкой совпадения периода и преобразованием `period_rows` в authoritative hierarchy periods по baseline lines 49-71.
4. Заменить только значение `hierarchyPeriods` в вызове v3 materializer на `authoritativeStructuralInventoryHierarchyPeriodsFromPayload(payload)`.

Не менять тест, `structural_control_inventory_v3.mjs`, `modules/corrections/**`, `service/**`, S04/S06 или Rules Service.

### Тест до/после

- До, R17: ESM import failure, `exit=1`, `does not provide an export named 'authoritativeStructuralInventoryHierarchyPeriodsFromPayload'`.
- Контроль после на baseline source: `2 tests / 2 pass / 0 fail`, включая fail-closed period drift.
- После будущего точечного production patch в R17: `service_r005_owner_wrapper_inventory.test.mjs` должен дать `2 pass / 0 fail`; тест нельзя делать зелёным удалением проверки периода.

## 4. `structural_control_report_detail.test.mjs`

### Наблюдение и root cause

Два unit-case detail-builder в `modules/reconciliation/source/structural_control_report_detail.test.mjs` проходят. Падает только integration assertion на строке 76, которая проверяет, что production вызывает builder и добавляет бизнес-детали в `07_Контроли`.

Проверка исходников даёт однозначный результат:

- R17 `structural_control_report_detail.mjs` содержит рабочие `STRUCTURAL_CONTROL_REPORT_DETAIL_HEADERS` и `buildStructuralControlReportDetail` на строках 37 и 60; builder fail-closed с `financial_rows=0` и `posting_rows=0` на строках 100-107.
- В R17 `modules/reconciliation/source/opiu_reconcile.mjs` нет ни одного вхождения `buildStructuralControlReportDetail`, `STRUCTURAL_CONTROL_REPORT_DETAIL_HEADERS` или `structuralControlDetail`.
- Baseline содержит import builder/header на строках 118-120, вызов с `controls: reportStructuralControlResults` и `settingsAudit: structuralControlSettingsAudit` на строках 9147-9150, а также заголовок, headers и rows detail table на строках 9264-9268.

Следовательно, это реальный production integration gap, не просто устаревшая точная форма вызова. Тестовая regex-форма здесь корректно обнаруживает отсутствие целого output path. Менять regex на более слабую проверку нельзя.

### Contract classification

Production reporting integration gap; §§4-6, §§10-11 и 13, A01, A02, A04, A09, A11 и A12. `07_Контроли` должен сохранить summary и раскрывать выбранные Intalev/ERP members, не создавать финансовые строки и не скрывать дельту.

### Минимальный patch scope

Изменить только `modules/reconciliation/source/opiu_reconcile.mjs`, восстановив существующую baseline-связку:

1. Добавить import `buildStructuralControlReportDetail` и `STRUCTURAL_CONTROL_REPORT_DETAIL_HEADERS`.
2. После расчёта `reportStructuralControlResults` построить `structuralControlDetail` с `controls: reportStructuralControlResults` и `settingsAudit: structuralControlSettingsAudit`.
3. Оставить существующий summary `07_Контроли` и дописать title, headers и rows detail table с расчётом конечной строки.
4. Сохранить `financial_rows=0` и `posting_rows=0`; не превращать structural control в STORNO/REPOST.

Не менять сам builder, его тест, `modules/corrections/**`, `service/**`, S04/S06 или Rules Service.

### Тест до/после

- До, R17: `3 tests / 2 pass / 1 fail`, `exit=1`; падает только `07_Контроли keeps its summary and appends the business detail table` на отсутствии вызова в production source.
- Контроль после на baseline source: `3 tests / 3 pass / 0 fail`.
- После будущего точечного production patch в R17: тот же тест должен дать `3 pass / 0 fail`; отдельно сохранить проверку нулевых financial/posting rows.

## Сохранение фактических блоков и финансовый барьер

Коммерческие, административные, транспортные, складские и иные фактические блоки не должны исчезать. Это прямое требование §4.3, A01 и приложения B, а не побочный эффект теста.

Предлагаемые scopes не удаляют ни один такой блок:

- пункт 1 добавляет организационный профиль, не меняет expense hierarchy;
- пункт 2 добавляет только внешний источник журнала; кандидатные строки остаются review-only;
- пункт 3 восстанавливает authoritative projection двух деревьев и period binding, не фильтрует экономические строки;
- пункт 4 добавляет detail table к существующему summary и не заменяет исходные суммы.

Во всех четырёх вариантах сохраняются `rules_service=false`, `REPORT_ONLY=true`, запрет повторного использования физической строки и отсутствие готовых STORNO/REPOST без уникального физического ERP-доказательства. Сахалинский контроль с внешним журналом фактически подтвердил `posting_rows=0`.

## Протокол и состояние рабочей копии

До S07-A R17 уже был dirty: `git status --short` показал чужие изменения в `SPARK_TASKS.md`, `STATUS.md`, `contracts/ERROR_REGISTER.md`, `modules/corrections/**`, `modules/reconciliation/source/opiu_reconcile.mjs`, `service/**`, а также подготовленные S04/S06/C02 файлы. Эти изменения сохранены и этим отчётом не затрагивались.

В рамках S07-A добавлен только этот файл. Поэтому scoped diff S07-A должен содержать только `reports/S07A_R005_DIAGNOSIS.md`; полный `git diff` рабочей копии неизбежно также показывает перечисленные ранее чужие изменения. Коммит не создавался.
