// Giao diện bản điện thoại / máy tính bảng.
import {
  STATUS_NAMES, STATUS_COLOR, SUITABILITY, SUIT_TO_STATUS, DONE_STATUSES, SKIP_STATUSES, dateVn, fmtDt, parseDate, today,
  daysBetween, isOverdue, matches, nextRevision, isApproved, milestoneState, phaseTitle, safeName, dateIsoOf,
} from "./core.js";
import { Project } from "./store.js";
import { GoogleAuth, DriveAccount, AuthError } from "./drive.js";

const VERSION = "1.1.0";
const SYNC_MS = 20000;
const HEARTBEAT_MS = 120000;
const $ = (sel, el = document) => el.querySelector(sel);

// ---------------------------------------------------------------- lưu cài đặt trên thiết bị
const LS = {
  get(k, d = "") { try { const v = localStorage.getItem("qlhs." + k); return v == null ? d : v; } catch { return d; } },
  set(k, v) { try { localStorage.setItem("qlhs." + k, v); } catch { /* chế độ riêng tư */ } },
  del(k) { try { localStorage.removeItem("qlhs." + k); } catch { /* bỏ qua */ } },
  json(k, d = null) { try { return JSON.parse(LS.get(k, "") || "null") ?? d; } catch { return d; } },
};

const S = {
  dev: new URLSearchParams(location.search).has("dev"),
  auth: null, acc: null, me: null, projects: null, key: null, p: null,
  tab: "dash", f: { text: "", phase: null, status: "", quick: "" },
  sheet: null, syncing: false, error: "", online: [], logs: null,
};

function hostName() {
  let h = LS.get("host");
  if (!h) {
    const ua = navigator.userAgent;
    const kind = /iPad|Tablet|Android(?!.*Mobile)/i.test(ua) ? "may-tinh-bang" : /iPhone|Android|Mobile/i.test(ua) ? "dien-thoai" : "trinh-duyet";
    h = `${kind}-${Math.random().toString(16).slice(2, 6)}`;
    LS.set("host", h);
  }
  return h;
}
const userName = () => LS.get("user") || (S.me && S.me.displayName) || "Người dùng";

// ---------------------------------------------------------------- dựng DOM
function h(tag, attrs = {}, ...kids) {
  const el = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs || {})) {
    if (v == null || v === false) continue;
    if (k === "class") el.className = v;
    else if (k === "style" && typeof v === "object") Object.assign(el.style, v);
    else if (k.startsWith("on")) el.addEventListener(k.slice(2), v);
    else if (k === "html") el.innerHTML = v;
    else if (v === true) el.setAttribute(k, "");
    else el.setAttribute(k, v);
  }
  for (const c of kids.flat(Infinity)) if (c != null && c !== false) el.append(c.nodeType ? c : String(c));
  return el;
}
const statusDot = (s) => h("span", { class: "dot", style: { background: STATUS_COLOR[s] || "#999" } });
const statusChip = (s) => h("span", { class: "chip st" }, statusDot(s), s || "Chưa bắt đầu");

function toast(msg, kind = "") {
  const t = h("div", { class: `toast ${kind}` }, msg);
  $("#toasts").append(t);
  setTimeout(() => t.classList.add("show"), 10);
  setTimeout(() => { t.classList.remove("show"); setTimeout(() => t.remove(), 300); }, kind === "err" ? 6000 : 2600);
}

/** Hộp hỏi nhiều lựa chọn. buttons: [{label, value, kind}] */
function ask(title, text, buttons) {
  return new Promise((resolve) => {
    const close = (v) => { m.remove(); resolve(v); };
    const m = h("div", { class: "modal" },
      h("div", { class: "box" }, h("h3", {}, title), text ? h("p", {}, text) : null,
        h("div", { class: "row end" }, buttons.map((b) => h("button", { class: `btn ${b.kind || ""}`, onclick: () => close(b.value) }, b.label)))));
    document.body.append(m);
  });
}

// ---------------------------------------------------------------- lỗi và đăng nhập lại
async function guard(fn, what = "") {
  try {
    return await fn();
  } catch (e) {
    console.error(e);
    if (e instanceof AuthError) {
      savePending();
      // không có gì đang sửa dở: đăng nhập lại luôn (thay đổi chưa gửi đã giữ trên máy, gửi tiếp sau khi quay lại)
      if (!(S.sheet && S.sheet.dirty()) && S.auth && LS.get("email")) return relogin();
      S.error = "auth";
      renderBanner();
    } else if (!navigator.onLine || e instanceof TypeError) {
      savePending();
      S.error = "offline";
      renderBanner();
      toast(`${what ? what + ": " : ""}chưa gửi được lên cloud – sẽ gửi lại khi có mạng.`, "warn");
    } else {
      toast(`${what ? what + ": " : ""}${e.message || e}`, "err");
    }
    return undefined;
  }
}

function savePending() {
  if (!S.p) return;
  const pend = { docs: S.p.docs.pending(), miles: S.p.miles.pending() };
  if (pend.docs.length || pend.miles.length) LS.set("pending." + S.key, JSON.stringify(pend));
}

