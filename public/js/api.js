/* ============================================
   OKI Maintenance System — shared frontend helpers
   Satu origin dengan backend (di-serve dari server.js yang sama),
   jadi semua request API cukup pakai path relatif "/api/...".
============================================ */

const SESSION_KEY = 'oki_session';

/* ── API fetch wrapper ──
   Otomatis nempelin Authorization: Bearer <token> dari session yang lagi
   login, supaya backend bisa ngecek role beneran (bukan cuma sembunyiin
   tombol di frontend). Kalau token expired/invalid (401), langsung logout
   & lempar ke halaman login. */
async function api(path, opts = {}) {
  const session = getSession();
  const headers = { 'Content-Type': 'application/json', ...(opts.headers || {}) };
  if (session && session.token) headers.Authorization = `Bearer ${session.token}`;

  const res = await fetch(path, { ...opts, headers });
  const data = await res.json().catch(() => ({}));

  if (res.status === 401) {
    clearSession();
    if (!location.pathname.endsWith('index') && location.pathname !== '/') {
      window.location.href = 'index';
    }
    throw new Error(data.message || 'Sesi habis, silakan login ulang.');
  }

  if (!res.ok || data.success === false) {
    throw new Error(data.message || 'Terjadi kesalahan, coba lagi.');
  }
  return data;
}

/* ── Session (localStorage) ──
   { type: 'staff'|'technician', id, username, nama, role|status, token } */
function getSession() {
  try { return JSON.parse(localStorage.getItem(SESSION_KEY) || 'null'); }
  catch (_) { return null; }
}
function setSession(session) { localStorage.setItem(SESSION_KEY, JSON.stringify(session)); }
function clearSession() { localStorage.removeItem(SESSION_KEY); }

/* Panggil di paling atas tiap halaman terproteksi.
   allowedTypes: array of 'staff' | 'technician' */
function requireAuth(allowedTypes) {
  const session = getSession();
  if (!session || !allowedTypes.includes(session.type)) {
    window.location.href = 'index';
    return null;
  }
  return session;
}

/* ── Upload file (multipart/form-data) ──
   Beda dari api() biasa: JANGAN set Content-Type manual, browser yang
   nentuin boundary-nya otomatis pas body-nya FormData. */
async function apiUpload(path, formData) {
  const session = getSession();
  const headers = {};
  if (session && session.token) headers.Authorization = `Bearer ${session.token}`;

  const res = await fetch(path, { method: 'POST', headers, body: formData });
  const data = await res.json().catch(() => ({}));

  if (res.status === 401) {
    clearSession();
    window.location.href = 'index';
    throw new Error(data.message || 'Sesi habis, silakan login ulang.');
  }
  if (!res.ok || data.success === false) {
    throw new Error(data.message || 'Gagal upload file.');
  }
  return data;
}

function logout() {
  clearSession();
  window.location.href = 'index';
}

/* ── Role helper ──
   Dipakai buat nampilin/nyembunyiin elemen UI sesuai role. INGAT: ini cuma
   kosmetik (UX), keamanan sebenarnya di-enforce backend (lihat middleware
   auth.js). Jangan andalkan ini sebagai satu-satunya proteksi. */
function hasRole(...roles) {
  const s = getSession();
  return !!s && s.type === 'staff' && roles.includes(s.role);
}

/* ── Toast ── */
function toast(message, type = 'info') {
  let el = document.getElementById('toast-custom');
  if (!el) {
    el = document.createElement('div');
    el.id = 'toast-custom';
    el.className = 'toast-custom';
    document.body.appendChild(el);
  }
  el.textContent = message;
  el.className = 'toast-custom show ' + (type === 'error' ? 'error' : type === 'success' ? 'success' : '');
  clearTimeout(el._timer);
  el._timer = setTimeout(() => el.classList.remove('show'), 3200);
}

/* ── Formatters ── */
function rupiah(n) {
  const num = Number(n) || 0;
  return 'Rp' + num.toLocaleString('id-ID');
}

function fmtDate(iso) {
  if (!iso) return '-';
  const d = new Date(iso.replace(' ', 'T'));
  if (isNaN(d.getTime())) return iso;
  return d.toLocaleString('id-ID', { day: '2-digit', month: 'short', year: 'numeric', hour: '2-digit', minute: '2-digit' });
}

function relTime(iso) {
  if (!iso) return '-';
  const d = new Date(iso.replace(' ', 'T'));
  if (isNaN(d.getTime())) return iso;
  const diff = Math.floor((Date.now() - d.getTime()) / 1000);
  if (diff < 60) return 'Baru saja';
  if (diff < 3600) return Math.floor(diff / 60) + ' menit lalu';
  if (diff < 86400) return Math.floor(diff / 3600) + ' jam lalu';
  return Math.floor(diff / 86400) + ' hari lalu';
}

/* ── Badge helpers ── */
const STATUS_LABEL = {
  NEW: 'Baru', ASSIGNED: 'Ditugaskan', ON_THE_WAY: 'Menuju Lokasi',
  IN_PROGRESS: 'Dikerjakan', DONE: 'Selesai', CLOSED: 'Ditutup', REJECTED: 'Ditolak', CANCELLED: 'Dibatalkan',
};
function statusBadge(status) {
  return `<span class="badge badge-status-${status}">${STATUS_LABEL[status] || status}</span>`;
}
function priorityBadge(p) {
  return `<span class="badge badge-priority-${p}">${p}</span>`;
}
function approvalBadge(s) {
  const label = { PENDING: 'Menunggu', APPROVED: 'Disetujui', REJECTED: 'Ditolak' }[s] || s;
  return `<span class="badge badge-approval-${s}">${label}</span>`;
}
function techStatusBadge(s) {
  const label = { OFFLINE: 'Offline', READY: 'Ready', ON_DUTY: 'Bertugas' }[s] || s;
  return `<span class="badge badge-tech-${s}">${label}</span>`;
}

/* ── Loader overlay (dipakai saat submit form) ── */
function showLoader() {
  if (document.getElementById('loader')) return;
  const el = document.createElement('div');
  el.id = 'loader';
  el.innerHTML = '<div class="spinner-border text-primary" role="status"></div>';
  document.body.appendChild(el);
}
function hideLoader() {
  const el = document.getElementById('loader');
  if (el) el.remove();
}

/* ── Escape helper ── */
function escapeHtml(str) {
  if (str === null || str === undefined) return '';
  return String(str).replace(/[&<>"']/g, m => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[m]));
}
