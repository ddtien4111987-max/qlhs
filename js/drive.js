// Google Drive: đăng nhập (OAuth chuyển trang, chạy được cả khi "Thêm vào màn hình chính" trên iPhone)
// và backend đọc/ghi tệp dự án theo đường dẫn tương đối.
import { META } from "./core.js";

const API = "https://www.googleapis.com/drive/v3";
const UP = "https://www.googleapis.com/upload/drive/v3";
const SCOPE = "https://www.googleapis.com/auth/drive";
const FOLDER = "application/vnd.google-apps.folder";
const SHORTCUT = "application/vnd.google-apps.shortcut";
const TOKEN_KEY = "qlhs.gtoken";
const FIELDS = "id,name,mimeType,version,modifiedTime,size,webViewLink,shortcutDetails(targetId,targetMimeType)";

export class AuthError extends Error {}

const q = (s) => s.replace(/\\/g, "\\\\").replace(/'/g, "\\'");

// ---------------------------------------------------------------- đăng nhập
export class GoogleAuth {
  constructor(clientId) {
    this.clientId = clientId;
    this.token = null;
    try { this.token = JSON.parse(localStorage.getItem(TOKEN_KEY) || "null"); } catch { this.token = null; }
  }

  static redirectUri() {
    return location.origin + location.pathname.replace(/index\.html$/, "");
  }

  /** Gọi khi trang mở: nhận token Google trả về trên #hash. Trả về true nếu vừa đăng nhập xong. */
  handleRedirect() {
    if (!location.hash.includes("access_token=")) {
      if (location.hash.includes("error=")) {
        const p = new URLSearchParams(location.hash.slice(1));
        history.replaceState(null, "", location.pathname + location.search);
        this.lastError = p.get("error");
      }
      return false;
    }
    const p = new URLSearchParams(location.hash.slice(1));
    const state = sessionStorage.getItem("qlhs.oauthState") || localStorage.getItem("qlhs.oauthState");
    history.replaceState(null, "", location.pathname + location.search);
    if (state && p.get("state") !== state) {
      this.lastError = "state";
      return false;
    }
    this.token = { access_token: p.get("access_token"), exp: Date.now() + (parseInt(p.get("expires_in") || "3600", 10) - 60) * 1000 };
    try { localStorage.setItem(TOKEN_KEY, JSON.stringify(this.token)); } catch { /* chế độ riêng tư */ }
    return true;
  }

  valid() {
    return !!(this.token && this.token.access_token && Date.now() < this.token.exp);
  }

  /** Chuyển sang trang đăng nhập Google (trang quay lại đúng chỗ này sau khi đăng nhập). */
  signIn({ hint = "", consent = false } = {}) {
    const state = Math.random().toString(36).slice(2) + Date.now().toString(36);
    try {
      sessionStorage.setItem("qlhs.oauthState", state);
      localStorage.setItem("qlhs.oauthState", state);
    } catch { /* bỏ qua */ }
    const p = new URLSearchParams({
      client_id: this.clientId, redirect_uri: GoogleAuth.redirectUri(), response_type: "token", scope: SCOPE,
      include_granted_scopes: "true", state,
    });
    if (hint) p.set("login_hint", hint);
    if (consent) p.set("prompt", "consent select_account");
    location.href = "https://accounts.google.com/o/oauth2/v2/auth?" + p.toString();
  }

  signOut() {
    const t = this.token && this.token.access_token;
    this.token = null;
    try { localStorage.removeItem(TOKEN_KEY); } catch { /* bỏ qua */ }
    if (t) fetch("https://oauth2.googleapis.com/revoke?token=" + encodeURIComponent(t), { method: "POST" }).catch(() => {});
  }
}

// ---------------------------------------------------------------- tài khoản Drive
export class DriveAccount {
  constructor(auth) {
    this.auth = auth;
  }

  async api(url, { method = "GET", body, headers = {}, as = "json" } = {}) {
    if (!this.auth.valid()) throw new AuthError("Phiên đăng nhập Google đã hết hạn");
    let res;
    for (let i = 0; i < 4; i++) {
      res = await fetch(url, { method, body, headers: { Authorization: `Bearer ${this.auth.token.access_token}`, ...headers } });
      if (res.status === 429 || res.status >= 500) {
        await new Promise((r) => setTimeout(r, 500 * 2 ** i));
        continue;
      }
      break;
    }
    if (res.status === 401) throw new AuthError("Phiên đăng nhập Google đã hết hạn");
    if (!res.ok) {
      let msg = `${res.status}`;
      try { msg += " " + ((await res.json()).error || {}).message; } catch { /* bỏ qua */ }
      const e = new Error(`Google Drive báo lỗi ${msg}`);
      e.status = res.status;
      throw e;
    }
    if (as === "json") return res.json();
    if (as === "text") return res.text();
    return res;
  }

  async about() {
    return this.api(`${API}/about?fields=user(displayName,emailAddress)`);
  }

  async listAll(query, fields = FIELDS, orderBy = "") {
    const out = [];
    let token = "";
    do {
      const p = new URLSearchParams({
        q: query, fields: `nextPageToken,files(${fields})`, pageSize: "1000", supportsAllDrives: "true",
        includeItemsFromAllDrives: "true", corpora: "allDrives",
      });
      if (orderBy) p.set("orderBy", orderBy);
      if (token) p.set("pageToken", token);
      const r = await this.api(`${API}/files?${p}`);
      out.push(...(r.files || []));
      token = r.nextPageToken || "";
    } while (token);
    return out;
  }

  async meta(id, fields = "id,name,parents,mimeType") {
    return this.api(`${API}/files/${id}?fields=${encodeURIComponent(fields)}&supportsAllDrives=true`);
  }

  /** Tìm mọi dự án: tệp project.json nằm trong thư mục _QLHS (của mình hoặc được chia sẻ). */
  async listProjects() {
    const files = await this.listAll(`name='project.json' and trashed=false and mimeType!='${FOLDER}'`, "id,name,parents,modifiedTime");
    const out = [];
    const seen = new Set();
    await Promise.all(files.map(async (f) => {
      try {
        const metaDir = await this.meta(f.parents[0]);
        if (metaDir.name !== META || !metaDir.parents) return;
        const rootId = metaDir.parents[0];
        if (seen.has(rootId)) return;
        seen.add(rootId);
        const [root, text] = await Promise.all([this.meta(rootId), this.api(`${API}/files/${f.id}?alt=media&supportsAllDrives=true`, { as: "text" })]);
        let info = {};
        try { info = JSON.parse(text); } catch { /* bỏ qua */ }
        out.push({ key: rootId, folder: root.name, code: info.code || "", name: info.name || root.name, modified: f.modifiedTime });
      } catch (e) {
        if (e instanceof AuthError) throw e;
      }
    }));
    return out.sort((a, b) => (b.modified || "").localeCompare(a.modified || ""));
  }

  project(rootId) {
    return new DriveProject(this, rootId);
  }
}

// ---------------------------------------------------------------- backend một dự án
export class DriveProject {
  constructor(acc, rootId) {
    this.acc = acc;
    this.rootId = rootId;
    this.dirIds = new Map([["", rootId]]);
    this.listing = new Map(); // dirId -> {at, files}
  }

  static split(rel) {
    const parts = rel.split("/").filter(Boolean);
    return { dir: parts.slice(0, -1).join("/"), name: parts[parts.length - 1] || "" };
  }

  static entry(f) {
    const isShortcut = f.mimeType === SHORTCUT && f.shortcutDetails;
    const id = isShortcut ? f.shortcutDetails.targetId : f.id;
    const mime = isShortcut ? f.shortcutDetails.targetMimeType : f.mimeType;
    return { name: f.name, isDir: mime === FOLDER, version: String(f.version || ""), modified: f.modifiedTime || "", key: id, link: f.webViewLink, size: +f.size || 0 };
  }

  async children(dirId, maxAge = 30000) {
    const c = this.listing.get(dirId);
    if (c && Date.now() - c.at < maxAge) return c.files;
    const files = (await this.acc.listAll(`'${dirId}' in parents and trashed=false`)).map(DriveProject.entry);
    this.listing.set(dirId, { at: Date.now(), files });
    return files;
  }

  async dirId(rel, create = false) {
    rel = rel.split("/").filter(Boolean).join("/");
    if (this.dirIds.has(rel)) return this.dirIds.get(rel);
    const { dir, name } = DriveProject.split(rel);
    const parent = await this.dirId(dir, create);
    if (!parent) return null;
    let hit = (await this.children(parent)).find((e) => e.isDir && e.name === name);
    if (!hit) hit = (await this.children(parent, 0)).find((e) => e.isDir && e.name === name);
    if (!hit) {
      if (!create) return null;
      const f = await this.acc.api(`${API}/files?supportsAllDrives=true&fields=id`, {
        method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ name, mimeType: FOLDER, parents: [parent] }),
      });
      this.listing.delete(parent);
      this.dirIds.set(rel, f.id);
      return f.id;
    }
    this.dirIds.set(rel, hit.key);
    return hit.key;
  }

  /** Bản chính của một tệp: cùng tên, sửa gần nhất (Drive cho phép nhiều tệp trùng tên). */
  async find(rel, fresh = true) {
    const { dir, name } = DriveProject.split(rel);
    const d = await this.dirId(dir);
    if (!d) return null;
    if (fresh) {
      const r = await this.acc.listAll(`'${d}' in parents and name='${q(name)}' and trashed=false`, FIELDS, "modifiedTime desc");
      return r.length ? DriveProject.entry(r[0]) : null;
    }
    const all = (await this.children(d)).filter((e) => e.name === name).sort((a, b) => b.modified.localeCompare(a.modified));
    return all[0] || null;
  }

  async list(relDir) {
    const d = await this.dirId(relDir);
    return d ? this.children(d, 0) : [];
  }

  async readKey(key) {
    return this.acc.api(`${API}/files/${key}?alt=media&supportsAllDrives=true`, { as: "text" });
  }

  async read(rel) {
    const e = await this.find(rel);
    if (!e) return null;
    return { text: await this.readKey(e.key), version: e.version };
  }

  async version(rel) {
    const e = await this.find(rel);
    return e ? e.version : null;
  }

  async write(rel, text, mime = "application/json") {
    const { dir, name } = DriveProject.split(rel);
    const e = await this.find(rel);
    if (e) {
      const r = await this.acc.api(`${UP}/files/${e.key}?uploadType=media&supportsAllDrives=true&fields=version`, {
        method: "PATCH", headers: { "Content-Type": `${mime}; charset=UTF-8` }, body: text,
      });
      return String(r.version);
    }
    const parent = await this.dirId(dir, true);
    const r = await this._multipart({ name, parents: [parent], mimeType: mime }, new Blob([text], { type: mime }));
    this.listing.delete(parent);
    return String(r.version);
  }

  async _multipart(metadata, blob) {
    const b = "qlhs" + Math.random().toString(36).slice(2);
    const body = new Blob([
      `--${b}\r\nContent-Type: application/json; charset=UTF-8\r\n\r\n${JSON.stringify(metadata)}\r\n`,
      `--${b}\r\nContent-Type: ${blob.type || "application/octet-stream"}\r\n\r\n`, blob, `\r\n--${b}--`,
    ]);
    return this.acc.api(`${UP}/files?uploadType=multipart&supportsAllDrives=true&fields=id,version,name`, {
      method: "POST", headers: { "Content-Type": `multipart/related; boundary=${b}` }, body,
    });
  }

  async ensureDir(rel) {
    await this.dirId(rel, true);
  }

  async upload(relDir, name, blob) {
    const parent = await this.dirId(relDir, true);
    const names = new Set((await this.children(parent, 0)).map((e) => e.name.toLowerCase()));
    const dot = name.lastIndexOf(".");
    const stem = dot > 0 ? name.slice(0, dot) : name, ext = dot > 0 ? name.slice(dot) : "";
    let final = name;
    for (let n = 2; names.has(final.toLowerCase()); n++) final = `${stem} (${n})${ext}`;
    const meta = { name: final, parents: [parent] };
    if (blob.size <= 4 * 1024 * 1024) {
      await this._multipart(meta, blob);
    } else {
      const init = await this.acc.api(`${UP}/files?uploadType=resumable&supportsAllDrives=true`, {
        method: "POST", as: "raw",
        headers: { "Content-Type": "application/json; charset=UTF-8", "X-Upload-Content-Type": blob.type || "application/octet-stream" },
        body: JSON.stringify(meta),
      });
      const loc = init.headers.get("Location");
      const res = await fetch(loc, { method: "PUT", body: blob });
      if (!res.ok) throw new Error(`Tải tệp lên thất bại (${res.status})`);
    }
    this.listing.delete(parent);
    return final;
  }

  async exists(rel) {
    return !!(await this.find(rel, false));
  }

  async openUrl(rel) {
    const e = await this.find(rel, false);
    if (!e) return null;
    return e.link || `https://drive.google.com/file/d/${e.key}/view`;
  }
}
