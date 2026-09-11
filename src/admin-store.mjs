import fs from "node:fs";
import path from "node:path";
import { ROOT } from "./config.mjs";

/**
 * Reads and writes the two configuration files the admin dashboard edits:
 * config/repos.json (the projects) and config/users.json (the people and the
 * repositories each of them may read).
 *
 * Every write is validated first and then written whole, so a rejected edit
 * leaves the file exactly as it was.
 */

const REPOS_FILE = path.join(ROOT, "config", "repos.json");
const USERS_FILE = path.join(ROOT, "config", "users.json");

const ID_PATTERN = /^[a-z0-9][a-z0-9._-]*$/i;

function readJson(file) {
  return JSON.parse(fs.readFileSync(file, "utf8"));
}

function writeJson(file, value) {
  fs.writeFileSync(file, `${JSON.stringify(value, null, 2)}\n`);
}

function asString(value) {
  return typeof value === "string" ? value.trim() : "";
}

/** Absolute location of a configured repo path, which may be relative to the project. */
export function resolveRepoPath(repoPath) {
  return path.isAbsolute(repoPath) ? repoPath : path.resolve(ROOT, repoPath);
}

export function readRepos() {
  return readJson(REPOS_FILE).repos;
}

export function readUsers() {
  return readJson(USERS_FILE);
}

/** Problems are returned as plain sentences so the dashboard can list them. */
export function validateRepos(repos) {
  const problems = [];
  if (!Array.isArray(repos) || repos.length === 0) {
    return ["Add at least one project."];
  }

  const seen = new Set();
  repos.forEach((repo, i) => {
    const label = asString(repo?.id) || `project ${i + 1}`;
    const id = asString(repo?.id);
    const repoPath = asString(repo?.path);

    if (!id) {
      problems.push(`${label}: an id is required.`);
    } else if (!ID_PATTERN.test(id)) {
      problems.push(`${label}: the id may only contain letters, numbers, dot, dash and underscore.`);
    } else if (seen.has(id)) {
      problems.push(`${label}: duplicate id.`);
    }
    seen.add(id);

    if (!repoPath) {
      problems.push(`${label}: a path is required.`);
    } else {
      const absolute = resolveRepoPath(repoPath);
      if (!fs.existsSync(absolute)) {
        problems.push(`${label}: path not found on disk (${absolute}).`);
      } else if (!fs.statSync(absolute).isDirectory()) {
        problems.push(`${label}: path is not a directory (${absolute}).`);
      }
    }

    const url = asString(repo?.url);
    if (url && !/^https?:\/\//i.test(url)) {
      problems.push(`${label}: the repository link must start with http:// or https://.`);
    }
  });

  return problems;
}

export function validateUsers(users, repoIds) {
  const problems = [];
  if (!Array.isArray(users) || users.length === 0) {
    return ["Add at least one person."];
  }

  const known = new Set(repoIds);
  const seen = new Set();
  users.forEach((user, i) => {
    const id = asString(user?.id);
    const label = id || asString(user?.name) || `person ${i + 1}`;

    if (!id) {
      problems.push(`${label}: an id is required.`);
    } else if (!ID_PATTERN.test(id)) {
      problems.push(`${label}: the id may only contain letters, numbers, dot, dash and underscore.`);
    } else if (seen.has(id)) {
      problems.push(`${label}: duplicate id.`);
    }
    seen.add(id);

    if (!asString(user?.name)) {
      problems.push(`${label}: a display name is required.`);
    }

    const email = asString(user?.email);
    if (email && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
      problems.push(`${label}: that does not look like an email address.`);
    }

    if (!Array.isArray(user?.repos)) {
      problems.push(`${label}: repository access must be a list.`);
      return;
    }
    for (const repoId of user.repos) {
      if (!known.has(repoId)) {
        problems.push(`${label}: no project with the id "${repoId}".`);
      }
    }
  });

  return problems;
}

/** Normalise to the on-disk shape, dropping anything the form did not own. */
export function saveRepos(repos) {
  const cleaned = repos.map((repo) => {
    const id = asString(repo.id);
    return {
      id,
      name: id,
      path: asString(repo.path).replace(/\\/g, "/"),
      url: asString(repo.url),
      language: asString(repo.language),
      summary: asString(repo.summary),
    };
  });
  writeJson(REPOS_FILE, { repos: cleaned });
  return cleaned;
}

export function saveUsers(users) {
  const existing = readUsers();
  const cleaned = users.map((user) => ({
    id: asString(user.id),
    name: asString(user.name),
    email: asString(user.email),
    repos: [...new Set(user.repos ?? [])],
  }));
  writeJson(USERS_FILE, { comment: existing.comment, users: cleaned });
  return cleaned;
}
