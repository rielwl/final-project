/* Admin dashboard: edit the indexed projects and the people who may read them.
 * Both forms are edited locally and written in one PUT, so a rejected save
 * leaves the configuration files untouched.
 */

const state = {
  repos: [],
  users: [],
  status: {},
};

const el = {
  indexLine: document.getElementById("indexLine"),
  authNote: document.getElementById("authNote"),
  repoList: document.getElementById("repoList"),
  userList: document.getElementById("userList"),
  addRepo: document.getElementById("addRepo"),
  addUser: document.getElementById("addUser"),
  saveRepos: document.getElementById("saveRepos"),
  saveUsers: document.getElementById("saveUsers"),
  repoStatus: document.getElementById("repoStatus"),
  userStatus: document.getElementById("userStatus"),
  repoProblems: document.getElementById("repoProblems"),
  userProblems: document.getElementById("userProblems"),
};

function escapeHtml(text) {
  return String(text ?? "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

/* --------------------------- rendering --------------------------- */

function repoStatusLine(repo) {
  const status = state.status[repo.id];
  if (!status) return `<span class="pill new">not indexed yet</span>`;
  if (!status.exists) {
    return `<span class="pill bad">path not found</span> <code>${escapeHtml(status.absolutePath)}</code>`;
  }
  const excluded = status.excluded.length;
  return [
    `<span class="pill good">${status.indexedFiles} files indexed</span>`,
    status.maskedValues > 0 ? `<span class="pill">${status.maskedValues} values masked</span>` : "",
    excluded > 0 ? `<span class="pill">${excluded} excluded by secrets policy</span>` : "",
  ]
    .filter(Boolean)
    .join(" ");
}

function renderRepos() {
  el.repoList.innerHTML = state.repos
    .map(
      (repo, i) => `
    <article class="card" data-index="${i}">
      <div class="card-head">
        <input class="id-input" data-field="id" value="${escapeHtml(repo.id)}" placeholder="repo-id" aria-label="Project id" />
        <button class="remove" type="button" data-remove="repo" aria-label="Remove project">Remove</button>
      </div>
      <label>Path<input data-field="path" value="${escapeHtml(repo.path)}" placeholder="repos/my-service or C:\\code\\my-service" /></label>
      <label>Repository link<input data-field="url" value="${escapeHtml(repo.url)}" placeholder="https://github.com/org/repo/blob/main" /></label>
      <div class="two-up">
        <label>Language<input data-field="language" value="${escapeHtml(repo.language)}" placeholder="Go 1.22" /></label>
        <label>Summary<input data-field="summary" value="${escapeHtml(repo.summary)}" placeholder="What this service owns" /></label>
      </div>
      <p class="card-status">${repoStatusLine(repo)}</p>
    </article>`,
    )
    .join("");
}

function renderUsers() {
  el.userList.innerHTML = state.users
    .map(
      (user, i) => `
    <article class="card" data-index="${i}">
      <div class="card-head">
        <input class="id-input" data-field="id" value="${escapeHtml(user.id)}" placeholder="person-id" aria-label="Person id" />
        <button class="remove" type="button" data-remove="user" aria-label="Remove person">Remove</button>
      </div>
      <div class="two-up">
        <label>Display name<input data-field="name" value="${escapeHtml(user.name)}" placeholder="Priya (new engineer)" /></label>
        <label>Email<input data-field="email" value="${escapeHtml(user.email)}" placeholder="person@acme.example" /></label>
      </div>
      <fieldset class="repo-access">
        <legend>Can read</legend>
        ${state.repos
          .map(
            (repo) => `
          <label class="check">
            <input type="checkbox" data-repo="${escapeHtml(repo.id)}" ${user.repos.includes(repo.id) ? "checked" : ""} />
            <span>${escapeHtml(repo.id)}</span>
          </label>`,
          )
          .join("")}
        ${state.repos.length === 0 ? "<p class='muted'>Add a project first.</p>" : ""}
      </fieldset>
    </article>`,
    )
    .join("");
}

function showProblems(listEl, problems) {
  if (!problems || problems.length === 0) {
    listEl.hidden = true;
    listEl.innerHTML = "";
    return;
  }
  listEl.hidden = false;
  listEl.innerHTML = problems.map((p) => `<li>${escapeHtml(p)}</li>`).join("");
}

/* --------------------------- reading the forms --------------------------- */

function collectRepos() {
  return [...el.repoList.querySelectorAll(".card")].map((card) => {
    const value = (field) => card.querySelector(`[data-field="${field}"]`).value.trim();
    return {
      id: value("id"),
      path: value("path"),
      url: value("url"),
      language: value("language"),
      summary: value("summary"),
    };
  });
}

function collectUsers() {
  return [...el.userList.querySelectorAll(".card")].map((card) => {
    const value = (field) => card.querySelector(`[data-field="${field}"]`).value.trim();
    return {
      id: value("id"),
      name: value("name"),
      email: value("email"),
      repos: [...card.querySelectorAll("input[type=checkbox]")]
        .filter((box) => box.checked)
        .map((box) => box.dataset.repo),
    };
  });
}

/* --------------------------- wiring --------------------------- */

async function load() {
  const data = await fetch("/api/admin/config").then((r) => r.json());
  if (data.error === "admin_token_required") {
    el.authNote.hidden = false;
    el.authNote.textContent =
      "This dashboard is protected by ADMIN_TOKEN. Open it with the token configured, or unset ADMIN_TOKEN for local use.";
    return;
  }

  state.repos = data.repos.map((r) => ({ ...r, url: r.url ?? "" }));
  state.users = data.users.map((u) => ({ ...u, email: u.email ?? "", repos: u.repos ?? [] }));
  state.status = data.status;

  el.indexLine.textContent = `${state.repos.length} projects · ${state.users.length} people · index built ${new Date(data.generatedAt).toLocaleString()}`;

  if (!data.protected) {
    el.authNote.hidden = false;
    el.authNote.textContent =
      "No ADMIN_TOKEN is set, so anyone who can reach this server can edit these settings. Set ADMIN_TOKEN in .env before exposing it beyond localhost.";
  }

  renderRepos();
  renderUsers();
}

async function save(kind) {
  const isRepos = kind === "repos";
  const button = isRepos ? el.saveRepos : el.saveUsers;
  const statusEl = isRepos ? el.repoStatus : el.userStatus;
  const problemsEl = isRepos ? el.repoProblems : el.userProblems;

  // Keep whatever is on screen, so a failed save does not lose the edits.
  state.repos = collectRepos();
  state.users = collectUsers();

  button.disabled = true;
  statusEl.textContent = isRepos ? "Saving and re-indexing…" : "Saving…";
  showProblems(problemsEl, []);

  try {
    const response = await fetch(`/api/admin/${kind}`, {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(isRepos ? { repos: state.repos } : { users: state.users }),
    });
    const data = await response.json();

    if (!response.ok) {
      statusEl.textContent = "Not saved.";
      showProblems(problemsEl, data.problems ?? [data.error ?? "Save failed."]);
      return;
    }

    if (isRepos) {
      state.repos = data.repos.map((r) => ({ ...r, url: r.url ?? "" }));
      state.users = data.users.map((u) => ({ ...u, email: u.email ?? "", repos: u.repos ?? [] }));
      state.status = data.status;
      renderRepos();
      renderUsers();
      const total = Object.values(data.status).reduce((sum, s) => sum + s.indexedFiles, 0);
      statusEl.textContent = `Saved. Re-indexed ${total} files.`;
    } else {
      state.users = data.users;
      renderUsers();
      statusEl.textContent = "Saved.";
    }
    el.indexLine.textContent = `${state.repos.length} projects · ${state.users.length} people · index built ${new Date().toLocaleString()}`;
  } catch (error) {
    statusEl.textContent = "Not saved.";
    showProblems(problemsEl, [error.message ?? String(error)]);
  } finally {
    button.disabled = false;
    setTimeout(() => (statusEl.textContent = ""), 4000);
  }
}

el.addRepo.addEventListener("click", () => {
  state.repos = [...collectRepos(), { id: "", path: "", url: "", language: "", summary: "" }];
  renderRepos();
  el.repoList.querySelector(".card:last-child .id-input")?.focus();
});

el.addUser.addEventListener("click", () => {
  state.users = [...collectUsers(), { id: "", name: "", email: "", repos: [] }];
  renderUsers();
  el.userList.querySelector(".card:last-child .id-input")?.focus();
});

document.addEventListener("click", (event) => {
  const remove = event.target.closest("[data-remove]");
  if (!remove) return;
  const index = Number(remove.closest(".card").dataset.index);
  if (remove.dataset.remove === "repo") {
    state.repos = collectRepos().filter((_, i) => i !== index);
    state.users = collectUsers();
    renderRepos();
    renderUsers();
  } else {
    state.users = collectUsers().filter((_, i) => i !== index);
    renderUsers();
  }
});

el.saveRepos.addEventListener("click", () => save("repos"));
el.saveUsers.addEventListener("click", () => save("users"));

load();
