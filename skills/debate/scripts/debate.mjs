#!/usr/bin/env node
/**
 * debate · debate.mjs
 *
 * Workflow helpers. The web search and the orchestrator's judgment remain
 * outside this CLI; this file makes packets, briefs, delegated passes, and
 * mechanical review records reproducible.
 */

import { execFileSync, spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, readdirSync, realpathSync, statSync, writeFileSync } from "node:fs";
import { basename, dirname, extname, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";

import {
  EVIDENCE_SCHEMA,
  REFERENCE_SCHEMA,
  REPORT_SECTIONS,
  assertValid,
  DECISION_SCHEMA,
  readJson,
  reviewRun,
  validateDecision,
  validateEvidencePacket,
  validateReferencePacket,
} from "./protocol.mjs";

const HERE = dirname(fileURLToPath(import.meta.url));
const DELEGATE_DISPATCH = resolve(HERE, "../../delegate/scripts/dispatch.mjs");
const MAX_FILE_BYTES = 120_000;
const MAX_TOTAL_BYTES = 500_000;
const DEFAULT_MAX_FILES = 20;
const SKIP_DIRS = new Set([".git", ".hg", ".svn", "node_modules", "vendor", "dist", "build", ".next", "coverage"]);
const SECRET_BASENAMES = /(^|\.)((env|npmrc|pypirc|netrc)|pem|key|crt)$/i;
const TEXT_EXTENSIONS = new Set([
  ".cjs", ".css", ".go", ".h", ".hpp", ".java", ".js", ".json", ".jsx", ".kt", ".md", ".mjs", ".php",
  ".py", ".rb", ".rs", ".sh", ".sql", ".swift", ".toml", ".ts", ".tsx", ".txt", ".vue", ".xml", ".yaml", ".yml",
]);

function parseArgs(argv) {
  const options = { _: [], files: [], queries: [] };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === "--file") options.files.push(argv[++i]);
    else if (arg === "--query") options.queries.push(argv[++i]);
    else if (arg.startsWith("--")) options[arg.slice(2)] = argv[++i] ?? true;
    else options._.push(arg);
  }
  return options;
}

function required(options, name) {
  if (typeof options[name] !== "string" || !options[name].trim()) throw new Error(`--${name} is required`);
  return options[name];
}

function limitValue(rawLimit) {
  const limit = rawLimit === undefined ? DEFAULT_MAX_FILES : Number(rawLimit);
  if (!Number.isInteger(limit) || limit < 1) throw new Error("--max-files must be a positive integer");
  return limit;
}

function writeOutput(value, path = null) {
  const text = `${JSON.stringify(value, null, 2)}\n`;
  if (path) {
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, text, "utf8");
  } else process.stdout.write(text);
}

function writeTextOutput(text, path = null) {
  if (path) {
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, text, "utf8");
  } else process.stdout.write(text);
}

function goalText(options) {
  if (options["goal-file"]) return readFileSync(resolve(options["goal-file"]), "utf8").trim();
  return required(options, "goal").trim();
}

function inside(root, candidate) {
  const rootPath = resolve(root);
  const candidatePath = resolve(candidate);
  return candidatePath === rootPath || candidatePath.startsWith(`${rootPath}${sep}`);
}

function safeTextPath(path) {
  const base = basename(path);
  return !SECRET_BASENAMES.test(base) && (TEXT_EXTENSIONS.has(extname(base).toLowerCase()) || !extname(base));
}

function walk(root) {
  const paths = [];
  const visit = (dir) => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      if (entry.isDirectory()) {
        if (!SKIP_DIRS.has(entry.name)) visit(resolve(dir, entry.name));
      } else if (entry.isFile()) {
        const path = resolve(dir, entry.name);
        if (safeTextPath(path)) paths.push(path);
      }
    }
  };
  visit(resolve(root));
  return paths;
}

function queryPaths(root, queries) {
  if (!queries.length) return [];
  try {
    const args = ["-l", "-F", "--hidden", ...queries.flatMap((query) => ["-e", query]), "."];
    const output = execFileSync("rg", args, { cwd: root, encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] });
    return output.split(/\r?\n/).filter(Boolean).map((path) => resolve(root, path)).filter(safeTextPath);
  } catch {
    return walk(root).filter((path) => {
      try {
        const text = readFileSync(path, "utf8");
        return queries.some((query) => text.includes(query));
      } catch {
        return false;
      }
    });
  }
}

function explicitReferencePaths(root, files) {
  const paths = files.map((path) => resolve(root, path));
  for (const path of paths) {
    if (!inside(root, path)) throw new Error(`reference path escapes --cd: ${path}`);
    if (!existsSync(path) || !statSync(path).isFile()) throw new Error(`reference file not found: ${path}`);
    if (!inside(root, realpathSync(path))) throw new Error(`reference symlink escapes --cd: ${path}`);
    if (!safeTextPath(path)) throw new Error(`refusing a secret or non-text reference: ${path}`);
  }
  return paths;
}

