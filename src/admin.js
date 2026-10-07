// 后台运维台前端：纯原生 JS，2 秒轮询 /api/admin/*，只做实时观测与有限干预
const $ = (id) => document.getElementById(id);
const api = new URLSearchParams(location.search).get('key');
let key = api || localStorage.getItem('qadmin-key') || '';
if (api) localStorage.setItem('qadmin-key', api);

let paused = false;
let selCode = '';
const logs = [];

const esc = (s) => String(s == null ? '' : s).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
const ago = (s) => (s < 60 ? s + '秒' : s < 3600 ? Math.floor(s / 60) + '分' : Math.floor(s / 3600) + '时' + Math.floor((s % 3600) / 60) + '分');
const PH = { 大厅: 'lobby', 起步: 'mid', 比赛中: 'race', 结算: 'mid' };

async function call(path, opts = {}) {
  const q = key ? (path.includes('?') ? '&' : '?') + 'key=' + encodeURIComponent(key) : '';
  const r = await fetch(path + q, opts);
  if (r.status === 401) { showLogin(false); throw new Error('口令不正确'); }
  if (r.status === 404) throw new Error((await r.json().catch(() => ({}))).error || '接口不存在');
  if (!r.ok) throw new Error('HTTP ' + r.status);
  return r.json();
}

function showLogin(wrong) {
  $('login').classList.remove('hidden');
  $('keyerr').classList.toggle('hidden', !wrong);
  $('key').focus();
}

$('enter').onclick = () => {
  key = $('key').value.trim();
  if (!key) return;
  localStorage.setItem('qadmin-key', key);
  // 走一次带 key 的地址：服务器校验通过就种下 Cookie，之后地址栏干净
  call('/api/admin/overview').then(() => { location.replace('/admin?key=' + encodeURIComponent(key)); })
    .catch(() => showLogin(true));
};
$('key').onkeydown = (e) => { if (e.key === 'Enter') $('enter').click(); };
$('refresh').onclick = () => tick(true);
$('pause').onclick = () => {
  paused = !paused;
  $('pause').textContent = paused ? '继续' : '暂停';
  $('hb').className = 'dot' + (paused ? ' bad' : '');
  if (!paused) tick();
};

function log(msg) {
  logs.unshift(`${new Date().toLocaleTimeString('zh-CN', { hour12: false })} ${msg}`);
  if (logs.length > 40) logs.pop();
  $('log').innerHTML = logs.map((l) => `<div>${esc(l)}</div>`).join('');
}

function kpi(label, value, sub, alert) {
  return `<div class="kpi${alert ? ' alert' : ''}"><div class="l">${label}</div><div class="v">${value}</div><div class="s">${sub || ''}</div></div>`;
}

function phaseTag(p) {
  const name = { 0: '大厅', 1: '起步', 2: '比赛中', 3: '结算' }[p] || '其他';
  return `<span class="tag ${PH[name] || ''}">${name}</span>`;
}

function renderOverview(o) {
  $('uptime').textContent = o ? ago(o.server.uptime_s) : '-';
  if (!o) return;
  $('kpis').innerHTML = [
    kpi('房间', o.rooms.total, `${o.players.listed_rooms} 个可加入`),
    kpi('席位', o.players.seats, `剩余 ${o.rooms.open_slots > 0 ? o.rooms.open_slots : 0} 个车位`),
    kpi('在线', o.players.online, `电脑 ${o.players.bots} 台`),
    kpi('断线待回线', o.players.ghost, o.players.ghost ? '宽限期内可重连' : '无', o.players.ghost > 0),
    kpi('连接数', o.net.connections, o.net.connections < o.players.online ? '少于在线人数，异常' : '与健康'),
    kpi('平均延迟', o.net.avg_rtt + 'ms', o.net.avg_rtt > 180 ? '偏高' : '良好', o.net.avg_rtt > 180),
    kpi('丢弃输入', o.net.dropped_inputs, '累计', o.net.dropped_inputs > 50),
  ].join('');
  const max = Math.max(1, ...o.maps.map((m) => m.rooms));
  $('maps').innerHTML = o.maps.map((m) =>
    `<div class="maprow"><span>${esc(m.name)}</span><span class="bar"><i style="width:${(m.rooms / max * 100).toFixed(0)}%"></i></span><span class="n">${m.rooms}</span></div>`).join('');
}

