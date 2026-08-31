# CONTRACT_V05_MONTHLY_ONLY_PERIOD — acceptance record

Дата: `31.08.2026`

## Source of truth

- Repository base: `release/r17` at exact SHA `cf639eacf5dcc232cf2d2ebc80780994f68e821b`.
- Previous canonical contract: v0.4, SHA-256 `09AB635802E436C2C33E2FD39D8B35E62631376AB9AE8DA6F6EFC23EAF844BCD`.
- New canonical contract: v0.5, `contracts/Контракт_ОПИУ_v0.5_зафиксированный.docx`.
- v0.5 SHA-256: `B2C7D11B8373E603D0FA0C9B9AF090CF3026085A4E80457B228336CEA3DFAB5A`.
- v0.4 remains byte-identical at its recorded SHA-256.

## Product decision

Один запуск расчета выполняется за один полный календарный месяц.

Один расчёт имеет точную область: одна организация + один `YYYY-MM`. Значения `YYYY`, `YYYY-QN` и произвольные диапазоны дат/нескольких месяцев не поддерживаются как calculation scope. Автоматического годового fan-out в R17 нет. Год обрабатывается двенадцатью независимыми последовательными месячными запусками.

Годовой ERP/Инталев файл или ZIP допустим только как source container, если выбранный месяц детерминированно доказан из содержимого. Организация, период, R005 evidence, `SourceRowID`/provenance, handoff, R001 result и approval scope принадлежат одному месячному запуску и не переносятся между месяцами. Межмесячное неттирование и повторное использование физической ERP-строки запрещены.

## Acceptance mapping

| User criterion | Contract criterion | Required proof |
|---|---|---|
| A | A25 | Валидный запуск одной организации за полный `YYYY-MM` формирует независимый комплект. |
| B | A26 | `YYYY` отклоняется до создания расчёта. |
| C | A27 | `YYYY-QN` отклоняется до создания расчёта. |
| D | A28 | Произвольный диапазон/несколько месяцев отклоняются. |
| E | A29 | Годовой ZIP/файл используется только как контейнер доказуемо выбранного месяца. |
| F | A30 | Два последовательных месяца не смешивают organization/period, evidence, provenance, handoff, R001 или approvals. |
| G | A31 | Нет межмесячного netting; физическая ERP-строка не переиспользуется. |
| H | A32 | Все REPORT_ONLY и 1С safety guards неизменны. |

## FY-001 disposition

- Annual mode удалён из продуктового требования, а не объявлен технически исправленным.
- Existing month mode остаётся обязательным.
- Диагностика FY-001 сохраняется как историческое evidence.
- Draft PR #19 не подлежит merge.

## Safety and scope controls

- `REPORT_ONLY=true`
- `rules_service=false`
- `posting_rows=0`
- `executed_posting_rows=0`
- `live_posting_rows=0`
- автоматическая загрузка в 1С отсутствует
- проведение в 1С отсутствует

В этой задаче не изменялись production, UI или Service code; не реализовывались fan-out, изменение JSON/Service limits, ослабление month guards или сборка EXE.

## Contract QA

- DOCX создан как новая версия; v0.4 не редактировался.
- Microsoft Word 16 → PDF → PNG at 144 DPI: `22/22` pages visually inspected, `PASS`.
- No clipping, overlap, broken tables, missing glyphs or orphaned headings: `PASS`.
- A25–A32 and the explicit monthly-only sentence are present: `PASS`.
- DOCX ZIP/package, sections, styles, fields and required content: `PASS`.
