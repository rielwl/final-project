import fs from "node:fs";
import path from "node:path";

/**
 * Pulls the raw material for "how do I run this locally" out of a repository's
 * own configuration files, so the assistant synthesises setup steps from facts
 * rather than from memory.
 *
 * Nothing here is interpreted or reworded: every field is a verbatim quote of
 * something in the repo, with the file it came from, so the answer can cite it.
 */
export function extractSetupFacts(repoRoot, repo) {
  const facts = {
    repo: repo.id,
    language: repo.language,
    readmeCommands: readmeSetupBlocks(repoRoot),
    makeTargets: makefileTargets(repoRoot),
    packageScripts: packageScripts(repoRoot),
    runtime: runtimeRequirements(repoRoot),
    services: composeServices(repoRoot),
    envKeys: envExampleKeys(repoRoot),
  };
  return facts;
}

function read(repoRoot, relative) {
  const file = path.join(repoRoot, relative);
  return fs.existsSync(file) ? fs.readFileSync(file, "utf8") : null;
}

/** Fenced code blocks that sit under a setup/run/test heading in the README. */
function readmeSetupBlocks(repoRoot) {
  const readme = read(repoRoot, "README.md");
  if (!readme) return [];

  const lines = readme.split(/\r?\n/);
  const blocks = [];
  let heading = null;
  let inFence = false;
  let fenceStart = 0;
  let buffer = [];

  lines.forEach((line, i) => {
    const headingMatch = /^#{1,6}\s+(.*)$/.exec(line);
    if (headingMatch && !inFence) {
      heading = headingMatch[1].trim();
      return;
    }
    if (/^```/.test(line)) {
      if (!inFence) {
        inFence = true;
        fenceStart = i + 2; // first command line, 1-indexed
        buffer = [];
      } else {
        inFence = false;
        const relevant = /setup|install|run|start|test|getting started|quick start|local/i;
        if (heading && relevant.test(heading) && buffer.length > 0) {
          blocks.push({
            heading,
            source: `README.md:${fenceStart}-${i}`,
            commands: buffer.filter((l) => l.trim() !== ""),
          });
        }
      }
      return;
    }
    if (inFence) buffer.push(line);
  });

  return blocks;
}

/** Make targets plus their `##` doc comments, with line numbers for citation. */
function makefileTargets(repoRoot) {
  const makefile = read(repoRoot, "Makefile");
  if (!makefile) return [];
  const targets = [];
  makefile.split(/\r?\n/).forEach((line, i) => {
    const match = /^([a-zA-Z0-9_.-]+):(?!=)[^#]*(?:##\s*(.*))?$/.exec(line);
    if (match && match[1] !== ".PHONY") {
      targets.push({ target: match[1], description: (match[2] ?? "").trim(), source: `Makefile:${i + 1}` });
    }
  });
  return targets;
}

function packageScripts(repoRoot) {
  const raw = read(repoRoot, "package.json");
  if (!raw) return [];
  try {
    const parsed = JSON.parse(raw);
    return Object.entries(parsed.scripts ?? {}).map(([name, command]) => ({
      name,
      command,
      source: "package.json",
    }));
  } catch {
    return [];
  }
}

/** Runtime/toolchain constraints stated by the repo itself. */
function runtimeRequirements(repoRoot) {
  const requirements = [];

  const pkg = read(repoRoot, "package.json");
  if (pkg) {
    try {
      const parsed = JSON.parse(pkg);
      if (parsed.engines?.node) requirements.push({ tool: "node", version: parsed.engines.node, source: "package.json" });
    } catch { /* ignore malformed manifest */ }
  }

  const pyproject = read(repoRoot, "pyproject.toml");
  if (pyproject) {
    const match = /requires-python\s*=\s*"([^"]+)"/.exec(pyproject);
    if (match) requirements.push({ tool: "python", version: match[1], source: "pyproject.toml" });
  }

  const gomod = read(repoRoot, "go.mod");
  if (gomod) {
    const match = /^go\s+([0-9.]+)/m.exec(gomod);
    if (match) requirements.push({ tool: "go", version: match[1], source: "go.mod" });
  }

  return requirements;
}

/** Service names and published ports from docker-compose. */
function composeServices(repoRoot) {
  const compose = read(repoRoot, "docker-compose.yml") ?? read(repoRoot, "docker-compose.yaml");
  if (!compose) return [];

  const services = [];
  let current = null;
  let inServices = false;
  for (const line of compose.split(/\r?\n/)) {
    if (/^services:/.test(line)) { inServices = true; continue; }
    if (!inServices) continue;

    const serviceMatch = /^ {2}([a-zA-Z0-9_.-]+):\s*$/.exec(line);
    if (serviceMatch) {
      current = { name: serviceMatch[1], image: null, ports: [], source: "docker-compose.yml" };
      services.push(current);
      continue;
    }
    if (!current) continue;

    const imageMatch = /^\s+image:\s*(.+)$/.exec(line);
    if (imageMatch) current.image = imageMatch[1].trim();

    const portMatch = /^\s+-\s*"?([0-9]+:[0-9]+)"?\s*$/.exec(line);
    if (portMatch) current.ports.push(portMatch[1]);
  }
  return services;
}

/** Keys only. Values are never read out of an env file, even an example one. */
function envExampleKeys(repoRoot) {
  const example = read(repoRoot, ".env.example");
  if (!example) return [];
  return example
    .split(/\r?\n/)
    .map((line) => /^([A-Z0-9_]+)=/.exec(line.trim()))
    .filter(Boolean)
    .map((match) => match[1]);
}