async function flushPending() {
  if (!S.p) return;
  const pend = LS.json("pending." + S.key);
  if (pend) {
    S.p.docs.restore(pend.docs);
    S.p.miles.restore(pend.miles);
  }
  if (!S.p.docs.dirty.size && !S.p.miles.dirty.size) return;
  if (S.p.docs.dirty.size) await S.p.docs.save(S.p.user);
  if (S.p.miles.dirty.size) await S.p.miles.save(S.p.user);
  LS.del("pending." + S.key);
  toast("Đã gửi các thay đổi lưu tạm lên cloud.");
}

function renderBanner() {
  const b = $("#banner");
  b.innerHTML = "";
  b.hidden = !S.error;
  if (S.error === "auth") {
    b.append(h("span", {}, "Phiên đăng nhập Google đã hết hạn. Thay đổi chưa gửi được giữ trên máy."),
      h("button", { class: "btn small", onclick: () => relogin() }, "Đăng nhập lại"));
  } else if (S.error === "offline") {
    b.append(h("span", {}, "Đang mất mạng. Thay đổi được giữ trên máy và gửi lại khi có mạng."),
      h("button", { class: "btn small", onclick: () => syncNow(true) }, "Thử lại"));
  }
}

function relogin() {
  savePending();
  if (S.sheet) {
    LS.set("reopen", S.sheet.rec.id);
    if (S.sheet.dirty()) S.sheet.stash(); // giữ cả phần đang gõ dở
  }
  S.auth.signIn({ hint: (S.me && S.me.emailAddress) || "" });
}

// ---------------------------------------------------------------- khởi động
async function boot() {
  $("#ver").textContent = VERSION;
  if ("serviceWorker" in navigator && (location.protocol === "https:" || location.hostname === "localhost") && !S.dev) {
    navigator.serviceWorker.register("sw.js").catch(() => {});
  }
  window.addEventListener("online", () => { if (S.error === "offline") syncNow(true); });
  document.addEventListener("visibilitychange", () => { if (!document.hidden && S.p) syncNow(); });
  setInterval(() => { if (!document.hidden && S.p && !S.syncing) syncNow(); }, SYNC_MS);
  setInterval(() => { if (!document.hidden && S.p) S.p.heartbeat(); }, HEARTBEAT_MS);

  if (S.dev) {
    const { DevAccount } = await import("./devbackend.js"); // chỉ có khi chạy thử với tools/devserver.py
    S.acc = new DevAccount();
  } else {
    const cid = (window.QLHS_CONFIG && window.QLHS_CONFIG.googleClientId) || LS.get("clientId");
    if (!cid) return renderSetup();
    S.auth = new GoogleAuth(cid);
    S.auth.handleRedirect();
    if (!S.auth.valid()) {
      // đã từng đăng nhập: chuyển thẳng sang Google (thường tự quay lại ngay, không phải bấm gì)
      if (LS.get("email") && !S.auth.lastError && !sessionStorage.getItem("qlhs.autoLogin")) {
        sessionStorage.setItem("qlhs.autoLogin", "1");
        return S.auth.signIn({ hint: LS.get("email") });
      }
      return renderLogin();
    }
    sessionStorage.removeItem("qlhs.autoLogin");
    S.acc = new DriveAccount(S.auth);
  }
  const about = await guard(() => S.acc.about(), "Đọc tài khoản");
  if (!about) return S.error === "auth" ? renderLogin() : renderLogin("Không kết nối được Google Drive. Kiểm tra mạng rồi thử lại.");
  S.me = about.user;
  if (S.me.emailAddress && S.auth) LS.set("email", S.me.emailAddress);
  S.error = "";
  renderBanner();
  const last = LS.get("last");
  await loadProjects();
  if (last && S.projects && S.projects.some((x) => x.key === last)) await openProject(last);
  else renderProjects();
}

function shell(title, { back = null, actions = [] } = {}) {
  const top = $("#top");
  top.innerHTML = "";
  top.append(
    back ? h("button", { class: "icon", title: "Quay lại", onclick: back }, "‹") : h("span", { class: "logo" }, "HS"),
    h("div", { class: "title" }, title),
    ...actions,
  );
}

function renderSetup() {
  shell("Quản lý hồ sơ dự án");
  $("#nav").hidden = true;
  const inp = h("input", { type: "text", placeholder: "xxxxxxxx.apps.googleusercontent.com", value: LS.get("clientId") });
  $("#view").replaceChildren(h("div", { class: "card pad center-col" },
    h("h2", {}, "Cài đặt lần đầu"),
    h("p", { class: "muted" }, "Dán Google OAuth Client ID (xem HUONG-DAN-DIEN-THOAI.md, mục Cài đặt Google). Việc này chỉ làm một lần cho cả nhóm."),
    inp,
    h("button", { class: "btn primary", onclick: () => { LS.set("clientId", inp.value.trim()); location.reload(); } }, "Lưu")));
}

function renderLogin(msg = "") {
  shell("Quản lý hồ sơ dự án");
  $("#nav").hidden = true;
  const err = S.auth && S.auth.lastError ? `Đăng nhập không thành công (${S.auth.lastError}).` : msg;
  $("#view").replaceChildren(h("div", { class: "card pad center-col" },
    h("div", { class: "hero" }, "HS"),
    h("h2", {}, "Quản lý hồ sơ dự án"),
    h("p", { class: "muted" }, "Đăng nhập bằng tài khoản Google đang chứa (hoặc được chia sẻ) thư mục dự án trên Google Drive."),
    err ? h("p", { class: "err" }, err) : null,
    h("button", { class: "btn primary big", onclick: () => S.auth.signIn({ consent: !!S.auth.lastError }) }, "Đăng nhập Google"),
    h("p", { class: "muted small" }, "Phần mềm chỉ đọc/ghi thư mục dự án (_QLHS và thư mục hồ sơ). Không gửi dữ liệu đi đâu khác.")));
}

