const ROLE_ORDER = Object.freeze([
  "ERP_OPIU",
  "ERP_OSV",
  "ERP_POSTING_JOURNAL",
  "ERP_EXPORT_JOURNAL",
  "ERP_PACKAGE_PASSPORT",
]);

function normalizedSourceName(value) {
  const leafName = String(value ?? "").split(/[\\/]/u).at(-1) ?? "";
  return leafName
    .normalize("NFKC")
    .toLocaleLowerCase("ru-RU")
    .replaceAll("ё", "е")
    .replace(/[\\/]+/gu, " ")
    .replace(/[_\-.]+/gu, " ")
    .replace(/\s+/gu, " ")
    .trim();
}

export function classifyErpContainerSourceRole(filePath) {
  const name = normalizedSourceName(filePath);
  if (!name) return null;
  if (/package passport|паспорт ?пакет|паспорт выгруз/u.test(name)) {
    return "ERP_PACKAGE_PASSPORT";
  }
  if (/журнал выгруз/u.test(name)) return "ERP_EXPORT_JOURNAL";
  if (/журнал провод/u.test(name)) return "ERP_POSTING_JOURNAL";
  if (/(?:^| )осв(?: |$)/u.test(name)) return "ERP_OSV";
  if (/(?:^| )опиу(?: |$)|(?:^| )опу(?: |$)/u.test(name)) return "ERP_OPIU";
  return null;
}

export function sortErpContainerSources(sources = []) {
  const rank = new Map(ROLE_ORDER.map((role, index) => [role, index]));
  return [...sources].sort((left, right) => {
    const roleDelta = (rank.get(left?.role) ?? 999) - (rank.get(right?.role) ?? 999);
    if (roleDelta !== 0) return roleDelta;
    return String(left?.archiveEntry ?? left?.path ?? "").localeCompare(
      String(right?.archiveEntry ?? right?.path ?? ""),
      "ru-RU",
    );
  });
}

export function buildArchiveSourceGateNarrative({ journalVerified = false, sources = [] } = {}) {
  const roles = new Set(sources.map((source) => source?.role).filter(Boolean));
  const journalDiscovered = roles.has("ERP_POSTING_JOURNAL");
  const osvDiscovered = roles.has("ERP_OSV");
  const journalFact = journalVerified
    ? "ERP журнал VERIFIED"
    : journalDiscovered
      ? "ERP журнал обнаружен, но не VERIFIED"
      : "ERP журнал не обнаружен";
  const osvFact = osvDiscovered
    ? "ERP ОСВ обнаружена в архиве, но контроль ОСВ не выполнен"
    : "ERP ОСВ не обнаружена; контроль ОСВ не выполнен";
  return Object.freeze({
    releaseAllowed: false,
    passportComment: `${journalFact}; ${osvFact}; контроль дублей и live preflight не выполнены.`,
    osvControlValue: osvDiscovered ? "ERP ОСВ ОБНАРУЖЕНА" : "ERP ОСВ НЕ ОБНАРУЖЕНА",
    osvControlStatus: "BLOCKED",
    osvControlComment: osvDiscovered
      ? "ERP ОСВ обнаружена в архиве; парная проверка Инталев/ERP не выполнялась."
      : "ERP ОСВ не обнаружена; парная проверка Инталев/ERP не выполнялась.",
  });
}
