# Portable Service 1.9.4 — USER_DELIVERY_CANDIDATE

## Clean-source Service candidate (CR-PKG-20260825-SERVICE-PACKAGING-BUILD-001)

`build_clean_source_service_candidate.py` — отдельный fail-closed builder для
сборки текущего Service из исходников. Старый REL-52L ZIP используется только
как immutable carrier для уже находящихся в нём runtime overlays. Встроенный в
carrier `OPIU_STABLE_Service.exe` обязательно заменяется.

Builder требует:

- exact clean Git repository и явно переданный 40-символьный `--source-head`;
- exact `go version go1.22.12 windows/amd64`;
- `GOTOOLCHAIN=local`, `GOOS=windows`, `GOARCH=amd64`, `CGO_ENABLED=0`;
- успешный `go test -count=1 ./...` до сборки;
- две независимые byte-identical deterministic EXE сборки;
- полный inventory каждого файла `service/source`, включая embedded web и
  локальные regressions;
- byte-for-byte сохранение полного `runtime` inventory carrier;
- два разных несуществующих output path, которые должны дать byte-identical
  ZIP.

Пример запуска из корня clean worktree:

```powershell
$head = git rev-parse HEAD
python .\development\OPIU_1.9.4\service\packaging\build_clean_source_service_candidate.py `
  --carrier C:\OPIU\rel52l\P\OPIU_1.9.4_REPORT_ONLY.zip `
  --repository . `
  --go-exe C:\path\to\go1.22.12\go\bin\go.exe `
  --output-a C:\new-output\OPIU_1.9.4_SOURCE_BUILD_A.zip `
  --output-b C:\new-output\OPIU_1.9.4_SOURCE_BUILD_B.zip `
  --source-head $head
```

Builder никогда не перезаписывает outputs. В пакет записываются
`SERVICE_BUILD_PROVENANCE.json` с полным source/runtime inventory и новый
`BUNDLE_MANIFEST.json`. Runtime manifest, safety и overlays не изменяются.

Этот контур не запускает full-year financial E2E и не разрешает posting,
upload, release или live 1C. Успешные Go tests, EXE build и deterministic ZIP
не являются доказательством финансовой правильности.

## Независимая проверка

Проверяющий повторяет ту же команду на exact clean head и новых output paths,
сверяет SHA двух ZIP, `SERVICE_BUILD_PROVENANCE.json` и
`BUNDLE_MANIFEST.json`. Успешная сборка фиксирует точный Git-tree каждого
`service/source` файла и полный pinned inventory Go 1.22.12.

Carrier содержит унаследованные абсолютные build-path строки внутри
стороннего native-модуля. Builder не добавляет новые user-profile paths и
правдиво ставит `whole_zip_user_profile_path_free=false`, пока эти строки
остаются в immutable carrier. Это не путь пользователя текущего запуска и не
выводится в нормальный UI, но пакет нельзя называть полностью path-free.

Builder публикует только имена output-файлов, не абсолютные пути. Оба ZIP
сначала формируются во временных файлах; при любой ошибке пара откатывается и
ни один final output не остаётся.
