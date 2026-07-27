// github-api.js
// Minimal GitHub Contents API client. Lets a swipe (Plan/Dismiss) commit
// directly to the repo instead of requiring the manual "copy id, run this
// Action" step. Needs a fine-grained Personal Access Token scoped to just
// this repo (Contents: Read and write), stored in the browser's
// localStorage — nothing leaves the browser except direct calls to
// api.github.com using that token.

const STORAGE_KEY = "lm_github_config";

export function getGithubConfig() {
  try {
    return JSON.parse(localStorage.getItem(STORAGE_KEY) || "null");
  } catch {
    return null;
  }
}

export function saveGithubConfig(config) {
  localStorage.setItem(STORAGE_KEY, JSON.stringify(config));
}

export function clearGithubConfig() {
  localStorage.removeItem(STORAGE_KEY);
}

function apiBase(config) {
  return `https://api.github.com/repos/${config.owner}/${config.repo}/contents/`;
}

async function ghRequest(config, path, options = {}) {
  const res = await fetch(apiBase(config) + path, {
    ...options,
    headers: {
      Authorization: `Bearer ${config.token}`,
      Accept: "application/vnd.github+json",
      "X-GitHub-Api-Version": "2022-11-28",
      ...(options.headers || {}),
    },
  });
  if (!res.ok) {
    const body = await res.text().catch(() => "");
    const err = new Error(`GitHub API ${res.status} on ${path}: ${body.slice(0, 300)}`);
    err.status = res.status;
    throw err;
  }
  return res.json();
}

// UTF-8 safe base64 encode/decode (atob/btoa are Latin1-only by default)
function b64EncodeUtf8(str) {
  return btoa(unescape(encodeURIComponent(str)));
}
function b64DecodeUtf8(str) {
  return decodeURIComponent(escape(atob(str)));
}

export async function getFile(config, path) {
  const data = await ghRequest(config, path);
  const content = b64DecodeUtf8(data.content.replace(/\n/g, ""));
  return { json: JSON.parse(content), sha: data.sha };
}

export async function putFile(config, path, obj, sha, message) {
  const content = b64EncodeUtf8(JSON.stringify(obj, null, 2) + "\n");
  try {
    return await ghRequest(config, path, {
      method: "PUT",
      body: JSON.stringify({ message, content, sha }),
    });
  } catch (err) {
    // Someone else committed (e.g. the scheduled discovery Action) between
    // our GET and PUT. Refetch the current sha and retry once with the
    // same content — good enough for a low-concurrency personal tool.
    if (err.status === 409) {
      const fresh = await getFile(config, path);
      return await ghRequest(config, path, {
        method: "PUT",
        body: JSON.stringify({ message, content, sha: fresh.sha }),
      });
    }
    throw err;
  }
}

export async function testConnection(config) {
  await getFile(config, "data/config.json");
}
 