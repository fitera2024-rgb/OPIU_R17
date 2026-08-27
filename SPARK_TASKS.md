# Очередь задач Codex Spark

Статусы: `READY`, `RUNNING`, `REVIEW`, `MERGED`, `BLOCKED`.

Новые задачи выдаёт координатор. Запуск выполняет пользователь. Задача без текущего контракта блокируется.

| ID | Статус | Область | Цель |
|---|---|---|---|
| S00 | MERGED | Репозиторий | Чистый baseline и независимый аудит отличий R16 |
| S01 | READY | R005/R001 | Контролируемо импортировать production-реализацию R16 без runtime-мусора |

## Шаблон карточки

```text
ID и одна цель:

Контракт:
- файл: contracts/Контракт_ОПИУ_v0.2_зафиксированный.docx
- версия: 0.2
- SHA-256: 4C64998B675B6D0F910DA557CE1CBE20C5E15A023C75830CC145FC95DA6B540A
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
2. Наложить runtime/modules/reconciliation/source и runtime/modules/corrections/source поверх одноимённых каталогов R17 только для *.mjs.
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
