/* ============================================
   Sidebar + topbar reusable — dipanggil dari tiap halaman:
   renderLayout({ active: 'dashboard', title: 'Dashboard' })
============================================ */

const ALL_STAFF_NAV = [
  { key: 'dashboard', href: 'dashboard',  icon: 'bi-speedometer2', label: 'Dashboard',        roles: ['ADMIN','ATASAN','FINANCE','DISPATCHER'] },
  { key: 'orders',    href: 'orders',     icon: 'bi-list-task',    label: 'Data Order',       roles: ['ADMIN','ATASAN','FINANCE','DISPATCHER'] },
  { key: 'approval',  href: 'approval',   icon: 'bi-check2-square',label: 'Approval Order',   roles: ['ATASAN'] },
  { key: 'customer',  href: 'customer',   icon: 'bi-people',       label: 'Master Customer',  roles: ['ADMIN'] },
  { key: 'site',      href: 'site',       icon: 'bi-geo-alt',      label: 'Master Site',      roles: ['ADMIN'] },
  { key: 'technician',href: 'technician', icon: 'bi-person-badge', label: 'Master Teknisi',   roles: ['ADMIN'] },
  { key: 'perangkat', href: 'perangkat',  icon: 'bi-hdd-network',  label: 'Master Perangkat', roles: ['ADMIN'] },
];

const TECH_NAV = [
  { key: 'profile', href: 'profile', icon: 'bi-person-circle', label: 'Profile Saya' },
];

/* Nav ditampilkan sesuai role login — bukan cuma kosmetik, tiap halaman
   yang dibuka lewat link ini TETAP dilindungi backend (401/403) kalau
   nekat diakses lewat URL langsung oleh role yang gak berhak. */
function renderLayout({ active, title }) {
  const session = getSession();
  if (!session) return;

  const nav = session.type === 'technician'
    ? TECH_NAV
    : ALL_STAFF_NAV.filter(item => item.roles.includes(session.role));
  const navHtml = nav.map(item => `
    <a href="${item.href}" class="${item.key === active ? 'active' : ''}">
      <i class="bi ${item.icon}"></i> ${item.label}
    </a>
  `).join('');

  const sidebar = document.createElement('div');
  sidebar.className = 'sidebar';
  sidebar.innerHTML = `
    <div class="logo"><i class="bi bi-tools"></i> Maintenance</div>
    <nav>
      ${navHtml}
      <a href="#" onclick="logout(); return false;" style="margin-top:14px;border-top:1px solid rgba(255,255,255,.15);padding-top:16px;">
        <i class="bi bi-box-arrow-right"></i> Logout
      </a>
    </nav>
    <div class="sidebar-foot">Login sebagai <b>${session.nama}</b></div>
  `;
  document.body.prepend(sidebar);

  const topbar = document.getElementById('topbar-slot');
  if (topbar) {
    topbar.outerHTML = `
      <nav class="navbar-top">
        <h4>${title}</h4>
        <div class="d-flex align-items-center" style="gap:14px;">
          ${session.type === 'staff' ? notifBellHtml() : ''}
          <div class="user-chip">
            <div class="av">${(session.nama || '?').slice(0,1).toUpperCase()}</div>
            <span>${session.nama}${session.role ? ' · ' + session.role : ''}</span>
          </div>
        </div>
      </nav>
    `;
  }

  // Notifikasi cuma buat staff (admin/atasan/finance/dispatcher) --
  // teknisi punya jalur notif sendiri (FCM push + socket assignment di
  // profile.html), gak perlu bell ini.
  if (session.type === 'staff') {
    initNotifBell();
  }
}

/* ============================================
   NOTIFIKASI — bell icon + badge counter + dropdown riwayat.

   Sumber data:
   - Riwayat awal: GET /api/dashboard/notifications (dibaca dari
     oki_order_timeline, jadi otomatis nyakup SEMUA event seputar order:
     approve/reject/assign/status/checklist BA/kebutuhan/biaya/dll)
   - Real-time: socket event 'notification' (di-emit backend dari titik
     yang sama, lihat logTimeline() di order.route.js)

   Status "sudah dibaca" dan "clear" itu MURNI kosmetik di browser
   (localStorage), gak nyentuh data asli di server -- Timeline Pekerjaan
   di halaman detail order tetap utuh walau notifikasinya di-clear di sini:
   - oki_notif_read_ids     -> array id yang udah ditandai dibaca
   - oki_notif_cleared_before -> timestamp; notif lebih lama dari ini
     disembunyikan dari daftar (dianggap "sudah di-clear")
============================================ */

