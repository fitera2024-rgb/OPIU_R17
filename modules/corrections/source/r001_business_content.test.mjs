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
    "Операция REPOST | ERP: документ «Операция МСФО 1»; дата 30.11.2025 23:59:59; проводка № 7; Дт 26; Кт 70.1; сумма 8 000,00; организация «ООО Источник»; подразделение «Администрация» | Статья: «ФЗП» → «НДФЛ» | Инталев: R036: файл «INTALEV_OPIU_2025-11.xlsx», лист «TDSheet», ячейка E113, путь «Расходы на персонал / ФЗП» | REPORT_ONLY | CaseID=CASE-1 | PairID=PAIR-1 | SourceRowID=ROW-1");
  assert.doesNotMatch(content, /C:\\evidence|A{64}|sha/i);
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
    "Операция STORNO | ERP: сумма 123,45 | Статья: «Исходная статья» | документ операций Инталев не представлен | REPORT_ONLY | CaseID=CASE-2");
  assert.doesNotMatch(content, /не определ|организация|подразделение|SourceRowID=|PairID=/);
});

test("audit suffix contains only known exact tokens and remains at the end", () => {
  const content = buildR001BusinessContent({
    operation: "REPOST",
    erp: { debit: "26", credit: "70", amount: 1.5 },
    caseId: "CASE-3",
    pairId: "PAIR-3",
    sourceRowId: "ROW-3",
  });
  assert.match(content, /документ операций Инталев не представлен/);
  assert.match(content, /\| REPORT_ONLY \| CaseID=CASE-3 \| PairID=PAIR-3 \| SourceRowID=ROW-3$/);
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
    "Операция REPOST | ERP: документ «Операция МСФО 9»; сумма 10,00 | Статья: «ФЗП» → «НДФЛ» | документ операций Инталев не представлен | REPORT_ONLY | CaseID=CASE-NO-INTALEV-DOCUMENT");
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

test("owner contract and exact R001 CR bind presentation-only content to the frozen physical baseline", () => {
  const repositoryRoot = path.resolve(
    path.dirname(fileURLToPath(import.meta.url)),
    "../../../../../",
  );
  const ownerContract = fs.readFileSync(path.join(
    repositoryRoot,
    "governance/changes/CR-OWNER-20260824-ORDERED-RECLASS-PHYSICAL-PROOF-CONTRACT.md",
  ), "utf8");
  const exactCr = fs.readFileSync(path.join(
    repositoryRoot,
    "governance/changes/CR-R001-20260825-ECONOMIC-RECLASS-SPORNO-MATERIALIZATION-001.md",
  ), "utf8");
  const engineContract = fs.readFileSync(path.join(
    repositoryRoot,
    "development/OPIU_1.9.4/modules/corrections/source/КОНТРАКТ_ДВИЖКА_R001.md",
  ), "utf8");

  for (const required of [
    "документ операций Инталев не представлен",
    "A:O и Q:AA обязаны остаться идентичными",
    "неизменяемым точным\nphysical baseline",
    "ADC8463708A3E4E39FCF64513D6CC2B6E732DCD038556AE9E1C603C3BE902FE8",
    "E1720A6D0385B8A7272DA24E8EE4C539A735F3BB660D84F8F704B275F296477B",
    "6378CBE0D763AFDE6897EBFF5FD85022E33CEE0ECF5AF5B35F1C1FA38914BC50",
  ]) assert.match(ownerContract, new RegExp(required));

  assert.match(exactCr, /Deterministic business `Содержание` follow-up/);
  assert.match(exactCr, /Future deterministic content is\nvalidated separately and grants no authority for physical row, pair or amount\ndrift\./);
  assert.match(engineContract, /экономическая операция `STORNO` или `REPOST`/);
  assert.match(engineContract, /audit-хвостом `REPORT_ONLY`/);
  assert.match(engineContract, /`CaseID`, `PairID` и `SourceRowID`/);
  assert.doesNotMatch(engineContract, /Содержание` начинается с `Причина корректировки:/);
});
