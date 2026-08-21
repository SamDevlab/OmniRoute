import { summarizeBenchmarkRun } from "./omniroute-governor-benchmark-persistence.mjs";

const argument = process.argv.find((value) => value.startsWith("--summarize-run="));
if (!argument) {
  console.error(
    "Usage: node scripts/ad-hoc/omniroute-governor-run-summarizer.mjs --summarize-run=<run-dir-or-runId>"
  );
  process.exit(2);
}

const runDirectory = argument.slice("--summarize-run=".length);
const summary = summarizeBenchmarkRun(runDirectory);
console.log(JSON.stringify(summary, null, 2));
process.exit(summary.status === "COMPLETE" ? 0 : 2);
