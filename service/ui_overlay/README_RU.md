# UI overlay Service 1.9.4 — CR-SVC-20260811-005

Каталог содержит overlay существующих Web-файлов Portable Service 1.9.4. Packaging и payload в этом CR не меняются.

## Пользовательский маршрут

Обычный оператор работает только с бизнес-понятиями:

1. выбирает или загружает пакеты ERP и Инталев;
2. выбирает организацию и период;
3. открывает «Движки»;
4. нажимает одну кнопку «Запустить сверку R005».

Панель выбора evidence JSON, SHA-256, root/package/file identity, preflight и confirm удалена. В интерфейсе остаётся только короткая готовность или русское бизнес-сообщение о том, что нужно исправить. Технические пути, хеши и blocker codes не показываются.

Rules и R001 заблокированы до активного валидированного RUN. После успешного R005 они становятся доступны в рамках того же active-run контекста.

## Проверки

```powershell
node --check .\development\OPIU_1.9.4\service\ui_overlay\web\app.js
node --check .\development\OPIU_1.9.4\service\ui_overlay\tests\browser_fixture_server.mjs
node --test --test-isolation=none .\development\OPIU_1.9.4\service\ui_overlay\tests\source_proof_flow.test.mjs
```

`browser_fixture_server.mjs` — санитизированный served-browser стенд. Happy path фиксирует внутренние счётчики preflight/confirm и один RUN. Missing ERP, missing Инталев, mixed organization, mixed period, ambiguity и drift сохраняют нулевой RUN.

Safety всегда остаётся report-only: `posting_rows=0`, `ready_to_upload=false`, `release_allowed=false`, `live_1c_allowed=false`.