const NOTIF_READ_IDS_BASE = 'oki_notif_read_ids';
const NOTIF_CLEARED_BEFORE_BASE = 'oki_notif_cleared_before';
const NOTIF_MAX_READ_IDS = 300;

/* Scope localStorage per AKUN yang login (bukan per browser secara
   umum) -- biar kalau ganti akun di browser yang sama, status "sudah
   dibaca"/"di-clear" gak ikut kebawa dari akun sebelumnya. */
function _notifStorageKey(base) {
  const s = getSession();
  const uid = s ? `${s.type}-${s.id}` : 'anon';
  return `${base}:${uid}`;
}

let _notifList = [];
let _notifDropdownOpen = false;
let _notifSocket = null;
let _audioCtx = null;
let _notifReminderIntervalId = null;
let _notifStylesInjected = false;

const NOTIF_EVENT_ICON = {
  CREATED: 'bi-plus-circle', APPROVED: 'bi-check2-circle', REJECTED: 'bi-x-circle',
  ASSIGNED: 'bi-person-check-fill', ON_THE_WAY: 'bi-signpost-fill', IN_PROGRESS: 'bi-tools',
  DONE: 'bi-check-circle-fill', CANCELLED: 'bi-slash-circle', NOTE: 'bi-info-circle',
};
function notifIcon(eventType) { return NOTIF_EVENT_ICON[eventType] || 'bi-bell'; }

function _getReadIds() {
  try { return new Set(JSON.parse(localStorage.getItem(_notifStorageKey(NOTIF_READ_IDS_BASE)) || '[]')); }
  catch (_) { return new Set(); }
}
function _saveReadIds(set) {
  let arr = [...set];
  if (arr.length > NOTIF_MAX_READ_IDS) arr = arr.slice(arr.length - NOTIF_MAX_READ_IDS);
  localStorage.setItem(_notifStorageKey(NOTIF_READ_IDS_BASE), JSON.stringify(arr));
}
function _isNotifRead(id) { return _getReadIds().has(String(id)); }

function notifBellHtml() {
  return `
    <div style="position:relative;">
      <button id="notif-bell-btn" onclick="toggleNotifDropdown(); return false;"
              style="background:none;border:none;position:relative;font-size:19px;color:#495057;padding:6px;cursor:pointer;">
        <i id="notif-bell-icon" class="bi bi-bell"></i>
        <span id="notif-badge" style="display:none;position:absolute;top:0;right:0;background:#dc3545;color:#fff;
              font-size:10px;font-weight:700;min-width:16px;height:16px;border-radius:8px;
              display:flex;align-items:center;justify-content:center;padding:0 3px;line-height:1;"></span>
      </button>
      <div id="notif-dropdown" style="display:none;position:absolute;right:0;top:38px;width:340px;max-height:440px;
           display:none;flex-direction:column;background:#fff;border:1px solid #e9ecef;border-radius:12px;
           box-shadow:0 8px 24px rgba(0,0,0,.12);z-index:1050;overflow:hidden;">
        <div style="padding:10px 14px;border-bottom:1px solid #f1f3f5;display:flex;align-items:center;gap:8px;">
          <span style="font-weight:700;font-size:13px;flex-grow:1;">Notifikasi</span>
          <a href="#" onclick="markAllNotifRead(); return false;" style="font-size:11px;color:#2563EB;text-decoration:none;">Tandai dibaca</a>
          <a href="#" onclick="clearAllNotif(); return false;" style="font-size:11px;color:#dc3545;text-decoration:none;">Hapus semua</a>
        </div>
        <div id="notif-list-body" style="padding:6px;overflow-y:auto;max-height:390px;">
          <div class="text-muted small text-center py-3">Memuat...</div>
        </div>
      </div>
    </div>
  `;
}

