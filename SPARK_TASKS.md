# Очередь задач Codex Spark

Статусы: `READY`, `RUNNING`, `REVIEW`, `MERGED`, `BLOCKED`.

Новые задачи выдаёт координатор. Запуск выполняет пользователь. Задача без текущего контракта блокируется.

| ID | Статус | Область | Цель |
|---|---|---|---|
| S00 | MERGED | Репозиторий | Чистый baseline и независимый аудит отличий R16 |
| S01 | MERGED | R005/R001 | Production-реализация R16, commit `8a63606a` |
| S02 | MERGED | Справочники | 21 физический ref, legacy Rules Service data удалён, commit `19822da4` |
| S03 | READY | Тесты | Объединить свежие тесты R16 и полный применимый контур R001 из исходного репозитория |

## Шаблон карточки

```text
ID и одна цель:

Контракт:
- файл: contracts/Контракт_ОПИУ_v0.3_зафиксированный.docx
- версия: 0.3
- SHA-256: 3E42344A1C4668913AD7DF2AF9748FF0D9648229DA97CE751F1076811892EE78
- применимые разделы:

Входы:
Разрешено изменять:
Запрещено:
Шаги:
PASS:
Отчёт:
```

## S01 — импорт production-реализации R16

```text
ID и одна цель:
S01. Перенести поверх чистого baseline только production-файлы R005/R001 из финального R16, не удаляя отсутствующие в пакете baseline-файлы.

Контракт:
- прочитать AGENTS.md и contracts/CURRENT.md до первой мутации;
- файл: contracts/Контракт_ОПИУ_v0.2_зафиксированный.docx;
- версия: 0.2;
- SHA-256: 4C64998B675B6D0F910DA557CE1CBE20C5E15A023C75830CC145FC95DA6B540A;
- разделы: 1, 4–8, 10, 13–16 и приложение B.

Входы:
- репозиторий: C:\Users\NB-FIT\Documents\OPIU_R17;
- подтверждённый пакет: C:\Users\NB-FIT\Documents\Codex\2026-08-25\c-users-nb-fit-documents-chatgpt\outputs\OPIU_R16;
- manifest: PACKAGE_MANIFEST.json, SHA-256 EE7128280F90207CE3EBA10DBF9FF61A8C33230817A807F10B250EF4731A5EC4.

Разрешено изменять:
- modules/reconciliation/source/*.mjs;
- modules/corrections/source/*.mjs.

Запрещено:
- удалять baseline-файлы, которых нет в R16;
- менять PowerShell/UI, справочники, user-settings, контракт и документы координации;
- переносить node_modules, work, outputs, results, *.log, EXE, ZIP и data/ui-context;
- возвращать Rules Service;
- выполнять git commit.

Шаги:
1. Сверить входной manifest и его SHA-256.
2. Наложить runtime/modules/reconciliation/source и runtime/modules/corrections/source поверх одноимённых каталогов R17 только для production MJS; явно исключить `*.test.mjs` и `*_test.mjs`.
3. Не удалять дополнительные baseline-тесты.
4. Показать git diff --stat, перечень новых/изменённых файлов и git diff --check.

PASS:
- ключевой modules/reconciliation/source/opiu_reconcile.mjs имеет SHA-256 AE9477886F8C8D8E88CC60BA889E9D652209E4AB3EBAE2BDD7FB0DCBB411F82E;
- modules/corrections/source/correction_engine_r001.mjs имеет SHA-256 EF2F8E314482E9EE9E127FFF863CCE43623872795673D91F80578E67141E2546;
- добавлены journal-first и self-discovery production-модули R16;
- нет удалений baseline-файлов;
- запрещённых путей в git status нет;
- git diff --check не сообщает ошибок.

Отчёт:
- статус PASS/FAIL;
- изменённые и новые файлы;
- фактические SHA ключевых файлов;
- команды проверки и полный вывод ошибок, если они есть;
- коммит не создавать.
```

## S02 — канонические справочники без junction и legacy Rules Service

