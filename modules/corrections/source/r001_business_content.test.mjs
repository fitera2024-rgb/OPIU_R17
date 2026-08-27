import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import { buildR001BusinessContent } from "./r001_business_content.mjs";

test("complete ERP and proven Intalev references produce deterministic Russian business content", () => {
  const content = buildR001BusinessContent({
    operation: "REPOST",
    erp: {
      document: "Операция МСФО 1",
      date: "30.11.2025 23:59:59",
      postingNumber: 7,
      debit: "26",
      credit: "70.1",
      amount: 8000,
      organization: "ООО Источник",
      debitDepartment: "Администрация",
      creditDepartment: "Администрация",
    },
    economic: { sourceArticle: "ФЗП", targetArticle: "НДФЛ" },
    decision: {
      intalev_references: [{
        proven: true,
        code: "R036",
        source_file: "C:\\evidence\\INTALEV_OPIU_2025-11.xlsx",
        sheet: "TDSheet",
        source_cell: "E113",
        full_path: "Расходы на персонал / ФЗП",
        sha256: "A".repeat(64),
      }],
    },
    caseId: "CASE-1",
    pairId: "PAIR-1",
    sourceRowId: "ROW-1",
  });

  assert.equal(content,
    "Операция REPOST | ERP: документ «Операция МСФО 1»; дата 30.11.2025 23:59:59; проводка № 7; Дт 26; Кт 70.1; сумма 8 000,00; организация «ООО Источник»; подразделение «Администрация» | Статья: «ФЗП» → «НДФЛ» | Инталев: R036: файл «INTALEV_OPIU_2025-11.xlsx», лист «TDSheet», ячейка E113, путь «Расходы на персонал / ФЗП»");
  assert.doesNotMatch(content, /C:\\evidence|A{64}|sha/i);
  assert.doesNotMatch(content, /REPORT_ONLY|CaseID|PairID|SourceRowID/);
});

test("aggregate Intalev without operation registrar is stated explicitly and optional data is not invented", () => {
  const content = buildR001BusinessContent({
    operation: "STORNO",
    erp: { amount: 123.45 },
    economic: { sourceArticle: "Исходная статья" },
    decision: {
      intalev_reference: "R001 «Исходная статья»; регистратор операций Инталев в выгрузке ОПИУ отсутствует",
    },
    caseId: "CASE-2",
  });

  assert.equal(content,
    "Операция STORNO | ERP: сумма 123,45 | Статья: «Исходная статья» | документ операций Инталев не представлен");
  assert.doesNotMatch(content, /не определ|организация|подразделение|SourceRowID=|PairID=/);
});

test("technical audit identifiers never enter user-facing business content", () => {
  const content = buildR001BusinessContent({
    operation: "REPOST",
    erp: { debit: "26", credit: "70", amount: 1.5 },
    caseId: "CASE-3",
    pairId: "PAIR-3",
    sourceRowId: "ROW-3",
  });
  assert.match(content, /документ операций Инталев не представлен/);
  assert.doesNotMatch(content, /REPORT_ONLY|CaseID|PairID|SourceRowID/);
});

test("missing proven Intalev operation reference is stated explicitly without inventing a document", () => {
  const content = buildR001BusinessContent({
    operation: "REPOST",
    erp: { document: "Операция МСФО 9", amount: 10 },
    economic: { sourceArticle: "ФЗП", targetArticle: "НДФЛ" },
    decision: {},
    caseId: "CASE-NO-INTALEV-DOCUMENT",
  });

  assert.equal(content,
    "Операция REPOST | ERP: документ «Операция МСФО 9»; сумма 10,00 | Статья: «ФЗП» → «НДФЛ» | документ операций Инталев не представлен");
});

test("filesystem-like Intalev hierarchy paths and unverified references are not disclosed", () => {
  const content = buildR001BusinessContent({
    operation: "REPOST",
    erp: { amount: 1 },
    decision: {
      intalev_references: [
        { proven: false, source_file: "secret.xlsx", sheet: "Hidden", source_cell: "A1" },
        { proven: true, source_file: "D:\\private\\safe-name.xlsx", full_path: "D:\\private\\tree" },
      ],
    },
  });
  assert.match(content, /файл «safe-name\.xlsx»/);
  assert.doesNotMatch(content, /secret\.xlsx|Hidden|D:\\private|путь «/);
});

test("the production decision technical-reference form yields safe file, sheet, cell and hierarchy fields", () => {
  const content = buildR001BusinessContent({
    operation: "REPOST",
    erp: { amount: 244745 },
    decision: {
      intalev_technical_reference:
        "R033: intalev.xlsx!TDSheet!E103; путь Расходы / ФЗП; R023: intalev.xlsx!TDSheet!E80; путь Расходы / Персонал; регистратор операций Инталев в выгрузке ОПИУ отсутствует; JournalSHA=" + "B".repeat(64),
    },
  });
  assert.match(content, /Инталев: R033: файл «intalev\.xlsx», лист «TDSheet», ячейка E103, путь «Расходы \/ ФЗП»; R023: файл «intalev\.xlsx», лист «TDSheet», ячейка E80, путь «Расходы \/ Персонал»/);
  assert.match(content, /документ операций Инталев не представлен/);
  assert.doesNotMatch(content, /JournalSHA|B{64}/);
});

test("local R001 description binds presentation content to business-only evidence", () => {
  const sourceDirectory = path.dirname(fileURLToPath(import.meta.url));
  const engineContractPath = fs.readdirSync(sourceDirectory)
    .map((name) => path.join(sourceDirectory, name))
    .find((candidate) => candidate.endsWith("_R001.md")
      && fs.readFileSync(candidate, "utf8").includes("# Движок корректировок ОПИУ R001"));
  assert.ok(engineContractPath, "R001 engine contract must be discoverable inside the current repository");
  const engineContract = fs.readFileSync(engineContractPath, "utf8");

  assert.match(engineContract, /только реально известные реквизиты ERP/);
  assert.match(engineContract, /Локальные пути и SHA-256 в `Содержание` запрещены/);
  assert.match(engineContract, /не заменяют понятное содержание/);
  assert.match(engineContract, /экономическая операция `STORNO` или `REPOST`/);
  assert.doesNotMatch(engineContract, /Содержание` начинается с `Причина корректировки:/);
});
