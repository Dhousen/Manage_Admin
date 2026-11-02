document.addEventListener('DOMContentLoaded', () => {
  const body = document.body;
  const savedTheme = localStorage.getItem('apms-theme') || 'dark';
  body.dataset.theme = savedTheme;

  document.querySelectorAll('[data-password-toggle]').forEach((toggle) => {
    const passwordInput = document.getElementById('password');
    if (!passwordInput) return;
    toggle.addEventListener('click', () => {
      const isVisible = passwordInput.type === 'text';
      passwordInput.type = isVisible ? 'password' : 'text';
      toggle.setAttribute('aria-pressed', String(!isVisible));
      toggle.setAttribute('aria-label', isVisible ? 'Tampilkan password' : 'Sembunyikan password');
    });
  });

  const topbar = document.querySelector('.topbar');
  if (topbar) topbar.replaceChildren();

  if (topbar && !document.querySelector('[data-theme-toggle]')) {
    const toggleBtn = document.createElement('button');
    toggleBtn.type = 'button';
    toggleBtn.className = 'theme-toggle';
    toggleBtn.dataset.themeToggle = 'true';
    toggleBtn.setAttribute('aria-label', 'Toggle theme');
    toggleBtn.addEventListener('click', () => {
      const nextTheme = body.dataset.theme === 'dark' ? 'light' : 'dark';
      body.dataset.theme = nextTheme;
      localStorage.setItem('apms-theme', nextTheme);
      syncThemeButton(toggleBtn, nextTheme);
    });
    syncThemeButton(toggleBtn, savedTheme);
    const actions = document.createElement('div');
    actions.className = 'topbar-actions';
    actions.appendChild(toggleBtn);
    topbar.appendChild(actions);
  }

  if (!document.querySelector('[data-theme-toggle]')) {
    const authWrap = document.querySelector('.auth-wrap');
    if (authWrap) {
      const toggleBtn = document.createElement('button');
      toggleBtn.type = 'button';
      toggleBtn.className = 'theme-toggle';
      toggleBtn.dataset.themeToggle = 'true';
      toggleBtn.setAttribute('aria-label', 'Toggle theme');
      toggleBtn.addEventListener('click', () => {
        const nextTheme = body.dataset.theme === 'dark' ? 'light' : 'dark';
        body.dataset.theme = nextTheme;
        localStorage.setItem('apms-theme', nextTheme);
        syncThemeButton(toggleBtn, nextTheme);
      });
      syncThemeButton(toggleBtn, savedTheme);
      authWrap.prepend(toggleBtn);
    }
  }

  const sidebar = document.querySelector('.sidebar');
  if (sidebar) {
    sidebar.querySelectorAll('.nav-item a').forEach((link) => {
      const text = link.textContent.trim();
      const icons = {
        '/dashboard': '<rect x="3" y="3" width="7" height="7" rx="1"/><rect x="14" y="3" width="7" height="5" rx="1"/><rect x="14" y="12" width="7" height="9" rx="1"/><rect x="3" y="14" width="7" height="7" rx="1"/>',
        '/admins': '<circle cx="9" cy="8" r="3"/><path d="M3 20v-1a6 6 0 0 1 12 0v1"/><path d="M16 5.5a3 3 0 0 1 0 5.8M18 14a5 5 0 0 1 3 5v1"/>',
        '/performance': '<path d="M3 3v18h18"/><path d="m7 14 4-4 4 3 6-7"/>',
        '/audit': '<path d="M9 11 12 14 22 4"/><path d="M21 12v7a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h11"/>',
        '/reports': '<path d="M4 19V5"/><path d="M4 19h17"/><rect x="7" y="11" width="3" height="5" rx="1"/><rect x="13" y="7" width="3" height="9" rx="1"/><rect x="19" y="4" width="3" height="12" rx="1"/>',
        '/jobdesk': '<path d="M9 6h11"/><path d="M9 12h11"/><path d="M9 18h11"/><path d="m3 6 1 1 2-2"/><path d="m3 12 1 1 2-2"/><path d="m3 18 1 1 2-2"/>',
        '/history': '<path d="M3 12a9 9 0 1 0 3-6.7L3 8"/><path d="M3 3v5h5"/><path d="M12 7v5l3 2"/>',
        '/export': '<path d="M12 3v12"/><path d="m7 10 5 5 5-5"/><path d="M5 21h14a2 2 0 0 0 2-2v-3M3 16v3a2 2 0 0 0 2 2"/>',
        '/settings': '<circle cx="12" cy="12" r="3"/><path d="m19.4 15 .1.1 1.4 1.1-1.4 2.4-1.7-.7a8 8 0 0 1-1.8 1l-.3 1.8h-2.8l-.3-1.8a8 8 0 0 1-1.8-1l-1.7.7-1.4-2.4 1.4-1.1a7 7 0 0 1 0-2l-1.4-1.1 1.4-2.4 1.7.7a8 8 0 0 1 1.8-1l.3-1.8h2.8l.3 1.8a8 8 0 0 1 1.8 1l1.7-.7 1.4 2.4-1.4 1.1a7 7 0 0 1 0 2Z"/>',
        '/logout': '<path d="M10 17l5-5-5-5"/><path d="M15 12H3"/><path d="M12 3h6a2 2 0 0 1 2 2v14a2 2 0 0 1-2 2h-6"/>'
      };
      const href = new URL(link.href, window.location.origin).pathname;
      const icon = icons[href] || '<circle cx="12" cy="12" r="8"/>';
      link.innerHTML = `<svg class="nav-icon" viewBox="0 0 24 24" aria-hidden="true">${icon}</svg><span class="nav-label">${text}</span>`;
      link.title = text;
    });

    if (!document.querySelector('[data-sidebar-toggle]')) {
      const sidebarToggle = document.createElement('button');
      sidebarToggle.type = 'button';
      sidebarToggle.className = 'sidebar-toggle';
      sidebarToggle.dataset.sidebarToggle = 'true';
      sidebarToggle.setAttribute('aria-label', 'Toggle sidebar');
      sidebarToggle.title = 'Buka/tutup navigasi';
      sidebarToggle.innerHTML = '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M4 6h16M4 12h16M4 18h16"/></svg>';
      const topbar = document.querySelector('.topbar');
      const mobileBackdrop = document.createElement('button');
      mobileBackdrop.type = 'button';
      mobileBackdrop.className = 'sidebar-backdrop';
      mobileBackdrop.setAttribute('aria-label', 'Tutup navigasi');
      document.body.appendChild(mobileBackdrop);

      const closeMobileSidebar = () => {
        sidebar.classList.remove('mobile-open');
        mobileBackdrop.classList.remove('is-visible');
        sidebarToggle.setAttribute('aria-expanded', 'false');
      };

      if (topbar) {
        topbar.prepend(sidebarToggle);
      } else {
        sidebar.prepend(sidebarToggle);
      }
      sidebarToggle.addEventListener('click', () => {
        if (window.matchMedia('(max-width: 860px)').matches) {
          const isOpen = sidebar.classList.toggle('mobile-open');
          mobileBackdrop.classList.toggle('is-visible', isOpen);
          sidebarToggle.setAttribute('aria-expanded', String(isOpen));
          return;
        }
        const nextState = sidebar.classList.contains('collapsed') ? 'expanded' : 'collapsed';
        sidebar.classList.toggle('collapsed', nextState === 'collapsed');
        sidebarToggle.setAttribute('aria-expanded', String(nextState === 'expanded'));
        localStorage.setItem('apms-sidebar', nextState);
      });
      mobileBackdrop.addEventListener('click', closeMobileSidebar);
      sidebar.querySelectorAll('.nav-item a').forEach((link) => {
        link.addEventListener('click', () => {
          if (window.matchMedia('(max-width: 860px)').matches) closeMobileSidebar();
        });
      });

      const savedSidebarState = localStorage.getItem('apms-sidebar') || 'expanded';
      if (savedSidebarState === 'collapsed') {
        sidebar.classList.add('collapsed');
        sidebarToggle.setAttribute('aria-expanded', 'false');
      } else {
        sidebarToggle.setAttribute('aria-expanded', 'true');
      }
    }
  }

  document.querySelectorAll('[data-chart]').forEach((chartHost) => {
    const labels = JSON.parse(chartHost.dataset.chartLabels || '[]');
    const values = JSON.parse(chartHost.dataset.chartValues || '[]');
    if (labels.length && values.length) {
      renderChart(chartHost, labels, values, chartHost.dataset.chartType || 'line');
    }
  });
});