// ---------------------------------------------------------------- danh sách dự án
async function loadProjects() {
  S.projects = await guard(() => S.acc.listProjects(), "Tìm dự án") || S.projects || [];
}

function renderProjects() {
  stopProject();
  shell("Dự án", { actions: [h("button", { class: "icon", title: "Tìm lại", onclick: async () => { await loadProjects(); renderProjects(); } }, "↻"),
    h("button", { class: "icon", title: "Cài đặt", onclick: openSettings }, "⚙")] });
  $("#nav").hidden = true;
  const list = (S.projects || []).map((x) => h("button", { class: "card proj", onclick: () => openProject(x.key) },
    h("div", { class: "code" }, x.code || "—"), h("div", { class: "name" }, x.name), h("div", { class: "muted small" }, `Thư mục: ${x.folder}`)));
  $("#view").replaceChildren(
    h("p", { class: "muted pad-x" }, `Xin chào ${userName()}. Các dự án tìm thấy trên Google Drive${S.me && S.me.emailAddress ? " của " + S.me.emailAddress : ""}:`),
    list.length ? h("div", { class: "grid" }, list) : h("div", { class: "card pad" },
      h("p", {}, "Chưa thấy dự án nào."),
      h("p", { class: "muted" }, "Trên máy tính, dự án phải nằm trong Google Drive (vd G:\\My Drive\\QuanLyHoSo\\…). Nếu dự án do người khác chia sẻ, mở Google Drive và chọn \"Thêm lối tắt vào Drive\" cho thư mục đó, rồi bấm ↻.")));
}

function stopProject() {
  S.p = null;
  S.key = null;
  S.logs = null;
}

async function openProject(key) {
  $("#view").replaceChildren(h("p", { class: "muted pad" }, "Đang mở dự án…"));
  const p = new Project(S.acc.project(key), userName(), hostName());
  const ok = await guard(() => p.load(), "Mở dự án");
  if (!ok) return renderProjects();
  S.p = p;
  S.key = key;
  LS.set("last", key);
  S.f = { text: "", phase: null, status: "", quick: "" };
  await guard(() => flushPending(), "Gửi thay đổi lưu tạm");
  p.heartbeat();
  guard(async () => { S.online = await p.online(); if (S.tab === "dash") render(); });
  render();
  const re = LS.get("reopen");
  if (re && p.get(re)) {
    LS.del("reopen");
    openRecord(re);
  }
}

async function syncNow(force = false) {
  if (!S.p || S.syncing) return;
  S.syncing = true;
  $("#top").classList.add("busy");
  const r = await guard(async () => {
    await flushPending();
    return S.p.sync(force);
  });
  S.syncing = false;
  $("#top").classList.remove("busy");
  if (!r) return;
  if (S.error) { S.error = ""; renderBanner(); }
  if (r.docs.length || r.other || force) {
    if (force) S.logs = null;
    if (S.sheet && !S.sheet.dirty()) S.sheet.reload();
    render(false);
    if (r.docs.length && !force) toast(`Nhận ${r.docs.length} thay đổi từ cloud.`);
  }
  if (force) toast("Đã đọc lại từ cloud.");
}

// ---------------------------------------------------------------- khung dự án và các tab
const TABS = [["dash", "Tổng quan", "◎"], ["docs", "Hồ sơ", "≡"], ["miles", "Mốc", "⚑"], ["logs", "Nhật ký", "↺"]];

function render(scrollTop = true) {
  const p = S.p;
  if (!p) return renderProjects();
  shell(h("span", {}, h("b", {}, p.code), " · ", p.name), {
    back: () => renderProjects(),
    actions: [h("button", { class: "icon", title: "Đọc lại (nhận thay đổi của người khác)", onclick: () => syncNow(true) }, "↻"),
      h("button", { class: "icon", title: "Cài đặt", onclick: openSettings }, "⚙")],
  });
  const nav = $("#nav");
  nav.hidden = false;
  nav.replaceChildren(...TABS.map(([k, label, ic]) => h("button", { class: S.tab === k ? "on" : "", onclick: () => { S.tab = k; render(); } },
    h("span", { class: "ic" }, ic), h("span", {}, label))));
  const y = window.scrollY;
  const v = $("#view");
  v.replaceChildren(...({ dash: viewDash, docs: viewDocs, miles: viewMiles, logs: viewLogs }[S.tab])());
  window.scrollTo(0, scrollTop ? 0 : y);
}

function goDocs(f) {
  S.f = { text: "", phase: null, status: "", quick: "", ...f };
  S.tab = "docs";
  render();
}