function renderRooms(list) {
  $('rcount').textContent = list.length;
  $('rnote').textContent = list.length ? `车位共 ${list.length * 6}，在座 ${list.reduce((a, r) => a + r.players, 0)}` : '';
  if (!list.length) { $('rooms').innerHTML = '<tr><td colspan="8" class="empty">当前没有房间，玩家进「在线对战」创建即可</td></tr>'; return; }
  $('rooms').innerHTML = list.map((r) => `<tr class="${r.code === selCode ? 'sel' : ''}">
    <td><span class="code" data-code="${esc(r.code)}">${esc(r.code)}</span></td>
    <td>${esc(r.mapName)}</td>
    <td>${phaseTag(r.phase)}${r.listed ? ' <span class="tag race">可加入</span>' : r.phase === 0 ? ' <span class="tag off">已满</span>' : ''}</td>
    <td class="n">${r.online}<span style="color:var(--muted)">/${r.players}·${r.cap}</span></td>
    <td class="n">${r.laps}</td>
    <td><span class="tag ${r.mode ? 'mid' : ''}">${r.mode ? '道具' : '竞速'}</span></td>
    <td class="n">${ago(r.created_ago)}</td>
    <td style="white-space:nowrap">
      ${r.phase === 0 ? `<button class="tiny" data-act="start" data-code="${esc(r.code)}">开赛</button>
      <button class="tiny" data-act="bot" data-code="${esc(r.code)}">+电脑</button>` : ''}
      <button class="tiny warn" data-act="close" data-code="${esc(r.code)}">关闭</button>
    </td></tr>`).join('');
}

function speedBar(c) {
  return `<span class="rowbar"><span class="bar" style="flex:1"><i style="width:${Math.min(100, c.speed / 45).toFixed(0)}%"></i></span>${(c.speed * 3.6).toFixed(0)}</span>`;
}

function renderDetail(d) {
  if (!d) { $('cars').innerHTML = '<tr><td colspan="10" class="empty">点左侧房间码查看每辆车实况</td></tr>'; return; }
  $('dcode').textContent = d.code + ' · ' + d.mapName;
  $('dnote').textContent = d.error || '';
  const cars = [...(d.cars || [])].sort((a, b) => (a.place || 99) - (b.place || 99));
  if (!cars.length) { $('cars').innerHTML = '<tr><td colspan="10" class="empty">房间暂无车辆</td></tr>'; return; }
  $('cars').innerHTML = cars.map((c) => `<tr>
    <td class="n">${c.place || '-'}</td>
    <td>${esc(c.name)} ${c.bot ? '<span class="tag bot">电脑</span>' : ''}
      ${c.online ? '' : c.ghost_left != null ? `<span class="tag off">掉线 ${c.ghost_left}s</span>` : '<span class="tag off">离线</span>'}
      ${c.auto ? '<span class="tag mid">托管</span>' : ''}
      ${c.finished ? '<span class="tag race">完赛</span>' : ''}</td>
    <td class="n">${speedBar(c)}</td>
    <td class="n">${(c.progress / 10).toFixed(0)}%</td>
    <td class="n">${Math.min(c.lap, d.laps)}/${d.laps}</td>
    <td class="n">${c.best_lap != null ? c.best_lap.toFixed(2) : '-'}</td>
    <td class="n">${c.rtt != null ? c.rtt + 'ms' : '-'}</td>
    <td class="n">${c.pending}</td>
    <td class="n">${c.dropped}</td>
    <td style="white-space:nowrap">${c.seat_token ? `<button class="tiny warn" data-act="kick" data-code="${esc(d.code)}" data-token="${esc(c.seat_token)}">请离</button>` : ''}</td>
  </tr>`).join('');
}

async function tick(manual) {
  if (paused && !manual) return;
  try {
    const [o, r] = await Promise.all([call('/api/admin/overview'), call('/api/admin/rooms')]);
    renderOverview(o);
    renderRooms(r.rooms);
    $('hb').className = 'dot';
    $('hbtext').textContent = '服务正常';
    if (selCode) renderDetail(await call('/api/admin/rooms/' + selCode));
  } catch (e) {
    $('hb').className = 'dot bad';
    $('hbtext').textContent = '已断开';
    if (String(e.message) !== '口令不正确') log('刷新失败：' + e.message);
  }
}

async function act(code, action, token) {
  const tips = { close: `关闭房间 ${code}？在场玩家会立刻掉线。`, start: `强制开始 ${code}？未准备的玩家也会被放进去。`, bot: `给 ${code} 补一台电脑。`, kick: `请离 ${code} 的这个席位？` };
  if (!confirm(tips[action] || '确认操作？')) return;
  try {
    const body = token ? JSON.stringify({ token }) : '{}';
    await call(`/api/admin/rooms/${code}/${action}`, {
      method: 'POST', headers: { 'content-type': 'application/json' }, body,
    });
    log(`${action} · ${code} 完成`);
    await tick(true);
  } catch (e) {
    log(`${action} ${code} 失败：${e.message}`);
    alert('操作失败：' + e.message);
  }
}

document.addEventListener('click', (e) => {
  const el = e.target.closest('[data-act],[data-code]');
  if (!el) return;
  if (el.dataset.act) { act(el.dataset.code, el.dataset.act, el.dataset.token); return; }
  selCode = el.dataset.code === selCode ? '' : el.dataset.code;
  log(selCode ? '查看房间 ' + selCode : '取消查看');
  tick(true);
});

(async () => {
  // 先看 Cookie 是否已经有效（/admin?key= 会种下 Cookie 并跳回 /admin），无效才要口令
  try { await call('/api/admin/overview'); $('login').classList.add('hidden'); }
  catch { showLogin(false); return; }
  tick();
  setInterval(tick, 2000);
})();
