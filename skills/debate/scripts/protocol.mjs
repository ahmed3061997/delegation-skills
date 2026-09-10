/**
 * debate · protocol.mjs
 *
 * Small, dependency-free contracts for the debate workflow. Delegated agents
 * still return the delegate run document; this module adds the semantic
 * layer that a technical debate needs on top of that process record.
 */

import { readFileSync } from "node:fs";

export const REFERENCE_SCHEMA = "debate.reference.v1";
export const EVIDENCE_SCHEMA = "debate.evidence.v1";
export const REVIEW_SCHEMA = "debate.review.v1";
export const DECISION_SCHEMA = "debate.decision.v1";

export const REPORT_SECTIONS = Object.freeze([
  "Position",
  "Claims",
  "Objections",
  "Alternatives",
  "Recommendation",
  "Confidence",
  "Unknowns",
]);

const RELATIONS = new Set(["supports", "contradicts", "limits"]);
const CONFIDENCE = new Set(["low", "medium", "high"]);

export function readJson(path) {
  try {
    return JSON.parse(readFileSync(path, "utf8"));
  } catch (error) {
    throw new Error(`could not read JSON ${path}: ${error?.message ?? error}`);
  }
}

function nonEmptyString(value) {
  return typeof value === "string" && value.trim().length > 0;
}

function issue(path, detail) {
  return `${path}: ${detail}`;
}

export function validateReferencePacket(packet) {
  const errors = [];
  if (packet?.schema !== REFERENCE_SCHEMA) errors.push(issue("schema", `expected ${REFERENCE_SCHEMA}`));
  if (!nonEmptyString(packet?.workdir)) errors.push(issue("workdir", "must be a non-empty string"));
  if (!nonEmptyString(packet?.goal)) errors.push(issue("goal", "must be a non-empty string"));
  if (!Array.isArray(packet?.files)) errors.push(issue("files", "must be an array"));
  for (const [index, file] of (packet?.files ?? []).entries()) {
    if (!nonEmptyString(file?.path)) errors.push(issue(`files[${index}].path`, "must be a non-empty string"));
    if (typeof file?.content !== "string") errors.push(issue(`files[${index}].content`, "must be a string"));
    if (!Number.isInteger(file?.bytes) || file.bytes < 0) errors.push(issue(`files[${index}].bytes`, "must be a non-negative integer"));
  }
  return errors;
}

export function validateEvidencePacket(packet) {
  const errors = [];
  if (packet?.schema !== EVIDENCE_SCHEMA) errors.push(issue("schema", `expected ${EVIDENCE_SCHEMA}`));
  if (!Array.isArray(packet?.sources)) errors.push(issue("sources", "must be an array"));
  const ids = new Set();
  for (const [index, source] of (packet?.sources ?? []).entries()) {
    const prefix = `sources[${index}]`;
    if (!nonEmptyString(source?.id)) errors.push(issue(`${prefix}.id`, "must be a non-empty string"));
    else if (ids.has(source.id)) errors.push(issue(`${prefix}.id`, `duplicate id ${source.id}`));
    else ids.add(source.id);
    if (!nonEmptyString(source?.title)) errors.push(issue(`${prefix}.title`, "must be a non-empty string"));
    if (!nonEmptyString(source?.url)) errors.push(issue(`${prefix}.url`, "must be a non-empty string"));
    else {
      try {
        const parsedUrl = new URL(source.url);
        if (!/^https?:$/.test(parsedUrl.protocol)) errors.push(issue(`${prefix}.url`, "must use http or https"));
      } catch {
        errors.push(issue(`${prefix}.url`, "must be a valid URL"));
      }
    }
    if (!RELATIONS.has(source?.relation)) errors.push(issue(`${prefix}.relation`, "must be supports, contradicts, or limits"));
    if (!nonEmptyString(source?.summary)) errors.push(issue(`${prefix}.summary`, "must be a non-empty string"));
    if (!nonEmptyString(source?.limitations)) errors.push(issue(`${prefix}.limitations`, "must be a non-empty string"));
    if (!Array.isArray(source?.claims) || source.claims.some((claim) => !nonEmptyString(claim))) {
      errors.push(issue(`${prefix}.claims`, "must be an array of non-empty claim identifiers"));
    }
  }
  return errors;
}

export function assertValid(packet, validator, label) {
  const errors = validator(packet);
  if (errors.length) throw new Error(`${label} is invalid:\n- ${errors.join("\n- ")}`);
  return packet;
}