// ---------- Tổng quan
function viewDash() {
  const p = S.p, info = p.info;
  const st = p.stats();
  const tot = st[st.length - 1];
  const bits = [info.location, info.capacity, info.owner_org && `CĐT: ${info.owner_org}`, info.epc && `EPC: ${info.epc}`].filter(Boolean);
  const cod = parseDate(info.cod_target || "");
  if (cod) {
    const d = daysBetween(today(), cod);
    bits.push(`Mục tiêu COD ${dateVn(info.cod_target)} (${d >= 0 ? "còn " + d : "đã qua " + -d} ngày)`);
  }
  const kpi = (n, label, color, onclick) => h("button", { class: "kpi", style: { color }, onclick }, h("b", {}, n), h("span", {}, label));
  const due = p.records().filter((r) => {
    const d = parseDate(r.due || "");
    return d && !DONE_STATUSES.has(r.status) && !SKIP_STATUSES.has(r.status) && daysBetween(today(), d) <= 30;
  }).sort((a, b) => (a.due || "").localeCompare(b.due || ""));
  return [
    h("div", { class: "pad-x" }, h("h2", { class: "ptitle" }, p.name), h("p", { class: "muted small" }, bits.join(" · "))),
    h("div", { class: "kpis" },
      kpi(tot.counted, "hồ sơ cần có", "var(--teal)", () => goDocs({})),
      kpi(tot.done, "đã duyệt / hoàn công", "#2f855a", () => goDocs({ status: "Đã duyệt" })),
      kpi(tot.counted - tot.done - tot.not_started, "đang thực hiện", "#b7791f", () => goDocs({})),
      kpi(tot.not_started, "chưa bắt đầu", "#8a989c", () => goDocs({ status: "Chưa bắt đầu" })),
      kpi(tot.overdue, "quá hạn", "#c53030", () => goDocs({ quick: "overdue" })),
      kpi(`${Math.round(tot.progress)}%`, "tiến độ hồ sơ", "var(--teal)", null)),
    h("h3", { class: "sec" }, "Tiến độ theo giai đoạn"),
    h("div", { class: "card list" }, st.filter((s) => s.num != null).map((s) => h("button", { class: "li phase", onclick: () => goDocs({ phase: s.num }) },
      h("div", { class: "row between" }, h("span", {}, `${s.num}. ${s.title}`), h("span", { class: "muted small" }, `${s.done}/${s.counted}${s.overdue ? " · " : ""}`, s.overdue ? h("span", { class: "red" }, `${s.overdue} quá hạn`) : null)),
      h("div", { class: "bar" }, h("i", { style: { width: `${s.progress}%` } })),
      h("div", { class: "muted small" }, `${Math.round(s.progress)}% · ${s.with_files} hồ sơ có tệp`)))),
    h("h3", { class: "sec" }, "Quá hạn và đến hạn trong 30 ngày"),
    due.length ? h("div", { class: "card list" }, due.slice(0, 30).map(recRow))
      : h("p", { class: "muted pad-x" }, "Không có hồ sơ quá hạn hoặc đến hạn trong 30 ngày."),
    h("h3", { class: "sec" }, "Đang mở dự án"),
    h("p", { class: "muted pad-x" }, S.online.length ? S.online.map((x) => `${x.user} (${x.host}, ${fmtDt(x.at)})`).join(" · ") : "Không có ai khác đang mở dự án."),
    h("p", { class: "muted small pad-x foot" }, `Bạn: ${p.user} · thiết bị: ${p.host}`),
  ];
}

// ---------- Hồ sơ
function filtered() {
  const f = S.f, p = S.p;
  return p.records().filter((r) => {
    if (f.phase != null && r.phase !== f.phase) return false;
    if (f.status && (r.status || "Chưa bắt đầu") !== f.status) return false;
    if (f.quick === "overdue" && !isOverdue(r)) return false;
    if (f.quick === "mine" && (r.owner || "").toLowerCase() !== p.user.toLowerCase()) return false;
    if (f.quick === "nofile" && (r.files || []).length) return false;
    if (f.quick === "proposed" && !r.proposed) return false;
    return !f.text || matches(r, f.text);
  });
}

function recRow(r) {
  const late = isOverdue(r);
  return h("button", { class: "li rec", onclick: () => openRecord(r.id) },
    h("div", { class: "row between" }, h("b", {}, r.pcode), h("span", { class: "mono muted small ell" }, r.code || "")),
    h("div", { class: "rtitle" }, r.title),
    h("div", { class: "row wrap gap" }, statusChip(r.status || "Chưa bắt đầu"),
      r.rev || r.suit ? h("span", { class: "chip" }, [r.rev, r.suit].filter(Boolean).join(" · ")) : null,
      r.due ? h("span", { class: `chip ${late ? "red" : ""}` }, `Hạn ${dateVn(r.due)}`) : null,
      r.owner ? h("span", { class: "chip" }, r.owner) : null,
      (r.files || []).length ? h("span", { class: "chip" }, `📎 ${r.files.length}`) : null));
}

