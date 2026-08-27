# Интеграция R005

## 1. База

R005 — overlay-кандидат для R004 (`engine/r004_operation_drilldown`, draft PR #35). Не заменяйте им весь runtime и не копируйте в live до review.

## 2. Файлы overlay

```text
arbitrary_period_operation_evidence.mjs
full_operation_evidence.mjs
opiu_reconcile.mjs
run_workdir.mjs
opiu_ui.ps1
```

Перед применением сравните SHA-256 с `SHA256SUMS.txt`.

## 3. Проверка кандидата

Из каталога R005:

```text
node --check arbitrary_period_operation_evidence.mjs
node --check full_operation_evidence.mjs
node --check opiu_reconcile.mjs
node qa/test_arbitrary_period_operation_evidence.mjs
powershell -NoProfile -ExecutionPolicy Bypass -File opiu_ui.ps1 -SelfTest
node qa/validate_r005_sidecars.mjs <july.json> <q2.json> <year.json>
```

Ожидаемые инварианты: `posting_rows=0`, `ready_to_upload=false`, `release_allowed=false`, `UploadID` отсутствует.

## 4. Source binding

- внешний ERP Excel/ZIP фиксируется SHA-256;
- ОПИУ и журнал должны происходить из одного выбранного ERP input;
- фактически прочитанный журнал сверяется с SHA-256 конкретной direct/archive entry;
- рабочая папка запуска уникальна, поэтому параллельные процессы не могут переиспользовать или удалить файлы друг друга;
- при drift/неоднозначности расчёт блокируется.

## 5. Установка кандидата

Устанавливайте только в новый каталог версии, не поверх R004. Ярлык должен указывать на `ui_loader.ps1` каталога R005 и иметь этот же каталог рабочей папкой.

## 6. Rollback

Rollback состоит в возврате к отдельному ярлыку и каталогу R004. R005 не изменяет R004, пользовательские Excel и 1С.

## 7. Release gate

Draft PR не сливать и не использовать для загрузки до полного интеграционного QA, live preflight, проверки дублей/идемпотентности, контроля ОСВ и явного разрешения пользователя.
