import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

export const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

export const INDEX_PATH = path.join(ROOT, "data", "index.json");

function readJson(relativePath) {
  return JSON.parse(fs.readFileSync(path.join(ROOT, relativePath), "utf8"));
}

/** Pilot repositories in scope for v1. */
export function loadRepos() {
  return readJson("config/repos.json").repos;
}

/**
 * Demo access-control table. In a real deployment this call is replaced by a
 * lookup against the SCM provider's read permissions for the signed-in user;
 * everything downstream already treats the returned list as the hard boundary.
 */
export function loadUsers() {
  return readJson("config/users.json").users;
}

export function findUser(userId) {
  const users = loadUsers();
  return users.find((u) => u.id === userId) ?? users[0];
}

/** Repo ids the user is allowed to see, intersected with the indexed repos. */
export function allowedRepoIds(user, repos) {
  const indexed = new Set(repos.map((r) => r.id));
  return user.repos.filter((id) => indexed.has(id));
}
