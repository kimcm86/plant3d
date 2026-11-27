/* PLANT 3D — 벡터 PDF 선 자동 추출 (AI 없이)
   ISO 도면 PDF의 선 데이터에서 배관 경로(꺾임·티·플랜지·밸브)를 찾아 경로표 초안을 만든다.
   치수 글자는 선으로 그려져 있어 읽지 않는다 → 거리(d)는 비워 두고 사람이 입력한다.
   브라우저(pdf.js)와 node 양쪽에서 동작하도록 DOM을 쓰지 않는다. */
(function (root) {
  const AX = { // 화면 방향(y 아래가 +) → 모델 축
    '+X': [0.866, 0.5], '-X': [-0.866, -0.5], '+Z': [-0.866, 0.5], '-Z': [0.866, -0.5], '+Y': [0, -1], '-Y': [0, 1]
  };
  const LINES = [['+X', 30], ['+Z', 150], ['+Y', 90]]; // 축 그룹(선 방향 각도, y 아래 기준)
  const deg = (dx, dy) => { let a = Math.atan2(dy, dx) * 180 / Math.PI; if (a < 0) a += 180; if (a >= 180) a -= 180; return a; };
  const angDiff = (a, b) => { const d = Math.abs(a - b) % 180; return Math.min(d, 180 - d); };
  const dist = (a, b) => Math.hypot(a[0] - b[0], a[1] - b[1]);

  /* 1) pdf.js operator list → 선분·채움 도형 */
  async function readPage(pdfjs, page) {
    const vp = page.getViewport({ scale: 1 }), H = vp.height;
    const ol = await page.getOperatorList(), O = pdfjs.OPS;
    const segs = [], fills = [];
    let pend = null, ctm = [1, 0, 0, 1, 0, 0];
    const stack = [];
    const T = (x, y) => [ctm[0] * x + ctm[2] * y + ctm[4], H - (ctm[1] * x + ctm[3] * y + ctm[5])];
    const mul = (m, n) => [m[0] * n[0] + m[2] * n[1], m[1] * n[0] + m[3] * n[1], m[0] * n[2] + m[2] * n[3], m[1] * n[2] + m[3] * n[3], m[0] * n[4] + m[2] * n[5] + m[4], m[1] * n[4] + m[3] * n[5] + m[5]];
    for (let i = 0; i < ol.fnArray.length; i++) {
      const fn = ol.fnArray[i], a = ol.argsArray[i];
      if (fn === O.save) stack.push(ctm.slice());
      else if (fn === O.restore) ctm = stack.pop() || [1, 0, 0, 1, 0, 0];
      else if (fn === O.transform) ctm = mul(ctm, a);
      else if (fn === O.constructPath) {
        const ops = a[0], args = a[1]; let k = 0, cur = null, start = null; const sub = { pts: [], curves: 0, lines: [] };
        for (const op of ops) {
          if (op === O.moveTo) { cur = T(args[k], args[k + 1]); start = cur; sub.pts.push(cur); k += 2; }
          else if (op === O.lineTo) { const p = T(args[k], args[k + 1]); if (cur) sub.lines.push([cur, p]); cur = p; sub.pts.push(p); k += 2; }
          else if (op === O.curveTo) { const p = T(args[k + 4], args[k + 5]); sub.curves++; cur = p; sub.pts.push(p); k += 6; }
          else if (op === O.curveTo2 || op === O.curveTo3) { const p = T(args[k + 2], args[k + 3]); sub.curves++; cur = p; sub.pts.push(p); k += 4; }
          else if (op === O.closePath) { if (cur && start) sub.lines.push([cur, start]); cur = start; }
          else if (op === O.rectangle) { const x = args[k], y = args[k + 1], w = args[k + 2], h = args[k + 3]; const p = [T(x, y), T(x + w, y), T(x + w, y + h), T(x, y + h)]; for (let j = 0; j < 4; j++) sub.lines.push([p[j], p[(j + 1) % 4]]); sub.pts.push(...p); k += 4; }
        }
        pend = sub;
      } else if (pend && (fn === O.stroke || fn === O.closeStroke)) { pend.lines.forEach(l => segs.push(l)); pend = null; }
      else if (pend && (fn === O.fill || fn === O.eoFill || fn === O.fillStroke || fn === O.eoFillStroke || fn === O.closeFillStroke || fn === O.closeEOFillStroke)) {
        const xs = pend.pts.map(p => p[0]), ys = pend.pts.map(p => p[1]);
        fills.push({ pts: pend.pts, curves: pend.curves, n: pend.pts.length, x0: Math.min(...xs), x1: Math.max(...xs), y0: Math.min(...ys), y1: Math.max(...ys) });
        { const w = Math.max(...xs) - Math.min(...xs), h = Math.max(...ys) - Math.min(...ys), uniq = []; pend.pts.forEach(p => { if (!uniq.some(q => Math.hypot(q[0] - p[0], q[1] - p[1]) < 0.3)) uniq.push(p); });
          const tri = uniq.length === 3 && Math.abs((uniq[1][0] - uniq[0][0]) * (uniq[2][1] - uniq[0][1]) - (uniq[2][0] - uniq[0][0]) * (uniq[1][1] - uniq[0][1])) > 0.8;
          const tiny = (w < 2.6 && h < 2.6) || (tri && Math.max(w, h) < 12);
          pend.lines.forEach(l => { const q = [l[0], l[1]]; if (tiny) q.isFill = true; segs.push(q); }); }
        pend = null;
      } else if (fn === O.endPath) pend = null;
    }
    return { W: vp.width, H, segs, fills };
  }

  const isect = (l, m) => { const den = l.u[0] * m.u[1] - l.u[1] * m.u[0]; if (Math.abs(den) < 1e-6) return null; const pl = [l.n[0] * l.off, l.n[1] * l.off], pm = [m.n[0] * m.off, m.n[1] * m.off]; const t = ((pm[0] - pl[0]) * m.u[1] - (pm[1] - pl[1]) * m.u[0]) / den; const X = [pl[0] + l.u[0] * t, pl[1] + l.u[1] * t]; return { X, sl: X[0] * l.u[0] + X[1] * l.u[1], sm: X[0] * m.u[0] + X[1] * m.u[1] }; };
  /* 2) 분석 */
  function analyze(pg) {
    const { segs, fills } = pg;
    // 용접점(작은 채움 원)·화살촉(채움 삼각형)
    const dots = [], arrows = [], small = [];
    fills.forEach(f => {
      const w = f.x1 - f.x0, h = f.y1 - f.y0;
      if (w < 5 && h < 5 && w > 0.6 && h > 0.6 && Math.abs(w - h) < 1.2 && f.curves >= 2) dots.push([(f.x0 + f.x1) / 2, (f.y0 + f.y1) / 2]);
      else if (Math.max(w, h) <= 2.4 && f.n >= 5) { const c = [(f.x0 + f.x1) / 2, (f.y0 + f.y1) / 2]; const g = small.find(q => dist(q.c, c) < 2.0); if (g) { g.n++; g.c = [(g.c[0] * (g.n - 1) + c[0]) / g.n, (g.c[1] * (g.n - 1) + c[1]) / g.n]; } else small.push({ c, n: 1 }); }
      else if (f.n >= 3 && f.n <= 5 && Math.max(w, h) < 12 && Math.max(w, h) > 2) {
        const P = f.pts.slice(0, 3); let best = 0, tip = P[0];
        P.forEach(p => { const s = P.reduce((a, q) => a + dist(p, q), 0); if (s > best) { best = s; tip = p; } });
        const c = [(P[0][0] + P[1][0] + P[2][0]) / 3, (P[0][1] + P[1][1] + P[2][1]) / 3];
        arrows.push({ tip, dir: [tip[0] - c[0], tip[1] - c[1]] });
      }
    });
    small.forEach(g => { if (g.n >= 2) dots.push(g.c); });
    // 축 방향 선분 → 선(line) 그룹으로 병합
    const L = [];
    segs.forEach(([a, b]) => {
      const len = dist(a, b); if (len < 0.8) return;
      const ang = deg(b[0] - a[0], b[1] - a[1]);
      const g = LINES.find(([, t]) => angDiff(ang, t) < 2.2);
      if (!g) return;
      const t = g[1] * Math.PI / 180, u = [Math.cos(t), Math.sin(t)], n = [-u[1], u[0]];
      const off = a[0] * n[0] + a[1] * n[1], s0 = a[0] * u[0] + a[1] * u[1], s1 = b[0] * u[0] + b[1] * u[1];
      L.push({ ax: g[0], u, n, off, s0: Math.min(s0, s1), s1: Math.max(s0, s1) });
    });
    const merged = [];
    const byAx = {};
    L.forEach(l => (byAx[l.ax] = byAx[l.ax] || []).push(l));
    Object.values(byAx).forEach(arr => {
      arr.sort((p, q) => p.off - q.off || p.s0 - q.s0);
      const groups = [];
      arr.forEach(l => { const g = groups.find(g => Math.abs(g.off - l.off) < 0.35); if (g) g.items.push(l); else groups.push({ off: l.off, items: [l] }); });
      groups.forEach(g => {
        g.items.sort((p, q) => p.s0 - q.s0);
        let cur = null;
        g.items.forEach(l => {
          if (cur && l.s0 <= cur.s1 + 1.8) { cur.cov += Math.max(0, l.s1 - Math.max(l.s0, cur.s1)); cur.s1 = Math.max(cur.s1, l.s1); }
          else { cur && merged.push(cur); cur = { ax: l.ax, u: l.u, n: l.n, off: g.off, s0: l.s0, s1: l.s1, cov: l.s1 - l.s0 }; }
        });
        cur && merged.push(cur);
      });
    });
    const P = (l, s) => [l.u[0] * s + l.n[0] * l.off, l.u[1] * s + l.n[1] * l.off];
    merged.forEach(l => { l.a = P(l, l.s0); l.b = P(l, l.s1); l.len = l.s1 - l.s0; });
    const onLine = (l, p, tol) => { const s = p[0] * l.u[0] + p[1] * l.u[1], o = p[0] * l.n[0] + p[1] * l.n[1]; return Math.abs(o - l.off) < tol && s > l.s0 - tol && s < l.s1 + tol ? s : null; };
    // 치수선: 화살촉이 붙은 선, 치수 보조선: 치수선 끝에 수직으로 닿는 선
    merged.forEach(l => {
      const hits = arrows.filter(a => onLine(l, a.tip, 1.2) != null && Math.abs(a.dir[0] * l.u[0] + a.dir[1] * l.u[1]) > 0.8 * Math.hypot(a.dir[0], a.dir[1]));
      if (hits.length) l.dim = true;
    });
    const dimL = merged.filter(l => l.dim);
    merged.forEach(l => {
      if (l.dim) return;
      if (dimL.some(d => { if (d.ax === l.ax) return false; if ([l.a, l.b].some(p => onLine(d, p, 1.5) != null)) return true;
        const xi = isect(l, d); return xi && xi.sm > d.s0 - 2 && xi.sm < d.s1 + 2 && (Math.abs(xi.sl - l.s0) < 5 || Math.abs(xi.sl - l.s1) < 5); })) l.ext = true; // 보조선 끝이 치수선을 살짝 넘어가도 보조선
    });
    // 배관 후보: 길이 6pt 이상, 치수/보조선 아님
    const onSeg = (l, d, tol) => { const s = d[0] * l.u[0] + d[1] * l.u[1], o = d[0] * l.n[0] + d[1] * l.n[1]; return Math.abs(o - l.off) < tol && s > l.s0 - 1 && s < l.s1 + 1; };
    const longL = merged.filter(m => m.len >= 15 && m.cov / m.len > 0.82);
    // 자기 용접점: 다른 선과 엇갈리는 자리가 아닌 곳의 용접점 (플랜지 면 획이 보조선과 이어져 배관을 가로지를 때 구별)
    const dotMid = l => dots.some(d => onSeg(l, d, 1.2) && !longL.some(m => m !== l && m.ax !== l.ax && !(m.dim || m.ext) && onSeg(m, d, 2)));
    // 화살촉 달린 치수선, 치수선에 닿는 보조선은 배관 후보에서 뺀다 (선 가운데에 용접점이 있으면 배관으로 봄)
    let cand = merged.filter(l => l.len >= 6 && l.cov / l.len > 0.82 && !((l.dim || l.ext) && !dotMid(l))); // 점선(기존 배관)은 빈틈이 많아 제외
    // 같은 축 같은 오프셋의 선 사이 틈(밸브·기호로 끊긴 곳) 잇기
    const bridged = [];
    // 틈 사이를 다른 긴 선이 가로지르면(꺾임·티 자리) 잇지 않는다 — 같은 줄 위의 치수 보조선/라벨선이 배관에 붙는 것 방지
    const crossGap = (l, g0, g1) => g1 - g0 > 2.5 && cand.some(m => {
      if (m.ax === l.ax || m.len < 10) return false;
      const xi = isect(l, m);
      if (!xi || xi.sl < g0 - 3 || xi.sl > g1 + 3 || xi.sm < m.s0 - 3 || xi.sm > m.s1 + 3) return false;
      const endsHere = Math.min(Math.abs(xi.sm - m.s0), Math.abs(xi.sm - m.s1)) < 3; // 틈 자리에서 끝나는 선 = 꺾임·티 배관
      return endsHere;
    });
    const gk = {};
    cand.forEach(l => { const k = l.ax + '|' + Math.round(l.off / 0.5); (gk[k] = gk[k] || []).push(l); });
    // 틈 안에 기호(밸브 등) 획이 있는가: 배관을 가로지르는 짧은 선 2개 이상
    const symS = segs.filter(q => !q.isFill).map(([a, b]) => ({ m: [(a[0] + b[0]) / 2, (a[1] + b[1]) / 2], len: dist(a, b), ang: deg(b[0] - a[0], b[1] - a[1]) })).filter(q => q.len > 1.5 && q.len < 16);
    const symGap = (l, g0, g1) => symS.filter(q => { const s = q.m[0] * l.u[0] + q.m[1] * l.u[1], o = q.m[0] * l.n[0] + q.m[1] * l.n[1]; return s > g0 - 1 && s < g1 + 1 && Math.abs(o - l.off) < 7 && angDiff(q.ang, LINES.find(x => x[0] === l.ax)[1]) > 20; }).map(q => q.m[0] * l.u[0] + q.m[1] * l.u[1]).sort((x, y) => x - y).some((v, i, A) => i > 0 && v - A[0] > 1.5); // 위치가 다른 획 2개 이상(플랜지 면·밸브) — 한 줄로 지나가는 배관과 구별
    // 틈을 다른 선이 지나가면(앞뒤로 엇갈려 그린 곳) 같은 배관으로 이음
    const passGap = (l, g0, g1) => g1 - g0 < 10 && segs.some(([a, b]) => { if (dist(a, b) < 6) return false; const ang = deg(b[0] - a[0], b[1] - a[1]); if (angDiff(ang, LINES.find(x => x[0] === l.ax)[1]) < 20) return false;
      const oa = a[0] * l.n[0] + a[1] * l.n[1] - l.off, ob = b[0] * l.n[0] + b[1] * l.n[1] - l.off; if (oa * ob >= 0 || Math.min(Math.abs(oa), Math.abs(ob)) < 2) return false;
      const t = oa / (oa - ob), X = [a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t], sx = X[0] * l.u[0] + X[1] * l.u[1]; return sx > g0 && sx < g1; });
    const fillM = segs.filter(q => q.isFill).map(([a, b]) => [(a[0] + b[0]) / 2, (a[1] + b[1]) / 2]);
    const dotIn = (l, g0, g1) => g1 - g0 < 8 && dots.concat(fillM).some(d => { const s = d[0] * l.u[0] + d[1] * l.u[1], o = d[0] * l.n[0] + d[1] * l.n[1]; return Math.abs(o - l.off) < 1.5 && s > g0 - 1 && s < g1 + 1; });
    Object.values(gk).forEach(arr => {
      arr.sort((p, q) => p.s0 - q.s0);
      // 1) 틈 종류 판정: 용접(≤2.5)·기호(밸브)는 잇고, 빈 틈은 점선 → 잇지 않음
      const link = [];
      for (let i = 0; i + 1 < arr.length; i++) {
        const g0 = arr[i].s1, g1 = arr[i + 1].s0, g = g1 - g0;
        link.push(g >= 22 ? 'no' : g <= 2.5 ? 'weld' : symGap(arr[i], g0, g1) ? 'sym' : dotIn(arr[i], g0, g1) ? 'weld' : crossGap(arr[i], g0, g1) ? 'no' : passGap(arr[i], g0, g1) ? 'pass' : 'empty');
      }
      // 2) 빈 틈으로 3조각 이상 이어지는 줄 = 점선/일점쇄선(기존 배관·중심선) → 배관 후보에서 뺌
      let i0 = 0;
      for (let i = 0; i <= link.length; i++) if (i === link.length || link[i] !== 'empty') { if (i - i0 + 1 >= 3) { const ch = arr.slice(i0, i + 1), mx = Math.max(...ch.map(l => l.len)), md = ch.map(l => l.len).sort((x, y) => x - y)[ch.length >> 1]; if (md < 30 && mx < 60) ch.forEach(l => { l.dashed = true; }); } i0 = i + 1; }
      let cur = null;
      arr.forEach((l, i) => {
        if (l.dashed) { cur && bridged.push(cur); cur = null; return; }
        const lk = i > 0 ? link[i - 1] : 'no';
        if (cur && (lk === 'weld' || lk === 'sym' || lk === 'pass')) { if (lk === 'sym') cur.gaps.push([cur.s1, l.s0]); cur.s1 = Math.max(cur.s1, l.s1); }
        else { cur && bridged.push(cur); cur = Object.assign({}, l, { gaps: [] }); }
      });
      cur && bridged.push(cur);
    });
    bridged.forEach(l => { l.a = P(l, l.s0); l.b = P(l, l.s1); l.len = l.s1 - l.s0; });
    // 배관 = 용접점이 올라앉은 선에서 시작해, 끝점이 정확히 맞닿는 선(엘보 꺾임·티)으로 넓혀 간다.
    // 치수선·보조선은 배관과 틈을 두고 그려지므로 여기서 빠진다.
    const onL = (l, p, tol) => { const s = p[0] * l.u[0] + p[1] * l.u[1], o = p[0] * l.n[0] + p[1] * l.n[1]; return Math.abs(o - l.off) < tol && s > l.s0 - 0.8 && s < l.s1 + 0.8; };
    const N = bridged.length, adj = bridged.map(() => []);
    for (let i = 0; i < N; i++) for (let j = 0; j < N; j++) {
      if (i === j || bridged[i].ax === bridged[j].ax) continue;
      const l = bridged[i], m = bridged[j];
      const xi = isect(l, m), ix = xi && xi.sl > l.s0 - 8 && xi.sl < l.s1 + 8 && xi.sm > m.s0 - 8 && xi.sm < m.s1 + 8;
      const ee = ix || [l.a, l.b].some(e => [m.a, m.b].some(f => dist(e, f) < 3.2));
      const et = [l.a, l.b].some(e => onL(m, e, 1.0));
      if (ee || et) adj[i].push(j);
    }
    const nearEnd = (l, p) => { const s = p[0] * l.u[0] + p[1] * l.u[1], o = p[0] * l.n[0] + p[1] * l.n[1]; return Math.abs(o - l.off) < 1.2 && s > l.s0 - 1.3 && s < l.s1 + 1.3; }; // 용접점이 선 끝에 붙어 있음 (보조선은 2pt 이상 떨어져 시작)
    // 배관을 가로질러 양쪽으로 튀어나온 짧은 획 = 플랜지 면·밸브 기호 (배관 아님)
    const straddle = l => l.len < 20 && bridged.some(m => { if (m === l || m.ax === l.ax || m.len < 8) return false; const xi = isect(l, m); return xi && xi.sm > m.s0 - 9 && xi.sm < m.s1 + 9 && xi.sl - l.s0 > 2 && l.s1 - xi.sl > 2; }); // 배관 끝의 플랜지 면 획도 포함
    const seed = bridged.map(l => l.len >= 8 && dots.some(d => nearEnd(l, d)) && !straddle(l));
    const keep = new Array(N).fill(false), st = [];
    seed.forEach((v, i) => { if (v) keep[i] = true; });
    for (let it = 0; it < 2; it++) bridged.forEach((l, i) => {
      if (keep[i] || straddle(l)) return;
      const dotAt = p => dots.some(d => dist(d, p) < 3.5);
      const okE = e => bridged.some((m, j) => keep[j] && m.ax !== l.ax && (onL(m, e, 1.0) || [m.a, m.b].some(f => dist(e, f) < 1.2 || (dist(e, f) < 3.5 && dotAt(f)))));
      if (okE(l.a) && okE(l.b)) keep[i] = true;
    });
    // 작은 묶음(로고·기호 안의 선)은 제외: 연결된 배관 길이 합이 60pt 미만
    const cid = new Array(N).fill(-1); let nc = 0;
    for (let i = 0; i < N; i++) if (keep[i] && cid[i] < 0) { const q = [i]; cid[i] = nc; while (q.length) { const c = q.pop(); adj[c].forEach(j => { if (keep[j] && cid[j] < 0) { cid[j] = nc; q.push(j); } }); } nc++; }
    const clen = new Array(nc).fill(0); bridged.forEach((l, i) => { if (cid[i] >= 0) clen[cid[i]] += l.len; });
    const cdot = new Array(nc).fill(0); bridged.forEach((l, i) => { if (cid[i] >= 0) cdot[cid[i]] += dots.filter(d => onL(l, d, 1.1)).length; });
    const pipes = bridged.filter((l, i) => keep[i] && (clen[cid[i]] >= 60 || cdot[cid[i]] >= 3));
    // 플랜지·밸브 기호: 배관 위를 가로지르는 짧은 선 무리
    const shortS = segs.filter(q => !q.isFill).map(([a, b]) => ({ a, b, m: [(a[0] + b[0]) / 2, (a[1] + b[1]) / 2], len: dist(a, b), ang: deg(b[0] - a[0], b[1] - a[1]) })).filter(s => s.len > 1.5 && s.len < 16);
    pipes.forEach(l => {
      const lang = LINES.find(x => x[0] === l.ax)[1];
      const marks = [];
      shortS.forEach(s => {
        const sp = onLine(l, s.m, 7); if (sp == null || sp < l.s0 + 2 || sp > l.s1 - 2) return;
        const cross = angDiff(s.ang, lang) > 20;
        const oa = s.a[0] * l.n[0] + s.a[1] * l.n[1] - l.off, ob = s.b[0] * l.n[0] + s.b[1] * l.n[1] - l.off;
        const straddle = (oa * ob < 0) || Math.abs(oa) < 0.8 || Math.abs(ob) < 0.8;
        marks.push({ s: sp, cross, straddle, len: s.len, ax: (LINES.find(([, t]) => angDiff(s.ang, t) < 4) || [null])[0] });
      });
      marks.sort((p, q) => p.s - q.s);
      const cl = [];
      marks.forEach(m => { const c = cl[cl.length - 1]; if (c && m.s - c.e < 3) { c.e = m.s; c.items.push(m); } else cl.push({ b: m.s, e: m.s, items: [m] }); });
      l.feats = [];
      cl.forEach(c => {
        const axc = c.items.filter(m => m.cross && m.straddle && m.ax && m.ax !== l.ax && m.len >= 4), diag = c.items.filter(m => !m.ax && m.straddle && m.len >= 2.5);
        const s = (c.b + c.e) / 2, span = c.e - c.b;
        if (s < l.s0 + 5 || s > l.s1 - 5) return;
        const fp = P(l, s);
        if (pipes.some(m => m !== l && ([m.a, m.b].some(e => dist(e, fp) < 8) || (m.ax !== l.ax && onL(m, fp, 2.5))))) return;
        if (diag.length >= 2) l.feats.push({ t: 'valve', s });
        else if (axc.length >= 2 && span < 7) l.feats.push({ t: 'flange', s });
      });
      // 끊긴 틈 중 기호가 없는 곳 → 밸브로 추정
      (l.gaps || []).forEach(([g0, g1]) => { const s = (g0 + g1) / 2; if (!l.feats.some(f => Math.abs(f.s - s) < 10)) l.feats.push({ t: 'valve', s, guess: true }); });
      l.feats.sort((p, q) => p.s - q.s);
    });
    // 아이소 밸브(나비꼴 ⋈): 아이소 축(30/90/150°)이 아닌 빗선 2개 이상이 배관 축을 가로지르는 곳
    const isoAng = a => [30, 90, 150].some(t => angDiff(a, t) < 4);
    const slant = segs.filter(q => !q.isFill).map(([a, b]) => ({ a, b, len: dist(a, b), ang: deg(b[0] - a[0], b[1] - a[1]) })).filter(q => q.len >= 7 && q.len < 25 && !isoAng(q.ang)); // 용접 끝 작은 삼각형(7pt 미만)은 제외
    const valves = [], vc = [];
    pipes.forEach(l => {
      const xs = [];
      slant.forEach(q => {
        const oa = q.a[0] * l.n[0] + q.a[1] * l.n[1] - l.off, ob = q.b[0] * l.n[0] + q.b[1] * l.n[1] - l.off;
        if (Math.max(Math.abs(oa), Math.abs(ob)) > 12 || !(oa * ob < 0 || Math.min(Math.abs(oa), Math.abs(ob)) < 1.2)) return;
        const t = Math.abs(oa - ob) < 1e-6 ? 0 : Math.max(0, Math.min(1, oa / (oa - ob))), X = [q.a[0] + (q.b[0] - q.a[0]) * t, q.a[1] + (q.b[1] - q.a[1]) * t];
        const sx = X[0] * l.u[0] + X[1] * l.u[1]; if (sx > l.s0 - 2 && sx < l.s1 + 2) xs.push(sx);
      });
      xs.sort((x, y) => x - y);
      const g = []; xs.forEach(v => { const c = g[g.length - 1]; if (c && v - c.e < 6) { c.e = v; c.v.push(v); } else g.push({ b: v, e: v, v: [v] }); });
      g.forEach(c => { if (c.v.length >= 2) vc.push({ p: P(l, c.v.reduce((a, v) => a + v, 0) / c.v.length), n: c.v.length, L: l.len }); });
    });
    // 같은 밸브 중심을 지나는 선이 여럿이면(배관 + 핸들 축) 가장 긴 선이 배관, 짧은 선(30pt 미만)은 핸들 축으로 보고 뺀다
    const onPipe = (m, p) => { const sp = onLine(m, p, 1.5); return sp != null && sp > m.s0 - 2 && sp < m.s1 + 2 ? sp : null; };
    vc.sort((x, y) => y.n - x.n || y.L - x.L).forEach(c => { if (valves.some(v => dist(v, c.p) < 12)) return; valves.push(c.p); });
    const drop = new Set();
    valves.forEach(p => {
      const own = pipes.filter(m => onPipe(m, p) != null).sort((x, y) => y.len - x.len);
      if (!own.length) return; const l = own[0], sv = Math.min(l.s1 - 0.6, Math.max(l.s0 + 0.6, onPipe(l, p)));
      l.feats = (l.feats || []).filter(f => Math.abs(f.s - sv) > 9); // 밸브 양옆 플랜지 표시는 밸브(플랜지형)에 포함
      l.feats.push({ t: 'valve', s: sv, vt: 'gate', iso: true }); l.feats.sort((x, y) => x.s - y.s);
      own.slice(1).forEach(m => { if (m.len < 30 && m.ax !== l.ax) drop.add(m); });
      pipes.forEach(m => { if (m === l || m.len >= 30 || m.ax === l.ax) return; // 밸브 기호 안을 지나는 짧은 선 = 핸들 축
        const xi = isect(l, m); if (xi && dist(xi.X, p) < 9 && xi.sm > m.s0 - 2 && xi.sm < m.s1 + 2) drop.add(m); });
    });
    for (let i = pipes.length - 1; i >= 0; i--) if (drop.has(pipes[i])) pipes.splice(i, 1);
    // 체크 밸브 등 '플랜지 면 ─ 몸통 ─ 플랜지 면' 기호: 배관을 가로지르는 면 획 두 무리가 6~16pt 떨어져 있고,
    // 그 사이를 아이소 축이 아닌 빗선이 가로지르면 플랜지형 밸브(체크 밸브로 추정)
    pipes.forEach(l => {
      const la = LINES.find(x => x[0] === l.ax)[1], cross = [], diag = [];
      segs.forEach(q => { if (q.isFill) return; const [a, b] = q, n = dist(a, b); if (n < 4 || n > 25) return;
        const oa = a[0] * l.n[0] + a[1] * l.n[1] - l.off, ob = b[0] * l.n[0] + b[1] * l.n[1] - l.off; if (!(oa * ob < 0) || Math.max(Math.abs(oa), Math.abs(ob)) > 13) return;
        const t = oa / (oa - ob), X = [a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t], sx = X[0] * l.u[0] + X[1] * l.u[1]; if (sx < l.s0 - 1 || sx > l.s1 + 1) return;
        const ang = deg(b[0] - a[0], b[1] - a[1]); if (angDiff(ang, la) < 10) return;
        if (isoAng(ang)) { if (n <= 14) cross.push(sx); } else if (n >= 7) diag.push(sx); });
      cross.sort((x, y) => x - y); const g = []; cross.forEach(v => { const c = g[g.length - 1]; if (c && v - c.e < 3) c.e = v; else g.push({ b: v, e: v }); });
      for (let i = 0; i + 1 < g.length; i++) { const A1 = g[i], B1 = g[i + 1], gap = B1.b - A1.e; if (gap < 6 || gap > 16) continue;
        const inn = diag.filter(v => v > A1.e + 1 && v < B1.b - 1); if (!inn.length) continue;
        const sv = (A1.e + B1.b) / 2; if ((l.feats || []).some(f => f.t === 'valve' && f.iso && Math.abs(f.s - sv) < 10)) continue;
        l.feats = (l.feats || []).filter(f => !(Math.abs(f.s - sv) < gap / 2 + 4)); // 양쪽 플랜지 표시는 밸브(플랜지형)에 포함
        l.feats.push({ t: 'valve', s: sv, vt: 'check', iso: true, vg: 'check' }); l.feats.sort((x, y) => x.s - y.s); i++; }
    });
    // 레듀서(사다리꼴): 배관 양옆에서 같은 쪽으로 좁아지는 빗선 2개 (배관 축을 가로지르지 않음)
    pipes.forEach(l => {
      const sd = segs.filter(q => !q.isFill).map(([a, b]) => ({ a, b, len: dist(a, b), ang: deg(b[0] - a[0], b[1] - a[1]) })).filter(q => q.len >= 4 && q.len < 20 && !isoAng(q.ang)).map(q => {
        const oa = q.a[0] * l.n[0] + q.a[1] * l.n[1] - l.off, ob = q.b[0] * l.n[0] + q.b[1] * l.n[1] - l.off, sa = q.a[0] * l.u[0] + q.a[1] * l.u[1], sb = q.b[0] * l.u[0] + q.b[1] * l.u[1];
        const [s0, o0, s1, o1] = sa < sb ? [sa, oa, sb, ob] : [sb, ob, sa, oa];
        return { s0, s1, o0, o1, side: Math.sign(o0 + o1), taper: Math.sign(Math.abs(o1) - Math.abs(o0)) };
      }).filter(q => q.o0 * q.o1 > 0 && Math.min(Math.abs(q.o0), Math.abs(q.o1)) > 1 && Math.max(Math.abs(q.o0), Math.abs(q.o1)) < 8 && Math.abs(Math.abs(q.o1) - Math.abs(q.o0)) > 1 && q.s1 > l.s0 - 2 && q.s0 < l.s1 + 2);
      sd.forEach((a, i) => sd.slice(i + 1).forEach(b => {
        if (a.side === b.side || a.taper !== b.taper) return;
        const ov = Math.min(a.s1, b.s1) - Math.max(a.s0, b.s0); if (ov < 0.5 * Math.min(a.s1 - a.s0, b.s1 - b.s0)) return;
        const sv = Math.min(l.s1 - 0.6, Math.max(l.s0 + 0.6, (Math.max(a.s0, b.s0) + Math.min(a.s1, b.s1)) / 2));
        if ((l.feats || []).some(f => ((f.t === 'valve' && f.iso) || f.t === 'reducer') && Math.abs(f.s - sv) < 8)) return;
        l.feats = (l.feats || []).filter(f => Math.abs(f.s - sv) > (f.t === 'valve' ? 7 : 5)); // 레듀서 빗변을 밸브로 읽은 것 제거
        l.feats.push({ t: 'reducer', s: sv }); l.feats.sort((x, y) => x.s - y.s);
      }));
    });
    // 캡(ㄷ 모양): 배관 끝 5pt 안에 짧은 획 3개 이상
    const tiny = segs.filter(q => !q.isFill).filter(([a, b]) => { const n = dist(a, b); return n >= 2 && n <= 6; });
    const caps = [];
    pipes.forEach(l => { const la = LINES.find(x => x[0] === l.ax)[1];
      [[l.a, -1], [l.b, 1]].forEach(([e, sg]) => {
        const es = e[0] * l.u[0] + e[1] * l.u[1], near = tiny.filter(([a, b]) => dist(a, e) < 5 && dist(b, e) < 5).map(([a, b]) => { const m = [(a[0] + b[0]) / 2, (a[1] + b[1]) / 2]; return { o: m[0] * l.n[0] + m[1] * l.n[1] - l.off, s: (m[0] * l.u[0] + m[1] * l.u[1] - es) * sg, ang: deg(b[0] - a[0], b[1] - a[1]) }; });
        const par = near.filter(q => angDiff(q.ang, la) < 5 && Math.abs(q.o) > 0.8 && Math.abs(q.o) < 3.5);
        const sides = par.some(q => q.o > 0) && par.some(q => q.o < 0), bottom = near.some(q => angDiff(q.ang, la) > 20 && q.s > 0.3 && Math.abs(q.o) < 3);
        if (sides && bottom) caps.push(e); // ㄷ 모양: 배관 양옆 평행선 + 끝을 막는 선
      }); });
    return { pipes, dots, arrows, merged, P, valves, caps };
  }

  /* 3) 배관 선 → 경로표 초안 (거리 d는 비움) */
  function toRoute(A, mmpt, opt) {
    mmpt = mmpt || 50; opt = opt || {};
    const { pipes, P } = A;
    if (!pipes.length) return null;
    const pt = (l, s) => P(l, s);
    // 노드: 선 끝점, 다른 선 위에 닿는 끝점(티)
    const keyOf = p => Math.round(p[0] / 2.5) + ',' + Math.round(p[1] / 2.5);
    const nodes = []; const findNode = p => nodes.find(n => dist(n.p, p) < 3.5);
    const addNode = p => { let n = findNode(p); if (!n) { n = { p: p.slice(), edges: [] }; nodes.push(n); } return n; };
    // 각 선을 구간(edge)들로 쪼갬: 끝점 + 다른 선이 닿는 점
    pipes.forEach(l => pipes.forEach(m => { // 엘보 틈(용접점 자리) 메우기: 끝이 교차점 8pt 안이면 교차점까지 연장
      if (m === l || m.ax === l.ax) return; const xi = isect(l, m); if (!xi || xi.sm < m.s0 - 8 || xi.sm > m.s1 + 8) return;
      if (xi.sl < l.s0 && xi.sl > l.s0 - 8) l.s0 = xi.sl; if (xi.sl > l.s1 && xi.sl < l.s1 + 8) l.s1 = xi.sl;
    }));
    pipes.forEach(l => { l.a = P(l, l.s0); l.b = P(l, l.s1); });
    pipes.forEach(l => {
      const cuts = [l.s0, l.s1];
      pipes.forEach(m => {
        if (m === l) return;
        [m.a, m.b].forEach(e => { const s = e[0] * l.u[0] + e[1] * l.u[1], o = e[0] * l.n[0] + e[1] * l.n[1]; if (Math.abs(o - l.off) < 1.0 && s > l.s0 + 3 && s < l.s1 - 3) cuts.push(s); });
        if (m.ax !== l.ax) { // 교차점
          const den = l.u[0] * m.u[1] - l.u[1] * m.u[0]; if (Math.abs(den) < 1e-6) return;
          const pl = P(l, 0), pm = P(m, 0), t = ((pm[0] - pl[0]) * m.u[1] - (pm[1] - pl[1]) * m.u[0]) / den, X = [pl[0] + l.u[0] * t, pl[1] + l.u[1] * t];
          const sl = X[0] * l.u[0] + X[1] * l.u[1], sm = X[0] * m.u[0] + X[1] * m.u[1];
          const crossing = Math.min(sl - l.s0, l.s1 - sl) > 22 && Math.min(sm - m.s0, m.s1 - sm) > 22; // 그림상 교차(앞뒤로 지나감)
          if (!crossing && sl > l.s0 - 2 && sl < l.s1 + 2 && sm > m.s0 - 2 && sm < m.s1 + 2 && sl > l.s0 + 1 && sl < l.s1 - 1) cuts.push(sl);
        }
      });
      cuts.sort((a, b) => a - b);
      for (let i = 0; i < cuts.length - 1; i++) {
        if (cuts[i + 1] - cuts[i] < 1) continue;
        const n0 = addNode(pt(l, cuts[i])), n1 = addNode(pt(l, cuts[i + 1]));
        const e = { l, s0: cuts[i], s1: cuts[i + 1], n0, n1, feats: (l.feats || []).filter(f => f.s > cuts[i] && f.s < cuts[i + 1]) };
        n0.edges.push(e); n1.edges.push(e);
      }
    });
    nodes.forEach(n => {
      if (n.edges.length < 3 || A.dots.some(d => dist(d, n.p) < 14)) return;
      const ax = n.edges.map(e => e.l.ax), main = ax.find((a, i) => ax.indexOf(a) !== i);
      const drop = n.edges.filter(e => main ? e.l.ax !== main : false);
      drop.forEach(e => { [e.n0, e.n1].forEach(x => { x.edges = x.edges.filter(y => y !== e); }); });
    });
    // 사용자가 "배관 아님"이라고 한 구간 빼기
    const dSeg = (p, a, b) => { const v = [b[0] - a[0], b[1] - a[1]], L2 = v[0] * v[0] + v[1] * v[1] || 1, t = Math.max(0, Math.min(1, ((p[0] - a[0]) * v[0] + (p[1] - a[1]) * v[1]) / L2)); return dist(p, [a[0] + v[0] * t, a[1] + v[1] * t]); };
    (opt.excl || []).forEach(([a, b]) => nodes.forEach(n => n.edges.slice().forEach(e => {
      if (dSeg(e.n0.p, a, b) < 3 && dSeg(e.n1.p, a, b) < 3) [e.n0, e.n1].forEach(x => { x.edges = x.edges.filter(y => y !== e); });
    })));
    // 꺾임 너머로 튀어나온 짧은 끝(치수 보조선이 이어진 것) 잘라내기
    for (let it = 0; it < 3; it++) nodes.slice().forEach(n => {
      if (n.edges.length !== 1) return;
      const e = n.edges[0], o = e.n0 === n ? e.n1 : e.n0, len = e.s1 - e.s0;
      if (len < 30 && !e.feats.length && o.edges.length >= 3 && !A.dots.some(d => dist(d, n.p) < 3)) { o.edges = o.edges.filter(x => x !== e); n.edges = []; }
    });
    for (let i = nodes.length - 1; i >= 0; i--) if (!nodes[i].edges.length) nodes.splice(i, 1);
    const dirOf = (from, to) => { const v = [to[0] - from[0], to[1] - from[1]], L = Math.hypot(v[0], v[1]) || 1; let best = null, bv = -2; Object.entries(AX).forEach(([k, a]) => { const d = (v[0] * a[0] + v[1] * a[1]) / L; if (d > bv) { bv = d; best = k; } }); return best; };
    // 시작점: 차수 1 노드 중 가장 오른쪽 아래(관례상 아무 끝이나 가능)
    const ends = nodes.filter(n => n.edges.length === 1);
    if (!nodes.length) return null;
    const cands = (ends.length ? ends : nodes).slice().sort((a, b) => (b.p[1] + b.p[0] * 0.2) - (a.p[1] + a.p[0] * 0.2));
    let startIdx = ((opt.startAt || 0) % cands.length + cands.length) % cands.length;
    if (opt.startNear) { let bd = 1e9; cands.forEach((n, i) => { const dd = dist(n.p, opt.startNear); if (dd < bd) { bd = dd; startIdx = i; } }); } // 사용자가 도면에서 고른 시작점
    const start = cands[startIdx];
    const used = new Set(), runs = []; let tid = 0;
    const queue = [{ node: start, from: null, start: 'origin', id: 'R1' }];
    while (queue.length) {
      const q = queue.shift();
      let node = q.node, prev = q.from, dir = null; const steps = []; const run = { id: q.id, start: q.start, steps, nps: '', _p0: q.node.p.slice() };
      let last = q.node.p; const put = (st, p) => {
        st.d = Math.max(10, Math.round(dist(last, p) * mmpt / 10) * 10); st._p = p.slice(); st.est = true;
        // 이 구간 위 용접점 위치 (0=앞 지점, 1=이 지점) — 엘보·플랜지가 바로 붙은 구간(배관 없음) 판정용
        const L = dist(last, p) || 1, v = [(p[0] - last[0]) / L, (p[1] - last[1]) / L];
        st._wd = (A.dots || []).map(d => { const t = ((d[0] - last[0]) * v[0] + (d[1] - last[1]) * v[1]) / L, o = Math.abs((d[0] - last[0]) * v[1] - (d[1] - last[1]) * v[0]); return o < 1.5 && t > -0.3 && t < 1.3 ? Math.round(t * 100) / 100 : null; }).filter(t => t != null).sort((x, y) => x - y);
        st._pt = Math.round(L * 10) / 10;
        last = p; steps.push(st); };
      let e = node.edges.find(x => !used.has(x) && (!prev || x !== prev));
      while (e) {
        used.add(e);
        const other = e.n0 === node ? e.n1 : e.n0, d = dirOf(node.p, other.p);
        if (!dir) { dir = d; run.dir = d; }
        else if (d !== dir) { put({ t: 'elbow', to: d, conf: 'low' }, node.p); dir = d; }
        // 구간 안 기호(진행 방향 순서)
        const fs = e.feats.map(f => ({ f, p: pt(e.l, f.s) })).sort((a, b) => dist(node.p, a.p) - dist(node.p, b.p));
        fs.forEach(({ f, p }) => put(f.t === 'flange' ? { t: 'flange', conf: 'low' } : f.t === 'reducer' ? { t: 'reducer', rt: 'conc', conf: 'low' } : Object.assign({ t: 'valve', vt: 'gate', conn: 'flg', conf: 'low' }, f.iso ? { vguess: f.vg || 'gate' } : {}), p));
        node = other;
        const rest = node.edges.filter(x => !used.has(x));
        if (!rest.length) {
          const st = { t: 'end', end: 'open', conf: 'low' };
          if ((A.caps || []).some(c => dist(c, node.p) < 6)) st.guess = 'cap';
          else if ((A.valves || []).some(v => dist(v, node.p) < 14)) st.guess = 'flange'; // 밸브 바로 끝 = 플랜지로 계기·장치에 연결
          put(st, node.p); break;
        }
        // 직진 우선, 나머지는 분기
        const straight = rest.find(x => dirOf(node.p, (x.n0 === node ? x.n1 : x.n0).p) === dir);
        const nextE = straight || rest[0];
        const others = rest.filter(x => x !== nextE);
        if (others.length) {
          const id = 'T' + (++tid), bd = dirOf(node.p, (others[0].n0 === node ? others[0].n1 : others[0].n0).p);
          if (straight) { put({ t: 'tee', id, branch: bd, conf: 'low' }, node.p); }
          else { const nd = dirOf(node.p, (nextE.n0 === node ? nextE.n1 : nextE.n0).p); put({ t: 'tee_in', id, run: nd, conf: 'low' }, node.p); dir = nd; }
          others.forEach((x, k) => { if (k === 0) queue.push({ node, from: nextE, start: { tee: id }, id: 'R' + (runs.length + queue.length + 2), only: x }); });
        }
        e = nextE;
      }
      runs.push(run);
    }
    // 각 run 의 tee 분기 시작은 "only" 구간부터 — 큐 처리에서 첫 edge 선택 보정
    return { line_no: '', title: '', nps: 4, cls: 150, notes: ['선 자동 추출 결과입니다. 거리는 도면상 길이로 어림한 값(노란 줄)이니 도면 치수로 바꿔 입력하세요. 꺾임·플랜지·밸브 위치와 종류, 빠진 티·레듀서도 확인해 주세요.'], runs: runs.filter(r => r.steps.length), auto: true, nStarts: cands.length, startIdx, cands: cands.map(n => n.p.slice()) };
  }

  async function extract(pdfjs, data) {
    const doc = await pdfjs.getDocument({ data }).promise, page = await doc.getPage(1);
    const pg = await readPage(pdfjs, page);
    const A = analyze(pg);
    const mm = 50 * 842 / pg.W, route = toRoute(A, mm);
    const snaps = []; A.pipes.forEach(l => { snaps.push(l.a, l.b); (l.feats || []).forEach(f => snaps.push(A.P(l, f.s))); });
    return { snaps, page: { W: pg.W, H: pg.H }, stats: { segs: pg.segs.length, fills: pg.fills.length, dots: A.dots.length, arrows: A.arrows.length, pipes: A.pipes.length }, pipes: A.pipes.map(l => ({ a: l.a, b: l.b, ax: l.ax, feats: (l.feats || []).map(f => ({ t: f.t, p: A.P(l, f.s) })) })), dots: A.dots, route, _A: A, _mm: mm, _pg: pg };
  }

  const reroute = (res, opt) => toRoute(res._A, res._mm, opt);
  const API = { extract, readPage, analyze, toRoute, reroute, AX };
  if (typeof module !== 'undefined' && module.exports) module.exports = API; else root.P3DVEC = API;
})(typeof window !== 'undefined' ? window : globalThis);
