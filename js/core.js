// Phần lõi dùng chung, viết lại đúng theo core/*.py của bản máy tính
// (cùng định dạng dữ liệu, cùng quy tắc gộp thay đổi, cùng cách đặt tên thư mục).

export const STATUSES = [
  ["Chưa bắt đầu", "#8a989c", 0],
  ["Đang lập", "#b7791f", 30],
  ["Cần bổ sung", "#c05621", 50],
  ["Đang xem xét", "#2b6cb0", 60],
  ["Trình duyệt", "#6b46c1", 80],
  ["Đã duyệt", "#2f855a", 100],
  ["Hoàn công", "#0d6b70", 100],
  ["Không áp dụng", "#b8c4c7", null],
];
export const STATUS_NAMES = STATUSES.map((s) => s[0]);
export const STATUS_COLOR = Object.fromEntries(STATUSES.map((s) => [s[0], s[1]]));
export const STATUS_PROGRESS = Object.fromEntries(STATUSES.map((s) => [s[0], s[2]]));
export const DONE_STATUSES = new Set(["Đã duyệt", "Hoàn công"]);
export const SKIP_STATUSES = new Set(["Không áp dụng"]);

export const SUITABILITY = [
  ["S0", "Đang lập (WIP), chưa phát hành"],
  ["S1", "Phát hành để phối hợp"],
  ["S2", "Phát hành để tham khảo"],
  ["S3", "Phát hành để xem xét, cho ý kiến"],
  ["S4", "Trình phê duyệt giai đoạn"],
  ["A1", "Đã chấp thuận – giai đoạn 1"],
  ["A2", "Đã chấp thuận – giai đoạn 2"],
  ["A3", "Đã chấp thuận – giai đoạn 3"],
  ["A4", "Đã chấp thuận – giai đoạn 4"],
  ["B1", "Chấp thuận một phần, có ý kiến – giai đoạn 1"],
  ["B2", "Chấp thuận một phần, có ý kiến – giai đoạn 2"],
  ["B3", "Chấp thuận một phần, có ý kiến – giai đoạn 3"],
  ["B4", "Chấp thuận một phần, có ý kiến – giai đoạn 4"],
  ["CR", "Hồ sơ hoàn công (as-constructed record)"],
];
export const SUIT_TO_STATUS = { S0: "Đang lập", S1: "Đang lập", S2: "Đang lập", S3: "Đang xem xét", S4: "Trình duyệt", CR: "Hoàn công" };
for (const [c] of SUITABILITY) {
  if (c[0] === "A") SUIT_TO_STATUS[c] = "Đã duyệt";
  else if (c[0] === "B") SUIT_TO_STATUS[c] = "Cần bổ sung";
}

export const META = "_QLHS";
export const SCHEMA = 1;
export const ONLINE_MINUTES = 10;

// ---------------------------------------------------------------- chuỗi
export function noAccent(s) {
  s = (s || "").replace(/đ/g, "d").replace(/Đ/g, "D");
  return s.normalize("NFD").replace(/\p{Mn}/gu, "");
}
export const norm = (s) => noAccent(s).toLowerCase();

const STOP = new Set(["va", "cua", "cac", "voi", "cho", "the", "tu", "trong", "hoac", "kem", "ve", "tai", "theo", "duoc"]);

export function slug(title, maxWords = 4) {
  const t = noAccent(title).replace(/\(.*?\)/g, " ");
  const words = (t.match(/[A-Za-z0-9]+/g) || []).filter((w) => !STOP.has(w.toLowerCase())).slice(0, maxWords);
  return words.map((w) => w.slice(0, 1).toUpperCase() + w.slice(1)).join("-") || "HoSo";
}

