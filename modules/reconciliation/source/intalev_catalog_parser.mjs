function text(value) {
  return String(value ?? "")
    .replace(/\u00a0/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function headerKey(value) {
  return text(value).replace(/\s+/g, "").toLocaleLowerCase("ru-RU");
}

const HEADER_ALIASES = {
  uuid: ["UUID", "Ссылка", "Объект"],
  parent_uuid: ["UUIDРодителя", "UUID Родителя", "Родитель"],
  name: ["Наименование", "Объект.Наименование"],
  full_path: ["ПолныйПуть", "Полный путь", "Full path"],
  deletion_mark: ["ПометкаУдаления", "Пометка удаления"],
  is_group: ["ЭтоГруппа", "Это группа"],
  code: ["Код", "Объект.Код"],
  order: ["Порядок"],
  kind: ["Вид"],
  formula: ["Формула", "Объект.Формула"],
};

export function detectIntalevCatalogHeaders(values, maxRows = 15) {
  const rows = Array.isArray(values) ? values.slice(0, maxRows) : [];
  for (let headerRowIndex = 0; headerRowIndex < rows.length; headerRowIndex += 1) {
    const indexByHeader = new Map(
      (rows[headerRowIndex] ?? []).map((value, index) => [headerKey(value), index]),
    );
    const column = (field) => {
      for (const alias of HEADER_ALIASES[field]) {
        const index = indexByHeader.get(headerKey(alias));
        if (Number.isInteger(index)) return index;
      }
      return null;
    };
    const columns = Object.fromEntries(
      Object.keys(HEADER_ALIASES).map((field) => [field, column(field)]),
    );
    if (
      Number.isInteger(columns.uuid) &&
      Number.isInteger(columns.parent_uuid) &&
      Number.isInteger(columns.name)
    ) {
      const uuidHeader = headerKey(rows[headerRowIndex][columns.uuid]);
      const parentHeader = headerKey(rows[headerRowIndex][columns.parent_uuid]);
      return {
        headerRowIndex,
        columns,
        format: uuidHeader === "uuid" && parentHeader === "uuidродителя" ? "UUID" : "LEGACY",
      };
    }
  }
  return { headerRowIndex: -1, columns: {}, format: "OUTLINE" };
}
