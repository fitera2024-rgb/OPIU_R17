# Происхождение baseline

## Исторический источник

- Репозиторий: `C:\Users\NB-FIT\Documents\ChatGPT\OPIU_ST_integration_0825`
- Поддерево: `development\OPIU_1.9.4`
- Ветка: `codex/pkg-runtime-settings-alias-0826`
- Commit: `4b8e7ce5e7ed9a18ee1401a54f4e05facf039b93`
- Дата импорта: 27.08.2026

Tracked-файлы импортированы непосредственно из указанного commit, а не из смешанного рабочего дерева.

## Дополнительно материализованы

Следующие обязательные runtime-материалы отсутствовали в историческом Git и перенесены из локального продукта:

- `SAFETY.json`;
- `data/defaults/**`;
- `modules/reconciliation/source/external_reference/**`;
- `modules/reconciliation/source/resources/**`.

## Намеренно исключены

- `modules/reconciliation/source/work/**`;
- прежние `results`, временные распаковки и журналы запусков;
- `node_modules`, `__pycache__`, логи и сборочные кэши;
- готовые ZIP/EXE до их отдельной проверки.

Пакет `OPIU_R16` рассматривается как отдельный источник проверенных изменений. Его файлы переносятся после сравнения, а не поверх baseline вслепую.

