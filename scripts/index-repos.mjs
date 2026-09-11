#!/usr/bin/env node
/** Build the static index over the pilot repositories. */
import { buildIndex } from "../src/indexer.mjs";
import { INDEX_PATH } from "../src/config.mjs";

console.log("Indexing pilot repositories...");
const index = buildIndex();

const secretsSkipped = index.skipped.filter((s) => s.reason.startsWith("secrets policy"));

console.log("");
console.log(`Indexed ${index.files.length} files into ${index.chunks.length} chunks.`);
console.log(`Excluded by secrets policy: ${secretsSkipped.length}`);
for (const skipped of secretsSkipped) {
  console.log(`  - ${skipped.repo}/${skipped.path}  (${skipped.reason})`);
}
console.log("");
const { services, edges, infra, external, order } = index.graph;
const httpEdges = edges.filter((e) => e.kind === "http");
console.log(
  `Architecture graph: ${services.length} services, ${httpEdges.length} service calls,` +
    ` ${infra.length} infrastructure dependencies, ${external.length} external.`,
);
for (const edge of httpEdges) {
  const via = edge.calls.map((c) => c.path).join(", ") || "no endpoint path found";
  console.log(`  ${edge.from} -> ${edge.to}  (${via})`);
}
console.log(`  reading order: ${order.join(" -> ")}`);

console.log("");
console.log(`Written to ${INDEX_PATH}`);
