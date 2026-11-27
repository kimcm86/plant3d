/* PLANT 3D — ISO 도면 치수 숫자 자동 읽기 (키 없이, 브라우저 안에서)
   CAD에서 뽑은 PDF는 글자가 '짧은 선'으로 그려져 있음 → 짧은 획만 골라 그린 뒤
   아이소 방향(30°/150°/90°)과 기울임을 바로잡아 OCR(tesseract)로 숫자를 읽는다. */
(function () {
  'use strict';
  const LOCAL = !!window.P3D_LOCAL;
  const BASE = LOCAL ? 'vendor/tess/' : null;
  const CDN = {
    lib: 'https://cdn.jsdelivr.net/npm/tesseract.js@5.1.1/dist/tesseract.min.js',
    worker: 'https://cdn.jsdelivr.net/npm/tesseract.js@5.1.1/dist/worker.min.js',
    core: 'https://cdn.jsdelivr.net/npm/tesseract.js-core@5.1.1',
    lang: 'https://cdn.jsdelivr.net/npm/@tesseract.js-data/eng@1.0.0/4.0.0_best_int'
  };
  let worker = null, loading = null;

  function loadScript(src) {
    return new Promise((res, rej) => { const s = document.createElement('script'); s.src = src; s.onload = res; s.onerror = () => rej(new Error('불러오기 실패: ' + src)); document.head.appendChild(s); });
  }
  async function getWorker(onMsg) {
    if (worker) return worker;
    if (loading) return loading;
    loading = (async () => {
      if (!window.Tesseract) await loadScript(LOCAL ? BASE + 'tesseract.min.js' : CDN.lib);
      const opt = LOCAL
        ? { workerPath: BASE + 'worker.min.js', corePath: BASE, langPath: BASE + 'lang' }
        : { workerPath: CDN.worker, corePath: CDN.core, langPath: CDN.lang };
      if (onMsg) opt.logger = m => { if (m && m.status) onMsg(m); };
      const w = await window.Tesseract.createWorker('eng', 1, opt);
      await w.setParameters({ tessedit_char_whitelist: '0123456789', tessedit_pageseg_mode: '11' });
      worker = w; return w;
    })();
    try { return await loading; } finally { loading = null; }
  }

  function segDist(m, p, q) { const dx = q[0] - p[0], dy = q[1] - p[1], L2 = dx * dx + dy * dy || 1; let t = ((m[0] - p[0]) * dx + (m[1] - p[1]) * dy) / L2; t = Math.max(0, Math.min(1, t)); return Math.hypot(m[0] - p[0] - t * dx, m[1] - p[1] - t * dy); }
  // 회전(도)·기울임 조합: 아이소 글자는 축 방향으로 눕고 30° 기울어져 있음
  const VARS = [[-30, -0.577], [30, 0.577], [0, 0], [90, -0.577], [-90, 0.577], [-30, 0.577], [30, -0.577]];

  /* segs: [[a,b],...] 페이지 좌표(pt). region: [x0,y0,x1,y1] (생략하면 전체) */
  async function readNumbers(segs, page, opts) {
    opts = opts || {};
    const prog = opts.progress || (() => {});
    const MAXL = opts.maxStroke || 8, NEAR = opts.nearDist || 60;
    let T = segs.filter(q => !q.isFill).filter(([a, b]) => Math.hypot(b[0] - a[0], b[1] - a[1]) < MAXL);
    // 배관 선 가까이에 있는 글자만 (BOM 표·표제란 글자는 빼서 빠르고 덜 헷갈리게)
    if (opts.near && opts.near.length) T = T.filter(([a, b]) => { const m = [(a[0] + b[0]) / 2, (a[1] + b[1]) / 2]; return opts.near.some(([p, q]) => segDist(m, p, q) < NEAR); });
    if (!T.length) return [];
    let rg = opts.region;
    if (!rg) { const xs = T.flatMap(([a, b]) => [a[0], b[0]]), ys = T.flatMap(([a, b]) => [a[1], b[1]]); rg = [Math.min(...xs) - 10, Math.min(...ys) - 10, Math.max(...xs) + 10, Math.max(...ys) + 10]; }
    // 캔버스 크기 제한 (휴대폰 한도 ~16M 픽셀) 안에서 최대한 크게
    const d1 = Math.hypot(rg[2] - rg[0], rg[3] - rg[1]);
    const K = opts.scale || Math.max(2.5, Math.min(5, Math.sqrt(14e6 / (d1 * d1 * 1.6))));
    prog('치수 읽기 준비 중…');
    const w = await getWorker(); await w.setParameters({ tessedit_char_whitelist: '0123456789', tessedit_pageseg_mode: '11' });
    const cx = (rg[0] + rg[2]) / 2, cy = (rg[1] + rg[3]) / 2, RW = (rg[2] - rg[0]) * K, RH = (rg[3] - rg[1]) * K;
    const out = [];
    for (let vi = 0; vi < VARS.length; vi++) {
      const [deg, sh] = VARS[vi];
      prog('도면 치수 읽는 중… (' + (vi + 1) + '/' + VARS.length + ')');
      const th = deg * Math.PI / 180, c = Math.cos(th), s = Math.sin(th);
      // 페이지(pt) → 이미지(px): 중심 기준 회전(+deg = 반시계) 후 기울임(x += sh*y)
      const D = Math.ceil(Math.hypot(RW, RH)), CW = Math.ceil(D + Math.abs(sh) * D), CH = D;
      const fwd = (x, y) => { const X = (x - cx) * K, Y = (y - cy) * K; const rx = X * c + Y * s, ry = -X * s + Y * c; return [rx + sh * ry + CW / 2, ry + CH / 2]; };
      const inv = (u, v) => { const ry = v - CH / 2, rx = u - CW / 2 - sh * ry; const X = rx * c - ry * s, Y = rx * s + ry * c; return [X / K + cx, Y / K + cy]; };
      const cv = document.createElement('canvas'); cv.width = CW; cv.height = CH;
      const g = cv.getContext('2d'); g.fillStyle = '#fff'; g.fillRect(0, 0, CW, CH); g.strokeStyle = '#000'; g.lineWidth = Math.max(2, K * 0.55); g.lineCap = 'round';
      g.beginPath(); T.forEach(([a, b]) => { const p = fwd(a[0], a[1]), q = fwd(b[0], b[1]); g.moveTo(p[0], p[1]); g.lineTo(q[0], q[1]); }); g.stroke();
      let r;
      try { r = await w.recognize(cv); } catch (e) { continue; }
      (r.data.words || []).forEach(wd => {
        const t = (wd.text || '').trim(); if (!/^[1-9]\d{1,4}$/.test(t) || wd.confidence < 55) return;
        const b = wd.bbox, m = inv((b.x0 + b.x1) / 2, (b.y0 + b.y1) / 2), e = inv(b.x1, (b.y0 + b.y1) / 2), st = inv(b.x0, (b.y0 + b.y1) / 2);
        let ang = Math.atan2(e[1] - st[1], e[0] - st[0]) * 180 / Math.PI;
        const hgt = (b.y1 - b.y0) / K;
        if (hgt < 1.2 || hgt > 12) return;
        out.push({ v: +t, txt: t, c: Math.round(wd.confidence), p: m, ang, h: hgt, var: vi });
      });
    }
    // 같은 자리 중복은 확신이 가장 큰 것만
    out.sort((a, b) => b.c - a.c);
    const keep = [];
    out.forEach(n => { if (!keep.some(k => Math.hypot(k.p[0] - n.p[0], k.p[1] - n.p[1]) < Math.max(4, n.h * 1.2))) keep.push(n); });
    prog('');
    keep.K = K;
    return keep;
  }

  /* 경로 구간(이전 점 → 이 점)마다 가장 알맞은 치수를 하나씩 붙임 */
  function assign(route, nums) {
    const used = new Set(), cands = [];
    route.runs.forEach((r, ri) => r.steps.forEach((s, si) => {
      const p0 = si === 0 ? r._p0 : r.steps[si - 1]._p, p1 = s._p; if (!p0 || !p1) return;
      const L = Math.hypot(p1[0] - p0[0], p1[1] - p0[1]); if (L < 2) return;
      const u = [(p1[0] - p0[0]) / L, (p1[1] - p0[1]) / L], sa = Math.atan2(u[1], u[0]) * 180 / Math.PI;
      nums.forEach((n, ni) => {
        let da = Math.abs(((n.ang - sa) % 180 + 180) % 180); da = Math.min(da, 180 - da);
        if (da > 18) return;                                  // 글자 방향이 배관 방향과 같아야 함
        const v = [n.p[0] - p0[0], n.p[1] - p0[1]], t = (v[0] * u[0] + v[1] * u[1]) / L, d = Math.abs(v[0] * u[1] - v[1] * u[0]);
        if (t < -0.25 || t > 1.25 || d > 45) return;
        const sc = d + Math.abs(t - 0.5) * L * 0.35 + da * 0.4 - n.c * 0.05;
        cands.push({ ri, si, ni, sc });
      });
    }));
    cands.sort((a, b) => a.sc - b.sc);
    const done = new Set();
    cands.forEach(c => {
      const key = c.ri + ':' + c.si; if (done.has(key) || used.has(c.ni)) return;
      done.add(key); used.add(c.ni);
      const n = nums[c.ni], s = route.runs[c.ri].steps[c.si];
      // 값이 다른 후보가 거의 비슷한 자리에 있으면 '헷갈림' 표시 → 사용자에게 확인
      const alt = cands.find(o => o.ri === c.ri && o.si === c.si && o.ni !== c.ni && nums[o.ni].v !== n.v && !used.has(o.ni));
      s.ocr = { v: n.v, c: n.c, p: n.p, h: n.h, amb: !!(alt && alt.sc - c.sc < 8) };
    });
    return done.size;
  }

  /* ---------- 글자 단어 읽기 (BOM·표제란 — 똑바로 선 글자) ---------- */
  const isText = ([a, b]) => Math.hypot(b[0] - a[0], b[1] - a[1]) < 8;
  async function setP(w, wl, psm) { await w.setParameters({ tessedit_char_whitelist: wl || '', tessedit_pageseg_mode: String(psm || 11) }); }
  function drawUp(T, rg, K, pad) {
    pad = pad == null ? 4 : pad;
    const cv = document.createElement('canvas'); cv.width = Math.ceil((rg[2] - rg[0]) * K + pad * 2); cv.height = Math.ceil((rg[3] - rg[1]) * K + pad * 2);
    const g = cv.getContext('2d'); g.fillStyle = '#fff'; g.fillRect(0, 0, cv.width, cv.height); g.strokeStyle = '#000'; g.lineWidth = Math.max(1.6, K * 0.5); g.lineCap = 'round';
    g.beginPath(); T.forEach(([a, b]) => { g.moveTo((a[0] - rg[0]) * K + pad, (a[1] - rg[1]) * K + pad); g.lineTo((b[0] - rg[0]) * K + pad, (b[1] - rg[1]) * K + pad); }); g.stroke();
    return { cv, inv: (u, v) => [(u - pad) / K + rg[0], (v - pad) / K + rg[1]] };
  }
  const inRect = (q, r) => { const [a, b] = q; return Math.min(a[0], b[0]) >= r[0] - 0.2 && Math.max(a[0], b[0]) <= r[2] + 0.2 && Math.min(a[1], b[1]) >= r[1] - 0.2 && Math.max(a[1], b[1]) <= r[3] + 0.2; };
  // 페이지 전체 똑바른 글자 → 단어(페이지 좌표)
  async function readWords(segs, page, opts) {
    opts = opts || {};
    const T = segs.filter(q => !q.isFill && isText(q)); if (!T.length) return [];
    const w = await getWorker(); await setP(w, '', 11);
    const K = Math.min(4, Math.sqrt(12e6 / (page.W * page.H)));
    const { cv, inv } = drawUp(T, [0, 0, page.W, page.H], K, 0);
    const r = await w.recognize(cv);
    await setP(w, '0123456789', 11);
    return (r.data.words || []).filter(x => (x.text || '').trim()).map(x => { const a = inv(x.bbox.x0, x.bbox.y0), b = inv(x.bbox.x1, x.bbox.y1); return { t: x.text.trim(), c: Math.round(x.confidence), x0: a[0], y0: a[1], x1: b[0], y1: b[1], cx: (a[0] + b[0]) / 2, cy: (a[1] + b[1]) / 2 }; });
  }
  // 칸 하나만 크게 다시 읽기
  async function readCell(segs, rect, wl, K) {
    const T = segs.filter(q => !q.isFill && isText(q) && inRect(q, [rect[0] + 0.4, rect[1] + 0.4, rect[2] - 0.4, rect[3] - 0.4]));
    if (!T.length) return { t: '', c: 0, n: 0 };
    const xs = T.flatMap(([a, b]) => [a[0], b[0]]), ys = T.flatMap(([a, b]) => [a[1], b[1]]);
    const { cv } = drawUp(T, [Math.min(...xs) - 1, Math.min(...ys) - 1, Math.max(...xs) + 1, Math.max(...ys) + 1], K || 9, 14);
    const w = await getWorker(); await setP(w, wl || '', 7);
    const r = await w.recognize(cv);
    await setP(w, '0123456789', 11);
    return { t: (r.data.text || '').replace(/\s+/g, ' ').trim(), c: Math.round(r.data.confidence || 0), n: T.length };
  }
  // 한 열(column)을 통째로 크게 그려 한 번에 읽고, 줄(row)마다 나눔
  async function readColumn(segs, x0, x1, ys, wl, K, lw, psm) {
    const y0 = ys[0], y1 = ys[ys.length - 1];
    const T = segs.filter(q => !q.isFill && isText(q) && inRect(q, [x0 + 0.4, y0 + 0.4, x1 - 0.4, y1 - 0.4]));
    const out = ys.slice(1).map(() => ({ t: '', c: 0 }));
    if (!T.length) return out;
    K = K || 10;
    const cv = document.createElement('canvas'); const pad = 20; cv.width = Math.ceil((x1 - x0) * K + pad * 2); cv.height = Math.ceil((y1 - y0) * K + pad * 2);
    const g = cv.getContext('2d'); g.fillStyle = '#fff'; g.fillRect(0, 0, cv.width, cv.height); g.strokeStyle = '#000'; g.lineWidth = lw || Math.max(1.6, K * 0.45); g.lineCap = 'round';
    g.beginPath(); T.forEach(([a, b]) => { g.moveTo((a[0] - x0) * K + pad, (a[1] - y0) * K + pad); g.lineTo((b[0] - x0) * K + pad, (b[1] - y0) * K + pad); }); g.stroke();
    const w = await getWorker(); await setP(w, wl || '', psm || 11);
    const r = await w.recognize(cv);
    await setP(w, '0123456789', 11);
    (r.data.lines || []).forEach(ln => { const cy = ((ln.bbox.y0 + ln.bbox.y1) / 2 - pad) / K + y0; const i = ys.findIndex((y, k) => k > 0 && cy > ys[k - 1] && cy < y) - 1; if (i < 0) return;
      const t = (ln.text || '').replace(/\s+/g, ' ').trim(); if (!t) return; out[i] = { t: out[i].t ? out[i].t + ' ' + t : t, c: Math.round(ln.confidence) }; });
    return out;
  }
  function gridOf(segs) {
    const H = [], V = [];
    segs.forEach(q => { if (q.isFill) return; const [a, b] = q; const L = Math.hypot(b[0] - a[0], b[1] - a[1]); if (L < 6) return;
      if (Math.abs(a[1] - b[1]) < 0.3) H.push({ y: (a[1] + b[1]) / 2, x0: Math.min(a[0], b[0]), x1: Math.max(a[0], b[0]) });
      else if (Math.abs(a[0] - b[0]) < 0.3) V.push({ x: (a[0] + b[0]) / 2, y0: Math.min(a[1], b[1]), y1: Math.max(a[1], b[1]) }); });
    return { H, V };
  }
  // 점(x,y)을 둘러싼 칸
  function cellAt(G, x, y) {
    const l = G.V.filter(v => v.x < x && v.y0 <= y + 0.5 && v.y1 >= y - 0.5).reduce((m, v) => Math.max(m, v.x), -1e9);
    const r = G.V.filter(v => v.x > x && v.y0 <= y + 0.5 && v.y1 >= y - 0.5).reduce((m, v) => Math.min(m, v.x), 1e9);
    const t = G.H.filter(h => h.y < y && h.x0 <= x + 0.5 && h.x1 >= x - 0.5).reduce((m, h) => Math.max(m, h.y), -1e9);
    const b = G.H.filter(h => h.y > y && h.x0 <= x + 0.5 && h.x1 >= x - 0.5).reduce((m, h) => Math.min(m, h.y), 1e9);
    return [l, t, r, b];
  }
  const fixTxt = t => t.replace(/[‘’`´]/g, "'").replace(/[“”]/g, '"');

  /* ---------- 도면 BOM 표 ---------- */
  function catOf(code, desc) {
    const c = (code || '').toUpperCase().replace(/[^A-Z0-9/ ]/g, ''), d = (desc || '').toUpperCase();
    const has = re => re.test(c);
    if (has(/SW?AGE|SWG|^SWE/)) return 'SWAGE NIPPLE';
    if (has(/NIP/)) return 'NIPPLE';
    if (has(/BLIND|BLD/)) return 'BLIND FLANGE';
    if (has(/GAS?K|GSKT/)) return 'GASKET';
    if (has(/BOLT|STUD|BLT/)) return 'STUD/BOLT';
    if (has(/CHEC|CHK/) || (has(/V\/?V|VALVE/) && /CHECK/.test(d))) return 'CHECK V/V';
    if (has(/GATE|GAT|^ATE ?V/)) return 'GATE V/V';
    if (has(/GLOB/)) return 'GLOBE V/V';
    if (has(/BALL/)) return 'BALL V/V';
    if (has(/BUTT|BFLY|B\/F/)) return 'BFLY V/V';
    if (has(/PLUG/)) return 'PLUG V/V';
    if (has(/CONT|CTRL|CV/)) return 'CONTROL V/V';
    if (has(/STRA/)) return 'STRAINER';
    if (has(/RED|CONC|ECC/)) return 'REDUCER';
    if (has(/ELB|EL9|EL4|90|45/)) return 'ELBOW';
    if (has(/TEE/)) return 'TEE';
    if (has(/CAP/)) return 'CAP';
    if (has(/COUP|CPLG/)) return 'COUPLING';
    if (has(/UNION/)) return 'UNION';
    if (has(/OLET/)) return 'OLET';
    if (has(/FLANG|FLG|FLNG/)) return 'FLANGE';
    if (has(/PIPE|PIP/)) return 'PIPE';
    if (has(/V\/?V|VALVE/)) return 'VALVE';
    return '';
  }
  // 3/4" · 1-1/2" · 1 1/2" · 2" → 숫자 (볼트는 앞쪽 지름)
  function sizeNum(t) {
    t = fixTxt(String(t || '')).toUpperCase().replace(/[^0-9/.\- X]/g, ' ').trim(); if (!t) return null;
    const m0 = t.split('X')[0].trim();
    let m = m0.match(/^(\d+)[- ](\d+)\/(\d+)/); if (m) return +m[1] + m[2] / m[3];
    m = m0.match(/^(\d+)\/(\d+)/); if (m && +m[2]) return m[1] / m[2];
    m = m0.match(/^(\d+(?:\.\d+)?)/); if (m) return +m[1];
    return null;
  }
  const NPS = [0.5, 0.75, 1, 1.25, 1.5, 2, 2.5, 3, 4, 5, 6, 8, 10, 12, 14, 16, 18, 20, 24, 26, 28, 30, 32, 36, 42, 48];
  // OCR이 헷갈리는 모양(3/4→3/8·34·38, 1/2→12) 바로잡기
  function npsOf(t, hint) {
    const raw = fixTxt(String(t || '')).toUpperCase().replace(/[^0-9/.\- X"]/g, '').trim(); if (!raw) return null;
    const head = raw.split('X')[0].replace(/"/g, '').trim();
    const fix = { '1/7': 0.5, '1/9': 0.5, '1/0': 0.5, '3/8': 0.75, '34': 0.75, '38': 0.75, '3/48': 0.75, '3/4': 0.75, '12': hint === 12 ? 12 : 0.5, '1/2': 0.5, '1/22': 0.5, '1/27': 0.5, '14': hint === 14 ? 14 : 0.25 };
    if (fix[head] != null) return fix[head];
    const v = sizeNum(head + '"');
    if (v != null && NPS.includes(v)) return v;
    if (v != null) { const m = head.match(/^(\d)\/(\d)/); if (m) { const c = [0.5, 0.75].find(x => Math.abs(x - m[1] / m[2]) < 0.2); if (c) return c; } }
    return v != null && NPS.includes(Math.round(v)) ? Math.round(v) : null;
  }
  async function readBOM(segs, page, words, prog) {
    const W1 = words.map(x => Object.assign({}, x, { u: x.t.toUpperCase().replace(/[^A-Z']/g, '') }));
    const heads = W1.filter(x => x.u === 'CODE' || x.u === 'ITEM' || x.u === 'COMPONENT');
    for (const hd of heads) {
      const sz = W1.find(x => x !== hd && /^SIZE/.test(x.u) && Math.abs(x.cy - hd.cy) < 4 && x.cx > hd.cx);
      if (!sz) continue;
      const qt = W1.find(x => /^Q'?T'?Y|^QTY|^QUAN/.test(x.u) && Math.abs(x.cy - hd.cy) < 4);
      const ds = W1.find(x => /^DESC/.test(x.u) && Math.abs(x.cy - hd.cy) < 4);
      const G = gridOf(segs);
      const cc = cellAt(G, hd.cx, hd.cy), cs = cellAt(G, sz.cx, sz.cy);
      const cq = qt ? cellAt(G, qt.cx, qt.cy) : cellAt(G, cs[2] + 2, hd.cy), cd = ds ? cellAt(G, ds.cx, ds.cy) : null;
      if (![cc, cs, cq].every(c => c.every(v => Math.abs(v) < 1e8))) continue;
      // 머리줄 아래 가로줄
      const x0 = cc[0], x1 = cq[2];
      let ys = [...new Set(G.H.filter(h => h.y > cc[3] - 0.6 && h.x0 <= cc[0] + 1 && h.x1 >= cs[2] - 1).map(h => Math.round(h.y * 4) / 4))].sort((a, b) => a - b);
      ys = ys.filter((y, i) => i === 0 || y - ys[i - 1] > 1.5);
      const hs = []; for (let i = 1; i < ys.length; i++) hs.push(ys[i] - ys[i - 1]);
      const med = hs.slice().sort((a, b) => a - b)[hs.length >> 1] || 9;
      let ye = ys.length; for (let i = 1; i < ys.length; i++) if (ys[i] - ys[i - 1] > med * 1.8) { ye = i; break; }
      ys = ys.slice(0, ye);
      if (prog) prog('도면 BOM 읽는 중…');
      const colS = await readColumn(segs, cs[0], cs[2], ys, '0123456789/"X-. '), colQ = await readColumn(segs, cq[0], cq[2], ys, '0123456789.');
      const rows = []; let blank = 0;
      for (let i = 1; i < ys.length; i++) {
        const t = ys[i - 1], b = ys[i];
        const inC = (x, c) => x.cx > c[0] && x.cx < c[2] && x.cy > t && x.cy < b;
        const codeW = W1.filter(x => inC(x, cc)).sort((p, q) => p.x0 - q.x0).map(x => fixTxt(x.t)).join(' ');
        const descW = cd ? W1.filter(x => inC(x, [cd[0], 0, cd[2]])).sort((p, q) => p.x0 - q.x0).map(x => fixTxt(x.t)).join(' ') : '';
        const hasInk = c => segs.some(q => !q.isFill && isText(q) && inRect(q, [c[0], t, c[2], b]));
        if (!hasInk(cc) && !hasInk(cs)) { if (++blank >= 2) break; continue; }
        blank = 0;
        const code = codeW || (await readCell(segs, [cc[0], t, cc[2], b], '', 8)).t;
        let s1 = colS[i - 1], q1 = colQ[i - 1];
        if (!s1.t && hasInk(cs)) s1 = await readCell(segs, [cs[0], t, cs[2], b], '0123456789/"X-. ', 9);
        if (!q1.t && hasInk(cq)) q1 = await readCell(segs, [cq[0], t, cq[2], b], '0123456789.', 9);
        const cat = catOf(code, descW);
        let size = npsOf(s1.t), size2 = null;
        const st = fixTxt(s1.t).toUpperCase().replace(/[" ]/g, '');
        if (cat === 'STUD/BOLT') { const m = st.match(/^(\d)\/(\d)/) || st.match(/^(\d)/); size = m ? (m[2] ? m[1] / m[2] : +m[1]) : null; }
        else if (cat === 'REDUCER' || /X/.test(st)) { const m = st.match(/^(\d+(?:-\d\/\d|\/\d)?)X?(\d+(?:-\d\/\d|\/\d)?)/); if (m) { size = npsOf(m[1]); size2 = npsOf(m[2]); } }
        rows.push({ code, cat, sizeTxt: s1.t, size, size2, qty: parseFloat(q1.t) || null, desc: descW, c: Math.min(s1.c, q1.c), rect: [x0, t, x1, b] });
      }
      if (rows.length) return { rows, rect: [x0, ys[0], x1, ys[ys.length - 1]] };
    }
    return null;
  }

  /* ---------- 표제란 (라인 번호·장 번호·등급 등) ---------- */
  async function readTitle(segs, words) {
    const G = gridOf(segs), out = {};
    const U = words.map(x => Object.assign({}, x, { u: x.t.toUpperCase() }));
    const valueIn = (lab, re) => {
      const c = cellAt(G, lab.cx, lab.cy); if (!c.every(v => Math.abs(v) < 1e8)) return '';
      let vs = U.filter(x => x !== lab && x.cx > c[0] && x.cx < c[2] && x.cy > c[1] && x.cy < c[3] && !re.test(x.u) && x.x0 > lab.x0 - 1);
      if (!vs.length) { const n = cellAt(G, c[2] + 1.5, lab.cy); if (n.every(v => Math.abs(v) < 1e8)) vs = U.filter(x => x.cx > n[0] && x.cx < n[2] && x.cy > n[1] && x.cy < n[3]); }
      return vs.sort((p, q) => (Math.abs(p.cy - q.cy) < 2 ? p.x0 - q.x0 : p.cy - q.cy)).map(x => fixTxt(x.t)).join(' ').trim();
    };
    const find = re => U.filter(x => re.test(x.u));
    const lab = (key, re, skip) => { for (const l of find(re)) { const v = valueIn(l, skip || re); if (v) { out[key] = v; return; } } };
    // 'LINE' 다음 'NO.'
    for (const l of find(/^LINE$/)) { const no = U.find(x => /^NO/.test(x.u) && Math.abs(x.cy - l.cy) < 2 && x.x0 > l.x1 - 1 && x.x0 - l.x1 < 15); if (!no) continue; const v = valueIn(no, /^(LINE|NO\.?)$/); if (v) { out.line_no = v.replace(/\s+/g, ''); break; } }
    for (const l of find(/^SHT|^SHEET|^STA?C|^SH[A-Z]?\.?N/)) {
      let m = null; const c = cellAt(G, l.cx, l.cy);
      if (c.every(x => Math.abs(x) < 1e8)) m = (await readCell(segs, [l.x1 + 0.3, c[1], c[2], c[3]], '0123456789/', 10)).t.match(/(\d+)\s*\/\s*(\d+)/);
      if (!m) { const v = valueIn(l, /^(SHT|SHEET|NO|STAC)/); m = v.match(/(\d+)\s*\/\s*(\d+)/) || v.match(/(\d+)\s+OF\s+(\d+)/i); }
      if (m && +m[1] <= +m[2] && +m[2] < 50) { out.sht = +m[1]; out.of = +m[2]; break; }
    }
    lab('area', /^AREA$/); lab('unit', /^UNIT$/); lab('wps', /^WPS$/);
    if (out.line_no) { const m = out.line_no.match(/^(\d+(?:[-\s]\d+\/\d+|\/\d+)?)"/); if (m) out.nps = sizeNum(m[1] + '"'); }
    return out;
  }

  /* ---------- 다른 장으로 이어지는 표시 / 좌표 (아이소 방향 글자) ---------- */
  async function readIsoText(segs, page, opts) {
    opts = opts || {};
    const ML = opts.maxStroke || 12;
    const T = segs.filter(q => !q.isFill && Math.hypot(q[1][0] - q[0][0], q[1][1] - q[0][1]) < ML); if (!T.length) return [];
    const w = await getWorker(); await setP(w, opts.wl || '', 11);
    const rg = [0, 0, page.W, page.H], cx = page.W / 2, cy = page.H / 2;
    const d1 = Math.hypot(page.W, page.H), K = Math.max(2.5, Math.min(4, Math.sqrt(14e6 / (d1 * d1 * 1.6))));
    const RW = page.W * K, RH = page.H * K, D = Math.ceil(Math.hypot(RW, RH));
    const out = [];
    const vs = opts.vars || VARS;
    for (let vi = 0; vi < vs.length; vi++) {
      const [deg, sh] = vs[vi]; if (opts.progress) opts.progress('도면 글자 읽는 중… (' + (vi + 1) + '/' + vs.length + ')');
      const th = deg * Math.PI / 180, c = Math.cos(th), s = Math.sin(th), CW = Math.ceil(D + Math.abs(sh) * D), CH = D;
      const fwd = (x, y) => { const X = (x - cx) * K, Y = (y - cy) * K; const rx = X * c + Y * s, ry = -X * s + Y * c; return [rx + sh * ry + CW / 2, ry + CH / 2]; };
      const inv = (u, v) => { const ry = v - CH / 2, rx = u - CW / 2 - sh * ry; const X = rx * c - ry * s, Y = rx * s + ry * c; return [X / K + cx, Y / K + cy]; };
      const cv = document.createElement('canvas'); cv.width = CW; cv.height = CH;
      const g = cv.getContext('2d'); g.fillStyle = '#fff'; g.fillRect(0, 0, CW, CH); g.strokeStyle = '#000'; g.lineWidth = Math.max(2, K * 0.55); g.lineCap = 'round';
      g.beginPath(); T.forEach(([a, b]) => { const p = fwd(a[0], a[1]), q = fwd(b[0], b[1]); g.moveTo(p[0], p[1]); g.lineTo(q[0], q[1]); }); g.stroke();
      const r = await w.recognize(cv);
      (r.data.lines || []).forEach(ln => { const t = (ln.text || '').trim(); if (!t || ln.confidence < 40) return; const b = ln.bbox; out.push({ t, c: Math.round(ln.confidence), p: inv((b.x0 + b.x1) / 2, (b.y0 + b.y1) / 2), var: vi }); });
    }
    await setP(w, '0123456789', 11);
    return out;
  }
  // "SEE DWG SHT NO.(2/3)" → {sht:2, of:3, p}
  function seeSheets(lines) {
    const out = [];
    lines.forEach(l => { const u0 = fixTxt(l.t).toUpperCase(), u = u0.replace(/\s+/g, ''); if (!/SE|EE|DWG|DW|SHT|SH|NO|CONT|MATCH|\(/.test(u)) return; const m = u.match(/(\d{1,2})\/(\d{1,2})/) || u0.match(/\(\s*(\d{1,2})\s*[\/ 7I]?\s*(\d{1,2})\s*\)/); if (!m || +m[1] > +m[2] || +m[2] > 30 || +m[1] < 1) return;
      if (!out.some(o => Math.hypot(o.p[0] - l.p[0], o.p[1] - l.p[1]) < 20)) out.push({ sht: +m[1], of: +m[2], p: l.p, t: l.t, c: l.c }); });
    return out;
  }
  // "E 12345.6 / N 2345 / EL 105500" 같은 좌표 표기
  function coordsOf(lines) {
    const out = [];
    lines.forEach(l => { const u = fixTxt(l.t).toUpperCase().replace(/\s+/g, ' ');
      const g = (re) => { const m = u.match(re); return m ? parseFloat(m[1].replace(/[^0-9.\-+]/g, '')) : null; };
      const e = g(/\bE\.?\s*[:=]?\s*([+\-]?\d[\d,]*(?:\.\d+)?)/), n = g(/\bN\.?\s*[:=]?\s*([+\-]?\d[\d,]*(?:\.\d+)?)/), el = g(/\b(?:EL|ELEV|TOS|BOP|COP)\.?\s*[:=]?\s*([+\-]?\d[\d,]*(?:\.\d+)?)/);
      if (e == null && n == null && el == null) return;
      out.push({ e, n, el, p: l.p, t: l.t, c: l.c }); });
    return out;
  }

  /* 점 둘레만 잘라 여러 방향으로 읽기 (다른 장 표시·좌표) — 페이지 전체보다 훨씬 빠름 */
  const NVARS = [[-30, -0.577], [30, 0.577], [-30, 0.577], [30, -0.577], [0, 0], [90, -0.577], [-90, 0.577]];
  async function readNear(segs, pts, opts) {
    opts = opts || {};
    const R = opts.radius || 130, K = opts.scale || 4, ML = opts.maxStroke || 12, T0 = segs.filter(q => !q.isFill && Math.hypot(q[1][0] - q[0][0], q[1][1] - q[0][1]) < ML);
    const w = await getWorker(); await setP(w, opts.wl || 'ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789./()-+:=# ', 11);
    const res = [];
    for (let i = 0; i < pts.length; i++) {
      const pp = pts[i].p || pts[i], od = pts[i].out, c0 = od ? [pp[0] + od[0] * R * 0.35, pp[1] + od[1] * R * 0.35] : pp, T = T0.filter(([a, b]) => Math.hypot((a[0] + b[0]) / 2 - c0[0], (a[1] + b[1]) / 2 - c0[1]) < R);
      const got = []; res.push(got); if (!T.length) continue;
      // 끝의 배관 방향과 같은 방향으로 누운 글자만 (아이소: ±30° / 세로)
      const an = pts[i].ang, vlist = an == null ? NVARS.map((v, k) => k) : NVARS.map((v, k) => k).filter(k => Math.abs(Math.abs(NVARS[k][0]) - Math.min(Math.abs(an), 180 - Math.abs(an))) < 20 || (Math.abs(Math.abs(an) - 90) < 20 && Math.abs(NVARS[k][0]) === 90));
      for (const vi of vlist) {
        if (opts.progress) opts.progress('도면 끝 표시 읽는 중… (' + (i + 1) + '/' + pts.length + ')');
        const [deg, sh] = NVARS[vi], th = deg * Math.PI / 180, c = Math.cos(th), s2 = Math.sin(th);
        const D = Math.ceil(2 * R * K * 1.45), CW = Math.ceil(D * (1 + Math.abs(sh))), CH = D;
        const fwd = (x, y) => { const X = (x - c0[0]) * K, Y = (y - c0[1]) * K; const rx = X * c + Y * s2, ry = -X * s2 + Y * c; return [rx + sh * ry + CW / 2, ry + CH / 2]; };
        const inv = (u, v) => { const ry = v - CH / 2, rx = u - CW / 2 - sh * ry; const X = rx * c - ry * s2, Y = rx * s2 + ry * c; return [X / K + c0[0], Y / K + c0[1]]; };
        const cv = document.createElement('canvas'); cv.width = CW; cv.height = CH;
        const g = cv.getContext('2d'); g.fillStyle = '#fff'; g.fillRect(0, 0, CW, CH); g.strokeStyle = '#000'; g.lineWidth = Math.max(2, K * 0.5); g.lineCap = 'round';
        g.beginPath(); T.forEach(([a, b]) => { const p = fwd(a[0], a[1]), q = fwd(b[0], b[1]); g.moveTo(p[0], p[1]); g.lineTo(q[0], q[1]); }); g.stroke();
        if (opts.debug) opts.debug.push(cv.toDataURL());
        let r; try { r = await w.recognize(cv); } catch (e) { continue; }
        (r.data.lines || []).forEach(ln => { const t = (ln.text || '').replace(/\s+/g, ' ').trim(); if (t.length < 3 || ln.confidence < 45) return; const b = ln.bbox; got.push({ t, c: Math.round(ln.confidence), p: inv((b.x0 + b.x1) / 2, (b.y0 + b.y1) / 2), var: vi }); });
        if (opts.stop && opts.stop(got)) break;
      }
    }
    await setP(w, '0123456789', 11);
    return res;
  }
  window.P3DOCR = { readNear, readNumbers, assign, getWorker, readWords, readBOM, readTitle, readCell, readIsoText, seeSheets, coordsOf, catOf, sizeNum, npsOf, gridOf, readColumn };
})();
