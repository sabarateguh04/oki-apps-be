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

   Badge counter pakai localStorage 'oki_notif_last_seen' (timestamp
   terakhir kali bell dibuka) -- bukan per-akun di server, cukup per
   browser. Dibuka sekali -> semua tertandai "sudah dilihat".
============================================ */

const NOTIF_LAST_SEEN_KEY = 'oki_notif_last_seen';

let _notifList = [];
let _notifUnseenCount = 0;
let _notifDropdownOpen = false;
let _notifSocket = null;
let _audioCtx = null;

const NOTIF_EVENT_ICON = {
  CREATED: 'bi-plus-circle', APPROVED: 'bi-check2-circle', REJECTED: 'bi-x-circle',
  ASSIGNED: 'bi-person-check-fill', ON_THE_WAY: 'bi-signpost-fill', IN_PROGRESS: 'bi-tools',
  DONE: 'bi-check-circle-fill', CANCELLED: 'bi-slash-circle', NOTE: 'bi-info-circle',
};
function notifIcon(eventType) { return NOTIF_EVENT_ICON[eventType] || 'bi-bell'; }

function notifBellHtml() {
  return `
    <div style="position:relative;">
      <button id="notif-bell-btn" onclick="toggleNotifDropdown(); return false;"
              style="background:none;border:none;position:relative;font-size:19px;color:#495057;padding:6px;cursor:pointer;">
        <i class="bi bi-bell"></i>
        <span id="notif-badge" style="display:none;position:absolute;top:0;right:0;background:#dc3545;color:#fff;
              font-size:10px;font-weight:700;min-width:16px;height:16px;border-radius:8px;
              display:flex;align-items:center;justify-content:center;padding:0 3px;line-height:1;"></span>
      </button>
      <div id="notif-dropdown" style="display:none;position:absolute;right:0;top:38px;width:340px;max-height:400px;
           overflow-y:auto;background:#fff;border:1px solid #e9ecef;border-radius:12px;
           box-shadow:0 8px 24px rgba(0,0,0,.12);z-index:1050;">
        <div style="padding:10px 14px;border-bottom:1px solid #f1f3f5;font-weight:700;font-size:13px;">
          Notifikasi
        </div>
        <div id="notif-list-body" style="padding:6px;">
          <div class="text-muted small text-center py-3">Memuat...</div>
        </div>
      </div>
    </div>
  `;
}

function initNotifBell() {
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
    _notifList = d.notifications || [];
    const lastSeenRaw = localStorage.getItem(NOTIF_LAST_SEEN_KEY);
    if (!lastSeenRaw) {
      // Pertama kali pernah buka -- riwayat lama gak dianggap "baru",
      // biar badge gak langsung penuh nampilin history lama sekaligus.
      localStorage.setItem(NOTIF_LAST_SEEN_KEY, new Date().toISOString());
      _notifUnseenCount = 0;
    } else {
      const lastSeen = new Date(lastSeenRaw).getTime();
      _notifUnseenCount = _notifList.filter(n => new Date(n.created_at.replace(' ', 'T')).getTime() > lastSeen).length;
    }
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
  _notifSocket.on('connect', () => _notifSocket.emit('register-dashboard'));
  _notifSocket.on('notification', handleIncomingNotification);
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
  _notifList.unshift(normalized);
  if (_notifList.length > 50) _notifList.length = 50;

  if (_notifDropdownOpen) {
    localStorage.setItem(NOTIF_LAST_SEEN_KEY, new Date().toISOString());
  } else {
    _notifUnseenCount++;
    updateNotifBadge();
  }
  renderNotifList();
  playNotifSound();
}

function updateNotifBadge() {
  const badge = document.getElementById('notif-badge');
  if (!badge) return;
  if (_notifUnseenCount > 0) {
    badge.textContent = _notifUnseenCount > 99 ? '99+' : _notifUnseenCount;
    badge.style.display = 'flex';
  } else {
    badge.style.display = 'none';
  }
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
    return `
      <a href="order-detail?id=${n.order_id}" style="display:flex;gap:10px;padding:9px 8px;border-radius:8px;
         text-decoration:none;color:inherit;" onmouseover="this.style.background='#f8f9fb'" onmouseout="this.style.background='transparent'">
        <div style="width:30px;height:30px;border-radius:50%;background:#eef1f6;flex-shrink:0;
             display:flex;align-items:center;justify-content:center;color:#495057;font-size:14px;">
          <i class="bi ${notifIcon(n.event_type)}"></i>
        </div>
        <div style="min-width:0;flex:1;">
          <div style="font-size:12.5px;font-weight:700;color:#212529;">${escapeHtml(header)}</div>
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
  dropdown.style.display = 'block';
  _notifDropdownOpen = true;
  _notifUnseenCount = 0;
  localStorage.setItem(NOTIF_LAST_SEEN_KEY, new Date().toISOString());
  updateNotifBadge();
}

function closeNotifDropdown() {
  const dropdown = document.getElementById('notif-dropdown');
  if (!dropdown) return;
  dropdown.style.display = 'none';
  _notifDropdownOpen = false;
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