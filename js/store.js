// Dự án trên cloud, đọc/ghi qua một "backend" (Google Drive, hoặc máy chủ thử nghiệm).
// Cùng bố cục và quy tắc gộp với core/store.py:
//   <Dự án>/_QLHS/project.json, hoso.json, moc.json, nhatky/<người>@<máy>.jsonl, dang-mo/<người>@<máy>.json
//
// Giao diện backend (mọi đường dẫn tương đối so với thư mục gốc dự án, phân cách "/"):
//   list(relDir)            -> [{name, isDir, version, modified, key}]   ([] nếu không có thư mục)
//   read(relPath)           -> {text, version} | null                   (bản chính = bản sửa gần nhất)
//   readKey(key)            -> text
//   version(relPath)        -> string | null
//   write(relPath, text)    -> version mới (tạo thư mục nếu thiếu)
//   ensureDir(relDir)
//   upload(relDir, name, blob) -> tên tệp thực tế (thêm " (2)" nếu trùng)
//   openUrl(relPath)        -> link mở tệp | null
//   exists(relPath)         -> bool
import {
  META, SCHEMA, ONLINE_MINUTES, mergeRecords, isCopyOf, nowIso, safeName, cmpRecords, recordFolder, stats, sortedPhases,
} from "./core.js";

export class RecordSet {
  constructor(backend, base) {
    this.b = backend;
    this.base = base;
    this.path = `${META}/${base}`;
    this.records = {};
    this.version = null;
    this.dirty = new Set();
  }

  _pick(entries) {
    const same = entries.filter((e) => !e.isDir && e.name.toLowerCase() === this.base.toLowerCase())
      .sort((a, b) => (b.modified || "").localeCompare(a.modified || ""));
    const copies = entries.filter((e) => !e.isDir && isCopyOf(e.name, this.base));
    // dấu vân tay: bản chính + mọi bản trùng / bản xung đột (để biết có gì mới mà không phải tải về)
    const sig = [...same, ...copies].map((e) => `${e.name}|${e.version}`).sort().join("/");
    return { same, copies, sig };
  }

  async _readMerged() {
    const { same, copies, sig } = this._pick(await this.b.list(META));
    this.sig = sig;
    let recs = {};
    let version = null;
    for (const [i, e] of [...same, ...copies].entries()) {
      let data;
      try {
        data = JSON.parse(await this.b.readKey(e.key));
      } catch {
        continue; // tệp đang ghi dở / hỏng: bỏ qua lần này
      }
      if (data && typeof data.records === "object" && data.records) recs = mergeRecords(recs, data.records);
      if (i === 0 && same.length) version = e.version;
    }
    return { recs, version, copies: copies.length + Math.max(0, same.length - 1) };
  }

  async load() {
    const { recs, version } = await this._readMerged();
    this.records = recs;
    this.version = version;
    return this;
  }

  async changed() {
    return this._pick(await this.b.list(META)).sig !== this.sig;
  }

  /** Gộp thay đổi trên cloud vào bộ nhớ, giữ bản đang sửa. Trả về id các bản ghi thay đổi. */
  async refresh() {
    const old = this.records;
    const { recs, version } = await this._readMerged();
    const merged = mergeRecords(old, recs);
    for (const k of this.dirty) if (old[k]) merged[k] = old[k];
    this.records = merged;
    this.version = version;
    return Object.keys(merged).filter((k) => old[k] !== merged[k] && JSON.stringify(old[k]) !== JSON.stringify(merged[k]));
  }

  put(rec, user) {
    rec.updated_at = nowIso();
    rec.updated_by = user;
    this.records[rec.id] = rec;
    this.dirty.add(rec.id);
  }

  /** Đọc lại bản trên cloud, gộp, ghi. Nếu có người ghi chen giữa lúc đọc và lúc ghi thì làm lại. */
  async save(user) {
    for (let attempt = 0; ; attempt++) {
      const { recs, version } = await this._readMerged();
      const mine = {};
      for (const k of this.dirty) if (this.records[k]) mine[k] = this.records[k];
      const merged = Object.assign(mergeRecords(this.records, recs), mine);
      if (attempt < 3 && (await this.b.version(this.path)) !== version) continue;
      const text = JSON.stringify({ schema: SCHEMA, saved_by: user, saved_at: nowIso(), records: merged }, null, 1);
      this.version = await this.b.write(this.path, text);
      this.records = merged;
      this.dirty.clear();
      return;
    }
  }

  active() {
    return Object.values(this.records).filter((r) => !r.deleted);
  }

  pending() {
    return [...this.dirty].map((k) => this.records[k]).filter(Boolean);
  }

  restore(recs) {
    for (const r of recs || []) {
      const cur = this.records[r.id];
      if (!cur || (r.updated_at || "") >= (cur.updated_at || "")) {
        this.records[r.id] = r;
        this.dirty.add(r.id);
      }
    }
  }
}

export class Project {
  /** host: tên "máy" của thiết bị này, vd "dien-thoai-3fa2" */
  constructor(backend, user, host) {
    this.b = backend;
    this.user = user;
    this.host = host;
    this.info = {};
    this.infoVersion = null;
    this.docs = new RecordSet(backend, "hoso.json");
    this.miles = new RecordSet(backend, "moc.json");
    this._logChain = Promise.resolve();
  }

  async load() {
    const r = await this.b.read(`${META}/project.json`);
    if (!r) throw new Error("Không đọc được _QLHS/project.json");
    this.info = JSON.parse(r.text);
    this.info.phases = this.info.phases || [];
    this.info.members = this.info.members || [];
    this.infoVersion = r.version;
    await Promise.all([this.docs.load(), this.miles.load()]);
    return this;
  }

