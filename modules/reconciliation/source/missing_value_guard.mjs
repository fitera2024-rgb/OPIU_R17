export function proveNumericSourceAmount(value, { trace = [] } = {}) {
  if (typeof value === "number" && Number.isFinite(value)) {
    return { status: "PASS_NUMERIC_SOURCE", amount: value, trace };
  }
  return {
    status: "MISSING_VALUE",
    amount: null,
    trace,
    note: "Числовое значение отсутствует; ноль не доказан источником.",
  };
}

export function aggregateExplicitChildren(children, { trace = [] } = {}) {
  if (!Array.isArray(children) || children.length === 0) {
    return {
      status: "MISSING_VALUE",
      amount: null,
      trace,
      note: "Нет явных дочерних числовых значений; ноль не доказан источником.",
    };
  }
  if (!children.every((child) => typeof child?.amount === "number" && Number.isFinite(child.amount))) {
    return {
      status: "MISSING_VALUE",
      amount: null,
      trace: [...trace, ...children.flatMap((child) => child?.trace ?? [])],
      note: "Не все дочерние значения числовые; ноль не доказан источником.",
    };
  }
  return {
    status: "PASS_EXPLICIT_CHILDREN",
    amount: children.reduce((sum, child) => sum + child.amount, 0),
    trace: [...trace, ...children.flatMap((child) => child.trace ?? [])],
  };
}
