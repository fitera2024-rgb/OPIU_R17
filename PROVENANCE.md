# Происхождение baseline

## Исторический источник

- Репозиторий: `C:\Users\NB-FIT\Documents\ChatGPT\OPIU_ST_integration_0825`
- Поддерево: `development\OPIU_1.9.4`
- Ветка: `codex/pkg-runtime-settings-alias-0826`
- Commit: `4b8e7ce5e7ed9a18ee1401a54f4e05facf039b93`
- Дата импорта: 27.08.2026

Tracked-файлы импортированы непосредственно из указанного commit, а не из смешанного рабочего дерева.

## Дополнительно перенесены в baseline

В первый baseline были перенесены следующие локальные материалы:

- `SAFETY.json`;
- `data/defaults/**`;
- `modules/reconciliation/source/external_reference/**`;
- `modules/reconciliation/source/resources/**`.

Независимый аудит после baseline установил, что `data`, `external_reference` и `resources` в development-дереве были junction-ссылками на старый релиз. Поэтому эти файлы не считаются окончательным каноническим набором R17. Следующий отдельный commit должен:

- заменить справочники физическими проверенными файлами из `outputs/OPIU_R16/runtime`;
- удалить legacy `data/defaults` старого Rules Service;
- сохранить manifest и SHA-256 канонических справочников.

## Намеренно исключены

- `modules/reconciliation/source/work/**`;
- прежние `results`, временные распаковки и журналы запусков;
- `node_modules`, `__pycache__`, логи и сборочные кэши;
- готовые ZIP/EXE до их отдельной проверки.

Пакет `OPIU_R16` рассматривается как отдельный источник проверенных изменений. Его файлы переносятся после сравнения, а не поверх baseline вслепую.
