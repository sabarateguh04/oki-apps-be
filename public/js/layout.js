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
        <div class="user-chip">
          <div class="av">${(session.nama || '?').slice(0,1).toUpperCase()}</div>
          <span>${session.nama}${session.role ? ' · ' + session.role : ''}</span>
        </div>
      </nav>
    `;
  }
}