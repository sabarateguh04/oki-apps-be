/* ============================================
   Sidebar + topbar reusable — dipanggil dari tiap halaman:
   renderLayout({ active: 'dashboard', title: 'Dashboard' })
============================================ */

const STAFF_NAV = [
  { key: 'dashboard', href: 'dashboard.html',  icon: 'bi-speedometer2', label: 'Dashboard' },
  { key: 'orders',    href: 'orders.html',     icon: 'bi-list-task',    label: 'Data Order' },
  { key: 'approval',  href: 'approval.html',   icon: 'bi-check2-square',label: 'Approval Order' },
  { key: 'customer',  href: 'customer.html',   icon: 'bi-people',       label: 'Master Customer' },
  { key: 'technician',href: 'technician.html', icon: 'bi-person-badge', label: 'Master Teknisi' },
];

const TECH_NAV = [
  { key: 'profile', href: 'profile.html', icon: 'bi-person-circle', label: 'Profile Saya' },
];

function renderLayout({ active, title }) {
  const session = getSession();
  if (!session) return;

  const nav = session.type === 'technician' ? TECH_NAV : STAFF_NAV;
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