export function safeName(name) {
  // giống Python: bỏ ký tự cấm, strip() rồi bỏ dấu chấm cuối
  name = (name || "").replace(/[<>:"/\\|?*\x00-\x1f]/g, "_").trim().replace(/\.+$/, "");
  return name || "_";
}

// ---------------------------------------------------------------- thời gian
const p2 = (n) => String(n).padStart(2, "0");

/** UTC dạng ISO giống Python isoformat(timespec="milliseconds"): 2026-11-10T09:58:45.248+00:00 */
export function nowIso(d = new Date()) {
  return d.toISOString().replace("Z", "+00:00");
}

export function newId() {
  const a = new Uint8Array(6);
  globalThis.crypto.getRandomValues(a);
  return Array.from(a, (b) => b.toString(16).padStart(2, "0")).join("");
}

/** 'dd/mm/yyyy', 'd/m/yy', 'yyyy-mm-dd' -> Date (giờ địa phương 00:00) hoặc null */
export function parseDate(s) {
  s = (s || "").trim();
  if (!s) return null;
  let m = s.match(/^(\d{4})-(\d{1,2})-(\d{1,2})$/);
  let y, mo, d;
  if (m) [y, mo, d] = [+m[1], +m[2], +m[3]];
  else {
    m = s.match(/^(\d{1,2})[/.\-](\d{1,2})[/.\-](\d{2,4})$/);
    if (!m) return null;
    [d, mo, y] = [+m[1], +m[2], +m[3]];
    if (y < 100) y += 2000;
  }
  const dt = new Date(y, mo - 1, d);
  return dt.getFullYear() === y && dt.getMonth() === mo - 1 && dt.getDate() === d ? dt : null;
}
export function dateIsoOf(dt) {
  return dt ? `${dt.getFullYear()}-${p2(dt.getMonth() + 1)}-${p2(dt.getDate())}` : "";
}
export function dateVn(iso) {
  const d = parseDate(iso);
  return d ? `${p2(d.getDate())}/${p2(d.getMonth() + 1)}/${d.getFullYear()}` : "";
}
export function fmtDt(iso) {
  if (!iso) return "";
  const d = new Date(iso);
  if (isNaN(d)) return iso;
  return `${p2(d.getDate())}/${p2(d.getMonth() + 1)}/${d.getFullYear()} ${p2(d.getHours())}:${p2(d.getMinutes())}`;
}
export function today() {
  const n = new Date();
  return new Date(n.getFullYear(), n.getMonth(), n.getDate());
}
export const daysBetween = (a, b) => Math.round((b - a) / 86400000);

// ---------------------------------------------------------------- gộp bản ghi
/** Gộp theo từng bản ghi: bản có updated_at mới hơn thắng (giống store.merge_records). */
export function mergeRecords(a, b) {
  const out = { ...a };
  for (const [k, rb] of Object.entries(b || {})) {
    const ra = out[k];
    if (ra == null || (rb.updated_at || "") > (ra.updated_at || "")) out[k] = rb;
  }
  return out;
}

/** Tên tệp có phải bản xung đột / bản trùng của stem.json không (hoso.json -> hoso (1).json, hoso-MAY.json…) */
export function isCopyOf(name, base) {
  const low = name.toLowerCase();
  const b = base.toLowerCase();
  const stem = b.replace(/\.json$/, "");
  return low !== b && low.startsWith(stem) && low.endsWith(".json");
}

// ---------------------------------------------------------------- hồ sơ
/** 'P3-02' -> [3, 2] */
export function pkey(pcode) {
  const m = (pcode || "").slice(1).split("-");
  if (m.length < 2) return [99, 99];
  const a = parseInt(m[0], 10);
  const digits = m.slice(1).join("-").replace(/\D/g, "");
  if (isNaN(a) || !/^\s*[+-]?\d+\s*$/.test(m[0])) return [99, 99];
  return [a, digits ? parseInt(digits, 10) : 0];
}

/** Giống store.sort_key: giai đoạn, thứ tự xếp tay (nếu không có thì số trong mã DM), mã DM, tên. */
const isNum = (v) => typeof v === "number" && isFinite(v);
export function cmpRecords(x, y) {
  const kx = pkey(x.pcode), ky = pkey(y.pcode);
  const a = [x.phase || 0, isNum(x.order) ? x.order : kx[1], ...kx], b = [y.phase || 0, isNum(y.order) ? y.order : ky[1], ...ky];
  for (let i = 0; i < 4; i++) if (a[i] !== b[i]) return a[i] - b[i];
  return (x.title || "") < (y.title || "") ? -1 : (x.title || "") > (y.title || "") ? 1 : 0;
}

export function isOverdue(rec, now = today()) {
  const d = parseDate(rec.due || "");
  return !!(d && d < now && !DONE_STATUSES.has(rec.status) && !SKIP_STATUSES.has(rec.status));
}

export function sortedPhases(info) {
  return [...(info.phases || [])].sort((a, b) => a.num - b.num);
}

export function defaultFolder(info, rec) {
  const ph = (info.phases || []).find((p) => p.num === (rec.phase || 0));
  const base = ph ? ph.folder : "99_DU-LIEU-TAM";
  return `${base}/${safeName((rec.pcode || "") + "_" + slug(rec.title || ""))}`;
}
export const recordFolder = (info, rec) => rec.folder || defaultFolder(info, rec);

export function phaseTitle(info, num) {
  const ph = (info.phases || []).find((p) => p.num === num);
  return ph ? `${num}. ${ph.title}` : `Giai đoạn ${num}`;
}

export function stats(info, recs, now = today()) {
  const rows = [];
  for (const ph of [...sortedPhases(info), { num: null, title: "Toàn dự án" }]) {
    const rs = recs.filter((r) => ph.num == null || r.phase === ph.num);
    const counted = rs.filter((r) => !SKIP_STATUSES.has(r.status));
    const prog = counted.map((r) => STATUS_PROGRESS[r.status] || 0);
    rows.push({
      num: ph.num, title: ph.title, total: rs.length, counted: counted.length,
      done: counted.filter((r) => DONE_STATUSES.has(r.status)).length,
      not_started: counted.filter((r) => r.status === "Chưa bắt đầu").length,
      overdue: counted.filter((r) => isOverdue(r, now)).length,
      with_files: rs.filter((r) => (r.files || []).length).length,
      progress: prog.length ? Math.round((prog.reduce((a, b) => a + b, 0) / prog.length) * 10) / 10 : 0,
    });
  }
  return rows;
}

// ---------------------------------------------------------------- revision
export const isApproved = (suit) => !!suit && ("AB".includes(suit[0]) || suit === "CR");

export function nextRevision(current, approved) {
  current = (current || "").trim().toUpperCase();
  const m = current.match(/^([PC])(\d{2,})$/);
  if (!m) return approved ? "C01" : "P01";
  const series = m[1], n = parseInt(m[2], 10);
  if (approved) return series === "C" ? `C${p2(n + 1)}` : "C01";
  return `${series}${p2(n + 1)}`;
}

// ---------------------------------------------------------------- mốc
export function milestoneState(m, now = today()) {
  const a = parseDate(m.actual || ""), p = parseDate(m.planned || "");
  if (a) {
    if (p) {
      const d = daysBetween(p, a);
      return "Hoàn thành" + (d > 0 ? ` (trễ ${d} ngày)` : d < 0 ? ` (sớm ${-d} ngày)` : " (đúng hạn)");
    }
    return "Hoàn thành";
  }
  if (!p) return "Chưa có kế hoạch";
  const d = daysBetween(now, p);
  return d < 0 ? `Trễ ${-d} ngày` : d === 0 ? "Hôm nay" : `Còn ${d} ngày`;
}

// ---------------------------------------------------------------- tìm kiếm
export function hay(rec) {
  const files = (rec.files || []).map((f) => f.path).join(" ");
  return norm([rec.pcode, rec.code, rec.title, rec.status, rec.owner, rec.note, rec.doc_no, files].join(" "));
}
export function matches(rec, text) {
  const h = hay(rec);
  return norm(text).trim().split(/\s+/).filter(Boolean).every((t) => h.includes(t));
}