function viewDocs() {
  const p = S.p, f = S.f;
  const listBox = h("div", { class: "card list recs" });
  const count = h("span", { class: "muted small" });
  const fill = () => {
    const rs = filtered();
    count.textContent = `${rs.length} / ${p.records().length} hồ sơ`;
    listBox.replaceChildren(...(rs.length ? rs.map(recRow) : [h("p", { class: "muted pad" }, "Không có hồ sơ khớp bộ lọc.")]));
  };
  const search = h("input", { type: "search", placeholder: "Tìm mã, tên, ghi chú… (gõ không dấu được)", value: f.text,
    oninput: (e) => { f.text = e.target.value; fill(); } });
  const chip = (label, on, onclick) => h("button", { class: `chip pick ${on ? "on" : ""}`, onclick }, label);
  const phases = h("div", { class: "chips scroll" },
    chip("Tất cả", f.phase == null, () => { f.phase = null; render(false); }),
    p.phases.map((ph) => chip(`${ph.num}. ${ph.title}`, f.phase === ph.num, () => { f.phase = ph.num; render(false); })));
  const status = h("select", { onchange: (e) => { f.status = e.target.value; fill(); } },
    h("option", { value: "" }, "Mọi trạng thái"), STATUS_NAMES.map((s) => h("option", { value: s, selected: f.status === s }, s)));
  const quick = h("select", { onchange: (e) => { f.quick = e.target.value; fill(); } },
    [["", "Không lọc nhanh"], ["overdue", "Quá hạn"], ["mine", `Tôi phụ trách (${p.user})`], ["nofile", "Chưa có tệp"], ["proposed", "Mã còn đề xuất"]]
      .map(([v, l]) => h("option", { value: v, selected: f.quick === v }, l)));
  fill();
  return [h("div", { class: "filters" }, search, phases, h("div", { class: "row gap" }, status, quick), count), listBox];
}

// ---------- Mốc tiến độ
function viewMiles() {
  const p = S.p;
  const ms = p.milestones();
  const save = (m, field, val, label) => guard(async () => {
    if ((m[field] || "") === val) return;
    m[field] = val;
    await p.saveMilestone(m, "Sửa mốc");
    toast(`Đã lưu ${label}: ${m.name}`);
    render(false);
  }, "Lưu mốc");
  return [
    h("p", { class: "muted small pad-x" }, "Sửa ngày là lưu ngay lên cloud."),
    h("div", { class: "card list" }, ms.map((m) => {
      const s = milestoneState(m);
      const cls = s.startsWith("Trễ") ? "red" : s.startsWith("Hoàn thành") ? "green" : "";
      return h("div", { class: "li" },
        h("div", { class: "row between" }, h("b", {}, m.name), h("span", { class: `small ${cls}` }, s)),
        h("div", { class: "row gap" },
          h("label", { class: "fld" }, h("span", {}, "Kế hoạch"), h("input", { type: "date", value: m.planned || "", onchange: (e) => save(m, "planned", e.target.value, "kế hoạch") })),
          h("label", { class: "fld" }, h("span", {}, "Thực tế"), h("input", { type: "date", value: m.actual || "", onchange: (e) => save(m, "actual", e.target.value, "ngày thực tế") }))),
        h("input", { type: "text", placeholder: "Ghi chú", value: m.note || "", onchange: (e) => save(m, "note", e.target.value.trim(), "ghi chú") }));
    })),
  ];
}

// ---------- Nhật ký
function viewLogs() {
  const box = h("div", { class: "card list" }, h("p", { class: "muted pad" }, "Đang đọc nhật ký…"));
  const fill = (logs) => box.replaceChildren(...(logs.length ? logs.slice(0, 300).map((x) => h("button", {
    class: "li", onclick: () => x.rec && S.p.get(x.rec) && openRecord(x.rec),
  }, h("div", { class: "row between" }, h("b", {}, x.action), h("span", { class: "muted small" }, fmtDt(x.at))),
  x.pcode || x.title ? h("div", {}, [x.pcode, x.title].filter(Boolean).join(" – ")) : null,
  x.detail ? h("div", { class: "muted small" }, x.detail) : null,
  h("div", { class: "muted small" }, `${x.user} · ${x.host}`))) : [h("p", { class: "muted pad" }, "Chưa có nhật ký.")]));
  if (S.logs) fill(S.logs);
  else guard(async () => { S.logs = await S.p.readLogs(500); if (S.tab === "logs") fill(S.logs); }, "Đọc nhật ký");
  return [h("p", { class: "muted small pad-x" }, "Ai làm gì, lúc nào, trên máy nào. Bấm vào dòng để mở hồ sơ."), box];
}

// ---------------------------------------------------------------- cửa sổ hồ sơ
const LABELS = { code: "Mã", proposed: "Đề xuất", title: "Tên", status: "Trạng thái", rev: "Rev", suit: "Suit.", doc_no: "Số hiệu",
  doc_date: "Ngày VB", owner: "Phụ trách", due: "Hạn", note: "Ghi chú" };