function readReferenceFiles({ selected, root }) {
  const files = [];
  const omitted = [];
  let totalBytes = 0;
  for (const path of selected) {
    const raw = readFileSync(path);
    const remainingBytes = MAX_TOTAL_BYTES - totalBytes;
    if (remainingBytes <= 0) {
      omitted.push(relative(root, path));
      continue;
    }
    const content = raw.subarray(0, Math.min(MAX_FILE_BYTES, remainingBytes)).toString("utf8");
    const contentBytes = Buffer.byteLength(content);
    totalBytes += contentBytes;
    files.push({
      path: relative(root, path) || basename(path),
      bytes: raw.length,
      sha256: createHash("sha256").update(raw).digest("hex"),
      truncated: contentBytes < raw.length,
      content,
    });
  }
  return { files, omitted };
}

export function collectReferencePacket({ cwd, goal, files = [], queries = [], maxFiles = DEFAULT_MAX_FILES } = {}) {
  const root = realpathSync(resolve(cwd || process.cwd()));
  const fileLimit = limitValue(maxFiles);
  if (!existsSync(root) || !statSync(root).isDirectory()) throw new Error(`working directory is not a directory: ${root}`);
  const explicit = explicitReferencePaths(root, files);
  const candidates = [...new Set([...explicit, ...queryPaths(root, queries)])]
    .filter((path) => inside(root, path))
    .filter((path) => inside(root, realpathSync(path)));
  const selected = candidates.slice(0, fileLimit);
  const omitted = candidates.slice(selected.length).map((path) => relative(root, path));
  const packetFiles = readReferenceFiles({ selected, root });
  return {
    schema: REFERENCE_SCHEMA,
    generatedAt: new Date().toISOString(),
    workdir: root,
    goal,
    files: packetFiles.files,
    omitted: [...omitted, ...packetFiles.omitted],
    limits: { maxFiles: fileLimit, maxFileBytes: MAX_FILE_BYTES, maxTotalBytes: MAX_TOTAL_BYTES },
  };
}

function packetBlock(packet, tag) {
  return `<${tag}>\n${JSON.stringify(packet, null, 2)}\n</${tag}>`;
}

function briefInstructions({ phase, goal, references, evidence, provisional }) {
  const sections = [
    "You are the delegated participant in an evidence-informed technical debate.",
    `Debate phase: ${phase === "initial" ? "initial analysis" : "final recommendation"}.`,
    "Analyze the decision; do not edit files, commit, push, contact external systems, or claim that your process exit proves the conclusion.",
    "Use only the supplied local references and evidence. Mark assumptions and unknowns explicitly.",
    `Goal and decision question:\n${goal.trim()}`,
    packetBlock(references, "reference-packet"),
  ];
  if (phase === "final") {
    sections.push(packetBlock(provisional, "provisional-review"));
    sections.push(packetBlock(evidence, "evidence-packet"));
    sections.push("Test the provisional verdict, including the strongest evidence against it. Cite evidence by id and distinguish source facts from inference.");
  } else {
    sections.push("Develop the strongest position, then try to defeat it with concrete objections and credible alternatives.");
  }
  return sections;
}

function reportInstructions() {
  return [
    "Return Markdown with exactly these non-empty level-2 sections:",
    REPORT_SECTIONS.map((name, index) => `${index + 1}. ## ${name}`).join("\n"),
    "In Claims, identify claims with stable ids such as C1, C2. In Recommendation, state a decision and conditions. In Confidence, give low, medium, or high with reasons. In Unknowns, list what would change the conclusion.",
  ];
}

export function buildBrief({ phase, goal, references, evidence = null, provisional = null } = {}) {
  if (phase !== "initial" && phase !== "final") throw new Error('phase must be "initial" or "final"');
  if (typeof goal !== "string" || !goal.trim()) throw new Error("goal must be a non-empty string");
  if (phase === "final" && !provisional) throw new Error("final brief requires the provisional review");
  assertValid(references, validateReferencePacket, "reference packet");
  if (phase === "final") assertValid(evidence, validateEvidencePacket, "evidence packet");
  const sections = briefInstructions({ phase, goal, references, evidence, provisional });
  sections.push(...reportInstructions());
  return `${sections.join("\n\n")}\n`;
}

function loadRun(path) {
  const run = readJson(path);
  if (!run || typeof run !== "object") throw new Error(`run result is not an object: ${path}`);
  return run;
}