```text
ID и одна цель:
S02. Заменить старые/junction-зависимые справочники R17 физическими проверенными файлами R16 и удалить legacy data/defaults старого Rules Service.

Контракт:
- прочитать AGENTS.md и contracts/CURRENT.md до первой мутации;
- файл: contracts/Контракт_ОПИУ_v0.2_зафиксированный.docx;
- версия: 0.2;
- SHA-256: 4C64998B675B6D0F910DA557CE1CBE20C5E15A023C75830CC145FC95DA6B540A;
- разделы: 1, 3–6, 9, 13–16 и приложение B.

Входы:
- репозиторий: C:\Users\NB-FIT\Documents\OPIU_R17;
- источник: C:\Users\NB-FIT\Documents\Codex\2026-08-25\c-users-nb-fit-documents-chatgpt\outputs\OPIU_R16\runtime;
- manifest R16 SHA-256: EE7128280F90207CE3EBA10DBF9FF61A8C33230817A807F10B250EF4731A5EC4.

Разрешено изменять:
- modules/reconciliation/source/external_reference/**;
- modules/reconciliation/source/resources/**;
- modules/reconciliation/source/config.json;
- modules/reconciliation/source/r005_intalev_template_graph.current.json;
- modules/reconciliation/source/reference_catalog_manifest.current.json;
- resources/reference/**;
- data/defaults/** только для удаления legacy;
- отдельный manifest SHA справочников.

Запрещено:
- менять *.mjs, тесты, UI, контракт и user-settings;
- переносить work, results, logs, cache, drafts, EXE, ZIP, node_modules, data/ui-context;
- переносить rules.json, runs.json, approvals и состояние старого Rules Service;
- выполнять git commit.

PASS:
- все обязательные справочники R16 физически присутствуют и являются обычными файлами, не junction;
- присутствует resources/reference/ОрганизациииерархияЕРП.xlsx;
- manifest справочников и все SHA проходят;
- legacy data/defaults удалён из tracked-файлов;
- отсутствующий optional intalev_articles.xlsx не маскируется и обозначен как optional;
- git diff --check PASS, запрещённых путей в status нет.

Отчёт:
- PASS/FAIL, новые/изменённые/удалённые файлы;
- manifest и SHA;
- список намеренно отсутствующих optional refs;
- коммит не создавать.
```

## S03 — единый тестовый контур R005/R001

```text
ID и одна цель:
S03. Объединить свежие тесты R005 из финального R16 с полным baseline-контуром R001, не возвращая runtime Rules Service и не меняя production-код.

Контракт:
- прочитать AGENTS.md и contracts/CURRENT.md до первой мутации;
- файл: contracts/Контракт_ОПИУ_v0.3_зафиксированный.docx;
- версия: 0.3;
- SHA-256: 3E42344A1C4668913AD7DF2AF9748FF0D9648229DA97CE751F1076811892EE78;
- разделы: 1, 4–14, 16 и приложение B;
- UI-001/A16 относится к следующей UI-задаче: в S03 требуется зафиксировать отсутствие такого теста, но launcher не изменять.

Входы:
- репозиторий: C:\Users\NB-FIT\Documents\OPIU_R17;
- свежие тесты R16: C:\Users\NB-FIT\Documents\Codex\2026-08-25\c-users-nb-fit-documents-chatgpt\outputs\OPIU_R16\runtime;
- полный baseline R001: C:\Users\NB-FIT\Documents\ChatGPT\OPIU_ST_integration_0825\development\OPIU_1.9.4;
- contract v0.3 SHA-256: 3E42344A1C4668913AD7DF2AF9748FF0D9648229DA97CE751F1076811892EE78.

Разрешено изменять:
- только `modules/reconciliation/source/*.test.mjs` и `modules/reconciliation/source/*_test.mjs`;
- только `modules/corrections/source/*.test.mjs` и `modules/corrections/source/*_test.mjs`;
- отдельный test inventory/report без runtime-артефактов.

Запрещено:
- менять production MJS, PowerShell/UI, справочники, контракт, user-settings и package-файлы;
- переносить Rules Service, `data/defaults`, work, results, logs, cache, node_modules, EXE или ZIP;
- удалять baseline-only тест без отдельного письменного обоснования;
- выполнять git commit.

Шаги:
1. Для R005 наложить 31 тест R16 и сохранить пять baseline-only тестов: `owner_nested_parent_invariants.test.mjs`, `service_r005_owner_wrapper_inventory.test.mjs`, `structural_control_authoritative_candidates.test.mjs`, `structural_control_current_hierarchy_binding.test.mjs`, `structural_control_report_detail.test.mjs`.
2. Для R001 наложить свежий `r001_group_scoped_posting_rule.test.mjs` из R16 и сохранить остальные baseline-тесты.
3. Отдельно перечислить тесты, импортирующие `modules/rules-engine`; они являются legacy-аудитом и не доказывают разрешение Rules Service в runtime.
4. Запустить все R005 и R001 тесты Node 24 с `--test --test-force-exit`.
5. Зафиксировать количество файлов и тест-кейсов, время, exit code и полный перечень ошибок.

PASS:
- R005 test files: 36; R001 test files: 25 до отдельного решения об удалении legacy-аудитов;
- все свежие тесты R16 присутствуют с точными SHA-256 источника;
- пять baseline-only R005 и полный baseline R001 не потеряны;
- production MJS diff относительно commit `8a63606a` отсутствует;
- тесты завершаются самостоятельно, exit code 0, failed 0;
- нет runtime Rules Service state и запрещённых путей;
- `git diff --check` PASS.

Отчёт:
- PASS/FAIL;
- изменённые и новые тесты с источником и SHA-256;
- количество test files/test cases/passed/failed;
- legacy Rules Service imports отдельным списком;
- UI-001/A16 отмечен как обязательный будущий launcher regression test;
- коммит не создавать.
```