function initNotifBell() {
  injectNotifStyles();
  loadNotifHistory();
  connectNotifSocket();
  document.addEventListener('click', (e) => {
    const dropdown = document.getElementById('notif-dropdown');
    const btn = document.getElementById('notif-bell-btn');
    if (!dropdown || !btn) return;
    if (_notifDropdownOpen && !dropdown.contains(e.target) && !btn.contains(e.target)) {
      closeNotifDropdown();
    }
  });
}

async function loadNotifHistory() {
  try {
    const d = await api('/api/dashboard/notifications?limit=30');
    const clearedBefore = localStorage.getItem(_notifStorageKey(NOTIF_CLEARED_BEFORE_BASE));
    let list = d.notifications || [];
    if (clearedBefore) {
      const clearedTs = new Date(clearedBefore).getTime();
      list = list.filter(n => new Date(n.created_at.replace(' ', 'T')).getTime() > clearedTs);
    }
    _notifList = list;
    updateNotifBadge();
    renderNotifList();
  } catch (e) {
    // Gagal muat riwayat gak boleh ganggu halaman utama -- diamkan.
  }
}

function connectNotifSocket() {
  if (window.io) { _startNotifSocket(); return; }
  const s = document.createElement('script');
  s.src = 'https://cdn.socket.io/4.7.5/socket.io.min.js';
  s.onload = _startNotifSocket;
  document.head.appendChild(s);
}

function _startNotifSocket() {
  if (_notifSocket) return;
  _notifSocket = window.io();
  _notifSocket.on('connect', () => {
    const session = getSession();
    _notifSocket.emit('register-dashboard', { role: session ? session.role : null });
  });
  _notifSocket.on('notification', handleIncomingNotification);

  // BARU: selain notifikasi buat bell, ini juga dipakai buat AUTO-REFRESH
  // data di halaman yang lagi kebuka (order-detail, orders list, dsb) --
  // tanpa perlu klik notif atau reload manual dulu. Tiap halaman yang mau
  // ikut auto-refresh tinggal definisiin `window.onOrderRealtimeUpdate =
  // function(orderId) { ... }` di script-nya sendiri.
  _notifSocket.on('order-updated', (payload) => {
    if (typeof window.onOrderRealtimeUpdate === 'function') {
      window.onOrderRealtimeUpdate(payload?.orderId);
    }
  });
}

function handleIncomingNotification(n) {
  // Payload socket pakai orderNo/customerName (camelCase); riwayat dari
  // API pakai order_no/customer_name/created_at (snake_case) -- disamain
  // di sini biar renderNotifItem() gak perlu peduli sumbernya dari mana.
  const normalized = {
    id: `live-${Date.now()}-${Math.random().toString(36).slice(2)}`,
    order_id: n.orderId,
    order_no: n.orderNo,
    customer_name: n.customerName,
    event_type: n.eventType,
    note: n.note,
    actor_type: n.actorType,
    created_at: n.createdAt,
  };
  // Kalau dropdown lagi kebuka pas notif baru masuk, anggap langsung
  // "dilihat" -- gak perlu nambahin ke unread count.
  if (_notifDropdownOpen) {
    const ids = _getReadIds();
    ids.add(String(normalized.id));
    _saveReadIds(ids);
  }
  _notifList.unshift(normalized);
  if (_notifList.length > 50) _notifList.length = 50;

  updateNotifBadge();
  renderNotifList();
  playNotifSound();

  if (typeof window.onOrderRealtimeUpdate === 'function') {
    window.onOrderRealtimeUpdate(n.orderId);
  }
}

function injectNotifStyles() {
  if (_notifStylesInjected || document.getElementById('notif-bell-styles')) return;
  _notifStylesInjected = true;
  const style = document.createElement('style');
  style.id = 'notif-bell-styles';
  style.textContent = `
    @keyframes notifBellBlink {
      0%, 100% { color: #495057; transform: scale(1); }
      50% { color: #dc3545; transform: scale(1.18); }
    }
    .notif-bell-blink { animation: notifBellBlink 1s ease-in-out infinite; }
  `;
  document.head.appendChild(style);
}