let chartSequence = 0;

function syncThemeButton(button, theme) {
  if (!button) return;
  const isDark = theme === 'dark';
  button.innerHTML = isDark
    ? '<span class="toggle-icon">☀️</span><span class="toggle-label">Light</span>'
    : '<span class="toggle-icon">🌙</span><span class="toggle-label">Dark</span>';
  button.title = isDark ? 'Switch to light mode' : 'Switch to dark mode';
}

function renderChart(host, labels, values, type) {
  const width = 640;
  const height = 250;
  const padding = { top: 22, right: 60, bottom: 42, left: 56 };
  const safeValues = values.map((value) => Number(value) || 0);
  const maxValue = 100;
  const minValue = 0;
  const chartHeight = height - padding.top - padding.bottom;
  const chartWidth = width - padding.left - padding.right;
  const y = (value) => height - padding.bottom - ((value - minValue) / Math.max(maxValue - minValue, 1)) * chartHeight;
  const gradientId = `chartGradient-${chartSequence += 1}`;

  const points = safeValues.map((value, index) => {
    const x = type === 'bar'
      ? padding.left + ((index + 0.5) * chartWidth) / Math.max(safeValues.length, 1)
      : padding.left + (index * chartWidth) / Math.max(safeValues.length - 1, 1);
    return { x, y: y(value), value, label: labels[index] || `#${index + 1}` };
  });

  const linePath = points.map((point, index) => `${index === 0 ? 'M' : 'L'} ${point.x} ${point.y}`).join(' ');
  const areaPath = `${linePath} L ${points[points.length - 1].x} ${height - padding.bottom} L ${points[0].x} ${height - padding.bottom} Z`;
  const gridLines = Array.from({ length: 5 }, (_, i) => {
    const value = maxValue - ((maxValue - minValue) * i) / 4;
    const lineY = y(value);
    return `<g><line x1="${padding.left}" x2="${width - padding.right}" y1="${lineY}" y2="${lineY}" class="chart-gridline"/><text x="${padding.left - 10}" y="${lineY + 4}" class="chart-axis-label" text-anchor="end">${Math.round(value)}%</text></g>`;
  }).join('');
  const chartLabel = (label) => String(label).replace(/[&<>"']/g, (character) => ({
    '&': '&amp;',
    '<': '&lt;',
    '>': '&gt;',
    '"': '&quot;',
    "'": '&#39;'
  })[character]);
  const xLabels = points.map((point) => `<text x="${point.x}" y="${height - 12}" class="chart-axis-label chart-x-label" text-anchor="middle">${chartLabel(point.label)}</text>`).join('');
  const series = type === 'bar'
    ? points.map((point) => `<g class="chart-point" data-label="${chartLabel(point.label)}" data-value="${point.value}" data-x="${point.x}" data-y="${point.y}"><rect class="chart-bar" style="fill:url(#${gradientId})" x="${point.x - Math.min(21, chartWidth / (points.length * 3))}" y="${point.y}" width="${Math.min(42, chartWidth / (points.length * 1.7))}" height="${Math.max(0, height - padding.bottom - point.y)}" rx="7"/></g>`).join('')
    : `<path d="${areaPath}" fill="url(#${gradientId})" opacity="0.9"></path><path d="${linePath}" fill="none" stroke="var(--primary)" stroke-width="3" stroke-linecap="round" stroke-linejoin="round"></path>${points.map((point) => `<g class="chart-point" data-label="${chartLabel(point.label)}" data-value="${point.value}" data-x="${point.x}" data-y="${point.y}"><circle cx="${point.x}" cy="${point.y}" r="5" fill="var(--primary-2)" stroke="var(--white)" stroke-width="2"></circle></g>`).join('')}`;

  const svg = `
    <svg viewBox="0 0 ${width} ${height}" role="img" aria-label="Grafik kinerja bulanan">
      <defs>
        <linearGradient id="${gradientId}" x1="0" x2="0" y1="0" y2="1">
          <stop offset="0%" stop-color="rgba(94, 234, 212, 0.45)" />
          <stop offset="100%" stop-color="rgba(96, 165, 250, 0.08)" />
        </linearGradient>
      </defs>
      ${gridLines}
      ${xLabels}
      ${series}
    </svg>
  `;

  host.innerHTML = svg;

  host.querySelectorAll('.chart-point').forEach((point) => {
    point.addEventListener('mouseenter', (event) => {
      const label = event.currentTarget.dataset.label;
      const value = event.currentTarget.dataset.value;
      const x = Number(event.currentTarget.dataset.x);
      const y = Number(event.currentTarget.dataset.y);

      const tooltip = document.createElement('div');
      tooltip.className = 'chart-tooltip';
      tooltip.textContent = `${label}: ${value}%`;
      host.appendChild(tooltip);
      const viewBoxWidth = 640;
      const scale = host.clientWidth / viewBoxWidth;
      tooltip.style.left = `${x * scale + 12}px`;
      tooltip.style.top = `${y * scale - 12}px`;
    });
    point.addEventListener('mouseleave', () => {
      host.querySelector('.chart-tooltip')?.remove();
    });
  });
}
