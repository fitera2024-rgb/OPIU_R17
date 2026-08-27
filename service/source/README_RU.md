# OPIU_STABLE Service — новая совместимая реализация

Эта папка создана заново после удаления исторической папки
`OPIU_Service_Installer_0.4.5_Source`.

Она **не выдаётся за побайтово идентичный исторический исходник**. Статус:
`NEW_COMPATIBLE_IMPLEMENTATION`.

## Что реализовано

- локальный web-сервис без внешних Go-зависимостей;
- бизнес-интерфейс загрузки и перевыбора ERP/Инталев источников;
- организация, ЦФО и период в изолированном контексте;
- архивирование контекста без молчаливого удаления истории;
- очередь и журнал отчётных запусков;
- внутренний паспорт запуска с идентичностью выбранных источников;
- публичный API не раскрывает локальные пути и SHA;
- автоматическое обнаружение проверенного runtime рядом с EXE;
- встроенная последовательность `R005 → Rules → R001` без shell-строк;
- обязательная проверка `SAFETY.json` и общих runtime-зависимостей;
- остановка на пользовательском решении Rules вместо автоматического применения;
- запуск R001 только при наличии явного проверенного handoff;
- внешний argv-only override для технического QA;
- обязательный `REPORT_ONLY` и отказ запуска при попытке включить live 1C.

## Безопасность

Неизменяемые значения:

```text
posting_rows=0
ready_to_upload=false
release_allowed=false
live_1c_allowed=false
```

Сервис не содержит функции проведения, загрузки или изменения данных в 1С.

## Локальная проверка

```bash
go test -race ./...
go vet ./...
go build ./...
node --check web/app.js
```

Windows-сборка:

```bash
GOOS=windows GOARCH=amd64 CGO_ENABLED=0 \
  go build -trimpath -buildvcs=false -ldflags="-s -w -buildid=" \
  -o OPIU_STABLE_Service.exe .
```

## Запуск исходного сервиса

```bash
go run .
```

По умолчанию сервис доступен только локально:

```text
http://127.0.0.1:8765/
```

Рабочие файлы сохраняются в пользовательской конфигурационной папке. Их
локальные пути и контрольные суммы не показываются в обычном интерфейсе.

## Bundled runtime

Review-пакет должен содержать рядом с EXE папку `runtime`, в которой находятся:

```text
runtime/runtime/node/node.exe
runtime/modules/reconciliation/source/opiu_reconcile.mjs
runtime/modules/rules-engine/source/cli.mjs
runtime/modules/corrections/source/correction_engine_r001.mjs
runtime/node_modules
runtime/data/defaults/rules.json
runtime/SAFETY.json
runtime/MANIFEST.json
```

Сервис сначала ищет `OPIU_RUNTIME_ROOT`, затем `runtime` или `payload` рядом с
исполняемым файлом. Runtime принимается только при безопасном manifest и наличии
всех обязательных entrypoint/dependency-файлов.

## Внешний argv-only override

Для отдельного технического QA можно задать одновременно три JSON-массива:

- `OPIU_R005_CMD_JSON`;
- `OPIU_RULES_CMD_JSON`;
- `OPIU_R001_CMD_JSON`.

Частичная настройка запрещена. Shell-интерпретация не используется.

Поддерживаемые placeholders:

```text
{erp} {intalev} {period} {organization} {cfo}
{run_dir} {context_id} {run_id}
```

## Сборка review-пакета

```bash
python development/OPIU_1.9.4/service/packaging/build_reimplemented_service_bundle.py \
  --service-exe OPIU_STABLE_Service.exe \
  --runtime-root <verified-runtime-root> \
  --output-root <empty-output-folder> \
  --source-commit <exact-40-char-commit>
```

Сборщик проверяет runtime manifest, `REPORT_ONLY`, обязательные entrypoints и
зависимости, формирует deterministic ZIP и пишет полный файловый manifest.

## Ограничение статуса

Успешная сборка и технические тесты не подтверждают финансовую правильность,
полноту правил, принятую производительность или готовность релиза. Для этого
нужны отдельные golden, profile, независимый QA и явное решение владельца.