function updateNotifBadge() {
  const badge = document.getElementById('notif-badge');
  const icon = document.getElementById('notif-bell-icon');
  const unreadCount = _notifList.filter(n => !_isNotifRead(n.id)).length;

  if (badge) {
    if (unreadCount > 0) {
      badge.textContent = unreadCount > 99 ? '99+' : unreadCount;
      badge.style.display = 'flex';
    } else {
      badge.style.display = 'none';
    }
  }

  // Ikon bell kedip-kedip TERUS selama masih ada yang belum dibaca --
  // berhenti otomatis begitu unreadCount balik ke 0 (semua udah dibaca).
  if (icon) {
    icon.classList.toggle('notif-bell-blink', unreadCount > 0);
  }

  // Reminder: tiap 30 detik, bunyi beda selama MASIH ada yang belum
  // dibaca. Timer cuma di-start sekali (gak di-reset tiap notif baru
  // masuk) dan otomatis berhenti begitu unreadCount == 0.
  if (unreadCount > 0 && !_notifReminderIntervalId) {
    _notifReminderIntervalId = setInterval(() => {
      const stillUnread = _notifList.filter(n => !_isNotifRead(n.id)).length;
      if (stillUnread > 0) {
        playReminderSound();
      } else {
        clearInterval(_notifReminderIntervalId);
        _notifReminderIntervalId = null;
      }
    }, 30000);
  } else if (unreadCount === 0 && _notifReminderIntervalId) {
    clearInterval(_notifReminderIntervalId);
    _notifReminderIntervalId = null;
  }
}

/* Tandai SATU notifikasi udah dibaca -- dipanggil pas item-nya diklik
   (sebelum browser pindah ke halaman order-detail tujuannya). */
function markNotifRead(id) {
  const ids = _getReadIds();
  ids.add(String(id));
  _saveReadIds(ids);
  updateNotifBadge();
  renderNotifList();
}

function markAllNotifRead() {
  const ids = _getReadIds();
  _notifList.forEach(n => ids.add(String(n.id)));
  _saveReadIds(ids);
  updateNotifBadge();
  renderNotifList();
}

/* "Hapus Semua" -- cuma bersihin TAMPILAN dropdown, data asli di
   Timeline Pekerjaan order tetap ada (gak ada DELETE ke server). Notif
   baru yang masuk SETELAH ini tetap muncul seperti biasa. */
function clearAllNotif() {
  if (!_notifList.length) return;
  if (!confirm('Hapus semua notifikasi dari daftar ini? (Riwayat di halaman detail order tetap tersimpan)')) return;
  localStorage.setItem(_notifStorageKey(NOTIF_CLEARED_BEFORE_BASE), new Date().toISOString());
  _notifList = [];
  updateNotifBadge();
  renderNotifList();
}

function notifItemText(n) {
  const parts = [];
  if (n.order_no) parts.push(n.order_no);
  if (n.customer_name) parts.push(n.customer_name);
  const header = parts.join(' — ') || 'Order';
  return { header, body: n.note || n.event_type.replace(/_/g, ' ') };
}

