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
    const w = await getWorker();
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

  window.P3DOCR = { readNumbers, assign, getWorker };
})();
