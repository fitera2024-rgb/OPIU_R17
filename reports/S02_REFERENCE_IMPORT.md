# S02 — канонические справочники R16

Статус: **PASS**  
Дата: 27.08.2026  
Коммит реализации: `19822da4f03dcf0dde046f9078678bb1b7886138`

## Контракт

- версия: `0.2`;
- SHA-256: `4C64998B675B6D0F910DA557CE1CBE20C5E15A023C75830CC145FC95DA6B540A`;
- Rules Service не переносился;
- режим безопасности не изменён: `report_only=true`, публикация и загрузка в 1С запрещены.

## Результат

- физически зафиксирован 21 справочный файл;
- для каждого файла проверены существование, размер и SHA-256;
- четыре SHA-привязки `config.json` проверены;
- два отсутствующих справочника Инталев обозначены как optional, а не подменены догадками;
- добавлена иерархия организаций ERP и план счетов ERP;
- удалены восемь tracked-файлов `data/defaults` старого Rules Service;
- junction/reparse points и запрещённые runtime-каталоги отсутствуют;
- 71/71 производственных MJS совпадают с проверенным R16;
- `git diff --check` и независимый guard: PASS.

Канонический инвентарь: `resources/reference/R17_REFERENCE_MANIFEST.json`.

## Намеренно отсутствуют

1. `modules/reconciliation/source/external_reference/intalev_articles.xlsx` — optional fallback; рабочая классификация извлекается из выбранного архива Инталев.
2. `modules/reconciliation/source/external_reference/intalev/01_Показатели.csv` — роль `intalev_uid`, в исходном R16 имеет статус `MISSING`.

## Ключевые SHA-256

- `ERP_Аналитики_ОПИУ.xlsx`: `9B887E42EEDE2E37939A0B3E4AC10FD1F64F360A2724BE03CF0562FC6220DD35`;
- `ERP_Показатели_ОПИУ.xlsx`: `914BF4EED2A636FB6EF5006BC688457A93577BD318625C239C8CF19B218E109B`;
- `ERP_Формулы_ОПИУ.xlsx`: `E8644766E8E46F9978F64EA88BB119A4A6125A00A3711B21942D035DA1F1D1CE`;
- `ОрганизациииерархияЕРП.xlsx`: `3342603C0782FE12871AD55E7E19E778A97651E8CFF2E00F0CE6774295C57522`;
- `ПланСчетов_ERP.mxl`: `867E493B4458975D2EF798452F4AD5C249DB9DD378454E5332188D200755A1CD`.

## Независимая проверка

Агент-аудитор подтвердил: 21/21 файлов, 4/4 config pins, 71/71 production MJS, 0 reparse, 0 запрещённых каталогов, ровно 8 удалений legacy defaults.