function openRecord(id) {
  const p = S.p;
  let rec = p.get(id);
  if (!rec) return;
  let dirty = false;
  const body = h("div", { class: "sheet-body" });
  const applyBtn = h("button", { class: "btn primary", disabled: true, onclick: () => apply() }, "Áp dụng");
  const hint = h("span", { class: "muted small" });
  const touch = () => { if (!dirty) { dirty = true; applyBtn.disabled = false; hint.textContent = "Có thay đổi chưa áp dụng."; } };
  const F = {};

  const fill = () => {
    rec = p.get(id) || rec;
    dirty = false;
    applyBtn.disabled = true;
    const input = (k, attrs = {}) => (F[k] = h("input", { type: "text", value: rec[k] || "", oninput: touch, ...attrs }));
    F.status = rec.status || "Chưa bắt đầu";
    const stBox = h("div", { class: "chips wrap" });
    const drawStatus = () => stBox.replaceChildren(...STATUS_NAMES.map((s) => h("button", {
      class: `chip pick ${F.status === s ? "on" : ""}`, onclick: () => { F.status = s; touch(); drawStatus(); },
    }, statusDot(s), s)));
    drawStatus();
    F.suit = h("select", { onchange: touch }, h("option", { value: "" }, "—"), SUITABILITY.map(([c, t]) => h("option", { value: c, selected: rec.suit === c }, `${c} – ${t}`)));
    F.proposed = h("input", { type: "checkbox", checked: !!rec.proposed, onchange: touch });
    F.note = h("textarea", { rows: 3, oninput: touch }, rec.note || "");
    const members = h("datalist", { id: "members" }, p.members().map((m) => h("option", { value: m })));
    const upd = rec.updated_at ? `Cập nhật ${fmtDt(rec.updated_at)} bởi ${rec.updated_by || ""}` : "";
    body.replaceChildren(
      h("div", { class: "muted small" }, `${rec.pcode} · ${phaseTitle(p.info, rec.phase)}${upd ? " · " + upd : ""}`),
      h("h2", { class: "rtitle-big" }, rec.title),
      h("div", { class: "form" }, h("label", {}, "Trạng thái"), stBox),
      h("h3", { class: "sec" }, `Ảnh và tệp đính kèm (${(rec.files || []).length})`),
      h("div", { class: "row gap wrap actions" },
        h("label", { class: "btn primary" }, "📷 Chụp ảnh", h("input", { type: "file", accept: "image/*", capture: "environment", hidden: true, onchange: (e) => upload(e.target) })),
        h("label", { class: "btn" }, "📎 Ảnh / tệp có sẵn", h("input", { type: "file", multiple: true, hidden: true, onchange: (e) => upload(e.target) }))),
      filesBox(),
      h("p", { class: "muted small" }, `Tệp được lưu vào thư mục hồ sơ: ${p.folderOf(rec)}`),
      h("h3", { class: "sec" }, "Thông tin hồ sơ"),
      h("div", { class: "form" },
        h("label", {}, "Tên hồ sơ"), input("title"),
        h("label", {}, "Mã tài liệu"), input("code", { class: "mono", autocapitalize: "characters" }),
        h("label", { class: "check" }, F.proposed, " Mã đề xuất (chưa xác nhận)"),
        h("div", { class: "row gap" }, h("div", { class: "grow1" }, h("label", {}, "Revision"), input("rev", { placeholder: "P01", autocapitalize: "characters" })),
          h("div", { class: "grow3" }, h("label", {}, "Suitability"), F.suit)),
        h("label", {}, "Số hiệu văn bản"), input("doc_no", { placeholder: "Số văn bản / số hiệu gốc" }),
        h("div", { class: "row gap" }, h("div", { class: "grow1" }, h("label", {}, "Ngày văn bản"), input("doc_date", { type: "date" })),
          h("div", { class: "grow1" }, h("label", {}, "Hạn hoàn thành"), input("due", { type: "date" }))),
        h("label", {}, "Phụ trách"), input("owner", { list: "members", autocomplete: "off" }), members,
        h("label", {}, "Ghi chú"), F.note),
      h("h3", { class: "sec" }, "Phát hành"),
      historyBox(),
      h("button", { class: "btn", onclick: () => revision() }, "Phát hành bản mới…"));
    hint.textContent = "";
  };

  const filesBox = () => {
    const files = rec.files || [];
    if (!files.length) return h("p", { class: "muted" }, "Chưa có tệp.");
    const box = h("div", { class: "list files" });
    for (const fo of files) {
      const name = fo.path.split("/").pop();
      const mark = h("span", { class: "small muted" });
      box.append(h("button", { class: "li file", onclick: () => openFile(fo.path) }, h("span", { class: "fic" }, fileIcon(name)),
        h("span", { class: "grow1 ell" }, name, h("br"), h("span", { class: "muted small" }, `${fo.added_by || ""} · ${fmtDt(fo.added_at || "")}`)), mark));
      S.p.b.exists(fo.path).then((ok) => { if (!ok) { mark.textContent = "⚠ không thấy"; mark.className = "small red"; } }).catch(() => {});
    }
    return box;
  };

  const historyBox = () => {
    const hs = [...(rec.history || [])].reverse();
    if (!hs.length) return h("p", { class: "muted" }, "Chưa có lần phát hành nào.");
    return h("div", { class: "list" }, hs.map((x) => h("div", { class: "li" },
      h("div", { class: "row between" }, h("b", {}, [x.rev, x.suit].filter(Boolean).join(" · ")), h("span", { class: "muted small" }, dateVn(x.date))),
      h("div", { class: "small" }, statusChip(x.status), ` ${x.by || ""}`),
      x.note || (x.files || []).length ? h("div", { class: "muted small" }, [x.note, (x.files || []).map((f) => f.split("/").pop()).join(", ")].filter(Boolean).join(" – ")) : null)));
  };

  const collect = () => ({
    title: F.title.value.trim() || rec.title, code: F.code.value.trim().toUpperCase(), proposed: F.proposed.checked, status: F.status,
    rev: F.rev.value.trim().toUpperCase(), suit: F.suit.value, doc_no: F.doc_no.value.trim(), doc_date: F.doc_date.value,
    owner: F.owner.value.trim(), due: F.due.value, note: F.note.value.trim(),
  });

  async function apply() {
    if (!dirty) return true;
    const nw = collect();
    if (nw.code) {
      const dup = p.records().find((r) => r.id !== rec.id && (r.code || "").toUpperCase() === nw.code);
      if (dup) { await ask("Trùng mã", `Mã tài liệu đã dùng cho ${dup.pcode} – ${dup.title}. Sửa mã trước khi lưu.`, [{ label: "OK", value: 1, kind: "primary" }]); return false; }
    }
    const diff = Object.entries(nw).filter(([k, v]) => (rec[k] ?? (k === "proposed" ? false : "")) !== v)
      .map(([k, v]) => (k === "note" || k === "title" ? `${LABELS[k]} sửa` : `${LABELS[k]}: ${rec[k] ?? ""} → ${v}`));
    if (!diff.length) { dirty = false; applyBtn.disabled = true; hint.textContent = ""; return true; }
    Object.assign(rec, nw);
    applyBtn.disabled = true;
    hint.textContent = "Đang lưu…";
    const ok = await guard(async () => { await p.saveRecord(rec, "Cập nhật", diff.join("; ")); return true; }, "Lưu hồ sơ");
    dirty = false;
    if (ok) {
      toast("Đã lưu hồ sơ.");
      fill();
      hint.textContent = `Đã lưu lúc ${new Date().toLocaleTimeString("vi-VN")}.`;
    } else {
      hint.textContent = "Đã giữ trên máy, chưa gửi được lên cloud.";
    }
    render(false);
    return true;
  }

  async function close() {
    if (dirty) {
      const a = await ask("Chưa áp dụng", "Hồ sơ có thay đổi chưa áp dụng. Lưu trước khi đóng?",
        [{ label: "Huỷ", value: "cancel" }, { label: "Không lưu", value: "discard" }, { label: "Lưu", value: "save", kind: "primary" }]);
      if (a === "cancel") return;
      if (a === "save" && !(await apply())) return;
    }
    sheet.remove();
    S.sheet = null;
    document.body.classList.remove("noscroll");
  }

  async function upload(inp) {
    const files = [...inp.files];
    inp.value = "";
    if (!files.length) return;
    if (dirty && !(await apply())) return;
    const prog = h("div", { class: "progress" }, "Đang chuẩn bị…");
    body.prepend(prog);
    const ok = await guard(async () => {
      const items = [];
      const stamp = (() => { const d = new Date(), z = (n) => String(n).padStart(2, "0"); return `${d.getFullYear()}${z(d.getMonth() + 1)}${z(d.getDate())}_${z(d.getHours())}${z(d.getMinutes())}${z(d.getSeconds())}`; })();
      for (const [i, f] of files.entries()) {
        if (f.type.startsWith("image/") && LS.get("resize", "1") === "1" && !/gif|svg/.test(f.type)) {
          prog.textContent = `Đang nén ảnh ${i + 1}/${files.length}…`;
          const blob = await shrink(f);
          const base = safeName(rec.code || rec.pcode);
          items.push({ name: `${base}_ANH_${stamp}${files.length > 1 ? "_" + (i + 1) : ""}.jpg`, blob });
        } else {
          items.push({ name: /^image\.(jpe?g|heic|png)$/i.test(f.name) ? `${safeName(rec.code || rec.pcode)}_ANH_${stamp}${f.name.slice(f.name.lastIndexOf("."))}` : f.name, blob: f });
        }
      }
      const rels = await p.attach(rec, items, (i, n, name) => { prog.textContent = `Đang tải lên ${i + 1}/${n}: ${name}`; });
      await p.saveRecord(rec, "Gắn tệp", rels.map((r) => r.split("/").pop()).join(", "));
      return rels;
    }, "Tải tệp lên");
    prog.remove();
    if (ok) {
      toast(`Đã gắn ${ok.length} tệp vào hồ sơ.`);
      fill();
      render(false);
    }
  }

  async function revision() {
    if (dirty && !(await apply())) return;
    const suit = h("select", {}, SUITABILITY.map(([c, t]) => h("option", { value: c, selected: (rec.suit || "S0") === c }, `${c} – ${t}`)));
    const rev = h("input", { type: "text", autocapitalize: "characters" });
    const status = h("select", {}, STATUS_NAMES.map((s) => h("option", { value: s }, s)));
    const date = h("input", { type: "date", value: dateIsoOf(today()) });
    const note = h("textarea", { rows: 3, placeholder: "Ghi chú phát hành (gửi ai, số công văn…)" });
    const auto = () => { rev.value = nextRevision(rec.rev, isApproved(suit.value)); status.value = SUIT_TO_STATUS[suit.value] || rec.status || "Đang lập"; };
    suit.onchange = auto;
    auto();
    const m = h("div", { class: "modal" }, h("div", { class: "box" },
      h("h3", {}, `Phát hành bản mới – ${rec.pcode}`),
      h("div", { class: "form" }, h("label", {}, "Suitability"), suit, h("div", { class: "row gap" },
        h("div", { class: "grow1" }, h("label", {}, "Revision"), rev), h("div", { class: "grow2" }, h("label", {}, "Trạng thái"), status)),
      h("label", {}, "Ngày phát hành"), date, h("label", {}, "Ghi chú"), note),
      h("div", { class: "row end gap" }, h("button", { class: "btn", onclick: () => m.remove() }, "Huỷ"),
        h("button", { class: "btn primary", onclick: async () => {
          const r = rev.value.trim().toUpperCase();
          if (!r) return;
          m.remove();
          const ok = await guard(async () => { await p.issueRevision(rec, { rev: r, suit: suit.value, status: status.value, date: date.value, note: note.value.trim() }); return true; }, "Phát hành");
          if (ok) { toast(`Đã phát hành ${r} · ${suit.value}.`); fill(); render(false); }
        } }, "Phát hành"))));
    document.body.append(m);
  }

  const sheet = h("div", { class: "sheet" }, h("div", { class: "sheet-in" },
    h("div", { class: "sheet-top" }, h("button", { class: "icon", title: "Đóng", onclick: () => close() }, "✕"), h("b", { class: "grow1 ell" }, `Hồ sơ ${rec.pcode}`)),
    body,
    h("div", { class: "sheet-foot" }, hint, h("span", { class: "grow1" }), applyBtn, h("button", { class: "btn", onclick: () => close() }, "Đóng"))));
  document.body.append(sheet);
  document.body.classList.add("noscroll");
  fill();
  const draft = LS.json("draft." + id);
  if (draft) {
    LS.del("draft." + id);
    for (const k of ["title", "code", "rev", "doc_no", "doc_date", "owner", "due", "note"]) if (F[k] && draft[k] != null) F[k].value = draft[k];
    F.proposed.checked = !!draft.proposed;
    F.suit.value = draft.suit || "";
    F.status = draft.status || F.status;
    body.querySelectorAll(".form .chip.pick").forEach((b) => b.classList.toggle("on", b.textContent.trim() === F.status));
    touch();
    toast("Đã khôi phục phần đang sửa dở – bấm Áp dụng để lưu.");
  }
  S.sheet = { rec, dirty: () => dirty, reload: () => { if (!dirty) fill(); }, close, stash: () => LS.set("draft." + id, JSON.stringify(collect())) };
}