/** Parse the fixed headings required by the delegated analysis brief. */
export function parseAnalysisReport(text) {
  const sections = Object.fromEntries(REPORT_SECTIONS.map((name) => [name, ""]));
  if (typeof text !== "string") return { sections, headings: [], missing: [...REPORT_SECTIONS] };

  const heading = /^##\s+([^\n#]+?)\s*$/gm;
  const matches = [...text.matchAll(heading)];
  for (let index = 0; index < matches.length; index += 1) {
    const name = matches[index][1].trim();
    const known = REPORT_SECTIONS.find((candidate) => candidate.toLowerCase() === name.toLowerCase());
    if (!known) continue;
    const start = matches[index].index + matches[index][0].length;
    const end = matches[index + 1]?.index ?? text.length;
    sections[known] = text.slice(start, end).trim();
  }
  const headings = REPORT_SECTIONS.filter((name) => sections[name]);
  return { sections, headings, missing: REPORT_SECTIONS.filter((name) => !sections[name]) };
}

function evidenceCoverage(packet, report) {
  const cited = new Set();
  const text = `${report.sections.Claims}\n${report.sections.Recommendation}\n${report.sections.Unknowns}`;
  for (const source of packet?.sources ?? []) {
    if (text.includes(source.id)) cited.add(source.id);
  }
  const relations = { supports: 0, contradicts: 0, limits: 0 };
  for (const source of packet?.sources ?? []) relations[source.relation] += 1;
  return {
    sourceCount: packet?.sources?.length ?? 0,
    citedSourceIds: [...cited],
    uncitedSourceIds: (packet?.sources ?? []).map((source) => source.id).filter((id) => !cited.has(id)),
    relations,
    hasContradictoryEvidence: relations.contradicts > 0,
  };
}

function runFindings(run) {
  if (run?.status !== "completed") {
    return [{ severity: "high", kind: "run-not-completed", detail: `delegated run status is ${run?.status ?? "missing"}` }];
  }
  if (!String(run?.finalMessage ?? "").trim()) {
    return [{ severity: "high", kind: "missing-report", detail: "the process completed without a final report" }];
  }
  return [];
}

function reportFindings(report, phase) {
  const findings = report.missing.map((section) => ({
    severity: "medium",
    kind: "missing-section",
    detail: `analysis report has no non-empty ## ${section} section`,
  }));
  if (phase === "initial" && report.sections.Objections.trim().length < 20) {
    findings.push({ severity: "medium", kind: "weak-opposition", detail: "the provisional analysis does not contain a substantive objection" });
  }
  return findings;
}

function evidenceFindings(coverage) {
  if (!coverage) return [{ severity: "high", kind: "missing-evidence-packet", detail: "final review requires a validated evidence packet" }];
  const findings = [];
  if (!coverage.hasContradictoryEvidence) {
    findings.push({ severity: "medium", kind: "no-contradictory-evidence", detail: "the evidence packet contains no source marked contradicts" });
  }
  if (coverage.uncitedSourceIds.length) {
    findings.push({ severity: "low", kind: "uncited-evidence", detail: "some supplied sources are not referenced by id in the report" });
  }
  return findings;
}

export function reviewRun(run, { phase, evidence = null } = {}) {
  if (phase !== "initial" && phase !== "final") throw new Error('phase must be "initial" or "final"');
  const report = parseAnalysisReport(run?.finalMessage ?? "");
  const coverage = evidence ? evidenceCoverage(evidence, report) : null;
  const findings = [...runFindings(run), ...reportFindings(report, phase), ...(phase === "final" ? evidenceFindings(coverage) : [])];
  return {
    schema: REVIEW_SCHEMA,
    reviewedAt: new Date().toISOString(),
    phase,
    run: {
      status: run?.status ?? null,
      resultPath: run?.artifacts?.resultPath ?? null,
      sessionId: run?.sessionId ?? null,
    },
    report,
    evidence: coverage,
    findings,
    verdict: findings.some((finding) => finding.severity === "high") ? "unverified" : "reviewable",
  };
}

export function validateDecision(decision) {
  const errors = [];
  if (decision?.schema !== DECISION_SCHEMA) errors.push(issue("schema", `expected ${DECISION_SCHEMA}`));
  for (const field of ["recommendation", "rationale", "confidence"]) {
    if (!nonEmptyString(decision?.[field])) errors.push(issue(field, "must be a non-empty string"));
  }
  if (!CONFIDENCE.has(decision?.confidence)) errors.push(issue("confidence", "must be low, medium, or high"));
  for (const field of ["evidenceIds", "unresolved", "nextSteps"]) {
    if (!Array.isArray(decision?.[field]) || decision[field].some((item) => !nonEmptyString(item))) {
      errors.push(issue(field, "must be an array of non-empty strings"));
    }
  }
  return errors;
}
