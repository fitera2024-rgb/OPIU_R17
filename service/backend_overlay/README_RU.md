# Backend overlay Service 1.9.4

Каталог фиксирует проверяемые backend-дельты Service 1.9.4. Контракты R005, Rules и R001 из предшествующих CR сохраняются. `CR-SVC-20260811-005` меняет только Service/UI orchestration нормального запуска R005 и усиливает fail-closed проверки источников.

## Нормальный запуск R005

Браузер отправляет только бизнес-намерение запуска. Service сам строит точное доказательство из canonical persisted state и допускает маршрут лишь при наличии одной однозначной пары ERP + Инталев для выбранных организации и периода.

Внутренний порядок остаётся двухшаговым:

1. preflight проверяет точные байты, контекст и роли, не создавая RUN;
2. подтверждение неизменного результата preflight может создать ровно один RUN;
3. drift, неоднозначность, внешний путь, подмена evidence или контекста блокируются до RUN.

Имена файлов, время загрузки, newest/latest и fuzzy matching не являются основанием выбора. Технические пути, хеши и blocker codes не выдаются обычному браузеру; `/api/bootstrap` содержит только санитизированную бизнес-готовность.

Прямые запросы к `/api/engine/prepare` и `/api/modules/open` не обходят proof gate. Все evidence/root paths должны находиться внутри `InputsDir`. Unsafe evidence, включая `live_1c_allowed=true`, отклоняется.

## Применение и проверки

Overlay накладывается на отдельно доказанный полный service-source 1.9.4:

1. проверить базовые байты по `BASELINE_PROVENANCE.json`;
2. наложить `.go`-файлы на корень полного Service source;
3. выполнить `gofmt`;
4. выполнить `go test -count=1 ./...` и `go vet ./...`;
5. не собирать package/release без отдельного CR и release approval.

Safety-контракт неизменен: `posting_rows=0`, `ready_to_upload=false`, `release_allowed=false`, `live_1c_allowed=false`. Rules и R001 доступны только после валидированного активного RUN/handoff. Финансовая логика, mappings, formulas и source rules не изменяются этим overlay.