function fileIcon(name) {
  const ext = name.split(".").pop().toLowerCase();
  if (["jpg", "jpeg", "png", "heic", "gif", "webp"].includes(ext)) return "🖼";
  if (ext === "pdf") return "📕";
  if (["xls", "xlsx", "csv"].includes(ext)) return "📗";
  if (["doc", "docx"].includes(ext)) return "📘";
  if (["dwg", "dxf"].includes(ext)) return "📐";
  return "📄";
}

async function openFile(rel) {
  const w = S.dev ? null : window.open("about:blank", "_blank"); // mở cửa sổ ngay khi bấm để trình duyệt không chặn
  const url = await guard(() => S.p.b.openUrl(rel), "Mở tệp");
  if (!url) {
    if (w) w.close();
    if (url === null) toast("Không thấy tệp trên Google Drive (có thể đã bị đổi tên hoặc di chuyển).", "warn");
    return;
  }
  if (w) w.location.href = url;
  else window.open(url, "_blank");
}

/** Thu nhỏ ảnh (cạnh dài tối đa 2560 px, JPEG 85%) để tải lên nhanh qua 4G. */
async function shrink(file, max = 2560, quality = 0.85) {
  try {
    const bmp = await createImageBitmap(file, { imageOrientation: "from-image" });
    const k = Math.min(1, max / Math.max(bmp.width, bmp.height));
    const c = document.createElement("canvas");
    c.width = Math.round(bmp.width * k);
    c.height = Math.round(bmp.height * k);
    c.getContext("2d").drawImage(bmp, 0, 0, c.width, c.height);
    const blob = await new Promise((r) => c.toBlob(r, "image/jpeg", quality));
    return blob && blob.size < file.size ? blob : file;
  } catch {
    return file; // trình duyệt không đọc được định dạng (vd HEIC trên Android): tải bản gốc
  }
}

