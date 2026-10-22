import { CATALOGUE, CATALOGUE_VERSION, MODEL, THRESHOLD } from "./catalogue.mjs";

/** Applies deterministic draft rules to model classifications; developer decisions are retained. */
export function createReport(policy, libraries, requests, results, metadata = {}) {
  const draft = Object.create(null);
  const report = { schemaVersion: 1, catalogueVersion: CATALOGUE_VERSION, model: MODEL, threshold: THRESHOLD,
    ...metadata, usage: { input_tokens: 0, output_tokens: 0 }, libraries: [] };
  for (const result of results) {
    if (result?.response && !result.cached) {
      report.usage.input_tokens += result.response.usage.input_tokens;
      report.usage.output_tokens += result.response.usage.output_tokens;
    }
  }
  for (const library of libraries) {
    const permissions = [...policy[library.name].permissions];
    const capabilities = CATALOGUE.map((capability) => {
      const index = requests.findIndex((request) => request.state.library === library.name && capability.name in request.questions);
      const evidence = requests[index]?.state.capabilities[capability.name];
      const result = results[index];
      const answer = result?.response?.answers[capability.name];
      const probability = answer ? answer.probabilities[answer.choice] : null;
      const references = library.references.filter((reference) => reference.capability === capability.name);
      const unsupportedCrypto = capability.name === "crypto" && references.some((reference) =>
        reference.members.length > 0 && !capability.coveredMembers.includes(reference.members[0]));
      const eligible = capability.exposure === "supported" && !unsupportedCrypto && evidence?.complete &&
        evidence.evidence.length > 0 && probability >= THRESHOLD && ["core_required", "optional_feature"].includes(answer?.choice);
      if (eligible && !permissions.includes(capability.name)) permissions.push(capability.name);
      return { name: capability.name, exposure: capability.exposure, classification: answer?.choice ?? "insufficient_evidence",
        probability, probabilities: answer?.probabilities ?? null, confidence: answer?.confidence ?? null,
        evidenceComplete: evidence?.complete ?? false, omittedEvidence: evidence?.omitted ?? 0,
        evidence: references.map(({ file, line, members, initialization, feature }) => ({ file, line, members, initialization, feature })),
        suggested: Boolean(eligible), existing: policy[library.name].permissions.includes(capability.name),
        reviewReason: result?.error ?? (metadata.dryRun ? "dry_run_not_evaluated" : unsupportedCrypto ? "crypto_member_not_exposed" :
          !evidence?.complete ? "incomplete_evidence" : !references.length ? "no_matching_evidence" :
          capability.exposure !== "supported" ? capability.exposure : !eligible ? "classification_or_probability_requires_review" : "review_draft"),
        cached: result?.cached ?? false };
    });
    draft[library.name] = { ...policy[library.name], permissions };
    report.libraries.push({ name: library.name, packages: library.packages, moduleCount: library.moduleCount,
      moduleFingerprint: library.moduleFingerprint, issues: library.issues,
      workloadsAnalyzed: false, workloadsPresent: Boolean(Object.keys(policy[library.name].workloads ?? {}).length),
      existingUncataloguedPermissions: policy[library.name].permissions.filter((name) => !CATALOGUE.some((capability) => capability.name === name)), capabilities });
  }
  return { report, draft };
}

/** Renders code from local data only; the model never writes executable configuration. */
export function renderDraft(draft) {
  return "// Suggested policy. Review permissions before copying them into the active configuration.\n" +
    "// Optional features and unresolved capabilities are documented in report.md.\n" +
    `export default ${JSON.stringify(draft, null, 2)};\n`;
}

/** Escapes untrusted package/source labels in Markdown table cells. */
function cell(value) {
  return String(value).replaceAll("|", "\\|").replace(/[\r\n]/g, " ").replaceAll("<", "&lt;");
}

/** Produces a source-backed review report without inventing model explanations. */
export function renderMarkdown(report) {
  const lines = ["# Sandbox capability suggestions", "", `Model: ${report.model}. Draft threshold: ${report.threshold}.`, "",
    "Review the draft before copying permissions into the active policy. Probabilities are review heuristics, not a security guarantee.", "",
    "Analysis follows the runtime build's entry resolution and includes installed transitive modules. Host/local modules and configured workloads are excluded.", "",
    "Sensitive and unvalidated APIs require explicit developer review. Static absence is not proof that a capability is unnecessary.", "",
    `New API token usage: ${report.usage.input_tokens} input; ${report.usage.output_tokens} output. Cached results do not add new usage.`, ""];
  for (const library of report.libraries) {
    lines.push(`## ${cell(library.name)}`, "", `Packages: ${library.packages.map((entry) => cell(`${entry.name}@${entry.version}`)).join(", ")}`, "",
      `Analysis issues: ${library.issues.map(cell).join(", ") || "none detected"}. Workloads analyzed: no.`, "");
    if (library.existingUncataloguedPermissions.length) lines.push(`Existing uncatalogued permissions retained: ${library.existingUncataloguedPermissions.map(cell).join(", ")}. Exposure coverage requires review.`, "");
    lines.push("| Capability | Classification | Probability | Draft / review | Code evidence |", "|---|---|---|---|---|");
    for (const capability of library.capabilities) {
      const evidence = capability.evidence.map((reference) => `${reference.file}:${reference.line} [${reference.feature ?? "unknown feature"}]${reference.members.length ? ` (${reference.members.join(".")})` : ""}`).join("; ");
      lines.push(`| ${cell(capability.name)} | ${capability.classification} | ${capability.probability ?? "—"} | ${cell(`${capability.existing ? "existing; " : ""}${capability.suggested ? "suggested; " : ""}${capability.reviewReason}`)} | ${cell(evidence || "none found")} |`);
    }
    lines.push("");
  }
  return lines.join("\n") + "\n";
}