  get code() { return this.info.code || ""; }
  get name() { return this.info.name || ""; }
  get phases() { return sortedPhases(this.info); }

  records() { return this.docs.active().sort(cmpRecords); }
  get(id) { const r = this.docs.records[id]; return r && !r.deleted ? r : null; }
  stats() { return stats(this.info, this.records()); }
  folderOf(rec) { return recordFolder(this.info, rec); }

  members() {
    const names = [...(this.info.members || [])];
    for (const r of this.records()) if (r.owner && !names.includes(r.owner)) names.push(r.owner);
    if (!names.includes(this.user)) names.push(this.user);
    return names;
  }

  /** Kiểm tra thay đổi từ cloud. Trả về {docs: [id…], other: bool} */
  async sync(force = false) {
    const out = { docs: [], other: false };
    if (force || (await this.docs.changed())) out.docs = await this.docs.refresh();
    if (force || (await this.miles.changed())) out.other = (await this.miles.refresh()).length > 0;
    const v = await this.b.version(`${META}/project.json`);
    if (v && v !== this.infoVersion) {
      const r = await this.b.read(`${META}/project.json`);
      if (r) {
        this.info = { ...this.info, ...JSON.parse(r.text) };
        this.infoVersion = r.version;
        out.other = true;
      }
    }
    return out;
  }

  async saveRecord(rec, action = "Cập nhật", detail = "") {
    this.docs.put(rec, this.user);
    await this.docs.save(this.user);
    this.log(action, rec, detail);
  }

  async issueRevision(rec, { rev, suit, status, date, note, files = [] }) {
    rec.history = rec.history || [];
    rec.history.push({ rev, suit, status, date, by: this.user, note, files: [...files], at: nowIso() });
    Object.assign(rec, { rev, suit, status });
    if (date && !rec.doc_date) rec.doc_date = date;
    await this.saveRecord(rec, "Phát hành", `${rev} · ${suit} · ${status}` + (note ? ` – ${note}` : ""));
  }

  link(rec, rel) {
    rec.files = rec.files || [];
    if (rec.files.some((f) => f.path === rel)) return false;
    rec.files.push({ path: rel, added_by: this.user, added_at: nowIso() });
    return true;
  }

  /** Tải tệp (ảnh chụp, PDF…) lên thư mục hồ sơ và gắn vào hồ sơ. files: [{name, blob}] */
  async attach(rec, files, onProgress) {
    const folder = this.folderOf(rec);
    await this.b.ensureDir(folder);
    const rels = [];
    for (const [i, f] of files.entries()) {
      onProgress && onProgress(i, files.length, f.name);
      const name = await this.b.upload(folder, safeName(f.name), f.blob);
      const rel = `${folder}/${name}`;
      this.link(rec, rel);
      rels.push(rel);
    }
    if (!rec.folder) rec.folder = folder;
    return rels;
  }

  milestones() {
    return this.miles.active().sort((a, b) => (a.order || 0) - (b.order || 0) || (a.planned || "9999").localeCompare(b.planned || "9999"));
  }

  async saveMilestone(m, action = "Sửa mốc") {
    this.miles.put(m, this.user);
    await this.miles.save(this.user);
    this.log(action, null, m.name || "");
  }

  // ---------- nhật ký: mỗi người / thiết bị một tệp, ghi nối tiếp
  logName() { return `${META}/nhatky/${safeName(`${this.user}@${this.host}`)}.jsonl`; }

  log(action, rec = null, detail = "") {
    const line = {
      at: nowIso(), user: this.user, host: this.host, action,
      rec: rec ? rec.id : "", pcode: rec ? rec.pcode || "" : "", title: rec ? rec.title || "" : "", detail,
    };
    this._logChain = this._logChain.then(async () => {
      try {
        const cur = await this.b.read(this.logName());
        const prev = cur ? cur.text : "";
        const text = (prev && !prev.endsWith("\n") ? prev + "\n" : prev) + JSON.stringify(line) + "\n";
        await this.b.write(this.logName(), text);
      } catch (e) {
        console.warn("Không ghi được nhật ký", e); // nhật ký không được làm hỏng thao tác chính
      }
    });
    return this._logChain;
  }

  async readLogs(limit = 500) {
    const out = [];
    const entries = (await this.b.list(`${META}/nhatky`)).filter((e) => !e.isDir && e.name.endsWith(".jsonl"));
    const texts = await Promise.all(entries.map((e) => this.b.readKey(e.key).catch(() => "")));
    for (const t of texts) for (const ln of t.split("\n")) {
      if (!ln.trim()) continue;
      try { out.push(JSON.parse(ln)); } catch { /* dòng ghi dở */ }
    }
    out.sort((a, b) => (b.at || "").localeCompare(a.at || ""));
    return out.slice(0, limit);
  }

  // ---------- ai đang mở
  presenceName() { return `${META}/dang-mo/${safeName(`${this.user}@${this.host}`)}.json`; }

  async heartbeat() {
    try {
      await this.b.write(this.presenceName(), JSON.stringify({ user: this.user, host: this.host, at: nowIso() }));
    } catch { /* không quan trọng */ }
  }

  async online() {
    const limit = nowIso(new Date(Date.now() - ONLINE_MINUTES * 60000));
    const me = this.presenceName().split("/").pop();
    const entries = (await this.b.list(`${META}/dang-mo`)).filter((e) => !e.isDir && e.name.endsWith(".json") && e.name !== me);
    const out = [];
    for (const e of entries) {
      try {
        const x = JSON.parse(await this.b.readKey(e.key));
        if (x && (x.at || "") >= limit) out.push(x);
      } catch { /* bỏ qua */ }
    }
    return out;
  }
}