// ---------------------------------------------------------------- cài đặt
function openSettings() {
  const user = h("input", { type: "text", value: userName() });
  const host = h("input", { type: "text", value: hostName() });
  const resize = h("input", { type: "checkbox", checked: LS.get("resize", "1") === "1" });
  const m = h("div", { class: "modal" }, h("div", { class: "box" },
    h("h3", {}, "Cài đặt trên thiết bị này"),
    h("div", { class: "form" },
      h("label", {}, "Tên người dùng (giống tên trên máy tính để lọc \"Tôi phụ trách\")"), user,
      h("label", {}, "Tên thiết bị (hiện trong nhật ký)"), host,
      h("label", { class: "check" }, resize, " Thu nhỏ ảnh chụp trước khi tải lên (nhanh hơn, ~1 MB/ảnh)")),
    h("p", { class: "muted small" }, S.me ? `Tài khoản: ${S.me.displayName || ""} ${S.me.emailAddress || ""}` : "", h("br"), `Phiên bản ${VERSION}`),
    h("div", { class: "row end gap wrap" },
      S.auth ? h("button", { class: "btn danger", onclick: () => { S.auth.signOut(); LS.del("last"); LS.del("email"); location.reload(); } }, "Đăng xuất") : null,
      h("button", { class: "btn", onclick: () => m.remove() }, "Huỷ"),
      h("button", { class: "btn primary", onclick: () => {
        LS.set("user", user.value.trim());
        LS.set("host", safeName(host.value.trim()) || hostName());
        LS.set("resize", resize.checked ? "1" : "0");
        m.remove();
        if (S.p) { S.p.user = userName(); S.p.host = hostName(); render(false); } else renderProjects();
        toast("Đã lưu cài đặt.");
      } }, "Lưu"))));
  document.body.append(m);
}

// cho bài kiểm thử tự động
window.QLHS = { S, openRecord, syncNow, render, goDocs };
boot();