function renderNotifList() {
  const body = document.getElementById('notif-list-body');
  if (!body) return;
  if (!_notifList.length) {
    body.innerHTML = '<div class="text-muted small text-center py-3">Belum ada notifikasi</div>';
    return;
  }
  body.innerHTML = _notifList.map(n => {
    const { header, body: text } = notifItemText(n);
    const unread = !_isNotifRead(n.id);
    return `
      <a href="order-detail?id=${n.order_id}" onclick="markNotifRead('${n.id}')"
         style="display:flex;gap:10px;padding:9px 8px;border-radius:8px;
         text-decoration:none;color:inherit;background:${unread ? '#eef4ff' : 'transparent'};"
         onmouseover="this.style.background='#f8f9fb'" onmouseout="this.style.background='${unread ? '#eef4ff' : 'transparent'}'">
        <div style="width:30px;height:30px;border-radius:50%;background:#eef1f6;flex-shrink:0;
             display:flex;align-items:center;justify-content:center;color:#495057;font-size:14px;position:relative;">
          <i class="bi ${notifIcon(n.event_type)}"></i>
          ${unread ? '<span style="position:absolute;top:-1px;right:-1px;width:8px;height:8px;border-radius:50%;background:#2563EB;border:1.5px solid #fff;"></span>' : ''}
        </div>
        <div style="min-width:0;flex:1;">
          <div style="font-size:12.5px;font-weight:${unread ? 700 : 500};color:#212529;">${escapeHtml(header)}</div>
          <div style="font-size:12px;color:#667085;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;">${escapeHtml(text)}</div>
          <div style="font-size:10.5px;color:#adb5bd;margin-top:2px;">${relTime(n.created_at)}</div>
        </div>
      </a>
    `;
  }).join('');
}

function toggleNotifDropdown() {
  _notifDropdownOpen ? closeNotifDropdown() : openNotifDropdown();
}

function openNotifDropdown() {
  const dropdown = document.getElementById('notif-dropdown');
  if (!dropdown) return;
  dropdown.style.display = 'flex';
  _notifDropdownOpen = true;
}

function closeNotifDropdown() {
  const dropdown = document.getElementById('notif-dropdown');
  if (!dropdown) return;
  dropdown.style.display = 'none';
  _notifDropdownOpen = false;
}

/* Bunyi REMINDER (tiap 30 detik selama masih ada notif belum dibaca) --
   sengaja dibikin BEDA dari bunyi notif baru: 3 beep pendek nada rendah
   yang sama (kayak "masih nunggu, masih nunggu, masih nunggu"), bukan
   2 nada naik kayak playNotifSound() (yang artinya "ada yang baru masuk"). */
function playReminderSound() {
  try {
    if (!_audioCtx) _audioCtx = new (window.AudioContext || window.webkitAudioContext)();
    if (_audioCtx.state === 'suspended') _audioCtx.resume();
    const ctx = _audioCtx;
    const now = ctx.currentTime;
    [0, 1, 2].forEach(i => {
      const osc = ctx.createOscillator();
      const gain = ctx.createGain();
      osc.type = 'triangle';
      osc.frequency.value = 523;
      const start = now + i * 0.16;
      gain.gain.setValueAtTime(0.0001, start);
      gain.gain.exponentialRampToValueAtTime(0.18, start + 0.02);
      gain.gain.exponentialRampToValueAtTime(0.0001, start + 0.12);
      osc.connect(gain).connect(ctx.destination);
      osc.start(start);
      osc.stop(start + 0.14);
    });
  } catch (e) {
    // Audio gagal (browser block dsb) -- diamkan, jangan ganggu app.
  }
}

/* Bunyi notifikasi pakai Web Audio API (2 nada singkat) -- gak perlu
   file audio terpisah. Browser modern nge-block autoplay audio sebelum
   ada interaksi user; karena bell ini muncul SETELAH staff login (yang
   berarti mereka udah klik tombol login sebelumnya), AudioContext
   biasanya udah "unlocked" di titik ini. */
function playNotifSound() {
  try {
    if (!_audioCtx) _audioCtx = new (window.AudioContext || window.webkitAudioContext)();
    if (_audioCtx.state === 'suspended') _audioCtx.resume();
    const ctx = _audioCtx;
    const now = ctx.currentTime;
    [880, 1174].forEach((freq, i) => {
      const osc = ctx.createOscillator();
      const gain = ctx.createGain();
      osc.type = 'sine';
      osc.frequency.value = freq;
      const start = now + i * 0.12;
      gain.gain.setValueAtTime(0.0001, start);
      gain.gain.exponentialRampToValueAtTime(0.22, start + 0.02);
      gain.gain.exponentialRampToValueAtTime(0.0001, start + 0.18);
      osc.connect(gain).connect(ctx.destination);
      osc.start(start);
      osc.stop(start + 0.2);
    });
  } catch (e) {
    // Audio gagal (browser block dsb) -- diamkan, jangan ganggu app.
  }
}