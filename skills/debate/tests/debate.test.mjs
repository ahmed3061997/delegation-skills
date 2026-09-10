import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import { withTempDir, test, equal, includes, ok, throwsWith } from "../../delegate/tests/harness.mjs";
import { buildBrief, collectReferencePacket } from "../scripts/debate.mjs";
import {
  EVIDENCE_SCHEMA,
  REFERENCE_SCHEMA,
  reviewRun,
  validateEvidencePacket,
  validateReferencePacket,
} from "../scripts/protocol.mjs";

const baseReport = `## Position\nChoose A.\n\n## Claims\nC1: A is simpler. E1\n\n## Objections\nB may be safer under load because of the operational cost.\n\n## Alternatives\nB and a staged rollout.\n\n## Recommendation\nChoose A if the rollout guard exists.\n\n## Confidence\nMedium: the local evidence is incomplete.\n\n## Unknowns\nA production benchmark could change this.\n`;

test("reference packets are bounded, hashed, and exclude secret files", () => withTempDir("debate-refs", (dir) => {
  mkdirSync(join(dir, "src"));
  writeFileSync(join(dir, "src", "module.ts"), "export const answer = 42;\n");
  writeFileSync(join(dir, ".env"), "TOKEN=do-not-share\n");
  const packet = collectReferencePacket({ cwd: dir, goal: "Choose an implementation", files: ["src/module.ts"] });
  equal(packet.schema, REFERENCE_SCHEMA);
  equal(packet.files.length, 1);
  equal(packet.files[0].path, "src/module.ts");
  ok(packet.files[0].sha256.length === 64);
  equal(validateReferencePacket(packet).length, 0);
  throwsWith(() => collectReferencePacket({ cwd: dir, goal: "x", files: [".env"] }), "secret");
}));

test("evidence validation requires claim mapping and unique ids", () => {
  const packet = {
    schema: EVIDENCE_SCHEMA,
    sources: [{ id: "E1", title: "Docs", url: "https://example.test/docs", relation: "supports", claims: ["C1"], summary: "A fact", limitations: "Example source" }],
  };
  equal(validateEvidencePacket(packet).length, 0);
  equal(validateEvidencePacket({ ...packet, sources: [packet.sources[0], packet.sources[0]] }).length, 1);
  ok(validateEvidencePacket({ ...packet, sources: [{ ...packet.sources[0], relation: "invented" }] }).length > 0);
});

test("initial review distinguishes an incomplete report from a reviewable one", () => {
  const run = { status: "completed", finalMessage: baseReport, artifacts: { resultPath: "/tmp/result.json" }, sessionId: "s1" };
  const review = reviewRun(run, { phase: "initial" });
  equal(review.verdict, "reviewable");
  equal(review.findings.length, 0);
  const incomplete = reviewRun({ status: "failed", finalMessage: "## Position\nOnly" }, { phase: "initial" });
  equal(incomplete.verdict, "unverified");
  ok(incomplete.findings.some((finding) => finding.kind === "run-not-completed"));
});

test("final review flags missing contradiction and tracks cited evidence", () => {
  const run = { status: "completed", finalMessage: baseReport, artifacts: { resultPath: "/tmp/result.json" } };
  const evidence = { schema: EVIDENCE_SCHEMA, sources: [{ id: "E1", title: "Docs", url: "https://example.test/docs", relation: "supports", claims: ["C1"], summary: "A fact", limitations: "Example source" }] };
  const review = reviewRun(run, { phase: "final", evidence });
  equal(review.verdict, "reviewable");
  ok(review.findings.some((finding) => finding.kind === "no-contradictory-evidence"));
  equal(review.evidence.citedSourceIds[0], "E1");
});

test("final brief carries the evidence and asks for disconfirmation", () => {
  const references = { schema: REFERENCE_SCHEMA, workdir: "/tmp/repo", goal: "Choose A or B", files: [], omitted: [], limits: {} };
  const evidence = { schema: EVIDENCE_SCHEMA, sources: [{ id: "E1", title: "Docs", url: "https://example.test/docs", relation: "contradicts", claims: ["C1"], summary: "A caveat", limitations: "Example source" }] };
  const brief = buildBrief({ phase: "final", goal: references.goal, references, evidence, provisional: { verdict: "reviewable" } });
  includes(brief, "<evidence-packet>");
  includes(brief, "Debate phase: final recommendation");
  includes(brief, "## Unknowns");
});
