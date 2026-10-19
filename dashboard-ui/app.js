/* Kamala owner dashboard. Talks to the API on Render (/dash/api). Plain JS, no build step. */
(() => {
  'use strict';

  // Same server when opened at <render>/dashboard, otherwise (Cloudflare) the Render API.
  const API = window.KAMALA_API ?? (location.pathname.startsWith('/dashboard') ? '' : 'https://whatsapp-agent-gqg6.onrender.com');
  const TZ = 'Asia/Kolkata';
  const COLORS = { pink: '#C2185B', blue: '#3F6EA8', amber: '#C77A12', grid: '#F1E7EB', ink: '#5E4F56' };

  const store = {
    get(k) { try { return localStorage.getItem(k); } catch (e) { return null; } },
    set(k, v) { try { if (v == null) localStorage.removeItem(k); else localStorage.setItem(k, v); } catch (e) { /* private mode */ } }
  };

  const state = {
    token: store.get('kamala_token'),
    me: null,
    range: 'today',
    view: null,
    charts: [],
    inbox: { filter: 'all', q: '', tag: '', people: [], selected: null, messages: [], more: false, person: null, invoices: [], unread: new Set(), detail: false },
    invoices: { filter: 'all', rows: [], total: 0 },
    alertsSeen: Number(store.get('kamala_alerts_seen') || 0),
    es: null,
    refreshTimer: null
  };

  // ---------- small helpers ----------
  const $ = (sel, root = document) => root.querySelector(sel);
  const $$ = (sel, root = document) => [...root.querySelectorAll(sel)];
  const esc = s => String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  const money = paise => '₹' + Math.round(Number(paise || 0) / 100).toLocaleString('en-IN');
  const num = n => Number(n || 0).toLocaleString('en-IN');
  const pct = (a, b) => (b ? Math.round((a / b) * 100) : 0) + '%';
  const plural = (n, one, many) => num(n) + ' ' + (Number(n) === 1 ? one : many);
  const phoneText = p => (p ? '+' + String(p).replace(/^\+/, '') : '');
  const initials = (name, phone) => {
    const n = String(name || '').trim();
    if (!n) return String(phone || '').slice(-2);
    return n.split(/\s+/).slice(0, 2).map(w => w[0]).join('').toUpperCase();
  };
  const fmt = (d, opts) => (d ? new Date(d).toLocaleString('en-IN', { timeZone: TZ, ...opts }) : '');
  const dateTime = d => fmt(d, { day: 'numeric', month: 'short', hour: 'numeric', minute: '2-digit' });
  const timeOnly = d => fmt(d, { hour: 'numeric', minute: '2-digit' });
  const dayKey = d => fmt(d, { year: 'numeric', month: '2-digit', day: '2-digit' });
  const ago = d => {
    if (!d) return '';
    const s = (Date.now() - new Date(d)) / 1000;
    if (s < 60) return 'now';
    if (s < 3600) return Math.floor(s / 60) + 'm';
    if (dayKey(d) === dayKey(new Date())) return timeOnly(d);
    if (s < 6 * 86400) return fmt(d, { weekday: 'short' });
    return fmt(d, { day: 'numeric', month: 'short' });
  };
  const hourLabel = h => (h % 12 === 0 ? 12 : h % 12) + (h < 12 ? 'am' : 'pm');

  function toast(msg, bad) {
    const t = $('#toast');
    t.textContent = msg;
    t.className = 'toast show' + (bad ? ' bad' : '');
    clearTimeout(toast.timer);
    toast.timer = setTimeout(() => { t.className = 'toast'; }, bad ? 6000 : 3500);
  }

  async function api(path, { method = 'GET', body, raw } = {}) {
    const res = await fetch(API + path, {
      method,
      headers: { Authorization: 'Bearer ' + (state.token || ''), ...(body ? { 'Content-Type': 'application/json' } : {}) },
      body: body ? JSON.stringify(body) : undefined
    });
    if (res.status === 401 && path !== '/dash/api/login') { signedOut(); throw new Error('Please sign in again.'); }
    if (raw) {
      if (!res.ok) { let m = 'Request failed'; try { m = (await res.json()).error || m; } catch (e) { /* not json */ } throw new Error(m); }
      return res;
    }
    let data = {};
    try { data = await res.json(); } catch (e) { throw new Error('The server did not answer properly (HTTP ' + res.status + ').'); }
    if (!res.ok || data.ok === false) throw Object.assign(new Error(data.error || data.message || 'Request failed'), { status: res.status, data });
    return data;
  }

  // ---------- sign in / out ----------
  function showLogin(msg) {
    $('#app').hidden = true;
    $('#login').hidden = false;
    $('#loginErr').textContent = msg || '';
    setTimeout(() => $('#pw').focus(), 50);
  }
  function signedOut(msg) {
    state.token = null;
    store.set('kamala_token', null);
    if (state.es) { state.es.close(); state.es = null; }
    showLogin(msg || 'Your session ended. Please sign in again.');
  }
  $('#loginForm').addEventListener('submit', async e => {
    e.preventDefault();
    const btn = $('#loginBtn');
    btn.disabled = true;
    $('#loginErr').textContent = '';
    try {
      const r = await api('/dash/api/login', { method: 'POST', body: { password: $('#pw').value } });
      state.token = r.token;
      store.set('kamala_token', r.token);
      $('#pw').value = '';
      await start();
    } catch (err) {
      $('#loginErr').textContent = err.message === 'Failed to fetch' ? 'Could not reach the server. Check your internet and try again.' : err.message;
    } finally {
      btn.disabled = false;
    }
  });

  async function start() {
    try {
      state.me = await api('/dash/api/me');
    } catch (e) {
      if (state.token) showLogin(e.message === 'Failed to fetch' ? 'Could not reach the server. It may be waking up; try again in a minute.' : e.message);
      return;
    }
    $('#login').hidden = true;
    $('#app').hidden = false;
    connectStream();
    checkAlertDot();
    route();
  }

  // ---------- routing ----------
  function parseHash() {
    const h = location.hash.replace(/^#\/?/, '');
    const [path, query] = h.split('?');
    const parts = path.split('/').filter(Boolean);
    const params = new URLSearchParams(query || '');
    return { view: parts[0] || 'overview', arg: parts[1] ? decodeURIComponent(parts[1]) : null, params };
  }
  window.addEventListener('hashchange', () => { if (state.token && !$('#app').hidden) route(); });

  function destroyCharts() {
    state.charts.forEach(c => { try { c.destroy(); } catch (e) { /* gone */ } });
    state.charts = [];
  }

  function route() {
    const { view, arg, params } = parseHash();
    const views = { overview: viewOverview, inbox: viewInbox, invoices: viewInvoices, insights: viewInsights, alerts: viewAlerts, settings: viewSettings };
    const fn = views[view] || viewOverview;
    const name = views[view] ? view : 'overview';
    $$('.nav a').forEach(a => a.classList.toggle('active', a.dataset.view === name));
    if (name !== 'inbox' || state.view !== 'inbox') destroyCharts();
    const sameInbox = name === 'inbox' && state.view === 'inbox';
    state.view = name;
    fn(arg, params, sameInbox);
  }

  // ---------- live updates ----------
  function connectStream() {
    if (state.es || !state.token || typeof EventSource === 'undefined') return;
    const es = new EventSource(API + '/dash/api/stream?token=' + encodeURIComponent(state.token));
    state.es = es;
    es.onopen = () => $('#live').classList.add('on');
    es.onerror = () => {
      $('#live').classList.remove('on');
      if (es.readyState === EventSource.CLOSED) {
        state.es = null;
        // A closed stream usually means a sleeping server or an expired session: check, then reconnect.
        setTimeout(async () => {
          if (!state.token) return;
          try { await api('/dash/api/me'); connectStream(); } catch (e) { if (state.token) setTimeout(connectStream, 15000); }
        }, 5000);
      }
    };
    const on = (type, fn) => es.addEventListener(type, ev => { try { fn(JSON.parse(ev.data)); } catch (e) { console.error(e); } });
    on('message', ev => onMessage(ev.message));
    on('invoice', ev => { toast('Invoice sent: ' + (ev.service || '') + ' ' + money(ev.amount_paise)); softRefresh(['overview', 'invoices', 'insights']); refreshPersonIf(ev.phone); });
    on('payment', ev => {
      if (ev.status === 'paid') toast('Payment received: ' + (ev.service || '') + ' ' + money(ev.amount_paise));
      softRefresh(['overview', 'invoices', 'insights']);
      refreshPersonIf(ev.phone);
    });
    on('invoice_update', () => softRefresh(['invoices', 'overview', 'insights']));
    on('alert', ev => {
      const a = ev.alert || {};
      if (state.view === 'alerts') viewAlerts(); else $('#alertDot').hidden = false;
      if (a.priority === 'important') toast(a.subject || 'New alert');
    });
    on('person', ev => {
      if (state.view === 'inbox' && state.inbox.selected === ev.phone && state.inbox.person) {
        state.inbox.person.is_paused = ev.is_paused;
        const sw = $('#pauseSw');
        if (sw) sw.checked = !!ev.is_paused;
      }
      if (state.view === 'inbox') loadPeople(true);
    });
  }

  // Re-draws the current page a few seconds after a change (one refresh for a burst of events).
  function softRefresh(views) {
    if (!views.includes(state.view)) return;
    clearTimeout(state.refreshTimer);
    state.refreshTimer = setTimeout(() => {
      if (state.view === 'overview') viewOverview(null, null, true);
      else if (state.view === 'insights') viewInsights(null, null, true);
      else if (state.view === 'invoices') loadInvoices(true);
    }, 3000);
  }
  function refreshPersonIf(phone) {
    if (state.view === 'inbox' && phone && state.inbox.selected === phone) loadDetail(phone);
  }

  function onMessage(m) {
    if (!m || !m.phone) return;
    const ib = state.inbox;
    if (state.view === 'inbox' && ib.selected === m.phone) {
      mergeMessages([m]);
    } else if (m.role === 'user') {
      ib.unread.add(m.phone);
      if (state.view !== 'inbox') $('#inboxDot').hidden = false;
    }
    if (state.view === 'inbox') {
      clearTimeout(onMessage.t);
      onMessage.t = setTimeout(() => loadPeople(true), 1200);
    } else {
      softRefresh(['overview']);
    }
  }

  // ---------- shared pieces ----------
  function rangeSeg() {
    const r = [['today', 'Today'], ['7d', '7 days'], ['30d', '30 days'], ['90d', '90 days']];
    return '<div class="seg" role="group" aria-label="Date range">' +
      r.map(([k, l]) => `<button type="button" data-range="${k}" class="${state.range === k ? 'on' : ''}">${l}</button>`).join('') + '</div>';
  }
  function bindRange(rerender) {
    $$('[data-range]').forEach(b => b.addEventListener('click', () => { state.range = b.dataset.range; rerender(); }));
  }
  const rangeWords = () => ({ today: 'today', '7d': 'in the last 7 days', '30d': 'in the last 30 days', '90d': 'in the last 90 days' }[state.range]);

  function chart(canvas, config) {
    if (!window.Chart || !canvas) return null;
    const c = new window.Chart(canvas, config);
    state.charts.push(c);
    return c;
  }
  function baseOptions(extra = {}) {
    return {
      responsive: true, maintainAspectRatio: false, animation: { duration: 250 },
      interaction: { mode: 'index', intersect: false },
      plugins: {
        legend: { display: false, labels: { boxWidth: 10, boxHeight: 10, color: COLORS.ink, font: { size: 12 } } },
        tooltip: { backgroundColor: '#2A1F24', padding: 10, cornerRadius: 6, titleFont: { weight: '600' }, displayColors: true, boxPadding: 4 }
      },
      scales: {
        x: { grid: { display: false }, ticks: { color: '#8C7B82', font: { size: 11 }, maxRotation: 0, autoSkip: true, autoSkipPadding: 12 }, border: { color: '#E6D8DE' } },
        y: { beginAtZero: true, grid: { color: COLORS.grid }, ticks: { color: '#8C7B82', font: { size: 11 }, precision: 0 }, border: { display: false } }
      },
      ...extra
    };
  }
  const barDs = (label, data, color) => ({ label, data, backgroundColor: color, borderRadius: 4, borderSkipped: 'start', maxBarThickness: 26, categoryPercentage: 0.8, barPercentage: 0.9 });
  const lineDs = (label, data, color) => ({ label, data, borderColor: color, backgroundColor: color, borderWidth: 2, pointRadius: 0, pointHoverRadius: 4, pointHitRadius: 12, tension: 0 });
  const dayLabel = d => new Date(d + 'T00:00:00').toLocaleDateString('en-IN', { day: 'numeric', month: 'short' });

  function hoursCharts(hours, idA, idB) {
    const labels = Array.from({ length: 24 }, (_, h) => hourLabel(h));
    chart($('#' + idA), { type: 'bar', data: { labels, datasets: [barDs('Customer messages', hours.messages, COLORS.pink)] }, options: baseOptions() });
    chart($('#' + idB), { type: 'bar', data: { labels, datasets: [barDs('Payments', hours.payments, COLORS.blue)] }, options: baseOptions() });
  }
  function bestHourText(arr) {
    const max = Math.max(...arr);
    if (!max) return 'No data yet.';
    const top = arr.map((n, h) => [n, h]).sort((a, b) => b[0] - a[0]).slice(0, 3).filter(x => x[0] > 0).map(x => hourLabel(x[1]));
    return 'Busiest: ' + top.join(', ');
  }

  function funnelHtml(f) {
    const steps = [
      ['Chatted', f.chatted], ['Shared their problem', f.shared_problem], ['Asked the price', f.asked_price],
      ['Gave birth details', f.gave_details], ['Got an invoice', f.got_invoice], ['Paid', f.paid]
    ];
    const top = steps[0][1] || 0;
    if (!top) return '<div class="empty">Nobody chatted in this period.</div>';
    let biggest = null;
    for (let i = 1; i < steps.length; i++) {
      const lostN = Math.max(0, steps[i - 1][1] - steps[i][1]);
      if (!biggest || lostN > biggest.n) biggest = { n: lostN, at: steps[i][0], from: steps[i - 1][0] };
    }
    return '<div class="funnel">' + steps.map(([label, n], i) => {
      return `<div class="fstep"><span>${esc(label)}</span><div class="fbar" title="${num(n)} people"><i style="width:${Math.max(1, (n / top) * 100)}%"></i></div>
        <span class="num"><b>${num(n)}</b> <span class="muted small">${i ? pct(n, top) : ''}</span></span></div>`;
    }).join('') + '</div>' +
      (biggest && biggest.n ? `<p class="small muted" style="margin:12px 0 0">Percent of everyone who chatted. Biggest fall: from <b>${esc(biggest.from.toLowerCase())}</b> to <b>${esc(biggest.at.toLowerCase())}</b> (${plural(biggest.n, 'person', 'people')}). Steps are counted separately, so a later step can be higher.</p>` : '');
  }

  const statusBadge = r => {
    const s = r.status;
    if (s === 'paid') return '<span class="badge paid">Paid</span>';
    if (s === 'request_created') return r.upi_claimed_at ? '<span class="badge pink">UPI sent, check</span>' : '<span class="badge open">Unpaid</span>';
    if (s === 'expired') return r.upi_claimed_at ? '<span class="badge pink">UPI sent, check</span>' : '<span class="badge lost">Expired</span>';
    if (String(s).startsWith('gateway_test')) return '<span class="badge">Test</span>';
    if (s === 'cancelled') return '<span class="badge">Cancelled</span>';
    if (s === 'delivery_failed') return '<span class="badge lost">Not delivered</span>';
    if (s === 'discount10_offered') return '<span class="badge lost">Discount offered</span>';
    return `<span class="badge">${esc(s)}</span>`;
  };
  const isReport = r => r.delivery_kind === 'delivered';

  function invoiceActions(r) {
    const id = esc(r.payment_link_id);
    let h = `<button class="btn small" data-pdf="${id}" data-kind="invoice">Invoice PDF</button>`;
    if (r.status === 'paid' || r.status === 'gateway_test_paid') h += `<button class="btn small" data-pdf="${id}" data-kind="receipt">Receipt PDF</button>`;
    if (isReport(r) && (r.status === 'request_created' || r.status === 'expired')) h += `<button class="btn small ok" data-upi="${id}">Confirm UPI</button>`;
    if (isReport(r) && r.status === 'paid') {
      h += r.report_delivered_at
        ? `<button class="btn small" data-delivered="${id}" data-value="false" title="Delivered ${esc(dateTime(r.report_delivered_at))}">Delivered. Undo</button>`
        : `<button class="btn small ok" data-delivered="${id}" data-value="true">Mark report delivered</button>`;
    }
    return h;
  }

  // Invoice buttons work the same everywhere (invoice list, chat side panel).
  function bindInvoiceActions(root, after) {
    $$('[data-pdf]', root).forEach(b => b.addEventListener('click', () => openPdf(b.dataset.pdf, b.dataset.kind)));
    $$('[data-upi]', root).forEach(b => b.addEventListener('click', async () => {
      if (b.dataset.armed !== '1') {
        b.dataset.armed = '1';
        b.textContent = 'Yes, I received it';
        b.classList.add('primary');
        setTimeout(() => { if (b.isConnected && b.dataset.armed === '1') { b.dataset.armed = ''; b.textContent = 'Confirm UPI'; b.classList.remove('primary'); } }, 6000);
        return;
      }
      b.disabled = true;
      b.textContent = 'Confirming...';
      try {
        const r = await api('/dash/api/invoices/' + encodeURIComponent(b.dataset.upi) + '/confirm-upi', { method: 'POST' });
        toast(r.message || 'Done');
      } catch (e) { toast(e.data?.message || e.message, true); }
      after && after();
    }));
    $$('[data-delivered]', root).forEach(b => b.addEventListener('click', async () => {
      b.disabled = true;
      try {
        await api('/dash/api/invoices/' + encodeURIComponent(b.dataset.delivered) + '/delivered', { method: 'POST', body: { delivered: b.dataset.value === 'true' } });
        toast(b.dataset.value === 'true' ? 'Marked as delivered' : 'Marked as not delivered');
      } catch (e) { toast(e.message, true); }
      after && after();
    }));
  }

  async function openPdf(id, kind) {
    // Open the tab first (inside the click) so phones do not block it, then fill it.
    const w = window.open('', '_blank');
    try {
      const res = await api('/dash/api/invoices/' + encodeURIComponent(id) + '/pdf?kind=' + kind, { raw: true });
      const blob = await res.blob();
      const url = URL.createObjectURL(blob);
      if (w) w.location.href = url;
      else {
        const a = document.createElement('a');
        a.href = url; a.download = (kind === 'receipt' ? 'Receipt' : 'Invoice') + '.pdf';
        document.body.appendChild(a); a.click(); a.remove();
      }
      setTimeout(() => URL.revokeObjectURL(url), 60000);
    } catch (e) {
      if (w) w.close();
      toast(e.message, true);
    }
  }

  const personLink = (phone, name, extra = '') => `<a href="#/inbox/${encodeURIComponent(phone)}">${esc(name || phoneText(phone))}</a>${extra}`;

  function peopleList(rows, empty) {
    if (!rows.length) return `<div class="empty">${esc(empty)}</div>`;
    return '<ul class="list">' + rows.map(p => `<li>
      <span class="avatar">${esc(initials(p.name, p.phone))}</span>
      <div class="grow"><div class="t">${personLink(p.phone, p.name)}</div>
        <div class="s">${esc(p.last_text ? (p.last_role === 'user' ? '' : (p.last_sender === 'owner' ? 'You: ' : 'Kamala: ')) + p.last_text : (p.pain_point || ''))}</div></div>
      <span class="small muted">${esc(ago(p.last_at || p.last_inbound_at))}</span></li>`).join('') + '</ul>';
  }

  // ---------- Overview ----------
  async function viewOverview(_a, _p, quiet) {
    const main = $('#main');
    if (!quiet) main.innerHTML = `<div class="head"><div><h1>Overview</h1><div class="sub">Loading...</div></div>${rangeSeg()}</div><div class="loading">Loading numbers...</div>`;
    bindRange(() => viewOverview());
    let s, ins, unpaid, noInvoice;
    try {
      [s, ins, unpaid, noInvoice] = await Promise.all([
        api('/dash/api/summary?range=' + state.range),
        api('/dash/api/insights?range=' + state.range),
        api('/dash/api/people?filter=invoiced_unpaid&limit=8'),
        api('/dash/api/people?filter=chatting_no_invoice&limit=8')
      ]);
    } catch (e) {
      if (state.view === 'overview') main.innerHTML = `<div class="head"><h1>Overview</h1>${rangeSeg()}</div><p class="error">${esc(e.message)}</p>`;
      bindRange(() => viewOverview());
      return;
    }
    if (state.view !== 'overview') return;
    destroyCharts();
    const t = s.totals;
    const m = ins.morning;
    const istHour = Number(fmt(new Date(), { hour: 'numeric', hour12: false }));
    const greet = istHour < 12 ? 'Good morning' : istHour < 17 ? 'Good afternoon' : 'Good evening';
    const today = state.range === 'today';

    const consults = m.consults_today.length
      ? '<ul class="list">' + m.consults_today.map(c => `<li><b class="num">${esc(timeOnly(c.appointment_start))}</b><div class="grow"><div class="t">${personLink(c.phone, c.name)}</div><div class="s">${esc(c.service_name)}</div></div>${c.meet_link ? `<a class="btn small" href="${esc(c.meet_link)}" target="_blank" rel="noopener">Meet link</a>` : ''}</li>`).join('') + '</ul>'
      : '<div class="small muted" style="margin-top:10px">No consultations booked for today.</div>';
    const hot = m.hot_leads.length
      ? '<h3 style="margin-top:14px">Hot leads (ready to buy)</h3><ul class="list">' + m.hot_leads.map(p => `<li><div class="grow"><div class="t">${personLink(p.phone, p.name)}</div><div class="s">${esc(p.lead_stage || '')}</div></div><span class="badge pink">Score ${num(p.lead_score)}</span></li>`).join('') + '</ul>'
      : '';
    const g = ins.goal;
    const goalPct = g.target_paise ? Math.min(100, Math.round((g.today_paise / g.target_paise) * 100)) : 0;

    $('#main').innerHTML = `
      <div class="head"><div><h1>Overview</h1><div class="sub">Updated ${esc(timeOnly(new Date()))}. Live.</div></div>${rangeSeg()}</div>

      <div class="brief">
        <section class="card">
          <h2>${greet}. Here is what needs you today</h2>
          <p class="desc">Counts are live and include everything still open.</p>
          <div class="brief-items">
            <a class="brief-item ${m.consults_today.length ? 'hot' : ''}" href="#/overview"><b>${num(m.consults_today.length)}</b><span>Consultations today</span></a>
            <a class="brief-item ${m.reports_to_deliver ? 'hot' : ''}" href="#/invoices?f=report_to_deliver"><b>${num(m.reports_to_deliver)}</b><span>Reports to deliver</span></a>
            <a class="brief-item ${m.upi_to_check ? 'hot' : ''}" href="#/invoices?f=upi_to_check"><b>${num(m.upi_to_check)}</b><span>UPI payments to check</span></a>
            <a class="brief-item" href="#/invoices?f=unpaid"><b>${num(m.unpaid_yesterday)}</b><span>Unpaid invoices from yesterday</span></a>
            <a class="brief-item ${m.hot_leads.length ? 'hot' : ''}" href="#/inbox"><b>${num(m.hot_leads.length)}</b><span>Hot leads</span></a>
            <a class="brief-item" href="#/inbox?f=paused"><b>${num(m.paused_chats)}</b><span>Chats where Kamala is paused</span></a>
          </div>
          ${consults}${hot}
        </section>
        <section class="card" id="goalCard">
          <h2>Daily goal</h2>
          <p class="desc">Money received today (IST) against your target.</p>
          ${g.target_paise ? `
            <div class="goal-row"><span class="big">${money(g.today_paise)}</span><span class="muted">of ${money(g.target_paise)} (${goalPct}%)</span></div>
            <div class="goal-bar" role="progressbar" aria-valuenow="${goalPct}" aria-valuemin="0" aria-valuemax="100"><i style="width:${goalPct}%"></i></div>
            <div class="small muted">${g.today_paise >= g.target_paise ? 'Goal reached for today.' : money(g.target_paise - g.today_paise) + ' to go.'}</div>` :
            `<div class="goal-row"><span class="big">${money(g.today_paise)}</span><span class="muted">received today</span></div>
             <p class="small muted">Set a target to see progress here.</p>`}
          <form id="goalForm" class="row" style="display:flex;gap:8px;margin-top:12px">
            <input type="number" min="0" step="100" inputmode="numeric" id="goalIn" placeholder="Target in rupees" value="${g.target_paise ? Math.round(g.target_paise / 100) : ''}" aria-label="Daily goal in rupees">
            <button class="btn" type="submit">Save</button>
          </form>
        </section>
      </div>

      <div class="kpis section">
        <div class="kpi lead"><div class="label">People chatting</div><div class="value">${num(t.people_chatting)}</div><div class="foot">${num(t.chatting_not_paid)} have never paid</div></div>
        <div class="kpi lead"><div class="label">New people</div><div class="value">${num(t.people_new)}</div><div class="foot">${num(t.people_total)} people in total</div></div>
        <div class="kpi"><div class="label">Messages</div><div class="value">${num(t.messages)}</div><div class="foot">${plural(t.paused_chats, 'chat', 'chats')} paused</div></div>
        <div class="kpi"><div class="label">Invoices sent</div><div class="value">${num(t.invoices)}</div><div class="foot">${money(t.invoiced_paise)} to ${plural(t.people_invoiced, 'person', 'people')}</div></div>
        <div class="kpi"><div class="label">Payments</div><div class="value">${num(t.payments)}</div><div class="foot">${plural(t.people_paid, 'person', 'people')} paid</div></div>
        <div class="kpi"><div class="label">Revenue</div><div class="value">${money(t.revenue_paise)}</div><div class="foot">${plural(t.open_invoices, 'open invoice', 'open invoices')}, ${money(t.open_paise)}</div></div>
      </div>

      <div class="grid g2 section">
        ${today ? `
        <section class="card"><h2>Customer messages by hour, today</h2><p class="desc">IST. ${esc(bestHourText(ins.hours.messages))}</p><div class="chart-box"><canvas id="cA" aria-label="Customer messages by hour"></canvas></div></section>
        <section class="card"><h2>Payments by hour, today</h2><p class="desc">IST. ${esc(bestHourText(ins.hours.payments))}</p><div class="chart-box"><canvas id="cB" aria-label="Payments by hour"></canvas></div></section>` : `
        <section class="card"><h2>Revenue by day</h2><p class="desc">Money received each day (IST).</p><div class="chart-box"><canvas id="cA" aria-label="Revenue by day"></canvas></div></section>
        <section class="card"><h2>Activity by day</h2><p class="desc">People chatting, invoices sent and payments each day.</p><div class="chart-box"><canvas id="cB" aria-label="Activity by day"></canvas></div></section>`}
      </div>

      <div class="grid g2 section">
        <section class="card"><h2>By service</h2><p class="desc">Revenue from each service ${esc(rangeWords())}. Hover for invoices and payments.</p><div class="chart-box" id="svcBox"><canvas id="cC" aria-label="Revenue by service"></canvas></div></section>
        <section class="card"><h2>Lead stages</h2><p class="desc">Where every person stands now.</p><div class="chart-box"><canvas id="cD" aria-label="People by lead stage"></canvas></div></section>
      </div>

      <div class="grid g2 section">
        <section class="card"><h2>Where people drop off</h2><p class="desc">People who chatted ${esc(rangeWords())}, step by step.</p>${funnelHtml(ins.funnel)}</section>
        <section class="card"><h2>Money lost</h2><p class="desc">Invoices ${esc(rangeWords())} that ran out or sat unpaid over 12 hours, with no later payment.</p>
          <div class="goal-row"><span class="big" style="color:var(--bad)">${money(ins.lost.paise)}</span><span class="muted">${plural(ins.lost.count, 'invoice', 'invoices')}</span></div>
          ${lostList(ins.lost.invoices.slice(0, 4))}
          <a class="btn small" href="#/insights" style="margin-top:10px">See all insights</a></section>
      </div>

      ${today ? '' : `<div class="grid g2 section">
        <section class="card"><h2>Best hours for messages</h2><p class="desc">IST. ${esc(bestHourText(ins.hours.messages))}</p><div class="chart-box short"><canvas id="cE"></canvas></div></section>
        <section class="card"><h2>Best hours for payments</h2><p class="desc">IST. ${esc(bestHourText(ins.hours.payments))}</p><div class="chart-box short"><canvas id="cF"></canvas></div></section>
      </div>`}

      <div class="grid g2 section">
        <section class="card"><h2>Got an invoice, did not pay</h2><p class="desc">${plural(unpaid.total, 'person', 'people')}, latest first.</p>${peopleList(unpaid.people, 'Nobody right now.')}
          ${unpaid.total > 8 ? '<a class="btn small" href="#/inbox?f=invoiced_unpaid">See all</a>' : ''}</section>
        <section class="card"><h2>Chatting, no invoice yet</h2><p class="desc">${plural(noInvoice.total, 'person', 'people')}, latest first.</p>${peopleList(noInvoice.people, 'Nobody right now.')}
          ${noInvoice.total > 8 ? '<a class="btn small" href="#/inbox?f=chatting_no_invoice">See all</a>' : ''}</section>
      </div>`;

    bindRange(() => viewOverview());
    $('#goalForm').addEventListener('submit', async e => {
      e.preventDefault();
      const v = $('#goalIn').value.trim();
      try {
        await api('/dash/api/settings', { method: 'POST', body: { dailyGoalRupees: v === '' ? 0 : Number(v) } });
        toast('Daily goal saved');
        viewOverview(null, null, true);
      } catch (err) { toast(err.message, true); }
    });

    if (today) {
      hoursCharts(ins.hours, 'cA', 'cB');
    } else {
      const labels = s.daily.map(d => dayLabel(d.day));
      chart($('#cA'), {
        type: 'bar', data: { labels, datasets: [barDs('Revenue', s.daily.map(d => Number(d.revenue_paise) / 100), COLORS.pink)] },
        options: (() => { const o = baseOptions(); o.plugins.tooltip.callbacks = { label: c => ' Revenue: ' + money(c.raw * 100) }; o.scales.y.ticks.callback = v => '\u20B9' + Number(v).toLocaleString('en-IN'); return o; })()
      });
      const o = baseOptions();
      o.plugins.legend.display = true;
      o.plugins.legend.position = 'top';
      o.plugins.legend.align = 'start';
      chart($('#cB'), {
        type: 'line',
        data: { labels, datasets: [lineDs('People chatting', s.daily.map(d => d.chatting), COLORS.pink), lineDs('Invoices', s.daily.map(d => d.invoices), COLORS.blue), lineDs('Payments', s.daily.map(d => d.payments), COLORS.amber)] },
        options: o
      });
      hoursCharts(ins.hours, 'cE', 'cF');
    }
    const svc = s.services.slice(0, 8);
    if (svc.length) {
      $('#svcBox').style.height = Math.max(170, svc.length * 34 + 40) + 'px';
      const so = baseOptions({ indexAxis: 'y' });
      so.scales.x = { beginAtZero: true, grid: { color: COLORS.grid }, ticks: { color: '#8C7B82', font: { size: 11 }, callback: v => '₹' + Number(v).toLocaleString('en-IN') }, border: { display: false } };
      so.scales.y = { grid: { display: false }, ticks: { color: COLORS.ink, font: { size: 12 } }, border: { color: '#E6D8DE' } };
      so.plugins.tooltip.callbacks = { label: c => { const r = svc[c.dataIndex]; return [' Revenue: ' + money(r.revenue_paise), ' Invoices: ' + num(r.invoices) + ', paid: ' + num(r.paid)]; } };
      chart($('#cC'), { type: 'bar', data: { labels: svc.map(r => r.service), datasets: [barDs('Revenue', svc.map(r => Number(r.revenue_paise) / 100), COLORS.pink)] }, options: so });
    } else {
      $('#svcBox').innerHTML = '<div class="empty">No invoices in this period.</div>';
    }
    const st = s.stages;
    const sto = baseOptions({ indexAxis: 'y' });
    sto.scales.x = { beginAtZero: true, grid: { color: COLORS.grid }, ticks: { color: '#8C7B82', precision: 0, font: { size: 11 } }, border: { display: false } };
    sto.scales.y = { grid: { display: false }, ticks: { color: COLORS.ink, font: { size: 12 } }, border: { color: '#E6D8DE' } };
    chart($('#cD'), { type: 'bar', data: { labels: st.map(r => r.stage), datasets: [barDs('People', st.map(r => r.people), COLORS.blue)] }, options: sto });
  }

  function lostList(rows) {
    if (!rows.length) return '<div class="empty">Nothing lost in this period.</div>';
    return '<ul class="list">' + rows.map(r => `<li><div class="grow"><div class="t">${personLink(r.phone, r.name)}</div>
      <div class="s">${esc(r.service_name)}, ${esc(dateTime(r.created_at))}</div></div>
      <b class="num">${money(r.amount_paise)}</b>
      ${r.window_open ? `<a class="btn small" href="#/inbox/${encodeURIComponent(r.phone)}">Follow up</a>` : `<a class="btn small" href="tel:${esc(phoneText(r.phone))}">Call</a>`}</li>`).join('') + '</ul>';
  }

  // ---------- Insights ----------
  async function viewInsights(_a, _p, quiet) {
    const main = $('#main');
    if (!quiet) main.innerHTML = `<div class="head"><div><h1>Insights</h1></div>${rangeSeg()}</div><div class="loading">Loading...</div>`;
    bindRange(() => viewInsights());
    let ins, tags;
    try {
      [ins, tags] = await Promise.all([api('/dash/api/insights?range=' + state.range), api('/dash/api/tags')]);
    } catch (e) {
      if (state.view === 'insights') main.innerHTML = `<div class="head"><h1>Insights</h1>${rangeSeg()}</div><p class="error">${esc(e.message)}</p>`;
      bindRange(() => viewInsights());
      return;
    }
    if (state.view !== 'insights') return;
    destroyCharts();
    const r = ins.response;
    const d = ins.delivery;
    const quietList = (rows, empty) => rows.length ? '<ul class="list">' + rows.map(x => `<li><div class="grow"><div class="t">${personLink(x.phone, x.name, x.paused ? ' <span class="badge open">Paused</span>' : '')}</div>
      <div class="s">${esc(x.text)}</div></div><span class="small muted">${esc(ago(x.at))}</span></li>`).join('') + '</ul>' : `<div class="empty">${esc(empty)}</div>`;

    main.innerHTML = `
      <div class="head"><div><h1>Insights</h1><div class="sub">What to fix and who to follow up, ${esc(rangeWords())}.</div></div>${rangeSeg()}</div>

      <div class="grid g2">
        <section class="card"><h2>Money lost</h2><p class="desc">Invoices that ran out or sat unpaid over 12 hours, where the person did not pay later for the same service. Follow up while WhatsApp's 24-hour window is open; otherwise call.</p>
          <div class="goal-row"><span class="big" style="color:var(--bad)">${money(ins.lost.paise)}</span><span class="muted">${plural(ins.lost.count, 'invoice', 'invoices')}</span></div>
          ${lostList(ins.lost.invoices)}</section>
        <section class="card"><h2>Where people drop off</h2><p class="desc">People who chatted, step by step.</p>${funnelHtml(ins.funnel)}</section>
      </div>

      <section class="card section"><h2>Lead sources that pay</h2><p class="desc">New people ${esc(rangeWords())} by where they first came from.</p>
        ${ins.sources.length ? `<div class="tbl-wrap"><table><thead><tr><th>Source</th><th class="r">People</th><th class="r">Got invoice</th><th class="r">Paid</th><th class="r">Pay rate</th><th class="r">Revenue</th></tr></thead><tbody>
        ${ins.sources.map(x => `<tr><td>${esc(x.source)}</td><td class="r">${num(x.people)}</td><td class="r">${num(x.invoiced)}</td><td class="r">${num(x.paid)}</td><td class="r">${pct(x.paid, x.people)}</td><td class="r">${money(x.revenue_paise)}</td></tr>`).join('')}
        </tbody></table></div>` : '<div class="empty">No new people in this period.</div>'}</section>

      <div class="grid g2 section">
        <section class="card"><h2>Waiting for a reply</h2><p class="desc">The customer wrote last and nobody answered for over 10 minutes (${plural(r.unreplied, 'chat', 'chats')}). Paused chats need you.</p>${quietList(r.unreplied_list, 'Every customer has an answer.')}</section>
        <section class="card"><h2>Went quiet after a question</h2><p class="desc">Kamala asked something and the customer has not answered in over 24 hours (${num(r.went_quiet)} of ${num(r.chats)} chats).</p>${quietList(r.went_quiet_list, 'Nobody went quiet.')}</section>
      </div>

      <div class="grid g2 section">
        <section class="card"><h2>Best hours for messages</h2><p class="desc">IST. ${esc(bestHourText(ins.hours.messages))}</p><div class="chart-box short"><canvas id="iA"></canvas></div></section>
        <section class="card"><h2>Best hours for payments</h2><p class="desc">IST. ${esc(bestHourText(ins.hours.payments))}</p><div class="chart-box short"><canvas id="iB"></canvas></div></section>
      </div>

      <div class="grid g2 section">
        <section class="card"><h2>Repeat customers</h2><p class="desc">People who paid two times or more (all time).</p>
          ${ins.repeat.customers.length ? `<div class="tbl-wrap"><table><thead><tr><th>Person</th><th class="r">Purchases</th><th class="r">Paid</th><th class="r">Last paid</th></tr></thead><tbody>
          ${ins.repeat.customers.map(x => `<tr><td>${personLink(x.phone, x.name)}</td><td class="r">${num(x.purchases)}</td><td class="r">${money(x.paid_paise)}</td><td class="r">${esc(fmt(x.last_paid_at, { day: 'numeric', month: 'short' }))}</td></tr>`).join('')}
          </tbody></table></div>` : '<div class="empty">No repeat customers yet.</div>'}</section>
        <section class="card"><h2>Bought a report, never a consultation</h2><p class="desc">Good people to offer a live consultation (all time).</p>
          ${ins.repeat.report_only.length ? '<ul class="list">' + ins.repeat.report_only.map(x => `<li><div class="grow"><div class="t">${personLink(x.phone, x.name)}</div><div class="s">${esc(x.reports)}</div></div>
            ${x.window_open ? `<a class="btn small" href="#/inbox/${encodeURIComponent(x.phone)}">Message</a>` : `<a class="btn small" href="tel:${esc(phoneText(x.phone))}">Call</a>`}</li>`).join('') + '</ul>' : '<div class="empty">Nobody yet.</div>'}</section>
      </div>

      <div class="grid g2 section">
        <section class="card"><h2>Report delivery time</h2><p class="desc">From payment to marking the report delivered, for reports paid ${esc(rangeWords())}.</p>
          <div class="kpis" style="grid-template-columns:repeat(2,minmax(0,1fr))">
            <div class="kpi"><div class="label">Average time</div><div class="value">${d.avg_hours == null ? '-' : esc(d.avg_hours) + 'h'}</div><div class="foot">${num(d.delivered)} delivered</div></div>
            <div class="kpi"><div class="label">Still to deliver</div><div class="value" style="${d.pending ? 'color:var(--bad)' : ''}">${num(d.pending)}</div><div class="foot">${d.oldest_pending_hours == null ? 'None waiting' : 'Oldest waiting ' + esc(d.oldest_pending_hours) + 'h'}</div></div>
          </div>
          <a class="btn small" style="margin-top:12px" href="#/invoices?f=report_to_deliver">Open reports to deliver</a></section>
        <section class="card"><h2>Your tags</h2><p class="desc">Tags you add to people in Chats. Tap one to see those people.</p>
          ${tags.tags.length ? '<div class="chips">' + tags.tags.map(x => `<a class="chip" href="#/inbox?tag=${encodeURIComponent(x.tag)}">${esc(x.tag)}<span class="n">${num(x.people)}</span></a>`).join('') + '</div>' : '<div class="empty">No tags yet. Open a chat and add tags in the side panel.</div>'}</section>
      </div>`;
    bindRange(() => viewInsights());
    hoursCharts(ins.hours, 'iA', 'iB');
  }

  // ---------- Chats (inbox) ----------
  const PEOPLE_FILTERS = [['all', 'All'], ['customers', 'Paid'], ['invoiced_unpaid', 'Invoice unpaid'], ['chatting_no_invoice', 'No invoice'], ['paused', 'Paused'], ['upi_to_check', 'UPI to check']];

  async function viewInbox(arg, params, same) {
    const ib = state.inbox;
    $('#inboxDot').hidden = true;
    if (params && params.get('f') && PEOPLE_FILTERS.some(f => f[0] === params.get('f'))) ib.filter = params.get('f');
    if (params && params.has('tag')) ib.tag = params.get('tag');
    if (!same || !$('#inbox')) {
      $('#main').innerHTML = `
        <div class="inbox no-detail" id="inbox">
          <div class="pane people">
            <div class="people-top">
              <input type="search" id="q" placeholder="Search name, number or email" value="${esc(ib.q)}" aria-label="Search people">
              <div class="chips" id="pf">${PEOPLE_FILTERS.map(([k, l]) => `<button type="button" class="chip ${ib.filter === k ? 'on' : ''}" data-f="${k}">${l}</button>`).join('')}</div>
              <select id="tagSel" aria-label="Filter by tag"><option value="">All tags</option></select>
            </div>
            <div class="people-list" id="plist"><div class="empty" style="padding:14px">Loading...</div></div>
          </div>
          <div class="pane chat" id="chatPane"><div class="no-chat">Choose a chat on the left.</div></div>
          <aside class="pane detail" id="detail"></aside>
        </div>`;
      let qt;
      $('#q').addEventListener('input', () => { clearTimeout(qt); qt = setTimeout(() => { ib.q = $('#q').value.trim(); loadPeople(); }, 300); });
      $$('#pf [data-f]').forEach(b => b.addEventListener('click', () => {
        ib.filter = b.dataset.f;
        $$('#pf [data-f]').forEach(x => x.classList.toggle('on', x === b));
        loadPeople();
      }));
      $('#tagSel').addEventListener('change', () => { ib.tag = $('#tagSel').value; loadPeople(); });
      loadTags();
      await loadPeople();
    } else {
      $$('#pf [data-f]').forEach(x => x.classList.toggle('on', x.dataset.f === ib.filter));
    }
    const sel = arg ? String(arg).replace(/\D/g, '') : null;
    if (sel && sel !== ib.selected) openChat(sel);
    if (!sel) {
      ib.selected = null;
      $('#inbox').classList.remove('open-chat', 'show-detail');
      $('#inbox').classList.add('no-detail');
      $('#chatPane').innerHTML = '<div class="no-chat">Choose a chat on the left.</div>';
      $('#detail').innerHTML = '';
      markSelected();
    }
  }

  async function loadTags() {
    try {
      const r = await api('/dash/api/tags');
      const sel = $('#tagSel');
      if (!sel) return;
      const ib = state.inbox;
      sel.innerHTML = '<option value="">All tags</option>' + r.tags.map(t => `<option value="${esc(t.tag)}" ${ib.tag === t.tag ? 'selected' : ''}>${esc(t.tag)} (${num(t.people)})</option>`).join('');
      if (ib.tag && !r.tags.some(t => t.tag === ib.tag)) sel.insertAdjacentHTML('beforeend', `<option value="${esc(ib.tag)}" selected>${esc(ib.tag)}</option>`);
    } catch (e) { /* tags are optional */ }
  }

  async function loadPeople(quiet) {
    const ib = state.inbox;
    const list = $('#plist');
    if (!list) return;
    const qs = new URLSearchParams({ filter: ib.filter, limit: '100' });
    if (ib.q) qs.set('q', ib.q);
    if (ib.tag) qs.set('tag', ib.tag);
    try {
      const r = await api('/dash/api/people?' + qs);
      ib.people = r.people;
      if (!$('#plist')) return;
      $('#plist').innerHTML = r.people.length ? r.people.map(p => {
        const last = p.last_text ? (p.last_role === 'user' ? '' : p.last_sender === 'owner' ? 'You: ' : 'Kamala: ') + p.last_text : '';
        return `<button type="button" class="person ${ib.selected === p.phone ? 'on' : ''}" data-phone="${esc(p.phone)}">
          <span class="avatar">${esc(initials(p.name, p.phone))}</span>
          <span style="min-width:0"><span class="name">${esc(p.name || phoneText(p.phone))}</span>
            <span class="last" style="display:block">${esc(last)}</span>
            ${p.paid_count > 0 ? '<span class="badge paid">Paid</span> ' : p.open_invoices > 0 ? '<span class="badge open">Invoice open</span> ' : ''}${p.is_paused ? '<span class="badge open">Paused</span> ' : ''}${p.upi_pending > 0 ? '<span class="badge pink">UPI to check</span> ' : ''}${(p.tags || '').split(',').filter(Boolean).slice(0, 3).map(t => `<span class="tag">${esc(t)}</span>`).join('')}
          </span>
          <span class="when">${esc(ago(p.last_at))}${ib.unread.has(p.phone) ? '<i class="unread"></i>' : ''}</span>
        </button>`;
      }).join('') + (r.total > r.people.length ? `<div class="empty" style="padding:12px">Showing ${num(r.people.length)} of ${num(r.total)}. Search to find others.</div>` : '')
        : '<div class="empty" style="padding:14px">Nobody here.</div>';
      $$('#plist .person').forEach(b => b.addEventListener('click', () => { location.hash = '#/inbox/' + encodeURIComponent(b.dataset.phone); }));
    } catch (e) {
      if (!quiet && $('#plist')) $('#plist').innerHTML = `<p class="error" style="padding:12px">${esc(e.message)}</p>`;
    }
  }
  function markSelected() {
    $$('#plist .person').forEach(b => b.classList.toggle('on', b.dataset.phone === state.inbox.selected));
  }

  async function openChat(phone) {
    const ib = state.inbox;
    ib.selected = phone;
    ib.messages = [];
    ib.person = null;
    ib.unread.delete(phone);
    markSelected();
    const inbox = $('#inbox');
    inbox.classList.add('open-chat');
    inbox.classList.remove('no-detail', 'show-detail');
    $('#chatPane').innerHTML = '<div class="no-chat">Loading chat...</div>';
    $('#detail').innerHTML = '';
    try {
      const [msgs] = await Promise.all([api('/dash/api/chats/' + phone + '/messages?limit=100'), loadDetail(phone)]);
      if (ib.selected !== phone) return;
      ib.messages = msgs.messages;
      ib.more = msgs.more;
      renderChat();
    } catch (e) {
      if (ib.selected === phone) $('#chatPane').innerHTML = `<div class="no-chat"><p class="error">${esc(e.message)}</p></div>`;
    }
  }

  async function loadDetail(phone) {
    const ib = state.inbox;
    const r = await api('/dash/api/people/' + phone);
    if (ib.selected !== phone) return;
    ib.person = r.person;
    ib.invoices = r.invoices;
    renderDetail();
    if (ib.messages.length || $('#msgs')) renderChatHead();
  }

  function renderChat() {
    const ib = state.inbox;
    const p = ib.person || { phone: ib.selected };
    $('#chatPane').innerHTML = `
      <div class="chat-head" id="chatHead"></div>
      <div class="msgs" id="msgs"></div>
      <div class="composer" id="composer"></div>`;
    renderChatHead();
    renderMessages(true);
    renderComposer(p);
  }

  function renderChatHead() {
    const ib = state.inbox;
    const head = $('#chatHead');
    if (!head) return;
    const p = ib.person || { phone: ib.selected };
    head.innerHTML = `
      <button class="btn small back" type="button" id="backBtn" aria-label="Back to chats">Back</button>
      <span class="avatar">${esc(initials(p.name, p.phone))}</span>
      <div class="who"><b>${esc(p.name || phoneText(p.phone))}</b>
        <span>${p.name ? esc(phoneText(p.phone)) + ' &middot; ' : ''}${p.window_open ? 'Can message now' : 'Window closed (call)'}</span></div>
      <label class="switch" title="When paused, Kamala does not reply to this person"><input type="checkbox" id="pauseSw" ${p.is_paused ? 'checked' : ''}> Kamala paused</label>
      <button class="btn small" type="button" id="detailBtn">Details</button>`;
    $('#backBtn').addEventListener('click', () => { location.hash = '#/inbox'; });
    $('#detailBtn').addEventListener('click', () => {
      const inbox = $('#inbox');
      if (window.matchMedia('(max-width: 1280px)').matches) inbox.classList.toggle('show-detail');
      else inbox.classList.toggle('no-detail');
    });
    $('#pauseSw').addEventListener('change', async e => {
      const want = e.target.checked;
      try {
        await api('/dash/api/chats/' + ib.selected + '/pause', { method: 'POST', body: { paused: want } });
        if (ib.person) ib.person.is_paused = want;
        toast(want ? 'Kamala is paused for this chat. You reply.' : 'Kamala is replying again.');
      } catch (err) { e.target.checked = !want; toast(err.message, true); }
    });
  }

  function bubbleHtml(m) {
    const who = m.sender === 'owner' ? 'owner' : m.role === 'user' ? 'customer' : 'kamala';
    const by = who === 'owner' ? 'You' : who === 'kamala' ? 'Kamala' : '';
    return `<div class="bubble ${who}" data-id="${esc(m.id)}">${esc(m.text)}<div class="meta">${by ? `<span class="by">${by}</span>` : ''}${esc(timeOnly(m.created_at))}</div></div>`;
  }

  function renderMessages(scrollEnd) {
    const ib = state.inbox;
    const box = $('#msgs');
    if (!box) return;
    const nearEnd = box.scrollHeight - box.scrollTop - box.clientHeight < 120;
    let html = ib.more ? '<button class="btn small" type="button" id="olderBtn" style="align-self:center">Load earlier messages</button>' : '';
    let lastDay = null;
    for (const m of ib.messages) {
      const k = dayKey(m.created_at);
      if (k !== lastDay) { html += `<div class="day-sep">${esc(fmt(m.created_at, { weekday: 'short', day: 'numeric', month: 'short', year: 'numeric' }))}</div>`; lastDay = k; }
      html += bubbleHtml(m);
    }
    if (!ib.messages.length) html += '<div class="no-chat">No messages saved yet.</div>';
    box.innerHTML = html;
    if (scrollEnd || nearEnd) box.scrollTop = box.scrollHeight;
    const older = $('#olderBtn');
    if (older) older.addEventListener('click', loadOlder);
  }

  async function loadOlder() {
    const ib = state.inbox;
    const phone = ib.selected;
    if (!ib.messages.length) return;
    const box = $('#msgs');
    const before = box.scrollHeight;
    try {
      const r = await api('/dash/api/chats/' + phone + '/messages?limit=100&before=' + ib.messages[0].id);
      if (ib.selected !== phone) return;
      ib.messages = r.messages.concat(ib.messages);
      ib.more = r.more;
      renderMessages(false);
      box.scrollTop = box.scrollHeight - before;
    } catch (e) { toast(e.message, true); }
  }

  function mergeMessages(list) {
    const ib = state.inbox;
    const have = new Set(ib.messages.map(m => String(m.id)));
    const add = list.filter(m => !have.has(String(m.id)));
    if (!add.length) return;
    ib.messages = ib.messages.concat(add).sort((a, b) => Number(a.id) - Number(b.id));
    renderMessages(false);
    // A new customer message reopens WhatsApp's 24-hour window.
    if (add.some(m => m.role === 'user') && ib.person && !ib.person.window_open) {
      ib.person.window_open = true;
      renderChatHead();
      renderComposer(ib.person);
    }
  }

  function renderComposer(p) {
    const box = $('#composer');
    if (!box) return;
    if (!p.window_open) {
      box.innerHTML = `<div class="closed-note"><span>WhatsApp's 24-hour window is closed. They have not written in the last 24 hours, so a normal message will not be delivered.</span>
        <a class="btn primary" href="tel:${esc(phoneText(p.phone))}">Call ${esc(phoneText(p.phone))}</a></div>`;
      return;
    }
    box.innerHTML = `
      <div class="row"><textarea id="msgIn" rows="2" maxlength="4000" placeholder="Reply as Veshannastro (Kamala keeps replying too)" aria-label="Your message"></textarea>
      <button class="btn primary" type="button" id="sendBtn">Send</button></div>
      <div class="small muted">Sent from the business number. Ctrl or Cmd + Enter sends.</div>`;
    const input = $('#msgIn');
    const send = async () => {
      const text = input.value.trim();
      if (!text) return;
      const phone = state.inbox.selected;
      const btn = $('#sendBtn');
      btn.disabled = true;
      try {
        await api('/dash/api/chats/' + phone + '/send', { method: 'POST', body: { text } });
        if (state.inbox.selected === phone) {
          input.value = '';
          const r = await api('/dash/api/chats/' + phone + '/messages?limit=20');
          if (state.inbox.selected === phone) mergeMessages(r.messages);
          const box2 = $('#msgs');
          if (box2) box2.scrollTop = box2.scrollHeight;
        }
      } catch (e) {
        toast(e.message, true);
        if (e.status === 409) loadDetail(phone).then(() => renderComposer(state.inbox.person)).catch(() => {});
      } finally {
        btn.disabled = false;
      }
    };
    $('#sendBtn').addEventListener('click', send);
    input.addEventListener('keydown', e => { if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) { e.preventDefault(); send(); } });
  }

  function renderDetail() {
    const ib = state.inbox;
    const p = ib.person;
    const d = $('#detail');
    if (!d || !p) return;
    const birth = [p.dob, p.tob, p.pob].filter(Boolean).join(', ');
    const kv = [
      ['Phone', phoneText(p.phone)], ['Email', p.email], ['Birth', birth], ['Gender', p.gender], ['Concern', p.pain_point],
      ['Stage', p.lead_stage], ['Score', p.lead_score], ['Source', p.first_source], ['First chat', dateTime(p.first_contact)],
      ['Last message', dateTime(p.last_inbound_at)], ['Messages', p.message_count]
    ].filter(([, v]) => v !== null && v !== undefined && v !== '');
    d.innerHTML = `
      <div style="display:flex;justify-content:space-between;align-items:center;gap:8px"><h2>${esc(p.name || 'Customer')}</h2>
        <button class="btn small" type="button" id="closeDetail">Close</button></div>
      <dl class="kv">${kv.map(([k, v]) => `<dt>${esc(k)}</dt><dd>${esc(v)}</dd>`).join('')}</dl>
      <a class="btn" href="tel:${esc(phoneText(p.phone))}">Call ${esc(phoneText(p.phone))}</a>
      <form id="notesForm" style="display:grid;gap:6px">
        <label for="notesIn">Your notes (only you see these)</label>
        <textarea id="notesIn" rows="4" maxlength="4000">${esc(p.owner_notes || '')}</textarea>
        <label for="tagsIn">Tags, separated by commas</label>
        <input type="text" id="tagsIn" value="${esc((p.tags || '').split(',').filter(Boolean).join(', '))}" placeholder="e.g. vip, follow up, marriage">
        <button class="btn" type="submit">Save notes</button>
      </form>
      <div><h3 style="margin-bottom:8px">Invoices</h3>
        ${ib.invoices.length ? ib.invoices.map(r => `<div class="inv">
          <div class="top"><b>${esc(r.service_name)}</b><span class="num">${money(r.amount_paise)}</span></div>
          <div class="small muted">${esc(r.invoice_number || '')} &middot; ${esc(dateTime(r.created_at))} ${isReport(r) ? '&middot; Report' : r.appointment_start ? '&middot; ' + esc(dateTime(r.appointment_start)) : ''}</div>
          <div>${statusBadge(r)}${r.paid_by === 'upi_manual' ? ' <span class="badge blue">UPI</span>' : ''}${isReport(r) && r.status === 'paid' ? (r.report_delivered_at ? ' <span class="badge paid">Report delivered</span>' : ' <span class="badge open">Report to deliver</span>') : ''}</div>
          <div class="acts">${invoiceActions(r)}</div></div>`).join('') : '<div class="empty">No invoices.</div>'}
      </div>`;
    $('#closeDetail').addEventListener('click', () => {
      const inbox = $('#inbox');
      inbox.classList.remove('show-detail');
      if (!window.matchMedia('(max-width: 1280px)').matches) inbox.classList.add('no-detail');
    });
    $('#notesForm').addEventListener('submit', async e => {
      e.preventDefault();
      try {
        const r = await api('/dash/api/people/' + p.phone + '/notes', { method: 'POST', body: { notes: $('#notesIn').value, tags: $('#tagsIn').value } });
        p.owner_notes = r.owner_notes;
        p.tags = r.tags;
        $('#tagsIn').value = (r.tags || '').split(',').filter(Boolean).join(', ');
        toast('Notes saved');
        loadTags();
        loadPeople(true);
      } catch (err) { toast(err.message, true); }
    });
    bindInvoiceActions(d, () => loadDetail(p.phone).catch(() => {}));
  }

  // ---------- Invoices ----------
  const INVOICE_FILTERS = [['all', 'All'], ['unpaid', 'Unpaid'], ['paid', 'Paid'], ['upi_to_check', 'UPI to check'], ['report_to_deliver', 'Reports to deliver'], ['lost', 'Lost'], ['closed', 'Closed'], ['test', 'Test']];

  async function viewInvoices(_a, params) {
    const st = state.invoices;
    if (params && params.get('f') && INVOICE_FILTERS.some(f => f[0] === params.get('f'))) st.filter = params.get('f');
    $('#main').innerHTML = `
      <div class="head"><div><h1>Invoices</h1><div class="sub" id="invSub">Every invoice Kamala sent, newest first.</div></div></div>
      <div class="chips" id="if" style="margin-bottom:12px">${INVOICE_FILTERS.map(([k, l]) => `<button type="button" class="chip ${st.filter === k ? 'on' : ''}" data-f="${k}">${l}</button>`).join('')}</div>
      <section class="card"><div id="ilist"><div class="loading">Loading...</div></div></section>`;
    $$('#if [data-f]').forEach(b => b.addEventListener('click', () => {
      st.filter = b.dataset.f;
      $$('#if [data-f]').forEach(x => x.classList.toggle('on', x === b));
      loadInvoices();
    }));
    loadInvoices();
  }

  async function loadInvoices(keep) {
    const st = state.invoices;
    const count = keep ? Math.max(50, st.rows.length) : 50;
    try {
      const r = await api(`/dash/api/invoices?filter=${st.filter}&limit=${Math.min(count, 200)}`);
      st.rows = r.invoices;
      st.total = r.total;
      renderInvoices();
    } catch (e) {
      if ($('#ilist')) $('#ilist').innerHTML = `<p class="error">${esc(e.message)}</p>`;
    }
  }
  async function moreInvoices() {
    const st = state.invoices;
    try {
      const r = await api(`/dash/api/invoices?filter=${st.filter}&limit=50&offset=${st.rows.length}`);
      st.rows = st.rows.concat(r.invoices);
      st.total = r.total;
      renderInvoices();
    } catch (e) { toast(e.message, true); }
  }
  function renderInvoices() {
    const st = state.invoices;
    const box = $('#ilist');
    if (!box || state.view !== 'invoices') return;
    $('#invSub').textContent = `${plural(st.total, 'invoice', 'invoices')}${st.filter === 'all' ? '' : ' in this list'}, newest first.`;
    box.innerHTML = st.rows.length ? st.rows.map(r => `<div class="irow">
        <div><div class="t">${personLink(r.phone, r.name)}</div><div class="s">${esc(phoneText(r.phone))} &middot; ${esc(r.invoice_number || '')}</div></div>
        <div class="c3"><div>${esc(r.service_name)}</div><div class="s">${isReport(r) ? 'Report' : 'Consultation' + (r.appointment_start ? ', ' + esc(dateTime(r.appointment_start)) : '')}</div></div>
        <div class="c4 num"><b>${money(r.amount_paise)}</b></div>
        <div>${statusBadge(r)}${r.paid_by === 'upi_manual' ? ' <span class="badge blue">UPI</span>' : ''}${isReport(r) && r.status === 'paid' ? (r.report_delivered_at ? ' <span class="badge paid">Delivered</span>' : ' <span class="badge open">To deliver</span>') : ''}
          <div class="s">${esc(r.paid_at ? 'Paid ' + dateTime(r.paid_at) : 'Sent ' + dateTime(r.created_at))}</div></div>
        <div class="acts">${invoiceActions(r)}</div></div>`).join('') + (st.rows.length < st.total ? '<div style="text-align:center;padding-top:12px"><button class="btn" type="button" id="moreInv">Show more</button></div>' : '')
      : '<div class="empty">No invoices in this list.</div>';
    bindInvoiceActions(box, () => loadInvoices(true));
    const more = $('#moreInv');
    if (more) more.addEventListener('click', moreInvoices);
  }

  // ---------- Alerts ----------
  async function viewAlerts() {
    $('#alertDot').hidden = true;
    const main = $('#main');
    if (!$('#alist')) main.innerHTML = `<div class="head"><div><h1>Alerts</h1><div class="sub">Everything Kamala told you. Urgent ones and payments also go to WhatsApp.</div></div></div>
      <section class="card"><div id="alist"><div class="loading">Loading...</div></div></section>`;
    try {
      const r = await api('/dash/api/alerts?limit=100');
      if (state.view !== 'alerts') return;
      if (r.alerts[0]) { state.alertsSeen = Number(r.alerts[0].id); store.set('kamala_alerts_seen', String(state.alertsSeen)); }
      $('#alist').innerHTML = r.alerts.length ? r.alerts.map(a => `<div class="alert">
        <div class="top"><b>${esc(a.subject || 'Alert')}</b><span class="small muted">${esc(dateTime(a.created_at))}</span></div>
        <div style="margin-top:4px">${a.priority === 'important' ? '<span class="badge pink">Important</span>' : '<span class="badge">Routine</span>'} ${a.whatsapp_sent ? '<span class="badge blue">Also on WhatsApp</span>' : '<span class="badge">Dashboard only</span>'}</div>
        <div class="body">${esc(a.text)}</div></div>`).join('') : '<div class="empty">No alerts yet.</div>';
    } catch (e) {
      if ($('#alist')) $('#alist').innerHTML = `<p class="error">${esc(e.message)}</p>`;
    }
  }
  async function checkAlertDot() {
    try {
      const r = await api('/dash/api/alerts?limit=1');
      if (state.view === 'alerts') return;
      $('#alertDot').hidden = !(r.alerts[0] && Number(r.alerts[0].id) > state.alertsSeen);
    } catch (e) { /* not important */ }
  }

  // ---------- Settings ----------
  async function viewSettings() {
    const main = $('#main');
    main.innerHTML = '<div class="head"><h1>Settings</h1></div><div class="loading">Loading...</div>';
    let me, sync;
    try {
      [me, sync] = await Promise.all([api('/dash/api/me'), api('/dash/api/sheet-sync').catch(e => ({ error: e.message }))]);
    } catch (e) { main.innerHTML = `<div class="head"><h1>Settings</h1></div><p class="error">${esc(e.message)}</p>`; return; }
    if (state.view !== 'settings') return;
    state.me = me;
    const syncHtml = sync.error ? `<p class="error">${esc(sync.error)}</p>` : `
      <dl class="kv"><dt>Messages</dt><dd>${num(sync.messagesCopied)} of ${num(sync.messages)} copied</dd>
      <dt>People</dt><dd>${num(sync.peopleCopied)} of ${num(sync.people)} copied</dd>
      <dt>Status</dt><dd>${sync.complete ? '<span class="badge paid">Up to date</span>' : '<span class="badge open">Copying (a few every minute)</span>'}</dd></dl>`;
    main.innerHTML = `
      <div class="head"><div><h1>Settings</h1><div class="sub">Signed in as the owner (${esc(me.owner)}).</div></div></div>
      <div class="grid g2">
        <section class="card"><h2>WhatsApp alerts</h2><p class="desc">Which alerts also come to your WhatsApp. All alerts are always on the Alerts page.</p>
          <form id="alertForm" style="display:grid;gap:10px">
            <label class="radio"><input type="radio" name="am" value="important" ${me.alertMode !== 'all' ? 'checked' : ''}> Urgent and payments only (recommended)</label>
            <label class="radio"><input type="radio" name="am" value="all" ${me.alertMode === 'all' ? 'checked' : ''}> Every alert</label>
            <div><button class="btn" type="submit">Save</button></div>
          </form></section>
        <section class="card"><h2>Daily goal</h2><p class="desc">Shown on the Overview page. 0 turns it off.</p>
          <form id="goalForm2" style="display:flex;gap:8px"><input type="number" min="0" step="100" inputmode="numeric" id="goal2" value="${esc(me.dailyGoalRupees || '')}" placeholder="Target in rupees" aria-label="Daily goal in rupees"><button class="btn" type="submit">Save</button></form></section>
        <section class="card"><h2>Google Sheet copy</h2><p class="desc">Every chat and person is also written to your Google Sheet.</p>${syncHtml}</section>
        <section class="card"><h2>Sign out</h2><p class="desc">"Everywhere" signs out every phone and laptop (use it if a device is lost). Changing DASHBOARD_PASSWORD in Render does the same.</p>
          <div style="display:flex;gap:8px;flex-wrap:wrap"><button class="btn" type="button" id="signOut">Sign out here</button><button class="btn warn" type="button" id="signOutAll">Sign out everywhere</button></div></section>
      </div>`;
    $('#alertForm').addEventListener('submit', async e => {
      e.preventDefault();
      const v = ($$('input[name=am]').find(x => x.checked) || {}).value;
      try { await api('/dash/api/settings', { method: 'POST', body: { alertMode: v } }); toast('Saved'); } catch (err) { toast(err.message, true); }
    });
    $('#goalForm2').addEventListener('submit', async e => {
      e.preventDefault();
      const v = $('#goal2').value.trim();
      try { await api('/dash/api/settings', { method: 'POST', body: { dailyGoalRupees: v === '' ? 0 : Number(v) } }); toast('Daily goal saved'); } catch (err) { toast(err.message, true); }
    });
    $('#signOut').addEventListener('click', () => { signedOut(' '); });
    $('#signOutAll').addEventListener('click', async e => {
      const b = e.currentTarget;
      if (b.dataset.armed !== '1') { b.dataset.armed = '1'; b.textContent = 'Yes, sign out every device'; return; }
      try { await api('/dash/api/logout-everywhere', { method: 'POST' }); signedOut('Signed out on every device.'); } catch (err) { toast(err.message, true); }
    });
  }

  // ---------- boot ----------
  if (window.Chart) {
    window.Chart.defaults.font.family = getComputedStyle(document.body).fontFamily;
    window.Chart.defaults.color = COLORS.ink;
  }
  if (state.token) start(); else showLogin('');
})();
