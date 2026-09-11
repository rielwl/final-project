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
console.log(`Written to ${INDEX_PATH}`);
