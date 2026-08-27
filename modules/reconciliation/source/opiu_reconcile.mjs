import crypto from "node:crypto";
import { execFile } from "node:child_process";
import fs from "node:fs/promises";
import path from "node:path";
import { promisify } from "node:util";
import { fileURLToPath } from "node:url";
import JSZip from "jszip";
import { FileBlob, SpreadsheetFile, Workbook } from "@oai/artifact-tool";
import {
  bindCalculationPayload,
  bindRunIntalevUidCatalog,
  buildReferenceCatalogTrace,
  rehashReferenceCatalogManifest,
  verifyReferenceCatalogManifest,
} from "./reference_catalog_manifest.mjs";
import {
  applyR005MachinePolicyToProfile,
  evaluateR005DecisionClass,
  loadR005MachinePolicy,
  r005PolicyTrace,
} from "./r005_machine_policy.mjs";
import {
  assertSourceUnchanged,
  buildSourceProvenance,
  captureSourceEvidence,
  serializeExactSourceTrace,
} from "./source_trace_guard.mjs";
import {
  annotateSourceTree,
  gateResolvedResultBySourceTree,
  serializeSourceTreeProof,
} from "./source_tree_proof.mjs";
import { advanceIntalevOutlinePath } from "./intalev_outline_path.mjs";
import {
  bindTemplateRowsToTrees,
  buildErpOutlineTree,
  buildIntalevParentTree,
  parseOutlineLevelsXml,
  resolveHierarchyNodeFromPath,
  resolveHierarchyNodeFromTrace,
  selectHierarchyTracePath,
  selectHierarchyTracePathForLabel,
} from "./hierarchy_tree.mjs";
import { validateEconomicHierarchyMapping } from "./economic_hierarchy_mapping.mjs";
import {
  attachCanonicalBindingStatuses,
  attachIntalevSourceHierarchy,
  buildHierarchyPresentationRows,
} from "./r005_intalev_tree_presentation.mjs";
import {
  buildSourceDrivenExpensePresentationRows,
  insertSourceDrivenExpenseRows,
} from "./source_driven_expense_presentation.mjs";
import { applyJournalFirstPresentationAttribution } from "./journal_first_presentation_attribution.mjs";
import {
  approvedIntalevTemplateGraphAppliesToProfile,
  attachApprovedIntalevTemplateGraph,
  loadApprovedIntalevTemplateGraph,
  serializeApprovedIntalevTemplateGraph,
} from "./r005_intalev_template_graph.mjs";
import {
  detectIntalevCatalogHeaders,
  isIntalevCatalogPlaceholderRow,
} from "./intalev_catalog_parser.mjs";
import {
  assertIntalevCatalogBindingUnchanged,
  discoverIntalevArticleCatalog,
  extractZipArchiveSafely,
} from "./intalev_catalog_binding.mjs";
import {
  D04_CATALOG_MANIFEST,
  buildCatalogCoverage,
  resolveCatalogFallback,
} from "./catalog_descendants.mjs";
import {
  buildParentDetailBlockedResult,
  evaluateParentDetailConsistency,
} from "./parent_detail_guard.mjs";
import {
  buildIntalevCatalogIdentityEvidence,
  buildIntalevArticleIdentity,
  buildRoleBoundDimensionIdentity,
  dimensionRoleForHeader,
  proveRequestedOrganization,
  scopeOrganizationCandidates,
} from "./organization_identity_guard.mjs";
import { analyzeExactSourceIdentityDuplicates } from "./d07_source_identity.mjs";
import { aggregateProvenRows, combineProvenAggregations } from "./aggregation_grain.mjs";
import { selectErpSemanticParent } from "./erp_semantic_hierarchy.mjs";
import {
  aggregateExplicitChildren,
  proveNumericSourceAmount,
} from "./missing_value_guard.mjs";
import {
  classifyHierarchyResidual,
  postingEligibility,
  proveR064CandidateAmount,
  resolveR064DuplicateNull,
} from "./issue10_r064_hierarchy_guard.mjs";
import { validateR021IndependentTrace } from "./r021_exact_source_guard.mjs";
import {
  assertUniquePeriodHeader,
  removeReportTypeCodesFromPeriods,
} from "./period_selection_guard.mjs";
import {
  selectAuthoritativeErpCandidate,
  verifyErpInputAuthority,
} from "./erp_source_authority_guard.mjs";
import { assessZeroSumHierarchyGroups } from "./zero_sum_group_reclass.mjs";
import { detectGenericReclassifications } from "./generic_reclassification_detection.mjs";
import {
  bindEconomicRouteProofs,
  loadEconomicRouteProofDocument,
} from "./economic_route_proof_binding.mjs";
import {
  assessConfiguredStructuralControlGroups,
  OWNER_PRESENTATION_BLOCK_EXEMPT_CLASSIFICATION,
  isOwnerPresentationBlockExempt,
  ownerPresentationBlockExemption,
} from "./owner_presentation_block_exemption.mjs";
import {
  serializeStructuralControlGroups,
  structuralControlGroupsFromConfig,
} from "./structural_control_groups.mjs";
import { loadStructuralControlSettingsDocument } from "./structural_control_settings_binding.mjs";
import {
  buildStructuralControlReportDetail,
  STRUCTURAL_CONTROL_REPORT_DETAIL_HEADERS,
} from "./structural_control_report_detail.mjs";
import { loadEmptyArticleBindingSettingsDocument } from "./empty_article_binding_settings.mjs";
import { applyEmptyArticleBindingsToBlankArticleReporting } from "./empty_article_binding_application.mjs";
import {
  applyArticleApprovalRules,
  buildArticleApprovalSheet,
  loadArticleApprovalDocument,
} from "./article_approval_core.mjs";
import {
  materializeStructuralControlInventoryV3,
  planStructuralControlInventoryV3,
} from "./structural_control_inventory_v3.mjs";
import {
  buildReportDecision,
  decideReconciliationPipelineRows,
  projectDecisionContract,
} from "./reconciliation_decision_engine.mjs";
import { loadR002OperationEvidence } from "./r002_operation_evidence.mjs";
import { loadArbitraryPeriodOperationEvidence } from "./arbitrary_period_operation_evidence.mjs";
import { provenOperationWorkbookRows } from "./operation_evidence_workbook_projection.mjs";
import {
  loadFullOperationEvidence,
  readOperationJournalRows,
} from "./full_operation_evidence.mjs";
import {
  applyPostedCorrectionOverlayToErpParsed,
  loadPostedCorrectionJournalOverlay,
} from "./posted_correction_journal_overlay.mjs";
import {
  buildCrossJournalDiscrepancyEvidence,
  unavailableCrossJournalEvidence,
} from "./cross_journal_discrepancy_evidence.mjs";
import { createUniqueRunWorkDir } from "./run_workdir.mjs";
import { OWNER_DECISION_EXPLANATION_HEADERS } from "./owner_decision_xlsx.mjs";
import { detectConfiguredRootProfile } from "./organization_profile_registry.mjs";
import { buildOperationTreePresentation } from "./operation_tree_presentation.mjs";
import {
  deriveReconciliationStatus,
  erpHierarchyBlockedControlFormula,
  intalevHierarchyBlockedControlFormula,
  requiresReconciliationReview,
  summaryStatusFormula,
} from "./r005_reconciliation_status.mjs";
import {
  keepRawWithReclassificationCandidate,
  useDerivedOnlyWhenRawMissing,
} from "./r005_erp_normalization.mjs";
import {
  resolveProvenErpCompositionAlias,
  resolveProvenErpPresentationParent,
  resolveProvenErpTemplateParentComposition,
} from "./erp_proven_parent_composition.mjs";
import { selectExactDiagnosticCandidate } from "./r005_intalev_diagnostic.mjs";
import {
  applyIntalevBlankArticleReporting,
  buildIntalevSourceScopeDiagnostics,
  buildIntalevSourceScopePayloadContract,
  buildIntalevSourceScopeRowContract,
  classifyIntalevArticleLabel,
  isBlankIntalevArticleLabel,
} from "./intalev_source_scope.mjs";
import {
  buildArchiveSourceGateNarrative,
  classifyErpContainerSourceRole,
  sortErpContainerSources,
} from "./erp_container_source_registry.mjs";

const appDir = path.dirname(fileURLToPath(import.meta.url));
const configPath = path.join(appDir, "config.json");
const dataDir = path.join(appDir, "data");
const snapshotsDir = path.join(dataDir, "intalev_snapshots");
const currentSnapshotPath = path.join(dataDir, "current.json");
const workRoot = path.join(appDir, "work");
const defaultOutputsDir = path.join(appDir, "outputs");
const organizationProfilesPath = path.join(appDir, "organization_profiles.json");
const xlsConverterPath = path.join(appDir, "convert_xls_to_xlsx.ps1");
const execFileAsync = promisify(execFile);
const erpSourceMetadataByPath = new Map();
const erpContainerSourceRegistry = [];
const operationJournalScopeCache = new Map();

function khabarovskRulesPath() {
  const configured = String(config.khabarovsk_rules_path ?? "").trim();
  return configured
    ? path.resolve(configured)
    : path.join(appDir, "resources", "khabarovsk_project.json");
}

const argv = process.argv.slice(2);
const command = argv[0] ?? "help";
const args = parseArgs(argv.slice(1));
const config = JSON.parse(await fs.readFile(configPath, "utf8"));
const structuralControlSettingsBinding = await loadStructuralControlSettingsDocument(
  args["structural-control-settings"],
  { organization: args.organization, period: args.period },
);
const activeStructuralControlGroups = structuralControlSettingsBinding.document
  ? structuralControlSettingsBinding.groups
  : structuralControlGroupsFromConfig(config, { organization: args.organization });
const structuralControlSettingsAudit = structuralControlSettingsBinding.audit;
const organizationProfileRegistry = JSON.parse(
  await fs.readFile(organizationProfilesPath, "utf8"),
);

const colors = {
  blue: "#4472C4",
  blueLight: "#D9EAF7",
  blueHeader: "#7EA6C9",
  green: "#E2F0D9",
  greenStrong: "#A9D18E",
  yellow: "#FFF2CC",
  orange: "#FCE4D6",
  red: "#F4CCCC",
  gray: "#E7E6E6",
  darkGray: "#595959",
  border: "#B4C6E7",
  white: "#FFFFFF",
};

export const MANDATORY_RECONCILIATION_SHEET_NAMES = Object.freeze([
  "00_Паспорт",
  "01_Сверка_дерево",
  "01_Сверка_ОПИУ",
  "01_Правила",
  "02_Помесячно",
  "03_Инталев_узлы",
  "03A_Пустые_статьи",
  "04_ERP_статьи",
  "04A_Расхождения_проводок",
  "04B_R001_решения",
  "05_Несопоставленные",
  "06_Источники",
  "07_Контроли",
  "08_Операции_журнала",
  "08_Решения_обоснование",
]);

export const OPTIONAL_PROVEN_OPERATIONS_SHEET_NAME = "09_Доказанные_операции";

export const CROSS_JOURNAL_DISCREPANCY_HEADERS = Object.freeze([
  "Результат сопоставления", "Тип строки", "Уверенность, %", "Период",
  "Блок Инталев", "Статья Инталев", "Статья ERP", "Сумма", "Дата", "Дт",
  "Кт", "Общие аналитики", "Содержание операции", "Документ Инталев",
  "Строка Инталев", "Документ ERP", "Строка ERP",
  "Почему строки признаны одной операцией", "Что делать пользователю",
  "Повторное использование строки", "SourceRowID Инталев", "SourceRowID ERP",
  "Путь статьи Инталев", "Путь статьи ERP", "Фактический блок ERP",
  "Целевой блок по Инталев", "Код исходной статьи ERP",
  "Счёт исходного блока ERP", "Целевая статья ERP", "Код целевой статьи ERP",
  "Счёт целевого блока ERP", "Целевой путь ERP", "Статус выбора цели",
]);

export const CROSS_JOURNAL_CORRECTION_HEADERS = Object.freeze([
  "CaseID", "PairID", "Тип решения", "Решение владельца", "Период",
  "Строка сверки", "Группа", "Статья", "Роль доказательства",
  "classification", "reclass_scope", "Proof status", "effective_delta",
  "ECONOMIC_ROUTE_PROVEN", "SOURCE_OPERATION_PROVEN", "PHYSICAL_SOURCE_UNIQUE",
  "ECONOMIC_CORRECTION_PROVEN", "partial_source_amount_proven",
  "Архив источника ERP", "SHA256 архива источника ERP", "Файл журнала внутри архива",
  "SHA256 журнала ERP", "Лист источника ERP", "SourceRowID ERP",
  "ERP файл/лист/диапазон", "Дата источника", "Регистратор/документ",
  "№ проводки источника", "Дт источник", "Аналитика Дт источник 1",
  "Аналитика Дт источник 2", "Аналитика Дт источник 3", "Подразделение Дт источник",
  "Кт источник", "Аналитика Кт источник 1", "Аналитика Кт источник 2",
  "Аналитика Кт источник 3", "Подразделение Кт источник", "Организация",
  "Организация сверки", "Организация источника ERP", "Физическая сумма источника",
  "Сумма корректировки", "Причина", "Предлагаемое решение", "Исходная статья",
  "Счет доходов/расходов Инталев", "Целевая статья analytical", "Код целевой статьи",
  "Слот целевой аналитики", "Блок Инталев", "Полный путь Инталев",
  "Путь целевой статьи ERP", "Счет целевой статьи ERP", "Комментарий",
]);

export const JOURNAL_OPERATION_HEADERS = Object.freeze([
  "Период", "Исходный файл", "Лист", "Строка Excel", "Документ", "№ проводки",
  "Дата", "Дт", "Аналитика Дт", "Кт", "Аналитика Кт", "Сумма",
  "Организация", "Статья", "Статус", "Решение", "Причина",
]);

const INTALEV_CATALOG_NOT_EXPORTED = "BLOCKED_INTALEV_CATALOG_NOT_EXPORTED";
const INTALEV_CATALOG_SHEET_AMBIGUOUS = "BLOCKED_SOURCE_PROOF_AMBIGUOUS_SOURCE";

const russianMonthNumbers = new Map([
  ["январь", "01"],
  ["февраль", "02"],
  ["март", "03"],
  ["апрель", "04"],
  ["май", "05"],
  ["июнь", "06"],
  ["июль", "07"],
  ["август", "08"],
  ["сентябрь", "09"],
  ["октябрь", "10"],
  ["ноябрь", "11"],
  ["декабрь", "12"],
]);

function parseArgs(tokens) {
  const parsed = {};
  for (let index = 0; index < tokens.length; index += 1) {
    const token = tokens[index];
    if (!token.startsWith("--")) continue;
    const key = token.slice(2);
    const next = tokens[index + 1];
    if (next && !next.startsWith("--")) {
      parsed[key] = next;
      index += 1;
    } else {
      parsed[key] = true;
    }
  }
  return parsed;
}

function printHelp() {
  console.log(`
Автоматическая сверка ОПИУ Инталев ↔ ERP

1. Зафиксировать Инталев:
   Запуск_сверки.ps1 init -Intalev "C:\\путь\\к\\Инталев"

2. Построить отчёт:
   Запуск_сверки.ps1 run -ERP "C:\\путь\\к\\ERP" -Mode month -Period "2025-01"
   Запуск_сверки.ps1 run -ERP "C:\\путь\\к\\ERP" -Mode quarter -Period "2025-Q1"
   Запуск_сверки.ps1 run -ERP "C:\\путь\\к\\ERP" -Mode year -Period "2025"

3. Проверить активный снимок:
   Запуск_сверки.ps1 status

Экономическая иерархия (только явный доказанный mapping):
   --economic-hierarchy-mapping "C:\\путь\\economic-hierarchy-mapping.json"

Owner-approved economic route proof (run-bound, REPORT_ONLY):
   --economic-route-proofs "C:\\путь\\economic-route-proofs.json"

Настройки классификации пустых статей (по организации, только UPDATE_MAPPING / NO_POSTING):
   --empty-article-binding-settings "C:\\путь\\empty-article-bindings.json"

Утверждённая область статей (по организации и месяцу, REPORT_ONLY):
   --article-approval-settings "C:\\путь\\article_registry_<organization_slug>_vNNN.approved.json"
`);
}

function fail(message) {
  throw new Error(message);
}

async function loadEconomicHierarchyMappingResource(mappingPath) {
  const requested = normalizeText(mappingPath);
  if (!requested) return null;
  const resourcePath = path.resolve(requested);
  let document;
  try {
    document = JSON.parse(await fs.readFile(resourcePath, "utf8"));
  } catch (error) {
    fail(`ECONOMIC_HIERARCHY_MAPPING_RESOURCE_UNREADABLE:${resourcePath}:${error.message}`);
  }
  const validation = validateEconomicHierarchyMapping(document);
  if (validation.status !== "PASS") {
    fail(`ECONOMIC_HIERARCHY_MAPPING_RESOURCE_INVALID:${validation.reason ?? validation.status}`);
  }
  return document;
}

function normalizeText(value) {
  return String(value ?? "")
    .replace(/\u00A0/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function normalizeLabel(value) {
  return normalizeText(value)
    .replace(/^\d+_/, "")
    .replace(/[«»"]/g, "")
    .toLocaleLowerCase("ru-RU");
}

function isOrganizationalDimensionHeader(value) {
  return dimensionRoleForHeader(value) !== null;
}

function normalizeDimensionValues(values) {
  return unique(
    (values ?? [])
      .flatMap((value) => Array.isArray(value) ? value : [value])
      .map(normalizeText)
      .filter(Boolean),
  );
}

function dimensionKey(row) {
  return [
    `ORGANIZATION:${normalizeLabel(row?.organization)}`,
    `CFO:${normalizeLabel(row?.cfo)}`,
    `DEPARTMENT:${normalizeLabel(row?.department)}`,
  ].join(" | ");
}

function periodFromRussianMonthHeader(value) {
  const normalized = normalizeLabel(value);
  const match = normalized.match(
    /^(январь|февраль|март|апрель|май|июнь|июль|август|сентябрь|октябрь|ноябрь|декабрь)\s+(20\d{2})/,
  );
  if (!match) return null;
  return `${match[2]}-${russianMonthNumbers.get(match[1])}`;
}

function makeMultiOrganizationProfile(id, organization, organizationCode) {
  return {
    id,
    organization,
    organizationCode,
    projectRules: "MULTI_ORG_FORM_ADAPTER_V1",
    rulesPath: organizationProfilesPath,
    status: "BLOCKED_PROFILE_REVIEW_REQUIRED",
    templateVariant: "MULTI_ORG_STANDARD",
    restrictAdministrativePath: true,
    rulesNote:
      "Профиль организации; годовые и месячные формы Инталев/ERP читаются по выбранному периоду.",
    controlsNote:
      "Результат требует проверки расхождений, сопоставлений и источников по организации.",
  };
}

function makeConfiguredRootProfile(profile) {
  const operationEvidenceProfile = {
    journalOrganizationAliases: Array.isArray(profile.journal_organization_aliases)
      ? [...profile.journal_organization_aliases]
      : [],
    operationBearingCodes: Array.isArray(profile.operation_bearing_codes)
      ? [...profile.operation_bearing_codes]
      : [],
    includeUnassignedJournalRows: profile.show_unassigned_journal_rows === true,
  };
  if (profile.profile_kind === "UK_R005") {
    return {
      id: "UK_R005",
      organization: normalizeText(config.default_organization) || profile.organization,
      organizationCode:
        normalizeText(config.default_organization_code) || profile.organization_code,
      projectRules: config.project_rules,
      rulesPath: path.resolve(config.rules_path),
      status: "BLOCKED_R005_REPASS_REQUIRED",
      templateVariant: "UK_R005",
      restrictAdministrativePath: false,
      rulesNote: "R005 дополняет R004.",
      controlsNote: "Активный канон R005.",
      ...operationEvidenceProfile,
    };
  }
  if (profile.profile_kind === "HABAROVSK_AT") {
    return {
      id: "HABAROVSK_AT_2025",
      organization: profile.organization,
      organizationCode: profile.organization_code,
      projectRules: "HABAROVSK_AT_FORM_ADAPTER_V1",
      rulesPath: khabarovskRulesPath(),
      status: "BLOCKED_PROFILE_REVIEW_REQUIRED",
      templateVariant: "MULTI_ORG_STANDARD",
      restrictAdministrativePath: true,
      rulesNote: "Профиль Хабаровска; годовые формы Инталев и ERP читаются по выбранному периоду.",
      controlsNote: "Профиль Хабаровска; результат требует проверки расхождений и источников.",
      ...operationEvidenceProfile,
    };
  }
  const result = makeMultiOrganizationProfile(
    profile.id,
    profile.organization,
    profile.organization_code,
  );
  result.status = "BLOCKED_PROFILE_REVIEW_REQUIRED";
  Object.assign(result, operationEvidenceProfile);
  return result;
}

function getIntalevOrganizationSignatures() {
  return [
    {
      organization: "3 Сахалин",
      hintTokens: ["3 сахалин"],
      sourceTokens: ["цмд сахалин", "3 сахалин", "сахалин_без юл"],
    },
    {
      organization: "8 Сахалин МА",
      hintTokens: ["8 сахалин ма", "сахалин ма"],
      sourceTokens: ["8 сахалин ма", "сахалин ма"],
    },
    {
    organization: "9 Управляющая компания",
    hintTokens: ["9 управляющая компания"],
    sourceTokens: [
      "цд/цз фонд развития",
      "фонд развития",
      "\\opiu pv\\input\\uk\\",
    ],
    },
    {
    organization: "Хабаровск",
    hintTokens: ["хабаровск"],
    sourceTokens: ["хабаровск", "\\opiu x\\input\\at\\"],
    },
    {
    organization: "Сахалин",
    hintTokens: ["сахалин"],
    sourceTokens: ["сахалин"],
    },
    {
    organization: "Владивосток — Айс Юнион",
    hintTokens: ["владивосток", "айс юнион"],
    sourceTokens: ["владивосток", "айс юнион"],
    },
    {
    organization: "Планета Запад",
    hintTokens: ["планета запад"],
    sourceTokens: ["планета запад"],
    },
    {
    organization: "Мега Айс",
    hintTokens: ["мега айс"],
    sourceTokens: ["мега айс"],
    },
    {
    organization: "Камчатка",
    hintTokens: ["камчатка"],
    sourceTokens: ["цмд камчатка"],
    },
    {
    organization: "КонсалтСервис",
    hintTokens: ["консалтсервис"],
    sourceTokens: ["консалтсервис"],
    },
  ];
}

function organizationAliases(organization) {
  const requested = normalizeLabel(organization);
  const signature = getIntalevOrganizationSignatures().find((item) =>
    [...item.hintTokens, item.organization].some((token) =>
      requested.includes(normalizeLabel(token)),
    ),
  );
  return signature ? unique([...signature.hintTokens, ...signature.sourceTokens]) : [];
}

function validateSelectedIntalevOrganization(organizationHint, parsed) {
  const normalizedHint = normalizeLabel(organizationHint);
  if (!normalizedHint) fail("BLOCKED_ORGANIZATION_REQUIRED: укажите организацию явно.");
  const signatures = getIntalevOrganizationSignatures();
  const expected = signatures.find((signature) =>
    signature.hintTokens.some((token) =>
      normalizedHint.includes(normalizeLabel(token)),
    ),
  );
  if (!expected) {
    fail(`BLOCKED_ORGANIZATION_NOT_PROVEN: неизвестен набор identity-токенов для «${organizationHint}».`);
  }

  const evidenceItems = [
    parsed.source_file,
    ...parsed.nodes
      .slice(0, 30)
      .flatMap((node) => [node.label, node.full_path]),
  ].filter(Boolean);
  const evidence = evidenceItems.map(normalizeLabel).join(" | ");
  const organizationProof = proveRequestedOrganization({
    requestedOrganization: organizationHint,
    aliases: expected.sourceTokens,
    evidence: evidenceItems,
  });
  if (organizationProof.status === "PASS_ORGANIZATION_PROVEN") {
    parsed.organization_proof = organizationProof;
    return;
  }

  const detected = signatures.find(
    (signature) =>
      signature.organization !== expected.organization &&
      signature.sourceTokens.some((token) =>
        evidence.includes(normalizeLabel(token)),
      ),
  );
  if (!detected) {
    fail(
      `BLOCKED_ORGANIZATION_NOT_PROVEN: источник Инталев не содержит доказательства организации «${expected.organization}».`,
    );
  }
  const heading =
    parsed.nodes
      .slice(0, 30)
      .map((node) => node.label)
      .find((label) => {
        const normalized = normalizeLabel(label);
        return (
          normalized.includes("цфо:") ||
          normalized.includes("цмд ") ||
          normalized.includes("цд/цз")
        );
      }) ?? path.basename(parsed.source_file);
  fail(
    `Выбрана организация «${expected.organization}», но отчёт Инталев не подтверждает эту организацию. ` +
      `Определён источник «${detected.organization}». ` +
      `В файле указано: ${heading}. Выберите правильный Инталев для «${expected.organization}».`,
  );
}

function detectReconciliationProfile(
  snapshot,
  erpFiles,
  organizationHint = "",
  intalevParsed = [],
  erpParsed = [],
) {
  const normalizedHint = normalizeLabel(organizationHint);
  if (normalizedHint) {
    const configuredRootProfile = detectConfiguredRootProfile(
      organizationProfileRegistry,
      organizationHint,
    );
    if (configuredRootProfile) {
      return makeConfiguredRootProfile(configuredRootProfile);
    }
    if (normalizedHint.includes("9 управляющая компания")) {
      return {
        id: "UK_R005",
        organization: config.default_organization,
        organizationCode: config.default_organization_code,
        projectRules: config.project_rules,
        rulesPath: path.resolve(config.rules_path),
        status: "BLOCKED_R005_REPASS_REQUIRED",
        templateVariant: "UK_R005",
        restrictAdministrativePath: false,
        rulesNote: "R005 дополняет R004.",
        controlsNote: "Активный канон R005.",
      };
    }
    if (normalizedHint.includes("хабаровск")) {
      return {
        id: "HABAROVSK_AT_2025",
        organization: "Хабаровск",
        organizationCode: "ORG-AT-HAB",
        projectRules: "HABAROVSK_AT_FORM_ADAPTER_V1",
        rulesPath: khabarovskRulesPath(),
        status: "BLOCKED_PROFILE_REVIEW_REQUIRED",
        templateVariant: "MULTI_ORG_STANDARD",
        restrictAdministrativePath: true,
        rulesNote:
          "Профиль Хабаровска; годовые формы Инталев и ERP читаются по выбранному периоду.",
        controlsNote:
          "Профиль Хабаровска; результат требует проверки расхождений и источников.",
      };
    }
    if (normalizedHint.includes("консалтсервис")) {
      return makeMultiOrganizationProfile(
        "CONSULTSERVICE_2025",
        "КонсалтСервис",
        "ORG-CONSULTSERVICE",
      );
    }
    if (normalizedHint.includes("камчатка")) {
      return makeMultiOrganizationProfile(
        "KAMCHATKA_2025",
        "Камчатка",
        "ORG-KAMCHATKA",
      );
    }
    if (normalizedHint.includes("мега айс")) {
      return makeMultiOrganizationProfile(
        "MEGA_ICE_2025",
        "Мега Айс",
        "ORG-MEGA-ICE",
      );
    }
    if (normalizedHint.includes("планета запад")) {
      return makeMultiOrganizationProfile(
        "PLANETA_WEST_2025",
        "Планета Запад",
        "ORG-PLANETA-WEST",
      );
    }
    if (normalizedHint.includes("айс юнион")) {
      return makeMultiOrganizationProfile(
        "VLADIVOSTOK_ICE_UNION_2025",
        "Владивосток — Айс Юнион",
        "ORG-VLAD-ICE",
      );
    }
    if (normalizedHint.includes("сахалин")) {
      return makeMultiOrganizationProfile(
        "SAKHALIN_2025",
        "Сахалин",
        "ORG-SAKH",
      );
    }
  }

  const paths = [
    organizationHint,
    snapshot.source_root,
    ...snapshot.files.flatMap((file) => [
      file.original_path,
      file.stored_path,
    ]),
    ...erpFiles.values(),
  ]
    .filter(Boolean)
    .map((value) => normalizeLabel(value));
  const pathCombined = paths.join(" | ");
  const intalevEvidence = intalevParsed.flatMap((parsed) =>
    parsed.nodes.slice(0, 30).flatMap((node) => [node.label, node.full_path]),
  );
  const combined = [...paths, ...intalevEvidence]
    .filter(Boolean)
    .map((value) => normalizeLabel(value))
    .join(" | ");
  const hasAny = (...tokens) =>
    tokens.some((token) => combined.includes(normalizeLabel(token)));

  if (
    pathCombined.includes("опиу_хаб") ||
    pathCombined.includes("\\opiu x\\input\\at\\")
  ) {
    return {
      id: "HABAROVSK_AT_2025",
      organization: "Хабаровск",
      organizationCode: "ORG-AT-HAB",
      projectRules: "HABAROVSK_AT_FORM_ADAPTER_V1",
      rulesPath: khabarovskRulesPath(),
      status: "BLOCKED_PROFILE_REVIEW_REQUIRED",
      templateVariant: "MULTI_ORG_STANDARD",
      restrictAdministrativePath: true,
      rulesNote:
        "Профиль Хабаровска; годовые формы Инталев и ERP читаются по выбранному периоду.",
      controlsNote:
        "Профиль Хабаровска; результат требует проверки расхождений и источников.",
    };
  }

  if (hasAny("консалтсервис")) {
    return makeMultiOrganizationProfile(
      "CONSULTSERVICE_2025",
      "КонсалтСервис",
      "ORG-CONSULTSERVICE",
    );
  }
  if (hasAny("цмд камчатка", "организация камчатка")) {
    return makeMultiOrganizationProfile(
      "KAMCHATKA_2025",
      "Камчатка",
      "ORG-KAMCHATKA",
    );
  }
  if (hasAny("цмд мега айс", "мега айс")) {
    return makeMultiOrganizationProfile(
      "MEGA_ICE_2025",
      "Мега Айс",
      "ORG-MEGA-ICE",
    );
  }
  if (hasAny("цмд планета запад", "планета запад", "планета-запад")) {
    return makeMultiOrganizationProfile(
      "PLANETA_WEST_2025",
      "Планета Запад",
      "ORG-PLANETA-WEST",
    );
  }
  if (hasAny("айс юнион", "владивосток — айс юнион", "владивосток - айс юнион")) {
    return makeMultiOrganizationProfile(
      "VLADIVOSTOK_ICE_UNION_2025",
      "Владивосток — Айс Юнион",
      "ORG-VLAD-ICE",
    );
  }
  if (hasAny("организация сахалин", "сахалин")) {
    return makeMultiOrganizationProfile(
      "SAKHALIN_2025",
      "Сахалин",
      "ORG-SAKH",
    );
  }
  if (
    hasAny(
      "9 управляющая компания",
      "управляющая компания",
      "org-9uk",
      "uk_project_rules",
    ) ||
    combined.includes("\\ук 21\\input\\")
  ) {
    return {
      id: "UK_R005",
      organization: config.default_organization,
      organizationCode: config.default_organization_code,
      projectRules: config.project_rules,
      rulesPath: path.resolve(config.rules_path),
      status: "BLOCKED_R005_REPASS_REQUIRED",
      templateVariant: "UK_R005",
      restrictAdministrativePath: false,
      rulesNote: "R005 дополняет R004.",
      controlsNote: "Активный канон R005.",
    };
  }

  if (organizationHint) {
    return makeMultiOrganizationProfile(
      `MULTI_ORG_${safeFileName(organizationHint).toUpperCase()}`,
      organizationHint,
      `ORG-${crypto
        .createHash("sha256")
        .update(organizationHint)
        .digest("hex")
        .slice(0, 8)
        .toUpperCase()}`,
    );
  }

  return {
    ...makeMultiOrganizationProfile(
      "MULTI_ORG_AUTO_REVIEW",
      "Организация не определена",
      "ORG-AUTO-REVIEW",
    ),
    controlsNote:
      "Организация не определена автоматически; выберите её в интерфейсе и повторите сверку.",
  };
}

function applyProfileTemplateOverrides(templateRows, profile) {
  const multiOrganizationOverrides = {
    R024: { intalev_label: "Корпоративные меропрития" },
    R045: {
      intalev_label: "Результат по финансовой деятельности",
      erp_label: "Итоги по финансовой деятельности",
    },
    R046: {
      intalev_label: "Доходы по финансовой деятельности",
      erp_label: "Доходы по финансовой деятельности",
    },
    R055: {
      intalev_label:
        "Результат по инвестиционной и внереализационной деятельности",
      erp_label: "Итоги по внереализационной деятельности",
    },
    R056: {
      intalev_label: "Внутрихолдинговые проценты",
      erp_label: "Внутрихолдинговые проценты",
    },
    R057: {
      intalev_label: "Прочие внереализационные доходы",
      erp_label: "Прочие внереализационные доходы",
    },
    R058: {
      intalev_label: "Прочие внереализационные расходы",
      erp_label: "Прочие внереализационные расходы",
    },
    R059: {
      intalev_label: "Убытки прошлых периодов",
      erp_label: "Убытки прошлых периодов",
    },
    R060: {
      intalev_label: "Чистая прибыль",
      erp_label: "Чистая прибыль",
    },
    R061: {
      intalev_label: "Внутрихолдинговые дивиденды",
      erp_label: "Внутрихолдинговые дивиденды",
    },
    R062: {
      intalev_label: "Дивиденды",
      erp_label: "Дивиденды",
    },
    R065: {
      intalev_label: "Нераспределенная прибыль",
      erp_label: "Нераспределенная прибыль",
    },
  };
  const ukOverrides = {
    R021: {
      intalev_label: "Обслуживание орг.техники",
      erp_label: "Обслуживание орг.техники",
      comparison_mode: "",
      covered_by_code: "",
    },
    R045: {
      intalev_label: "Результат по финансовой деятельности",
      erp_label: "Итоги по финансовой деятельности",
    },
    R046: {
      intalev_label: "Доход по финансовой деятельности",
      erp_label: "Доходы по финансовой деятельности",
    },
    R047: {
      intalev_label: "% по депозитам",
      erp_label: "% по депозитам",
    },
    R052: {
      intalev_label: "Расходы по получению кредитов (госпошлины и пр.)",
      erp_label: "Расходы по получению кредитов (госпошлины и пр.)",
    },
    R055: {
      intalev_label:
        "Результат по инвестиционной и внереализационной деятельности",
      erp_label: "Итоги по внереализационной деятельности",
    },
    R056: {
      intalev_label: "Внутрихолдинговые проценты",
      erp_label: "Внутрихолдинговые проценты",
    },
    R057: {
      intalev_label: "Прочие внереализационные доходы",
      erp_label: "Прочие внереализационные доходы",
    },
    R058: {
      intalev_label: "Прочие внереализационные расходы",
      erp_label: "Прочие внереализационные расходы",
    },
    R059: {
      intalev_label: "Убытки прошлых периодов",
      erp_label: "Убытки прошлых периодов",
    },
    R060: {
      intalev_label: "Чистая прибыль",
      erp_label: "Чистая прибыль",
    },
    R061: {
      intalev_label: "Внутрихолдинговые дивиденды",
      erp_label: "Внутрихолдинговые дивиденды",
    },
  };
  const overrides =
    profile.templateVariant === "UK_R005"
      ? ukOverrides
      : profile.templateVariant === "MULTI_ORG_STANDARD"
        ? multiOrganizationOverrides
        : {};
  return templateRows.map((row) => ({ ...row, ...(overrides[row.code] ?? {}) }));
}

function attachTemplateHierarchy(
  templateRows,
  { erpTree, intalevTree, economicHierarchyMapping = null },
) {
  const exactBindingRows = templateRows.map((row) => {
    const erpExact = resolveHierarchyNodeFromTrace(row.erp, erpTree);
    const intalevPresentationExact = resolveHierarchyNodeFromPath(
      row.intalev_node_path,
      intalevTree,
    );
    const intalevTraceExact = resolveHierarchyNodeFromTrace(row.intalev, intalevTree);
    const intalevExact = intalevPresentationExact.node_id
      ? intalevPresentationExact
      : intalevTraceExact;
    return {
      ...row,
      erp_node_id: erpExact.node_id,
      intalev_node_id: intalevExact.node_id,
      erp_exact_node_binding: erpExact,
      intalev_exact_node_binding: intalevExact,
    };
  });
  const result = bindTemplateRowsToTrees(exactBindingRows, {
    erpTree,
    intalevTree,
    canonicalSystem: "INTALEV",
    economicHierarchyMapping,
  });
  const expectedCodes = Array.from(
    { length: 65 },
    (_, index) => `R${String(index + 1).padStart(3, "0")}`,
  );
  const actualCodes = result.rows.map((row) => normalizeText(row.code));
  const exactCodeSet =
    actualCodes.length === expectedCodes.length &&
    actualCodes.every((code, index) => code === expectedCodes[index]);
  if (!exactCodeSet) {
    result.blockers.push({
      code: "TEMPLATE_GRAPH_INCOMPLETE",
      message: "Versioned template graph must contain R001-R065 in exact order.",
      expected_codes: expectedCodes,
      actual_codes: actualCodes,
    });
  }
  result.template_graph.graph_id = "R001-R065-source-binding-20260801";
  result.template_graph.approved_intalev_reference_graph_id = normalizeText(
    templateRows[0]?.intalev_reference_graph_id,
  );
  result.template_graph.approved_intalev_reference_graph_sha256 = normalizeText(
    templateRows[0]?.intalev_reference_graph_sha256,
  );
  result.template_graph.approved_intalev_reference_template_sha256 = normalizeText(
    templateRows[0]?.intalev_reference_template_sha256,
  );
  result.template_graph.expected_codes = expectedCodes;
  result.template_graph.validation = {
    exact_code_set: exactCodeSet,
    source_derived: true,
    r_codes_are_hierarchy_source: false,
    erp_and_intalev_parents_are_separate: true,
    economic_hierarchy_mapping_status: economicHierarchyMapping ? "SUPPLIED" : "MISSING_REVIEW_ONLY",
    approved_intalev_reference_graph_complete: templateRows.every(
      (row) => row.intalev_reference_status === "PROVEN_APPROVED_TEMPLATE_GRAPH",
    ),
    erp_used_for_canonical_parent: false,
  };
  result.status = result.blockers.length === 0 ? "PASS" : "BLOCKED";
  return result;
}

function resolvedHierarchyPath(
  result,
  preferredFields,
  fallbackFields = [],
  businessLabel = "",
) {
  return (
    selectHierarchyTracePathForLabel(
      result?.trace,
      businessLabel,
      preferredFields,
    ) ||
    selectHierarchyTracePathForLabel(
      result?.trace,
      businessLabel,
      fallbackFields,
    )
  );
}

function attachTreeMetadata(rows, tree) {
  const nodeById = new Map(tree.nodes.map((node) => [node.node_id, node]));
  const nodeByInput = new Map(tree.nodes.map((node) => [node.input_index, node]));
  for (let index = 0; index < rows.length; index += 1) {
    const row = rows[index];
    const node = nodeByInput.get(index);
    if (!node) continue;
    const parent = node.parent_id ? nodeById.get(node.parent_id) : null;
    row.node_id = node.node_id;
    row.parent_id = node.parent_id;
    row.parent_index = parent?.input_index ?? null;
    row.level = node.level;
    row.parent_path = parent?.full_path ?? "";
    row.full_path = node.full_path;
    row.normalized_path = normalizeLabel(node.full_path);
    row.child_indexes = node.immediate_children
      .map((nodeId) => nodeById.get(nodeId)?.input_index)
      .filter(Number.isInteger);
    row.descendant_indexes = node.recursive_descendants
      .map((nodeId) => nodeById.get(nodeId)?.input_index)
      .filter(Number.isInteger);
    row.has_children = node.immediate_children.length > 0;
    row.row_kind = row.has_children ? "GROUP" : "LEAF";
    row.child_sum = node.immediate_child_sum;
    row.aggregation_grain = node.aggregation_grain ?? null;
    row.aggregation_grain_review = node.aggregation_grain_review ?? null;
    const hierarchyControl = node.immediate_children.length === 0
      ? { status: "LEAF", residual: null }
      : node.aggregation_grain?.status === "REVIEW_ONLY"
        ? { status: "REVIEW_ONLY_AGGREGATION_GRAIN", residual: null }
        : node.aggregation_grain?.status === "BLOCKED"
          ? { status: "BLOCKED_PROVEN_COMPOSITION_CONTRADICTION", residual: null }
          : classifyHierarchyResidual({
              parentTotal: node.direct_total,
              childSum: node.immediate_child_sum,
              tolerance: Number(config.tolerance ?? 0.01),
            });
    row.hierarchy_delta = hierarchyControl.residual;
    row.hierarchy_status = hierarchyControl.status;
    row.hierarchy_blockers = tree.blockers.filter(
      (blocker) => !blocker.node_id || blocker.node_id === node.node_id,
    );
  }
}

function asNumber(value) {
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (typeof value !== "string") return null;
  const cleaned = value
    .replace(/\u00A0/g, "")
    .replace(/\s/g, "")
    .replace(",", ".")
    .replace(/[()]/g, (match) => (match === "(" ? "-" : ""));
  if (!cleaned || cleaned === "-") return null;
  const number = Number(cleaned);
  return Number.isFinite(number) ? number : null;
}

function roundMoney(value) {
  if (value === null || value === undefined) return null;
  return Math.round((value + Number.EPSILON) * 100) / 100;
}

function unique(values) {
  return [...new Set(values)];
}

function hasFormulaErrors(report) {
  return String(report?.ndjson ?? "")
    .split(/\r?\n/)
    .filter(Boolean)
    .some((line) => {
      try {
        return JSON.parse(line).kind === "match";
      } catch {
        return true;
      }
    });
}

function safeFileName(value) {
  return normalizeText(value)
    .replace(/[\\/:*?"<>|]/g, "_")
    .replace(/\s+/g, "_")
    .slice(0, 120);
}

async function relocateInspectArtifacts(outputPath) {
  const outputDirectory = path.dirname(path.resolve(outputPath));
  const outputBase = path.basename(outputPath);
  const technicalDirectory = path.join(outputDirectory, "technical");
  await fs.mkdir(technicalDirectory, { recursive: true });

  const entries = await fs.readdir(outputDirectory, { withFileTypes: true });
  for (const entry of entries) {
    if (!entry.isFile()) continue;
    if (!/\.inspect\.ndjson$/i.test(entry.name)) continue;
    if (!entry.name.startsWith(outputBase) && entry.name !== `${outputBase}.inspect.ndjson`) {
      continue;
    }
    const sourcePath = path.join(outputDirectory, entry.name);
    const destinationPath = path.join(technicalDirectory, entry.name);
    await fs.rename(sourcePath, destinationPath).catch(async () => {
      await fs.copyFile(sourcePath, destinationPath);
      await fs.rm(sourcePath, { force: true });
    });
  }
}

async function sha256File(filePath) {
  const buffer = await fs.readFile(filePath);
  return crypto.createHash("sha256").update(buffer).digest("hex").toUpperCase();
}

async function listFilesRecursive(rootPath) {
  const stat = await fs.stat(rootPath);
  if (stat.isFile()) return [rootPath];
  const result = [];
  const entries = await fs.readdir(rootPath, { withFileTypes: true });
  for (const entry of entries) {
    if (entry.name.startsWith("~$")) continue;
    const fullPath = path.join(rootPath, entry.name);
    if (entry.isDirectory()) {
      result.push(...(await listFilesRecursive(fullPath)));
    } else {
      result.push(fullPath);
    }
  }
  return result;
}

async function operationJournalPeriods(filePath) {
  const resolved = path.resolve(filePath);
  if (!operationJournalScopeCache.has(resolved)) {
    operationJournalScopeCache.set(
      resolved,
      readOperationJournalRows({ journalPath: resolved, sheet: "Лист_1" }).then((journal) => ({
        journal,
        periods: unique(journal.rows.map((row) => normalizeText(row.period)).filter(Boolean)),
      })),
    );
  }
  return operationJournalScopeCache.get(resolved);
}

async function resolveOperationEvidenceSources(erpParsed, period) {
  const selectedOpiu = erpParsed
    .filter((item) => item?.period === period || erpParsed.length === 1)
    .map((item) => item?.source_file)
    .filter(Boolean);
  const uniqueOpiu = unique(selectedOpiu.map((filePath) => path.resolve(filePath)));
  if (uniqueOpiu.length !== 1) {
    fail(
      `BLOCKED_OPERATION_ERP_OPIU_AMBIGUOUS: expected one selected ERP OPIU for ${period}, got ${uniqueOpiu.length}.`,
    );
  }

  const erpOpiuPath = uniqueOpiu[0];
  const siblingFiles = await listFilesRecursive(path.dirname(erpOpiuPath));
  const journalCandidates = siblingFiles.filter((filePath) => {
    const name = path.basename(filePath).toLocaleLowerCase("ru-RU");
    return (
      /_01_.*\.xlsx$/i.test(name) &&
      name.includes("журнал") &&
      name.includes("проводок") &&
      name.includes("мсфо")
    );
  });
  const uniqueJournals = unique(
    journalCandidates.map((filePath) => path.resolve(filePath)),
  );
  const scopedJournals = [];
  for (const journalPath of uniqueJournals) {
    const scope = await operationJournalPeriods(journalPath);
    if (scope.periods.includes(period)) scopedJournals.push(journalPath);
  }
  if (scopedJournals.length !== 1) {
    fail(
      `BLOCKED_OPERATION_JOURNAL_AMBIGUOUS: expected one sibling ERP journal containing ${period}, got ${scopedJournals.length} of ${uniqueJournals.length}.`,
    );
  }
  return {
    journalPath: scopedJournals[0],
    erpOpiuPath,
    journalOrigin: erpSourceMetadata(scopedJournals[0]),
    erpOpiuOrigin: erpSourceMetadata(erpOpiuPath),
  };
}

async function resolveIntalevOperationJournalSource(workDir, period) {
  const archiveRoot = path.join(workDir, "intalev_archives");
  let files = [];
  try {
    files = await listFilesRecursive(archiveRoot);
  } catch (error) {
    if (error?.code === "ENOENT") {
      return {
        path: null,
        status: "NOT_FOUND_INTALEV_ARCHIVE_ROOT",
        reason: `После распаковки Инталев не создан каталог ${archiveRoot}.`,
      };
    }
    throw error;
  }
  const candidates = files.filter((filePath) => {
    const name = path.basename(filePath).toLocaleLowerCase("ru-RU").replace(/ё/g, "е");
    return (
      /\.xlsx$/i.test(name) &&
      name.includes("проводк") &&
      name.includes("управленческ") &&
      name.includes("план")
    );
  });
  const scoped = candidates.filter((filePath) => periodsFromPath(filePath).includes(period));
  const eligible = scoped.length > 0 ? scoped : candidates.length === 1 ? candidates : [];
  if (eligible.length !== 1) {
    return {
      path: null,
      status: eligible.length === 0
        ? "NOT_FOUND_INTALEV_POSTING_JOURNAL"
        : "AMBIGUOUS_INTALEV_POSTING_JOURNAL",
      reason: `Ожидался один журнал проводок Инталев за ${period}; найдено ${eligible.length} подходящих из ${candidates.length}.`,
      candidates: candidates.map((filePath) => path.resolve(filePath)),
    };
  }
  return {
    path: path.resolve(eligible[0]),
    status: "SELECTED_INTALEV_POSTING_JOURNAL",
    reason: "Выбран журнал проводок управленческого плана счетов из текущего архива Инталев.",
  };
}

function periodsFromPath(filePath) {
  const source = String(filePath ?? "")
    .replace(/\\/g, "/")
    .toLocaleLowerCase("ru-RU")
    .replace(/ё/g, "е");
  const periods = new Set();

  for (const match of source.matchAll(/(?:^|[^0-9])(20\d{2})[-_./ ](0[1-9]|1[0-2])(?:$|[^0-9])/g)) {
    periods.add(`${match[1]}-${match[2]}`);
  }
  for (const match of source.matchAll(/(?:^|[^0-9])(0[1-9]|1[0-2])[-_./ ](20\d{2})(?:$|[^0-9])/g)) {
    periods.add(`${match[2]}-${match[1]}`);
  }

  const monthPattern =
    "январь|февраль|март|апрель|май|июнь|июль|август|сентябрь|октябрь|ноябрь|декабрь";
  const russianMonthRegex = new RegExp(
    `(?:^|[^а-я])(${monthPattern})[^0-9]{0,8}(20\\d{2}|\\d{2})(?:$|[^0-9])`,
    "g",
  );
  for (const match of source.matchAll(russianMonthRegex)) {
    const year = match[2].length === 2 ? `20${match[2]}` : match[2];
    periods.add(`${year}-${russianMonthNumbers.get(match[1])}`);
  }

  const numberedRussianMonthRegex = new RegExp(
    `(?:^|[^0-9])(0?[1-9]|1[0-2])[^а-я0-9]{0,4}(${monthPattern})[^0-9]{0,8}(20\\d{2}|\\d{2})(?:$|[^0-9])`,
    "g",
  );
  for (const match of source.matchAll(numberedRussianMonthRegex)) {
    const year = match[3].length === 2 ? `20${match[3]}` : match[3];
    const monthByNumber = String(Number(match[1])).padStart(2, "0");
    const monthByName = russianMonthNumbers.get(match[2]);
    if (monthByNumber === monthByName) periods.add(`${year}-${monthByName}`);
  }

  return removeReportTypeCodesFromPeriods(filePath, [...periods]);
}

function extractPeriodFromName(filePath) {
  return periodsFromPath(path.basename(filePath))[0] ?? null;
}

function isZipArchivePath(filePath) {
  return /\.zip$/i.test(filePath) && !path.basename(filePath).startsWith("~$");
}

function safeArchiveRelativePath(entryName) {
  const parts = String(entryName ?? "")
    .replace(/\\/g, "/")
    .split("/")
    .filter((part) => part && part !== ".");
  if (parts.length === 0 || parts.some((part) => part === "..")) return null;
  const safeParts = parts.map((part) =>
    part
      .replace(/[<>:"|?*\u0000-\u001F]/g, "_")
      .replace(/[. ]+$/g, "")
      .slice(0, 140) || "_",
  );
  return path.join(...safeParts);
}

async function extractZipArchive(sourcePath, destinationDir) {
  const zip = await JSZip.loadAsync(await fs.readFile(sourcePath));
  const root = path.resolve(destinationDir);
  await fs.mkdir(root, { recursive: true });
  const extracted = [];

  for (const [entryName, entry] of Object.entries(zip.files)) {
    if (entry.dir || entryName.endsWith("/")) continue;
    const relativePath = safeArchiveRelativePath(entryName);
    if (!relativePath) {
      fail(`В архиве найден небезопасный путь: ${entryName}`);
    }
    const targetPath = path.resolve(root, relativePath);
    if (targetPath !== root && !targetPath.startsWith(`${root}${path.sep}`)) {
      fail(`В архиве найден путь за пределами рабочей папки: ${entryName}`);
    }
    await fs.mkdir(path.dirname(targetPath), { recursive: true });
    await fs.writeFile(targetPath, await entry.async("nodebuffer"));
    extracted.push(targetPath);
  }
  return extracted;
}

async function collectErpExcelFiles(erpPath, workDir) {
  if (!erpPath) fail("Укажите --erp с текущим файлом, ZIP-архивом или папкой ERP.");
  const resolved = path.resolve(erpPath);
  const stat = await fs.stat(resolved);
  const sourceFiles = stat.isFile() ? [resolved] : await listFilesRecursive(resolved);
  const excelFiles = [];
  const archiveQueue = [];
  erpSourceMetadataByPath.clear();
  erpContainerSourceRegistry.length = 0;
  for (const sourcePath of sourceFiles) {
    const directRole = classifyErpContainerSourceRole(sourcePath);
    let directSha256 = null;
    if (directRole) {
      directSha256 = await sha256File(sourcePath);
      erpContainerSourceRegistry.push({
        role: directRole,
        path: path.resolve(sourcePath),
        inputPath: path.resolve(sourcePath),
        sourceKind: "direct_file",
        archivePath: null,
        archiveEntry: null,
        archiveDepth: 0,
        sha256: directSha256,
      });
    }
    if (isExcelWorkbookPath(sourcePath)) {
      const sourceStat = await fs.stat(sourcePath);
      const absolutePath = path.resolve(sourcePath);
      excelFiles.push(absolutePath);
      erpSourceMetadataByPath.set(absolutePath.toLocaleLowerCase("ru-RU"), {
        inputPath: absolutePath,
        inputModifiedMs: sourceStat.mtimeMs,
        inputModified: sourceStat.mtime.toISOString(),
        sourceKind: "direct_excel",
        archiveDepth: 0,
        sha256: directSha256 ?? await sha256File(absolutePath),
      });
    }
    if (isZipArchivePath(sourcePath)) {
      const sourceStat = await fs.stat(sourcePath);
      archiveQueue.push({
        archivePath: path.resolve(sourcePath),
        inputPath: path.resolve(sourcePath),
        inputModifiedMs: sourceStat.mtimeMs,
        inputModified: sourceStat.mtime.toISOString(),
        archiveDepth: 1,
      });
    }
  }
  const seenArchives = new Set();
  const archiveRoot = path.join(workDir, "erp_archives");
  let archiveIndex = 0;

  while (archiveQueue.length > 0) {
    const archiveItem = archiveQueue.shift();
    const archivePath = path.resolve(archiveItem.archivePath);
    const archiveKey = archivePath.toLocaleLowerCase("ru-RU");
    if (seenArchives.has(archiveKey)) continue;
    seenArchives.add(archiveKey);
    archiveIndex += 1;
    if (archiveIndex > 200) {
      fail("В выбранном ERP-пакете найдено слишком много вложенных ZIP-архивов.");
    }

    const archiveName = safeFileName(path.basename(archivePath, path.extname(archivePath))) || "archive";
    const destination = path.join(
      archiveRoot,
      `${String(archiveIndex).padStart(3, "0")}_${archiveName}`,
    );
    let extracted;
    try {
      extracted = await extractZipArchive(archivePath, destination);
    } catch (error) {
      fail(`Не удалось прочитать ZIP-архив ${archivePath}: ${error?.message ?? error}`);
    }
    for (const extractedPath of extracted) {
      const absolutePath = path.resolve(extractedPath);
      const archiveEntry = path.relative(destination, absolutePath);
      const extractedRole = classifyErpContainerSourceRole(archiveEntry);
      let extractedSha256 = null;
      if (extractedRole) {
        extractedSha256 = await sha256File(absolutePath);
        erpContainerSourceRegistry.push({
          role: extractedRole,
          path: absolutePath,
          inputPath: archiveItem.inputPath,
          sourceKind: "archive_entry",
          archivePath,
          archiveEntry,
          archiveDepth: archiveItem.archiveDepth,
          sha256: extractedSha256,
        });
      }
      if (isExcelWorkbookPath(extractedPath)) {
        excelFiles.push(absolutePath);
        erpSourceMetadataByPath.set(absolutePath.toLocaleLowerCase("ru-RU"), {
          inputPath: archiveItem.inputPath,
          inputModifiedMs: archiveItem.inputModifiedMs,
          inputModified: archiveItem.inputModified,
          sourceKind: "archive_entry",
          archivePath,
          archiveEntry,
          archiveDepth: archiveItem.archiveDepth,
          sha256: extractedSha256 ?? await sha256File(absolutePath),
        });
      }
      if (isZipArchivePath(extractedPath)) {
        archiveQueue.push({
          archivePath: path.resolve(extractedPath),
          inputPath: archiveItem.inputPath,
          inputModifiedMs: archiveItem.inputModifiedMs,
          inputModified: archiveItem.inputModified,
          archiveDepth: archiveItem.archiveDepth + 1,
        });
      }
    }
  }

  return unique(excelFiles.map((filePath) => path.resolve(filePath)));
}

function erpSourceMetadata(filePath) {
  return (
    erpSourceMetadataByPath.get(path.resolve(filePath).toLocaleLowerCase("ru-RU")) ?? {
      inputPath: path.resolve(filePath),
      inputModifiedMs: 0,
      inputModified: "",
      sourceKind: "unknown",
      archiveDepth: 0,
    }
  );
}

function erpWorkbookCandidateRank(filePath) {
  const name = normalizeLabel(path.basename(filePath));
  const explicitlyIntalev = name.includes("intalev") || name.includes("инталев");
  if (explicitlyIntalev) return 0;

  const generatedOrCorrection =
    /(?:storno|repost|reclass|report[\s_-]*only|codex|загрузк|корректиров|перекласс|аудит|ошиб|сверк|модель|паспорт)/i.test(
      name,
    );
  if (generatedOrCorrection) return 0;

  const looksLikeOpiu = name.includes("опиу") || name.includes("опу");
  const explicitlyErp = name.includes("erp") || name.includes("ерп");
  const standardErpReport = /(?:^|[_\s-])03(?:[_\s-]+)оп(?:и)?у(?:[_\s.-]|$)/i.test(name);

  if (looksLikeOpiu && explicitlyErp && standardErpReport) return 300;
  if (looksLikeOpiu && explicitlyErp) return 200;
  if (looksLikeOpiu) return 100;
  if (explicitlyErp) return 50;
  return 0;
}

function selectLikelyErpWorkbooks(allExcel) {
  const ranked = allExcel
    .map((filePath) => ({ filePath, rank: erpWorkbookCandidateRank(filePath) }))
    .filter((candidate) => candidate.rank > 0);
  const opiuCandidates = ranked.filter((candidate) => candidate.rank >= 100);
  if (opiuCandidates.length > 0) {
    return opiuCandidates.map((candidate) => candidate.filePath);
  }
  const explicitErpCandidates = ranked.filter((candidate) => candidate.rank >= 50);
  if (explicitErpCandidates.length > 0) {
    return explicitErpCandidates.map((candidate) => candidate.filePath);
  }
  return allExcel.length === 1 ? allExcel : [];
}

function pathSelectionKey(filePath, workDir) {
  const relative = path.relative(path.resolve(workDir), path.resolve(filePath));
  const insideWorkDir =
    relative === "" || (!relative.startsWith("..") && !path.isAbsolute(relative));
  return [
    insideWorkDir ? 1 : 0,
    path.resolve(filePath).length,
    normalizeLabel(path.resolve(filePath)),
  ];
}

function comparePathSelectionKeys(left, right) {
  for (let index = 0; index < left.length; index += 1) {
    if (left[index] < right[index]) return -1;
    if (left[index] > right[index]) return 1;
  }
  return 0;
}

async function deduplicateErpWorkbookFiles(files, workDir) {
  const byHash = new Map();
  const ignoredDuplicates = [];
  for (const filePath of files) {
    const sha256 = await sha256File(filePath);
    const current = {
      filePath,
      sha256,
      selectionKey: pathSelectionKey(filePath, workDir),
    };
    const existing = byHash.get(sha256);
    if (!existing) {
      byHash.set(sha256, current);
      continue;
    }
    if (comparePathSelectionKeys(current.selectionKey, existing.selectionKey) < 0) {
      ignoredDuplicates.push(existing.filePath);
      byHash.set(sha256, current);
    } else {
      ignoredDuplicates.push(current.filePath);
    }
  }
  return {
    files: [...byHash.values()].map((item) => item.filePath),
    ignoredDuplicates,
  };
}

function periodsFromCell(value) {
  const text = normalizeText(value);
  if (!text) return [];

  const periods = new Set();
  const russianMonthPeriod = periodFromRussianMonthHeader(text);
  if (russianMonthPeriod) periods.add(russianMonthPeriod);

  const normalized = normalizeLabel(text);
  const russianMonthMatch = normalized.match(
    /(?:^|[^а-яё])(январь|февраль|март|апрель|май|июнь|июль|август|сентябрь|октябрь|ноябрь|декабрь)\s+(20\d{2})/i,
  );
  if (russianMonthMatch) {
    periods.add(
      `${russianMonthMatch[2]}-${russianMonthNumbers.get(
        russianMonthMatch[1].toLocaleLowerCase("ru-RU"),
      )}`,
    );
  }

  for (const match of normalized.matchAll(
    /(\d{1,2})\.(\d{1,2})\.(20\d{2})\s*[-–—]\s*(\d{1,2})\.(\d{1,2})\.(20\d{2})/g,
  )) {
    if (match[2] === match[5] && match[3] === match[6]) {
      const month = String(Number(match[2])).padStart(2, "0");
      if (/^(0[1-9]|1[0-2])$/.test(month)) periods.add(`${match[3]}-${month}`);
    }
  }

  for (const match of normalized.matchAll(/\b(20\d{2})[-_/](0[1-9]|1[0-2])\b/g)) {
    periods.add(`${match[1]}-${match[2]}`);
  }
  return [...periods];
}

function candidateErpSheets(workbook) {
  const sheets = workbook.worksheets.items;
  const byName = sheets.filter((sheet) => {
    const name = normalizeLabel(sheet.name);
    const isOpiu = name.includes("опиу") || name.includes("опу");
    const isIntalev = name.includes("инт") || name.includes("intalev");
    return isOpiu && !isIntalev;
  });
  if (byName.length > 0) return byName;

  const byTitle = sheets.filter((sheet) =>
    sheet
      .getRange("A1:Z15")
      .values.flat()
      .some((value) => {
        const text = normalizeLabel(value);
        return (
          text.includes("отчет о прибылях и убытках") ||
          text.includes("отчёт о прибылях и убытках")
        );
      }),
  );
  return byTitle.length > 0 ? byTitle : sheets;
}

function requestedPeriodsIfValid(mode, period) {
  if (mode === "month" && /^20\d{2}-(0[1-9]|1[0-2])$/.test(period ?? "")) {
    return [period];
  }
  const quarterMatch = String(period ?? "").match(/^(20\d{2})-Q([1-4])$/i);
  if (mode === "quarter" && quarterMatch) {
    const firstMonth = (Number(quarterMatch[2]) - 1) * 3 + 1;
    return [0, 1, 2].map(
      (offset) =>
        `${quarterMatch[1]}-${String(firstMonth + offset).padStart(2, "0")}`,
    );
  }
  if (mode === "year" && /^20\d{2}$/.test(period ?? "")) {
    return Array.from(
      { length: 12 },
      (_, index) => `${period}-${String(index + 1).padStart(2, "0")}`,
    );
  }
  return [];
}

function chooseErpPeriodSelection(periods, requestedMode, requestedPeriod) {
  const availablePeriods = unique(periods).sort();
  if (availablePeriods.length === 0) {
    fail("В выбранном отчёте ERP не найден заголовок периода.");
  }
  const available = new Set(availablePeriods);
  const requested = requestedPeriodsIfValid(requestedMode, requestedPeriod);
  if (requested.length > 0 && requested.every((period) => available.has(period))) {
    return {
      mode: requestedMode,
      period: requestedPeriod.toUpperCase(),
      adjusted: false,
      availablePeriods,
    };
  }

  if (availablePeriods.length === 1) {
    return {
      mode: "month",
      period: availablePeriods[0],
      adjusted: requestedMode !== "month" || requestedPeriod !== availablePeriods[0],
      availablePeriods,
    };
  }

  const completeQuarters = [];
  const years = unique(availablePeriods.map((period) => period.slice(0, 4))).sort();
  for (const year of years) {
    for (let quarter = 1; quarter <= 4; quarter += 1) {
      const firstMonth = (quarter - 1) * 3 + 1;
      const quarterPeriods = [0, 1, 2].map(
        (offset) => `${year}-${String(firstMonth + offset).padStart(2, "0")}`,
      );
      if (quarterPeriods.every((period) => available.has(period))) {
        completeQuarters.push(`${year}-Q${quarter}`);
      }
    }
  }
  const completeYears = years.filter((year) =>
    Array.from(
      { length: 12 },
      (_, index) => `${year}-${String(index + 1).padStart(2, "0")}`,
    ).every((period) => available.has(period)),
  );

  if (requestedMode === "year" && completeYears.length > 0) {
    return {
      mode: "year",
      period: completeYears.at(-1),
      adjusted: true,
      availablePeriods,
    };
  }
  if (requestedMode === "year") {
    fail("В выбранном ERP нет полного года из 12 месяцев.");
  }
  if (requestedMode === "quarter" && completeQuarters.length > 0) {
    return {
      mode: "quarter",
      period: completeQuarters.at(-1),
      adjusted: true,
      availablePeriods,
    };
  }
  if (requestedMode === "quarter") {
    fail("В выбранном ERP нет полного квартала из трёх месяцев.");
  }
  return {
    mode: "month",
    period: availablePeriods.at(-1),
    adjusted: requestedMode !== "month" || requestedPeriod !== availablePeriods.at(-1),
    availablePeriods,
  };
}

async function detectPeriodsInErpWorkbook(sourcePath, workDir, index) {
  await fs.mkdir(workDir, { recursive: true });
  const workingPath = path.join(
    workDir,
    `erp_period_${String(index + 1).padStart(3, "0")}.sanitized.xlsx`,
  );
  const workbook = await importSanitizedWorkbook(sourcePath, workingPath);
  const periods = new Set(periodsFromPath(sourcePath));
  const sheetNames = [];
  const identityEvidence = [
    sourcePath,
    erpSourceMetadata(sourcePath).inputPath,
    erpSourceMetadata(sourcePath).archiveEntry,
  ];
  for (const sheet of candidateErpSheets(workbook)) {
    sheetNames.push(sheet.name);
    identityEvidence.push(sheet.name);
    for (const value of sheet.getRange("A1:AZ40").values.flat()) {
      for (const period of periodsFromCell(value)) periods.add(period);
      if (normalizeText(value)) identityEvidence.push(normalizeText(value));
    }
  }
  return {
    sourceFile: sourcePath,
    sheetNames,
    periods: [...periods].sort(),
    identity_evidence: unique(identityEvidence.map(normalizeText).filter(Boolean)),
  };
}

async function detectErpPeriodCommand() {
  if (!args.erp) fail("Укажите --erp с файлом, ZIP-архивом или папкой ERP.");
  const workDir = path.join(
    workRoot,
    `period_detection_${new Date().toISOString().replace(/[-:.TZ]/g, "").slice(0, 14)}`,
  );
  await fs.mkdir(workDir, { recursive: true });
  const allExcel = await collectErpExcelFiles(args.erp, workDir);
  const candidateSelection = await deduplicateErpWorkbookFiles(
    selectLikelyErpWorkbooks(allExcel),
    workDir,
  );
  const candidates = candidateSelection.files;
  if (candidates.length === 0) {
    fail("В выбранном файле, ZIP-архиве или папке не найдено Excel-файлов ERP.");
  }

  const details = [];
  for (let index = 0; index < candidates.length; index += 1) {
    details.push(await detectPeriodsInErpWorkbook(candidates[index], workDir, index));
  }
  const detectedPeriods = unique([
    ...details.flatMap((detail) => detail.periods),
    ...periodsFromPath(args.erp),
  ]).sort();
  const selection = chooseErpPeriodSelection(
    detectedPeriods,
    String(args.mode ?? "month").toLocaleLowerCase("ru-RU"),
    String(args.period ?? "").toUpperCase(),
  );
  console.log(
    `ERP_PERIOD_JSON=${JSON.stringify({
      ...selection,
      sourceFiles: details.map((detail) => detail.sourceFile),
      sheets: unique(details.flatMap((detail) => detail.sheetNames)),
      archiveInput: isZipArchivePath(path.resolve(args.erp)),
      ignoredDuplicateSources: candidateSelection.ignoredDuplicates.length,
    })}`,
  );
}

function isExcelWorkbookPath(filePath) {
  return /\.(xlsx|xls)$/i.test(filePath) && !path.basename(filePath).startsWith("~$");
}

function isOpiuFileName(filePath) {
  return /ОП(?:И)?У/i.test(path.basename(filePath));
}

function selectedPeriods(mode, period) {
  if (mode === "month") {
    if (!/^20\d{2}-(0[1-9]|1[0-2])$/.test(period ?? "")) {
      fail("Для режима month период должен быть в формате YYYY-MM.");
    }
    return [period];
  }
  if (mode === "quarter") {
    const match = String(period ?? "").match(/^(20\d{2})-Q([1-4])$/i);
    if (!match) fail("Для режима quarter период должен быть в формате YYYY-Q1.");
    const year = Number(match[1]);
    const quarter = Number(match[2]);
    const firstMonth = (quarter - 1) * 3 + 1;
    return [0, 1, 2].map((offset) => `${year}-${String(firstMonth + offset).padStart(2, "0")}`);
  }
  if (mode === "year") {
    if (!/^20\d{2}$/.test(period ?? "")) {
      fail("Для режима year период должен быть в формате YYYY.");
    }
    return Array.from({ length: 12 }, (_, index) => `${period}-${String(index + 1).padStart(2, "0")}`);
  }
  fail("Режим должен быть month, quarter или year.");
}

async function initializeIntalevSnapshot() {
  const sourcePath = args.intalev;
  if (!sourcePath) fail("Укажите --intalev с файлом или папкой Инталев.");
  const resolvedSource = path.resolve(sourcePath);
  const sourceStat = await fs.stat(resolvedSource);
  const allExcel = (await listFilesRecursive(resolvedSource)).filter(isExcelWorkbookPath);
  const namedOpiu = allExcel.filter((filePath) => {
    const name = path.basename(filePath);
    return /Отчет_ОПИУ_/i.test(name) || isOpiuFileName(name);
  });
  const candidates = sourceStat.isFile()
    ? allExcel
    : namedOpiu.length > 0
      ? namedOpiu
      : allExcel;
  if (candidates.length === 0) {
    fail("В указанном пути не найдено ни одного файла Excel ОПИУ Инталев.");
  }

  const detectionWorkDir = path.join(
    workRoot,
    `intalev_fix_${new Date().toISOString().replace(/[-:.TZ]/g, "").slice(0, 14)}`,
  );
  await fs.mkdir(detectionWorkDir, { recursive: true });
  const byPeriod = new Map();
  for (let index = 0; index < candidates.length; index += 1) {
    const filePath = candidates[index];
    const fileNamePeriod = extractPeriodFromName(filePath);
    const periods = fileNamePeriod
      ? [fileNamePeriod]
      : await detectPeriodsInIntalevWorkbook(filePath, detectionWorkDir, index);
    for (const period of periods) {
      if (!byPeriod.has(period)) byPeriod.set(period, []);
      byPeriod.get(period).push(filePath);
    }
  }
  if (byPeriod.size === 0) {
    fail(
      "В выбранном Инталев не найдены месячные периоды. Проверьте, что в заголовках есть даты месяца.",
    );
  }
  const duplicates = [...byPeriod.entries()].filter(([, paths]) => paths.length !== 1);
  if (duplicates.length > 0) {
    fail(
      `Снимок не создан: для периодов найдены дубли: ${duplicates
        .map(([period, paths]) => `${period} (${paths.length})`)
        .join(", ")}`,
    );
  }

  const now = new Date();
  const snapshotId = now.toISOString().replace(/[-:.TZ]/g, "").slice(0, 14);
  const snapshotDir = path.join(snapshotsDir, snapshotId);
  await fs.mkdir(snapshotDir, { recursive: true });

  const files = [];
  for (const [period, paths] of [...byPeriod.entries()].sort()) {
    const source = paths[0];
    const storedName = `${period}_${safeFileName(path.basename(source))}`;
    const storedPath = path.join(snapshotDir, storedName);
    await fs.copyFile(source, storedPath);
    const stat = await fs.stat(storedPath);
    files.push({
      period,
      original_path: source,
      stored_path: path.relative(appDir, storedPath),
      sha256: await sha256File(storedPath),
      size: stat.size,
    });
  }

  const manifest = {
    schema: "uk-opiu-fixed-intalev-snapshot-v1",
    snapshot_id: snapshotId,
    fixed_at: now.toISOString(),
    source_root: resolvedSource,
    files,
  };
  const manifestPath = path.join(snapshotDir, "manifest.json");
  await fs.writeFile(manifestPath, JSON.stringify(manifest, null, 2), "utf8");
  await fs.mkdir(dataDir, { recursive: true });
  await fs.writeFile(
    currentSnapshotPath,
    JSON.stringify(
      {
        snapshot_id: snapshotId,
        manifest_path: path.relative(appDir, manifestPath),
      },
      null,
      2,
    ),
    "utf8",
  );

  console.log(`Снимок Инталев зафиксирован: ${snapshotId}`);
  console.log(`Периодов: ${files.length}`);
  console.log(`Манифест: ${manifestPath}`);
}

async function detectPeriodsInIntalevWorkbook(sourcePath, workDir, index) {
  const workingPath = path.join(
    workDir,
    `intalev_period_${String(index + 1).padStart(3, "0")}.sanitized.xlsx`,
  );
  const workbook = await importSanitizedWorkbook(sourcePath, workingPath);
  const periods = new Set();
  for (const sheet of workbook.worksheets.items) {
    for (const value of sheet.getRange("A1:AZ40").values.flat()) {
      for (const period of periodsFromCell(value)) periods.add(period);
    }
  }
  return [...periods].sort();
}

async function loadCurrentSnapshot({ verify = true } = {}) {
  let current;
  try {
    current = JSON.parse(await fs.readFile(currentSnapshotPath, "utf8"));
  } catch {
    fail("Снимок Инталев ещё не создан. Сначала выполните команду init.");
  }
  const manifestPath = path.resolve(appDir, current.manifest_path);
  const manifest = JSON.parse(await fs.readFile(manifestPath, "utf8"));
  if (verify) {
    for (const file of manifest.files) {
      const storedPath = path.resolve(appDir, file.stored_path);
      const actualHash = await sha256File(storedPath);
      if (actualHash !== file.sha256) {
        fail(`Нарушена неизменность снимка Инталев: ${storedPath}`);
      }
    }
  }
  return {
    ...manifest,
    manifest_path: manifestPath,
    source_kind: "FIXED_SNAPSHOT",
  };
}

async function collectSelectedIntalevExcelFiles(selectedPath, workDir) {
  const resolved = path.resolve(selectedPath);
  const selectedStat = await fs.stat(resolved);
  const sourceFiles = selectedStat.isFile() ? [resolved] : await listFilesRecursive(resolved);
  const excelFiles = sourceFiles.filter(isExcelWorkbookPath).map((filePath) => path.resolve(filePath));
  const archiveQueue = sourceFiles
    .filter(isZipArchivePath)
    .map((archivePath) => ({ path: path.resolve(archivePath), depth: 0 }));
  const seenArchives = new Set();
  const archiveExtractionState = { entries: 0, bytes: 0 };
  const archiveRoot = path.join(workDir, "intalev_archives");
  let archiveIndex = 0;

  while (archiveQueue.length > 0) {
    const archiveItem = archiveQueue.shift();
    const archivePath = path.resolve(archiveItem.path);
    if (archiveItem.depth > 4) {
      fail("BLOCKED_SOURCE_PROOF_ARCHIVE_LIMIT: Intalev archive depth exceeds 4.");
    }
    const archiveKey = archivePath.toLocaleLowerCase("ru-RU");
    if (seenArchives.has(archiveKey)) continue;
    seenArchives.add(archiveKey);
    archiveIndex += 1;
    if (archiveIndex > 100) {
      fail("В выбранном пакете Инталев найдено слишком много вложенных ZIP-архивов.");
    }
    const archiveName = safeFileName(path.basename(archivePath, path.extname(archivePath))) || "archive";
    const destination = path.join(
      archiveRoot,
      `${String(archiveIndex).padStart(3, "0")}_${archiveName}`,
    );
    let extracted;
    try {
      extracted = await extractZipArchiveSafely(archivePath, destination, {
        max_entries: 10_000,
        max_uncompressed_bytes: 512 * 1024 * 1024,
        max_archive_depth: 4,
        state: archiveExtractionState,
      });
    } catch (error) {
      fail(`Не удалось прочитать ZIP-архив Инталев ${archivePath}: ${error?.message ?? error}`);
    }
    for (const extractedPath of extracted) {
      if (isExcelWorkbookPath(extractedPath)) excelFiles.push(path.resolve(extractedPath));
      if (isZipArchivePath(extractedPath)) {
        archiveQueue.push({ path: path.resolve(extractedPath), depth: archiveItem.depth + 1 });
      }
    }
  }
  return unique(excelFiles);
}

async function loadSelectedIntalevSource(selectedPath, periods, workDir) {
  const resolved = path.resolve(selectedPath);
  const selectedStat = await fs.stat(resolved);
  const byPeriod = new Map();

  if (selectedStat.isFile() && isExcelWorkbookPath(resolved)) {
    for (const period of periods) {
      byPeriod.set(period, resolved);
    }
  } else {
    const allExcel = await collectSelectedIntalevExcelFiles(resolved, workDir);
    const opiuFiles = allExcel.filter(isOpiuFileName);
    const candidatesPool = opiuFiles.length > 0 ? opiuFiles : allExcel;
    if (candidatesPool.length === 0) {
      fail("В выбранном ZIP-архиве или папке Инталев не найдено ни одной книги Excel ОПИУ.");
    }
    if (candidatesPool.length === 1) {
      for (const period of periods) byPeriod.set(period, candidatesPool[0]);
    } else {
      const detectedPeriods = new Map();
      for (let index = 0; index < candidatesPool.length; index += 1) {
        const candidate = candidatesPool[index];
        const namedPeriod = extractPeriodFromName(candidate);
        const candidatePeriods = namedPeriod ? [namedPeriod] : [];
        detectedPeriods.set(candidate, candidatePeriods);
      }
      for (const period of periods) {
        const exactNamedCandidates = candidatesPool.filter(
          (filePath) => detectedPeriods.get(filePath)?.includes(period),
        );
        if (exactNamedCandidates.length === 1) {
          byPeriod.set(period, exactNamedCandidates[0]);
          continue;
        }
        if (exactNamedCandidates.length > 1) {
          fail(`Для ${period} в пакете Инталев найдено несколько месячных отчётов ОПИУ.`);
        }
        const contentCandidates = [];
        for (let index = 0; index < candidatesPool.length; index += 1) {
          const candidate = candidatesPool[index];
          if (extractPeriodFromName(candidate)) continue;
          const candidatePeriods = await detectPeriodsInIntalevWorkbook(candidate, workDir, index);
          if (candidatePeriods.includes(period)) contentCandidates.push(candidate);
        }
        if (contentCandidates.length !== 1) {
          fail(
            `Для ${period} в пакете Инталев нужен ровно один отчёт ОПИУ, найдено ${contentCandidates.length}.`,
          );
        }
        byPeriod.set(period, contentCandidates[0]);
      }
    }
  }

  const files = [];
  for (const period of periods) {
    const sourcePath = byPeriod.get(period);
    const stat = await fs.stat(sourcePath);
    files.push({
      period,
      original_path: sourcePath,
      stored_path: sourcePath,
      sha256: await sha256File(sourcePath),
      size: stat.size,
    });
  }
  const selectionHash = crypto
    .createHash("sha256")
    .update(files.map((file) => `${file.period}:${file.sha256}`).join("|"))
    .digest("hex")
    .slice(0, 12)
    .toUpperCase();
  return {
    schema: "uk-opiu-run-selected-intalev-v1",
    snapshot_id: `SELECTED_${selectionHash}`,
    fixed_at: new Date().toISOString(),
    source_root: resolved,
    files,
    manifest_path: resolved,
    source_kind: "RUN_SELECTED",
  };
}

async function showStatus() {
  const snapshot = await loadCurrentSnapshot({ verify: true });
  console.log(`Активный снимок: ${snapshot.snapshot_id}`);
  console.log(`Зафиксирован: ${snapshot.fixed_at}`);
  console.log(`Периодов: ${snapshot.files.length}`);
  for (const file of snapshot.files) {
    console.log(`${file.period}  ${file.sha256}  ${path.resolve(appDir, file.stored_path)}`);
  }
}

async function sanitizeWorkingCopy(sourcePath, targetPath) {
  const zip = await JSZip.loadAsync(await fs.readFile(sourcePath));
  for (const name of Object.keys(zip.files)) {
    const lower = name.toLowerCase();
    if (lower.startsWith("xl/comments") && lower.endsWith(".xml")) {
      const xml = await zip.file(name).async("string");
      zip.file(
        name,
        xml.replace(/<author\s*\/>|<author>\s*<\/author>/g, "<author>User</author>"),
      );
    }
  }
  const contentTypesFile = zip.file("[Content_Types].xml");
  if (contentTypesFile) {
    const contentTypes = await contentTypesFile.async("string");
    const sharedName = Object.keys(zip.files).find(
      (name) => name.toLowerCase() === "xl/sharedstrings.xml",
    );
    let fixedTypes = contentTypes;
    if (sharedName) {
      fixedTypes = fixedTypes.replace(
        /PartName="\/xl\/sharedStrings\.xml"/gi,
        `PartName="/${sharedName}"`,
      );
      fixedTypes = fixedTypes.replace(
        /PartName="\/[^"]*sharedStrings\.xml" ContentType="application\/xml"/gi,
        `PartName="/${sharedName}" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sharedStrings+xml"`,
      );
    } else {
      fixedTypes = fixedTypes.replace(
        /<Override\b[^>]*PartName="\/xl\/sharedStrings\.xml"[^>]*\/>/gi,
        "",
      );
    }
    zip.file("[Content_Types].xml", fixedTypes);
  }
  await fs.writeFile(
    targetPath,
    await zip.generateAsync({ type: "nodebuffer", compression: "DEFLATE" }),
  );
}

async function convertLegacyXls(sourcePath, targetPath) {
  const powershellPath = path.join(
    process.env.SystemRoot ?? "C:\\Windows",
    "System32",
    "WindowsPowerShell",
    "v1.0",
    "powershell.exe",
  );
  try {
    await execFileAsync(
      powershellPath,
      [
        "-NoProfile",
        "-ExecutionPolicy",
        "Bypass",
        "-File",
        xlsConverterPath,
        "-Source",
        sourcePath,
        "-Target",
        targetPath,
      ],
      {
        windowsHide: true,
        timeout: 120000,
        maxBuffer: 1024 * 1024,
      },
    );
  } catch (error) {
    fail(
      `Не удалось прочитать старый XLS ${sourcePath}. ` +
        `Для конвертации требуется установленный Microsoft Excel. ${error.message}`,
    );
  }
}

async function prepareWorkbookCopy(sourcePath, workingPath) {
  if (/\.xls$/i.test(sourcePath)) {
    const convertedPath = workingPath.replace(/\.xlsx$/i, ".converted.xlsx");
    await convertLegacyXls(sourcePath, convertedPath);
    await sanitizeWorkingCopy(convertedPath, workingPath);
    return;
  }
  await sanitizeWorkingCopy(sourcePath, workingPath);
}

async function readOutlineLevels(
  filePath,
  sheetIndex = 0,
  { required = false } = {},
) {
  const zip = await JSZip.loadAsync(await fs.readFile(filePath));
  const workbookFile = zip.file("xl/workbook.xml");
  const relsFile = zip.file("xl/_rels/workbook.xml.rels");
  if (!workbookFile || !relsFile) {
    if (required) fail(`BLOCKED_HIERARCHY_METADATA_MISSING: ${filePath}`);
    return new Map();
  }
  const workbookXml = await workbookFile.async("string");
  const relsXml = await relsFile.async("string");
  const sheetMatches = [
    ...workbookXml.matchAll(
      /<(?:[A-Za-z_][\w.-]*:)?sheet\b[^>]*name="([^"]*)"[^>]*(?:[A-Za-z_][\w.-]*:)?id="([^"]+)"/g,
    ),
  ];
  const selectedSheet = sheetMatches[sheetIndex];
  if (!selectedSheet) {
    if (required) {
      fail(`BLOCKED_HIERARCHY_METADATA_MISSING: sheet ${sheetIndex} in ${filePath}`);
    }
    return new Map();
  }
  const rel = [
    ...relsXml.matchAll(/<(?:[A-Za-z_][\w.-]*:)?Relationship\b([^>]*)\/>/g),
  ]
    .map((match) => match[1])
    .find((attrs) => attrs.includes(`Id="${selectedSheet[2]}"`));
  const target = rel?.match(/\bTarget="([^"]+)"/)?.[1];
  if (!target) {
    if (required) fail(`BLOCKED_HIERARCHY_METADATA_MISSING: sheet relation in ${filePath}`);
    return new Map();
  }
  const normalizedTarget = target.startsWith("/")
    ? target.slice(1)
    : `xl/${target.replace(/^\.\//, "")}`;
  const sheetFile = zip.file(normalizedTarget);
  if (!sheetFile) {
    if (required) fail(`BLOCKED_HIERARCHY_METADATA_MISSING: ${normalizedTarget}`);
    return new Map();
  }
  const xml = await sheetFile.async("string");
  const result = parseOutlineLevelsXml(xml);
  if (required && result.size === 0) {
    fail(`BLOCKED_HIERARCHY_METADATA_MISSING: row outline metadata in ${filePath}`);
  }
  return result;
}

async function importSanitizedWorkbook(sourcePath, workingPath) {
  await prepareWorkbookCopy(sourcePath, workingPath);
  return SpreadsheetFile.importXlsx(await FileBlob.load(workingPath));
}

function sheetPreviewValues(sheet) {
  return sheet.getRange("A1:Z15").values;
}

function sheetContainsPeriodDateRange(sheet, period) {
  const [targetYear, targetMonth] = period.split("-");
  return sheetPreviewValues(sheet).some((row) =>
    row.some((cell) => {
      const value = normalizeLabel(cell);
      const match = value.match(
        /(\d{2})\.(\d{2})\.(20\d{2})\s*-\s*(\d{2})\.(\d{2})\.(20\d{2})/,
      );
      return (
        match &&
        match[2] === targetMonth &&
        match[3] === targetYear &&
        match[5] === targetMonth &&
        match[6] === targetYear
      );
    }),
  );
}

function sheetContainsRussianMonth(sheet, period) {
  return sheetPreviewValues(sheet).some((row) =>
    row.some((cell) => periodFromRussianMonthHeader(cell) === period),
  );
}

function selectIntalevSheet(workbook, period) {
  const sheets = workbook.worksheets.items;
  return (
    sheets.find((sheet) => sheet.name === "TDSheet") ??
    sheets.find((sheet) => {
      const name = normalizeLabel(sheet.name);
      return name.includes("опиу") && name.includes("инт");
    }) ??
    sheets.find((sheet) => sheetContainsPeriodDateRange(sheet, period)) ??
    sheets[0]
  );
}

function selectErpSheet(workbook, period) {
  const sheets = workbook.worksheets.items;
  return (
    sheets.find((sheet) => {
      const name = normalizeLabel(sheet.name);
      return name.includes("опиу") && !name.includes("инт");
    }) ??
    sheets.find((sheet) => sheetContainsRussianMonth(sheet, period)) ??
    sheets[0]
  );
}

function traceText(period, items, maxItems = null, detailSheet = "02_Помесячно") {
  if (!items?.length) return "";
  const visibleItems =
    Number.isInteger(maxItems) && maxItems > 0 ? items.slice(0, maxItems) : items;
  const traces = visibleItems
    .map(
      (item) =>
        `${period}: ${path.basename(item.source_file)}!${item.sheet}!${
          item.source_cell ?? item.row
        }`,
    );
  if (visibleItems.length < items.length) {
    traces.push(
      `… ещё ${items.length - visibleItems.length} строк; полный список — ${detailSheet}`,
    );
  }
  return traces.join("; ");
}

async function loadTemplateRows(workDir) {
  const templatePath = path.resolve(config.template_path);
  const workingPath = path.join(workDir, "template.sanitized.xlsx");
  const workbook = await importSanitizedWorkbook(templatePath, workingPath);
  const sheet = workbook.worksheets.getItem("02_Месяц");
  const sheetIndex = workbook.worksheets.items.findIndex(
    (candidate) => candidate.name === sheet.name,
  );
  const outline = await readOutlineLevels(workingPath, Math.max(0, sheetIndex));
  const values = sheet.getRange("A7:E71").values;
  const rows = values.map((row, index) => ({
    code: normalizeText(row[1]),
    type: normalizeText(row[2]),
    intalev_label_raw: String(row[3] ?? ""),
    intalev_label: normalizeText(row[3]),
    erp_label: normalizeText(row[4]),
    hierarchy_level_raw: outline.get(index + 7) ?? 0,
    template_source_sheet: sheet.name,
    template_source_row: index + 7,
    template_code_cell: `B${index + 7}`,
    template_intalev_cell: `D${index + 7}`,
  }));
  if (
    rows.length !== 65 ||
    rows[0]?.code !== "R001" ||
    rows.at(-1)?.code !== "R065"
  ) {
    fail("Структура рабочего шаблона изменилась: ожидались строки R001–R065.");
  }
  return rows;
}

async function parseIntalevWorkbook(sourcePath, period, workDir, expectedHash) {
  const workingPath = path.join(workDir, `intalev_${period}.sanitized.xlsx`);
  const workbook = await importSanitizedWorkbook(sourcePath, workingPath);
  const sheet = selectIntalevSheet(workbook, period);
  const sheetIndex = workbook.worksheets.items.findIndex(
    (candidate) => candidate.name === sheet.name,
  );
  const used = sheet.getUsedRange();
  const values = used?.values ?? [];
  const bounds = used?.getBoundingBox();
  if (!bounds || values.length === 0) fail(`Пустой ОПИУ Инталев: ${sourcePath}`);

  let labelColumn = 0;
  let amountColumn = null;
  const periodHeaders = [];
  const [targetYear, targetMonth] = period.split("-");
  for (let rowIndex = 0; rowIndex < Math.min(15, values.length); rowIndex += 1) {
    for (let colIndex = 0; colIndex < values[rowIndex].length; colIndex += 1) {
      const value = normalizeLabel(values[rowIndex][colIndex]);
      if (value === "показатели") labelColumn = colIndex;
      const dateRange = value.match(
        /(\d{2})\.(\d{2})\.(20\d{2})\s*-\s*(\d{2})\.(\d{2})\.(20\d{2})/,
      );
      if (
        dateRange &&
        dateRange[2] === targetMonth &&
        dateRange[3] === targetYear &&
        dateRange[5] === targetMonth &&
        dateRange[6] === targetYear
      ) {
        periodHeaders.push({
          period,
          source_file: sourcePath,
          sheet: sheet.name,
          header_value: normalizeText(values[rowIndex][colIndex]),
          source_cell: `${columnName(bounds.startCol + colIndex + 1)}${bounds.startRow + rowIndex + 1}`,
          physical_row: bounds.startRow + rowIndex + 1,
          column: columnName(bounds.startCol + colIndex + 1),
          column_index: colIndex,
          sha256: expectedHash,
        });
      }
    }
  }
  let periodHeader;
  try {
    periodHeader = assertUniquePeriodHeader({
      period,
      headers: periodHeaders,
      sourceFile: sourcePath,
      sheet: sheet.name,
    });
  } catch (error) {
    fail(`${error.code ?? "BLOCKED_PERIOD_AMBIGUOUS"}: ${error.message}`);
  }
  amountColumn = periodHeader.column_index;

  const outline = await readOutlineLevels(workingPath, Math.max(0, sheetIndex), {
    required: true,
  });
  const nodes = [];
  const stack = [];
  for (let rowIndex = 0; rowIndex < values.length; rowIndex += 1) {
    const excelRow = bounds.startRow + rowIndex + 1;
    const sourceLabelRaw = normalizeText(values[rowIndex][labelColumn]);
    const sourceAmount = asNumber(values[rowIndex][amountColumn]);
    if (!sourceLabelRaw && sourceAmount === null) continue;
    const articleClassification = classifyIntalevArticleLabel(sourceLabelRaw);
    const label = isBlankIntalevArticleLabel(sourceLabelRaw)
      ? "<пустое значение>"
      : sourceLabelRaw;
    const level = outline.get(excelRow) ?? 0;
    const sourceIdentity = `${expectedHash}|${sheet.name}|${excelRow}`;
    const outlinePath = advanceIntalevOutlinePath(stack, {
      level,
      label,
      identity: sourceIdentity,
    });
    const fullPath = outlinePath.pathParts.join(" / ");
    const parentPath = outlinePath.parentPathParts.join(" / ");
    nodes.push({
      period,
      month: period,
      source_identity: sourceIdentity,
      source_identity_scope: `${expectedHash}|${sheet.name}|${period}`,
      parent_identity: outlinePath.parentIdentity,
      level,
      label,
      source_label_raw: sourceLabelRaw,
      source_label_present: Boolean(sourceLabelRaw),
      source_label_cell: `${columnName(bounds.startCol + labelColumn + 1)}${excelRow}`,
      article: articleClassification === "UNCLASSIFIED" ? "" : sourceLabelRaw,
      article_classification: articleClassification,
      normalized_label: normalizeLabel(label),
      full_path: fullPath,
      path_parts: [...outlinePath.pathParts],
      normalized_path: normalizeLabel(fullPath),
      parent_path: parentPath,
      parent_path_parts: [...outlinePath.parentPathParts],
      outline_gap_collapsed: outlinePath.outlineGapCollapsed,
      value: sourceAmount,
      amount: sourceAmount,
      source_cell_present: true,
      source_value_kind: sourceAmount === null ? "BLANK" : "NUMBER",
      source_file: sourcePath,
      sheet: sheet.name,
      row: excelRow,
      physical_row: excelRow,
      source_cell: `${columnName(bounds.startCol + amountColumn + 1)}${excelRow}`,
      period_header_trace: periodHeader,
      sha256: expectedHash,
    });
  }
  annotateSourceTree(nodes, {
    amountKey: "value",
    tolerance: Number(config.tolerance ?? 0.01),
    sourceSystem: "INTALEV",
  });
  const hierarchyTree = buildIntalevParentTree(
    nodes.map((node) => ({
      identity: `${expectedHash}|${sheet.name}|${node.row}`,
      parent_identity: node.parent_identity,
      source_identity_scope: `${expectedHash}|${sheet.name}|${period}`,
      label: node.label,
      path_parts: node.path_parts,
      parent_path_parts: node.parent_path_parts,
      outline_gap_collapsed: node.outline_gap_collapsed,
      source_row_role: "OUTLINE_ROW",
      aggregation_contract: "UNPROVEN",
      amount: node.value,
      source_file: node.source_file,
      sheet: node.sheet,
      row: node.row,
      source_cell: node.source_cell,
      sha256: node.sha256,
      period: node.period,
    })),
    {
      tolerance: Number(config.tolerance ?? 0.01),
      expectedSha256: expectedHash,
      requireSourceTrace: true,
      requireNonFlat: true,
    },
  );
  attachTreeMetadata(nodes, hierarchyTree);
  const sourceScopeDiagnostics = buildIntalevSourceScopeDiagnostics({
    period,
    nodes,
    tolerance: Number(config.tolerance ?? 0.01),
  });
  return {
    period,
    source_file: sourcePath,
    sheet: sheet.name,
    period_column: periodHeader.column,
    period_header_trace: periodHeader,
    nodes,
    hierarchy_tree: hierarchyTree,
    source_scope_diagnostics: sourceScopeDiagnostics,
  };
}

function pathParts(value) {
  return normalizeText(value)
    .split(/\s+\/\s+/)
    .map(normalizeLabel)
    .filter(Boolean);
}

function commonPathSuffixLength(leftPath, rightPath) {
  const left = pathParts(leftPath);
  const right = pathParts(rightPath);
  let count = 0;
  while (
    count < left.length &&
    count < right.length &&
    left[left.length - 1 - count] === right[right.length - 1 - count]
  ) {
    count += 1;
  }
  return count;
}

async function parseErpArticleCatalog(workDir) {
  const sourcePath = path.resolve(config.erp_article_catalog_path);
  const workingPath = path.join(workDir, "erp_article_catalog.sanitized.xlsx");
  const workbook = await importSanitizedWorkbook(sourcePath, workingPath);
  const sheet = workbook.worksheets.items[0];
  const used = sheet.getUsedRange();
  const values = used?.values ?? [];
  const bounds = used?.getBoundingBox();
  if (!bounds || values.length === 0) {
    fail(`Пустой справочник статей ERP: ${sourcePath}`);
  }
  const outline = await readOutlineLevels(workingPath, 0, { required: true });
  const nodes = [];
  const stack = [];
  const exactArticleNodes = new Map();
  const expenseBlocks = new Map([
    [normalizeLabel("Административные расходы"), "Административные расходы"],
    [normalizeLabel("Коммерческие расходы"), "Коммерческие расходы"],
    [normalizeLabel("Расходы на складскую логистику"), "Расходы на складскую логистику"],
    [normalizeLabel("Расходы на транспортную логистику"), "Расходы на транспортную логистику"],
  ]);
  let activeExpenseBlock = "";

  for (let rowIndex = 0; rowIndex < values.length; rowIndex += 1) {
    const excelRow = bounds.startRow + rowIndex + 1;
    if (excelRow <= 8) continue;
    const row = values[rowIndex];
    const level = outline.get(excelRow) ?? 0;
    const label = normalizeText(row[0]);
    const code = normalizeText(row[14]);

    if (!code && expenseBlocks.has(normalizeLabel(label))) {
      activeExpenseBlock = expenseBlocks.get(normalizeLabel(label));
    }

    if (code) {
      const parent = stack[level - 1];
      const entry = {
        code,
        account: label,
        functional_direction: normalizeText(row[4]),
        income_expense: normalizeText(row[6]),
        analytics: row.slice(7, 13).map(normalizeText).filter(Boolean),
        cash_flow_article: normalizeText(row[13]),
        source_row: excelRow,
      };
      if (parent) {
        parent.catalog_entries.push(entry);
      }

      // В справочнике ERP строки кода хранят точное имя статьи в колонке N,
      // тогда как outline служит визуальной свёрткой и не является обычным
      // деревом parent -> child. Строим дополнительный канонический узел по
      // фактической записи кода. Это различает одноимённые ФЗП/НДФЛ/ИТ/расходы
      // на персонал внутри административного, коммерческого и логистических
      // блоков и не позволяет склеить их только по отображаемому названию.
      const exactArticle = entry.cash_flow_article;
      if (activeExpenseBlock && exactArticle) {
        const exactPath = `${activeExpenseBlock} / ${exactArticle}`;
        const exactKey = normalizeLabel(exactPath);
        if (!exactArticleNodes.has(exactKey)) {
          exactArticleNodes.set(exactKey, {
            level: 1,
            label: exactArticle,
            normalized_label: normalizeLabel(exactArticle),
            parent_path: activeExpenseBlock,
            full_path: exactPath,
            catalog_entries: [],
            source_row: excelRow,
            exact_catalog_entry_node: true,
          });
        }
        exactArticleNodes.get(exactKey).catalog_entries.push(entry);
      }
      continue;
    }
    if (!label) continue;

    stack[level] = {
      level,
      label,
      normalized_label: normalizeLabel(label),
      parent_path: level > 0
        ? stack.slice(0, level).map((node) => node?.label).filter(Boolean).join(" / ")
        : "",
      full_path: "",
      catalog_entries: [],
      source_row: excelRow,
    };
    stack.length = level + 1;
    stack[level].full_path = [...stack]
      .map((node) => node?.label)
      .filter(Boolean)
      .join(" / ");
    nodes.push(stack[level]);
  }

  const sourceSha256 = await sha256File(sourcePath);
  const hierarchyTree = buildErpOutlineTree(
    nodes.map((node) => ({
      label: node.label,
      outlineLevel: node.level,
      full_path: node.full_path,
      source_file: sourcePath,
      sheet: sheet.name,
      row: node.source_row,
      source_cell: `A${node.source_row}`,
      sha256: sourceSha256,
    })),
    {
      requireAmounts: false,
      expectedSha256: sourceSha256,
      requireSourceTrace: true,
      requireNonFlat: true,
    },
  );
  attachTreeMetadata(nodes, hierarchyTree);
  const exactNodes = [...exactArticleNodes.values()];
  return {
    source_file: sourcePath,
    sheet: sheet.name,
    sha256: sourceSha256,
    nodes: [...nodes, ...exactNodes],
    exact_article_nodes: exactNodes,
    hierarchy_tree: hierarchyTree,
  };
}

async function parseLegacyIntalevArticleCatalog(workDir) {
  const sourcePath = path.resolve(args["intalev-articles"] ?? config.intalev_article_catalog_path);
  const workingPath = path.join(workDir, "intalev_article_catalog.sanitized.xlsx");
  const workbook = await importSanitizedWorkbook(sourcePath, workingPath);
  const sheet = workbook.worksheets.items[0];
  const used = sheet.getUsedRange();
  const values = used?.values ?? [];
  const bounds = used?.getBoundingBox();
  if (!bounds || values.length === 0) {
    fail(`Пустой справочник статей Инталев: ${sourcePath}`);
  }
  const outline = await readOutlineLevels(workingPath, 0, { required: true });
  const entries = [];
  let currentGroup = "";
  for (let rowIndex = 0; rowIndex < values.length; rowIndex += 1) {
    const excelRow = bounds.startRow + rowIndex + 1;
    if (excelRow === 1) continue;
    const row = values[rowIndex];
    const label = normalizeText(row[0]);
    if (!label) continue;
    const level = outline.get(excelRow) ?? 0;
    const isNumberedGroup = level === 0 && /^\d+_/.test(label);
    if (isNumberedGroup) currentGroup = label;
    const fullPath = level > 0 && currentGroup
      ? `${currentGroup} / ${label}`
      : label;
    entries.push({
      label,
      normalized_label: normalizeLabel(label),
      code: normalizeText(row[1]),
      cash_flow_article: normalizeText(row[2]),
      income_expense_account: normalizeText(row[3]),
      settlement_account: normalizeText(row[4]),
      new_cash_flow_classification: normalizeText(row[5]),
      level,
      group: level > 0 ? currentGroup : "",
      full_path: fullPath,
      normalized_path: normalizeLabel(fullPath),
      source_row: excelRow,
    });
  }
  return {
    source_file: sourcePath,
    sheet: sheet.name,
    sha256: await sha256File(sourcePath),
    entries,
  };
}

export function parseIntalevDeletionMark(value) {
  if (typeof value === "boolean") return { valid: true, deleted: value };
  if (typeof value === "number" && Number.isFinite(value)) {
    if (value === 0) return { valid: true, deleted: false };
    if (value === 1) return { valid: true, deleted: true };
    return { valid: false, deleted: null };
  }
  const normalized = normalizeText(value).toLocaleLowerCase("ru-RU");
  if (["", "0", "false", "ложь", "нет", "no"].includes(normalized)) {
    return { valid: true, deleted: false };
  }
  if (["1", "true", "истина", "да", "yes"].includes(normalized)) {
    return { valid: true, deleted: true };
  }
  return { valid: false, deleted: null };
}

function normalizedIntalevIdentity(value) {
  return normalizeText(value).replace(/[{}]/g, "").toLocaleLowerCase("en-US");
}

function normalizedIntalevParentIdentity(value) {
  const normalized = normalizedIntalevIdentity(value);
  const compact = normalized.replace(/[-\s]/g, "");
  return compact && /^0+$/.test(compact) ? "" : normalized;
}

export function hasIntalevParentChildEdge(entries) {
  const identities = new Set(
    (entries ?? [])
      .map((entry) => normalizedIntalevIdentity(entry?.identity || entry?.uuid))
      .filter(Boolean),
  );
  return (entries ?? []).some((entry) => {
    const identity = normalizedIntalevIdentity(entry?.identity || entry?.uuid);
    const parent = normalizedIntalevParentIdentity(
      entry?.parent_identity || entry?.parent_uuid,
    );
    return Boolean(parent && parent !== identity && identities.has(parent));
  });
}

function intalevSheetInspection(result) {
  return {
    sheet: result?.sheet ?? "",
    sheet_index: result?.sheet_index ?? null,
    status: result?.hierarchy_tree?.status ?? INTALEV_CATALOG_NOT_EXPORTED,
    structured_parent_export: result?.structured_parent_export === true,
    uid_schema_exported: result?.uid_schema_exported === true,
    deletion_status_exported: result?.deletion_status_exported === true,
    parent_child_edge_count: result?.parent_child_edge_count ?? 0,
    active_node_count: result?.entries?.length ?? 0,
    excluded_deleted_rows: result?.excluded_deleted_rows ?? 0,
    excluded_placeholder_rows: result?.excluded_placeholder_rows ?? 0,
  };
}

export function selectIntalevWorkbookCatalogSheet(sheetResults, sourcePath = "") {
  const inspectedSheets = (sheetResults ?? []).map(intalevSheetInspection);
  const validSheets = (sheetResults ?? []).filter(
    (result) =>
      result?.structured_parent_export === true &&
      result?.hierarchy_tree?.status === "PASS" &&
      result?.parent_child_edge_count > 0,
  );
  if (validSheets.length === 1) {
    return {
      ...validSheets[0],
      workbook_selection: {
        status: "PASS_UNIQUE_SEMANTIC_CLASSIFIER_SHEET",
        valid_sheet_count: 1,
        selected_sheet: validSheets[0].sheet,
        selected_sheet_index: validSheets[0].sheet_index,
        inspected_sheets: inspectedSheets,
      },
    };
  }
  if (validSheets.length > 1) {
    const blocker = {
      code: INTALEV_CATALOG_SHEET_AMBIGUOUS,
      message:
        "Workbook contains more than one semantically valid Intalev BDR classifier sheet.",
      source_file: sourcePath,
      valid_sheet_count: validSheets.length,
      sheets: validSheets.map((result) => ({
        sheet: result.sheet,
        sheet_index: result.sheet_index,
      })),
    };
    const representative = validSheets[0];
    return {
      ...representative,
      structured_parent_export: false,
      hierarchy_tree: {
        ...representative.hierarchy_tree,
        status: INTALEV_CATALOG_SHEET_AMBIGUOUS,
        blockers: [blocker, ...(representative.hierarchy_tree?.blockers ?? [])],
      },
      workbook_selection: {
        status: INTALEV_CATALOG_SHEET_AMBIGUOUS,
        valid_sheet_count: validSheets.length,
        selected_sheet: null,
        selected_sheet_index: null,
        inspected_sheets: inspectedSheets,
      },
    };
  }
  const representative = [...(sheetResults ?? [])].sort((left, right) =>
    (right?.semantic_schema_score ?? 0) - (left?.semantic_schema_score ?? 0) ||
    (right?.entries?.length ?? 0) - (left?.entries?.length ?? 0) ||
    (left?.sheet_index ?? 0) - (right?.sheet_index ?? 0),
  )[0] ?? {
    source_file: sourcePath,
    sheet: "",
    sheet_index: null,
    sha256: "",
    entries: [],
    hierarchy_tree: {
      status: INTALEV_CATALOG_NOT_EXPORTED,
      blockers: [],
      nodes: [],
    },
  };
  const blocker = {
    code: INTALEV_CATALOG_NOT_EXPORTED,
    message:
      "Workbook contains no sheet satisfying the Intalev UID classifier schema and tree contract.",
    source_file: sourcePath,
    valid_sheet_count: 0,
  };
  return {
    ...representative,
    structured_parent_export: false,
    hierarchy_tree: {
      ...representative.hierarchy_tree,
      status: INTALEV_CATALOG_NOT_EXPORTED,
      blockers: [
        blocker,
        ...(representative.hierarchy_tree?.blockers ?? []).filter(
          (item) => item?.code !== INTALEV_CATALOG_NOT_EXPORTED,
        ),
      ],
    },
    workbook_selection: {
      status: INTALEV_CATALOG_NOT_EXPORTED,
      valid_sheet_count: 0,
      selected_sheet: null,
      selected_sheet_index: null,
      inspected_sheets: inspectedSheets,
    },
  };
}

export function intalevCatalogSourcesStatus(catalog) {
  if (
    catalog?.structured_parent_export === true &&
    catalog?.hierarchy_tree?.status === "PASS"
  ) {
    return "ACTIVE_STRUCTURAL_CLASSIFIER";
  }
  return catalog?.workbook_selection?.status ??
    catalog?.hierarchy_tree?.status ??
    INTALEV_CATALOG_NOT_EXPORTED;
}

async function parseIntalevArticleCatalogSheet({
  sourcePath,
  sourceSha256,
  workingPath,
  sheet,
  sheetIndex,
}) {
  const used = sheet.getUsedRange();
  const values = used?.values ?? [];
  const bounds = used?.getBoundingBox();
  if (!bounds || values.length === 0) {
    return {
      source_file: sourcePath,
      sheet: sheet.name,
      sheet_index: sheetIndex,
      sha256: sourceSha256,
      entries: [],
      hierarchy_tree: {
        status: INTALEV_CATALOG_NOT_EXPORTED,
        blockers: [{
          code: "BLOCKED_INTALEV_CATALOG_EMPTY_SHEET",
          message: "Intalev classifier sheet is empty.",
          sheet: sheet.name,
          sheet_index: sheetIndex,
        }],
        nodes: [],
      },
      structured_parent_export: false,
      uid_schema_exported: false,
      deletion_status_exported: false,
      parent_child_edge_count: 0,
      excluded_deleted_rows: 0,
      excluded_placeholder_rows: 0,
      semantic_schema_score: 0,
      header_format: "OUTLINE",
    };
  }
  const outline = await readOutlineLevels(workingPath, sheetIndex);
  const detectedHeaders = detectIntalevCatalogHeaders(values);
  const { headerRowIndex, columns } = detectedHeaders;
  const referenceColumn = columns.uuid;
  const deletionColumn = columns.deletion_mark;
  const parentColumn = columns.parent_uuid;
  const groupFlagColumn = columns.is_group;
  const codeColumn = columns.code;
  const nameColumn = columns.name;
  const orderColumn = columns.order;
  const kindColumn = columns.kind;
  const formulaColumn = columns.formula;
  const fullPathColumn = columns.full_path;
  const uidSchemaExported =
    headerRowIndex >= 0 &&
    Number.isInteger(referenceColumn) &&
    Number.isInteger(parentColumn) &&
    Number.isInteger(nameColumn);
  const deletionStatusExported = uidSchemaExported && Number.isInteger(deletionColumn);
  const entries = [];
  const schemaBlockers = [];
  let currentGroup = "";
  let excludedDeletedRows = 0;
  let excludedPlaceholderRows = 0;
  for (let rowIndex = 0; rowIndex < values.length; rowIndex += 1) {
    const excelRow = bounds.startRow + rowIndex + 1;
    if (
      (headerRowIndex >= 0 && rowIndex <= headerRowIndex) ||
      (headerRowIndex < 0 && excelRow === 1)
    ) {
      continue;
    }
    const row = values[rowIndex];
    const identity = uidSchemaExported ? normalizeText(row[referenceColumn]) : "";
    const parentIdentity = uidSchemaExported ? normalizeText(row[parentColumn]) : "";
    const label = normalizeText(row[uidSchemaExported ? nameColumn : 0]);
    if (!label && !identity && !parentIdentity) continue;
    let deletion = { valid: true, deleted: false };
    if (uidSchemaExported) {
      if (!deletionStatusExported) {
        deletion = { valid: false, deleted: null };
      } else {
        deletion = parseIntalevDeletionMark(row[deletionColumn]);
        if (!deletion.valid) {
          schemaBlockers.push({
            code: "BLOCKED_INTALEV_CATALOG_DELETION_MARK_INVALID",
            message: "Deletion mark must be an explicit boolean/0/1 value.",
            sheet: sheet.name,
            sheet_index: sheetIndex,
            row: excelRow,
            source_cell: columnName(deletionColumn + 1) + excelRow,
            value: normalizeText(row[deletionColumn]),
          });
        }
      }
      if (deletion.deleted === true) {
        excludedDeletedRows += 1;
        continue;
      }
      if (!deletion.valid) continue;
    }
    const level = outline.get(excelRow) ?? 0;
    const isNumberedGroup = !uidSchemaExported && level === 0 && /^\d+_/.test(label);
    if (isNumberedGroup) currentGroup = label;
    const fullPath = uidSchemaExported
      ? Number.isInteger(fullPathColumn)
        ? normalizeText(row[fullPathColumn])
        : ""
      : level > 0 && currentGroup
          ? [currentGroup, label].join(" / ")
          : label;
    if (
      uidSchemaExported &&
      isIntalevCatalogPlaceholderRow({ identity, parentIdentity, label, fullPath })
    ) {
      excludedPlaceholderRows += 1;
      continue;
    }
    entries.push({
      identity,
      uuid: identity,
      parent_identity: parentIdentity,
      parent_uuid: parentIdentity,
      deletion_mark: uidSchemaExported && deletionStatusExported
        ? normalizeText(row[deletionColumn])
        : "",
      is_group: uidSchemaExported && Number.isInteger(groupFlagColumn)
        ? row[groupFlagColumn]
        : uidSchemaExported
          ? false
          : level === 0,
      label,
      normalized_label: normalizeLabel(label),
      code: uidSchemaExported
        ? Number.isInteger(codeColumn)
          ? normalizeText(row[codeColumn])
          : ""
        : normalizeText(row[1]),
      order: uidSchemaExported && Number.isInteger(orderColumn)
        ? normalizeText(row[orderColumn])
        : "",
      kind: uidSchemaExported && Number.isInteger(kindColumn)
        ? normalizeText(row[kindColumn])
        : "",
      formula: uidSchemaExported && Number.isInteger(formulaColumn)
        ? normalizeText(row[formulaColumn])
        : "",
      cash_flow_article: uidSchemaExported ? "" : normalizeText(row[2]),
      income_expense_account: uidSchemaExported ? "" : normalizeText(row[3]),
      settlement_account: uidSchemaExported ? "" : normalizeText(row[4]),
      new_cash_flow_classification: uidSchemaExported ? "" : normalizeText(row[5]),
      level,
      group: !uidSchemaExported && level > 0 ? currentGroup : "",
      full_path: fullPath,
      source_full_path: uidSchemaExported && Number.isInteger(fullPathColumn)
        ? normalizeText(row[fullPathColumn])
        : "",
      normalized_path: normalizeLabel(fullPath),
      source_row: excelRow,
      source_column: Number.isInteger(nameColumn) ? nameColumn : 0,
      source_cell: columnName((Number.isInteger(nameColumn) ? nameColumn : 0) + 1) + excelRow,
    });
  }
  if (uidSchemaExported && !deletionStatusExported) {
    schemaBlockers.push({
      code: "BLOCKED_INTALEV_CATALOG_DELETION_MARK_NOT_EXPORTED",
      message:
        "The UID classifier does not export a deletion-mark column; active nodes cannot be proven.",
      sheet: sheet.name,
      sheet_index: sheetIndex,
    });
  }
  const hierarchyTree = buildIntalevParentTree(
    entries.map((entry) => ({
      identity: entry.identity || [sourceSha256, sheet.name, entry.source_row].join("|"),
      parent_identity: entry.parent_identity,
      uuid: entry.uuid,
      parent_uuid: entry.parent_uuid,
      is_group: entry.is_group,
      code: entry.code,
      label: entry.label,
      full_path: entry.full_path,
      group: entry.group,
      source_file: sourcePath,
      sheet: sheet.name,
      row: entry.source_row,
      source_cell: columnName(entry.source_column + 1) + entry.source_row,
      sha256: sourceSha256,
    })),
    {
      requireAmounts: false,
      expectedSha256: sourceSha256,
      requireSourceTrace: true,
      requireNonFlat: true,
      requireIdentity: true,
      parentIdentityOnly: true,
    },
  );
  const hasParentChildEdge = hasIntalevParentChildEdge(entries);
  if (uidSchemaExported && deletionStatusExported && !hasParentChildEdge) {
    schemaBlockers.push({
      code: "BLOCKED_INTALEV_CATALOG_PARENT_CHILD_EDGE_NOT_EXPORTED",
      message:
        "The classifier does not contain an active child whose parent UUID references an active node.",
      sheet: sheet.name,
      sheet_index: sheetIndex,
    });
  }
  const semanticSchemaPass =
    uidSchemaExported &&
    deletionStatusExported &&
    schemaBlockers.length === 0 &&
    hasParentChildEdge;
  if (!semanticSchemaPass) {
    hierarchyTree.status = INTALEV_CATALOG_NOT_EXPORTED;
    hierarchyTree.blockers.unshift(
      {
        code: INTALEV_CATALOG_NOT_EXPORTED,
        message:
          "Fresh UID export requires UUID, parent UUID, name, deletion status, and an active parent-child edge.",
        sheet: sheet.name,
        sheet_index: sheetIndex,
      },
      ...schemaBlockers,
    );
  }
  attachTreeMetadata(entries, hierarchyTree);
  return {
    source_file: sourcePath,
    sheet: sheet.name,
    sheet_index: sheetIndex,
    sha256: sourceSha256,
    entries,
    hierarchy_tree: hierarchyTree,
    structured_parent_export: semanticSchemaPass && hierarchyTree.status === "PASS",
    uid_schema_exported: uidSchemaExported,
    deletion_status_exported: deletionStatusExported,
    parent_child_edge_count: hasParentChildEdge ? 1 : 0,
    excluded_deleted_rows: excludedDeletedRows,
    excluded_placeholder_rows: excludedPlaceholderRows,
    semantic_schema_score:
      (uidSchemaExported ? 3 : 0) +
      (deletionStatusExported ? 1 : 0) +
      (hasParentChildEdge ? 1 : 0),
    header_format: detectedHeaders.format,
  };
}

export async function parseIntalevArticleCatalog(
  workDir,
  selectedSourcePath = args["intalev-articles"] ?? config.intalev_article_catalog_path,
  probeSuffix = "selected",
) {
  const sourcePath = path.resolve(selectedSourcePath);
  const workingPath = path.join(
    workDir,
    `intalev_article_catalog.${safeFileName(probeSuffix)}.sanitized.xlsx`,
  );
  const workbook = await importSanitizedWorkbook(sourcePath, workingPath);
  const sourceSha256 = await sha256File(sourcePath);
  const sheetResults = [];
  for (let sheetIndex = 0; sheetIndex < workbook.worksheets.items.length; sheetIndex += 1) {
    sheetResults.push(await parseIntalevArticleCatalogSheet({
      sourcePath,
      sourceSha256,
      workingPath,
      sheet: workbook.worksheets.items[sheetIndex],
      sheetIndex,
    }));
  }
  return selectIntalevWorkbookCatalogSheet(sheetResults, sourcePath);
}

export async function parseConfiguredIntalevArticleCatalogIfPresent(
  workDir,
  selectedSourcePath,
  probeSuffix = "configured_legacy",
) {
  const configuredValue = normalizeText(selectedSourcePath);
  const sourcePath = configuredValue ? path.resolve(configuredValue) : "";
  let sourceIsFile = false;
  if (sourcePath) {
    try {
      sourceIsFile = (await fs.stat(sourcePath)).isFile();
    } catch (error) {
      if (error?.code !== "ENOENT") throw error;
    }
  }
  if (sourceIsFile) {
    return {
      status: "FOUND_CONFIGURED_FALLBACK",
      catalog: await parseIntalevArticleCatalog(workDir, sourcePath, probeSuffix),
    };
  }
  const catalog = selectIntalevWorkbookCatalogSheet([], sourcePath);
  catalog.hierarchy_tree.blockers.unshift({
    code: "BLOCKED_INTALEV_CATALOG_OPTIONAL_FALLBACK_MISSING",
    message:
      "The selected Intalev container did not provide a proven UID classifier; " +
      "the optional legacy fallback is not packaged. The report remains diagnostic.",
    source_file: sourcePath,
  });
  return {
    status: "MISSING_OPTIONAL_FALLBACK_REPORT_ONLY",
    catalog,
  };
}

async function selectIntalevArticleCatalog(workDir) {
  if (args["intalev-articles"]) {
    const sourcePath = path.resolve(args["intalev-articles"]);
    const before = await captureSourceEvidence({ role: "intalev_uid", filePath: sourcePath });
    const parsed = await parseIntalevArticleCatalog(workDir, sourcePath, "explicit");
    if (parsed.workbook_selection?.status === INTALEV_CATALOG_SHEET_AMBIGUOUS) {
      fail(`${INTALEV_CATALOG_SHEET_AMBIGUOUS}: ${JSON.stringify(parsed.workbook_selection)}`);
    }
    const after = await assertSourceUnchanged(before);
    return {
      catalog: parsed,
      discovery: parsed.structured_parent_export && parsed.hierarchy_tree.status === "PASS"
        ? {
            status: "PASS_EXPLICIT_STRUCTURAL_CLASSIFIER_REHASHED",
            candidate_count: 1,
            container_before: {
              path: sourcePath,
              kind: "file",
              size: after.size_after,
              sha256: after.sha256_after,
            },
            scan_totals: { entries: 1, bytes: after.size_after },
            selected: {
              source_path: sourcePath,
              parsed,
              provenance: {
                selection_mode: "EXPLICIT_ARGUMENT",
                source_kind: "DIRECT_FILE",
                entry_path: path.basename(sourcePath),
                archive_entry_path: null,
                archive_sha256: null,
                archive_chain: [],
                size: after.size_after,
                sha256: after.sha256_after,
                hash_stable: true,
                tree_status: parsed.hierarchy_tree.status,
                node_count: parsed.entries.length,
                sheet: parsed.sheet,
              },
            },
          }
        : null,
    };
  }
  let attemptedDiscovery = null;
  if (args.intalev) {
    const selectedPath = path.resolve(args.intalev);
    const selectedStat = await fs.stat(selectedPath);
    if (selectedStat.isDirectory() || (selectedStat.isFile() && isZipArchivePath(selectedPath))) {
      const ambiguousWorkbooks = [];
      const discovery = await discoverIntalevArticleCatalog({
        sourcePath: selectedPath,
        workDir: path.join(workDir, "intalev_catalog_candidates"),
        probeWorkbook: async (candidatePath, ordinal) => {
          const parsed = await parseIntalevArticleCatalog(
            workDir,
            candidatePath,
            `probe_${ordinal}`,
          );
          if (parsed.workbook_selection?.status === INTALEV_CATALOG_SHEET_AMBIGUOUS) {
            ambiguousWorkbooks.push({
              candidate_path: candidatePath,
              workbook_selection: parsed.workbook_selection,
            });
          }
          return parsed;
        },
      });
      if (ambiguousWorkbooks.length > 0) {
        fail(`${INTALEV_CATALOG_SHEET_AMBIGUOUS}: ${JSON.stringify({
          container: selectedPath,
          ambiguous_workbooks: ambiguousWorkbooks,
        })}`);
      }
      attemptedDiscovery = discovery;
      if (discovery.selected) {
        return { catalog: discovery.selected.parsed, discovery };
      }
    }
  }
  const configuredSelection = await parseConfiguredIntalevArticleCatalogIfPresent(
    workDir,
    config.intalev_article_catalog_path,
    "configured_legacy",
  );
  const configuredCatalog = configuredSelection.catalog;
  if (configuredCatalog.workbook_selection?.status === INTALEV_CATALOG_SHEET_AMBIGUOUS) {
    fail(`${INTALEV_CATALOG_SHEET_AMBIGUOUS}: ${JSON.stringify(
      configuredCatalog.workbook_selection,
    )}`);
  }
  return {
    catalog: configuredCatalog,
    discovery: attemptedDiscovery,
    selection_mode: attemptedDiscovery
      ? "AUTO_DETECTED_CONTAINER"
      : configuredSelection.status,
  };
}

function matchErpRowToCatalog(row, catalog) {
  if (!row.article) {
    return {
      catalog_status: "NOT_ARTICLE",
      catalog_path: "",
      catalog_codes: "",
      catalog_accounts: "",
      catalog_source_rows: "",
    };
  }
  const normalizedArticle = normalizeLabel(row.article);
  const normalizedReportSection = normalizeLabel(row.report_section);
  const matchingNodes = catalog.nodes
    .filter((node) => node.normalized_label === normalizedArticle);
  const entryBoundNodes = matchingNodes.filter((node) =>
    Array.isArray(node.catalog_entries) && node.catalog_entries.length > 0);
  const candidates = (entryBoundNodes.length > 0 ? entryBoundNodes : matchingNodes)
    .map((node) => ({
      node,
      // The source report has two structural columns: the section in column A
      // and the article in column B. Excel outline levels are capped at 7, so
      // the explicit section is stronger evidence than a saturated outline.
      score:
        (normalizedReportSection &&
        normalizeLabel(pathParts(node.full_path)[0]) === normalizedReportSection
          ? 1000
          : 0) + commonPathSuffixLength(row.full_path, node.full_path),
    }))
    .sort(
      (left, right) =>
        right.score - left.score ||
        left.node.level - right.node.level ||
        left.node.source_row - right.node.source_row,
    );
  if (candidates.length === 0) {
    return {
      catalog_status: "MISSING",
      catalog_path: "",
      catalog_codes: "",
      catalog_accounts: "",
      catalog_source_rows: "",
    };
  }
  const bestScore = candidates[0].score;
  const best = candidates.filter((candidate) => candidate.score === bestScore);
  if (best.length !== 1) {
    return {
      catalog_status: "AMBIGUOUS",
      catalog_path: best.map((candidate) => candidate.node.full_path).join(" | "),
      catalog_codes: "",
      catalog_accounts: "",
      catalog_source_rows: best.map((candidate) => candidate.node.source_row).join(", "),
    };
  }
  const node = best[0].node;
  return {
    catalog_status: "MATCHED",
    catalog_path: node.full_path,
    catalog_codes: unique(node.catalog_entries.map((entry) => entry.code)).join(", "),
    catalog_accounts: unique(
      node.catalog_entries.map((entry) => entry.account).filter(Boolean),
    ).join(", "),
    catalog_source_rows: [
      node.source_row,
      ...node.catalog_entries.map((entry) => entry.source_row),
    ].join(", "),
  };
}

async function parseErpWorkbook(
  sourcePath,
  period,
  workDir,
  erpCatalog,
  expectedHash,
) {
  const workingPath = path.join(workDir, `erp_${period}.sanitized.xlsx`);
  const workbook = await importSanitizedWorkbook(sourcePath, workingPath);
  const sheet = selectErpSheet(workbook, period);
  const sheetIndex = workbook.worksheets.items.findIndex(
    (candidate) => candidate.name === sheet.name,
  );
  const used = sheet.getUsedRange();
  const values = used?.values ?? [];
  const bounds = used?.getBoundingBox();
  if (!bounds || values.length === 0) fail(`Пустой ОПИУ ERP: ${sourcePath}`);

  let headerRowIndex = 0;
  let summaryColumn = 0;
  let articleColumn = 1;
  const dimensionColumnsByRole = {
    organization: [],
    cfo: [],
    department: [],
  };
  const periodHeaders = [];
  for (let rowIndex = 0; rowIndex < Math.min(15, values.length); rowIndex += 1) {
    for (let colIndex = 0; colIndex < values[rowIndex].length; colIndex += 1) {
      const value = normalizeLabel(values[rowIndex][colIndex]);
      if (value.includes("статьи доходов и расходов")) {
        headerRowIndex = rowIndex;
        articleColumn = colIndex;
      }
      const dimensionRole = dimensionRoleForHeader(value);
      if (dimensionRole) dimensionColumnsByRole[dimensionRole].push(colIndex);
      if (value.includes("отчет о прибылях и убытках")) summaryColumn = colIndex;
      if (periodFromRussianMonthHeader(value) === period) {
        periodHeaders.push({
          period,
          source_file: sourcePath,
          sheet: sheet.name,
          header_value: normalizeText(values[rowIndex][colIndex]),
          source_cell: `${columnName(bounds.startCol + colIndex + 1)}${bounds.startRow + rowIndex + 1}`,
          physical_row: bounds.startRow + rowIndex + 1,
          column: columnName(bounds.startCol + colIndex + 1),
          column_index: colIndex,
          sha256: expectedHash,
        });
      }
    }
  }
  const uniqueDimensionColumns = unique(Object.values(dimensionColumnsByRole).flat());
  const roleColumns = Object.fromEntries(
    Object.entries(dimensionColumnsByRole).map(([role, columns]) => [role, unique(columns)]),
  );
  let periodHeader;
  try {
    periodHeader = assertUniquePeriodHeader({
      period,
      headers: periodHeaders,
      sourceFile: sourcePath,
      sheet: sheet.name,
    });
  } catch (error) {
    fail(`${error.code ?? "BLOCKED_PERIOD_AMBIGUOUS"}: ${error.message}`);
  }
  const amountColumn = periodHeader.column_index;

  const outline = await readOutlineLevels(workingPath, Math.max(0, sheetIndex), {
    required: true,
  });
  const rows = [];
  const semanticStack = [];
  const dimensionContextStacks = {
    organization: [],
    cfo: [],
    department: [],
  };
  let lastSummaryRowIndex = null;
  const hash = expectedHash;
  const sourceMetadata = erpSourceMetadata(sourcePath);
  for (let rowIndex = headerRowIndex + 1; rowIndex < values.length; rowIndex += 1) {
    const excelRow = bounds.startRow + rowIndex + 1;
    const summaryLabel = normalizeText(values[rowIndex][summaryColumn]);
    const article = normalizeText(values[rowIndex][articleColumn]);
    const directDimensionsByRole = Object.fromEntries(
      Object.entries(roleColumns).map(([role, columns]) => [
        role,
        normalizeDimensionValues(columns.map((colIndex) => values[rowIndex][colIndex])),
      ]),
    );
    const directDimensions = normalizeDimensionValues(Object.values(directDimensionsByRole));
    const amount = asNumber(values[rowIndex][amountColumn]);
    if (!summaryLabel && !article && directDimensions.length === 0 && amount === null) continue;

    const sourceLevel = outline.get(excelRow) ?? 0;
    const inheritedDimensionsByRole = {};
    for (const role of Object.keys(dimensionContextStacks)) {
      const stack = dimensionContextStacks[role];
      stack.length = sourceLevel + 1;
      stack[sourceLevel] = directDimensionsByRole[role];
      inheritedDimensionsByRole[role] = directDimensionsByRole[role].length > 0
        ? directDimensionsByRole[role]
        : normalizeDimensionValues(stack.slice(0, sourceLevel + 1));
    }
    const inheritedDimensions = normalizeDimensionValues(Object.values(inheritedDimensionsByRole));

    const hierarchyLabel = article || summaryLabel;
    if (!hierarchyLabel) continue;

    const {
      parent,
      parentIndex,
      level,
      parentPath,
    } = selectErpSemanticParent({
      article,
      lastSummaryRowIndex,
      rows,
      semanticStack,
      sourceLevel,
    });

    const fullPath = [parentPath, hierarchyLabel].filter(Boolean).join(" / ");
    const organizationDimension = inheritedDimensionsByRole.organization.join(" | ");
    const cfoDimension = inheritedDimensionsByRole.cfo.join(" | ");
    const departmentDimension = inheritedDimensionsByRole.department.join(" | ");
    const dimensionIdentity = buildRoleBoundDimensionIdentity({
      organizationCode: organizationDimension,
      cfo: cfoDimension,
      department: departmentDimension,
    });
    const row = {
      period,
      month: period,
      source_identity: `${hash}|${sheet.name}|${excelRow}`,
      source_identity_scope: `${hash}|${sheet.name}|${period}`,
      level,
      source_level: sourceLevel,
      summary_label: summaryLabel,
      article,
      report_section: normalizeText(parent?.summary_label),
      organization: organizationDimension,
      cfo: cfoDimension,
      department: departmentDimension,
      organizational_dimensions: inheritedDimensions,
      dimension_key: dimensionIdentity.identity,
      dimension_identity_status: dimensionIdentity.status,
      dimension_roles: dimensionIdentity.roles,
      dimensions_used_for_identity: true,
      dimensions_not_posting_axis: true,
      parent_path: parentPath,
      full_path: fullPath,
      normalized_path: normalizeLabel(fullPath),
      parent_index: parentIndex,
      amount,
      source_file: sourcePath,
      input_origin: sourceMetadata.inputPath,
      source_modified: sourceMetadata.inputModified,
      archive_entry: sourceMetadata.archiveEntry ?? "",
      organization_proof: sourceMetadata.organizationProof ?? null,
      sheet: sheet.name,
      row: excelRow,
      physical_row: excelRow,
      source_cell: `${columnName(bounds.startCol + amountColumn + 1)}${excelRow}`,
      period_header_trace: periodHeader,
      sha256: hash,
    };
    Object.assign(row, matchErpRowToCatalog(row, erpCatalog));
    const currentIndex = rows.length;
    rows.push(row);
    if (summaryLabel && !article) {
      lastSummaryRowIndex = currentIndex;
      semanticStack.push({
        source_level: sourceLevel,
        level,
        full_path: fullPath,
        row_index: currentIndex,
      });
    }
  }
  rows.forEach((row, index) => {
    row.child_indexes = directChildren(rows, index);
    const children = row.child_indexes.map((childIndex) => rows[childIndex]);
    row.child_sum =
      row.article &&
      children.length > 0 &&
      children.every((child) => typeof child.amount === "number")
        ? roundMoney(children.reduce((sum, child) => sum + child.amount, 0))
        : null;
    row.hierarchy_delta =
      typeof row.amount === "number" && typeof row.child_sum === "number"
        ? roundMoney(row.amount - row.child_sum)
        : null;
    row.hierarchy_status =
      !row.article
        ? "NOT_ARTICLE"
        : children.length === 0
        ? "LEAF"
        : typeof row.hierarchy_delta !== "number"
          ? "BLOCKED"
          : Math.abs(row.hierarchy_delta) <= Number(config.tolerance ?? 0.01)
            ? "PASS"
            : "BLOCKED";
  });
  annotateSourceTree(rows, {
    amountKey: "amount",
    tolerance: Number(config.tolerance ?? 0.01),
    sourceSystem: "ERP",
  });
  const hierarchyTree = buildErpOutlineTree(
    rows.map((row) => ({
      label: row.article || row.summary_label,
      code: row.catalog_codes,
      // Excel limits outlineLevel to 7. Use the semantic hierarchy reconstructed
      // from the report columns so later rows do not fall out of their section.
      outlineLevel: row.level,
      parent_index: row.parent_index,
      full_path: row.full_path,
      source_level: row.source_level,
      amount: row.amount,
      source_file: row.source_file,
      sheet: row.sheet,
      row: row.row,
      source_cell: row.source_cell,
      sha256: row.sha256,
      identity: row.source_identity,
      source_identity_scope: row.source_identity_scope,
      dimension_key: row.dimension_key,
      dimension_identity_status: row.dimension_identity_status,
      dimension_roles: row.dimension_roles,
      organization: row.organization,
      cfo: row.cfo,
      department: row.department,
      source_row_role: row.article ? "ARTICLE" : "SUMMARY",
      aggregation_contract: "UNPROVEN",
      period: row.period,
    })),
    {
      tolerance: Number(config.tolerance ?? 0.01),
      expectedSha256: hash,
      requireSourceTrace: true,
      requireNonFlat: true,
    },
  );
  attachTreeMetadata(rows, hierarchyTree);
  return {
    period,
    source_file: sourcePath,
    input_origin: sourceMetadata.inputPath,
    source_modified: sourceMetadata.inputModified,
    archive_entry: sourceMetadata.archiveEntry ?? "",
    sheet: sheet.name,
    sha256: hash,
    period_column: columnName(bounds.startCol + amountColumn + 1),
    period_header_trace: periodHeader,
    organizational_dimension_columns: uniqueDimensionColumns.map(
      (colIndex) => columnName(bounds.startCol + colIndex + 1),
    ),
    dimensions_used_for_identity: true,
    dimensions_not_posting_axis: true,
    rows,
    hierarchy_tree: hierarchyTree,
  };
}

function rebuildErpParsedHierarchyAfterPostedOverlay(parsed) {
  parsed.rows.forEach((row, index) => {
    row.child_indexes = directChildren(parsed.rows, index);
    const children = row.child_indexes.map((childIndex) => parsed.rows[childIndex]);
    row.child_sum =
      row.article &&
      children.length > 0 &&
      children.every((child) => typeof child.amount === "number")
        ? roundMoney(children.reduce((sum, child) => sum + child.amount, 0))
        : null;
    row.hierarchy_delta =
      typeof row.amount === "number" && typeof row.child_sum === "number"
        ? roundMoney(row.amount - row.child_sum)
        : null;
    row.hierarchy_status =
      !row.article
        ? "NOT_ARTICLE"
        : children.length === 0
          ? "LEAF"
          : typeof row.hierarchy_delta !== "number"
            ? "BLOCKED"
            : Math.abs(row.hierarchy_delta) <= Number(config.tolerance ?? 0.01)
              ? "PASS"
              : "BLOCKED";
  });
  annotateSourceTree(parsed.rows, {
    amountKey: "amount",
    tolerance: Number(config.tolerance ?? 0.01),
    sourceSystem: "ERP",
  });
  parsed.hierarchy_tree = buildErpOutlineTree(
    parsed.rows.map((row) => ({
      label: row.article || row.summary_label,
      code: row.catalog_codes,
      outlineLevel: row.level,
      parent_index: row.parent_index,
      full_path: row.full_path,
      source_level: row.source_level,
      amount: row.amount,
      source_file: row.source_file,
      sheet: row.sheet,
      row: row.row,
      source_cell: row.source_cell,
      sha256: row.sha256,
      identity: row.source_identity,
      source_identity_scope: row.source_identity_scope,
      dimension_key: row.dimension_key,
      dimension_identity_status: row.dimension_identity_status,
      dimension_roles: row.dimension_roles,
      organization: row.organization,
      cfo: row.cfo,
      department: row.department,
      source_row_role: row.article ? "ARTICLE" : "SUMMARY",
      aggregation_contract: "UNPROVEN",
      period: row.period,
    })),
    {
      tolerance: Number(config.tolerance ?? 0.01),
      expectedSha256: parsed.sha256,
      requireSourceTrace: true,
      requireNonFlat: true,
    },
  );
  attachTreeMetadata(parsed.rows, parsed.hierarchy_tree);
}

function resolvedResult(amount, status, trace = [], note = "") {
  return { amount: roundMoney(amount), status, trace, note };
}

function resolveErpHierarchyCandidate(candidate, parsed) {
  const amountProof = proveNumericSourceAmount(candidate.amount, { trace: [candidate] });
  if (amountProof.status !== "PASS_NUMERIC_SOURCE") {
    return resolvedResult(
      null,
      "MISSING_VALUE",
      amountProof.trace,
      amountProof.note,
    );
  }
  if (!candidate.article) {
    return resolvedResult(candidate.amount, "MATCHED", [candidate]);
  }
  const children = (candidate.child_indexes ?? []).map(
    (childIndex) => parsed.rows[childIndex],
  );
  if (children.length === 0) {
    return resolvedResult(candidate.amount, "MATCHED", [candidate]);
  }
  if (
    candidate.hierarchy_status !== "PASS" ||
    typeof candidate.child_sum !== "number"
  ) {
    return resolvedResult(
      candidate.amount,
      "HIERARCHY_MISMATCH",
      [candidate, ...children],
      `Итог родителя не равен сумме ${children.length} прямых детей ERP.`,
    );
  }
  return resolvedResult(
    candidate.child_sum,
    "AGGREGATED_HIERARCHY",
    [candidate, ...children],
    `Сумма ${children.length} прямых детей по иерархии ERP; контроль с родителем пройден.`,
  );
}

function inferIntalevNodeAmount(nodes, nodeIndex, visited = new Set()) {
  if (visited.has(nodeIndex)) return { amount: null, trace: [] };
  visited.add(nodeIndex);
  const node = nodes[nodeIndex];
  if (typeof node.value === "number") {
    return { amount: node.value, trace: [node] };
  }
  const childIndexes = directChildren(nodes, nodeIndex);
  if (childIndexes.length === 0) {
    return { amount: null, trace: [node] };
  }
  const children = childIndexes.map((childIndex) =>
    inferIntalevNodeAmount(nodes, childIndex, visited),
  );
  return aggregateExplicitChildren(children, { trace: [node] });
}

// Keep a source amount visible for review even when catalog code identity is
// not proven. The caller retains a BLOCKED_* status, so this never unlocks
// posting, upload or release gates.
function resolveIntalevDiagnosticValue(
  parsed,
  expectedLabel,
  pathIncludes = [],
  parentPathEndsWith = "",
) {
  const normalizedExpected = normalizeLabel(expectedLabel);
  if (!normalizedExpected) return { amount: null, trace: [] };

  let candidates = parsed.nodes.filter(
    (node) => node.normalized_label === normalizedExpected,
  );
  for (const requiredPath of pathIncludes) {
    const normalizedRequired = normalizeLabel(requiredPath);
    candidates = candidates.filter((node) =>
      node.normalized_path.includes(normalizedRequired),
    );
  }
  if (parentPathEndsWith) {
    const normalizedParent = normalizeLabel(parentPathEndsWith);
    candidates = candidates.filter((node) =>
      normalizeLabel(node.parent_path).endsWith(normalizedParent),
    );
  }
  const candidate = selectExactDiagnosticCandidate(candidates, normalizedExpected);
  if (!candidate) return { amount: null, trace: candidates };
  if (typeof candidate.value === "number") {
    return { amount: candidate.value, trace: candidates };
  }
  const candidateIndex = parsed.nodes.indexOf(candidate);
  const inferred = inferIntalevNodeAmount(parsed.nodes, candidateIndex);
  return typeof inferred.amount === "number"
    ? { amount: inferred.amount, trace: inferred.trace }
    : { amount: null, trace: candidates };
}

export function resolveIntalevRow(templateRow, parsed, profile, intalevCatalog) {
  const code = templateRow.code;
  let expectedLabel = templateRow.intalev_label;
  let pathIncludes = [];
  let parentPathEndsWith = "";
  let catalogIdentityEvidence = null;

  if (code === "R001") {
    pathIncludes = ["Расходы по основной деятельности ИТОГО"];
  } else if (code === "R035") {
    expectedLabel = "НДФЛ";
    parentPathEndsWith = "ФЗП и компенсационные выплаты";
  } else if (code === "R036") {
    expectedLabel = "<пустое значение>";
    pathIncludes = ["ФЗП и компенсационные выплаты"];
    parentPathEndsWith = "ФЗП и компенсационные выплаты";
  } else if (code === "R037" && profile.id === "UK_R005") {
    pathIncludes = ["Расходы по основной деятельности ИТОГО", "1_Административные расходы"];
  } else if (code === "R050" && profile.id === "UK_R005") {
    expectedLabel = "1_Административные расходы";
    pathIncludes = ["Результат по финансовой деятельности", "Расходы по финансовой деятельности"];
  } else if (code === "R051" && profile.id === "UK_R005") {
    pathIncludes = ["Результат по финансовой деятельности", "Расходы по финансовой деятельности"];
  } else if (code === "R058" && profile.id === "UK_R005") {
    pathIncludes = ["Расходы по инвестиционной и внереализационной деятельности"];
    parentPathEndsWith = "_Статьи ОПиУ 2025";
  } else if (code === "R062" && profile.id === "UK_R005") {
    pathIncludes = ["Чистая прибыль", "Дивиденды"];
  } else if (code === "R065") {
    expectedLabel = "Нераспределенная прибыль";
  }

  const rowNumber = Number(code.slice(1));
  if (
    profile.restrictAdministrativePath &&
    rowNumber >= 2 &&
    rowNumber <= 40
  ) {
    pathIncludes.unshift("1_Административные расходы");
  }

  if (code === "R057" && profile.id === "UK_R005") {
    const incomeBranch = normalizeLabel("Доходы по инвестиционной и внереализационной");
    const parentCandidates = parsed.nodes.filter(
      (node) =>
        node.normalized_label === normalizeLabel("Прочие внереализационные доходы") &&
        node.normalized_path.includes(incomeBranch) &&
        node.level <= 4,
    );
    const depositCandidates = parsed.nodes.filter(
      (node) =>
        node.normalized_label === normalizeLabel("% по депозитам") &&
        node.normalized_path.includes(incomeBranch),
    );
    const intraCandidates = parsed.nodes.filter(
      (node) =>
        node.normalized_label === normalizeLabel("Внутрихолдинговые проценты") &&
        node.normalized_path.includes(incomeBranch),
    );
    const parent = [...parentCandidates].sort((left, right) => left.level - right.level)[0];
    const deposit = [...depositCandidates].sort((left, right) => left.level - right.level)[0];
    const intra = [...intraCandidates].sort((left, right) => left.level - right.level)[0];
    if (
      parent && deposit && intra &&
      typeof parent.value === "number" &&
      typeof deposit.value === "number" &&
      typeof intra.value === "number"
    ) {
      return resolvedResult(
        roundMoney(parent.value - deposit.value - intra.value),
        "DERIVED_RESIDUAL",
        [parent, deposit, intra],
        "Правило УК R005: прочие внереализационные доходы = общий доход ветки минус проценты по депозитам и внутригрупповые проценты, раскрытые отдельными строками.",
      );
    }
  }

  if (code === "R020" && profile.id === "UK_R005") {
    const labels = [
      "Консультант Плюс",
      "Обновление 1С (для всего Холдинга)",
      "Контур.Диадок",
    ].map(normalizeLabel);
    const candidates = parsed.nodes.filter(
      (node) =>
        labels.includes(node.normalized_label) &&
        node.normalized_path.includes(normalizeLabel("Расходы ИТ")),
    );
    if (candidates.length === labels.length && candidates.every((node) => node.value !== null)) {
      return resolvedResult(
        candidates.reduce((sum, node) => sum + node.value, 0),
        "AGGREGATED_RULE",
        candidates,
        "Сумма подтвержденных компонентов ПО внутри ветки Расходы ИТ.",
      );
    }
  }

  if (code === "R017") {
    const primaryCandidates = parsed.nodes.filter(
      (node) =>
        node.normalized_label === normalizeLabel(templateRow.intalev_label),
    );
    if (
      primaryCandidates.length === 1 &&
      primaryCandidates[0].value !== null
    ) {
      return resolvedResult(
        primaryCandidates[0].value,
        "MATCHED",
        primaryCandidates,
      );
    }
    expectedLabel = "<пустое значение>";
    pathIncludes = ["Прочие административные расходы"];
  }

  if (profile.id === "UK_R005") {
    const expectedCatalogLabel = normalizeLabel(expectedLabel);
    let catalogCandidates = intalevCatalog.entries.filter(
      (entry) => entry.normalized_label === expectedCatalogLabel,
    );
    if (catalogCandidates.length > 0) {
      const identified = catalogCandidates.filter(
        (entry) =>
          entry.organization_article_identity_status === "PASS" &&
          entry.organization_article_identity,
      );
      if (identified.length === 0) {
        const diagnostic = resolveIntalevDiagnosticValue(
          parsed,
          expectedLabel,
          pathIncludes,
          parentPathEndsWith,
        );
        const blocked = resolvedResult(
          diagnostic.amount,
          "BLOCKED_INTALEV_CODE_IDENTITY_NOT_PROVEN",
          diagnostic.trace,
          `Инталев «${expectedLabel}» найден только по имени; code+organization identity отсутствует.`,
        );
        blocked.intalev_identity_evidence = buildIntalevCatalogIdentityEvidence({
          status: blocked.status,
          sourceFile: intalevCatalog.source_file,
          sheet: intalevCatalog.sheet,
          sha256: intalevCatalog.sha256,
          entries: catalogCandidates,
        });
        return blocked;
      }
      const identities = unique(
        identified.map((entry) => entry.organization_article_identity),
      );
      if (identities.length !== 1) {
        const diagnostic = resolveIntalevDiagnosticValue(
          parsed,
          expectedLabel,
          pathIncludes,
          parentPathEndsWith,
        );
        const blocked = resolvedResult(
          diagnostic.amount,
          "BLOCKED_INTALEV_CODE_IDENTITY_AMBIGUOUS",
          diagnostic.trace,
          `Инталев «${expectedLabel}» имеет ${identities.length} code+organization identities.`,
        );
        blocked.intalev_identity_evidence = buildIntalevCatalogIdentityEvidence({
          status: blocked.status,
          sourceFile: intalevCatalog.source_file,
          sheet: intalevCatalog.sheet,
          sha256: intalevCatalog.sha256,
          entries: identified,
        });
        return blocked;
      }
      catalogCandidates = identified;
      catalogIdentityEvidence = identified[0];
    }
    if (rowNumber >= 1 && rowNumber <= 40) {
      const administrativePath = normalizeLabel("1_Административные расходы");
      const administrativeCandidates = catalogCandidates.filter((entry) =>
        entry.normalized_path.includes(administrativePath),
      );
      if (administrativeCandidates.length === 1) {
        const requiredGroup =
          administrativeCandidates[0].group || administrativeCandidates[0].label;
        if (
          requiredGroup &&
          !pathIncludes.some(
            (item) => normalizeLabel(item) === normalizeLabel(requiredGroup),
          )
        ) {
          pathIncludes.push(requiredGroup);
        }
      }
    }
  }

  const normalizedExpected = normalizeLabel(expectedLabel);
  if (!normalizedExpected) {
    return resolvedResult(null, "MISSING_MAPPING", [], "В шаблоне отсутствует строка Инталев.");
  }
  let candidates = parsed.nodes.filter(
    (node) => node.normalized_label === normalizedExpected,
  );
  for (const requiredPath of pathIncludes) {
    const normalizedRequired = normalizeLabel(requiredPath);
    candidates = candidates.filter((node) =>
      node.normalized_path.includes(normalizedRequired),
    );
  }
  if (parentPathEndsWith) {
    const normalizedParent = normalizeLabel(parentPathEndsWith);
    candidates = candidates.filter((node) =>
      normalizeLabel(node.parent_path).endsWith(normalizedParent),
    );
  }
  if (catalogIdentityEvidence) {
    for (const candidate of candidates) {
      candidate.organization_code = catalogIdentityEvidence.organization_code;
      candidate.intalev_article_code = catalogIdentityEvidence.code;
      candidate.intalev_article_identity =
        catalogIdentityEvidence.organization_article_identity;
      candidate.intalev_catalog_source_row = catalogIdentityEvidence.source_row;
    }
  }
  if (code === "R035" && candidates.length === 0) {
    const normalizedFzpPath = normalizeLabel("ФЗП и компенсационные выплаты");
    let descendantCandidates = parsed.nodes.filter(
      (node) =>
        node.normalized_label === normalizedExpected &&
        node.normalized_path.includes(normalizedFzpPath),
    );
    for (const requiredPath of pathIncludes) {
      const normalizedRequired = normalizeLabel(requiredPath);
      descendantCandidates = descendantCandidates.filter((node) =>
        node.normalized_path.includes(normalizedRequired),
      );
    }
    const topmostCandidates = descendantCandidates.filter(
      (candidate) =>
        !descendantCandidates.some(
          (other) =>
            other !== candidate &&
            candidate.normalized_path.startsWith(`${other.normalized_path} / `),
        ),
    );
    if (
      topmostCandidates.length > 0 &&
      topmostCandidates.every((candidate) => candidate.value !== null)
    ) {
      return resolvedResult(
        topmostCandidates.reduce((sum, candidate) => sum + candidate.value, 0),
        topmostCandidates.length === 1 ? "MATCHED" : "AGGREGATED_RULE",
        topmostCandidates,
        "Прямой НДФЛ в ветке ФЗП отсутствует; использованы верхние видимые узлы НДФЛ внутри этой ветки.",
      );
    }
  }
  if (candidates.length === 0) {
    if (code === "R059" && profile.id === "UK_R005") {
      return resolvedResult(
        null,
        "MISSING",
        [],
        "Правило УК R005: отдельный видимый узел убытков прошлых периодов отсутствует; ноль не доказан источником.",
      );
    }
    return resolvedResult(null, "MISSING", [], `Не найден точный узел «${expectedLabel}».`);
  }
  if (candidates.length === 1) {
    if (candidates[0].value === null) {
      if (code === "R021") {
        const blankProof = proveR064CandidateAmount(candidates[0], parsed.nodes);
        if (blankProof.status === "PASS_EXACT_BLANK_LEAF_ZERO") {
          return resolvedResult(
            0,
            "ZERO_NO_ACTIVITY",
            blankProof.trace,
            "R021: exact physical blank leaf proves zero activity for this isolated month.",
          );
        }
      }
      const candidateIndex = parsed.nodes.indexOf(candidates[0]);
      const inferred = inferIntalevNodeAmount(parsed.nodes, candidateIndex);
      if (typeof inferred.amount === "number") {
        return resolvedResult(
          inferred.amount,
          inferred.amount === 0 ? "ZERO_NO_ACTIVITY" : "AGGREGATED_RULE",
          inferred.trace,
          inferred.amount === 0
            ? "Видимый узел Инталев и его дочерние строки не имеют оборота за выбранный период."
            : "Сумма восстановлена по видимым дочерним узлам Инталев.",
        );
      }
      return resolvedResult(
        null,
        "MISSING_VALUE",
        candidates,
        "У родительского узла Инталев отсутствует числовая сумма.",
      );
    }
    return resolvedResult(candidates[0].value, "MATCHED", candidates);
  }
  if (code === "R064") {
    const r064 = resolveR064DuplicateNull({ candidates, nodes: parsed.nodes });
    if (r064.status !== "NOT_APPLICABLE_NUMERIC") {
      const result = resolvedResult(r064.amount, r064.status, r064.trace, r064.note ?? "");
      result.r064_zero_proof = r064.proofs ?? [];
      result.posting_rows = 0;
      result.ready_to_upload = false;
      result.release_allowed = false;
      return result;
    }
  }
  const duplicateAnalysis = analyzeExactSourceIdentityDuplicates(candidates, {
    amountProperty: "value",
  });
  if (duplicateAnalysis.status === "EXACT_DUPLICATE") {
    const selected = duplicateAnalysis.selected[0];
    return resolvedResult(
      selected.value,
      "MATCHED_DUPLICATE_EXACT_IDENTITY",
      candidates,
      `Одна точная source identity повторена ${candidates.length} раз; сумма и знак совпадают.`,
    );
  }
  const ambiguityNote = duplicateAnalysis.status === "IDENTITY_CONFLICT"
    ? "Одна точная source identity имеет разные суммы или знаки; выпуск заблокирован."
    : duplicateAnalysis.status === "INCOMPLETE_IDENTITY"
      ? "Точная source identity неполна; дубликат не подтверждён."
      : "Найдены разные доказанные source identity; совпадение суммы или знака не является дубликатом.";
  return resolvedResult(
    null,
    "AMBIGUOUS",
    candidates,
    ambiguityNote,
  );
}

function nearestErpSummaryLabel(row, parsed) {
  let parentIndex = row.parent_index;
  while (Number.isInteger(parentIndex) && parentIndex >= 0) {
    const parent = parsed.rows[parentIndex];
    if (parent?.summary_label) return parent.summary_label;
    parentIndex = parent?.parent_index;
  }
  return "";
}

function candidateAggregationKey(group) {
  const candidate = group[0] ?? {};
  return candidate.catalog_status === "MATCHED" && candidate.catalog_codes && candidate.catalog_path
    ? `CATALOG|${candidate.catalog_codes}|${normalizeLabel(candidate.catalog_path)}`
    : `ARTICLE|${normalizeLabel(candidate.article)}`;
}

function aggregationControl(aggregation, trace) {
  return {
    status: aggregation.status === "BLOCKED"
      ? "BLOCKED_PARENT_DETAIL_MISMATCH"
      : "REVIEW_ONLY_PARENT_DETAIL_GRAIN_UNPROVEN",
    reason_code: aggregation.reason_code,
    parent_total: null,
    detail_sum: null,
    difference: null,
    tolerance: Number(config.tolerance ?? 0.01),
    within_tolerance: false,
    source_trace: { parent_total: [], detail: [...trace] },
    parent_aggregation: aggregation,
    detail_aggregation: aggregation,
    correction_authority: false,
    posting_rows: 0,
    ready_to_upload: false,
    release_allowed: false,
  };
}

function canonicalizeErpCandidateGroup(group, hasCatalogIdentity, parsed) {
  if (group.length === 0) {
    return { selected: [], ignored: [], notes: [], error: "" };
  }

  if (hasCatalogIdentity && group.length > 1) {
    const catalogRoot = pathParts(group[0].catalog_path)[0] ?? "";
    const dedicated = group.filter(
      (candidate) =>
        normalizeLabel(nearestErpSummaryLabel(candidate, parsed)) === catalogRoot,
    );
    if (dedicated.length === 1) {
      const aggregation = aggregateProvenRows(dedicated, {
        sourceSystem: "ERP",
        aggregationKey: candidateAggregationKey(group),
      });
      if (aggregation.status !== "PROVEN") {
        return {
          selected: [],
          ignored: group,
          notes: [],
          error: "",
          blocked: aggregationControl(aggregation, group),
        };
      }
      return {
        selected: aggregation.selected,
        ignored: group.filter((candidate) => !aggregation.selected.includes(candidate)),
        notes: [
          `Статья ${group[0].catalog_codes} повторена в ${group.length} ветках ERP; выбрана ветка итоговой строки «${nearestErpSummaryLabel(dedicated[0], parsed)}» по доказанному source scope.`,
        ],
        aggregation,
        error: "",
      };
    }
  }

  const aggregation = aggregateProvenRows(group, {
    sourceSystem: "ERP",
    aggregationKey: candidateAggregationKey(group),
  });
  if (aggregation.status !== "PROVEN") {
    return {
      selected: [],
      ignored: group,
      notes: [],
      error: "",
      blocked: aggregationControl(aggregation, group),
    };
  }
  return {
    selected: aggregation.selected,
    ignored: aggregation.ignored,
    notes: aggregation.ignored.length > 0
      ? [`Статья ${group[0].article ?? group[0].catalog_codes ?? ""} повторена с той же proven source identity; повтор не суммировался.`]
      : [],
    aggregation,
    error: "",
  };
}

function candidateAmountSum(candidates) {
  if (
    !(candidates ?? []).length ||
    !candidates.every((candidate) => typeof candidate.amount === "number")
  ) {
    return null;
  }
  return roundMoney(candidates.reduce((sum, candidate) => sum + candidate.amount, 0));
}

function canonicalizeErpArticleCandidates(candidates, parsed) {
  const groups = new Map();
  for (const candidate of candidates) {
    const canUseCatalogIdentity =
      candidate.catalog_status === "MATCHED" &&
      candidate.catalog_codes &&
      candidate.catalog_path;
    const key = canUseCatalogIdentity
      ? `CATALOG|${candidate.catalog_codes}|${normalizeLabel(candidate.catalog_path)}`
      : `LABEL|${normalizeLabel(candidate.article)}`;
    if (!groups.has(key)) {
      groups.set(key, {
        candidates: [],
        has_catalog_identity: Boolean(canUseCatalogIdentity),
      });
    }
    groups.get(key).candidates.push(candidate);
  }

  const selected = [];
  const ignored = [];
  const notes = [];
  for (const grouped of groups.values()) {
    const group = grouped.candidates;
    const byDimension = new Map();
    for (const candidate of group) {
      const key = dimensionKey(candidate);
      if (!byDimension.has(key)) byDimension.set(key, []);
      byDimension.get(key).push(candidate);
    }
    const nonEmptyDimensionKeys = [...byDimension.keys()].filter(Boolean);
    const hasDimensionBreakdown = nonEmptyDimensionKeys.length > 0;

    if (hasDimensionBreakdown) {
      const canonicalByDimension = new Map();
      for (const [dimension, dimensionCandidates] of byDimension.entries()) {
        const result = canonicalizeErpCandidateGroup(
          dimensionCandidates,
          grouped.has_catalog_identity,
          parsed,
        );
        if (result.blocked) {
          return {
            candidates: [],
            ignored: group,
            note: "",
            error: "",
            blocked: result.blocked,
          };
        }
        if (result.error) {
          return { candidates: [], ignored: [], note: "", error: result.error };
        }
        canonicalByDimension.set(dimension, result);
      }

      const totalResult = canonicalByDimension.get("") ?? null;
      const detailResults = nonEmptyDimensionKeys.map(
        (key) => canonicalByDimension.get(key),
      );
      const detailSelected = detailResults.flatMap((result) => result.selected);
      const detailIgnored = detailResults.flatMap((result) => result.ignored);
      const detailNotes = detailResults.flatMap((result) => result.notes);

      if (totalResult) {
        const totalAmount = totalResult.aggregation?.amount ?? candidateAmountSum(totalResult.selected);
        const detailAggregation = aggregateProvenRows(detailSelected, {
          sourceSystem: "ERP",
          aggregationKey: candidateAggregationKey(group),
        });
        if (detailAggregation.status !== "PROVEN" || totalResult.aggregation?.status !== "PROVEN") {
          return {
            candidates: [],
            ignored: [
              ...totalResult.selected,
              ...totalResult.ignored,
              ...detailSelected,
              ...detailIgnored,
            ],
            note: "",
            error: "",
            blocked: aggregationControl(
              totalResult.aggregation?.status !== "PROVEN"
                ? totalResult.aggregation ?? { status: "REVIEW_ONLY", reason_code: "AGGREGATION_GRAIN_UNPROVEN" }
                : detailAggregation,
              [...detailSelected, ...detailIgnored],
            ),
          };
        }
        const detailAmount = detailAggregation.amount;
        const combinedAggregation = combineProvenAggregations(totalResult.aggregation, detailAggregation);
        const parentDetailControl = evaluateParentDetailConsistency({
          parentTotal: totalAmount,
          detailSum: detailAmount,
          tolerance: Number(config.tolerance ?? 0.01),
          parentTrace: [...totalResult.selected, ...totalResult.ignored],
          detailTrace: [...detailSelected, ...detailIgnored],
          parentAggregation: totalResult.aggregation,
          detailAggregation: combinedAggregation,
        });
        if (parentDetailControl.status !== "PASS") {
          return {
            candidates: [],
            ignored: [
              ...totalResult.selected,
              ...totalResult.ignored,
              ...detailSelected,
              ...detailIgnored,
            ],
            note: "",
            error: "",
            blocked: parentDetailControl,
          };
        }
        selected.push(...totalResult.selected);
        ignored.push(
          ...totalResult.ignored,
          ...detailSelected,
          ...detailIgnored,
        );
        notes.push(...totalResult.notes, ...detailNotes);
        notes.push(
          `Подразделения (${nonEmptyDimensionKeys.length}) схлопнуты: использована общая строка ${totalAmount.toFixed(2)}, детализация по подразделениям не удваивалась.`,
        );
        continue;
      }

      selected.push(...detailSelected);
      ignored.push(...detailIgnored);
      notes.push(...detailNotes);
      notes.push(
        `Подразделения (${nonEmptyDimensionKeys.length}) схлопнуты суммированием; сопоставление выполнено только по статье и иерархии ОПИУ.`,
      );
      continue;
    }

    const result = canonicalizeErpCandidateGroup(
      group,
      grouped.has_catalog_identity,
      parsed,
    );
    if (result.blocked) {
      return {
        candidates: [],
        ignored: group,
        note: "",
        error: "",
        blocked: result.blocked,
      };
    }
    if (result.error) {
      return { candidates: [], ignored: [], note: "", error: result.error };
    }
    selected.push(...result.selected);
    ignored.push(...result.ignored);
    notes.push(...result.notes);
  }
  return {
    candidates: selected,
    ignored,
    note: notes.join(" "),
    error: "",
  };
}

function resolveErpSummaryCandidates(candidates) {
  if (candidates.length === 0) return null;
  if (candidates.length === 1) {
    return resolveErpHierarchyCandidate(candidates[0], { rows: candidates });
  }

  const byDimension = new Map();
  for (const candidate of candidates) {
    const key = dimensionKey(candidate);
    if (!byDimension.has(key)) byDimension.set(key, []);
    byDimension.get(key).push(candidate);
  }
  const nonEmptyDimensionKeys = [...byDimension.keys()].filter(Boolean);
  if (nonEmptyDimensionKeys.length > 0) {
    const selectSummary = (group) => {
      if (!group || group.length === 0) return { selected: [], ignored: [], error: "" };
      const aggregation = aggregateProvenRows(group, {
        sourceSystem: "ERP",
        aggregationKey: `SUMMARY|${normalizeLabel(group[0].summary_label)}|${normalizeLabel(group[0].report_section)}`,
      });
      return aggregation.status === "PROVEN"
        ? { selected: aggregation.selected, ignored: aggregation.ignored, aggregation, error: "" }
        : { selected: [], ignored: group, aggregation, blocked: aggregationControl(aggregation, group), error: "" };
    };

    const totalResult = selectSummary(byDimension.get(""));
    if (totalResult.blocked) return buildParentDetailBlockedResult(totalResult.blocked);
    if (totalResult.error) return resolvedResult(null, "AMBIGUOUS", candidates, totalResult.error);
    const detailResults = nonEmptyDimensionKeys.map((key) => selectSummary(byDimension.get(key)));
    const detailBlocked = detailResults.find((result) => result.blocked);
    if (detailBlocked) return buildParentDetailBlockedResult(detailBlocked.blocked);
    const detailError = detailResults.find((result) => result.error);
    if (detailError) return resolvedResult(null, "AMBIGUOUS", candidates, detailError.error);
    const detailSelected = detailResults.flatMap((result) => result.selected);
    const detailIgnored = detailResults.flatMap((result) => result.ignored);

    if (totalResult.selected.length > 0) {
      return resolvedResult(
        totalResult.aggregation.amount,
        totalResult.ignored.length > 0 ? "MATCHED_DUPLICATE_EXACT_IDENTITY" : "MATCHED",
        [...totalResult.selected, ...totalResult.ignored, ...detailSelected, ...detailIgnored],
        `Подразделения (${nonEmptyDimensionKeys.length}) схлопнуты: использована общая итоговая строка ERP.`,
      );
    }
    if (detailSelected.every((candidate) => typeof candidate.amount === "number")) {
      const detailAggregation = aggregateProvenRows(detailSelected, {
        sourceSystem: "ERP",
        aggregationKey: `SUMMARY|${normalizeLabel(candidates[0].summary_label)}|${normalizeLabel(candidates[0].report_section)}`,
      });
      if (detailAggregation.status !== "PROVEN") {
        return buildParentDetailBlockedResult(aggregationControl(detailAggregation, detailSelected));
      }
      return resolvedResult(
        detailAggregation.amount,
        "AGGREGATED_RULE",
        [...detailSelected, ...detailIgnored],
        `Подразделения (${nonEmptyDimensionKeys.length}) схлопнуты суммированием итоговых строк ERP.`,
      );
    }
  }

  const aggregation = aggregateProvenRows(candidates, {
    sourceSystem: "ERP",
    aggregationKey: `SUMMARY|${normalizeLabel(candidates[0].summary_label)}|${normalizeLabel(candidates[0].report_section)}`,
  });
  if (aggregation.status !== "PROVEN") {
    return buildParentDetailBlockedResult(aggregationControl(aggregation, candidates));
  }
  return resolvedResult(
    aggregation.amount,
    aggregation.ignored.length > 0 ? "MATCHED_DUPLICATE_EXACT_IDENTITY" : "AGGREGATED_RULE",
    [...aggregation.selected, ...aggregation.ignored],
    aggregation.ignored.length > 0
      ? "Повторена доказанная source identity итоговой строки ERP; повтор не суммировался."
      : "Одноимённые итоговые строки ERP имеют разные proven source identities и суммированы.",
  );
}

function resolveErpDirect(templateRow, parsed) {
  const aliases = {
    R010: ["Проживание"],
    R036: ["ФЗП"],
    R043: ["Налоги с доходов текущего периода"],
    R045: ["Итоги по финансовой деятельности"],
    R046: ["Доходы по финансовой деятельности"],
    R054: ["Проценты по кредитам"],
    R055: ["Итоги по внереализационной деятельности"],
    R057: ["Прочие внереализационные доходы"],
    R058: ["Прочие внереализационные расходы"],
    R065: ["Нераспределенная прибыль"],
  };
  const primaryLabels = [templateRow.erp_label]
    .map(normalizeLabel)
    .filter(Boolean);
  const aliasLabels = (aliases[templateRow.code] ?? [])
    .map(normalizeLabel)
    .filter(Boolean);
  const labels = [...primaryLabels, ...aliasLabels];
  if (labels.length === 0) {
    return resolvedResult(null, "MISSING_MAPPING", [], "В шаблоне отсутствует строка ERP.");
  }

  const primarySummaryCandidates = parsed.rows.filter(
    (row) =>
      row.summary_label &&
      primaryLabels.includes(normalizeLabel(row.summary_label)),
  );
  const aliasSummaryCandidates = parsed.rows.filter(
    (row) =>
      row.summary_label &&
      aliasLabels.includes(normalizeLabel(row.summary_label)),
  );
  const summaryCandidates =
    primarySummaryCandidates.length > 0
      ? primarySummaryCandidates
      : aliasSummaryCandidates;
  if (summaryCandidates.length > 0) {
    if (summaryCandidates.length === 1) {
      return resolveErpHierarchyCandidate(summaryCandidates[0], parsed);
    }
    return resolveErpSummaryCandidates(summaryCandidates);
  }

  let primaryArticleCandidates = parsed.rows.filter(
    (row) => row.article && primaryLabels.includes(normalizeLabel(row.article)),
  );
  let aliasArticleCandidates = parsed.rows.filter(
    (row) => row.article && aliasLabels.includes(normalizeLabel(row.article)),
  );
  const rowNumber = Number(templateRow.code.slice(1));
  if (rowNumber >= 1 && rowNumber <= 40) {
    const administrativePath = normalizeLabel("Административные расходы");
    const primaryInAdministrativePath = primaryArticleCandidates.filter(
      (row) =>
        (
          normalizeText(row.catalog_status).startsWith("MATCHED") &&
          normalizeLabel(row.catalog_path).includes(administrativePath)
        ) ||
        normalizeLabel(row.full_path).includes(administrativePath),
    );
    const aliasesInAdministrativePath = aliasArticleCandidates.filter(
      (row) =>
        (
          normalizeText(row.catalog_status).startsWith("MATCHED") &&
          normalizeLabel(row.catalog_path).includes(administrativePath)
        ) ||
        normalizeLabel(row.full_path).includes(administrativePath),
    );
    // R001–R040 are the administrative template branch.  A same-name article
    // in commercial, transport or warehouse expenses is a different economic
    // article and must never be used as a fallback for this branch.
    primaryArticleCandidates = primaryInAdministrativePath;
    aliasArticleCandidates = aliasesInAdministrativePath;
  }
  let rawArticleCandidates =
    primaryArticleCandidates.length > 0
      ? primaryArticleCandidates
      : aliasArticleCandidates;

  if (["R052", "R054"].includes(templateRow.code)) {
    const expenseSummary = normalizeLabel("Расходы по финансовой деятельности");
    const inExpenseSummary = rawArticleCandidates.filter(
      (row) => normalizeLabel(nearestErpSummaryLabel(row, parsed)) === expenseSummary,
    );
    if (inExpenseSummary.length > 0) rawArticleCandidates = inExpenseSummary;
  }

  const canonical = canonicalizeErpArticleCandidates(rawArticleCandidates, parsed);
  if (canonical.blocked) {
    return buildParentDetailBlockedResult(canonical.blocked);
  }
  if (canonical.error) {
    return resolvedResult(
      null,
      "AMBIGUOUS",
      rawArticleCandidates,
      canonical.error,
    );
  }
  const articleCandidates = canonical.candidates;
  if (articleCandidates.length === 1) {
    const result = resolveErpHierarchyCandidate(articleCandidates[0], parsed);
    if (canonical.ignored.length > 0) {
      result.trace = [...result.trace, ...canonical.ignored];
      result.note = [result.note, canonical.note].filter(Boolean).join(" ");
      if (acceptedStatus(result.status)) {
        result.status = "MATCHED_DUPLICATE_HIERARCHY";
      }
    }
    return result;
  }
  if (articleCandidates.length > 0 && articleCandidates.every((row) => row.amount !== null)) {
    return resolvedResult(
      articleCandidates.reduce((sum, row) => sum + row.amount, 0),
      articleCandidates.length === 1 ? "MATCHED" : "AGGREGATED_RULE",
      [...articleCandidates, ...canonical.ignored],
      articleCandidates.length === 1
        ? ""
        : [`Сумма ${articleCandidates.length} строк ERP после схлопывания организационных измерений.`, canonical.note]
            .filter(Boolean)
            .join(" "),
    );
  }
  if (articleCandidates.length > 0) {
    return resolvedResult(
      null,
      "MISSING_VALUE",
      [...articleCandidates, ...canonical.ignored],
      "Найдена строка ERP без доказанной числовой суммы; ноль не подставлен.",
    );
  }
  return resolvedResult(
    null,
    "MISSING",
    [],
    "Строка с оборотом в ERP не найдена; ноль не доказан источником.",
  );
}

function resolveErpCatalogLeaf(leaf, parsed) {
  const leafPath = normalizeLabel(leaf.leaf_full_path);
  const leafCode = normalizeText(leaf.code);
  const candidates = parsed.rows.filter((row) => {
    const catalogCodes = normalizeText(row.catalog_codes)
      .split(",")
      .map(normalizeText)
      .filter(Boolean);
    return normalizeLabel(row.catalog_path) === leafPath && catalogCodes.includes(leafCode);
  });
  const canonical = canonicalizeErpArticleCandidates(candidates, parsed);
  if (canonical.blocked) {
    return buildParentDetailBlockedResult(canonical.blocked);
  }
  if (canonical.error) {
    return resolvedResult(null, "AMBIGUOUS", candidates, canonical.error);
  }
  if (
    canonical.candidates.length === 0 ||
    !canonical.candidates.every((row) => typeof row.amount === "number")
  ) {
    return resolvedResult(
      null,
      "MISSING_CATALOG_LEAF",
      [...canonical.candidates, ...canonical.ignored],
      `ERP leaf ${leaf.code} / ${leaf.leaf_full_path} is not exactly proven.`,
    );
  }
  return resolvedResult(
    canonical.candidates.reduce((sum, row) => sum + row.amount, 0),
    canonical.candidates.length === 1 ? "MATCHED" : "MATCHED_DUPLICATE_HIERARCHY",
    [...canonical.candidates, ...canonical.ignored],
    canonical.note,
  );
}

function catalogPathAlternatives(value) {
  return normalizeText(value)
    .split(/\s*\|\s*/u)
    .map((alternative) => normalizeText(alternative))
    .filter(Boolean)
    .map((alternative) => ({
      raw: alternative,
      parts: normalizeText(alternative)
        .split(/\s+\/\s+/u)
        .map((part) => normalizeText(part))
        .filter(Boolean),
    }));
}

function normalizedCatalogParts(parts = []) {
  return parts.map(normalizeLabel).filter(Boolean);
}

function catalogPathDescendsFrom(alternative, prefixParts) {
  const candidate = normalizedCatalogParts(alternative?.parts);
  const prefix = normalizedCatalogParts(prefixParts);
  return prefix.length > 0 && candidate.length > prefix.length &&
    prefix.every((part, index) => candidate[index] === part);
}

function pathEndsWithNormalizedLabels(value, labels = []) {
  const actual = pathParts(value);
  const expected = labels.map(normalizeLabel).filter(Boolean);
  return expected.length > 0 && expected.length <= actual.length &&
    actual.slice(-expected.length).every((part, index) => part === expected[index]);
}

function exactComponentSourceTreeProven(row) {
  const proof = row?.source_tree_proof;
  return proof?.complete === true && ["LEAF", "PASS"].includes(normalizeText(proof?.status));
}

/**
 * Catalog binding can expose one physical catalog path as a single path or as
 * several alternatives.  Normalize that representation before presentation
 * rollup, but only when every alternative remains inside one exact source
 * prefix and the unique physical component set closes the source summary.
 */
function resolveProvenErpParentCompositionBeforePresentation(templateRow, parsed) {
  const direct = resolveProvenErpTemplateParentComposition(templateRow, parsed, {
    tolerance: 0.01,
  });
  if (direct.status === "PROVEN_ERP_PARENT_COMPOSITION") return direct;

  const label = normalizeLabel(templateRow?.erp_label || templateRow?.intalev_label);
  const ancestorLabels = (Array.isArray(templateRow?.intalev_reference_path_labels)
    ? templateRow.intalev_reference_path_labels
    : []).slice(0, -1);
  const expectedPathLabels = [...ancestorLabels, label];
  const rows = Array.isArray(parsed?.rows) ? parsed.rows : [];
  const summaries = rows.flatMap((row) => {
    if (
      normalizeLabel(row?.article) !== label ||
      typeof row?.amount !== "number" ||
      !pathEndsWithNormalizedLabels(row?.full_path, expectedPathLabels)
    ) {
      return [];
    }
    const alternatives = catalogPathAlternatives(row?.catalog_path)
      .filter((alternative) =>
        alternative.parts.length >= 2 &&
        normalizeLabel(alternative.parts.at(-1)) === label);
    if (alternatives.length === 0) return [];
    const deepestLength = Math.max(...alternatives.map((alternative) => alternative.parts.length));
    const deepest = alternatives.filter((alternative) => alternative.parts.length === deepestLength);
    const prefixes = unique(
      deepest.map((alternative) =>
        normalizedCatalogParts(alternative.parts.slice(0, -1)).join(" / ")),
    );
    return prefixes.length === 1
      ? [{ row, summary_path: deepest[0], prefix_parts: deepest[0].parts.slice(0, -1) }]
      : [];
  });
  if (summaries.length !== 1 || summaries[0].prefix_parts.length === 0) return direct;

  const { row: summary, summary_path: summaryPath, prefix_parts: prefixParts } = summaries[0];
  const summaryParentPath = normalizeText(summary.full_path)
    .split(/\s+\/\s+/u)
    .slice(0, -1)
    .map(normalizeLabel)
    .join(" / ");
  const componentPathByRow = new Map();
  for (const row of rows) {
    if (row === summary || typeof row?.amount !== "number" || !exactComponentSourceTreeProven(row)) {
      continue;
    }
    const rowParentPath = normalizeText(row?.full_path)
      .split(/\s+\/\s+/u)
      .slice(0, -1)
      .map(normalizeLabel)
      .join(" / ");
    if (rowParentPath !== summaryParentPath) continue;
    const alternatives = catalogPathAlternatives(row?.catalog_path);
    if (
      alternatives.length === 0 ||
      !alternatives.every((alternative) => catalogPathDescendsFrom(alternative, prefixParts))
    ) {
      continue;
    }
    const deepestLength = Math.max(...alternatives.map((alternative) => alternative.parts.length));
    const deepest = alternatives.filter((alternative) => alternative.parts.length === deepestLength);
    const deepestIdentities = unique(
      deepest.map((alternative) => normalizedCatalogParts(alternative.parts).join(" / ")),
    );
    if (deepestIdentities.length !== 1) continue;
    const terminal = deepest[0].parts;
    if (
      terminal.length >= 2 &&
      normalizeLabel(terminal.at(-1)) === normalizeLabel(terminal.at(-2))
    ) {
      continue;
    }
    componentPathByRow.set(row, deepest[0].raw);
  }
  if (componentPathByRow.size === 0) return direct;

  const prefix = prefixParts.join(" / ");
  const normalizedRows = rows.map((row) => {
    if (row === summary) {
      return { ...row, catalog_path: `${prefix} | ${summaryPath.raw}` };
    }
    const componentPath = componentPathByRow.get(row);
    if (componentPath) return { ...row, catalog_path: componentPath };
    const sameParent = normalizeText(row?.full_path)
      .split(/\s+\/\s+/u)
      .slice(0, -1)
      .map(normalizeLabel)
      .join(" / ") === summaryParentPath;
    const insidePrefix = catalogPathAlternatives(row?.catalog_path)
      .some((alternative) => catalogPathDescendsFrom(alternative, prefixParts));
    return sameParent && insidePrefix
      ? { ...row, catalog_path: `${prefix} | ${normalizeText(row?.catalog_path)}` }
      : row;
  });
  return resolveProvenErpTemplateParentComposition(
    templateRow,
    { ...parsed, rows: normalizedRows },
    { tolerance: 0.01 },
  );
}

function resolveProvenErpCompositionAliasBeforePresentation(templateRow, parsed, parentResult) {
  const direct = resolveProvenErpCompositionAlias(templateRow, parsed, parentResult);
  if (direct.status === "PROVEN_ERP_PARENT_COMPOSITION_ALIAS") return direct;
  const parentSummary = (parentResult?.trace ?? [])
    .find((row) => row?.exact_parent_summary === true);
  const prefix = normalizeText(parentSummary?.catalog_path).split(/\s*\|\s*/u)[0];
  const prefixParts = prefix.split(/\s+\/\s+/u).map(normalizeText).filter(Boolean);
  const label = normalizeLabel(templateRow?.erp_label || templateRow?.intalev_label);
  if (!parentSummary || prefixParts.length === 0 || !label) return direct;
  const normalizedRows = (parsed?.rows ?? []).map((row) => {
    if (
      normalizeLabel(row?.article) !== label ||
      typeof row?.amount !== "number" ||
      Math.abs(row.amount - parentResult.amount) > 0.01 ||
      row?.parent_index !== parentSummary?.parent_index ||
      normalizeText(row?.source_identity_scope) !== normalizeText(parentSummary?.source_identity_scope)
    ) {
      return row;
    }
    const alternatives = catalogPathAlternatives(row?.catalog_path);
    if (
      alternatives.length === 0 ||
      !alternatives.every((alternative) => catalogPathDescendsFrom(alternative, prefixParts))
    ) {
      return row;
    }
    return { ...row, catalog_path: `${prefix} | ${normalizeText(row.catalog_path)}` };
  });
  return resolveProvenErpCompositionAlias(
    templateRow,
    { ...parsed, rows: normalizedRows },
    parentResult,
  );
}

export function resolveErpRows(templateRows, parsed, profile = null, catalogCoverage = null) {
  const results = new Map(
    templateRows.map((row) => [row.code, resolveErpDirect(row, parsed)]),
  );

  const templateParentCodes = new Set(
    templateRows
      .map((row) => normalizeText(
        row?.intalev_reference_parent_code ?? row?.intalev_source_parent_code ?? row?.parent_code,
      ))
      .filter(Boolean),
  );
  for (const templateRow of templateRows) {
    const previous = results.get(templateRow.code);
    const sourceParent = resolveProvenErpPresentationParent(templateRow, parsed, {
      templateHasChildren: templateParentCodes.has(normalizeText(templateRow.code)),
    });
    if (sourceParent.status !== "PROVEN_ERP_PRESENTATION_PARENT") continue;
    const candidate = resolvedResult(
      sourceParent.amount,
      "MATCHED",
      sourceParent.trace,
      sourceParent.note,
    );
    const traceIdentity = (trace) => [...new Set((trace ?? []).map((item) => [
      normalizeText(item?.sha256).toUpperCase(),
      normalizeText(item?.sheet),
      normalizeText(item?.source_cell),
    ].join("|")))].sort();
    const previousTrace = traceIdentity(previous?.trace);
    const provenTrace = traceIdentity(sourceParent.trace);
    const bindingRepairRequired =
      typeof previous?.amount !== "number" ||
      Math.abs(previous.amount - sourceParent.amount) > 0.01 ||
      JSON.stringify(previousTrace) !== JSON.stringify(provenTrace);
    candidate.proven_presentation_parent = {
      status: sourceParent.status,
      source_cell: sourceParent.source_cell,
      child_source_cells: sourceParent.child_source_cells,
      binding_repair_required: bindingRepairRequired,
      correction_authority: false,
      posting_rows: 0,
    };
    results.set(templateRow.code, candidate);
  }

  // A blank ERP label on a template parent does not mean that the source
  // parent is absent. Recover it only from an exact, unique ERP presentation
  // row whose terminal catalog descendants add back to the same source
  // amount. This is generic source hierarchy proof, not an organization,
  // period, code or amount exception.
  for (const templateRow of templateRows) {
    const current = results.get(templateRow.code);
    if (typeof current?.amount === "number") continue;
    const composition = resolveProvenErpParentCompositionBeforePresentation(templateRow, parsed);
    if (composition.status !== "PROVEN_ERP_PARENT_COMPOSITION") continue;
    const candidate = resolvedResult(
      composition.amount,
      "MATCHED",
      composition.trace,
      composition.note,
    );
    const currentComponentCells = (current?.trace ?? [])
      .filter((item) => item?.exact_parent_component === true)
      .map((item) => normalizeText(item?.source_cell))
      .filter(Boolean)
      .sort();
    const provenComponentCells = [...composition.component_source_cells]
      .map(normalizeText)
      .filter(Boolean)
      .sort();
    candidate.proven_parent_composition = {
      status: composition.status,
      component_source_cells: composition.component_source_cells,
      catalog_prefix: composition.catalog_prefix,
      binding_repair_required:
        typeof current?.amount !== "number" ||
        Math.abs(current.amount - composition.amount) > 0.01 ||
        JSON.stringify(currentComponentCells) !== JSON.stringify(provenComponentCells),
      correction_authority: false,
      posting_rows: 0,
    };
    results.set(templateRow.code, candidate);
  }

  for (const templateRow of templateRows) {
    const current = results.get(templateRow.code);
    if (typeof current?.amount === "number") continue;
    const parentCode = normalizeText(
      templateRow?.intalev_reference_parent_code ??
      templateRow?.intalev_source_parent_code ??
      templateRow?.parent_code,
    );
    if (!parentCode) continue;
    const compositionAlias = resolveProvenErpCompositionAliasBeforePresentation(
      templateRow,
      parsed,
      results.get(parentCode),
    );
    if (compositionAlias.status !== "PROVEN_ERP_PARENT_COMPOSITION_ALIAS") continue;
    const candidate = resolvedResult(
      compositionAlias.amount,
      "MATCHED",
      compositionAlias.trace,
      compositionAlias.note,
    );
    const currentComponentCells = (current?.trace ?? [])
      .filter((item) => item?.exact_parent_component === true)
      .map((item) => normalizeText(item?.source_cell))
      .filter(Boolean)
      .sort();
    const provenComponentCells = [...compositionAlias.component_source_cells]
      .map(normalizeText)
      .filter(Boolean)
      .sort();
    candidate.proven_parent_composition_alias = {
      status: compositionAlias.status,
      alias_source_cell: compositionAlias.alias_source_cell,
      component_source_cells: compositionAlias.component_source_cells,
      binding_repair_required:
        typeof current?.amount !== "number" ||
        Math.abs(current.amount - compositionAlias.amount) > 0.01 ||
        JSON.stringify(currentComponentCells) !== JSON.stringify(provenComponentCells),
      correction_authority: false,
      posting_rows: 0,
    };
    results.set(templateRow.code, candidate);
  }

  const detailDefinitions = {
    R011: ["Страховые взносы и пенсионные отчисления"],
    R033: ["ФЗП", "Компенсации", "НДФЛ"],
  };
  for (const [code, labels] of Object.entries(detailDefinitions)) {
    const current = results.get(code);
    if (
      current &&
      typeof current.amount === "number" &&
      current.status !== "ZERO_NO_ACTIVITY"
    ) {
      continue;
    }
    const normalizedLabels = labels.map(normalizeLabel);
    const administrativePath = normalizeLabel("Административные расходы");
    const candidates = parsed.rows.filter(
      (row) =>
        row.article &&
        normalizedLabels.includes(normalizeLabel(row.article)) &&
        (
          normalizeLabel(row.catalog_path).includes(administrativePath) ||
          normalizeLabel(row.full_path).includes(administrativePath)
        ),
    );
    const canonical = canonicalizeErpArticleCandidates(candidates, parsed);
    if (canonical.blocked) {
      results.set(code, buildParentDetailBlockedResult(canonical.blocked));
      continue;
    }
    if (
      !canonical.error &&
      canonical.candidates.length > 0 &&
      canonical.candidates.every((row) => typeof row.amount === "number")
    ) {
      results.set(
        code,
        resolvedResult(
          canonical.candidates.reduce((sum, row) => sum + row.amount, 0),
          "AGGREGATED_RULE",
          [...canonical.candidates, ...canonical.ignored],
          [`Сумма ERP-статей: ${labels.join(" + ")}.`, canonical.note]
            .filter(Boolean)
            .join(" "),
        ),
      );
    }
  }

  for (const parentCode of D04_CATALOG_MANIFEST.target_parent_codes) {
    results.set(
      parentCode,
      resolveCatalogFallback({
        parentCode,
        currentResult: results.get(parentCode),
        coverage: catalogCoverage,
        resolveLeaf: (leaf) => resolveErpCatalogLeaf(leaf, parsed),
        roundMoney,
      }),
    );
  }

  for (const result of results.values()) {
    if (result && !Object.hasOwn(result, "raw_amount")) {
      result.raw_amount = typeof result.amount === "number" ? result.amount : null;
    }
  }

  if (profile?.id === "UK_R005") {
    const deriveFrom = (code, sourceCode, note) => {
      const source = results.get(sourceCode);
      if (source && typeof source.amount === "number") {
        const candidate = resolvedResult(
          source.amount,
          "AGGREGATED_RULE",
          source.trace,
          note,
        );
        results.set(
          code,
          useDerivedOnlyWhenRawMissing(results.get(code), candidate),
        );
      }
    };

    deriveFrom(
      "R046",
      "R048",
      "Правило УК R005: доход по финансовой деятельности включает только проценты по кредитам сотрудников; проценты по депозитам раскрываются отдельно.",
    );
    deriveFrom(
      "R049",
      "R053",
      "Правило УК R005: блок расходов по финансовой деятельности равен строке расходов по финансовой деятельности.",
    );
    const financeIncome = results.get("R046");
    const financeExpenses = results.get("R049");
    const financeIncomeCandidate =
      typeof financeIncome?.normalized_amount === "number"
        ? financeIncome.normalized_amount
        : financeIncome?.amount;
    const financeExpensesCandidate =
      typeof financeExpenses?.normalized_amount === "number"
        ? financeExpenses.normalized_amount
        : financeExpenses?.amount;
    if (
      financeIncome &&
      financeExpenses &&
      typeof financeIncomeCandidate === "number" &&
      typeof financeExpensesCandidate === "number"
    ) {
      const candidate = resolvedResult(
        financeIncomeCandidate - financeExpensesCandidate,
        "AGGREGATED_RULE",
        [
          ...(financeIncome.normalization_trace ?? financeIncome.trace ?? []),
          ...(financeExpenses.normalization_trace ?? financeExpenses.trace ?? []),
        ],
        "Правило УК R005: результат по финансовой деятельности = доход без депозитов − расходы. Кандидат не заменяет literal ERP.",
      );
      results.set(
        "R045",
        keepRawWithReclassificationCandidate(results.get("R045"), candidate),
      );
    }

    const investmentBase = results.get("R055");
    const depositIncome = results.get("R047");
    if (
      investmentBase &&
      depositIncome &&
      typeof investmentBase.amount === "number" &&
      typeof depositIncome.amount === "number"
    ) {
      const candidate = resolvedResult(
        investmentBase.amount + depositIncome.amount,
        "AGGREGATED_RULE",
        [...investmentBase.trace, ...depositIncome.trace],
        "Правило УК R005: проценты по депозитам перенесены в результат по инвестиционной и внереализационной деятельности. Кандидат не заменяет literal ERP.",
      );
      results.set(
        "R055",
        keepRawWithReclassificationCandidate(investmentBase, candidate),
      );
    }

  }
  return new Map(
    templateRows.map((templateRow) => [
      templateRow.code,
      (() => {
        const gated = gateResolvedResultBySourceTree(
          results.get(templateRow.code),
          templateRow,
          parsed.rows,
          { sourceSystem: "ERP" },
        );
        return {
          ...gated,
          raw_amount: Object.hasOwn(gated ?? {}, "raw_amount")
            ? gated.raw_amount
            : typeof gated?.amount === "number"
              ? gated.amount
              : null,
        };
      })(),
    ]),
  );
}

function acceptedStatus(status) {
  return [
    "MATCHED",
    "MATCHED_DUPLICATE_SAME_VALUE",
    "MATCHED_DUPLICATE_EXACT_IDENTITY",
    "MATCHED_DUPLICATE_HIERARCHY",
    "AGGREGATED_RULE",
    "AGGREGATED_HIERARCHY",
    "DERIVED_RESIDUAL",
    "ZERO_NO_ACTIVITY",
    "ZERO_NO_ACTIVITY_DUPLICATE_PROVEN",
    "INFORMATIONAL_COVERED",
    "PRESENTATION_GROUP_ROLLUP",
  ].includes(status);
}

/**
 * Fill a missing amount on a visible grouping row without inventing a posting
 * amount.  The canonical presentation graph is Intalev-based, therefore the
 * same visible member set is used on both sides of the comparison.  Prefer an
 * exact source-node total; otherwise sum the direct visible children after a
 * bottom-up pass.  The result is explicitly review-only and never grants
 * correction authority.
 */
export function applyVisibleHierarchyGroupRollups(rows = []) {
  const resultRows = rows.map((row) => ({
    ...row,
    intalev: { ...(row?.intalev ?? {}) },
    erp: { ...(row?.erp ?? {}) },
  }));
  const byCode = new Map(
    resultRows.map((row) => [normalizeText(row?.code), row]),
  );
  const childrenByCode = new Map(
    resultRows.map((row) => [normalizeText(row?.code), []]),
  );
  for (const row of resultRows) {
    const parentCode = normalizeText(row?.presentation_parent_code);
    if (parentCode && childrenByCode.has(parentCode)) {
      childrenByCode.get(parentCode).push(row);
    }
  }
  const audits = [];
  const ordered = [...resultRows].sort(
    (left, right) =>
      Number(right?.presentation_depth ?? 0) -
      Number(left?.presentation_depth ?? 0),
  );
  for (const row of ordered) {
    const code = normalizeText(row?.code);
    const children = childrenByCode.get(code) ?? [];
    if (children.length === 0) continue;
    for (const system of ["intalev", "erp"]) {
      const side = row[system];
      if (typeof side?.amount === "number") continue;
      const hierarchyBinding = row?.[`${system}_hierarchy`] ?? null;
      const sourceTotal = hierarchyBinding?.mapped === true &&
        typeof hierarchyBinding?.direct_total === "number"
        ? roundMoney(hierarchyBinding.direct_total)
        : null;
      const childAmounts = children.map((child) => child?.[system]?.amount);
      const childrenComplete = childAmounts.every(
        (amount) => typeof amount === "number" && Number.isFinite(amount),
      );
      const visibleChildTotal = childrenComplete
        ? roundMoney(childAmounts.reduce((sum, amount) => sum + amount, 0))
        : null;
      const amount = sourceTotal ?? visibleChildTotal;
      if (typeof amount !== "number") continue;
      const basis = sourceTotal !== null
        ? "EXACT_SOURCE_NODE_TOTAL"
        : "DIRECT_VISIBLE_CHILDREN_SUM";
      const originalStatus = normalizeText(side?.status) || "MISSING";
      const childCodes = children.map((child) => normalizeText(child?.code));
      row[system] = {
        ...side,
        amount,
        status: "PRESENTATION_GROUP_ROLLUP",
        note: [
          normalizeText(side?.note),
          `Сумма группировки ${code} собрана для отображения: ${basis}; ` +
            `дети ${childCodes.join(", ")}; исходный статус ${originalStatus}.`,
          "Корректировочная и загрузочная полномочность не создаётся.",
        ].filter(Boolean).join(" "),
        trace: deduplicateTrace([
          ...(side?.trace ?? []),
          ...children.flatMap((child) => child?.[system]?.trace ?? []),
        ]),
        presentation_group_rollup: {
          schema: "opiu-presentation-group-rollup.v1",
          code,
          system: system.toUpperCase(),
          amount,
          basis,
          source_node_total: sourceTotal,
          visible_child_total: visibleChildTotal,
          child_codes: childCodes,
          original_amount: side?.amount ?? null,
          original_status: originalStatus,
          correction_authority: false,
          posting_rows: 0,
          ready_to_upload: false,
          release_allowed: false,
        },
      };
      audits.push(row[system].presentation_group_rollup);
    }
  }
  return { rows: resultRows, audits };
}

/**
 * ERP exposes the UK financial-expense total (R053), but its API hierarchy can
 * omit the two Intalev-only presentation levels R050/R051.  In that case both
 * omitted levels are accidentally resolved from the same visible ERP leaf
 * R052 and therefore show the same artificial delta twice.  When the leaf and
 * the complete financial-expense total already reconcile, cover only those
 * two presentation levels.  No posting is created and the literal ERP amount
 * remains available as raw_amount for audit.
 */
export function applyUkFinancialPresentationCoverage(rows = [], {
  profileId = "",
  tolerance = 0.01,
} = {}) {
  const resultRows = (Array.isArray(rows) ? rows : []).map((row) => ({
    ...row,
    intalev: { ...(row?.intalev ?? {}) },
    erp: { ...(row?.erp ?? {}) },
  }));
  if (normalizeText(profileId) !== "UK_R005") {
    return { rows: resultRows, audit: [] };
  }

  const byCode = new Map(resultRows.map((row) => [normalizeText(row?.code), row]));
  const r050 = byCode.get("R050");
  const r051 = byCode.get("R051");
  const r052 = byCode.get("R052");
  const r053 = byCode.get("R053");
  const amount = (row, side) => row?.[side]?.amount;
  const finite = (value) => typeof value === "number" && Number.isFinite(value);
  const close = (left, right) =>
    finite(left) && finite(right) && Math.abs(roundMoney(left - right)) <= tolerance;
  const deltaClosed = (row) => close(amount(row, "intalev"), amount(row, "erp"));

  const duplicatedPresentationChain =
    [r050, r051, r052, r053].every(Boolean) &&
    [r050, r051, r052, r053].every((row) =>
      finite(amount(row, "intalev")) && finite(amount(row, "erp"))) &&
    close(amount(r050, "intalev"), amount(r051, "intalev")) &&
    close(amount(r050, "erp"), amount(r051, "erp")) &&
    close(amount(r051, "erp"), amount(r052, "erp")) &&
    deltaClosed(r052) &&
    deltaClosed(r053) &&
    !deltaClosed(r050) &&
    !deltaClosed(r051);

  if (!duplicatedPresentationChain) {
    return { rows: resultRows, audit: [] };
  }

  const rawDelta = roundMoney(amount(r050, "intalev") - amount(r050, "erp"));
  const note =
    "Структурное раскрытие УК: ERP API не содержит уровни R050/R051 и повторяет на них лист R052. " +
    "R052 и полный итог R053 уже сходятся с Инталевом, поэтому двойная дельта уровней R050/R051 " +
    "закрыта как представление отчёта; финансовая проводка не создаётся.";
  for (const code of ["R050", "R051"]) {
    const row = byCode.get(code);
    const literalErpAmount = amount(row, "erp");
    row.erp.raw_amount = finite(row.erp.raw_amount)
      ? row.erp.raw_amount
      : literalErpAmount;
    row.erp.normalized_amount = amount(row, "intalev");
    row.erp.amount = amount(row, "intalev");
    row.erp.normalization_status = "STRUCTURAL_PRESENTATION_COVERED_BY_R053";
    row.erp.normalization_note = note;
    row.erp.normalization_trace = [
      ...(row.erp.trace ?? []),
      ...(r052.erp.trace ?? []),
      ...(r053.erp.trace ?? []),
    ];
    row.comparison_mode = "STRUCTURAL_PRESENTATION_COVERED";
    row.structural_presentation_coverage = {
      schema: "opiu-uk-financial-presentation-coverage.v1",
      status: "COVERED_NO_POSTING",
      code,
      raw_erp_amount: literalErpAmount,
      normalized_erp_amount: amount(row, "intalev"),
      raw_delta: rawDelta,
      proving_codes: ["R052", "R053"],
      financial_posting_rows: 0,
      correction_authority: false,
      note,
    };
  }

  return {
    rows: resultRows,
    audit: [{
      status: "COVERED_NO_POSTING",
      codes: ["R050", "R051"],
      proving_codes: ["R052", "R053"],
      raw_delta: rawDelta,
      financial_posting_rows: 0,
      correction_authority: false,
      note,
    }],
  };
}

export function calculateVisibleGroupDeltaResiduals(rows = [], tolerance = 0.01) {
  const childrenByParent = new Map();
  for (const row of rows) {
    const parentCode = normalizeText(row?.presentation_parent_code);
    if (!parentCode) continue;
    if (!childrenByParent.has(parentCode)) childrenByParent.set(parentCode, []);
    childrenByParent.get(parentCode).push(row);
  }
  const amountOf = (row, system) => {
    const nested = row?.[system]?.amount;
    if (typeof nested === "number" && Number.isFinite(nested)) return nested;
    const flat = row?.[`${system}_amount`];
    return typeof flat === "number" && Number.isFinite(flat) ? flat : null;
  };
  return rows.flatMap((row) => {
    const code = normalizeText(row?.code);
    const children = childrenByParent.get(code) ?? [];
    const intalevAmount = amountOf(row, "intalev");
    const erpAmount = amountOf(row, "erp");
    if (children.length === 0 || intalevAmount === null || erpAmount === null) {
      return [];
    }
    const groupDelta = roundMoney(intalevAmount - erpAmount);
    const completeChildren = [];
    const incompleteChildren = [];
    let knownChildDeltaSum = 0;
    for (const child of children) {
      const childIntalev = amountOf(child, "intalev");
      const childErp = amountOf(child, "erp");
      if (childIntalev === null || childErp === null) {
        incompleteChildren.push(normalizeText(child?.code));
        continue;
      }
      const childDelta = roundMoney(childIntalev - childErp);
      completeChildren.push({
        code: normalizeText(child?.code),
        delta: childDelta,
      });
      knownChildDeltaSum = roundMoney(knownChildDeltaSum + childDelta);
    }
    const residual = roundMoney(groupDelta - knownChildDeltaSum);
    return [{
      schema: "opiu-visible-group-delta-control.v1",
      code,
      group_delta: groupDelta,
      known_child_delta_sum: knownChildDeltaSum,
      residual,
      complete_children: completeChildren,
      incomplete_child_codes: incompleteChildren,
      child_count: children.length,
      delta_conservation_proven: Math.abs(residual) <= tolerance,
      display_residual: Math.abs(residual) > tolerance,
      correction_authority: false,
      posting_rows: 0,
      ready_to_upload: false,
      release_allowed: false,
    }];
  });
}

export function unanimousExactHierarchyBindingProof(sides, field) {
  const values = sides.map((side) => side?.[field] ?? null);
  if (values.length === 0 || values.every((value) => value === null)) return null;
  if (values.some((value) => value === null)) return null;
  const exact = JSON.stringify(values[0]);
  return values.every((value) => JSON.stringify(value) === exact) ? values[0] : null;
}

export function uniqueExactHierarchyBindingProof(erp = {}) {
  const proofs = [
    erp?.proven_presentation_parent,
    erp?.proven_parent_composition,
    erp?.proven_parent_composition_alias,
  ].filter((proof) => proof?.binding_repair_required === true);
  return proofs.length === 1 ? proofs[0] : null;
}

export function aggregateSide(records, system) {
  const sides = records.map((record) => record[system]);
  const presentationGroupRollups = sides
    .map((side) => side?.presentation_group_rollup)
    .filter(Boolean);
  const intalevIdentityEvidence = sides
    .map((side) => side.intalev_identity_evidence)
    .filter(Boolean);
  const r064ZeroProof = sides.flatMap((side) => side.r064_zero_proof ?? []);
  const d04CatalogProof = sides.map((side) => side.d04_catalog_proof).filter(Boolean);
  const r021SourceControl = records.map((record) => record.r021_source_control).filter(Boolean);
  const aggregateNumericField = (field) =>
    sides.length > 0 && sides.every((side) => typeof side?.[field] === "number")
      ? roundMoney(sides.reduce((sum, side) => sum + side[field], 0))
      : null;
  const rawAmount = system === "erp" ? aggregateNumericField("raw_amount") : null;
  const normalizedAmount =
    system === "erp" ? aggregateNumericField("normalized_amount") : null;
  const normalizationStatuses = unique(
    sides.map((side) => normalizeText(side?.normalization_status)).filter(Boolean),
  );
  const normalizationNotes = unique(
    sides.map((side) => normalizeText(side?.normalization_note)).filter(Boolean),
  );
  const normalizationTrace = sides.flatMap((side) => side?.normalization_trace ?? []);
  const bindingCandidates = sides.flatMap((side) => side?.binding_candidates ?? []);
  const hierarchyBindingProofs = system === "erp"
    ? {
        proven_presentation_parent: unanimousExactHierarchyBindingProof(
          sides,
          "proven_presentation_parent",
        ),
        proven_parent_composition: unanimousExactHierarchyBindingProof(
          sides,
          "proven_parent_composition",
        ),
        proven_parent_composition_alias: unanimousExactHierarchyBindingProof(
          sides,
          "proven_parent_composition_alias",
        ),
      }
    : {};
  const normalizationFields = system === "erp"
    ? {
        raw_amount: rawAmount,
        normalized_amount: normalizedAmount,
        normalization_status: normalizationStatuses.join("+"),
        normalization_note: normalizationNotes.join(" "),
        normalization_trace: normalizationTrace,
      }
    : {};
  if (
    system === "erp" &&
    sides.length > 0 &&
    sides.every((side) => side.status === "INFORMATIONAL_COVERED")
  ) {
    return {
      amount: null,
      status: "INFORMATIONAL_COVERED",
      trace: sides.flatMap((side) => side.trace),
      note: unique(sides.map((side) => normalizeText(side.note)).filter(Boolean)).join(" "),
      r064_zero_proof: r064ZeroProof,
      d04_catalog_proof: d04CatalogProof,
      r021_source_control: r021SourceControl,
      intalev_identity_evidence: intalevIdentityEvidence,
      binding_candidates: bindingCandidates,
      presentation_group_rollups: presentationGroupRollups,
      ...hierarchyBindingProofs,
      ...normalizationFields,
    };
  }
  if (!sides.every((side) => typeof side.amount === "number")) {
    const problems = unique(
      sides.filter((side) => !acceptedStatus(side.status)).map((side) => side.status),
    );
    return {
      amount: null,
      status: problems.join("+") || "MISSING",
      trace: sides.flatMap((side) => side.trace),
      r064_zero_proof: r064ZeroProof,
      d04_catalog_proof: d04CatalogProof,
      r021_source_control: r021SourceControl,
      intalev_identity_evidence: intalevIdentityEvidence,
      binding_candidates: bindingCandidates,
      presentation_group_rollups: presentationGroupRollups,
      ...hierarchyBindingProofs,
      ...normalizationFields,
    };
  }
  const reviewStatuses = unique(
    sides
      .map((side) => side.status)
      .filter((status) => requiresReconciliationReview(status)),
  );
  return {
    amount: roundMoney(sides.reduce((sum, side) => sum + side.amount, 0)),
    status: sides.every((side) => acceptedStatus(side.status))
      ? presentationGroupRollups.length > 0
        ? "PRESENTATION_GROUP_ROLLUP"
        : reviewStatuses.length > 0
          ? reviewStatuses.join("+")
          : "MATCHED"
      : unique(sides.map((side) => side.status)).join("+"),
    trace: sides.flatMap((side) => side.trace),
    r064_zero_proof: r064ZeroProof,
    d04_catalog_proof: d04CatalogProof,
    r021_source_control: r021SourceControl,
    intalev_identity_evidence: intalevIdentityEvidence,
    binding_candidates: bindingCandidates,
    presentation_group_rollups: presentationGroupRollups,
    ...hierarchyBindingProofs,
    ...normalizationFields,
  };
}

async function discoverErpFiles(erpPath, periods, organization, workDir) {
  const allExcel = await collectErpExcelFiles(erpPath, workDir);
  const candidateSelection = await deduplicateErpWorkbookFiles(
    selectLikelyErpWorkbooks(allExcel),
    workDir,
  );
  const likelyWorkbooks = candidateSelection.files;
  if (likelyWorkbooks.length === 0) {
    fail("В выбранном файле, ZIP-архиве или папке не найдено Excel-файлов ERP.");
  }

  const discoveryDir = path.join(workDir, "erp_discovery");
  const details = [];
  for (let index = 0; index < likelyWorkbooks.length; index += 1) {
    details.push(
      await detectPeriodsInErpWorkbook(
        likelyWorkbooks[index],
        discoveryDir,
        index,
      ),
    );
  }

  const scopedSelection = scopeOrganizationCandidates({
    requestedOrganization: organization,
    aliases: organizationAliases(organization),
    candidates: details,
  });
  if (scopedSelection.status !== "PASS_ORGANIZATION_SCOPED") {
    fail(
      `BLOCKED_ORGANIZATION_NOT_PROVEN: ни один ERP-источник не доказал запрошенную организацию «${organization || "MISSING"}»; unscoped fallback запрещён.`,
    );
  }
  const scopedDetails = scopedSelection.candidates;
  for (let index = 0; index < scopedDetails.length; index += 1) {
    erpSourceMetadata(scopedDetails[index].sourceFile).organizationProof =
      scopedSelection.proofs[index];
  }

  const result = new Map();
  for (const period of periods) {
    const eligibleCandidates = scopedDetails.filter((detail) =>
      detail.periods.includes(period),
    );
    const selectedCandidate = selectAuthoritativeErpCandidate({
      period,
      candidates: eligibleCandidates,
      metadataFor: (candidate) => erpSourceMetadata(candidate.sourceFile),
    });
    result.set(period, selectedCandidate.sourceFile);
  }
  console.log(
    `ERP_SOURCE_SELECTION_JSON=${JSON.stringify({
      strategy: "single_authoritative_candidate_only",
      periods,
      sourceFiles: unique([...result.values()]).map((sourceFile) => ({
        extractedFile: sourceFile,
        ...erpSourceMetadata(sourceFile),
      })),
      ignoredDuplicateSources: candidateSelection.ignoredDuplicates.length,
    })}`,
  );
  return result;
}

async function runReconciliation() {
  let referenceCatalogs = await verifyReferenceCatalogManifest({
    manifestPath: config.reference_catalog_manifest_path,
    expectedVersion: config.reference_catalog_manifest_version,
    expectedManifestSha256: config.reference_catalog_manifest_sha256,
    allowedMissingRoles: config.reference_catalog_allowed_missing_roles ?? [],
  });
  const { workDir } = await createUniqueRunWorkDir(workRoot);
  const mode = args.mode;
  const periodLabel = args.period;
  const periods = selectedPeriods(mode, periodLabel);
  const erpInputAuthority = await verifyErpInputAuthority({
    sourcePath: args.erp,
    expectedSha256: args["erp-sha256"],
    requirePin: config.require_erp_source_pin === true,
  });
  const organizationHint = normalizeText(args.organization);
  const snapshot = args.intalev
    ? await loadSelectedIntalevSource(args.intalev, periods, workDir)
    : await loadCurrentSnapshot({ verify: true });
  const snapshotByPeriod = new Map(snapshot.files.map((file) => [file.period, file]));
  const missingIntalev = periods.filter((period) => !snapshotByPeriod.has(period));
  if (missingIntalev.length > 0) {
    fail(`В фиксированном Инталев отсутствуют периоды: ${missingIntalev.join(", ")}`);
  }
  const erpFiles = await discoverErpFiles(
    args.erp,
    periods,
    organizationHint,
    workDir,
  );

  const erpCatalog = await parseErpArticleCatalog(workDir);
  const intalevCatalogSelection = await selectIntalevArticleCatalog(workDir);
  const intalevCatalog = intalevCatalogSelection.catalog;
  referenceCatalogs = bindRunIntalevUidCatalog(
    referenceCatalogs,
    intalevCatalogSelection.discovery,
    intalevCatalogSelection.selection_mode ??
      (args["intalev-articles"] ? "EXPLICIT_ARGUMENT" : "AUTO_DETECTED_CONTAINER"),
  );
  const intalevParsed = [];
  const erpParsed = [];
  for (const period of periods) {
    const intalevMeta = snapshotByPeriod.get(period);
    const intalevPath = path.isAbsolute(intalevMeta.stored_path)
      ? intalevMeta.stored_path
      : path.resolve(appDir, intalevMeta.stored_path);
    const intalevSourceBefore = await captureSourceEvidence({
      role: "intalev",
      filePath: intalevPath,
      expectedSha256: intalevMeta.sha256,
    });
    const intalev = await parseIntalevWorkbook(
      intalevPath,
      period,
      workDir,
      intalevMeta.sha256,
    );
    intalev.source_evidence = await assertSourceUnchanged(intalevSourceBefore);
    if ((await sha256File(intalevPath)) !== intalevMeta.sha256) {
      fail(`Отчёт Инталев изменился во время расчёта: ${intalevPath}`);
    }
    validateSelectedIntalevOrganization(organizationHint, intalev);
    const erpPath = erpFiles.get(period);
    const erpSourceBefore = await captureSourceEvidence({
      role: "erp",
      filePath: erpPath,
    });
    const erp = await parseErpWorkbook(
      erpPath,
      period,
      workDir,
      erpCatalog,
      erpSourceBefore.sha256_before,
    );
    erp.source_evidence = await assertSourceUnchanged(erpSourceBefore);
    intalevParsed.push(intalev);
    erpParsed.push(erp);
  }

  let profile = detectReconciliationProfile(
    snapshot,
    erpFiles,
    organizationHint,
    intalevParsed,
    erpParsed,
  );
  let machinePolicy = null;
  if (profile.id === "UK_R005") {
    machinePolicy = await loadR005MachinePolicy({
      configuredPath: profile.rulesPath,
      configuredPolicyId: config.project_rules,
      expectedSha256: config.project_rules_sha256 ?? null,
    });
    profile = applyR005MachinePolicyToProfile(profile, machinePolicy);
  }

  const organization = organizationHint || profile.organization;
  const structuralInventoryScope = {
    run_id: normalizeText(args["run-id"]),
    context_id: normalizeText(args["context-id"]),
    organization_id: normalizeText(args["organization-id"]),
    organization_name: normalizeText(args["organization-name"] ?? organization),
    organization_path: normalizeText(args["organization-path"]),
  };
  const articleApprovalScope = {
    organizationId: structuralInventoryScope.organization_id || profile.organizationCode,
    organizationName: organization,
    organizationHierarchyPath: structuralInventoryScope.organization_path,
    period: periodLabel,
    erpCatalog,
  };
  let articleApprovalDocument = null;
  const articleApprovalSettingsPath = normalizeText(args["article-approval-settings"]);
  if (articleApprovalSettingsPath) {
    try {
      articleApprovalDocument = await loadArticleApprovalDocument(
        articleApprovalSettingsPath,
        articleApprovalScope,
      );
    } catch (error) {
      fail(`ARTICLE_APPROVAL_SETTINGS_REJECTED:${error.message}`);
    }
  }
  const postedCorrectionJournalOverlays = [];
  if (
    profile.id === "UK_R005" ||
    (Array.isArray(profile.journalOrganizationAliases) && profile.journalOrganizationAliases.length > 0)
  ) {
    for (let index = 0; index < periods.length; index += 1) {
      const selectedPeriod = periods[index];
      const sourceSet = await resolveOperationEvidenceSources(erpParsed, selectedPeriod);
      const overlay = await loadPostedCorrectionJournalOverlay({
        journalPath: sourceSet.journalPath,
        period: selectedPeriod,
      });
      const application = applyPostedCorrectionOverlayToErpParsed({
        parsed: erpParsed[index],
        overlay,
      });
      if (overlay.applicable) rebuildErpParsedHierarchyAfterPostedOverlay(erpParsed[index]);
      postedCorrectionJournalOverlays.push({
        ...overlay,
        rows: overlay.rows.map((row) => ({
          pair_id: row.pair_id,
          operation: row.operation,
          amount: row.amount,
          effective_block: row.effective_block,
          effective_article: row.effective_article,
          effective_path: row.effective_path,
          effective_code: row.effective_code,
          cfo: row.cfo,
          physical_row: row.physical_row,
          source_row_id: row.source_row_id,
        })),
        application,
      });
    }
  }
  console.log(
    `POSTED_CORRECTION_JOURNAL_OVERLAY_JSON=${JSON.stringify({
      schema: "opiu-posted-correction-journal-overlay-run.v1",
      periods: postedCorrectionJournalOverlays.map((item) => ({
        period: item.period,
        status: item.status,
        applicable: item.applicable,
        counts: item.counts,
        application: item.application,
      })),
      report_only: true,
      live_1c_allowed: false,
    })}`,
  );
  const r002BaseOperationEvidence = await loadR002OperationEvidence({
    erpPath: args.erp,
    organization,
    mode,
    period: periodLabel,
    diagnosticExtractedSet:
      String(args["r002-diagnostic-extracted-set"] ?? "").toLowerCase() === "true",
  });
  for (const parsed of erpParsed) {
    for (const row of parsed.rows) {
      const identity = buildRoleBoundDimensionIdentity({
        organizationCode: profile.organizationCode,
        cfo: row.cfo,
        department: row.department,
      });
      row.organization_code = profile.organizationCode;
      row.dimension_key = identity.identity;
      row.dimension_identity_status = identity.status;
      row.dimension_roles = identity.roles;
    }
  }
  for (const entry of intalevCatalog.entries) {
    const identity = buildIntalevArticleIdentity({
      organizationCode: profile.organizationCode,
      articleCode: entry.code,
      articleName: entry.label,
    });
    entry.organization_code = profile.organizationCode;
    entry.organization_article_identity = identity.identity;
    entry.organization_article_identity_status = identity.status;
  }
  const templatePath = path.resolve(config.template_path);
  const templateSourceBefore = await captureSourceEvidence({
    role: "template",
    filePath: templatePath,
  });
  const loadedTemplateRows = await loadTemplateRows(workDir);
  const templateSourceAfter = await assertSourceUnchanged(templateSourceBefore);
  let intalevTemplateGraph = null;
  let intalevTemplateGraphSourceAfter = null;
  let templateRowsWithHierarchy;
  if (approvedIntalevTemplateGraphAppliesToProfile(profile)) {
    const intalevTemplateGraphPath = path.resolve(config.intalev_template_graph_path);
    const intalevTemplateGraphSourceBefore = await captureSourceEvidence({
      role: "intalev_template_graph",
      filePath: intalevTemplateGraphPath,
      expectedSha256: config.intalev_template_graph_sha256,
    });
    intalevTemplateGraph = await loadApprovedIntalevTemplateGraph({
      graphPath: intalevTemplateGraphPath,
      expectedGraphSha256: config.intalev_template_graph_sha256,
      templatePath,
      templateSha256: templateSourceAfter.sha256_after,
      templateRows: loadedTemplateRows,
    });
    intalevTemplateGraphSourceAfter = await assertSourceUnchanged(
      intalevTemplateGraphSourceBefore,
    );
    templateRowsWithHierarchy = attachApprovedIntalevTemplateGraph(
      loadedTemplateRows,
      intalevTemplateGraph,
    );
  } else {
    templateRowsWithHierarchy = attachIntalevSourceHierarchy(loadedTemplateRows)
      .map((row) => {
        const { intalev_label_raw: _rawLabel, ...result } = row;
        return result;
      });
  }
  const rulesPath = path.resolve(profile.rulesPath);
  const rulesSourceBefore = await captureSourceEvidence({
    role: "rules",
    filePath: rulesPath,
    expectedSha256: machinePolicy?.source?.sha256 ?? null,
  });
  const rulesSourceAfter = await assertSourceUnchanged(rulesSourceBefore);
  let policySourceAfter = null;
  if (machinePolicy) {
    const policySourceBefore = await captureSourceEvidence({
      role: "policy",
      filePath: machinePolicy.source.path,
      expectedSha256: machinePolicy.source.sha256,
    });
    policySourceAfter = await assertSourceUnchanged(policySourceBefore);
  }
  const templateRows = applyProfileTemplateOverrides(
    templateRowsWithHierarchy,
    profile,
  );
  const economicHierarchyMapping = await loadEconomicHierarchyMappingResource(
    args["economic-hierarchy-mapping"] ?? config.economic_hierarchy_mapping_path,
  );
  // This input is deliberately argument-only: production configuration must
  // never synthesize business route authority or silently reuse a prior run.
  const economicRouteProofDocument = await loadEconomicRouteProofDocument(
    args["economic-route-proofs"],
  );
  const catalogCoverage = buildCatalogCoverage({ templateRows, erpCatalog });
  const organizationHierarchyPath = normalizeText(
    args["organization-path"] ?? organization,
  ).split(/\s+\/\s+/u).filter(Boolean);
  const emptyArticleBindingOrganization = Object.freeze({
    organization_id: normalizeText(
      args["organization-id"] ?? profile.organizationCode,
    ),
    organization_name: normalizeText(
      args["organization-name"] ?? organization,
    ),
    organization_hierarchy_path: organizationHierarchyPath,
  });

  const monthly = [];
  for (let index = 0; index < periods.length; index += 1) {
    const period = periods[index];
    const intalev = intalevParsed[index];
    const erp = erpParsed[index];
    const erpResults = resolveErpRows(templateRows, erp, profile, catalogCoverage);
    const resolvedRows = templateRows.map((templateRow) => {
      let intalevResult = gateResolvedResultBySourceTree(
        resolveIntalevRow(
          templateRow,
          intalev,
          profile,
          intalevCatalog,
        ),
        templateRow,
        intalev.nodes,
        { sourceSystem: "INTALEV" },
      );
      const erpResult = erpResults.get(templateRow.code);
      const r021SourceControl = templateRow.code === "R021"
        ? validateR021IndependentTrace({ intalevResult, erpResult })
        : null;
      if (
        r021SourceControl &&
        r021SourceControl.status !== "PASS_R021_EXACT_INDEPENDENT_SOURCE"
      ) {
        intalevResult = {
          ...intalevResult,
          amount: null,
          status: "BLOCKED_R021_SOURCE_IDENTITY",
          note: "R021 exact Intalev/ERP source identity is not independently proven.",
        };
      }
      return {
        ...templateRow,
        period,
        intalev: intalevResult,
        erp: erpResult,
        r021_source_control: r021SourceControl,
        intalev_node_path: resolvedHierarchyPath(
          intalevResult,
          ["full_path"],
          [],
          templateRow.intalev_label,
        ),
        erp_node_path: resolvedHierarchyPath(
          erpResult,
          ["full_path"],
          ["catalog_path"],
          templateRow.erp_label,
        ),
      };
    });
    const hierarchy = attachTemplateHierarchy(resolvedRows, {
      erpTree: erp.hierarchy_tree,
      intalevTree: intalev.hierarchy_tree,
      economicHierarchyMapping,
    });
    for (const blocker of intalevCatalog.hierarchy_tree?.blockers ?? []) {
      if (
        !hierarchy.blockers.some(
          (candidate) => JSON.stringify(candidate) === JSON.stringify(blocker),
        )
      ) {
        hierarchy.blockers.push(blocker);
      }
    }
    if (
      intalevCatalog.hierarchy_tree?.status ===
      "BLOCKED_INTALEV_CATALOG_NOT_EXPORTED"
    ) {
      hierarchy.status = "BLOCKED_INTALEV_CATALOG_NOT_EXPORTED";
    } else {
      hierarchy.status = hierarchy.blockers.length === 0 ? "PASS" : "BLOCKED";
    }
    const sourcePresentationRows = attachCanonicalBindingStatuses(
      buildHierarchyPresentationRows(hierarchy.rows),
    );
    const sourceBlankArticleReporting = applyIntalevBlankArticleReporting({
      rows: sourcePresentationRows,
      sourceScope: intalev.source_scope_diagnostics,
      tolerance: Number(config.tolerance ?? 0.01),
    });
    const emptyArticleBindingSettings =
      await loadEmptyArticleBindingSettingsDocument(
        args["empty-article-binding-settings"],
        {
          ...emptyArticleBindingOrganization,
          period,
        },
      );
    const emptyArticleBindingApplication =
      applyEmptyArticleBindingsToBlankArticleReporting({
        organization: emptyArticleBindingOrganization,
        period,
        reporting: sourceBlankArticleReporting,
        bindingRules: emptyArticleBindingSettings.rules,
      });
    const presentationGroupRollups = applyVisibleHierarchyGroupRollups(
      emptyArticleBindingApplication.reporting.rows,
    );
    const financialPresentationCoverage = applyUkFinancialPresentationCoverage(
      presentationGroupRollups.rows,
      {
        profileId: profile.id,
        tolerance: Number(config.tolerance ?? 0.01),
      },
    );
    const blankArticleReporting = {
      ...emptyArticleBindingApplication.reporting,
      rows: financialPresentationCoverage.rows,
      presentation_group_rollup_audit: presentationGroupRollups.audits,
      structural_presentation_coverage_audit:
        financialPresentationCoverage.audit,
    };
    monthly.push({
      period,
      rows: blankArticleReporting.rows,
      hierarchy,
      erp_hierarchy_tree: erp.hierarchy_tree,
      intalev_hierarchy_tree: intalev.hierarchy_tree,
      intalev_catalog_tree: intalevCatalog.hierarchy_tree ?? null,
      intalev_source_scope: intalev.source_scope_diagnostics,
      blank_article_reporting: blankArticleReporting,
      empty_article_binding_settings: emptyArticleBindingSettings.audit,
      empty_article_binding_audit: emptyArticleBindingApplication.audit,
      catalog_coverage: catalogCoverage,
    });
  }

  const aggregateRows = templateRows.map((templateRow) => {
    const records = monthly.map((month) =>
      month.rows.find((row) => row.code === templateRow.code),
    );
    const representative = records.find(Boolean) ?? templateRow;
    const {
      intalev: _representativeIntalev,
      erp: _representativeErp,
      period: _representativePeriod,
      ...hierarchyFields
    } = representative;
    const hierarchySignatures = unique(
      records
        .filter(Boolean)
        .map((record) =>
          JSON.stringify({
            node_id: record.hierarchy_node_id,
            parent_node_id: record.hierarchy_parent_node_id,
            parent_code: record.hierarchy_parent_code,
            level: record.hierarchy_level,
            path: record.hierarchy_path,
          }),
        ),
    );
    const presentRecords = records.filter(Boolean);
    const erpBindingStatuses = presentRecords.map((record) =>
      normalizeText(record.erp_binding_status),
    );
    const erpBindingStatus = erpBindingStatuses.includes("MISMATCH")
      ? "MISMATCH"
      : presentRecords.length === records.length &&
          erpBindingStatuses.every((status) => status === "PROVEN")
        ? "PROVEN"
        : "UNPROVEN";
    const intalevHierarchyStatus =
      presentRecords.length === records.length &&
      hierarchySignatures.length <= 1 &&
      presentRecords.every(
        (record) => normalizeText(record.intalev_hierarchy_status) === "PROVEN",
      )
        ? "PROVEN"
        : "UNPROVEN";
    const intalevLiveHierarchyStatus =
      presentRecords.length === records.length &&
      hierarchySignatures.length <= 1 &&
      presentRecords.every(
        (record) => normalizeText(record.intalev_live_hierarchy_status) === "PROVEN",
      )
        ? "PROVEN"
        : "UNPROVEN";
    const blankArticleBindings = records.flatMap((record) =>
      record?.blank_article_bindings ?? (record?.blank_article_binding
        ? [record.blank_article_binding]
        : []));
    const directBlankArticleBindings = blankArticleBindings.filter(
      (binding) => normalizeText(binding?.target_code) === normalizeText(templateRow.code),
    );
    const allInReporting = records
      .map((record) => record?.intalev_all_in_reporting)
      .filter(Boolean);
    return {
      ...templateRow,
      ...hierarchyFields,
      hierarchy_period_consistent: hierarchySignatures.length <= 1,
      hierarchy_status:
        hierarchySignatures.length <= 1
          ? hierarchyFields.hierarchy_status
          : "BLOCKED_SOURCE_HIERARCHY_DRIFT",
      intalev_hierarchy_status: intalevHierarchyStatus,
      intalev_live_hierarchy_status: intalevLiveHierarchyStatus,
      erp_binding_status: erpBindingStatus,
      intalev: aggregateSide(records, "intalev"),
      erp: aggregateSide(records, "erp"),
      blank_article_bindings: blankArticleBindings,
      blank_article_binding:
        directBlankArticleBindings.length === 1 ? directBlankArticleBindings[0] : null,
      intalev_all_in_reporting: allInReporting.length > 0
        ? {
            periods: records
              .filter((record) => record?.intalev_all_in_reporting)
              .map((record) => record.period),
            classified_amount: roundMoney(allInReporting.reduce(
              (sum, item) => sum + Number(item.classified_amount ?? 0),
              0,
            )),
            blank_amount: roundMoney(allInReporting.reduce(
              (sum, item) => sum + Number(item.blank_amount ?? 0),
              0,
            )),
            all_in_amount: roundMoney(allInReporting.reduce(
              (sum, item) => sum + Number(item.all_in_amount ?? 0),
              0,
            )),
            financial_posting_rows: 0,
          }
        : null,
    };
  });

  let operationEvidence = r002BaseOperationEvidence;
  let selectedOperationSourceSets = [];
  let crossJournalEvidence = unavailableCrossJournalEvidence({
    organization,
    period: periodLabel,
    status: "NOT_EVALUATED",
    reason: "Сопоставление журналов ещё не выполнялось.",
  });
  if (
    profile.id === "UK_R005" ||
    (Array.isArray(profile.journalOrganizationAliases) && profile.journalOrganizationAliases.length > 0)
  ) {
    try {
      const sourceSets = [];
      for (const selectedPeriod of periods) {
        const parsedPeriod = erpParsed.find((item) => item?.period === selectedPeriod);
        if (!parsedPeriod?.sha256) {
          fail(`BLOCKED_OPERATION_ERP_SOURCE_SHA_MISSING: ${selectedPeriod}.`);
        }
        const operationSources = await resolveOperationEvidenceSources(
          erpParsed,
          selectedPeriod,
        );
        if (!operationSources?.journalOrigin?.sha256) {
          fail(`BLOCKED_OPERATION_JOURNAL_SOURCE_SHA_MISSING: ${selectedPeriod}.`);
        }
        sourceSets.push({
          period: selectedPeriod,
          ...operationSources,
          journalExpectedSha256: operationSources.journalOrigin.sha256,
          erpOpiuExpectedSha256: parsedPeriod.sha256,
          erpInputAuthorityPath: erpInputAuthority.input_path,
          erpInputAuthoritySha256: erpInputAuthority.actual_sha256,
        });
      }
      selectedOperationSourceSets = sourceSets;
      operationEvidence = await loadArbitraryPeriodOperationEvidence({
        sourceSets,
        organization,
        allowedJournalOrganizations: profile.journalOrganizationAliases,
        mode,
        period: periodLabel,
        periods,
        resolvedRowsByPeriod: monthly,
        aggregateRows,
        tolerance: Number(config.tolerance ?? 0.01),
        operationBearingCodes:
          profile.operationBearingCodes?.length > 0
            ? profile.operationBearingCodes
            : undefined,
        includeUnassignedRows: profile.includeUnassignedJournalRows === true,
        // Restore the 1.8.0/1.8.1 review presentation: journal rows whose
        // article text has a single R-code owner are shown directly beneath
        // that article.  This is display-only evidence; the operation builder
        // keeps every unproven row CANDIDATE_EXCLUDED and out of totals,
        // corrections, postings and release gates.
        genericExactArticleBinding: true,
      });
      if (profile.id === "UK_R005" && mode === "month" && periodLabel === "2025-07") {
        const strictOperationEvidence = await loadFullOperationEvidence({
          manifestPath: path.join(appDir, "july_2025_operation_evidence_manifest.json"),
          manifestExpectedSha256:
            "486AE13CCE41C60333812DB2560E64E8817298C3E7F6B1DD332BAA12C7D09CB9",
          journalPath: sourceSets[0].journalPath,
          erpOpiuPath: sourceSets[0].erpOpiuPath,
          organization,
          mode,
          period: periodLabel,
          financialCodes: aggregateRows.map((row) => normalizeText(row.code)),
          baseOperationEvidence: r002BaseOperationEvidence,
        });
        if (
          strictOperationEvidence.gates?.manifest_verified === true &&
          (strictOperationEvidence.rows?.length ?? 0) > 0
        ) {
          const provenNodes = (strictOperationEvidence.node_evidence ?? []).filter(
            (node) => node.node_kind === "DIRECT_LEAF" && node.node_status === "PROVEN",
          );
          const blockedNodes = (strictOperationEvidence.node_evidence ?? []).filter(
            (node) => node.node_kind === "DIRECT_LEAF" && node.node_status !== "PROVEN",
          );
          const candidateRows = (strictOperationEvidence.rows ?? []).filter(
            (row) => row.row_class === "CANDIDATE_EXCLUDED",
          );
          operationEvidence = {
            ...strictOperationEvidence,
            gates: {
              ...strictOperationEvidence.gates,
              candidate_rows_excluded_from_totals: candidateRows.every(
                (row) => row.count_in_parent === false && row.excluded_from_totals === true,
              ),
            },
            manifest_verified: true,
            journal_verified: strictOperationEvidence.gates?.journal_verified === true,
            operation_coverage_complete:
              strictOperationEvidence.gates?.operation_coverage_complete === true,
            proven_r_codes: provenNodes.map((node) => node.code),
            blocked_direct_leaf_nodes: blockedNodes.map((node) => node.code),
            proven_r_code_count: provenNodes.length,
            operation_bearing_terminal_rows: provenNodes.length + blockedNodes.length,
            evidence_strategy: "PINNED_JULY_MANIFEST",
          };
        } else {
          operationEvidence.source_trace = {
            ...(operationEvidence.source_trace ?? {}),
            pinned_july_manifest_fallback: {
              status: strictOperationEvidence.status,
              manifest_verified:
                strictOperationEvidence.gates?.manifest_verified === true,
              rows: strictOperationEvidence.rows?.length ?? 0,
              reason:
                "Pinned July source did not match the current selected source; generic rows remain review-only.",
            },
          };
        }
      }
    } catch (error) {
      operationEvidence = {
        schema: "opiu-operation-source-binding-block-v1",
        status: "BLOCKED_OPERATION_SOURCE_BINDING",
        applicable: true,
        input: {
          organization,
          mode,
          period: periodLabel,
          periods,
        },
        error: { message: error?.message ?? String(error) },
        manifest_verified: false,
        journal_verified: false,
        journal_sha256: null,
        journal_sheet: null,
        source_contributor_rows: 0,
        display_operation_rows: 0,
        candidate_excluded_rows: 0,
        new_pair_candidates: 0,
        correction_operation_rows: 0,
        posting_rows: 0,
        report_only: true,
        ready_to_upload: false,
        release_allowed: false,
        rows: [],
        node_evidence: [],
        leaf_totals: {},
        proven_r_codes: [],
        blocked_direct_leaf_nodes: [],
        proven_r_code_count: 0,
        operation_bearing_terminal_rows: 0,
        operation_coverage_complete: false,
        counts: {
          journal_rows: 0,
          source_contributor_rows: 0,
          candidate_excluded_rows: 0,
          display_operation_rows: 0,
          correction_operation_rows: 0,
          posting_rows: 0,
        },
        gates: {
          report_only: true,
          source_binding_verified: false,
          erp_sources_verified: false,
          journal_verified: false,
          operation_coverage_complete: false,
          candidate_rows_excluded_from_totals: true,
          correction_operation_rows: 0,
          posting_rows: 0,
          ready_to_upload: false,
          release_allowed: false,
        },
        source_trace: null,
      };
    }
  }

  if (periods.length === 1) {
    const crossJournalPeriod = periods[0];
    try {
      const intalevJournal = await resolveIntalevOperationJournalSource(
        workDir,
        crossJournalPeriod,
      );
      const erpSourceSet = selectedOperationSourceSets.find(
        (item) => item?.period === crossJournalPeriod,
      ) ?? await resolveOperationEvidenceSources(erpParsed, crossJournalPeriod);
      if (!intalevJournal.path) {
        crossJournalEvidence = unavailableCrossJournalEvidence({
          organization,
          period: crossJournalPeriod,
          status: intalevJournal.status,
          reason: intalevJournal.reason,
        });
      } else {
        crossJournalEvidence = await buildCrossJournalDiscrepancyEvidence({
          intalevJournalPath: intalevJournal.path,
          erpJournalPath: erpSourceSet.journalPath,
          period: crossJournalPeriod,
          organization,
          intalevCatalogNodes: intalevCatalog.entries ?? intalevCatalog.nodes ?? [],
          intalevReportNodes: intalevParsed
            .filter((item) => normalizeText(item?.period) === normalizeText(crossJournalPeriod))
            .flatMap((item) => item?.hierarchy_tree?.nodes ?? []),
          erpCatalogNodes: erpCatalog.nodes ?? [],
          erpSourceArchivePath: erpSourceSet.journalOrigin?.inputPath
            || erpSourceSet.erpInputAuthorityPath,
          erpSourceArchiveSha256: erpSourceSet.erpInputAuthoritySha256,
          erpJournalEntry: erpSourceSet.journalOrigin?.archiveEntry
            || path.basename(erpSourceSet.journalPath),
          articleApprovalDocument,
          articleApprovalScope,
          allowedPhysicalOrganizations: unique([
            organization,
            ...(profile.journalOrganizationAliases ?? []),
          ]),
        });
      }
    } catch (error) {
      crossJournalEvidence = unavailableCrossJournalEvidence({
        organization,
        period: crossJournalPeriod,
        status: "BLOCKED_CROSS_JOURNAL_READER",
        reason: error?.message ?? String(error),
      });
    }
  } else {
    crossJournalEvidence = unavailableCrossJournalEvidence({
      organization,
      period: periodLabel,
      status: "NOT_APPLICABLE_MULTI_PERIOD",
      reason: "Взаимно-уникальное сопоставление физических строк выполняется отдельно для одного месяца.",
    });
  }
  console.log(
    `CROSS_JOURNAL_EVIDENCE_JSON=${JSON.stringify({
      schema: crossJournalEvidence.schema,
      status: crossJournalEvidence.status,
      applicable: crossJournalEvidence.applicable,
      period: crossJournalEvidence.period,
      counts: crossJournalEvidence.counts,
      gates: crossJournalEvidence.gates,
    })}`,
  );

  if (intalevCatalogSelection.discovery?.selected) {
    intalevCatalogSelection.discovery = await assertIntalevCatalogBindingUnchanged(
      intalevCatalogSelection.discovery,
    );
    referenceCatalogs.run_bound.intalev_uid =
      intalevCatalogSelection.discovery.selected.provenance;
  }
  const referenceCatalogFinalRehash = await rehashReferenceCatalogManifest(
    referenceCatalogs,
  );
  const referenceCatalogTrace = buildReferenceCatalogTrace(
    referenceCatalogs,
    referenceCatalogFinalRehash,
  );
  const sourceProvenance = buildSourceProvenance({
    template: templateSourceAfter,
    intalevTemplateGraph: intalevTemplateGraphSourceAfter,
    rules: rulesSourceAfter,
    policy: policySourceAfter,
    referenceCatalogs: referenceCatalogTrace,
  });

  const requestedOutputPath = resolveOutputPath(organization, mode, periodLabel);
  const outputPath = await chooseWritableOutputPath(requestedOutputPath);
  await fs.mkdir(path.dirname(outputPath), { recursive: true });
  const buildResult = await buildReportWorkbook({
    organization,
    structuralInventoryScope,
    articleApprovalDocument,
    articleApprovalScope,
    profile,
    machinePolicy,
    mode,
    periodLabel,
    periods,
    snapshot,
    templateRows,
    aggregateRows,
    monthly,
    intalevParsed,
    erpParsed,
    erpCatalog,
    intalevCatalog,
    referenceCatalogs,
    referenceCatalogTrace,
    sourceProvenance,
    intalevTemplateGraph: serializeApprovedIntalevTemplateGraph(intalevTemplateGraph),
    erpInputAuthority,
    operationEvidence,
    crossJournalEvidence,
    postedCorrectionJournalOverlays,
    economicHierarchyMapping,
    economicRouteProofDocument,
    outputPath,
    workDir,
    render: Boolean(args.render),
  });
  const resolvedWorkDir = path.resolve(workDir);
  const resolvedOutputPath = path.resolve(outputPath);
  if (
    !args.render &&
    !resolvedOutputPath.startsWith(`${resolvedWorkDir}${path.sep}`)
  ) {
    await fs.rm(resolvedWorkDir, { recursive: true, force: true });
  }
  console.log(`Отчёт создан: ${outputPath}`);
  console.log(`Данные для предпросмотра: ${buildResult.codex_input_path}`);
  console.log(`Статус: ${buildResult.status}`);
  console.log(`ready_to_upload: FALSE`);
  // Some workbook backends can leave a non-zero process exitCode after a
  // successfully handled diagnostic operation.  The UI treats that stale
  // value as a failed run even though the XLSX and manifests are complete.
  process.exitCode = 0;
}

function resolveOutputPath(organization, mode, periodLabel) {
  const fileName = `Сверка_${safeFileName(periodLabel)}_${mode}.xlsx`;
  if (!args.output) return path.join(defaultOutputsDir, fileName);
  const requested = path.resolve(args.output);
  return /\.xlsx$/i.test(requested) ? requested : path.join(requested, fileName);
}

async function chooseWritableOutputPath(requestedPath) {
  try {
    await fs.access(requestedPath);
  } catch (error) {
    if (error?.code === "ENOENT") return requestedPath;
    throw error;
  }

  try {
    const handle = await fs.open(requestedPath, "r+");
    await handle.close();
    return requestedPath;
  } catch (error) {
    if (!["EBUSY", "EACCES", "EPERM"].includes(error?.code)) throw error;
  }

  const parsed = path.parse(requestedPath);
  const now = new Date();
  const pad = (value) => String(value).padStart(2, "0");
  const stamp =
    `${now.getFullYear()}${pad(now.getMonth() + 1)}${pad(now.getDate())}_` +
    `${pad(now.getHours())}${pad(now.getMinutes())}${pad(now.getSeconds())}`;
  for (let sequence = 1; sequence <= 99; sequence += 1) {
    const suffix = sequence === 1 ? "" : `_${sequence}`;
    const alternatePath = path.join(
      parsed.dir,
      `${parsed.name}_НОВЫЙ_${stamp}${suffix}${parsed.ext}`,
    );
    try {
      await fs.access(alternatePath);
    } catch (error) {
      if (error?.code !== "ENOENT") throw error;
      console.log(
        `Предыдущий отчёт открыт в Excel. Новый отчёт будет сохранён отдельно: ${alternatePath}`,
      );
      return alternatePath;
    }
  }
  fail("Не удалось подобрать свободное имя для нового отчёта.");
}

function columnName(number) {
  let current = number;
  let result = "";
  while (current > 0) {
    const remainder = (current - 1) % 26;
    result = String.fromCharCode(65 + remainder) + result;
    current = Math.floor((current - 1) / 26);
  }
  return result;
}

function address(startRow, startColumn, rowCount, columnCount) {
  const endRow = startRow + rowCount - 1;
  const endColumn = startColumn + columnCount - 1;
  return `${columnName(startColumn)}${startRow}:${columnName(endColumn)}${endRow}`;
}

function writeValues(sheet, startRow, startColumn, matrix) {
  if (matrix.length === 0 || matrix[0].length === 0) return null;
  const range = sheet.getRange(
    address(startRow, startColumn, matrix.length, matrix[0].length),
  );
  range.values = matrix;
  return range;
}

function writeFormulas(sheet, startRow, startColumn, matrix) {
  if (matrix.length === 0 || matrix[0].length === 0) return null;
  const range = sheet.getRange(
    address(startRow, startColumn, matrix.length, matrix[0].length),
  );
  range.formulas = matrix;
  return range;
}

function styleTitle(sheet, rangeAddress, text) {
  const range = sheet.getRange(rangeAddress);
  range.merge();
  range.values = [[text]];
  range.format = {
    fill: colors.blueHeader,
    font: { bold: true, color: colors.white, size: 15 },
    verticalAlignment: "center",
  };
  range.format.rowHeight = 28;
}

function styleHeader(range, fill = colors.blueHeader) {
  range.format = {
    fill,
    font: { bold: true, color: colors.white },
    horizontalAlignment: "center",
    verticalAlignment: "center",
    wrapText: true,
    borders: { preset: "all", style: "thin", color: colors.border },
  };
  range.format.rowHeight = 30;
}

function styleData(range) {
  range.format = {
    verticalAlignment: "center",
    borders: {
      insideHorizontal: { style: "thin", color: "#D9E2F3" },
      insideVertical: { style: "thin", color: "#D9E2F3" },
      bottom: { style: "thin", color: "#D9E2F3" },
    },
  };
}

function setColumnWidths(sheet, widths, lastRow) {
  for (let index = 0; index < widths.length; index += 1) {
    sheet.getRange(`${columnName(index + 1)}1:${columnName(index + 1)}${lastRow}`).format.columnWidth =
      widths[index];
  }
}

function initializeReportOnlyContractSheet(sheet, {
  title,
  description,
  headers,
  info,
  widths,
}) {
  const lastColumn = columnName(headers.length);
  styleTitle(sheet, `A1:${lastColumn}1`, title);
  sheet.getRange(`A2:${lastColumn}2`).merge();
  sheet.getRange("A2").values = [[`REPORT_ONLY — ${description}`]];
  sheet.getRange(`A2:${lastColumn}2`).format = {
    fill: colors.yellow,
    font: { bold: true, color: "#7F6000" },
    wrapText: true,
  };
  writeValues(sheet, 4, 1, [[...headers]]);
  styleHeader(sheet.getRange(`A4:${lastColumn}4`));
  const infoRow = [info, ...Array.from({ length: headers.length - 1 }, () => "")];
  writeValues(sheet, 5, 1, [infoRow]);
  styleData(sheet.getRange(`A5:${lastColumn}5`));
  sheet.getRange(`A5:${lastColumn}5`).format.fill = colors.yellow;
  setColumnWidths(sheet, widths, 5);
  sheet.freezePanes.freezeRows(4);
}

export function createMandatoryWorkbookSheets(workbook, {
  periodLabel = "",
  includeProvenOperations = false,
} = {}) {
  const byName = new Map();
  for (const sheetName of MANDATORY_RECONCILIATION_SHEET_NAMES) {
    byName.set(sheetName, workbook.worksheets.add(sheetName));
  }
  if (includeProvenOperations) {
    byName.set(
      OPTIONAL_PROVEN_OPERATIONS_SHEET_NAME,
      workbook.worksheets.add(OPTIONAL_PROVEN_OPERATIONS_SHEET_NAME),
    );
  }
  initializeReportOnlyContractSheet(byName.get("08_Решения_обоснование"), {
    title: `Обоснование решений владельца — ${periodLabel || "период не задан"}`,
    description: "placeholder будет заменён owner wrapper строго на месте; финансовая authority отсутствует.",
    headers: OWNER_DECISION_EXPLANATION_HEADERS,
    info: "INFO_NO_OWNER_DECISIONS",
    widths: [14,48,18,18,18,34,34,34,22,38,16,22,22,22,24,22,18,22,90,90,34],
  });
  return byName;
}

export function initializeMandatoryZeroWorkbookSheets(sheetsByName, periodLabel = "") {
  initializeReportOnlyContractSheet(sheetsByName.get("04A_Расхождения_проводок"), {
    title: `Сопоставление физических проводок Инталев ↔ ERP — ${periodLabel}`,
    description: "в выбранном периоде нет строк сопоставления журналов; проводки не формируются.",
    headers: CROSS_JOURNAL_DISCREPANCY_HEADERS,
    info: "INFO_NO_CROSS_JOURNAL_ROWS",
    widths: [38,24,14,12,30,36,36,16,14,10,10,42,54,46,16,46,16,76,68,24,44,44,72,72,34,34,22,20,36,22,20,72,34],
  });
  initializeReportOnlyContractSheet(sheetsByName.get("04B_R001_решения"), {
    title: `Доказанные решения для движка корректировок R001 — ${periodLabel}`,
    description: "доказанные correction rows отсутствуют; posting_rows=0.",
    headers: CROSS_JOURNAL_CORRECTION_HEADERS,
    info: "INFO_NO_R001_DECISION_ROWS",
    widths: CROSS_JOURNAL_CORRECTION_HEADERS.map((_, index) =>
      index < 18 ? 20 : index < 43 ? 24 : 36),
  });
  initializeReportOnlyContractSheet(sheetsByName.get("08_Операции_журнала"), {
    title: `Операции журнала для проверки — ${periodLabel}`,
    description: "непривязанные физические операции отсутствуют; проводки не формируются.",
    headers: JOURNAL_OPERATION_HEADERS,
    info: "INFO_NO_JOURNAL_OPERATION_ROWS",
    widths: [12,58,18,13,46,13,18,12,42,12,42,16,28,36,24,28,58],
  });
}

function deduplicateTrace(trace) {
  const seen = new Set();
  const result = [];
  for (const item of trace ?? []) {
    const key = `${item.source_file}|${item.sheet}|${item.source_cell ?? item.row}`;
    if (seen.has(key)) continue;
    seen.add(key);
    result.push(item);
  }
  return result;
}

function uniqueTraceValues(trace, propertyName) {
  return unique(
    deduplicateTrace(trace ?? [])
      .map((item) => normalizeText(item?.[propertyName]))
      .filter(Boolean),
  );
}

function traceSources(trace) {
  return deduplicateTrace(trace ?? []).map((item) => ({
    ...serializeExactSourceTrace(item),
    input_origin: normalizeText(item.input_origin),
    source_modified: normalizeText(item.source_modified),
    archive_entry: normalizeText(item.archive_entry),
    row: item.physical_row ?? item.row ?? null,
    full_path: normalizeText(item.full_path),
    organization: normalizeText(item.organization),
    organization_code: normalizeText(item.organization_code),
    organization_proof: item.organization_proof ?? null,
    cfo: normalizeText(item.cfo),
    department: normalizeText(item.department),
    dimension_roles: item.dimension_roles ?? null,
    dimension_identity_status: normalizeText(item.dimension_identity_status),
    organizational_dimensions: normalizeDimensionValues(item.organizational_dimensions),
    dimensions_used_for_identity: Boolean(item.dimensions_used_for_identity),
    dimensions_not_posting_axis: Boolean(item.dimensions_not_posting_axis),
    label: normalizeText(item.label),
    source_label_raw: normalizeText(item.source_label_raw),
    source_label_present: item.source_label_present !== false,
    source_label_cell: normalizeText(item.source_label_cell),
    article: normalizeText(item.article),
    article_classification: normalizeText(item.article_classification),
    summary_label: normalizeText(item.summary_label),
    catalog_code: normalizeText(item.catalog_code),
    catalog_account: normalizeText(item.catalog_account),
    catalog_path: normalizeText(item.catalog_path),
    intalev_article_code: normalizeText(item.intalev_article_code),
    intalev_article_identity: normalizeText(item.intalev_article_identity),
    intalev_catalog_source_row: item.intalev_catalog_source_row ?? null,
    period_header_trace: item.period_header_trace ?? null,
    source_tree_proof: serializeSourceTreeProof(item),
  }));
}

const CODEX_HIERARCHY_NODE_FIELDS = Object.freeze([
  "node_id",
  "parent_node_id",
  "name",
  "label",
  "full_path",
  "level",
  "hierarchy_level",
  "source_outline_level",
  "outline_gap_collapsed",
  "is_group",
  "immediate_children",
  "direct_total",
  "immediate_child_sum",
  "hierarchy_delta",
  "hierarchy_status",
  "validation_status",
  "status",
  "article",
  "article_classification",
  "catalog_code",
  "catalog_account",
  "catalog_path",
  "source_label_raw",
  "source_label_present",
  "source_label_cell",
  "source_identity",
  "source_identity_scope",
  "dimension_key",
  "dimension_identity_status",
  "dimension_roles",
  "source_row_role",
  "composition_grain_key",
  "aggregation_grain_key",
  "aggregation_contract",
  "aggregation_contract_status",
  "semantic_type",
  "semantic_type_status",
  "correction_authority",
]);

function compactHierarchyNodeSource(source) {
  if (!source || typeof source !== "object" || Array.isArray(source)) return null;
  return {
    file: normalizeText(source.file ?? source.source_file),
    sheet: normalizeText(source.sheet),
    row: source.row ?? source.physical_row ?? null,
    source_cell: normalizeText(source.source_cell),
    archive_path: normalizeText(source.archive_path),
    archive_entry: normalizeText(source.archive_entry),
    sha256: normalizeText(source.sha256),
  };
}

export function compactHierarchyTreeForCodex(tree) {
  if (!tree || typeof tree !== "object" || Array.isArray(tree)) return null;
  const bridgeBlockers = [];
  const nodes = Array.isArray(tree.nodes)
    ? tree.nodes.map((node) => {
        const result = Object.fromEntries(CODEX_HIERARCHY_NODE_FIELDS
          .filter((field) => field !== "parent_node_id")
          .filter((field) => Object.hasOwn(node ?? {}, field))
          .map((field) => [field, node[field]]));
        const canonicalParent = normalizeText(node?.parent_node_id);
        const producerParent = normalizeText(node?.parent_id);
        if (canonicalParent && producerParent && canonicalParent !== producerParent) {
          bridgeBlockers.push({
            code: "PARENT_FIELD_CONFLICT",
            message: "parent_node_id conflicts with producer parent_id.",
            node_id: normalizeText(node?.node_id),
            full_path: normalizeText(node?.full_path),
          });
        } else if (canonicalParent || producerParent) {
          result.parent_node_id = canonicalParent || producerParent;
        }
        const source = compactHierarchyNodeSource(node?.source);
        if (source) result.source = source;
        return result;
      })
    : [];
  const canonicalRoots = Array.isArray(tree.root_node_ids) ? tree.root_node_ids : null;
  const producerRoots = Array.isArray(tree.roots) ? tree.roots : null;
  let rootNodeIDs = canonicalRoots ?? producerRoots ?? [];
  if (canonicalRoots && producerRoots &&
      JSON.stringify(canonicalRoots) !== JSON.stringify(producerRoots)) {
    bridgeBlockers.push({
      code: "ROOT_FIELD_CONFLICT",
      message: "root_node_ids conflicts with producer roots.",
      node_id: "",
      full_path: "",
    });
    rootNodeIDs = [];
  }
  const sourceBlockers = Array.isArray(tree.blockers) ? tree.blockers.map((blocker) => ({
    code: normalizeText(blocker?.code),
    message: normalizeText(blocker?.message ?? blocker?.reason),
    node_id: normalizeText(blocker?.node_id),
    full_path: normalizeText(blocker?.full_path),
  })) : [];
  return {
    schema: normalizeText(tree.schema ?? tree.schema_version),
    status: bridgeBlockers.length === 0 ? normalizeText(tree.status) : "BLOCKED",
    period: normalizeText(tree.period),
    node_count: Number.isFinite(Number(tree.node_count)) ? Number(tree.node_count) : nodes.length,
    root_node_ids: [...rootNodeIDs],
    level_counts: tree.level_counts && typeof tree.level_counts === "object"
      ? { ...tree.level_counts }
      : {},
    blockers: [...sourceBlockers, ...bridgeBlockers],
    nodes,
    codex_compaction: {
      schema: "opiu-codex-hierarchy-tree-compact.v1",
      omitted_heavy_trace: true,
      physical_operation_evidence_location: "operation_evidence",
    },
  };
}

function compactTemplateGraphForCodex(graph) {
  if (!graph || typeof graph !== "object" || Array.isArray(graph)) return null;
  return {
    graph_id: normalizeText(graph.graph_id),
    status: normalizeText(graph.status),
    approved_intalev_reference_graph_id: normalizeText(graph.approved_intalev_reference_graph_id),
    approved_intalev_reference_graph_sha256: normalizeText(graph.approved_intalev_reference_graph_sha256),
    approved_intalev_reference_template_sha256: normalizeText(graph.approved_intalev_reference_template_sha256),
    expected_codes: Array.isArray(graph.expected_codes) ? [...graph.expected_codes] : [],
    validation: graph.validation && typeof graph.validation === "object"
      ? { ...graph.validation }
      : null,
  };
}

export function buildCodexInputPayload({
  organization,
  profile,
  machinePolicy,
  mode,
  periodLabel,
  periods,
  aggregateRows,
  presentationRows,
  monthly,
  outputPath,
  outputSha256,
  generatedAt,
  tolerance,
  referenceCatalogs,
  referenceCatalogTrace,
  sourceProvenance,
  intalevTemplateGraph,
  erpInputAuthority,
  operationEvidence,
  crossJournalEvidence = null,
  postedCorrectionJournalOverlays = [],
  sourceDrivenExpenseCoverage = null,
  economicHierarchyMapping = null,
  economicRouteProofDocument = null,
  includePeriodRows = true,
  structuralControlGroups = activeStructuralControlGroups,
}) {
  const presentationByCode = new Map(
    (presentationRows ?? []).map((row) => [normalizeText(row.code), row]),
  );
  const structuralAssessmentRows = (presentationRows ?? aggregateRows ?? []).map((row) => {
    const intalevAmount = row?.intalev?.amount ?? row?.intalev_amount;
    const erpAmount = row?.erp?.amount ?? row?.erp_amount;
    return {
      ...row,
      organization,
      period: periodLabel,
      intalev_amount: intalevAmount,
      erp_amount: erpAmount,
      raw_delta: typeof intalevAmount === "number" && typeof erpAmount === "number"
        ? roundMoney(intalevAmount - erpAmount)
        : null,
    };
  });
  const structuralControlResults = /^\d{4}-(0[1-9]|1[0-2])$/.test(periodLabel)
    ? assessConfiguredStructuralControlGroups(structuralAssessmentRows, {
        organization,
        period: periodLabel,
        groups: structuralControlGroups,
      })
    : [];
  const closedStructuralControlSetIds = new Set(structuralControlResults
    .filter((control) => control?.classification === "STRUCTURAL_GROUP_SUM_OK")
    .map((control) => normalizeText(control?.control_set_id))
    .filter(Boolean));
  const closedStructuralControlGroups = (structuralControlGroups ?? []).filter((group) =>
    closedStructuralControlSetIds.has(normalizeText(group?.group_id ?? group?.id)));
  const structuralMemberByCode = new Map(structuralControlResults.flatMap((control) =>
    (control.member_rows ?? []).map((member) => [member.code, { control, member }])));
  const decisionRows = (aggregateRows ?? []).map((row) => {
    const structural = structuralMemberByCode.get(normalizeText(row.code));
    return structural
      ? {
          ...row,
          structural_group_control_enabled: true,
          structural_group_control_set_id: structural.control.control_set_id,
          structural_group_sum_status: structural.control.classification,
          structural_control_effective_delta: structural.member.effective_delta,
        }
      : row;
  });
  const decisionPlan = decideReconciliationPipelineRows({
    rows: decisionRows,
    tolerance,
    structural_control_groups: closedStructuralControlGroups,
  });
  const decisionByCode = new Map(
    decisionPlan.rows.map((decision) => [normalizeText(decision.row_id), decision]),
  );
  const intalevSourceScopes = (monthly ?? [])
    .map((month) => month?.intalev_source_scope)
    .filter(Boolean);
  const unboundRows = aggregateRows.map((row, index) => {
    const presentation = presentationByCode.get(normalizeText(row.code)) ?? null;
    const intalevAmount = row.intalev.amount;
    const erpAmount = row.erp.amount;
    const delta =
      typeof intalevAmount === "number" && typeof erpAmount === "number"
        ? roundMoney(intalevAmount - erpAmount)
        : null;
    const isInformational =
      row.comparison_mode === "INFORMATIONAL_COVERED" ||
      row.erp.status === "INFORMATIONAL_COVERED";
    const baseReconciliationStatus = deriveReconciliationStatus({
      comparisonMode: row.comparison_mode,
      intalevStatus: row.intalev.status,
      erpStatus: row.erp.status,
      intalevAmount,
      erpAmount,
      delta,
      tolerance,
      erpBindingStatus: row.erp_binding_status,
    });
    const structuralMember = structuralMemberByCode.get(normalizeText(row.code)) ?? null;
    const presentationBlockExempt = isOwnerPresentationBlockExempt(
      row.code,
      closedStructuralControlGroups,
    );
    const structuralControl = ownerPresentationBlockExemption(row.code, {
      period: periodLabel,
      normalizedDelta: delta,
      groups: closedStructuralControlGroups,
      controlResult: structuralMember?.control ?? null,
    });
    const reconciliationStatus = structuralMember
      ? structuralMember.control.classification
      : presentationBlockExempt
        ? OWNER_PRESENTATION_BLOCK_EXEMPT_CLASSIFICATION
        : baseReconciliationStatus;
    const mappingProblem = reconciliationStatus === "REQUIRES_CLARIFICATION";
    const isDiscrepancy =
      structuralMember
        ? reconciliationStatus !== "STRUCTURAL_GROUP_SUM_OK"
        : (reconciliationStatus === "REQUIRES_CLARIFICATION" ||
          reconciliationStatus === "DISCREPANCY");

    const intalevTrace = deduplicateTrace(row.intalev.trace ?? []);
    const erpTrace = deduplicateTrace(row.erp.trace ?? []);
    const intalevPaths = uniqueTraceValues(intalevTrace, "full_path");
    const erpPaths = uniqueTraceValues(erpTrace, "full_path");
    const erpCatalogPaths = uniqueTraceValues(erpTrace, "catalog_path");
    const cfo = uniqueTraceValues(erpTrace, "cfo");
    const departments = uniqueTraceValues(erpTrace, "department");
    const accounts = uniqueTraceValues(erpTrace, "catalog_account");
    const articleCodes = uniqueTraceValues(erpTrace, "catalog_code");
    const hierarchyGroup = normalizeText(row.type) || "ОПИУ";
    const keyPayload = bindCalculationPayload({
      organization,
      organization_code: profile.organizationCode,
      cfo,
      departments,
      period: periodLabel,
      code: row.code,
      intalev_paths: intalevPaths,
      erp_paths: erpPaths,
      erp_catalog_paths: erpCatalogPaths,
    }, referenceCatalogs);
    const decisionKey = crypto
      .createHash("sha256")
      .update(JSON.stringify(keyPayload))
      .digest("hex");
    const monthlyDetails = monthly
      .map((month) => {
        const monthRow = month.rows.find((item) => item.code === row.code);
        if (!monthRow) return null;
        const monthDelta =
          typeof monthRow.intalev.amount === "number" &&
          typeof monthRow.erp.amount === "number"
            ? roundMoney(monthRow.intalev.amount - monthRow.erp.amount)
            : null;
        return {
          period: month.period,
          hierarchy_node_id: normalizeText(monthRow.hierarchy_node_id),
          hierarchy_parent_node_id: normalizeText(monthRow.hierarchy_parent_node_id),
          hierarchy_parent_code: normalizeText(monthRow.hierarchy_parent_code),
          hierarchy_level: Number(monthRow.hierarchy_level ?? 0),
          hierarchy_has_children: Boolean(monthRow.hierarchy_has_children),
          hierarchy_path: Array.isArray(monthRow.hierarchy_path)
            ? monthRow.hierarchy_path
            : [],
          hierarchy_status: normalizeText(monthRow.hierarchy_status),
          parent_code: normalizeText(monthRow.parent_code),
          presentation_parent: normalizeText(monthRow.presentation_parent),
          erp_presentation_parent: normalizeText(monthRow.erp_presentation_parent),
          erp_presentation_parent_node_id: normalizeText(monthRow.erp_presentation_parent_node_id),
          intalev_presentation_parent: normalizeText(monthRow.intalev_presentation_parent),
          intalev_presentation_parent_node_id: normalizeText(monthRow.intalev_presentation_parent_node_id),
          economic_parent: normalizeText(monthRow.economic_parent),
          posting_parent: normalizeText(monthRow.posting_parent),
          economic_parent_proven: monthRow.economic_parent_proven === true,
          presentation_parent_match: monthRow.presentation_parent_match === true,
          economic_parent_match: monthRow.economic_parent_match === true,
          posting_parent_proven: monthRow.posting_parent_proven === true,
          evidence_category: normalizeText(monthRow.evidence_category),
          evidence_severity: normalizeText(monthRow.evidence_severity),
          evidence_status: normalizeText(monthRow.evidence_status),
          correction_authority: monthRow.correction_authority === true,
          intalev_hierarchy_status: normalizeText(
            monthRow.intalev_hierarchy_status,
          ),
          intalev_live_hierarchy_status: normalizeText(
            monthRow.intalev_live_hierarchy_status,
          ),
          erp_binding_status: normalizeText(monthRow.erp_binding_status),
          intalev: monthRow.intalev.amount,
          erp: monthRow.erp.amount,
          intalev_group_rollup:
            monthRow.intalev.presentation_group_rollup ?? null,
          erp_group_rollup:
            monthRow.erp.presentation_group_rollup ?? null,
          erp_raw: monthRow.erp.raw_amount,
          erp_normalized: monthRow.erp.normalized_amount,
          erp_normalization_status: normalizeText(
            monthRow.erp.normalization_status,
          ),
          erp_normalization_note: normalizeText(monthRow.erp.normalization_note),
          delta: monthDelta,
          intalev_status: monthRow.intalev.status,
          erp_status: monthRow.erp.status,
          intalev_note: normalizeText(monthRow.intalev.note),
          intalev_identity_evidence:
            monthRow.intalev.intalev_identity_evidence ?? null,
          erp_note: normalizeText(monthRow.erp.note),
          erp_parent_detail_control: monthRow.erp.parent_detail_control ?? null,
          intalev_paths: uniqueTraceValues(monthRow.intalev.trace, "full_path"),
          erp_paths: uniqueTraceValues(monthRow.erp.trace, "full_path"),
          cfo: uniqueTraceValues(monthRow.erp.trace, "cfo"),
          departments: uniqueTraceValues(monthRow.erp.trace, "department"),
          d04_catalog_proof: monthRow.erp.d04_catalog_proof ?? null,
          dimensions_by_role: {
            cfo: uniqueTraceValues(monthRow.erp.trace, "cfo"),
            department: uniqueTraceValues(monthRow.erp.trace, "department"),
          },
          dimensions_used_for_identity: true,
          dimensions_not_posting_axis: true,
        };
      })
      .filter(Boolean);

    const posting = postingEligibility(row);
    const decision = decisionByCode.get(normalizeText(row.code));
    const allowedJournalOrganizations = new Set(
      (operationEvidence?.source_trace?.allowed_journal_organizations ?? [])
        .map(normalizeText)
        .filter(Boolean),
    );
    const operationEvidenceRows = (operationEvidence?.rows ?? [])
      .filter((operation) => {
        const sourceOrganization = normalizeText(operation?.organization);
        const organizationAllowed = allowedJournalOrganizations.size > 0
          ? allowedJournalOrganizations.has(sourceOrganization)
          : sourceOrganization === normalizeText(organization);
        return normalizeText(operation?.parent_code) === normalizeText(row.code) &&
          normalizeText(operation?.period) === normalizeText(periodLabel) &&
          organizationAllowed;
      })
      .map((operation) => ({
        ...operation,
        source_organization_raw: operation?.organization,
        source_organization: organization,
        source_organization_alias_verified: true,
      }));
    const decisionRawDelta = decision?.raw_delta ?? delta;
    const decisionEffectiveDelta = decision?.effective_delta;
    const hasProvenMapping = decision?.classification === "BINDING_REPAIR_PROVEN" &&
      typeof decisionRawDelta === "number" &&
      typeof decisionEffectiveDelta === "number";
    const erpHierarchyBindingProof = uniqueExactHierarchyBindingProof(row.erp);
    const provenMappingAdjustment = hasProvenMapping
      ? roundMoney(decisionRawDelta - decisionEffectiveDelta)
      : null;
    const sourceScopeContract = buildIntalevSourceScopeRowContract({
      row: {
        ...row,
        period: periodLabel,
        intalev_amount: intalevAmount,
        erp_amount: erpAmount,
        delta,
      },
      decision,
      sourceScopes: intalevSourceScopes,
      tolerance,
    });
    return {
      decision_key: decisionKey,
      organization,
      organization_code: profile.organizationCode,
      profile_id: profile.id,
      period: periodLabel,
      periods,
      mode,
      display_order: index + 1,
      code: row.code,
      group: row.type,
      hierarchy_group: hierarchyGroup,
      hierarchy_node_id: normalizeText(row.hierarchy_node_id),
      hierarchy_parent_node_id: normalizeText(row.hierarchy_parent_node_id),
      hierarchy_level: Number(row.hierarchy_level ?? 0),
      hierarchy_parent_code: normalizeText(row.hierarchy_parent_code),
      parent_code: normalizeText(row.parent_code),
      presentation_parent: normalizeText(row.presentation_parent),
      erp_presentation_parent: normalizeText(row.erp_presentation_parent),
      erp_presentation_parent_node_id: normalizeText(row.erp_presentation_parent_node_id),
      intalev_presentation_parent: normalizeText(row.intalev_presentation_parent),
      intalev_presentation_parent_node_id: normalizeText(row.intalev_presentation_parent_node_id),
      economic_parent: normalizeText(row.economic_parent),
      posting_parent: normalizeText(row.posting_parent),
      economic_parent_proven: row.economic_parent_proven === true,
      presentation_parent_match: row.presentation_parent_match === true,
      economic_parent_match: row.economic_parent_match === true,
      posting_parent_proven: row.posting_parent_proven === true,
      evidence_category: normalizeText(row.evidence_category),
      evidence_severity: normalizeText(row.evidence_severity),
      evidence_status: normalizeText(row.evidence_status),
      correction_authority: row.correction_authority === true,
      intalev_source_parent_code: normalizeText(row.intalev_source_parent_code),
      intalev_source_outline_level: Number(row.intalev_source_outline_level ?? 0),
      intalev_source_outline_basis: normalizeText(row.intalev_source_outline_basis),
      intalev_reference_status: normalizeText(row.intalev_reference_status),
      intalev_reference_parent_code: normalizeText(row.intalev_reference_parent_code),
      intalev_reference_outline_level: Number(row.intalev_reference_outline_level ?? 0),
      intalev_reference_path_codes: row.intalev_reference_path_codes ?? [],
      intalev_reference_path_labels: row.intalev_reference_path_labels ?? [],
      intalev_reference_graph_id: normalizeText(row.intalev_reference_graph_id),
      intalev_reference_graph_sha256: normalizeText(
        row.intalev_reference_graph_sha256,
      ),
      intalev_reference_template_sha256: normalizeText(
        row.intalev_reference_template_sha256,
      ),
      intalev_reference_source_sheet: normalizeText(row.intalev_reference_source_sheet),
      intalev_reference_source_row: Number(row.intalev_reference_source_row ?? 0),
      intalev_reference_source_cell: normalizeText(row.intalev_reference_source_cell),
      presentation_parent_code: normalizeText(presentation?.presentation_parent_code),
      presentation_parent_basis: normalizeText(presentation?.presentation_parent_basis),
      presentation_depth: Number(presentation?.presentation_depth ?? 0),
      presentation_source_outline_level: Number(
        presentation?.presentation_source_outline_level ?? 0,
      ),
      presentation_outline_level: Number(presentation?.presentation_outline_level ?? 0),
      presentation_hierarchy_status: normalizeText(
        presentation?.presentation_hierarchy_status,
      ),
      presentation_structural_proof: presentation?.presentation_structural_proof ?? {
        status: "HIERARCHY_UNPROVEN",
        system: "INTALEV",
        erp_used: false,
      },
      hierarchy_has_children: Boolean(row.hierarchy_has_children),
      hierarchy_path:
        Array.isArray(row.hierarchy_path) && row.hierarchy_path.length > 0
          ? row.hierarchy_path
          : [hierarchyGroup, row.intalev_label].filter(Boolean),
      hierarchy_status: normalizeText(row.hierarchy_status),
      hierarchy_period_consistent: Boolean(row.hierarchy_period_consistent),
      intalev_hierarchy_status: normalizeText(row.intalev_hierarchy_status),
      intalev_live_hierarchy_status: normalizeText(
        row.intalev_live_hierarchy_status,
      ),
      erp_binding_status: normalizeText(row.erp_binding_status),
      intalev_label: row.intalev_label,
      erp_label: row.erp_label,
      intalev_amount: intalevAmount,
      erp_amount: erpAmount,
      intalev_group_rollups: row.intalev.presentation_group_rollups ?? [],
      erp_group_rollups: row.erp.presentation_group_rollups ?? [],
      erp_raw_amount: row.erp.raw_amount,
      erp_normalized_amount: row.erp.normalized_amount,
      erp_normalization_status: normalizeText(row.erp.normalization_status),
      erp_normalization_note: normalizeText(row.erp.normalization_note),
      delta,
      comparison_mode: normalizeText(row.comparison_mode),
      covered_by_code: normalizeText(row.covered_by_code),
      owner_presentation_block_exempt: presentationBlockExempt,
      owner_control_only: structuralControl?.control_only === true,
      owner_posting_classification: structuralControl?.posting_classification ?? "",
      structural_group_control_enabled: presentationBlockExempt,
      structural_group_control_set_id:
        structuralControl?.structural_group_control_set_id ?? "",
      structural_control_group_id: structuralControl?.structural_control_group_id ?? "",
      structural_group_control_mode: structuralControl?.mode ?? "",
      structural_group_sum_status: structuralMember?.control?.classification ?? "",
      structural_group_control_sum_delta:
        structuralMember?.control?.control_sum_delta ?? null,
      structural_group_control_tolerance:
        structuralMember?.control?.tolerance ?? null,
      structural_group_descendant_internal_checks_active:
        structuralControl?.descendant_internal_checks_active === true,
      structural_group_control_financial_posting_rows: 0,
      is_discrepancy: isDiscrepancy,
      reconciliation_status: reconciliationStatus,
      intalev_status: row.intalev.status,
      erp_status: row.erp.status,
      erp_parent_detail_control: row.erp.parent_detail_control ?? null,
      technical_status: isInformational
        ? "INFORMATIONAL_COVERED"
        : presentationBlockExempt
          ? reconciliationStatus
          : mappingProblem
            ? "REQUIRES_CLARIFICATION"
            : "READY_FOR_ANALYSIS",
      default_include_in_task: isDiscrepancy,
      default_decision: isInformational
        ? "NOT_APPLICABLE"
        : isDiscrepancy
          ? "PROCESS"
          : "NOT_APPLICABLE",
      intalev_paths: intalevPaths,
      erp_paths: erpPaths,
      erp_catalog_paths: erpCatalogPaths,
      cfo,
      departments,
      organizational_dimensions_by_role: { cfo, department: departments },
      dimensions_used_for_identity: true,
      dimensions_not_posting_axis: true,
      ...projectDecisionContract(decision),
      ...sourceScopeContract,
      amount_presence: normalizeText(decision?.amount_presence),
      article_classification: normalizeText(decision?.article_classification),
      normalized_delta: decision?.normalized_delta ?? null,
      raw_delta: structuralMember?.member?.raw_delta ?? decision?.raw_delta ?? null,
      erp_literal: erpAmount,
      proven_mapping_adjustment: provenMappingAdjustment,
      mapping_proof_status: erpHierarchyBindingProof
        ? "BINDING_REPAIR_PROVEN"
        : hasProvenMapping ? "REPORT_SOURCE_PROVEN" : "",
      mapping_decision_type: erpHierarchyBindingProof ? "UPDATE_MAPPING" : "",
      erp_hierarchy_binding_proof: erpHierarchyBindingProof,
      journal_operation_proof_status: hasProvenMapping ? "UNPROVEN" : "",
      erp_effective_after_proven_mapping: hasProvenMapping
        ? (typeof erpAmount === "number"
          ? roundMoney(erpAmount + provenMappingAdjustment)
          : null)
        : erpAmount,
      effective_delta: structuralMember?.member?.effective_delta
        ?? (hasProvenMapping ? decisionEffectiveDelta : decision?.effective_delta ?? null),
      structural_control_effective_delta:
        structuralMember?.member?.effective_delta ?? null,
      source_amount_present: decision?.source_amount_present ?? null,
      binding_candidate: decision?.binding_candidate ?? null,
      accounts,
      article_codes: articleCodes,
      intalev_sources: traceSources(intalevTrace),
      // Preserve the exact evidence shape for downstream R005 re-evaluation;
      // do not force the routing layer to rediscover source rows or bindings.
      source_rows: traceSources(intalevTrace),
      binding_candidates: Array.isArray(row.erp.binding_candidates)
        ? row.erp.binding_candidates
        : [],
      intalev_identity_evidence: row.intalev.intalev_identity_evidence ?? [],
      erp_sources: traceSources(erpTrace),
      // Physical source proof remains a separate evidence layer. Preserve the
      // exact operation rows here so the generic detector can verify amount,
      // organization and month without promoting physical proof by itself.
      operation_evidence_rows: operationEvidenceRows,
      erp_normalization_sources: traceSources(
        deduplicateTrace(row.erp.normalization_trace ?? []),
      ),
      d04_catalog_proof: row.erp.d04_catalog_proof ?? null,
      r064_zero_proof: row.intalev.r064_zero_proof ?? null,
      r021_source_control: row.intalev.r021_source_control ?? null,
      ...posting,
      ...(presentationBlockExempt
        ? {
            financial_rows: 0,
            posting_allowed: false,
            execution_allowed: false,
          }
        : {}),
      monthly: monthlyDetails,
    };
  });

  const economicRouteProofBinding = bindEconomicRouteProofs(unboundRows, {
    organization,
    period: periodLabel,
    document: economicRouteProofDocument,
    tolerance,
  });
  const rows = economicRouteProofBinding.rows;
  const ownerEconomicIntragroupConfirmations = (
    economicRouteProofDocument?.intragroup_confirmations ?? []
  ).filter((confirmation) =>
    normalizeText(confirmation.organization) === normalizeText(organization)
      && normalizeText(confirmation.period) === normalizeText(periodLabel))
    .map((confirmation) => ({
      confirmation_id: confirmation.confirmation_id,
      organization: confirmation.organization,
      period: confirmation.period,
      run_id: confirmation.run_id,
      authority_ref: confirmation.authority_ref,
      evidence_ref: confirmation.evidence_ref,
      proof_input_sha256: confirmation.proof_input_sha256,
      intergroup_route_id: confirmation.intergroup_route_id,
      root_code: confirmation.root_code,
      descendant_codes: [...confirmation.descendant_codes],
      descendant_member_set_sha256: confirmation.descendant_member_set_sha256,
      economic_status: confirmation.economic_status,
      exact_allocation_status: confirmation.exact_allocation_status,
      physical_erp_status: confirmation.physical_erp_status,
    }));
  const discrepancyCount = rows.filter((row) => row.is_discrepancy).length;
  const hierarchyPeriods = monthly.map((month) => {
    const erpBindingCounts = { PROVEN: 0, UNPROVEN: 0, MISMATCH: 0 };
    for (const row of month.rows ?? []) {
      const status = normalizeText(row.erp_binding_status);
      if (Object.hasOwn(erpBindingCounts, status)) erpBindingCounts[status] += 1;
    }
    const erpTree = compactHierarchyTreeForCodex(month.erp_hierarchy_tree);
    const intalevTree = compactHierarchyTreeForCodex(month.intalev_hierarchy_tree);
    const sourceHierarchyStatus =
      erpTree?.status === "PASS" && intalevTree?.status === "PASS"
        ? "PASS"
        : "BLOCKED";
    return {
      period: month.period,
      status: month.hierarchy?.status ?? "BLOCKED",
      source_hierarchy_status: sourceHierarchyStatus,
      intalev_hierarchy_status: (month.rows ?? []).every(
        (row) => normalizeText(row.intalev_hierarchy_status) === "PROVEN",
      ) ? "PROVEN" : "UNPROVEN",
      erp_binding_status_counts: erpBindingCounts,
      blockers: month.hierarchy?.blockers ?? [],
      erp_tree: erpTree,
      intalev_tree: intalevTree,
      intalev_catalog_tree: compactHierarchyTreeForCodex(month.intalev_catalog_tree),
      template_graph: compactTemplateGraphForCodex(month.hierarchy?.template_graph),
    };
  });
  const hierarchyBlockerCount = hierarchyPeriods.reduce(
    (count, item) => count + item.blockers.length,
    0,
  );
  const intalevHierarchyBlockerCount = hierarchyPeriods.reduce(
    (count, item) =>
      count +
      (item.intalev_tree?.blockers?.length ?? 0) +
      (item.intalev_catalog_tree?.blockers?.length ?? 0),
    0,
  );
  const intalevCatalogMissing = hierarchyPeriods.some((item) =>
    item.blockers.some(
      (blocker) => blocker.code === "BLOCKED_INTALEV_CATALOG_NOT_EXPORTED",
    ),
  );
  const expectedCodes = Array.from(
    { length: 65 },
    (_, index) => `R${String(index + 1).padStart(3, "0")}`,
  );
  const exactCodeSet =
    rows.length === expectedCodes.length &&
    rows.every((row, index) => row.code === expectedCodes[index]);
  const hierarchyLevels = [
    ...new Set(rows.map((row) => row.presentation_source_outline_level)),
  ];
  const nonRootRows = rows.filter(
    (row) => row.presentation_source_outline_level > 0,
  );
  const intalevHierarchyGraphValidated =
    exactCodeSet &&
    hierarchyLevels.length > 1 &&
    nonRootRows.length > 0 &&
    nonRootRows.every((row) => row.presentation_parent_code) &&
    rows.some((row) =>
      rows.some((candidate) => candidate.presentation_parent_code === row.code),
    ) &&
    rows.every((row) => row.intalev_hierarchy_status === "PROVEN") &&
    rows.every(
      (row) =>
        row.presentation_hierarchy_status === "HIERARCHY_PROVEN" &&
        ["PROVEN_LIVE_INTALEV", "PROVEN_APPROVED_TEMPLATE_GRAPH"].includes(
          row.presentation_structural_proof?.status,
        ) &&
        row.presentation_structural_proof?.erp_used !== true,
    ) &&
    rows.every((row) => row.hierarchy_period_consistent);
  // Keep the legacy financial gate fail-closed on every source blocker. The
  // separate Intalev flag is presentation structure only and grants no new
  // correction or operation authority.
  const hierarchyGraphValidated =
    hierarchyBlockerCount === 0 &&
    intalevHierarchyGraphValidated;
  const hierarchyStatus = intalevCatalogMissing
    ? "BLOCKED_INTALEV_CATALOG_NOT_EXPORTED"
    : hierarchyGraphValidated
      ? "PASS"
      : "BLOCKED_HIERARCHY_METADATA_MISSING";
  const zeroSumGroupStornoRepost = assessZeroSumHierarchyGroups(rows, {
    hierarchy_graph_validated: hierarchyGraphValidated,
    tolerance,
    structural_control_groups: closedStructuralControlGroups,
  });
  const periodRows = includePeriodRows
    ? monthly.map((month) => {
        const periodPayload = buildCodexInputPayload({
          organization,
          profile,
          machinePolicy,
          mode: "month",
          periodLabel: month.period,
          periods: [month.period],
          aggregateRows: month.rows,
          // Presentation structure is a period-invariant catalog contract.
          // Financial values and exact traces still come only from month.rows.
          presentationRows,
          monthly: [month],
          outputPath,
          outputSha256,
          generatedAt,
          tolerance,
          referenceCatalogs,
          referenceCatalogTrace,
          sourceProvenance,
          intalevTemplateGraph,
          erpInputAuthority,
          operationEvidence,
          crossJournalEvidence: null,
          economicHierarchyMapping,
          economicRouteProofDocument,
          includePeriodRows: false,
          structuralControlGroups,
        });
        return {
          period: month.period,
          rows: periodPayload.rows,
          intalev_source_scope: periodPayload.intalev_source_scope,
          structural_group_control_results:
            periodPayload.structural_group_control_results ?? [],
          economic_route_proof_binding: periodPayload.economic_route_proof_binding,
        };
      })
    : [];
  // Structural controls are evaluated before any generic candidate pool is
  // built. The evaluator is report-only; only its configured parent members
  // are excluded, while descendants remain eligible for analysis.
  const ownerPresentationControlGroups = periodRows.length > 0
    ? periodRows.flatMap((item) => item.structural_group_control_results ?? [])
    : [...structuralControlResults];
  const genericReclassification = detectGenericReclassifications(
    (periodRows.length > 0 ? periodRows.flatMap((item) => item.rows) : rows)
      .map((row) => ({
        ...row,
        organization: normalizeText(row.organization) || organization,
        period: normalizeText(row.period) || periodLabel,
      })),
    {
      tolerance,
      hierarchy_graph_validated: hierarchyGraphValidated,
      structural_control_groups: structuralControlGroups,
    },
  );
  const visibleGroupDeltaControls = calculateVisibleGroupDeltaResiduals(
    rows,
    tolerance,
  );
  return {
    schema: "opiu-codex-review-input-v1",
    generated_at: generatedAt,
    report_path: outputPath,
    report_sha256: outputSha256,
    output_path: outputPath,
    output_sha256: outputSha256,
    organization,
    organization_code: profile.organizationCode,
    profile_id: profile.id,
    project_rules: profile.projectRules,
    machine_policy: machinePolicy ? r005PolicyTrace(machinePolicy) : null,
    machine_policy_execution: machinePolicy
      ? ["UPDATE_MAPPING", "UPDATE_FORMULA", "STORNO_REPOST"].map((decisionClass) =>
          evaluateR005DecisionClass(machinePolicy, decisionClass),
        )
      : null,
    mode,
    period: periodLabel,
    periods,
    tolerance,
    report_only: true,
    posting_rows: 0,
    executed_posting_rows: 0,
    live_posting_rows: 0,
    execution_allowed: false,
    ready_to_upload: false,
    release_allowed: false,
    live_1c_allowed: false,
    live_delete_allowed: false,
    reference_catalogs: referenceCatalogTrace,
    economic_hierarchy_mapping: economicHierarchyMapping
      ? {
          schema: "opiu-economic-hierarchy-mapping-v1",
          status: "ACTIVE_EXPLICIT_MAPPING",
          entry_count: Array.isArray(economicHierarchyMapping.entries)
            ? economicHierarchyMapping.entries.length
            : 0,
          correction_authority: false,
        }
      : {
          schema: "opiu-economic-hierarchy-mapping-v1",
          status: "MISSING_REVIEW_ONLY",
          entry_count: 0,
          correction_authority: false,
        },
    economic_route_proof_binding: economicRouteProofBinding.audit,
    owner_economic_intragroup_confirmations: ownerEconomicIntragroupConfirmations,
    source_provenance: sourceProvenance,
    ...buildIntalevSourceScopePayloadContract(intalevSourceScopes),
    intalev_reference_graph: intalevTemplateGraph,
    erp_input_authority: erpInputAuthority,
    operation_evidence: operationEvidence,
    cross_journal_discrepancy_evidence: crossJournalEvidence,
    posted_correction_journal_overlays: postedCorrectionJournalOverlays,
    source_driven_expense_coverage: sourceDrivenExpenseCoverage
      ? {
          audit: sourceDrivenExpenseCoverage.audit,
          discovery: sourceDrivenExpenseCoverage.discovery,
          journal_first_attribution:
            sourceDrivenExpenseCoverage.journal_first_attribution ?? null,
          rows: sourceDrivenExpenseCoverage.rows.map((row) => ({
            code: row.code,
            type: row.type,
            parent_code: row.presentation_parent_code,
            depth: row.presentation_depth,
            intalev_label: row.intalev_label,
            erp_label: row.erp_label,
            intalev_amount: row.intalev?.amount ?? null,
            erp_amount: row.erp?.amount ?? null,
            delta: typeof row.intalev?.amount === "number" && typeof row.erp?.amount === "number"
              ? roundMoney(row.intalev.amount - row.erp.amount)
              : null,
            intalev_paths: uniqueTraceValues(row.intalev?.trace ?? [], "full_path"),
            erp_paths: uniqueTraceValues(row.erp?.trace ?? [], "full_path"),
            erp_only_article_row: row.erp_only_article_row === true,
            correction_authority: false,
          })),
        }
      : null,
    default_behavior: "PROCESS_ALL_DISCREPANCIES",
    structural_group_control_sets:
      serializeStructuralControlGroups(structuralControlGroups),
    structural_control_settings_binding: structuralControlSettingsBinding.audit,
    empty_article_binding_settings: (monthly ?? []).map((month) => ({
      period: month.period,
      ...(month?.empty_article_binding_settings ?? {}),
    })),
    empty_article_binding_audit: (monthly ?? []).map((month) => ({
      period: month.period,
      ...(month?.empty_article_binding_audit ?? {}),
    })),
    structural_group_control_results: ownerPresentationControlGroups,
    hierarchy_requested_mode: "FULL_OPIU_ORDER",
    hierarchy_mode: hierarchyGraphValidated ? "FULL_OPIU_ORDER" : "HIERARCHY_BLOCKED",
    hierarchy_status: hierarchyStatus,
    hierarchy_graph_validated: hierarchyGraphValidated,
    intalev_hierarchy_graph_validated: intalevHierarchyGraphValidated,
    zero_sum_group_storno_repost: zeroSumGroupStornoRepost,
    zero_sum_storno_repost_candidates: hierarchyGraphValidated
      ? zeroSumGroupStornoRepost.candidates
      : [],
    generic_reclassification: genericReclassification,
    generic_reclassification_candidates: genericReclassification.candidates,
    visible_group_delta_controls: visibleGroupDeltaControls,
    owner_presentation_control_groups: ownerPresentationControlGroups,
    hierarchy_validation: {
      graph_id: "R001-R065-source-binding-20260801",
      exact_code_set: exactCodeSet,
      source_levels: hierarchyLevels,
      non_root_nodes: nonRootRows.length,
      non_root_nodes_with_parent: nonRootRows.filter(
        (row) => row.hierarchy_parent_node_id,
      ).length,
      nodes_with_children: rows.filter((row) => row.hierarchy_has_children).length,
      periods_consistent: rows.every((row) => row.hierarchy_period_consistent),
      r_codes_are_hierarchy_source: false,
    },
    hierarchy_blocker_count: hierarchyBlockerCount,
    intalev_hierarchy_blocker_count: intalevHierarchyBlockerCount,
    erp_binding_status_counts: rows.reduce(
      (counts, row) => {
        if (Object.hasOwn(counts, row.erp_binding_status)) {
          counts[row.erp_binding_status] += 1;
        }
        return counts;
      },
      { PROVEN: 0, UNPROVEN: 0, MISMATCH: 0 },
    ),
    hierarchy_periods: hierarchyPeriods,
    period_rows: periodRows,
    organizational_dimensions_mode: "ROLE_BOUND_CFO_DEPARTMENT",
    organizational_dimensions_optional: false,
    hierarchy_rows: rows.length,
    discrepancy_rows: discrepancyCount,
    rows,
    decision_engine: {
      schema: decisionPlan.schema,
      decision_priority: decisionPlan.decision_priority,
      internal_reclass_candidates: decisionPlan.internal_reclass_candidates,
      cross_branch_reclass_candidates: decisionPlan.cross_branch_reclass_candidates,
      binding_repairs: decisionPlan.binding_repairs.map((item) => ({
        row_id: item.row_id,
        classification: item.classification,
        binding_status: item.binding_status,
        effective_delta: item.effective_delta,
      })),
      empty_article_sources: decisionPlan.empty_article_sources.map((item) => ({
        row_id: item.row_id,
        source_amount_present: item.source_amount_present,
        article_classification: item.article_classification,
      })),
      financial_correction_candidates: decisionPlan.financial_correction_candidates.map((item) => ({
        row_id: item.row_id,
        effective_delta: item.effective_delta,
        proof_status: item.proof_status,
      })),
      safety: decisionPlan.safety,
    },
  };
}

function directChildren(nodes, parentIndex) {
  const parent = nodes[parentIndex];
  const result = [];
  for (let index = parentIndex + 1; index < nodes.length; index += 1) {
    const candidate = nodes[index];
    if (candidate.level <= parent.level) break;
    if (candidate.level === parent.level + 1) result.push(index);
  }
  return result;
}

function validatePresentationOutlineRows(rows) {
  const levels = rows.map((row) => Number(row.presentation_outline_level));
  for (let index = 0; index < levels.length; index += 1) {
    const level = levels[index];
    if (!Number.isInteger(level) || level < 0 || level > 7) {
      fail(`Недопустимый outlineLevel ОПИУ: ${rows[index].code}=${level}.`);
    }
  }
  if (Math.max(...levels) < 1) {
    fail("Иерархическое представление ОПИУ получилось плоским.");
  }
  return levels;
}

function expandHierarchyWithOperations(
  presentationRows,
  financialOutlineLevels,
  operationEvidence,
) {
  return buildOperationTreePresentation({
    presentationRows,
    financialOutlineLevels,
    operationEvidence,
    normalize: normalizeText,
    fail,
  });
}

function expandHierarchyWithBlankArticleRows(treePresentation, monthlyRows) {
  const scopesByOwner = new Map();
  for (const month of monthlyRows ?? []) {
    for (const scope of month?.blank_article_reporting?.display_scopes ?? []) {
      const ownerCode = normalizeText(scope?.owner_code);
      if (!ownerCode || !Number.isFinite(Number(scope?.blank_amount))) continue;
      if (!scopesByOwner.has(ownerCode)) scopesByOwner.set(ownerCode, []);
      scopesByOwner.get(ownerCode).push({ ...scope, period: month.period });
    }
  }
  const displayRows = [];
  const outlineLevels = [];
  const sourceRows = treePresentation?.displayRows ?? [];
  const sourceLevels = treePresentation?.outlineLevels ?? [];
  sourceRows.forEach((displayRow, index) => {
    const level = Number(sourceLevels[index] ?? 0);
    displayRows.push(displayRow);
    outlineLevels.push(level);
    if (displayRow?.kind !== "FINANCIAL") return;
    const ownerCode = normalizeText(displayRow?.financial?.code);
    const scopes = scopesByOwner.get(ownerCode) ?? [];
    for (const scope of scopes) {
      const branchLevel = Math.min(7, level + 1);
      displayRows.push({ kind: "EMPTY_ARTICLE_BRANCH", scope });
      outlineLevels.push(branchLevel);
      for (const item of scope?.items ?? []) {
        const relative = Math.max(1, Number(item?.source_scope_relative_level ?? 1));
        displayRows.push({ kind: "EMPTY_ARTICLE_DETAIL", scope, item });
        outlineLevels.push(Math.min(7, branchLevel + relative));
      }
    }
  });
  return { displayRows, outlineLevels };
}

function expandHierarchyWithGroupDeltaResiduals(
  treePresentation,
  presentationRows,
  tolerance,
) {
  const controlsByCode = new Map(
    calculateVisibleGroupDeltaResiduals(presentationRows, tolerance)
      .filter((control) => control.display_residual)
      .map((control) => [control.code, control]),
  );
  const displayRows = [];
  const outlineLevels = [];
  const sourceRows = treePresentation?.displayRows ?? [];
  const sourceLevels = treePresentation?.outlineLevels ?? [];
  sourceRows.forEach((displayRow, index) => {
    const level = Number(sourceLevels[index] ?? 0);
    displayRows.push(displayRow);
    outlineLevels.push(level);
    if (displayRow?.kind !== "FINANCIAL") return;
    const control = controlsByCode.get(normalizeText(displayRow?.financial?.code));
    if (!control) return;
    displayRows.push({
      kind: "GROUP_DELTA_RESIDUAL",
      financial: displayRow.financial,
      control,
    });
    outlineLevels.push(Math.min(7, level + 1));
  });
  return { displayRows, outlineLevels };
}

function decodeXmlEntities(value) {
  return String(value ?? "")
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&amp;/g, "&");
}

export async function patchWorksheetOutline({
  outputPath,
  sheetName,
  dataStartRow,
  outlineLevels,
  rowKinds,
  activeTabIndex,
  freezeRows = 0,
  freezeColumns = 0,
}) {
  if (!Array.isArray(rowKinds) || rowKinds.length !== outlineLevels.length) {
    fail(
      `Группировка листа ${sheetName}: типы строк не совпадают с outlineLevels ` +
        `(${Array.isArray(rowKinds) ? rowKinds.length : "MISSING"}/${outlineLevels.length}).`,
    );
  }
  const zip = await JSZip.loadAsync(await fs.readFile(outputPath));
  const workbookXmlPath = "xl/workbook.xml";
  const workbookRelsPath = "xl/_rels/workbook.xml.rels";
  let workbookXml = await zip.file(workbookXmlPath)?.async("string");
  const workbookRelsXml = await zip.file(workbookRelsPath)?.async("string");
  if (!workbookXml || !workbookRelsXml) {
    fail("Не найдены workbook.xml или workbook.xml.rels для группировки отчёта.");
  }

  const sheetTags = [
    ...workbookXml.matchAll(/<(?:[A-Za-z0-9_]+:)?sheet\b[^>]*\/?\s*>/g),
  ].map((match) => match[0]);
  const sheetTag = sheetTags.find((tag) => {
    const name = /\bname="([^"]+)"/.exec(tag)?.[1];
    return decodeXmlEntities(name) === sheetName;
  });
  if (!sheetTag) fail(`Лист ${sheetName} не найден в workbook.xml.`);

  const relationshipId = /\br:id="([^"]+)"/.exec(sheetTag)?.[1];
  if (!relationshipId) fail(`У листа ${sheetName} отсутствует r:id.`);
  const relationshipTags = [
    ...workbookRelsXml.matchAll(
      /<(?:[A-Za-z0-9_]+:)?Relationship\b[^>]*\/?\s*>/g,
    ),
  ].map((match) => match[0]);
  const relationshipTag = relationshipTags.find(
    (tag) => /\bId="([^"]+)"/.exec(tag)?.[1] === relationshipId,
  );
  const relationshipTarget = relationshipTag
    ? /\bTarget="([^"]+)"/.exec(relationshipTag)?.[1]
    : undefined;
  if (!relationshipTarget) {
    fail(`Связь ${relationshipId} для листа ${sheetName} не найдена.`);
  }
  const target = relationshipTarget.replace(/^\//, "").replace(/^\.\//, "");
  const sheetXmlPath = target.startsWith("xl/")
    ? target
    : path.posix.join("xl", target);
  let sheetXml = await zip.file(sheetXmlPath)?.async("string");
  if (!sheetXml) fail(`XML листа ${sheetName} не найден: ${sheetXmlPath}.`);

  if (/\bactiveTab="\d+"/.test(workbookXml)) {
    workbookXml = workbookXml.replace(
      /\bactiveTab="\d+"/,
      `activeTab="${activeTabIndex}"`,
    );
  } else if (/<(?:[A-Za-z0-9_]+:)?workbookView\b/.test(workbookXml)) {
    workbookXml = workbookXml.replace(
      /<((?:[A-Za-z0-9_]+:)?workbookView)\b([^>]*)\/?\s*>/,
      (match, tag, attrs) =>
        match.endsWith("/>")
          ? `<${tag}${attrs} activeTab="${activeTabIndex}"/>`
          : `<${tag}${attrs} activeTab="${activeTabIndex}">`,
    );
  } else {
    const workbookPrefix = /<([A-Za-z0-9_]+:)workbook\b/.exec(workbookXml)?.[1] ?? "";
    workbookXml = workbookXml.replace(
      new RegExp(`(<${workbookPrefix.replace(":", "\\:")}workbook[^>]*>)`),
      `$1<${workbookPrefix}bookViews><${workbookPrefix}workbookView activeTab="${activeTabIndex}"/></${workbookPrefix}bookViews>`,
    );
  }
  zip.file(workbookXmlPath, workbookXml);

  const worksheetPrefix = /<([A-Za-z0-9_]+:)worksheet\b/.exec(sheetXml)?.[1] ?? "";
  const escapedPrefix = worksheetPrefix.replace(":", "\\:");
  const outlinePr = `<${worksheetPrefix}outlinePr summaryBelow="0" summaryRight="1"/>`;
  const sheetPrSelfClosing = new RegExp(`<${escapedPrefix}sheetPr\\s*/>`);
  const sheetPrOpen = new RegExp(`<${escapedPrefix}sheetPr([^>]*)>`);
  if (sheetPrSelfClosing.test(sheetXml)) {
    sheetXml = sheetXml.replace(
      sheetPrSelfClosing,
      `<${worksheetPrefix}sheetPr>${outlinePr}</${worksheetPrefix}sheetPr>`,
    );
  } else if (sheetPrOpen.test(sheetXml)) {
    sheetXml = sheetXml.replace(sheetPrOpen, (match, attrs) => {
      if (new RegExp(`<${escapedPrefix}outlinePr\\b`).test(sheetXml)) return match;
      return `<${worksheetPrefix}sheetPr${attrs}>${outlinePr}`;
    });
  } else {
    sheetXml = sheetXml.replace(
      new RegExp(`(<${escapedPrefix}worksheet[^>]*>)`),
      `$1<${worksheetPrefix}sheetPr>${outlinePr}</${worksheetPrefix}sheetPr>`,
    );
  }

  const maxOutlineLevel = Math.max(0, ...outlineLevels);
  const sheetFormatRegex = new RegExp(
    `<${escapedPrefix}sheetFormatPr([^>]*)/>`,
  );
  if (sheetFormatRegex.test(sheetXml)) {
    sheetXml = sheetXml.replace(sheetFormatRegex, (match, attrs) => {
      const cleaned = attrs.replace(/\soutlineLevelRow="\d+"/g, "");
      return `<${worksheetPrefix}sheetFormatPr${cleaned} outlineLevelRow="${maxOutlineLevel}"/>`;
    });
  } else {
    const sheetDataTag = new RegExp(`<${escapedPrefix}sheetData\b`);
    sheetXml = sheetXml.replace(
      sheetDataTag,
      `<${worksheetPrefix}sheetFormatPr outlineLevelRow="${maxOutlineLevel}"/><${worksheetPrefix}sheetData`,
    );
  }

  const sheetViewSelfClosing = new RegExp(`<${escapedPrefix}sheetView([^>]*)/>`);
  const sheetViewOpen = new RegExp(`<${escapedPrefix}sheetView([^>]*)>`);
  const patchSheetView = (attrs) => {
    const cleaned = attrs
      .replace(/\sshowOutlineSymbols="[01]"/g, "")
      .replace(/\stabSelected="[01]"/g, "");
    return `<${worksheetPrefix}sheetView${cleaned} showOutlineSymbols="1" tabSelected="1">`;
  };
  const paneAttributes = [
    freezeColumns > 0 ? `xSplit="${freezeColumns}"` : "",
    freezeRows > 0 ? `ySplit="${freezeRows}"` : "",
    `topLeftCell="${columnName(freezeColumns + 1)}${freezeRows + 1}"`,
    'activePane="bottomRight"',
    'state="frozen"',
  ].filter(Boolean).join(" ");
  const paneXml = `<${worksheetPrefix}pane ${paneAttributes}/>`;
  sheetXml = sheetXml.replace(
    new RegExp(`<${escapedPrefix}pane\b[^>]*/>`, "g"),
    "",
  );
  if (sheetViewSelfClosing.test(sheetXml)) {
    sheetXml = sheetXml.replace(
      sheetViewSelfClosing,
      (match, attrs) => `${patchSheetView(attrs)}${paneXml}</${worksheetPrefix}sheetView>`,
    );
  } else if (sheetViewOpen.test(sheetXml)) {
    sheetXml = sheetXml.replace(
      sheetViewOpen,
      (match, attrs) => `${patchSheetView(attrs)}${paneXml}`,
    );
  } else {
    const sheetViewsXml = `<${worksheetPrefix}sheetViews><${worksheetPrefix}sheetView workbookViewId="0" showOutlineSymbols="1" tabSelected="1">${paneXml}</${worksheetPrefix}sheetView></${worksheetPrefix}sheetViews>`;
    sheetXml = sheetXml.replace(
      new RegExp(`(<${escapedPrefix}worksheet[^>]*>)`),
      `$1${sheetViewsXml}`,
    );
  }

  let patchedRows = 0;
  outlineLevels.forEach((level, index) => {
    const rowNumber = dataStartRow + index;
    const isOperation = rowKinds[index] === "OPERATION";
    const nextIsChildOperation =
      rowKinds[index + 1] === "OPERATION" &&
      Number(outlineLevels[index + 1]) > Number(level);
    const rowRegex = new RegExp(
      `<${escapedPrefix}row([^>]*\\br="${rowNumber}"[^>]*)>`,
    );
    sheetXml = sheetXml.replace(rowRegex, (match, attrs) => {
      patchedRows += 1;
      let cleaned = attrs
        .replace(/\soutlineLevel="\d+"/g, "")
        .replace(/\shidden="[01]"/g, "")
        .replace(/\scollapsed="[01]"/g, "");
      cleaned += ` outlineLevel="${level}"`;
      if (isOperation) cleaned += ' hidden="1"';
      if (nextIsChildOperation) cleaned += ' collapsed="1"';
      return `<${worksheetPrefix}row${cleaned}>`;
    });
  });
  if (patchedRows !== outlineLevels.length) {
    fail(
      `Группировка листа ${sheetName}: обработано ${patchedRows} строк из ${outlineLevels.length}.`,
    );
  }

  zip.file(sheetXmlPath, sheetXml);
  const patchedBytes = await zip.generateAsync({
    type: "nodebuffer",
    compression: "DEFLATE",
    compressionOptions: { level: 6 },
  });
  const temporaryPath = `${outputPath}.outline-${process.pid}.tmp`;
  await fs.writeFile(temporaryPath, patchedBytes);
  await fs.rename(temporaryPath, outputPath);
}

async function buildReportWorkbook(context) {
  const {
    organization,
    structuralInventoryScope,
    articleApprovalDocument,
    articleApprovalScope,
    profile,
    machinePolicy,
    mode,
    periodLabel,
    periods,
    snapshot,
    aggregateRows: sourceAggregateRows,
    monthly,
    intalevParsed,
    erpParsed,
    erpCatalog,
    intalevCatalog,
    referenceCatalogs,
    referenceCatalogTrace,
    sourceProvenance,
  intalevTemplateGraph,
  erpInputAuthority,
  operationEvidence,
  crossJournalEvidence,
  postedCorrectionJournalOverlays,
  economicHierarchyMapping,
  economicRouteProofDocument,
  outputPath,
    workDir,
    render,
  } = context;
  let aggregateRows = (sourceAggregateRows ?? []).map((row) => ({ ...row }));
  if (articleApprovalDocument) {
    aggregateRows = applyArticleApprovalRules(
      aggregateRows,
      articleApprovalDocument,
      articleApprovalScope,
    );
  }
  const tolerance = Number(config.tolerance ?? 0.01);
  const intalevSourceScopes = intalevParsed
    .map((parsed) => parsed?.source_scope_diagnostics)
    .filter(Boolean);
  const corePresentationRows = attachCanonicalBindingStatuses(
    buildHierarchyPresentationRows(aggregateRows),
  );
  const sourceDrivenExpenseCoverage = buildSourceDrivenExpensePresentationRows({
    coreRows: corePresentationRows,
    intalevParsed,
    erpParsed,
  });
  console.log(
    `SOURCE_DRIVEN_EXPENSE_COVERAGE_JSON=${JSON.stringify({
      blocks: sourceDrivenExpenseCoverage.audit,
      discovery: sourceDrivenExpenseCoverage.discovery,
      rows: sourceDrivenExpenseCoverage.rows.length,
      correction_authority: false,
      posting_rows: 0,
    })}`,
  );
  const basePresentationRows = insertSourceDrivenExpenseRows(
    corePresentationRows,
    sourceDrivenExpenseCoverage.rows,
  );
  const journalFirstAttribution = applyJournalFirstPresentationAttribution(
    basePresentationRows,
    crossJournalEvidence,
  );
  const presentationRows = journalFirstAttribution.rows;
  sourceDrivenExpenseCoverage.journal_first_attribution = {
    audit: journalFirstAttribution.audit,
    structure_bindings: journalFirstAttribution.structure_bindings,
    parent_rollups: journalFirstAttribution.parent_rollups,
    applied: journalFirstAttribution.applied,
    unresolved: journalFirstAttribution.unresolved,
  };
  console.log(
    `JOURNAL_FIRST_PRESENTATION_JSON=${JSON.stringify(sourceDrivenExpenseCoverage.journal_first_attribution)}`,
  );
  const reportStructuralControlResults = /^\d{4}-(0[1-9]|1[0-2])$/.test(periodLabel)
    ? assessConfiguredStructuralControlGroups(
      presentationRows.map((row) => ({
        ...row,
        organization,
        period: periodLabel,
        intalev_amount: row?.intalev?.amount ?? row?.intalev_amount,
        erp_amount: row?.erp?.amount ?? row?.erp_amount,
      })),
      {
        organization,
        period: periodLabel,
        groups: activeStructuralControlGroups,
      },
    )
    : monthly.flatMap((month) =>
      assessConfiguredStructuralControlGroups(
        (month?.rows ?? []).map((row) => ({
          ...row,
          organization,
          period: month.period,
          intalev_amount: row?.intalev?.amount ?? row?.intalev_amount,
          erp_amount: row?.erp?.amount ?? row?.erp_amount,
        })),
        {
          organization,
          period: month.period,
          groups: activeStructuralControlGroups,
        },
      ));
  const reportControlsBySet = new Map();
  for (const control of reportStructuralControlResults) {
    const controlSetId = normalizeText(control?.control_set_id);
    if (!controlSetId) continue;
    if (!reportControlsBySet.has(controlSetId)) reportControlsBySet.set(controlSetId, []);
    reportControlsBySet.get(controlSetId).push(control);
  }
  const reportClosedStructuralControlGroups = activeStructuralControlGroups.filter((group) => {
    const controls = reportControlsBySet.get(normalizeText(group?.group_id ?? group?.id)) ?? [];
    return controls.length > 0
      && controls.every((control) => control?.classification === "STRUCTURAL_GROUP_SUM_OK");
  });
  const decisionInput = {
    rows: decideReconciliationPipelineRows({
      rows: aggregateRows,
      tolerance,
      structural_control_groups: reportClosedStructuralControlGroups,
    }).rows.map((item) => ({
      ...item,
      code: item.row_id,
      ...projectDecisionContract(item),
    })),
  };
  const templateHash = sourceProvenance.template.sha256_after;
  const rulesPath = path.resolve(profile.rulesPath);
  const rulesHash = sourceProvenance.rules.sha256_after;
  const generatedAt = new Date().toISOString();
  const visibleGroupDeltaControlsForReport =
    calculateVisibleGroupDeltaResiduals(presentationRows, tolerance);
  const visibleGroupDeltaControlByCode = new Map(
    visibleGroupDeltaControlsForReport.map((control) => [control.code, control]),
  );
  const financialOutlineLevels = validatePresentationOutlineRows(presentationRows);
  const treePresentation = expandHierarchyWithOperations(
    presentationRows,
    financialOutlineLevels,
    operationEvidence,
  );
  const treePresentationWithDeltaResiduals =
    expandHierarchyWithGroupDeltaResiduals(
      treePresentation,
      presentationRows,
      tolerance,
    );
  const treePresentationWithBlankArticles = expandHierarchyWithBlankArticleRows(
    treePresentationWithDeltaResiduals,
    monthly,
  );
  const treeDisplayRows = treePresentationWithBlankArticles.displayRows;
  const treeOutlineLevels = treePresentationWithBlankArticles.outlineLevels;
  const primaryCodeByIntalevNode = new Map();
  for (const item of treeDisplayRows) {
    if (item.kind !== "FINANCIAL") continue;
    const nodeId = normalizeText(item.financial?.hierarchy_node_id);
    const code = normalizeText(item.financial?.code);
    if (nodeId && code && !primaryCodeByIntalevNode.has(nodeId)) {
      primaryCodeByIntalevNode.set(nodeId, code);
    }
  }

  function intalevBusinessLabel(row) {
    if (row?.blank_article_binding) {
      return "<пустая статья Инталев>";
    }
    const adjustment = Number(row?.intalev_reporting_adjustment ?? 0);
    if (row?.intalev_all_in_reporting) {
      return `${row.intalev_label} — all-in, включая пустые статьи`;
    }
    if (Math.abs(adjustment) > tolerance) {
      return `${row.intalev_label} — включая пустую статью ${adjustment.toLocaleString("ru-RU", {
        minimumFractionDigits: 2,
        maximumFractionDigits: 2,
      })}`;
    }
    return row?.intalev_label;
  }

  function isActualIntalevExpenseBlock(row) {
    const hierarchyPath = Array.isArray(row?.hierarchy_path)
      ? row.hierarchy_path.map(normalizeText).filter(Boolean)
      : [];
    const normalizedPath = hierarchyPath.map((item) => item
      .toLocaleLowerCase("ru-RU")
      .replace(/ё/g, "е")
      .replace(/^_+/u, "")
      .replace(/\s+/gu, " ")
      .trim());
    const marker = normalizedPath.indexOf("статьи опиу 2025");
    if (marker < 0 || marker !== normalizedPath.length - 2) return false;
    const label = normalizeText(row?.intalev_label || hierarchyPath.at(-1))
      .toLocaleLowerCase("ru-RU")
      .replace(/ё/g, "е");
    return /расход|затрат|себестоим/u.test(label)
      && !/итого|прибыл|результат|доход|выруч|чистая/u.test(label);
  }

  function intalevPresentationRole(row) {
    if (row?.journal_structure_binding?.status === "PROVEN") {
      return `ВНУТРИ ${normalizeText(row.journal_structure_binding.parent_code)} ПО ЖУРНАЛУ`;
    }
    if (!normalizeText(row?.hierarchy_node_id)) return "НЕТ УЗЛА ИНТАЛЕВ";
    const primaryCode = primaryCodeByIntalevNode.get(
      normalizeText(row.hierarchy_node_id),
    );
    if (primaryCode && primaryCode !== normalizeText(row.code)) {
      return `ДУБЛЬ УЗЛА ${primaryCode}`;
    }
    const parentCode = normalizeText(row?.presentation_parent_code);
    if (parentCode) return `ВНУТРИ ${parentCode}`;
    if (isActualIntalevExpenseBlock(row)) return "БЛОК ИНТАЛЕВ";
    return "СТАТЬЯ / ДЕТАЛЬ ИНТАЛЕВ";
  }

  function intalevPresentationPath(row) {
    return Array.isArray(row?.hierarchy_path)
      ? row.hierarchy_path.map(normalizeText).filter(Boolean).join(" / ")
      : "";
  }

  const workbook = Workbook.create();
  workbook.comments.setSelf({ displayName: "Codex — сверка ОПИУ" });
  const workbookSheets = createMandatoryWorkbookSheets(workbook, {
    periodLabel,
    includeProvenOperations: (operationEvidence?.source_contributor_rows ?? 0) > 0,
  });
  const passport = workbookSheets.get("00_Паспорт");
  const hierarchySheet = workbookSheets.get("01_Сверка_дерево");
  const summary = workbookSheets.get("01_Сверка_ОПИУ");
  const articleApprovalSheet = workbookSheets.get("01_Правила");
  const monthlySheet = workbookSheets.get("02_Помесячно");
  const intalevSheet = workbookSheets.get("03_Инталев_узлы");
  const intalevBlankArticleSheet = workbookSheets.get("03A_Пустые_статьи");
  const erpSheet = workbookSheets.get("04_ERP_статьи");
  const crossJournalSheet = workbookSheets.get("04A_Расхождения_проводок");
  const crossJournalCorrectionSheet = workbookSheets.get("04B_R001_решения");
  const issuesSheet = workbookSheets.get("05_Несопоставленные");
  const sourcesSheet = workbookSheets.get("06_Источники");
  const controlsSheet = workbookSheets.get("07_Контроли");
  const journalCandidatesSheet = workbookSheets.get("08_Операции_журнала");
  const provenOperationsSheet = workbookSheets.get(OPTIONAL_PROVEN_OPERATIONS_SHEET_NAME) ?? null;

  for (const sheet of workbook.worksheets.items) sheet.showGridLines = false;

  buildPassport();
  const articleApprovalAudit = buildArticleApprovalSheet(articleApprovalSheet, {
    organization,
    organizationId: structuralInventoryScope?.organization_id || profile.organizationCode,
    organizationCode: profile.organizationCode,
    organizationName: organization,
    organizationHierarchyPath: structuralInventoryScope?.organization_path,
    periodLabel,
    aggregateRows,
    monthly,
    erpCatalog,
    sourceProvenance,
    articleApprovalDocument,
  });
  const hierarchyEndRow = buildHierarchyTree();
  const summaryEndRow = buildSummary();
  const monthlyEndRow = buildMonthly();
  const intalevEndRow = buildIntalevNodes();
  const intalevBlankArticleEndRow = buildIntalevBlankArticleDiagnostics();
  const erpEndRow = buildErpRows();
  const crossJournalBuild = buildCrossJournalDiscrepancies();
  const crossJournalEndRow = crossJournalBuild.endRow;
  const crossJournalCorrectionBuild = buildCrossJournalCorrectionDecisions();
  const crossJournalCorrectionEndRow = crossJournalCorrectionBuild.endRow;
  const issuesEndRow = buildIssues();
  const sourcesEndRow = buildSources();
  const controlsEndRow = buildControls();
  const journalCandidatesBuild = buildJournalCandidates();
  const journalCandidatesEndRow = journalCandidatesBuild.endRow;
  const provenOperationsBuild = buildProvenOperations();
  const provenOperationsEndRow = provenOperationsBuild.endRow;
  operationEvidence.workbook_review_sheet = "08_Операции_журнала";
  operationEvidence.workbook_review_rows = journalCandidatesBuild.businessRowCount;
  if (provenOperationsSheet) {
    operationEvidence.workbook_source_proof_sheet = "09_Доказанные_операции";
    operationEvidence.workbook_source_proof_rows = provenOperationsBuild.businessRowCount;
  } else {
    operationEvidence.workbook_source_proof_sheet = null;
    operationEvidence.workbook_source_proof_rows = 0;
  }
  crossJournalEvidence.workbook_sheet = "04A_Расхождения_проводок";
  crossJournalEvidence.workbook_rows = crossJournalBuild.businessRowCount;
  crossJournalEvidence.correction_workbook_sheet = "04B_R001_решения";
  crossJournalEvidence.correction_workbook_rows = crossJournalCorrectionBuild.businessRowCount;

  const preExport = await workbook.inspect({
    kind: "table",
    range: `01_Сверка_ОПИУ!A1:N${Math.min(summaryEndRow, 25)}`,
    include: "values,formulas",
    tableMaxRows: 25,
    tableMaxCols: 14,
    maxChars: 12000,
  });
  const formulaErrors = await workbook.inspect({
    kind: "match",
    searchTerm: "#REF!|#DIV/0!|#VALUE!|#NAME\\?|#N/A",
    options: { useRegex: true, maxResults: 300 },
    summary: "final formula error scan",
  });
  if (hasFormulaErrors(formulaErrors)) {
    fail(
      `В формулах до экспорта найдены ошибки. Диагностика:\n${formulaErrors.ndjson.slice(0, 4000)}`,
    );
  }

  if (render) {
    const previewDir = path.join(workDir, "previews");
    await fs.mkdir(previewDir, { recursive: true });
    const specs = [
      ["00_Паспорт", "A1:D22"],
      ["01_Сверка_дерево", `A1:AD${Math.min(hierarchyEndRow, 28)}`],
      ["01_Сверка_ОПИУ", "A1:R25"],
      ["01_Правила", `A1:U${Math.min(5 + articleApprovalAudit.row_count, 28)}`],
      ["02_Помесячно", `A1:P${Math.min(monthlyEndRow, 28)}`],
      ["03_Инталев_узлы", `A1:M${Math.min(intalevEndRow, 28)}`],
      ["03A_Пустые_статьи", `A1:P${Math.min(intalevBlankArticleEndRow, 28)}`],
      ["04_ERP_статьи", `A1:L${Math.min(erpEndRow, 28)}`],
      ["04A_Расхождения_проводок", `A1:AG${Math.min(crossJournalEndRow, 28)}`],
      ["04B_R001_решения", `A1:BC${Math.min(crossJournalCorrectionEndRow, 24)}`],
      ["05_Несопоставленные", `A1:I${Math.min(issuesEndRow, 28)}`],
      ["06_Источники", `A1:J${Math.min(sourcesEndRow, 24)}`],
      ["07_Контроли", `A1:O${controlsEndRow}`],
      ["08_Операции_журнала", `A1:Q${Math.min(journalCandidatesEndRow, 28)}`],
      ["08_Решения_обоснование", "A1:U5"],
    ];
    if (provenOperationsSheet) {
      specs.push([
        "09_Доказанные_операции",
        `A1:AD${Math.min(provenOperationsEndRow, 28)}`,
      ]);
    }
    for (const [sheetName, range] of specs) {
      const preview = await workbook.render({ sheetName, range, scale: 1, format: "png" });
      await fs.writeFile(
        path.join(previewDir, `${sheetName}.png`),
        new Uint8Array(await preview.arrayBuffer()),
      );
    }
  }

  const output = await SpreadsheetFile.exportXlsx(workbook);
  await output.save(outputPath);
  await patchWorksheetOutline({
    outputPath,
    sheetName: "01_Сверка_дерево",
    dataStartRow: 7,
    outlineLevels: treeOutlineLevels,
    rowKinds: treeDisplayRows.map((row) => row.kind),
    activeTabIndex: 1,
    freezeRows: 6,
    freezeColumns: 3,
  });

  const reopened = await SpreadsheetFile.importXlsx(await FileBlob.load(outputPath));
  const reopenedErrors = await reopened.inspect({
    kind: "match",
    searchTerm: "#REF!|#DIV/0!|#VALUE!|#NAME\\?|#N/A",
    options: { useRegex: true, maxResults: 300 },
    summary: "reopened formula error scan",
  });
  if (hasFormulaErrors(reopenedErrors)) {
    fail(
      `После повторного открытия найдены ошибки формул. Диагностика:\n${reopenedErrors.ndjson.slice(0, 4000)}`,
    );
  }

  const outputSha256 = await sha256File(outputPath);
  const codexInputPath = outputPath.replace(/\.xlsx$/i, ".codex-input.json");
  const codexInput = buildCodexInputPayload({
    organization,
    profile,
    machinePolicy,
    mode,
    periodLabel,
    periods,
    aggregateRows,
    presentationRows,
    monthly,
    outputPath,
    outputSha256,
    generatedAt,
    tolerance,
    referenceCatalogs,
    referenceCatalogTrace,
    sourceProvenance,
    intalevTemplateGraph,
    erpInputAuthority,
    operationEvidence,
    crossJournalEvidence,
    postedCorrectionJournalOverlays,
    sourceDrivenExpenseCoverage,
    economicHierarchyMapping,
    economicRouteProofDocument,
  });
  const structuralInventoryInput = {
    runId: structuralInventoryScope?.run_id,
    contextId: structuralInventoryScope?.context_id,
    organization: {
      id: structuralInventoryScope?.organization_id,
      name: structuralInventoryScope?.organization_name ?? organization,
      path: structuralInventoryScope?.organization_path,
    },
    reconciliationOrganizationName: organization,
    period: periodLabel,
    hierarchyPeriods: codexInput.hierarchy_periods,
    generatedAt,
  };
  const structuralControlInventoryPlan = planStructuralControlInventoryV3(
    structuralInventoryInput,
  );
  codexInput.structural_control_inventory = structuralControlInventoryPlan.audit;
  await fs.writeFile(
    codexInputPath,
    JSON.stringify(codexInput, null, 2),
    "utf8",
  );
  const codexInputSha256 = await sha256File(codexInputPath);

  const manifest = {
    schema: "opiu-auto-reconciliation-run-v3",
    generated_at: generatedAt,
    organization,
    article_approval: articleApprovalAudit,
    organization_code: profile.organizationCode,
    profile_id: profile.id,
    mode,
    period: periodLabel,
    periods,
    project_rules: profile.projectRules,
    machine_policy: machinePolicy ? r005PolicyTrace(machinePolicy) : null,
    machine_policy_execution: machinePolicy
      ? ["UPDATE_MAPPING", "UPDATE_FORMULA", "STORNO_REPOST"].map((decisionClass) =>
          evaluateR005DecisionClass(machinePolicy, decisionClass),
        )
      : null,
    report_only: true,
    posting_rows: 0,
    executed_posting_rows: 0,
    live_posting_rows: 0,
    execution_allowed: false,
    ready_to_upload: false,
    release_allowed: false,
    live_1c_allowed: false,
    live_delete_allowed: false,
    reference_catalogs: referenceCatalogTrace,
    economic_route_proof_binding: codexInput.economic_route_proof_binding,
    source_provenance: sourceProvenance,
    erp_input_authority: erpInputAuthority,
    operation_evidence: operationEvidence,
    cross_journal_discrepancy_evidence: crossJournalEvidence
      ? {
          schema: crossJournalEvidence.schema,
          status: crossJournalEvidence.status,
          applicable: crossJournalEvidence.applicable,
          organization: crossJournalEvidence.organization,
          period: crossJournalEvidence.period,
          sources: crossJournalEvidence.sources,
          counts: crossJournalEvidence.counts,
          gates: crossJournalEvidence.gates,
          workbook_sheet: crossJournalEvidence.workbook_sheet,
          workbook_rows: crossJournalEvidence.workbook_rows,
        }
      : null,
    decision_engine: codexInput?.decision_engine ?? null,
    structural_group_control_sets:
      codexInput?.structural_group_control_sets ?? [],
    structural_control_settings_binding:
      codexInput?.structural_control_settings_binding ?? structuralControlSettingsBinding.audit,
    empty_article_binding_settings:
      codexInput?.empty_article_binding_settings ?? [],
    empty_article_binding_audit:
      codexInput?.empty_article_binding_audit ?? [],
    empty_article_binding_financial_rows: 0,
    empty_article_binding_posting_rows: 0,
    structural_control_inventory: structuralControlInventoryPlan.audit,
    structural_group_control_results:
      codexInput?.structural_group_control_results ?? [],
    structural_group_control_financial_posting_rows: 0,
    intalev_source_scope: codexInput?.intalev_source_scope ?? null,
    intalev_source_scopes: codexInput?.intalev_source_scopes ?? [],
    blank_article_financial_posting_authority: 0,
    blank_article_financial_posting_rows: 0,
    source_contributor_rows: operationEvidence?.source_contributor_rows ?? 0,
    display_operation_rows: operationEvidence?.display_operation_rows ?? 0,
    correction_operation_rows: 0,
    status: profile.status,
    intalev_snapshot_id: snapshot.snapshot_id,
    intalev_source_kind: snapshot.source_kind,
    output_path: outputPath,
    output_sha256: outputSha256,
    codex_input_path: codexInputPath,
    codex_input_sha256: codexInputSha256,
    hierarchy_rows_for_review: codexInput.rows.length,
    discrepancy_rows_for_review: codexInput.rows.filter((row) => row.is_discrepancy).length,
    zero_sum_group_storno_repost: codexInput.zero_sum_group_storno_repost,
    zero_sum_storno_repost_candidate_count:
      codexInput.zero_sum_storno_repost_candidates.length,
    pre_export_inspect: preExport.ndjson,
    formula_error_scan: formulaErrors.ndjson,
    reopened_formula_error_scan: reopenedErrors.ndjson,
  };
  const manifestPath = outputPath.replace(/\.xlsx$/i, ".manifest.json");
  await fs.writeFile(
    manifestPath,
    JSON.stringify(manifest, null, 2),
    "utf8",
  );
  await materializeStructuralControlInventoryV3({
    outputDirectory: path.dirname(outputPath),
    ...structuralInventoryInput,
    currentRunFiles: {
      reportPath: outputPath,
      codexInputPath,
      manifestPath,
    },
  });
  await relocateInspectArtifacts(outputPath);
  return manifest;

  function buildPassport() {
    styleTitle(
      passport,
      "A1:D1",
      `Паспорт автоматической сверки ОПИУ — ${periodLabel}`,
    );
    passport.getRange("A2:D2").merge();
    passport.getRange("A2").values = [[
      snapshot.source_kind === "RUN_SELECTED"
        ? "Инталев и ERP выбраны для текущей сверки; их хэши фиксируются в отчёте. Проводки не формируются."
        : "Инталев зафиксирован снимком; ERP загружается заново. Отчёт диагностический, проводки не формируются.",
    ]];
    passport.getRange("A2:D2").format = {
      fill: colors.yellow,
      font: { bold: true, color: "#9C5700" },
      wrapText: true,
    };
    passport.getRange("A5:D5").values = [[
      "Параметр",
      "Значение",
      "Статус",
      "Пояснение",
    ]];
    styleHeader(passport.getRange("A5:D5"));
    const archiveSourceGate = buildArchiveSourceGateNarrative({
      journalVerified: operationEvidence?.journal_verified === true,
      sources: erpContainerSourceRegistry,
    });
    const rows = [
      ["Организация ERP", organization, "INPUT", "Фильтр текущего ERP."],
      ["Код организации", profile.organizationCode, "INPUT", "Стабильный код отчёта."],
      ["Режим", mode, "INPUT", "month / quarter / year."],
      ["Период", periodLabel, "INPUT", periods.join(", ")],
      ["Месяцы расчёта", periods.length, "PASS", periods.join(", ")],
      ["Профиль источников", profile.id, "ACTIVE", "Определён по выбранным файлам."],
      ["Правила проекта", profile.projectRules, "ACTIVE_FAIL_CLOSED", profile.rulesNote],
      ["SHA-256 шаблона", templateHash, "SOURCE", path.resolve(config.template_path)],
      ["SHA-256 правил", rulesHash, "SOURCE", rulesPath],
      [
        "Источник Инталев",
        snapshot.snapshot_id,
        snapshot.source_kind === "RUN_SELECTED" ? "SELECTED" : "FIXED",
        snapshot.manifest_path,
      ],
      [
        "Инталев проверен",
        snapshot.fixed_at,
        snapshot.source_kind === "RUN_SELECTED" ? "CURRENT_RUN" : "FIXED",
        "Оригиналы не изменяются.",
      ],
      ["Отчёт сформирован", generatedAt, "INFO", "UTC timestamp."],
      ["Допуск", tolerance, "INPUT", "Абсолютная дельта в денежных единицах."],
      ["Корректировки", 0, "REPORT_ONLY", "Скрипт не создаёт проводки."],
      ["ready_to_upload", false, "BLOCKED", "Диагностический отчёт."],
      ["release_allowed", false, "BLOCKED", archiveSourceGate.passportComment],
      ["Итоговый статус", profile.status, "BLOCKED", profile.controlsNote],
      [
        "ERP журнал",
        operationEvidence?.source_trace?.journals?.length === 1
          ? operationEvidence.source_trace.journals[0].path
          : "",
        operationEvidence?.journal_verified === true ? "VERIFIED" : "BLOCKED",
        "Физический журнал текущего запуска; путь используется только внутренним R001 proof reader.",
      ],
      [
        "SHA-256 ERP журнала",
        operationEvidence?.source_trace?.journals?.length === 1
          ? operationEvidence.source_trace.journals[0].sha256
          : "",
        operationEvidence?.journal_verified === true ? "VERIFIED" : "BLOCKED",
        "SHA фактически прочитанного журнала.",
      ],
    ];
    writeValues(passport, 6, 1, rows);
    styleData(passport.getRange(`A6:D${5 + rows.length}`));
    if (/^\d+$/.test(String(snapshot.snapshot_id))) {
      passport.getRange("B15").format.numberFormat = "0";
    }
    passport.getRange("B16:B17").format.numberFormat = "yyyy-mm-dd hh:mm:ss";
    passport.getRange("B18").format.numberFormat = "0.00";
    passport.getRange("B12:B15").format.wrapText = true;
    passport.getRange("D12:D17").format.wrapText = true;
    passport.getRange("D9:D10").format.wrapText = true;
    passport.getRange("A9:D10").format.rowHeight = 34;
    passport.getRange("B20:B22").format.fill = colors.red;
    passport.getRange("D20:D24").format.wrapText = true;
    passport.getRange("A21:D24").format.rowHeight = 42;
    passport.getRange("B21:D21").format = {
      fill: colors.red,
      font: { bold: true, color: "#9C0006" },
    };
    setColumnWidths(passport, [26, 48, 24, 90], 24);
    passport.freezePanes.freezeRows(5);
  }

  function buildHierarchyTree() {
    const dataStartRow = 7;
    const endRow = dataStartRow + treeDisplayRows.length - 1;
    const hierarchyProofPassed = presentationRows.every(
      (row) =>
        row.intalev_hierarchy_status === "PROVEN" &&
        row.presentation_hierarchy_status === "HIERARCHY_PROVEN" &&
        ["PROVEN_LIVE_INTALEV", "PROVEN_APPROVED_TEMPLATE_GRAPH"].includes(
          row.presentation_structural_proof?.status,
        ) &&
        row.presentation_structural_proof?.erp_used !== true,
    );
    const intalevSourcePaths = [
      ...new Set(
        snapshot.files
          .map((file) => file.original_path || file.stored_path)
          .filter(Boolean)
          .map((filePath) =>
            path.isAbsolute(filePath) ? filePath : path.resolve(appDir, filePath),
          ),
      ),
    ];
    const erpSourcePaths = [
      ...new Set(erpParsed.map((item) => item.source_file).filter(Boolean)),
    ];
    const rowDeltas = presentationRows.map((row) =>
      typeof row.intalev.amount === "number" && typeof row.erp.amount === "number"
        ? roundMoney(row.intalev.amount - row.erp.amount)
        : null,
    );
    const hasProblemDescendant = (rowIndex) => {
      const parentLevel = financialOutlineLevels[rowIndex];
      for (let index = rowIndex + 1; index < presentationRows.length; index += 1) {
        if (financialOutlineLevels[index] <= parentLevel) break;
        const delta = rowDeltas[index];
        if (
          delta === null ||
          Math.abs(delta) > tolerance ||
          !acceptedStatus(presentationRows[index].intalev.status) ||
          !acceptedStatus(presentationRows[index].erp.status) ||
          presentationRows[index].erp_binding_status !== "PROVEN"
        ) {
          return true;
        }
      }
      return false;
    };

    styleTitle(
      hierarchySheet,
      "A1:AD1",
      `Сверка ОПИУ — ${organization} — ${periodLabel} — группировки как в ОПИУ`,
    );
    hierarchySheet.getRange("A2:AD2").merge();
    hierarchySheet.getRange("A2").values = [[
      "Дерево строится по фактическому пути из выбранного архива Инталев. Если название статьи ERP отличается от физической строки Инталев, место статьи определяется только по взаимно-уникальной операции двух журналов; сумма ERP при этом не переносится на другую статью. Нераспознанные строки остаются серыми. Полные источники приведены в комментариях и на листах 03_Инталев_узлы / 04_ERP_статьи / 04A_Расхождения_проводок.",
    ]];
    hierarchySheet.getRange("A2:AD2").format = {
      fill: colors.blueLight,
      font: { bold: true, color: "#17365D" },
      wrapText: true,
    };
    hierarchySheet.getRange("A2:AD2").format.rowHeight = 34;
    hierarchySheet.getRange("A3:AD3").merge();
    hierarchySheet.getRange("A3").values = [[
      `ИСТОЧНИКИ: Инталев — ${intalevSourcePaths.join("; ")} | ERP — ${erpSourcePaths.join("; ")}`,
    ]];
    hierarchySheet.getRange("A3:AD3").format = {
      fill: colors.yellow,
      font: { color: "#7F6000" },
      wrapText: true,
    };
    hierarchySheet.getRange("A3:AD3").format.rowHeight = 34;
    hierarchySheet.getRange("A4:AD4").merge();
    hierarchySheet.getRange("A4").values = [[
      [
        hierarchyProofPassed
          ? "Иерархия Инталева доказана текущим прогоном; ERP binding проверяется отдельно."
          : "Показан фактический путь Инталев; неоднозначные сопоставления не назначаются родителями и помечены HIERARCHY_UNPROVEN.",
        `Операции: ${operationEvidence?.status ?? "NOT_APPLICABLE"}; source_contributor_rows=${operationEvidence?.source_contributor_rows ?? 0}; display_operation_rows=${operationEvidence?.display_operation_rows ?? 0}.`,
        "REPORT_ONLY; correction_operation_rows=0; posting_rows=0; ready_to_upload=false; release_allowed=false.",
      ].join(" "),
    ]];
    hierarchySheet.getRange("A4:AD4").format = {
      fill: hierarchyProofPassed ? colors.green : colors.red,
      font: { bold: true, color: hierarchyProofPassed ? "#375623" : "#9C0006" },
      wrapText: true,
    };
    hierarchySheet.getRange("A4:AD4").format.rowHeight = 42;

    const headers = [
      "Код / PairID",
      "Положение в дереве Инталев",
      "Статья ОПИУ / строка источника",
      "Инталев",
      "ERP",
      "Дельта = Инталев − ERP",
      "Статус",
      "Что исправить",
      "Где исправить",
      "Как исправить",
      "Тип строки",
      "Дата",
      "ERP строка",
      "Регистратор / документ",
      "№ проводки",
      "Дт",
      "Аналитики Дт",
      "Подразделение Дт",
      "Кт",
      "Аналитики Кт",
      "Подразделение Кт",
      "Организация",
      "Физическая сумма",
      "STORNO",
      "REPOST",
      "Остаток после кандидата",
      "Источник → цель",
      "Комментарий / доказательство",
      "INTALEV_HIERARCHY",
      "ERP_BINDING",
    ];
    writeValues(hierarchySheet, 6, 1, [headers]);
    styleHeader(hierarchySheet.getRange("A6:AD6"));
    hierarchySheet.getRange("A6:AD6").format.rowHeight = 54;

    const decisionByCode = new Map(
      (decisionInput?.rows ?? []).map((item) => [normalizeText(item.code), item]),
    );

    const decisions = presentationRows.map((row, index) => {
      const delta = rowDeltas[index];
      const engineDecision = decisionByCode.get(normalizeText(row.code));
      const isParent =
        index + 1 < presentationRows.length &&
        financialOutlineLevels[index + 1] > financialOutlineLevels[index];
      const problemBelow = isParent && hasProblemDescendant(index);
      const intalevTrace = traceText(
        "AGG",
        deduplicateTrace(row.intalev.trace),
        2,
        "03_Инталев_узлы",
      );
      const erpTrace = traceText(
        "AGG",
        deduplicateTrace(row.erp.trace),
        2,
        "04_ERP_статьи",
      );
      const where = `Инталев: ${intalevTrace || "НЕ ДОКАЗАНО"} | ERP: ${erpTrace || "НЕ ДОКАЗАНО"}`;
      const groupDeltaControl = visibleGroupDeltaControlByCode.get(
        normalizeText(row.code),
      );

      if (
        groupDeltaControl &&
        typeof delta === "number" &&
        Math.abs(delta) > tolerance
      ) {
        const residualText = Math.abs(groupDeltaControl.residual) > tolerance
          ? ` Нераспределённый по полным дочерним статьям остаток: ${groupDeltaControl.residual.toLocaleString("ru-RU", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}.`
          : " Дельта полностью раскрыта дочерними статьями.";
        return {
          status: Math.abs(groupDeltaControl.residual) > tolerance
            ? "ДЕЛЬТА ГРУППЫ / ЕСТЬ НЕРАСПРЕДЕЛЁННЫЙ ОСТАТОК"
            : "ДЕЛЬТА ГРУППЫ / РАСКРЫТА ПО ДОЧЕРНИМ СТАТЬЯМ",
          what: `Инталев ${row.intalev.amount.toLocaleString("ru-RU", { minimumFractionDigits: 2, maximumFractionDigits: 2 })} − ERP ${row.erp.amount.toLocaleString("ru-RU", { minimumFractionDigits: 2, maximumFractionDigits: 2 })} = ${delta.toLocaleString("ru-RU", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}.${residualText}`,
          where: `Группа ${row.code}; полные дочерние статьи: ${groupDeltaControl.complete_children.map((item) => item.code).join(", ") || "нет"}; неполные дочерние статьи: ${groupDeltaControl.incomplete_child_codes.join(", ") || "нет"}. ${where}`,
          how: Math.abs(groupDeltaControl.residual) > tolerance
            ? "Проверить выделенную ниже контрольную строку остатка и статьи с неполной парой. Контрольная строка не является статьёй или проводкой."
            : "Расхождение уже локализовано в дочерних статьях; раскрыть группу и проверять строки с ненулевой дельтой.",
          delta,
        };
      }

      if (row.blank_article_binding) {
        return {
          status: "ПУСТАЯ СТАТЬЯ ИНТАЛЕВ / ERP СТАТЬЯ УКАЗАНА / БЕЗ ПРОВОДКИ",
          what: `Инталев ${row.blank_article_binding.amount.toLocaleString("ru-RU", {
            minimumFractionDigits: 2,
            maximumFractionDigits: 2,
          })} сохранён без статьи; в ERP сумма показана по строке ${row.code} «${row.erp_label}».`,
          where: `Инталев: ${row.blank_article_binding.source_file}; ${row.blank_article_binding.source_sheet}!${row.blank_article_binding.source_cell} | ERP: ${where}`,
          how: "Корректировка не требуется. Это отчётная классификация по уникальной сумме внутри доказанного all-in; физическая связь проводки отдельно не утверждается и поля ERP не выдумываются.",
          delta,
        };
      }
      if (
        (row.intalev_all_in_reporting || (row.blank_article_bindings?.length ?? 0) > 0) &&
        typeof delta === "number" &&
        Math.abs(delta) <= tolerance
      ) {
        return {
          status: "СУММА СОШЛАСЬ С УЧЕТОМ ПУСТЫХ СТАТЕЙ / БЕЗ ПРОВОДКИ",
          what: "Родительский итог рассчитан all-in: классифицированные и пустые статьи Инталева учтены один раз.",
          where,
          how: "Пустые ветви показаны непосредственно под родителем. Не вычитать их повторно из закрытой дельты; физическую ERP-проводку проверять отдельно.",
          delta,
        };
      }

      const engineStatus = buildReportDecision(engineDecision, { delta, where });
      if (engineStatus) return engineStatus;

      if (["UNPROVEN", "MISMATCH"].includes(row.erp_binding_status)) {
        return {
          status: "ТРЕБУЕТ ПРОВЕРКИ",
          what: `ERP_BINDING=${row.erp_binding_status}; структура Инталева сохранена.`,
          where,
          how: "Проверить точную ERP-привязку без изменения parent/outline Инталева. Сумму не обнулять и дерево не перестраивать.",
          delta,
        };
      }

      if (delta === null) {
        return {
          status: "ТРЕБУЕТ ПРОВЕРКИ",
          what: "Не доказана числовая сумма одной из систем.",
          where,
          how: "Проверить точную строку/код/полный путь источника. Проводку не формировать.",
          delta,
        };
      }
      if (Math.abs(delta) > tolerance) {
        return {
          status: "РАСХОЖДЕНИЕ",
          what: `Дельта ${delta.toLocaleString("ru-RU", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}.`,
          where,
          how: "Раскрыть потомков и доказать точные операции журнала. До этого решение не утверждено.",
          delta,
        };
      }
      if (problemBelow) {
        return {
          status: "НУЛЕВАЯ ГРУППА / ЕСТЬ ДЕЛЬТЫ ВНУТРИ",
          what: "Итог группы равен нулю, но внутри есть расхождения или недоказанные строки.",
          where,
          how: "Раскрыть ветку и проверять статьи построчно; нулевая дельта родителя не закрывает сверку.",
          delta,
        };
      }
      if (
        !hierarchyProofPassed ||
        row.presentation_hierarchy_status !== "HIERARCHY_PROVEN"
      ) {
        return {
          status: "СУММА СОШЛАСЬ / ИЕРАРХИЯ НЕ ДОКАЗАНА",
          what: "Сумма совпала, но состав/родительская связь источников не прошли полный gate.",
          where,
          how: "Сохранить как совпадение суммы; иерархию не считать подтверждённой до coverage-проверки.",
          delta,
        };
      }
      return {
        status: "СОШЛОСЬ",
        what: "Расхождение по сумме не найдено.",
        where,
        how: "Исправление не требуется.",
        delta,
      };
    });

    const decisionsByCode = new Map(
      presentationRows.map((row, index) => [row.code, decisions[index]]),
    );
    writeValues(
      hierarchySheet,
      dataStartRow,
      1,
      treeDisplayRows.map((displayRow, index) => {
        const level = treeOutlineLevels[index];
        if (displayRow.kind === "OPERATION_REVIEW_HEADER") {
          const cells = Array(30).fill(null);
          cells[0] = "ЖУРНАЛ";
          cells[1] = "1 — РАСКРЫТИЕ";
          cells[2] = "Операции журнала без доказанной связи со статьёй ОПИУ";
          cells[6] = "ТРЕБУЕТ ПРОВЕРКИ";
          cells[7] = `Ниже раскрыты ${displayRow.operationCount} операций с регистраторами.`;
          cells[8] = "Связь с R-кодом не доказана; строки показаны только для диагностики.";
          cells[9] = "Не включать в суммы и не формировать корректировки без подтверждения статьи.";
          cells[10] = "ДИАГНОСТИКА ЖУРНАЛА";
          cells[27] = "CANDIDATE_EXCLUDED; EXCLUDED_FROM_TOTAL; correction_operation_rows=0; posting_rows=0.";
          return cells;
        }
        if (displayRow.kind === "GROUP_DELTA_RESIDUAL") {
          const row = displayRow.financial;
          const control = displayRow.control;
          const cells = Array(30).fill(null);
          cells[0] = `${row.code}-Δ`;
          cells[1] = `${level + 1} — КОНТРОЛЬ ДЕЛЬТЫ`;
          cells[2] = `${"   ".repeat(level)}Нераспределённая дельта внутри группы «${intalevBusinessLabel(row) || row.erp_label || row.code}»`;
          cells[5] = control.residual;
          cells[6] = "ДЕЛЬТА ГРУППЫ НЕ РАСКРЫТА ПО СТАТЬЯМ";
          cells[7] = `Дельта группы ${control.group_delta.toLocaleString("ru-RU", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}; по полным дочерним статьям объяснено ${control.known_child_delta_sum.toLocaleString("ru-RU", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}; остаток ${control.residual.toLocaleString("ru-RU", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}.`;
          cells[8] = `Группа ${row.code}; полные дети: ${control.complete_children.map((item) => item.code).join(", ") || "нет"}; неполные дети: ${control.incomplete_child_codes.join(", ") || "нет"}.`;
          cells[9] = "Раскрыть статьи с неполной парой Инталев/ERP. Эта контрольная строка объясняет место остатка, но не является статьёй или проводкой.";
          cells[10] = "КОНТРОЛЬ ГРУППИРОВКИ / БЕЗ ПРОВОДКИ";
          cells[25] = control.residual;
          cells[27] = `group_delta=${control.group_delta}; known_child_delta_sum=${control.known_child_delta_sum}; residual=${control.residual}; incomplete_child_codes=${control.incomplete_child_codes.join(",")}; correction_authority=false; posting_rows=0; ready_to_upload=false; release_allowed=false.`;
          cells[28] = "VISIBLE_GROUP_DELTA_CONSERVATION";
          cells[29] = "REVIEW_ONLY_RESIDUAL";
          return cells;
        }
        if (displayRow.kind === "EMPTY_ARTICLE_BRANCH") {
          const scope = displayRow.scope;
          const itemLevels = (scope?.items ?? []).map(
            (item) => Math.max(1, Number(item?.source_scope_relative_level ?? 1)),
          );
          const directLevel = itemLevels.length > 0 ? Math.min(...itemLevels) : 1;
          const directItems = (scope?.items ?? []).filter(
            (item) => Math.max(1, Number(item?.source_scope_relative_level ?? 1)) === directLevel,
          );
          const matchedAmount = roundMoney(directItems.reduce(
            (sum, item) => sum + (typeof item?.erp_amount === "number" ? item.erp_amount : 0),
            0,
          ));
          const fullyMatched =
            directItems.length > 0 &&
            directItems.every((item) => typeof item?.erp_amount === "number") &&
            Math.abs(matchedAmount - Number(scope?.blank_amount ?? 0)) <= tolerance;
          const ownerBindingCandidates = (scope?.items ?? []).some(
            (item) => item?.source_is_leaf === true,
          )
            ? (scope?.items ?? []).filter((item) => item?.source_is_leaf === true)
            : directItems;
          const ownerBoundItems = ownerBindingCandidates.filter(
            (item) => item?.binding_status === "OWNER_APPROVED_BINDING",
          );
          const ownerBindingComplete =
            ownerBindingCandidates.length > 0 &&
            ownerBoundItems.length === ownerBindingCandidates.length;
          const ownerBindingPartial = ownerBoundItems.length > 0 && !ownerBindingComplete;
          const explanationItems = ownerBindingCandidates.filter(
            (item) => normalizeText(item?.source_label) && typeof item?.amount === "number",
          );
          const explanationTotal = roundMoney(explanationItems.reduce(
            (sum, item) => sum + item.amount,
            0,
          ));
          const explanationCloses = explanationItems.length > 0
            && Math.abs(explanationTotal - Number(scope?.blank_amount ?? 0)) <= tolerance;
          const userMoney = (value) => Number(value ?? 0).toLocaleString("ru-RU", {
            minimumFractionDigits: 2,
            maximumFractionDigits: 2,
          });
          const detailExplanation = explanationItems.length <= 8
            ? explanationItems.map((item) => `«${normalizeText(item.source_label)}» ${userMoney(item.amount)}`).join(" + ")
            : `${explanationItems.length} строк детализации общей суммой ${userMoney(explanationTotal)}`;
          const cells = Array(30).fill(null);
          cells[0] = "EMPTY";
          cells[1] = `${level + 1} — ПУСТАЯ СТАТЬЯ`;
          cells[2] = `${"   ".repeat(level)}<пустая статья Инталев> — ${scope.period}`;
          cells[3] = scope.blank_amount;
          cells[4] = fullyMatched ? matchedAmount : null;
          cells[6] = fullyMatched
            ? "UNCLASSIFIED / ERP СТАТЬИ УКАЗАНЫ / БЕЗ ПРОВОДКИ"
            : ownerBindingComplete
              ? "UNCLASSIFIED / UPDATE_MAPPING / БЕЗ ПРОВОДКИ"
              : ownerBindingPartial
                ? "UNCLASSIFIED / ЧАСТИЧНОЕ UPDATE_MAPPING / _СПОРНО / БЕЗ ПРОВОДКИ"
                : explanationCloses
                  ? "СУММА НАЙДЕНА / СТРУКТУРНОЕ РАСКРЫТИЕ / БЕЗ ПРОВОДКИ"
                  : "UNCLASSIFIED / _СПОРНО / БЕЗ ПРОВОДКИ";
          cells[7] = explanationCloses
            ? `Сумма найдена полностью: ${detailExplanation} = ${userMoney(scope.blank_amount)}. В Инталеве эти расходы расположены отдельной веткой без статьи, поэтому это объяснение структуры, а не потерянная сумма.`
            : `Сумма ${userMoney(scope.blank_amount)} найдена в Инталеве отдельной веткой без статьи и уже включена в общий итог родителя один раз; это объяснение структуры, а не потерянная сумма.`;
          cells[8] = scope.source_scope_path;
          cells[9] = fullyMatched
            ? `Корректировка не требуется: те же затраты найдены в ERP на именованных статьях. Инталев all-in ${userMoney(scope.all_in_amount)} − статьи ОПИУ ${userMoney(scope.classified_amount)} = отдельная ветка ${userMoney(scope.blank_amount)}; строки ниже показывают её состав.`
            : ownerBindingComplete || ownerBindingPartial
              ? "Применена настройка классификации организации. Сумму ERP не распределять по строкам; проводку не формировать. Непривязанные строки оставить на ручной проверке."
              : explanationCloses
                ? `Проводку не формировать: каждая деталь учтена один раз, а дельта отдельных строк возникает из-за различия иерархии Инталев и ERP. Проверять нужно только расположение в отчёте, не саму сумму.`
                : "Проверить ERP-классификацию вручную. Не подставлять статью, организацию или SourceRowID.";
          cells[10] = "UNCLASSIFIED_BRANCH / CONTROL_ONLY";
          cells[27] = `source_scope_id=${scope.source_scope_id}; all_in=${scope.all_in_amount}; classified=${scope.classified_amount}; blank=${scope.blank_amount}; detail_sum=${explanationTotal}; detail_sum_closes_blank=${explanationCloses}; count_in_parent_once=true; financial_posting_rows=0; ready_to_upload=false; release_allowed=false.`;
          cells[28] = "UNCLASSIFIED / EMPTY_ARTICLE";
          cells[29] = fullyMatched
            ? "ERP_REPORT_ARTICLE_PRESENT"
            : ownerBindingComplete
              ? "OWNER_APPROVED_CLASSIFICATION_BINDING"
              : ownerBindingPartial
                ? "OWNER_APPROVED_BINDING_PARTIAL_REVIEW"
                : "ERP_PHYSICAL_BINDING_UNPROVEN";
          return cells;
        }
        if (displayRow.kind === "EMPTY_ARTICLE_DETAIL") {
          const item = displayRow.item;
          const scopeItems = (displayRow.scope?.items ?? []).some((entry) => entry?.source_is_leaf === true)
            ? (displayRow.scope?.items ?? []).filter((entry) => entry?.source_is_leaf === true)
            : (displayRow.scope?.items ?? []);
          const scopeDetailTotal = roundMoney(scopeItems.reduce(
            (sum, entry) => sum + (typeof entry?.amount === "number" ? entry.amount : 0),
            0,
          ));
          const scopeDetailsClose = scopeItems.length > 0
            && Math.abs(scopeDetailTotal - Number(displayRow.scope?.blank_amount ?? 0)) <= tolerance;
          const hasErpArticle = Boolean(normalizeText(item?.target_code) && normalizeText(item?.erp_article));
          const ownerClassificationBinding =
            item?.binding_status === "OWNER_APPROVED_BINDING";
          const cells = Array(30).fill(null);
          cells[0] = item.target_code || "EMPTY";
          cells[1] = `${level + 1} — ПУСТАЯ ДЕТАЛЬ`;
          cells[2] = [
            `${"   ".repeat(level)}Инталев: <пустая статья>`,
            normalizeText(item?.source_label) ? `строка «${item.source_label}»` : "",
            hasErpArticle ? `→ ERP ${item.target_code}: «${item.erp_article}»` : "",
          ].filter(Boolean).join(" ");
          cells[3] = item.amount;
          cells[4] = typeof item.erp_amount === "number" ? item.erp_amount : null;
          cells[6] = ownerClassificationBinding
            ? "BINDING_REPAIR_PROVEN / UPDATE_MAPPING / БЕЗ ПРОВОДКИ"
            : hasErpArticle
              ? "ERP СТАТЬЯ УКАЗАНА / КОРРЕКТИРОВКА НЕ НУЖНА"
              : scopeDetailsClose
                ? "СУММА НАЙДЕНА / ДЕТАЛИЗАЦИЯ / БЕЗ ПРОВОДКИ"
                : "_СПОРНО / ERP СТАТЬЯ НЕ ДОКАЗАНА";
          cells[7] = ownerClassificationBinding
            ? "Исходная сумма Инталева сохранена без статьи; ERP-статья определена настройкой организации."
            : `Деталь «${normalizeText(item?.source_label) || "без названия"}» на сумму ${Number(item?.amount ?? 0).toLocaleString("ru-RU", { minimumFractionDigits: 2, maximumFractionDigits: 2 })} уже входит в итог пустой ветки Инталева; это расшифровка суммы, а не отдельная дополнительная дельта.`;
          cells[8] = `${item.source_file}; ${item.sheet}!${item.source_cell}`;
          cells[9] = ownerClassificationBinding
            ? "Сопоставлено по настройке организации; не формировать проводку и не распределять общую сумму ERP по исходным строкам."
            : hasErpArticle
              ? "Не формировать проводку; отчётное сопоставление выполнено по уникальной сумме внутри родителя."
              : "Показать пользователю как объясняющую детализацию. Проводку не формировать: сумма уже учтена в all-in родителя; проверка нужна только при обязательном выборе новой статьи ERP.";
          cells[10] = "UNCLASSIFIED_DETAIL / CONTROL_ONLY";
          cells[27] = `source_path=${item.source_path}; source_row=${item.source_row}; source_sha256=${item.source_sha256}; match_basis=${item.match_basis}; binding_status=${item.binding_status ?? ""}; binding_classification=${item.binding_classification ?? ""}; binding_decision_type=${item.binding_decision_type ?? ""}; article=""; correction_allowed=false; residual_consumption=0; financial_posting_rows=0.`;
          cells[28] = ownerClassificationBinding
            ? "SOURCE_CLASSIFICATION_GAP / EMPTY_ARTICLE"
            : scopeDetailsClose
              ? "STRUCTURAL_EXPLANATION / EMPTY_ARTICLE"
              : "UNCLASSIFIED / EMPTY_ARTICLE";
          cells[29] = ownerClassificationBinding
            ? "OWNER_APPROVED_CLASSIFICATION_BINDING"
            : hasErpArticle
              ? "ERP_REPORT_ARTICLE_PRESENT"
              : scopeDetailsClose
                ? "INTALEV_DETAIL_SUM_PROVEN"
                : "ERP_PHYSICAL_BINDING_UNPROVEN";
          return cells;
        }
        if (displayRow.kind === "FINANCIAL") {
          const row = displayRow.financial;
          const decision = decisionsByCode.get(row.code);
          const journalStructureBound = row?.journal_structure_binding?.status === "PROVEN";
          const journalStructureOnly = journalStructureBound && !(
            typeof row?.intalev?.amount === "number" &&
            typeof row?.erp?.amount === "number"
          );
          const visibleDecision = journalStructureOnly
            ? {
                status: "ПРИВЯЗАНО К ГРУППЕ ПО ЖУРНАЛУ / БЕЗ ПРОВОДКИ",
                what: `Статья ERP «${row.erp_label}» относится к группе Инталев «${row.journal_structure_binding.parent_article}».`,
                where: `Инталев: ${row.presentation_structural_proof?.source_report_paths?.join(" | ") || row.journal_structure_binding.parent_article}; ERP: физические строки журнала, ${row.journal_structure_binding.operation_count} доказанных операций.`,
                how: "Статью и сумму ERP не менять. В сверке показать её дочерней строкой соответствующей группы Инталев.",
              }
            : decision;
          const labelsDiffer =
            normalizeLabel(row.intalev_label) !== normalizeLabel(row.erp_label);
          const childOperationCount = (operationEvidence?.rows ?? []).filter(
            (operation) => operation.parent_code === row.code,
          ).length;
          const provenChildOperationCount = (operationEvidence?.rows ?? []).filter(
            (operation) =>
              operation.parent_code === row.code &&
              operation.row_class !== "CANDIDATE_EXCLUDED" &&
              operation.proof_status !== "CANDIDATE_NOT_PROVEN" &&
              operation.proof_status !== "BLOCKED",
          ).length;
          const candidateChildOperationCount = childOperationCount - provenChildOperationCount;
          const structuralProof = row.presentation_structural_proof ?? {
            status: "HIERARCHY_UNPROVEN",
          };
          const sourcePath = intalevPresentationPath(row);
          const sourceRole = intalevPresentationRole(row);
          return [
            row.code,
            sourceRole === "НЕТ УЗЛА ИНТАЛЕВ" && !journalStructureBound
              ? "— СТАТЬЯ ERP, НЕТ В ДЕРЕВЕ ИНТАЛЕВ"
              : sourceRole,
            `${"   ".repeat(level)}${intalevBusinessLabel(row) || row.erp_label || row.code}`,
            row.intalev.amount,
            row.erp.amount,
            null,
            visibleDecision.status,
            visibleDecision.what,
            visibleDecision.where,
            visibleDecision.how,
            row.type,
            null,
            null,
            null,
            null,
            null,
            null,
            null,
            null,
            null,
            null,
            null,
            null,
            null,
            null,
            null,
            labelsDiffer
              ? `${row.intalev_label || "—"} → ${row.erp_label || "—"}`
              : null,
            `Тип строки: статья ОПИУ${journalStructureBound ? ` ERP, привязанная к группе Инталев «${row.journal_structure_binding.parent_article}» по одинаковой операции журналов` : sourceRole === "НЕТ УЗЛА ИНТАЛЕВ" ? " из структуры ERP; в дереве Инталев точного узла нет" : " из дерева Инталев"}. Путь Инталев: ${sourcePath || "НЕТ УЗЛА В АРХИВЕ"}; Статус Инталев: ${row.intalev.status}; ERP: ${row.erp.status}; source parent=${row.presentation_parent_code || "ROOT"}; parent basis=${row.presentation_parent_basis}; source outlineLevel=${row.presentation_source_outline_level}; display outlineLevel=${level}; structural status=${row.presentation_hierarchy_status}; proof status=${structuralProof.status}; proof source=${structuralProof.system || "INTALEV"}; proof cell=${structuralProof.source_sheet && structuralProof.source_cell ? `${structuralProof.source_sheet}!${structuralProof.source_cell}` : "LIVE_INTALEV_NODE"}; graph SHA-256=${structuralProof.graph_sha256 || "LIVE_INTALEV"}; ERP used=${structuralProof.erp_used === true ? "true" : "false"}; group rollup Intalev=${(row.intalev.presentation_group_rollups ?? []).map((item) => item.basis).join(",") || "NO"}; group rollup ERP=${(row.erp.presentation_group_rollups ?? []).map((item) => item.basis).join(",") || "NO"}; ${row.presentation_reason || "parent-граф без локальных замечаний"}; child_operation_rows=${childOperationCount}; proven_operation_rows=${provenChildOperationCount}; candidate_operation_rows=${candidateChildOperationCount}.`,
            row.intalev_hierarchy_status,
            row.erp_binding_status,
          ];
        }

        const operation = displayRow.operation;
        const inactive = operation.row_class === "INACTIVE_DUPLICATE_HISTORY";
        const exactArticleBound = operation.exact_article_bound === true;
        const candidate =
          operation.row_class === "CANDIDATE_EXCLUDED" ||
          operation.proof_status === "CANDIDATE_NOT_PROVEN" ||
          operation.proof_status === "BLOCKED";
        const paired = Boolean(operation.pair_id);
        const operationStatus = inactive
          ? "ИСТОРИЯ ДУБЛЯ — НЕ В ИТОГЕ"
          : exactArticleBound
            ? "ТОЧНО СВЯЗАНО ПО СТАТЬЕ — ТОЛЬКО ПРОВЕРКА"
          : candidate && paired
            ? "КАНДИДАТ ПАРЫ STORNO/REPOST — НЕ В ИТОГЕ"
          : candidate
            ? "КАНДИДАТ / НЕ ДОКАЗАНО — НЕ В ИТОГЕ"
          : paired
            ? "СУЩЕСТВУЮЩАЯ АКТИВНАЯ ПАРА"
            : "ДОКАЗАННЫЙ ИСТОЧНИК ERP";
        const operationHow = inactive
          ? "Не включать в сумму и не формировать повторно."
          : exactArticleBound
            ? "Показано под строкой дельты по точному совпадению статьи; не включать в сумму, не формировать корректировку и не загружать."
          : candidate && paired
            ? "Кодовая нулевая группа: проверить предложенную пару STORNO/REPOST; не включать в сумму и не загружать."
          : candidate
            ? "Показано для проверки документа; не включать в сумму, не исправлять и не загружать без подтверждения."
          : paired
            ? operation.count_in_parent
              ? "Уже существующий REPOST входит в статью; новую пару не формировать."
              : "Связанная строка STORNO показана для контроля; в сумму статьи не входит."
            : "Строка составляет ERP-сумму статьи; исправление не требуется.";
        const sourceRange = operation.source_range ??
          `B${operation.physical_row}:AG${operation.physical_row}`;
        const operationComment = [
          operation.comment,
          `SourceRowID=${operation.source_row_id}`,
          `JournalSHA=${operation.journal_sha256 ?? operationEvidence?.journal_sha256 ?? "MISSING"}`,
          operation.journal_input_path ? `JournalInput=${operation.journal_input_path}` : "",
          operation.journal_archive_entry ? `JournalEntry=${operation.journal_archive_entry}` : "",
          paired ? `PairID=${operation.pair_id}` : "",
          operation.pair_status ? `Status=${operation.pair_status}` : "",
          operation.pair_role ? `Role=${operation.pair_role}` : "",
          operation.partner_range ? `Partner=${operation.partner_range}` : "",
          inactive ? "EXCLUDED_FROM_TOTAL" : "",
          candidate ? "CANDIDATE_NOT_PROVEN; EXCLUDED_FROM_TOTAL" : "",
        ].filter(Boolean).join("; ");
        return [
          operation.pair_id || `SRC-${operation.physical_row}`,
          `${level + 1} — ${operation.row_class}`,
          `${"   ".repeat(level)}${operation.article || operation.row_class}`,
          null,
          null,
          null,
          operationStatus,
          operation.reason || "Точная строка ERP-журнала.",
          `Лист_1!${sourceRange}`,
          operationHow,
          operation.row_class,
          // Preserve the exact journal display text so Excel and rendered QA
          // show the date instead of the underlying serial number.
          String(operation.date ?? "").replace(/\s+(?:0|00):00:00$/, ""),
          sourceRange,
          operation.document,
          operation.posting_no,
          operation.debit,
          (operation.debit_analytics ?? []).filter(Boolean).join(" | "),
          operation.debit_department,
          operation.credit,
          (operation.credit_analytics ?? []).filter(Boolean).join(" | "),
          operation.credit_department,
          operation.organization,
          operation.amount,
          operation.pair_role === "STORNO" ? operation.amount : null,
          operation.pair_role === "REPOST" ? operation.amount : null,
          null,
          operation.source_to_target ?? null,
          operationComment,
          null,
          null,
        ];
      }),
    );
    writeFormulas(
      hierarchySheet,
      dataStartRow,
      6,
      treeDisplayRows.map((displayRow, index) => {
        const excelRow = dataStartRow + index;
        if (displayRow.kind === "GROUP_DELTA_RESIDUAL") {
          return [`=${displayRow.control.residual}`];
        }
        return ["FINANCIAL", "EMPTY_ARTICLE_BRANCH", "EMPTY_ARTICLE_DETAIL"].includes(
          displayRow.kind,
        )
          ? [
              `=IF(OR(NOT(ISNUMBER(D${excelRow})),NOT(ISNUMBER(E${excelRow}))),"",D${excelRow}-E${excelRow})`,
            ]
          : [null];
      }),
    );
    writeFormulas(
      hierarchySheet,
      dataStartRow,
      26,
      treeDisplayRows.map((displayRow, index) => {
        const excelRow = dataStartRow + index;
        if (displayRow.kind === "GROUP_DELTA_RESIDUAL") {
          return [`=F${excelRow}`];
        }
        return ["FINANCIAL", "EMPTY_ARTICLE_BRANCH", "EMPTY_ARTICLE_DETAIL"].includes(
          displayRow.kind,
        )
          ? [[`=IF(F${excelRow}="","",F${excelRow})`][0]]
          : [null];
      }),
    );

    styleData(hierarchySheet.getRange(`A${dataStartRow}:AD${endRow}`));
    hierarchySheet.getRange(`D${dataStartRow}:F${endRow}`).format.numberFormat =
      '#,##0.00;[Red]-#,##0.00;–';
    hierarchySheet.getRange(`W${dataStartRow}:Z${endRow}`).format.numberFormat =
      '#,##0.00;[Red]-#,##0.00;–';
    hierarchySheet.getRange(`H${dataStartRow}:J${endRow}`).format.wrapText = true;
    hierarchySheet.getRange(`AB${dataStartRow}:AD${endRow}`).format.wrapText = true;

    hierarchySheet.getRange(`L${dataStartRow}:L${endRow}`).format.numberFormat =
      "dd.mm.yyyy hh:mm:ss";

    treeDisplayRows.forEach((displayRow, index) => {
      const excelRow = dataStartRow + index;
      const level = treeOutlineLevels[index];
      const rowRange = hierarchySheet.getRange(`A${excelRow}:AD${excelRow}`);
      if (displayRow.kind === "OPERATION_REVIEW_HEADER") {
        rowRange.format = {
          fill: "#D9EAF7",
          font: { bold: true, color: "#17365D" },
          verticalAlignment: "top",
          rowHeight: 52,
          borders: {
            bottom: { style: "thin", color: "#9EADBA" },
          },
        };
        hierarchySheet.getRange(`C${excelRow}:J${excelRow}`).format.wrapText = true;
        hierarchySheet.getRange(`AB${excelRow}:AD${excelRow}`).format.wrapText = true;
        return;
      }
      if (displayRow.kind === "GROUP_DELTA_RESIDUAL") {
        rowRange.format = {
          fill: "#FCE4D6",
          font: { bold: true, color: "#9C0006" },
          verticalAlignment: "top",
          rowHeight: 52,
          borders: {
            bottom: { style: "thin", color: "#E6B8AF" },
          },
        };
        hierarchySheet.getRange(`C${excelRow}:J${excelRow}`).format.wrapText = true;
        hierarchySheet.getRange(`AB${excelRow}:AD${excelRow}`).format.wrapText = true;
        workbook.comments.addThread(
          { cell: hierarchySheet.getRange(`C${excelRow}`) },
          [
            "Это контроль сохранения дельты, а не статья и не операция.",
            `Группа: ${displayRow.control.code}`,
            `Дельта группы: ${displayRow.control.group_delta}`,
            `Сумма известных дочерних дельт: ${displayRow.control.known_child_delta_sum}`,
            `Нераспределённый остаток: ${displayRow.control.residual}`,
            `Неполные дочерние статьи: ${displayRow.control.incomplete_child_codes.join(", ") || "нет"}`,
            "correction_authority=false; posting_rows=0; ready_to_upload=false; release_allowed=false.",
          ].join("\n"),
        );
        return;
      }
      if (["EMPTY_ARTICLE_BRANCH", "EMPTY_ARTICLE_DETAIL"].includes(displayRow.kind)) {
        const isBranch = displayRow.kind === "EMPTY_ARTICLE_BRANCH";
        const matched = isBranch
          ? (displayRow.scope?.items ?? []).some((item) => item?.target_code)
          : Boolean(displayRow.item?.target_code);
        rowRange.format = {
          fill: isBranch ? "#FCE4D6" : "#FFF2CC",
          font: { bold: isBranch, color: "#7F6000" },
          verticalAlignment: "top",
          rowHeight: isBranch ? 48 : 44,
          borders: {
            bottom: { style: "thin", color: "#E6B8AF" },
          },
        };
        hierarchySheet.getRange(`C${excelRow}:J${excelRow}`).format.wrapText = true;
        hierarchySheet.getRange(`AB${excelRow}:AD${excelRow}`).format.wrapText = true;
        hierarchySheet.getRange(`G${excelRow}`).format = {
          fill: matched ? "#E2F0D9" : "#FFE699",
          font: { bold: true, color: matched ? "#375623" : "#9C5700" },
          wrapText: true,
        };
        const source = isBranch ? displayRow.scope : displayRow.item;
        workbook.comments.addThread(
          { cell: hierarchySheet.getRange(`C${excelRow}`) },
          [
            "Инталев: статья отсутствует; сумма сохранена и включена в all-in родителя один раз.",
            `Период: ${displayRow.scope?.period ?? ""}`,
            `Родитель: ${displayRow.scope?.owner_code ?? ""}`,
            source?.source_file ? `Файл: ${source.source_file}` : "",
            source?.sheet && source?.source_cell
              ? `Источник: ${source.sheet}!${source.source_cell}`
              : "",
            source?.source_row ? `Строка: ${source.source_row}` : "",
            source?.target_code ? `ERP строка: ${source.target_code}` : "",
            source?.erp_article ? `ERP статья: ${source.erp_article}` : "",
            "article=\"\"; correction_allowed=false; financial_posting_rows=0; physical_posting_fields_invented=false.",
          ].filter(Boolean).join("\n"),
        );
        return;
      }
      if (displayRow.kind === "OPERATION") {
        const operation = displayRow.operation;
        const inactive = operation.row_class === "INACTIVE_DUPLICATE_HISTORY";
        const candidate =
          operation.row_class === "CANDIDATE_EXCLUDED" ||
          operation.proof_status === "CANDIDATE_NOT_PROVEN" ||
          operation.proof_status === "BLOCKED";
        const paired = Boolean(operation.pair_id);
        const fill = inactive
          ? "#D9D9D9"
          : candidate && paired
            ? "#F4B183"
          : candidate
            ? "#FFE699"
            : paired
              ? "#FFF2CC"
              : "#F2F2F2";
        rowRange.format = {
          fill,
          font: { color: inactive ? "#666666" : "#1F1F1F" },
          verticalAlignment: "top",
          rowHeight: 42,
          borders: {
            bottom: { style: "thin", color: "#D9E2F3" },
          },
        };
        hierarchySheet.getRange(`C${excelRow}`).format.wrapText = true;
        hierarchySheet.getRange(`G${excelRow}:J${excelRow}`).format.wrapText = true;
        hierarchySheet.getRange(`N${excelRow}:V${excelRow}`).format.wrapText = true;
        hierarchySheet.getRange(`AB${excelRow}:AD${excelRow}`).format.wrapText = true;
        hierarchySheet.getRange(`G${excelRow}`).format = {
          fill: inactive
            ? "#D9D9D9"
            : candidate && paired
              ? "#F4B183"
            : candidate
              ? "#FFE699"
              : paired
                ? "#FFF2CC"
                : "#E2F0D9",
          font: {
            bold: true,
            color: inactive ? "#666666" : candidate && paired ? "#843C0C" : candidate ? "#9C5700" : "#7F6000",
          },
          wrapText: true,
        };
        workbook.comments.addThread(
          { cell: hierarchySheet.getRange(`C${excelRow}`) },
          [
            `Тип: ${operation.row_class}`,
            `Родитель: ${operation.parent_code}`,
            `ERP: Лист_1!${operation.source_range}`,
            `SourceRowID=${operation.source_row_id}`,
            `JournalSHA=${operation.journal_sha256 ?? operationEvidence?.journal_sha256 ?? "MISSING"}`,
            operation.journal_input_path ? `JournalInput=${operation.journal_input_path}` : "",
            operation.journal_archive_entry ? `JournalEntry=${operation.journal_archive_entry}` : "",
            operation.pair_id ? `PairID=${operation.pair_id}` : "",
            operation.pair_status ? `Status=${operation.pair_status}` : "",
            operation.pair_role ? `Role=${operation.pair_role}` : "",
            operation.partner_range ? `Partner=${operation.partner_range}` : "",
            operation.comment ?? "",
            inactive ? "EXCLUDED_FROM_TOTAL" : "",
            candidate ? "CANDIDATE_NOT_PROVEN; EXCLUDED_FROM_TOTAL" : "",
            "correction_operation_rows=0; posting_rows=0; ready_to_upload=false; release_allowed=false.",
          ].filter(Boolean).join("\n"),
        );
        return;
      }

      const row = displayRow.financial;
      const levelFormat = level === 0
        ? { fill: "#1F4E78", font: { bold: true, color: colors.white } }
        : level === 1
          ? { fill: "#DDEBF7", font: { bold: true, color: "#17365D" } }
          : level === 2
            ? { fill: "#E2F0D9", font: { color: "#1F1F1F" } }
            : { fill: "#FFF2CC", font: { color: "#1F1F1F" } };
      const presentationRole = intalevPresentationRole(row);
      const journalStructureBound = row?.journal_structure_binding?.status === "PROVEN";
      const missingIntalevNode = !normalizeText(row?.hierarchy_node_id) && !journalStructureBound;
      const duplicateIntalevNode = presentationRole.startsWith("ДУБЛЬ УЗЛА ");
      rowRange.format = {
        ...(missingIntalevNode || duplicateIntalevNode
          ? { fill: "#E7E6E6", font: { color: "#595959", italic: true } }
          : levelFormat),
        verticalAlignment: "top",
        rowHeight: level <= 1 ? 52 : 44,
        borders: {
          insideHorizontal: { style: "thin", color: "#D9E2F3" },
          insideVertical: { style: "thin", color: "#D9E2F3" },
          bottom: { style: "thin", color: "#D9E2F3" },
        },
      };
      const rowDecision = decisionsByCode.get(row.code);
      const journalStructureOnly = row?.journal_structure_binding?.status === "PROVEN" && !(
        typeof row?.intalev?.amount === "number" &&
        typeof row?.erp?.amount === "number"
      );
      const status = journalStructureOnly
        ? "ПРИВЯЗАНО К ГРУППЕ ПО ЖУРНАЛУ / БЕЗ ПРОВОДКИ"
        : rowDecision.status;
      const statusFill = status === "СОШЛОСЬ"
        ? colors.greenStrong
        : status.startsWith("ПРИВЯЗАНО К ГРУППЕ ПО ЖУРНАЛУ")
          ? colors.greenStrong
        : status.startsWith("НУЛЕВАЯ ГРУППА") ||
            status.includes("ИЕРАРХИЯ") ||
            status.includes("ПУСТЫХ СТАТЕЙ") ||
            status.includes("ПУСТАЯ СТАТЬЯ")
          ? colors.orange
          : status === "ТРЕБУЕТ ПРОВЕРКИ"
            ? colors.gray
            : colors.red;
      hierarchySheet.getRange(`G${excelRow}`).format = {
        fill: statusFill,
        font: {
          bold: true,
          color: status === "СОШЛОСЬ" ? "#006100" : "#9C0006",
        },
        wrapText: true,
      };
      hierarchySheet.getRange(`C${excelRow}`).format.wrapText = true;
      workbook.comments.addThread(
        { cell: hierarchySheet.getRange(`C${excelRow}`) },
        [
          `Код: ${row.code}`,
          `Тип/уровень представления ОПИУ: ${row.type} / ${level}`,
          `Родитель: ${row.presentation_parent_code || "ROOT"}`,
          `Исходная позиция контрольного листа: ${row.presentation_source_index + 1}`,
          `Доказательность ветви: ${row.presentation_hierarchy_status}; ${row.presentation_reason || "без локальных замечаний"}`,
          `Строка ERP: ${row.erp_label || "—"}`,
          journalStructureOnly
            ? `Привязка по журналам: ${row.journal_structure_binding.operation_count} операций; сумма ERP сохранена без изменения.`
            : rowDecision.where,
          `Статус Инталев: ${row.intalev.status}`,
          `Статус ERP: ${row.erp.status}`,
          `INTALEV_HIERARCHY: ${row.intalev_hierarchy_status}`,
          `ERP_BINDING: ${row.erp_binding_status}`,
          `Операции: ${operationEvidence?.status ?? "NOT_APPLICABLE"}; child_operation_rows=${(operationEvidence?.rows ?? []).filter((operation) => operation.parent_code === row.code).length}.`,
          "posting_rows=0; ready_to_upload=false; release_allowed=false.",
        ].join("\n"),
      );
    });

    // Row-level fills replace the range format object, so restore the date
    // display after all hierarchy/operation row styles have been applied.
    hierarchySheet.getRange(`L${dataStartRow}:L${endRow}`).format.numberFormat =
      "dd.mm.yyyy hh:mm:ss";

    const widths = {
      A: 14, B: 28, C: 47, D: 15, E: 15, F: 18, G: 34, H: 42, I: 52,
      J: 48, K: 17, L: 21, M: 12, N: 42, O: 12, P: 10, Q: 36, R: 30,
      S: 10, T: 36, U: 30, V: 34, W: 16, X: 15, Y: 15, Z: 18, AA: 48,
      AB: 58, AC: 22, AD: 20,
    };
    for (const [column, width] of Object.entries(widths)) {
      hierarchySheet.getRange(`${column}1:${column}${endRow}`).format.columnWidth = width;
    }
    hierarchySheet.freezePanes.freezeRows(6);
    hierarchySheet.freezePanes.freezeColumns(3);
    return endRow;
  }

  function buildSummary() {
    const endRow = 6 + aggregateRows.length;
    const intalevSourcePaths = [
      ...new Set(
        snapshot.files
          .map((file) => file.original_path || file.stored_path)
          .filter(Boolean)
          .map((filePath) =>
            path.isAbsolute(filePath) ? filePath : path.resolve(appDir, filePath),
          ),
      ),
    ];
    const erpSourcePaths = [
      ...new Set(erpParsed.map((item) => item.source_file).filter(Boolean)),
    ];
    styleTitle(
      summary,
      `A1:R1`,
      `Сверка ОПИУ — ${organization} — ${periodLabel} — REPORT_ONLY`,
    );
    summary.getRange("A2:R2").merge();
    summary.getRange("A2").values = [[
      "Дельта = Инталев эталон − ERP текущая. Корректировки не формируются; остаточная дельта равна текущей.",
    ]];
    summary.getRange("A2:R2").format = { fill: colors.blueLight, font: { bold: true } };
    summary.getRange("A3:R3").merge();
    summary.getRange("A3").values = [[
      `ИСХОДНИК ИНТАЛЕВ: ${intalevSourcePaths.join("; ")}. Периоды: ${periods.join(", ")}.`,
    ]];
    summary.getRange("A4:R4").merge();
    summary.getRange("A4").values = [[
      `ИСХОДНИК ERP: ${erpSourcePaths.join("; ")}.`,
    ]];
    summary.getRange("A3:R4").format = {
      fill: colors.yellow,
      font: { bold: true, color: "#9C5700" },
      wrapText: true,
    };
    summary.getRange("A3:R4").format.rowHeight = 30;
    summary.getRange("A5:R6").values = [
      [
        "Код строки",
        "Строка ОПИУ Инталев (эталон)",
        "Строка/статья ОПИУ ERP",
        periodLabel,
        null,
        null,
        null,
        null,
        null,
        null,
        "Контроль сопоставления",
        null,
        "Трасса источника",
        null,
        "ERP-нормализация (только кандидат)",
        null,
        "Структура и ERP binding",
        null,
      ],
      [
        null,
        null,
        null,
        "Инталев эталон",
        "ERP текущая",
        "Дельта текущая",
        "Корректировки",
        "ОПИУ ERP после",
        "Остаточная дельта",
        "Статус",
        "Инталев",
        "ERP",
        "Инталев файл/строка",
        "ERP файл/строка",
        "Сумма кандидата",
        "Статус / основание",
        "INTALEV_HIERARCHY",
        "ERP_BINDING",
      ],
    ];
    summary.getRange("A5:A6").merge();
    summary.getRange("B5:B6").merge();
    summary.getRange("C5:C6").merge();
    summary.getRange("D5:J5").merge();
    summary.getRange("K5:L5").merge();
    summary.getRange("M5:N5").merge();
    summary.getRange("O5:P5").merge();
    summary.getRange("Q5:R5").merge();
    styleHeader(summary.getRange("A5:R6"));

    const decisionByCode = new Map(
      (decisionInput?.rows ?? []).map((item) => [normalizeText(item.code), item]),
    );
    const presentationByCode = new Map(
      presentationRows.map((row) => [normalizeText(row?.code), row]),
    );
    const sourceValues = aggregateRows.map((sourceRow) => {
      const row = presentationByCode.get(normalizeText(sourceRow?.code)) ?? sourceRow;
      const journalStructureBound = row?.journal_structure_binding?.status === "PROVEN";
      return [
        row.code,
        intalevBusinessLabel(row),
        row.erp_label,
        row.intalev.amount,
        row.erp.amount,
        null,
        null,
        null,
        null,
        null,
        journalStructureBound
          ? "ПРИВЯЗАНО К ГРУППЕ ПО ЖУРНАЛУ"
          : row.intalev.status,
        row.erp.status,
        traceText("AGG", deduplicateTrace(row.intalev.trace), 4, "02_Помесячно"),
        traceText("AGG", deduplicateTrace(row.erp.trace), 4, "02_Помесячно"),
        row.erp.normalized_amount,
        [
          row.erp.normalization_status,
          row.erp.normalization_note,
          row.erp.note,
          row.journal_structure_rollup?.status === "PROVEN"
            ? `ERP восстановлена по дочерним статьям журнала: ${row.journal_structure_rollup.child_codes.join(", ")}`
            : "",
          decisionByCode.get(normalizeText(row.code))?.status_text,
          decisionByCode.get(normalizeText(row.code))?.priority_stage,
        ]
          .map(normalizeText)
          .filter(Boolean)
          .join(": "),
        journalStructureBound
          ? "HIERARCHY_PROVEN_BY_JOURNAL"
          : row.intalev_hierarchy_status,
        row.erp_binding_status,
      ];
    });
    writeValues(summary, 7, 1, sourceValues);
    const formulas = aggregateRows.map((_, index) => {
      const row = index + 7;
      return [
        `=IF(OR(NOT(ISNUMBER(D${row})),NOT(ISNUMBER(E${row}))),"",D${row}-E${row})`,
        `='00_Паспорт'!$B$19`,
        `=IF(NOT(ISNUMBER(E${row})),"",E${row}+G${row})`,
        `=IF(OR(NOT(ISNUMBER(D${row})),NOT(ISNUMBER(H${row}))),"",D${row}-H${row})`,
        summaryStatusFormula(row),
      ];
    });
    writeFormulas(summary, 7, 6, formulas);
    styleData(summary.getRange(`A7:R${endRow}`));
    summary.getRange(`D7:I${endRow}`).format.numberFormat =
      '#,##0.00;[Red](#,##0.00);-';
    summary.getRange(`D7:D${endRow}`).format.fill = colors.green;
    summary.getRange(`E7:E${endRow}`).format.fill = colors.blueLight;
    summary.getRange(`F7:F${endRow}`).format.fill = colors.yellow;
    summary.getRange(`G7:G${endRow}`).format.fill = colors.orange;
    summary.getRange(`H7:H${endRow}`).format.fill = colors.green;
    summary.getRange(`I7:I${endRow}`).format.fill = colors.red;
    summary.getRange(`K7:L${endRow}`).format.fill = "#F2F2F2";
    summary.getRange(`M7:N${endRow}`).format.wrapText = true;
    summary.getRange(`O7:O${endRow}`).format.numberFormat =
      '#,##0.00;[Red](#,##0.00);-';
    summary.getRange(`O7:O${endRow}`).format.fill = colors.orange;
    summary.getRange(`P7:P${endRow}`).format = {
      fill: colors.yellow,
      wrapText: true,
    };
    summary.getRange(`Q7:R${endRow}`).format = {
      fill: colors.blueLight,
      wrapText: true,
    };
    summary.getRange(`J7:J${endRow}`).conditionalFormats.add("containsText", {
      text: "СОШЛОСЬ",
      format: { fill: colors.greenStrong, font: { color: "#006100", bold: true } },
    });
    summary.getRange(`J7:J${endRow}`).conditionalFormats.add("containsText", {
      text: "РАСХОЖДЕНИЕ",
      format: { fill: colors.red, font: { color: "#9C0006", bold: true } },
    });
    summary.getRange(`J7:J${endRow}`).conditionalFormats.add("containsText", {
      text: "ТРЕБУЕТ",
      format: { fill: colors.yellow, font: { color: "#9C5700", bold: true } },
    });
    summary.getRange(`J7:J${endRow}`).conditionalFormats.add("containsText", {
      text: "СПРАВОЧНО",
      format: { fill: colors.gray, font: { color: colors.darkGray, bold: true } },
    });
    setColumnWidths(
      summary,
      [11, 42, 42, 16, 16, 16, 16, 17, 17, 22, 24, 24, 48, 48, 18, 56, 22, 20],
      endRow,
    );
    summary.freezePanes.freezeRows(6);
    summary.freezePanes.freezeColumns(3);
    return endRow;
  }

  function buildMonthly() {
    const flatRows = monthly.flatMap((month) =>
      month.rows.map((row) => ({ ...row, period: month.period })),
    );
    const endRow = 4 + flatRows.length;
    styleTitle(monthlySheet, "A1:P1", `Помесячная сверка — ${periodLabel}`);
    monthlySheet.getRange("A2:P2").merge();
    monthlySheet.getRange("A2").values = [[
      "Квартал и год агрегируются только после отдельного расчёта каждого месяца.",
    ]];
    monthlySheet.getRange("A2:N2").format.fill = colors.blueLight;
    const headers = [[
      "Период",
      "Код",
      "Тип",
      "Строка Инталев",
      "Строка ERP",
      "Инталев",
      "ERP",
      "Дельта",
      "Статус Инталев",
      "Статус ERP",
      "Трасса Инталев",
      "Трасса ERP",
      "ERP-кандидат нормализации",
      "Статус / основание кандидата",
      "INTALEV_HIERARCHY",
      "ERP_BINDING",
    ]];
    writeValues(monthlySheet, 4, 1, headers);
    styleHeader(monthlySheet.getRange("A4:P4"));
    writeValues(
      monthlySheet,
      5,
      1,
      flatRows.map((row) => [
        row.period,
        row.code,
        row.type,
        intalevBusinessLabel(row),
        row.erp_label,
        row.intalev.amount,
        row.erp.amount,
        null,
        row.intalev.status,
        row.erp.status,
        traceText(row.period, row.intalev.trace, 8, "03_Инталев_узлы"),
        traceText(row.period, row.erp.trace, 8, "04_ERP_статьи"),
        row.erp.normalized_amount,
        [row.erp.normalization_status, row.erp.normalization_note]
          .map(normalizeText)
          .filter(Boolean)
          .join(": "),
        row.intalev_hierarchy_status,
        row.erp_binding_status,
      ]),
    );
    writeFormulas(
      monthlySheet,
      5,
      8,
      flatRows.map((_, index) => {
        const row = index + 5;
        return [
          `=IF(OR(NOT(ISNUMBER(F${row})),NOT(ISNUMBER(G${row}))),"",F${row}-G${row})`,
        ];
      }),
    );
    styleData(monthlySheet.getRange(`A5:P${endRow}`));
    monthlySheet.getRange(`F5:H${endRow}`).format.numberFormat =
      '#,##0.00;[Red](#,##0.00);-';
    monthlySheet.getRange(`F5:F${endRow}`).format.fill = colors.green;
    monthlySheet.getRange(`G5:G${endRow}`).format.fill = colors.blueLight;
    monthlySheet.getRange(`H5:H${endRow}`).format.fill = colors.yellow;
    monthlySheet.getRange(`K5:L${endRow}`).format.wrapText = true;
    monthlySheet.getRange(`M5:M${endRow}`).format.numberFormat =
      '#,##0.00;[Red](#,##0.00);-';
    monthlySheet.getRange(`M5:M${endRow}`).format.fill = colors.orange;
    monthlySheet.getRange(`N5:N${endRow}`).format = {
      fill: colors.yellow,
      wrapText: true,
    };
    monthlySheet.getRange(`O5:P${endRow}`).format = {
      fill: colors.blueLight,
      wrapText: true,
    };
    setColumnWidths(
      monthlySheet,
      [12, 10, 16, 40, 40, 16, 16, 16, 24, 24, 48, 48, 18, 56, 22, 20],
      endRow,
    );
    monthlySheet.freezePanes.freezeRows(4);
    monthlySheet.freezePanes.freezeColumns(2);
    return endRow;
  }

  function buildIntalevNodes() {
    const records = [];
    for (const parsed of intalevParsed) {
      const baseIndex = records.length;
      parsed.nodes.forEach((node) => records.push({ ...node, childIndexes: [] }));
      parsed.nodes.forEach((_, index) => {
        records[baseIndex + index].childIndexes = directChildren(parsed.nodes, index).map(
          (childIndex) => baseIndex + childIndex,
        );
      });
    }
    const endRow = 4 + records.length;
    styleTitle(intalevSheet, "A1:M1", `Все узлы Инталев — ${periodLabel}`);
    intalevSheet.getRange("A2:M2").merge();
    intalevSheet.getRange("A2").values = [[
      "Цвет исходников не используется. Иерархия восстановлена по outlineLevel; для каждого родителя проверяется сумма прямых детей.",
    ]];
    intalevSheet.getRange("A2:M2").format = {
      fill: colors.yellow,
      font: { bold: true, color: "#9C5700" },
    };
    writeValues(intalevSheet, 4, 1, [[
      "Период",
      "Уровень",
      "Родительский путь",
      "Полный путь",
      "Узел",
      "Сумма",
      "Сумма прямых детей",
      "Дельта контроля",
      "Статус",
      "Файл",
      "Лист",
      "Строка",
      "SHA-256",
    ]]);
    styleHeader(intalevSheet.getRange("A4:M4"));
    writeValues(
      intalevSheet,
      5,
      1,
      records.map((record) => [
        record.period,
        record.level,
        record.parent_path,
        record.full_path,
        record.label,
        record.value,
        null,
        null,
        null,
        record.source_file,
        record.sheet,
        record.row,
        record.sha256,
      ]),
    );
    const formulas = records.map((record, index) => {
      const excelRow = index + 5;
      if (record.childIndexes.length === 0) return ["", "", '="LEAF"'];
      const refs = record.childIndexes.map((childIndex) => `F${childIndex + 5}`);
      return [
        `=SUM(${refs.join(",")})`,
        `=IF(OR(NOT(ISNUMBER(F${excelRow})),NOT(ISNUMBER(G${excelRow}))),"",F${excelRow}-G${excelRow})`,
        `=IF(NOT(ISNUMBER(H${excelRow})),"BLOCKED_MISSING_EVIDENCE",IF(ABS(H${excelRow})<='00_Паспорт'!$B$18,"PASS","BLOCKED_HIERARCHY_MISMATCH"))`,
      ];
    });
    writeFormulas(intalevSheet, 5, 7, formulas);
    styleData(intalevSheet.getRange(`A5:M${endRow}`));
    intalevSheet.getRange(`F5:H${endRow}`).format.numberFormat =
      '#,##0.00;[Red](#,##0.00);-';
    intalevSheet.getRange(`F5:F${endRow}`).format.fill = colors.green;
    intalevSheet.getRange(`G5:H${endRow}`).format.fill = colors.yellow;
    intalevSheet.getRange(`I5:I${endRow}`).conditionalFormats.add("containsText", {
      text: "BLOCKED",
      format: { fill: colors.red, font: { color: "#9C0006", bold: true } },
    });
    intalevSheet.getRange(`C5:E${endRow}`).format.wrapText = true;
    setColumnWidths(
      intalevSheet,
      [12, 10, 55, 80, 38, 16, 18, 18, 16, 55, 14, 10, 68],
      endRow,
    );
    intalevSheet.freezePanes.freezeRows(4);
    intalevSheet.freezePanes.freezeColumns(2);
    return endRow;
  }

  function buildIntalevBlankArticleDiagnostics() {
    const bindingBySourceItem = new Map();
    for (const month of monthly ?? []) {
      for (const scope of month?.blank_article_reporting?.display_scopes ?? []) {
        for (const item of scope?.items ?? []) {
          const key = [
            month.period,
            normalizeText(item?.source_sha256),
            normalizeText(item?.sheet),
            normalizeText(item?.source_cell),
            item?.source_row ?? "",
            normalizeText(item?.source_path),
            Number(item?.amount ?? 0),
          ].join("|");
          bindingBySourceItem.set(key, item);
        }
      }
    }
    const rows = intalevSourceScopes.flatMap((scope) => [
      [
        scope.period,
        "SOURCE_SCOPE_CONTROL",
        scope.arithmetic_preservation_status,
        scope.intalev_all_in_control_total,
        scope.intalev_classified_subtotal,
        scope.intalev_blank_unclassified_total,
        scope.arithmetic_preservation_delta,
        null,
        "Сопоставимый source scope Инталев",
        "",
        scope.source_scopes?.[0]?.source_scope_path ?? "",
        "",
        0,
        "",
        "",
        "",
      ],
      ...(scope.unclassified_items ?? []).map((item) => {
        const key = [
          scope.period,
          normalizeText(item?.source_sha256),
          normalizeText(item?.sheet),
          normalizeText(item?.source_cell),
          item?.source_row ?? "",
          normalizeText(item?.source_path),
          Number(item?.amount ?? 0),
        ].join("|");
        const binding = bindingBySourceItem.get(key) ?? null;
        const ownerBound = binding?.binding_status === "OWNER_APPROVED_BINDING";
        return [
          scope.period,
          item.source_scope_role,
          ownerBound
            ? "BINDING_REPAIR_PROVEN / UPDATE_MAPPING / БЕЗ ПРОВОДКИ"
            : "UNCLASSIFIED / EMPTY_ARTICLE",
          null,
          null,
          null,
          null,
          item.amount,
          item.source_label,
          "",
          item.source_path,
          [item.sheet, item.source_cell || item.source_row].filter(Boolean).join("!"),
          0,
          binding?.erp_article ?? "",
          binding?.target_code ?? "",
          ownerBound ? "UPDATE_MAPPING / NO_POSTING" : "REVIEW_ONLY / NO_POSTING",
        ];
      }),
    ]);
    const endRow = 4 + rows.length;
    styleTitle(
      intalevBlankArticleSheet,
      "A1:P1",
      `Пустые / неклассифицированные статьи Инталев — ${periodLabel}`,
    );
    intalevBlankArticleSheet.getRange("A2:P2").merge();
    intalevBlankArticleSheet.getRange("A2").values = [[
      "Дополнительный реестр: он не заменяет основное дерево. Пустая статья не означает отсутствие суммы; значения также показаны под родителем в 01_Сверка_дерево и включены в all-in один раз. Статья Инталев не подставляется; утверждённая ERP-классификация показывается отдельно. Финансовые строки и STORNO не разрешаются.",
    ]];
    intalevBlankArticleSheet.getRange("A2:P2").format = {
      fill: colors.yellow,
      font: { bold: true, color: "#9C5700" },
      wrapText: true,
    };
    writeValues(intalevBlankArticleSheet, 4, 1, [[
      "Период",
      "Тип строки",
      "Статус / классификация",
      "Инталев all-in / контроль",
      "Инталев классифицировано",
      "Инталев пустая статья",
      "Дельта сохранности",
      "Сумма исходной строки",
      "Исходная метка",
      "Статья Инталев",
      "Исходный путь",
      "Лист / ячейка",
      "Финансовая authority",
      "Статья ERP",
      "Код цели",
      "Решение",
    ]]);
    styleHeader(intalevBlankArticleSheet.getRange("A4:P4"));
    writeValues(intalevBlankArticleSheet, 5, 1, rows);
    if (rows.length > 0) {
      styleData(intalevBlankArticleSheet.getRange(`A5:P${endRow}`));
      intalevBlankArticleSheet.getRange(`D5:H${endRow}`).format.numberFormat =
        '#,##0.00;[Red](#,##0.00);-';
      intalevBlankArticleSheet.getRange(`C5:C${endRow}`).conditionalFormats.add(
        "containsText",
        {
          text: "BLOCKED",
          format: { fill: colors.red, font: { color: "#9C0006", bold: true } },
        },
      );
      intalevBlankArticleSheet.getRange(`C5:C${endRow}`).conditionalFormats.add(
        "containsText",
        {
          text: "UNCLASSIFIED",
          format: { fill: colors.yellow, font: { color: "#9C5700", bold: true } },
        },
      );
      intalevBlankArticleSheet.getRange(`I5:P${endRow}`).format.wrapText = true;
    }
    setColumnWidths(
      intalevBlankArticleSheet,
      [12, 24, 38, 20, 20, 20, 18, 18, 40, 24, 72, 24, 20, 28, 16, 30],
      endRow,
    );
    intalevBlankArticleSheet.freezePanes.freezeRows(4);
    intalevBlankArticleSheet.freezePanes.freezeColumns(2);
    return endRow;
  }

  function buildErpRows() {
    const usedBy = new Map();
    for (const month of monthly) {
      for (const row of month.rows) {
        for (const trace of row.erp.trace ?? []) {
          const key = `${month.period}|${trace.row}`;
          if (!usedBy.has(key)) usedBy.set(key, new Set());
          usedBy.get(key).add(row.code);
        }
      }
    }
    const records = erpParsed.flatMap((parsed) =>
      parsed.rows.map((row) => {
        const key = `${parsed.period}|${row.row}`;
        return {
          ...row,
          kind: row.article
            ? row.child_indexes.length > 0
              ? "GROUP"
              : "DETAIL"
            : "SUMMARY",
          used_by: [...(usedBy.get(key) ?? [])].sort().join(", "),
        };
      }),
    );
    const endRow = 4 + records.length;
    styleTitle(erpSheet, "A1:V1", `Все строки ERP — ${periodLabel}`);
    erpSheet.getRange("A2:V2").merge();
    erpSheet.getRange("A2").values = [[
      "Иерархия восстановлена без организационных измерений. ЦФО/подразделение может присутствовать или отсутствовать; при сверке суммы схлопываются по статье ОПИУ.",
    ]];
    erpSheet.getRange("A2:V2").format = {
      fill: colors.yellow,
      font: { bold: true, color: "#9C5700" },
    };
    writeValues(erpSheet, 4, 1, [[
      "Период",
      "Тип",
      "Итоговая строка",
      "Статья ERP",
      "ЦФО / подразделение (справочно)",
      "Сумма",
      "Используется строками",
      "Покрытие",
      "Файл",
      "Лист",
      "Строка",
      "SHA-256",
      "Уровень",
      "Родительский путь ERP",
      "Полный путь ERP",
      "Статус справочника",
      "Путь по справочнику ERP",
      "Код статьи",
      "Счёт/признак счёта",
      "Сумма прямых детей",
      "Дельта иерархии",
      "Контроль иерархии",
    ]]);
    styleHeader(erpSheet.getRange("A4:V4"));
    writeValues(
      erpSheet,
      5,
      1,
      records.map((record) => [
        record.period,
        record.kind,
        record.summary_label,
        record.article,
        record.cfo,
        record.amount,
        record.used_by,
        null,
        record.source_file,
        record.sheet,
        record.row,
        record.sha256,
        record.level,
        record.parent_path,
        record.full_path,
        record.catalog_status,
        record.catalog_path,
        record.catalog_codes,
        record.catalog_accounts,
        record.child_sum,
        record.hierarchy_delta,
        record.hierarchy_status,
      ]),
    );
    writeFormulas(
      erpSheet,
      5,
      8,
      records.map((_, index) => {
        const row = index + 5;
        return [
          `=IF(B${row}="SUMMARY","SUMMARY",IF(OR(F${row}=0,F${row}=""),"ZERO_NO_ACTIVITY",IF(P${row}<>"MATCHED","CATALOG_"&P${row},IF(G${row}="","UNMAPPED","MATCHED"))))`,
        ];
      }),
    );
    styleData(erpSheet.getRange(`A5:V${endRow}`));
    erpSheet.getRange(`F5:F${endRow}`).format.numberFormat =
      '#,##0.00;[Red](#,##0.00);-';
    erpSheet.getRange(`T5:U${endRow}`).format.numberFormat =
      '#,##0.00;[Red](#,##0.00);-';
    erpSheet.getRange(`F5:F${endRow}`).format.fill = colors.blueLight;
    erpSheet.getRange(`H5:H${endRow}`).conditionalFormats.add("containsText", {
      text: "UNMAPPED",
      format: { fill: colors.red, font: { color: "#9C0006", bold: true } },
    });
    erpSheet.getRange(`H5:H${endRow}`).conditionalFormats.add("containsText", {
      text: "CATALOG_AMBIGUOUS",
      format: { fill: colors.yellow, font: { color: "#9C5700", bold: true } },
    });
    erpSheet.getRange(`H5:H${endRow}`).conditionalFormats.add("containsText", {
      text: "CATALOG_MISSING",
      format: { fill: colors.red, font: { color: "#9C0006", bold: true } },
    });
    erpSheet.getRange(`H5:H${endRow}`).conditionalFormats.add("containsText", {
      text: "BLOCKED",
      format: { fill: colors.red, font: { color: "#9C0006", bold: true } },
    });
    erpSheet.getRange(`V5:V${endRow}`).conditionalFormats.add("containsText", {
      text: "BLOCKED",
      format: { fill: colors.red, font: { color: "#9C0006", bold: true } },
    });
    erpSheet.getRange(`C5:E${endRow}`).format.wrapText = true;
    erpSheet.getRange(`N5:S${endRow}`).format.wrapText = true;
    setColumnWidths(
      erpSheet,
      [
        12, 12, 42, 48, 42, 16, 30, 22, 60, 14, 10, 68,
        10, 65, 85, 20, 85, 18, 24, 18, 18, 20,
      ],
      endRow,
    );
    erpSheet.freezePanes.freezeRows(4);
    erpSheet.freezePanes.freezeColumns(2);
    return endRow;
  }

  function buildCrossJournalDiscrepancies() {
    if (!crossJournalSheet) return { endRow: 0, businessRowCount: 0 };
    const evidenceRows = Array.isArray(crossJournalEvidence?.rows)
      ? crossJournalEvidence.rows
      : [];
    const rows = evidenceRows.map((row) => [
      row.classification ?? "",
      row.row_type ?? "",
      row.confidence ?? 0,
      row.period ?? "",
      row.block_intalev ?? "",
      row.article_intalev ?? "",
      row.article_erp ?? "",
      row.amount ?? null,
      row.date ?? "",
      row.debit ?? "",
      row.credit ?? "",
      row.analytics ?? "",
      row.content ?? "",
      row.intalev_document ?? "",
      row.intalev_rows ?? "",
      row.erp_document ?? "",
      row.erp_rows ?? "",
      row.reason ?? "",
      row.action ?? "",
      row.reused === true ? "ДА — ОШИБКА КОНТРОЛЯ" : "НЕТ",
      row.intalev_source_row_id ?? "",
      row.erp_source_row_id ?? "",
      row.intalev_path ?? "",
      row.erp_path ?? "",
      row.source_block_erp ?? "",
      row.target_block_intalev ?? "",
      row.source_article_code_erp ?? "",
      row.source_operating_account ?? "",
      row.target_article_erp ?? "",
      row.target_article_code_erp ?? "",
      row.target_operating_account ?? "",
      row.target_catalog_path ?? "",
      row.target_status ?? "",
    ]);
    const endRow = Math.max(5, 4 + rows.length);
    const counts = crossJournalEvidence?.counts ?? {};
    styleTitle(
      crossJournalSheet,
      "A1:AG1",
      `Сопоставление физических проводок Инталев ↔ ERP — ${periodLabel}`,
    );
    crossJournalSheet.getRange("A2:AG2").merge();
    crossJournalSheet.getRange("A2").values = [[
      `REPORT_ONLY — пара ищется по физическим журналам: дата + сумма + расчётная сторона + содержание + общие аналитики. Счёт затрат может различаться — это признак межгрупповой переклассификации. Уникальных пар: ${counts.unique_pairs ?? 0}; пересортов: ${counts.different_article_pairs ?? 0}; доказанных межгрупповых целей: ${counts.proven_intergroup_reposts ?? 0}; неоднозначных: ${counts.ambiguous_pairs ?? 0}.`,
    ]];
    crossJournalSheet.getRange("A2:AG2").format = {
      fill: colors.yellow,
      font: { bold: true, color: "#7F6000" },
      wrapText: true,
      rowHeight: 46,
    };
    writeValues(crossJournalSheet, 4, 1, [[...CROSS_JOURNAL_DISCREPANCY_HEADERS]]);
    styleHeader(crossJournalSheet.getRange("A4:AG4"));
    if (rows.length > 0) {
      writeValues(crossJournalSheet, 5, 1, rows);
      styleData(crossJournalSheet.getRange(`A5:AG${4 + rows.length}`));
      crossJournalSheet.getRange(`C5:C${4 + rows.length}`).format.numberFormat = "0";
      crossJournalSheet.getRange(`H5:H${4 + rows.length}`).format.numberFormat =
        '#,##0.00;[Red](#,##0.00);-';
      crossJournalSheet.getRange(`E5:AG${4 + rows.length}`).format.wrapText = true;
      crossJournalSheet.getRange(`A5:A${4 + rows.length}`).conditionalFormats.add(
        "containsText",
        {
          text: "ПЕРЕСОРТ",
          format: { fill: colors.yellow, font: { color: "#9C5700", bold: true } },
        },
      );
      crossJournalSheet.getRange(`A5:A${4 + rows.length}`).conditionalFormats.add(
        "containsText",
        {
          text: "ОДНА СТАТЬЯ",
          format: { fill: colors.green, font: { color: "#006100", bold: true } },
        },
      );
      crossJournalSheet.getRange(`A5:A${4 + rows.length}`).conditionalFormats.add(
        "containsText",
        {
          text: "НЕОДНОЗНАЧНОЕ",
          format: { fill: colors.yellow, font: { color: "#9C5700", bold: true } },
        },
      );
      crossJournalSheet.getRange(`A5:A${4 + rows.length}`).conditionalFormats.add(
        "containsText",
        {
          text: "ДУБЛЬ",
          format: { fill: colors.red, font: { color: "#9C0006", bold: true } },
        },
      );
      crossJournalSheet.getRange(`T5:T${4 + rows.length}`).conditionalFormats.add(
        "containsText",
        {
          text: "ОШИБКА",
          format: { fill: colors.red, font: { color: "#9C0006", bold: true } },
        },
      );
    } else {
      crossJournalSheet.getRange("A5:AG5").merge();
      crossJournalSheet.getRange("A5").values = [[
        "INFO_NO_CROSS_JOURNAL_ROWS — в выбранном периоде нет строк сопоставления журналов.",
      ]];
      crossJournalSheet.getRange("A5:AG5").format.fill = colors.yellow;
    }
    setColumnWidths(
      crossJournalSheet,
      [
        38, 24, 14, 12, 30, 36, 36, 16, 14, 10, 10, 42,
        54, 46, 16, 46, 16, 76, 68, 24, 44, 44, 72, 72,
        34, 34, 22, 20, 36, 22, 20, 72, 34,
      ],
      endRow,
    );
    crossJournalSheet.freezePanes.freezeRows(4);
    crossJournalSheet.freezePanes.freezeColumns(7);
    return { endRow, businessRowCount: evidenceRows.length };
  }

  function buildCrossJournalCorrectionDecisions() {
    if (!crossJournalCorrectionSheet) return { endRow: 0, businessRowCount: 0 };
    const declaredCorrectionDecisionRows = Number(
      crossJournalEvidence?.correction_decision_rows ?? 0,
    );
    const proven = (Array.isArray(crossJournalEvidence?.rows) ? crossJournalEvidence.rows : [])
      .filter((row) => row.financial_gate_status === "ДОКАЗАНО")
      .filter((row) => Array.isArray(row.correction_rows) && row.correction_rows.length === 2)
      .filter((row) => Math.abs(row.correction_rows.reduce(
        (sum, correctionRow) => sum + Number(correctionRow.amount ?? 0),
        0,
      )) < 0.005);
    const headers = CROSS_JOURNAL_CORRECTION_HEADERS;
    const rows = proven.flatMap((row) => {
      const sourceCorrection = row.correction_rows.find((item) => item.operation === "STORNO");
      const targetCorrection = row.correction_rows.find((item) => item.operation === "REPOST");
      if (!sourceCorrection || !targetCorrection) return [];
      const suffix = normalizeText(row.erp_source_row_id).slice(0, 24) || String(row.erp_rows);
      const caseId = `XJ-${suffix}`;
      const pairId = `PAIR-${suffix}`;
      const amount = Math.abs(Number(sourceCorrection.amount));
      const debitAnalytics = Array.isArray(sourceCorrection.debit_analytics)
        ? sourceCorrection.debit_analytics
        : [];
      const creditAnalytics = Array.isArray(sourceCorrection.credit_analytics)
        ? sourceCorrection.credit_analytics
        : [];
      const physical = [
        row.source_archive_path ?? "", row.source_archive_sha256 ?? "", row.journal_entry ?? "",
        row.journal_sha256 ?? "", row.source_sheet ?? "", sourceCorrection.source_row_id ?? "",
        sourceCorrection.source_range ?? `B${row.erp_rows}:AG${row.erp_rows}`,
        sourceCorrection.date_value || sourceCorrection.date || "",
        sourceCorrection.document ?? "", sourceCorrection.posting_no ?? "", sourceCorrection.debit ?? "",
        debitAnalytics[0] ?? "", debitAnalytics[1] ?? "", debitAnalytics[2] ?? "",
        sourceCorrection.debit_department ?? "", sourceCorrection.credit ?? "",
        creditAnalytics[0] ?? "", creditAnalytics[1] ?? "", creditAnalytics[2] ?? "",
        sourceCorrection.credit_department ?? "", organization, organization,
        sourceCorrection.organization ?? "", amount, amount,
      ];
      const common = [
        "STORNO_REPOST", "ДОКАЗАНО_СВЕРКОЙ", row.period ?? periodLabel,
      ];
      const proof = [
        "FINANCIAL_RECLASS", "INTER_GROUP", "ECONOMIC_RECLASS_PROVEN",
      ];
      const tail = [
        row.reason ?? "", row.action ?? "", sourceCorrection.article ?? row.source_article ?? row.article_erp ?? "",
        row.source_operating_account ?? "", targetCorrection.article ?? row.target_article_erp ?? "",
        targetCorrection.article_code ?? row.target_article_code_erp ?? "", 1, targetCorrection.article_block ?? row.target_block_intalev ?? "",
        row.intalev_path ?? "", row.target_catalog_path ?? "",
        row.target_operating_account ?? "",
        `Инталев: ${row.intalev_document ?? ""}, строки ${row.intalev_rows ?? ""}; ERP: ${row.erp_document ?? ""}, строка ${row.erp_rows ?? ""}.`,
      ];
      const sourceRow = [
        caseId, pairId, ...common,
        `XJS-${suffix}`, sourceCorrection.article ?? row.article_erp ?? row.source_article ?? "",
        sourceCorrection.article ?? row.source_article ?? row.article_erp ?? "", "RECLASS_SOURCE",
        ...proof, sourceCorrection.amount, true, true, true, true, true,
        ...physical, ...tail,
      ];
      const targetRow = [
        caseId, pairId, ...common,
        `XJT-${suffix}`, targetCorrection.article ?? row.target_article_erp ?? "", targetCorrection.article ?? row.target_article_erp ?? "",
        "RECLASS_TARGET", ...proof, targetCorrection.amount, true, true, true, true, true,
        ...physical, ...tail,
      ];
      return [sourceRow, targetRow];
    });
    const endRow = Math.max(5, 4 + rows.length);
    styleTitle(
      crossJournalCorrectionSheet,
      `A1:${columnName(headers.length)}1`,
      `Доказанные решения для движка корректировок R001 — ${periodLabel}`,
    );
    crossJournalCorrectionSheet.getRange(`A2:${columnName(headers.length)}2`).merge();
    crossJournalCorrectionSheet.getRange("A2").values = [[
      `REPORT_ONLY — каждый CaseID содержит две равные строки: STORNO с фактического кода статьи ERP и REPOST на одноимённую статью внутри блока Инталев. Доказанных межгрупповых переносов: ${proven.length}; заявлено строк решений: ${declaredCorrectionDecisionRows}; фактически записано: ${rows.length}. Счета Дт/Кт физической проводки не подменяются — меняется код статьи ОПИУ.`,
    ]];
    crossJournalCorrectionSheet.getRange(`A2:${columnName(headers.length)}2`).format = {
      fill: colors.green,
      font: { bold: true, color: "#006100" },
      wrapText: true,
      rowHeight: 46,
    };
    writeValues(crossJournalCorrectionSheet, 4, 1, [headers]);
    styleHeader(crossJournalCorrectionSheet.getRange(`A4:${columnName(headers.length)}4`));
    if (rows.length > 0) {
      writeValues(crossJournalCorrectionSheet, 5, 1, rows);
      styleData(crossJournalCorrectionSheet.getRange(`A5:${columnName(headers.length)}${4 + rows.length}`));
      crossJournalCorrectionSheet.getRange(`M5:M${4 + rows.length}`).format.numberFormat =
        '#,##0.00;[Red]-#,##0.00;0.00';
      crossJournalCorrectionSheet.getRange(`AP5:AQ${4 + rows.length}`).format.numberFormat =
        '#,##0.00;[Red]-#,##0.00;0.00';
      crossJournalCorrectionSheet.getRange(`A5:A${4 + rows.length}`).format.font = { bold: true };
    } else {
      const infoRow = [
        "INFO_NO_R001_DECISION_ROWS",
        ...Array.from({ length: headers.length - 1 }, () => ""),
      ];
      writeValues(crossJournalCorrectionSheet, 5, 1, [infoRow]);
      styleData(crossJournalCorrectionSheet.getRange(`A5:${columnName(headers.length)}5`));
      crossJournalCorrectionSheet.getRange(`A5:${columnName(headers.length)}5`).format.fill = colors.yellow;
    }
    setColumnWidths(
      crossJournalCorrectionSheet,
      headers.map((_, index) => index < 18 ? 20 : index < 43 ? 24 : 36),
      endRow,
    );
    crossJournalCorrectionSheet.freezePanes.freezeRows(4);
    crossJournalCorrectionSheet.freezePanes.freezeColumns(9);
    return { endRow, businessRowCount: rows.length };
  }

  function buildIssues() {
    const issues = [];
    for (const month of monthly) {
      for (const row of month.rows) {
        if (
          row.comparison_mode === "INFORMATIONAL_COVERED" ||
          row.erp.status === "INFORMATIONAL_COVERED"
        ) {
          continue;
        }
        const delta =
          typeof row.intalev.amount === "number" && typeof row.erp.amount === "number"
            ? roundMoney(row.intalev.amount - row.erp.amount)
            : null;
        const mappingProblem =
          !acceptedStatus(row.intalev.status) || !acceptedStatus(row.erp.status);
        if (mappingProblem || delta === null || Math.abs(delta) > tolerance) {
          issues.push([
            month.period,
            row.code,
            row.intalev_label,
            row.erp_label,
            delta,
            row.intalev.status,
            row.erp.status,
            mappingProblem
              ? "Проверить точное сопоставление и полный путь."
              : "Расшифровать дельту по текущему ERP.",
            `${traceText(
              month.period,
              row.intalev.trace,
              8,
              "03_Инталев_узлы",
            )} | ${traceText(
              month.period,
              row.erp.trace,
              8,
              "04_ERP_статьи",
            )}`,
          ]);
        }
      }
    }
    const endRow = Math.max(5, 4 + issues.length);
    styleTitle(issuesSheet, "A1:I1", `Несопоставленные строки — ${periodLabel}`);
    issuesSheet.getRange("A2:I2").merge();
    issuesSheet.getRange("A2").values = [[
      "Список не является перечнем проводок. UPDATE_MAPPING, UPDATE_FORMULA и расхождения остаются диагностикой.",
    ]];
    issuesSheet.getRange("A2:I2").format = {
      fill: colors.red,
      font: { bold: true, color: "#9C0006" },
    };
    writeValues(issuesSheet, 4, 1, [[
      "Период",
      "Код",
      "Строка Инталев",
      "Строка ERP",
      "Дельта",
      "Статус Инталев",
      "Статус ERP",
      "Что проверить",
      "Трасса",
    ]]);
    styleHeader(issuesSheet.getRange("A4:I4"));
    if (issues.length > 0) {
      writeValues(issuesSheet, 5, 1, issues);
      styleData(issuesSheet.getRange(`A5:I${4 + issues.length}`));
      issuesSheet.getRange(`E5:E${4 + issues.length}`).format.numberFormat =
        '#,##0.00;[Red](#,##0.00);-';
      issuesSheet.getRange(`E5:G${4 + issues.length}`).format.fill = colors.red;
      issuesSheet.getRange(`C5:I${4 + issues.length}`).format.wrapText = true;
    } else {
      issuesSheet.getRange("A5:I5").merge();
      issuesSheet.getRange("A5").values = [["Нет строк для проверки."]];
      issuesSheet.getRange("A5:I5").format.fill = colors.green;
    }
    setColumnWidths(issuesSheet, [12, 10, 42, 42, 16, 24, 24, 48, 80], endRow);
    issuesSheet.freezePanes.freezeRows(4);
    return endRow;
  }

  function buildSources() {
    const rows = [];
    for (const period of periods) {
      const meta = snapshot.files.find((file) => file.period === period);
      rows.push([
        snapshot.source_kind === "RUN_SELECTED"
          ? "ИНТАЛЕВ_SELECTED"
          : "ИНТАЛЕВ_FIXED",
        period,
        path.resolve(appDir, meta.stored_path),
        "TDSheet",
        meta.sha256,
        meta.size,
        snapshot.snapshot_id,
        meta.original_path,
        snapshot.source_kind === "RUN_SELECTED" ? "SELECTED" : "FIXED",
        snapshot.source_kind === "RUN_SELECTED"
          ? "Выбран пользователем; хэш проверен до и после чтения."
          : "Хэш проверен перед расчётом.",
      ]);
      const parsed = erpParsed.find((item) => item.period === period);
      rows.push([
        "ERP_CURRENT",
        period,
        parsed.source_file,
        parsed.sheet,
        parsed.sha256,
        null,
        runIdFromWorkDir(workDir),
        parsed.input_origin || parsed.source_file,
        "CURRENT",
        [
          "Новый ERP текущего запуска.",
          parsed.source_modified ? `Изменён: ${parsed.source_modified}.` : "",
          parsed.archive_entry ? `Файл в архиве: ${parsed.archive_entry}.` : "",
        ]
          .filter(Boolean)
          .join(" "),
      ]);
    }
    const verifiedJournalSha256 = operationEvidence?.source_trace?.journals?.length === 1
      ? String(operationEvidence.source_trace.journals[0].sha256 ?? "").toUpperCase()
      : "";
    for (const source of sortErpContainerSources(erpContainerSourceRegistry)) {
      const sourcePeriod = String(source.archiveEntry ?? source.path ?? "")
        .match(/20\d{2}[_-](?:0[1-9]|1[0-2])/u)?.[0]
        ?.replace("_", "-") ?? periodLabel;
      const journalIsVerified =
        source.role === "ERP_POSTING_JOURNAL" &&
        operationEvidence?.journal_verified === true &&
        verifiedJournalSha256 !== "" &&
        String(source.sha256 ?? "").toUpperCase() === verifiedJournalSha256;
      rows.push([
        `ERP_ARCHIVE_${String(source.role).replace(/^ERP_/u, "")}`,
        sourcePeriod,
        source.path,
        source.role,
        source.sha256,
        null,
        runIdFromWorkDir(workDir),
        source.inputPath,
        journalIsVerified ? "VERIFIED" : "DISCOVERED",
        [
          source.archiveEntry ? `Файл в архиве: ${source.archiveEntry}.` : "Прямой файл.",
          `Роль: ${source.role}.`,
          source.role === "ERP_OSV"
            ? "Обнаружение ERP ОСВ не означает выполнение парного контроля ОСВ."
            : "",
        ].filter(Boolean).join(" "),
      ]);
    }
    if (crossJournalEvidence?.sources?.intalev) {
      rows.push([
        "INTALEV_POSTING_JOURNAL",
        crossJournalEvidence.period,
        crossJournalEvidence.sources.intalev.path,
        crossJournalEvidence.sources.intalev.sheet,
        crossJournalEvidence.sources.intalev.sha256,
        null,
        runIdFromWorkDir(workDir),
        crossJournalEvidence.sources.intalev.path,
        "VERIFIED_FOR_DIAGNOSTIC_MATCH",
        "Физические проводки Инталев; используются только для взаимно-уникального сопоставления с ERP. Финансовая корректировка автоматически не создаётся.",
      ]);
    }
    if (crossJournalEvidence?.sources?.erp) {
      rows.push([
        "ERP_POSTING_JOURNAL_CROSS_MATCH",
        crossJournalEvidence.period,
        crossJournalEvidence.sources.erp.path,
        crossJournalEvidence.sources.erp.sheet,
        crossJournalEvidence.sources.erp.sha256,
        null,
        runIdFromWorkDir(workDir),
        crossJournalEvidence.sources.erp.path,
        "VERIFIED_FOR_DIAGNOSTIC_MATCH",
        "Физические проводки ERP; используются только для взаимно-уникального сопоставления с Инталев. Повторное использование строки запрещено.",
      ]);
    }
    rows.push([
      "REFERENCE_CATALOG_MANIFEST",
      periodLabel,
      referenceCatalogTrace.manifest.path,
      referenceCatalogTrace.schema,
      referenceCatalogTrace.manifest.sha256_after,
      referenceCatalogTrace.manifest.size,
      referenceCatalogTrace.version,
      referenceCatalogTrace.manifest.path,
      referenceCatalogTrace.manifest.status,
      `Финальный симметричный rehash; binding ${referenceCatalogTrace.binding_sha256}.`,
    ]);
    for (const catalog of referenceCatalogTrace.catalogs) {
      rows.push([
        `REFERENCE_${catalog.role.toUpperCase()}`,
        periodLabel,
        catalog.path,
        catalog.role,
        catalog.sha256_after,
        catalog.size,
        catalog.version,
        referenceCatalogTrace.manifest.path,
        catalog.status,
        `Назначение: ${catalog.usage.join(", ")}; SHA до/после: ${catalog.sha256_before} / ${catalog.sha256_after}.`,
      ]);
    }
    rows.push([
      "INTALEV_ARTICLE_CATALOG",
      periodLabel,
      intalevCatalog.source_file,
      intalevCatalog.sheet,
      intalevCatalog.sha256,
      null,
      "CURRENT_REFERENCE",
      intalevCatalog.source_file,
      intalevCatalogSourcesStatus(intalevCatalog),
      intalevCatalog.structured_parent_export === true &&
      intalevCatalog.hierarchy_tree?.status === "PASS"
        ? `UID classifier; semantic sheet ${intalevCatalog.sheet}; inspected sheets: ${intalevCatalog.workbook_selection?.inspected_sheets?.length ?? 1}.`
        : `UID classifier is not active; valid semantic sheets: ${intalevCatalog.workbook_selection?.valid_sheet_count ?? 0}; no financial matching authority granted.`,
    ]);
    rows.push([
      "ERP_ARTICLE_CATALOG",
      periodLabel,
      erpCatalog.source_file,
      erpCatalog.sheet,
      erpCatalog.sha256,
      null,
      "CURRENT_REFERENCE",
      erpCatalog.source_file,
      "ACTIVE",
      "Иерархия, группировки, коды и счета статей ERP.",
    ]);
    rows.push([
      "TEMPLATE",
      periodLabel,
      path.resolve(config.template_path),
      "02_Месяц",
      templateHash,
      null,
      null,
      path.resolve(config.template_path),
      "REFERENCE",
      "Структура R001–R065.",
    ]);
    if (intalevTemplateGraph) {
      rows.push([
        "INTALEV_TEMPLATE_GRAPH",
        periodLabel,
        intalevTemplateGraph.graph_path,
        `${intalevTemplateGraph.source_sheet}!${intalevTemplateGraph.source_range}`,
        intalevTemplateGraph.graph_sha256,
        sourceProvenance.intalev_template_graph?.size_after ?? null,
        intalevTemplateGraph.graph_id,
        intalevTemplateGraph.template_path,
        intalevTemplateGraph.approval.status,
        `Reference Intalev structure only; template SHA-256 ${intalevTemplateGraph.template_sha256}; basis ${intalevTemplateGraph.source_basis}; ERP used=false; Rules/R001/financial authority=false.`,
      ]);
    }
    rows.push([
      "RULES",
      periodLabel,
      rulesPath,
      profile.id,
      rulesHash,
      null,
      profile.projectRules,
      rulesPath,
      machinePolicy ? "ACTIVE_EXECUTED_FAIL_CLOSED" : "ACTIVE",
      profile.rulesNote,
    ]);
    const endRow = 4 + rows.length;
    styleTitle(sourcesSheet, "A1:J1", `Источники и версии — ${periodLabel}`);
    sourcesSheet.getRange("A2:J2").merge();
    sourcesSheet.getRange("A2").values = [[
      "Для каждого файла сохранены система, период, путь и SHA-256.",
    ]];
    sourcesSheet.getRange("A2:J2").format.fill = colors.blueLight;
    writeValues(sourcesSheet, 4, 1, [[
      "Система",
      "Период",
      "Рабочий путь",
      "Лист",
      "SHA-256",
      "Размер",
      "Версия/снимок",
      "Исходный путь",
      "Статус",
      "Примечание",
    ]]);
    styleHeader(sourcesSheet.getRange("A4:J4"));
    writeValues(sourcesSheet, 5, 1, rows);
    styleData(sourcesSheet.getRange(`A5:J${endRow}`));
    sourcesSheet
      .getRange(`G5:G${4 + periods.length * 2}`)
      .format.numberFormat = "0";
    sourcesSheet.getRange(`C5:J${endRow}`).format.wrapText = true;
    setColumnWidths(
      sourcesSheet,
      [32, 12, 70, 26, 68, 14, 26, 70, 20, 48],
      endRow,
    );
    sourcesSheet.freezePanes.freezeRows(4);
    return endRow;
  }

  function buildJournalCandidates() {
    if (!journalCandidatesSheet) return { endRow: 0, businessRowCount: 0 };
    const candidates = operationEvidence.unassigned_rows ?? [];
    const rows = candidates.map((row) => [
      row.period ?? "",
      row.journal_input_path || row.journal_source || "",
      row.journal_sheet || "",
      row.physical_row ?? "",
      row.document ?? "",
      row.posting_no ?? "",
      row.date_value || row.date || "",
      row.debit ?? "",
      (row.debit_analytics ?? []).join(" | "),
      row.credit ?? "",
      (row.credit_analytics ?? []).join(" | "),
      row.amount ?? "",
      row.organization ?? "",
      row.article ?? "",
      row.row_class ?? "",
      "НЕ ФОРМИРОВАТЬ ПРОВОДКУ",
      row.reason ?? "",
    ]);
    const endRow = Math.max(5, 4 + rows.length);
    styleTitle(
      journalCandidatesSheet,
      "A1:Q1",
      `Операции журнала для проверки — ${periodLabel}`,
    );
    journalCandidatesSheet.getRange("A2:Q2").merge();
    journalCandidatesSheet.getRange("A2").values = [[
      `REPORT_ONLY — только строки точной организации и периода, для которых связь с R-кодом не доказана. Точно привязаны и показаны под строками дельт: ${operationEvidence?.exact_bound_operation_rows ?? 0}; R-коды: ${(operationEvidence?.exact_bound_r_codes ?? []).join(", ") || "нет"}. Все строки исключены из итогов, проводки не формируются.`,
    ]];
    journalCandidatesSheet.getRange("A2:Q2").format = {
      fill: colors.yellow,
      font: { bold: true, color: "#9C5700" },
      wrapText: true,
    };
    writeValues(journalCandidatesSheet, 4, 1, [[...JOURNAL_OPERATION_HEADERS]]);
    styleHeader(journalCandidatesSheet.getRange("A4:Q4"));
    if (rows.length > 0) {
      writeValues(journalCandidatesSheet, 5, 1, rows);
      styleData(journalCandidatesSheet.getRange(`A5:Q${endRow}`));
      journalCandidatesSheet.getRange(`L5:L${endRow}`).format.numberFormat =
        '#,##0.00;[Red](#,##0.00);-';
      journalCandidatesSheet.getRange(`O5:Q${endRow}`).format.fill = colors.yellow;
      journalCandidatesSheet.getRange(`B5:Q${endRow}`).format.wrapText = true;
    } else {
      const infoRow = [
        "INFO_NO_JOURNAL_OPERATION_ROWS",
        ...Array.from({ length: JOURNAL_OPERATION_HEADERS.length - 1 }, () => ""),
      ];
      writeValues(journalCandidatesSheet, 5, 1, [infoRow]);
      styleData(journalCandidatesSheet.getRange("A5:Q5"));
      journalCandidatesSheet.getRange("A5:Q5").format.fill = colors.yellow;
    }
    setColumnWidths(
      journalCandidatesSheet,
      [12, 58, 18, 13, 46, 13, 18, 12, 42, 12, 42, 16, 28, 36, 24, 28, 58],
      endRow,
    );
    journalCandidatesSheet.freezePanes.freezeRows(4);
    journalCandidatesSheet.freezePanes.freezeColumns(4);
    return { endRow, businessRowCount: rows.length };
  }

  function buildProvenOperations() {
    if (!provenOperationsSheet) return { endRow: 0, businessRowCount: 0 };
    const headers = [
      "PairID", "Строка сверки", "Группа", "Роль", "ERP диапазон", "Дата",
      "Регистратор", "№ проводки", "Дт", "Аналитики Дт", "Подразделение Дт",
      "Кт", "Аналитики Кт", "Подразделение Кт", "Организация", "Физическая сумма",
      "Сумма кандидата", "STORNO", "REPOST", "Исходная статья", "Целевая статья",
      "Источник → цель", "Причина", "Предлагаемое решение", "Статус",
      "SHA-256 ERP пакета", "SHA-256 ERP ОПИУ", "SHA-256 ERP журнала",
      "Лист ERP журнала", "SourceRowID",
    ];
    const rows = provenOperationWorkbookRows(operationEvidence).rows;
    const endRow = 4 + rows.length;
    styleTitle(
      provenOperationsSheet,
      "A1:AD1",
      `Доказанные физические операции ERP — ${periodLabel}`,
    );
    provenOperationsSheet.getRange("A2:AD2").merge();
    provenOperationsSheet.getRange("A2").values = [[
      "SOURCE_OPERATION_PROVEN фиксирует физическую идентичность. Эти строки не являются проводками корректировки и не разрешают STORNO/REPOST без отдельного ECONOMIC_CORRECTION_PROVEN.",
    ]];
    provenOperationsSheet.getRange("A2:AD2").format = {
      fill: colors.yellow,
      font: { bold: true, color: "#9C5700" },
      wrapText: true,
    };
    writeValues(provenOperationsSheet, 4, 1, [headers]);
    styleHeader(provenOperationsSheet.getRange("A4:AD4"));
    writeValues(provenOperationsSheet, 5, 1, rows);
    if (rows.length > 0) {
      styleData(provenOperationsSheet.getRange(`A5:AD${endRow}`));
      provenOperationsSheet.getRange(`P5:S${endRow}`).format.numberFormat =
        '#,##0.00;[Red](#,##0.00);-';
      provenOperationsSheet.getRange(`W5:AD${endRow}`).format.wrapText = true;
    }
    setColumnWidths(
      provenOperationsSheet,
      [68, 14, 28, 14, 18, 18, 48, 14, 12, 42, 30, 12, 42, 30, 30, 18, 18, 18, 18, 36, 36, 42, 70, 70, 54, 68, 68, 68, 18, 68],
      endRow,
    );
    provenOperationsSheet.freezePanes.freezeRows(4);
    provenOperationsSheet.freezePanes.freezeColumns(5);
    return { endRow, businessRowCount: rows.length };
  }

  function buildControls() {
    const summaryStart = 7;
    const summaryEnd = 6 + aggregateRows.length;
    const monthlyStart = 5;
    const monthlyEnd = 4 + monthly.reduce((sum, month) => sum + month.rows.length, 0);
    const intalevEnd =
      4 + intalevParsed.reduce((sum, parsed) => sum + parsed.nodes.length, 0);
    const erpEnd = 4 + erpParsed.reduce((sum, parsed) => sum + parsed.rows.length, 0);
    const unclassifiedSourceRows = intalevSourceScopes.reduce(
      (sum, scope) => sum + (scope.unclassified_items?.length ?? 0),
      0,
    );
    const intalevSourceScopeBlocked = intalevSourceScopes.some(
      (scope) => scope.source_amount_lost === true,
    );
    const structuralControlRows = reportStructuralControlResults.map((control) => [
      `Структурное исключение: ${control.control_set_id}`,
      control.control_sum_delta,
      control.classification === "STRUCTURAL_GROUP_SUM_OK" ? "PASS" : "BLOCKED",
      [
        `mode=${control.mode}`,
        `members=${(control.member_codes ?? []).join(",")}`,
        `raw_delta=${(control.member_rows ?? []).map((member) => `${member.code}:${member.raw_delta}`).join(";")}`,
        `effective_delta=${(control.member_rows ?? []).map((member) => `${member.code}:${member.effective_delta}`).join(";")}`,
        `tolerance=${control.tolerance}`,
        `descendant_internal_checks_active=${control.descendant_internal_checks_active === true}`,
        "structural_control_financial_posting_rows=0",
      ].join("; "),
    ]);
    const structuralControlDetail = buildStructuralControlReportDetail({
      controls: reportStructuralControlResults,
      settingsAudit: structuralControlSettingsAudit,
    });
    if (structuralControlDetail.financial_rows !== 0 || structuralControlDetail.posting_rows !== 0) {
      fail("BLOCKED_STRUCTURAL_CONTROL_REPORT_DETAIL_FINANCIAL_AUTHORITY");
    }
    const summaryEndRow = 25 + structuralControlRows.length;
    const detailTitleRow = summaryEndRow + 2;
    const detailHeaderRow = detailTitleRow + 1;
    const detailStartRow = detailHeaderRow + 1;
    const detailEndRow = structuralControlDetail.row_count > 0
      ? detailStartRow + structuralControlDetail.row_count - 1
      : detailHeaderRow;
    const endRow = detailEndRow;
    const journalPairCounts = crossJournalEvidence?.counts ?? {};
    const journalReuseCount = Number(journalPairCounts.reused_intalev_rows ?? 0) +
      Number(journalPairCounts.reused_erp_rows ?? 0);
    const operationEvidenceStatus = String(operationEvidence?.status ?? "NOT_APPLICABLE");
    const operationEvidenceControlStatus = crossJournalEvidence?.applicable === true
      ? "INFO"
      : operationEvidenceStatus.startsWith("PASS")
      ? "PASS"
      : operationEvidenceStatus === "NOT_APPLICABLE"
        ? "INFO"
        : "BLOCKED";
    const archiveSourceGate = buildArchiveSourceGateNarrative({
      journalVerified: operationEvidence?.journal_verified === true,
      sources: erpContainerSourceRegistry,
    });
    styleTitle(controlsSheet, "A1:D1", `Контроли отчёта — ${periodLabel}`);
    controlsSheet.getRange("A2:D2").merge();
    controlsSheet.getRange("A2").values = [[
      "PASS означает только контроль данного отчёта. Выпуск и загрузка не разрешены.",
    ]];
    controlsSheet.getRange("A2:D2").format = {
      fill: colors.yellow,
      font: { bold: true, color: "#9C5700" },
    };
    writeValues(controlsSheet, 4, 1, [[
      "Контроль",
      "Результат",
      "Статус",
      "Комментарий",
    ]]);
    styleHeader(controlsSheet.getRange("A4:D4"));
    writeValues(controlsSheet, 5, 1, [
      ["Хэши фиксированного Инталев", periods.length, "PASS", "Проверены перед расчётом."],
      ["Структура строк ОПИУ", aggregateRows.length, "PASS", "R001–R065."],
      ["Строки свода не сошлись", null, null, "См. 01_Сверка_ОПИУ."],
      ["Помесячные пропуски значений", null, null, "См. 02_Помесячно."],
      ["child_sum ≠ parent_total", null, null, "См. 03_Инталев_узлы."],
      ["ERP-статьи UNMAPPED/нет в справочнике", null, null, "См. 04_ERP_статьи."],
      ["ERP child_sum ≠ parent_total", null, null, "См. 04_ERP_статьи."],
      [
        "Инталев: пустые / неклассифицированные статьи",
        unclassifiedSourceRows,
        intalevSourceScopeBlocked ? "BLOCKED" : "PASS",
        "Пустые статьи показаны под родителем в 01_Сверка_дерево и дополнительно в 03A_Пустые_статьи; суммы входят в all-in один раз и не разрешают STORNO.",
      ],
      [
        "ОСВ Инталев/ERP",
        archiveSourceGate.osvControlValue,
        archiveSourceGate.osvControlStatus,
        archiveSourceGate.osvControlComment,
      ],
      [
        "Старая однофайловая трасса ERP (справочно)",
        operationEvidence?.display_operation_rows ?? 0,
        operationEvidenceControlStatus,
        `Не используется для межсистемной привязки Инталев ↔ ERP. status=${operationEvidenceStatus}; exact_bound_operation_rows=${operationEvidence?.exact_bound_operation_rows ?? 0}; candidate_excluded_rows=${operationEvidence?.candidate_excluded_rows ?? 0}.`,
      ],
      [
        "Старая трасса ERP: покрытие конечных строк (справочно)",
        `${operationEvidence?.proven_r_code_count ?? 0} / ${operationEvidence?.operation_bearing_terminal_rows ?? 0}`,
        crossJournalEvidence?.applicable === true
          ? "INFO"
          : operationEvidence?.operation_coverage_complete === true ? "PASS" : "BLOCKED",
        `Доказаны: ${(operationEvidence?.proven_r_codes ?? []).join(", ") || "нет"}. Заблокированы: ${(operationEvidence?.blocked_direct_leaf_nodes ?? []).join(", ") || "нет"}.`,
      ],
      [
        "Старая трасса ERP: доказанные строки (справочно)",
        operationEvidence?.source_contributor_rows ?? 0,
        crossJournalEvidence?.applicable === true
          ? "INFO"
          : operationEvidence?.source_operation_proof_verified === true ? "PASS" : "BLOCKED",
        `source_proof_status=${operationEvidence?.source_trace?.source_operation_proof_status ?? "SOURCE_OPERATION_UNPROVEN"}; journal_sha256=${operationEvidence?.journal_sha256 ?? "MISSING"}.`,
      ],
      [
        "Кандидаты показаны, но исключены из итогов",
        operationEvidence?.candidate_excluded_rows ?? 0,
        operationEvidence?.gates?.candidate_rows_excluded_from_totals === true ? "PASS" : "BLOCKED",
        "Жёлтые строки нужны только для проверки документов; count_in_parent=false.",
      ],
      [
        "Межсистемное сопоставление журналов Инталев ↔ ERP",
        journalPairCounts.unique_pairs ?? 0,
        crossJournalEvidence?.applicable === true ? "PASS" : "INFO",
        `Уникальных пар=${journalPairCounts.unique_pairs ?? 0}; межгрупповых=${journalPairCounts.proven_intergroup_reposts ?? 0}; неоднозначных=${journalPairCounts.ambiguous_pairs ?? 0}. Подробности: 04A_Расхождения_проводок.`,
      ],
      [
        "Статьи ERP, помещённые в группы Инталев по журналу",
        `${journalFirstAttribution.audit.structure_bindings_applied ?? 0} / ${journalFirstAttribution.audit.structure_binding_candidates ?? 0}`,
        Number(journalFirstAttribution.audit.structure_bindings_applied ?? 0) > 0 ? "PASS" : "INFO",
        `Применены только однозначные связи по физической операции. Родительских ERP-сумм восстановлено=${journalFirstAttribution.audit.journal_parent_rollups_applied ?? 0}.`,
      ],
      [
        "Родительские суммы ERP, восстановленные по привязанным статьям",
        journalFirstAttribution.audit.journal_parent_rollups_applied ?? 0,
        "PASS",
        (journalFirstAttribution.parent_rollups ?? []).map((item) =>
          `${item.parent_code}=${item.amount} (${item.child_codes.join(",")})`).join("; ") || "Не требовалось.",
      ],
      [
        "Повторное использование физических строк журналов",
        journalReuseCount,
        journalReuseCount === 0 ? "PASS" : "BLOCKED",
        `Фактически повторно использовано: Инталев=${journalPairCounts.reused_intalev_rows ?? 0}; ERP=${journalPairCounts.reused_erp_rows ?? 0}. Предотвращено конфликтов payroll=${journalPairCounts.payroll_intalev_reuse_conflicts ?? 0}.`,
      ],
      ["Корректировки", 0, "PASS", "REPORT_ONLY; проводки отсутствуют."],
      ["ready_to_upload", false, "BLOCKED", "Fail-closed."],
      ["release_allowed", false, "BLOCKED", archiveSourceGate.passportComment],
      ...structuralControlRows,
      ["Итоговый статус", profile.status, "BLOCKED", profile.controlsNote],
    ]);
    writeFormulas(controlsSheet, 7, 2, [
      [`=COUNTIF('01_Сверка_ОПИУ'!$J$${summaryStart}:$J$${summaryEnd},"РАСХОЖДЕНИЕ")+COUNTIF('01_Сверка_ОПИУ'!$J$${summaryStart}:$J$${summaryEnd},"ТРЕБУЕТ ПРОВЕРКИ")`, `=IF(B7=0,"PASS","BLOCKED")`],
      [`=COUNTBLANK('02_Помесячно'!$F$${monthlyStart}:$F$${monthlyEnd})+COUNTIFS('02_Помесячно'!$G$${monthlyStart}:$G$${monthlyEnd},"",'02_Помесячно'!$J$${monthlyStart}:$J$${monthlyEnd},"<>INFORMATIONAL_COVERED")`, `=IF(B8=0,"PASS","BLOCKED")`],
      [intalevHierarchyBlockedControlFormula(5, intalevEnd), `=IF(B9=0,"PASS","BLOCKED")`],
      [`=COUNTIF('04_ERP_статьи'!$H$5:$H$${erpEnd},"UNMAPPED")+COUNTIF('04_ERP_статьи'!$H$5:$H$${erpEnd},"CATALOG_*")`, `=IF(B10=0,"PASS","BLOCKED")`],
      [erpHierarchyBlockedControlFormula(5, erpEnd), `=IF(B11=0,"PASS","BLOCKED")`],
    ]);
    styleData(controlsSheet.getRange(`A5:D${summaryEndRow}`));
    controlsSheet.getRange(`C5:C${summaryEndRow}`).conditionalFormats.add("containsText", {
      text: "PASS",
      format: { fill: colors.green, font: { color: "#006100", bold: true } },
    });
    controlsSheet.getRange(`C5:C${summaryEndRow}`).conditionalFormats.add("containsText", {
      text: "BLOCKED",
      format: { fill: colors.red, font: { color: "#9C0006", bold: true } },
    });
    controlsSheet.getRange(`A${summaryEndRow}:D${summaryEndRow}`).format = {
      fill: colors.red,
      font: { bold: true, color: "#9C0006" },
    };
    controlsSheet.getRange(`A${detailTitleRow}:O${detailTitleRow}`).merge();
    controlsSheet.getRange(`A${detailTitleRow}`).values = [[
      "Детали структурных групп — выбранные блоки Инталев и ERP",
    ]];
    controlsSheet.getRange(`A${detailTitleRow}:O${detailTitleRow}`).format = {
      fill: colors.blueLight,
      font: { bold: true, color: "#17365D" },
    };
    writeValues(controlsSheet, detailHeaderRow, 1, [
      [...STRUCTURAL_CONTROL_REPORT_DETAIL_HEADERS],
    ]);
    styleHeader(controlsSheet.getRange(`A${detailHeaderRow}:O${detailHeaderRow}`));
    if (structuralControlDetail.row_count > 0) {
      writeValues(controlsSheet, detailStartRow, 1, structuralControlDetail.rows);
      styleData(controlsSheet.getRange(`A${detailStartRow}:O${detailEndRow}`));
      controlsSheet.getRange(`H${detailStartRow}:M${detailEndRow}`).format.numberFormat =
        '#,##0.00;[Red](#,##0.00);-';
      controlsSheet.getRange(`N${detailStartRow}:N${detailEndRow}`).conditionalFormats.add("containsText", {
        text: "CLOSED",
        format: { fill: colors.green, font: { color: "#006100", bold: true } },
      });
      controlsSheet.getRange(`N${detailStartRow}:N${detailEndRow}`).conditionalFormats.add("containsText", {
        text: "BLOCK",
        format: { fill: colors.red, font: { color: "#9C0006", bold: true } },
      });
    }
    setColumnWidths(
      controlsSheet,
      [38, 30, 22, 18, 14, 34, 58, 18, 18, 18, 18, 18, 18, 30, 48],
      endRow,
    );
    controlsSheet.freezePanes.freezeRows(4);
    return endRow;
  }
}

function runIdFromWorkDir(workDir) {
  return path.basename(workDir);
}

try {
  if (command === "help") {
    printHelp();
  } else if (command === "init") {
    await initializeIntalevSnapshot();
  } else if (command === "status") {
    await showStatus();
  } else if (command === "detect-period") {
    await detectErpPeriodCommand();
  } else if (command === "run") {
    await runReconciliation();
  } else {
    fail(`Неизвестная команда: ${command}. Используйте help.`);
  }
} catch (error) {
  console.error(`ОШИБКА: ${error?.message ?? error}`);
  process.exitCode = 1;
}