function dispatchSelection(options, first) {
  const agent = options.agent || first?.requested?.agent || first?.agent;
  if (!agent) throw new Error("--agent is required for the initial pass or must be present in the first result");
  return { agent, model: options.model ?? first?.requested?.model ?? null, effort: options.effort ?? first?.requested?.effort ?? null };
}

function dispatchArguments({ options, cwd, selection, first }) {
  const args = [DELEGATE_DISPATCH, "--agent", selection.agent, "--cd", cwd, "--read-only"];
  if (selection.model) args.push("--model", selection.model);
  if (selection.effort) args.push("--effort", selection.effort);
  if (options["out-dir"]) args.push("--out-dir", resolve(options["out-dir"]));
  if (options.session) args.push("--session", options.session);
  if (first?.sessionId && !options.session) args.push("--session", first.sessionId);
  return args;
}

function finalInputs(options, first) {
  if (first.status !== "completed") throw new Error(`cannot start final pass from ${first.status} initial run`);
  const evidence = assertValid(readJson(required(options, "evidence")), validateEvidencePacket, "evidence packet");
  const reviewPath = options.review || `${dirname(resolve(options["first-result"]))}/review.json`;
  return { evidence, provisional: readJson(reviewPath) };
}

function dispatchPhase(options) {
  const phase = options._[1];
  if (phase !== "initial" && phase !== "final") throw new Error('dispatch phase must be "initial" or "final"');
  const cwd = resolve(options.cd || process.cwd());
  const references = readJson(required(options, "references"));
  const first = phase === "final" ? loadRun(required(options, "first-result")) : null;
  const selection = dispatchSelection(options, first);
  const inputs = phase === "final" ? finalInputs(options, first) : {};
  const brief = buildBrief({ phase, goal: references.goal || goalText(options), references, ...inputs });
  const args = dispatchArguments({ options, cwd, selection, first });
  const child = spawnSync(process.execPath, args, { cwd, input: brief, encoding: "utf8", stdio: ["pipe", "inherit", "inherit"] });
  if (child.error) throw child.error;
  process.exitCode = child.status ?? 1;
}

function main() {
  const options = parseArgs(process.argv.slice(2));
  const command = options._[0];
  if (command === "references") {
    const packet = collectReferencePacket({ cwd: options.cd, goal: goalText(options), files: options.files, queries: options.queries, maxFiles: options["max-files"] });
    assertValid(packet, validateReferencePacket, "reference packet");
    writeOutput(packet, options.out ? resolve(options.out) : null);
  } else if (command === "brief") {
    const references = assertValid(readJson(required(options, "references")), validateReferencePacket, "reference packet");
    const phase = required(options, "phase");
    const evidence = options.evidence ? assertValid(readJson(options.evidence), validateEvidencePacket, "evidence packet") : null;
    const provisional = options.review ? readJson(options.review) : null;
    writeTextOutput(buildBrief({ phase, goal: references.goal, references, evidence, provisional }), options.out ? resolve(options.out) : null);
  } else if (command === "review") {
    const resultPath = resolve(required(options, "result"));
    const run = loadRun(resultPath);
    const phase = options.phase || options._[1];
    if (!phase) throw new Error("--phase is required");
    const evidence = options.evidence ? assertValid(readJson(options.evidence), validateEvidencePacket, "evidence packet") : null;
    const review = reviewRun(run, { phase, evidence });
    const out = options.out ? resolve(options.out) : resolve(dirname(resultPath), "review.json");
    writeOutput(review, out);
    process.stdout.write(`${review.verdict}: ${review.findings.length} finding(s)\n${out}\n`);
    process.exitCode = review.verdict === "unverified" ? 1 : 0;
  } else if (command === "dispatch") {
    dispatchPhase(options);
  } else if (command === "validate-evidence") {
    const packet = assertValid(readJson(required(options, "input")), validateEvidencePacket, "evidence packet");
    writeOutput({ schema: EVIDENCE_SCHEMA, valid: true, sourceCount: packet.sources.length });
  } else if (command === "validate-decision") {
    const decision = assertValid(readJson(required(options, "input")), validateDecision, "decision record");
    writeOutput({ schema: DECISION_SCHEMA, valid: true, recommendation: decision.recommendation });
  } else {
    process.stdout.write("Usage: debate.mjs references|brief|dispatch|review|validate-evidence [options]\n");
    process.exitCode = command ? 2 : 0;
  }
}

if (process.argv[1] && fileURLToPath(import.meta.url) === resolve(process.argv[1])) {
  try {
    main();
  } catch (error) {
    if (!process.exitCode) process.exitCode = 2;
    if (!String(error?.message ?? error).startsWith("debate:")) process.stderr.write(`debate: ${error?.message ?? error}\n`);
  }
}
