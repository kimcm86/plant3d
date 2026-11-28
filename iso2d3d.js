/* PLANT 3D — ISO 도면 → 3D 변환
   1) AI(Claude API)가 도면 이미지를 읽어 "경로표(JSON)"를 만든다
   2) 사람이 확인표에서 고친다
   3) buildRoute()가 경로표를 3D 부품으로 만든다
   경로표 형식은 아래 SYS 프롬프트의 ROUTE FORMAT 과 같다. */
(function () {
  const P = window.P3D;
  if (!P) return;
  const AIK = 'p3d_ai';
  const API = 'https://api.anthropic.com/v1/messages';
  const MODELS = [
    ['claude-opus-5-5', 'Claude Opus 5.5 (정확도 우선, 권장)'],
    ['claude-sonnet-5-5', 'Claude Sonnet 5.5 (빠르고 저렴)'],
    ['claude-fable-5-2', 'Claude Fable 5.2 (가장 정밀, 비쌈)']
  ];
  const DIRS = ['+X', '-X', '+Y', '-Y', '+Z', '-Z'];
  // 방향 키 → 사람 말 (경사 방향 포함)
  const DN = { '+X': '동', '-X': '서', '+Z': '남', '-Z': '북', '+Y': '위', '-Y': '아래' };
  const dirName = k => (String(k || '').match(/[+-][XYZ]/g) || []).map(x => DN[x]).join('·') + (/[XYZ].*[XYZ]/.test(k) ? ' 사이' : '') || k;
  const DIRL = { '+X': '+X (오른쪽 아래)', '-X': '-X (왼쪽 위)', '+Y': '+Y (위)', '-Y': '-Y (아래)', '+Z': '+Z (왼쪽 아래)', '-Z': '-Z (오른쪽 위·북)' };
  const STEP = {
    elbow: '엘보 (꺾임)', flange: '플랜지 조인트', valve: '밸브', tee: '티 (분기)', tee_in: '티 (분기로 들어옴)',
    reducer: '레듀서', inst: '계기', equip: '장치 연결 (끝)', end: '끝'
  };
  const EQK = [['pump', '펌프'], ['vessel', '수직 베셀'], ['reactor', '반응기'], ['drum', '횡형 드럼'], ['hx', '열교환기']];
  const ENDS = [['open', '열린 끝/용접'], ['cap', '캡'], ['blind', '블라인드 플랜지'], ['flange', '플랜지 면']];
  const SIZES = P.SZ.map(s => s[0]);
  const E = P.EH;
  const cfg = () => { try { return JSON.parse(localStorage.getItem(AIK)) || {}; } catch (e) { return {}; } };
  const setCfg = c => { try { localStorage.setItem(AIK, JSON.stringify(c)); } catch (e) {} };
  const $ = id => document.getElementById(id);
  const nf = v => { const m = { 0.5: '1/2"', 0.75: '3/4"', 1.5: '1-1/2"', 2.5: '2-1/2"' }; return m[v] || (v + '"'); };

  /* ---------------- AI 지시문 ---------------- */
  const SYS = `You convert a piping isometric (ISO) drawing into a route description (JSON). A 3D piping editor builds the model from it automatically, and a person reviews it in a table.

AXES — map screen directions on the drawing to model axes exactly like this (ignore the north arrow):
- along the iso axis toward upper-left = "-X", toward lower-right = "+X"
- along the iso axis toward upper-right = "-Z", toward lower-left = "+Z"
- vertical up = "+Y", vertical down = "-Y"
Only these six directions exist. If something is drawn skewed/diagonal in plan, use the closest axis and explain in a note.

HOW TO READ
- Solid lines = piping of this drawing (existing:false). Dashed lines = existing piping (existing:true).
- Dimension numbers with arrows are lengths in mm between extension lines. Use them exactly. Dimensions are normally center-to-center between line ends / tie-in points, elbow corners (centerline intersections), tee centers, flange joints, valve centers.
- Flange joint symbol: two short parallel strokes or thin parallelograms across the pipe, often with a small ellipse → step "flange".
- Valves: bow-tie (two triangles) = gate unless the BOM says otherwise; globe = bow-tie with a filled dot; ball = bow-tie with a circle; check = triangle with a bar; butterfly = circle with a line; control valve = bow-tie with actuator dome/box (usually with an instrument bubble like LV/1002).
- Reducer: trapezoid, usually labeled like 4"X3" RED.CONC. or RED.ECC.
- "4"X3" RED.TEE." = tee with run 4" and branch 3".
- Black weld dots only mark butt welds; use them to locate fittings.
- Instrument bubble (circle with letters over a number, e.g. FT / 1001) at the end of a small connection → step "inst" with kind "FT" and tag "FT-1001".
- Read the line number (e.g. CW1001-4"-A1A-HC), title, size (from line number or BOM) and pressure class (e.g. 150# in the BOM). Use the BOM to confirm valve types, sizes and fittings.
- Small vents/drains (3/4", 1/2"): tee + short branch run with valve and cap/plug. Their length is usually not dimensioned: estimate 150–300 mm and set "conf":"low".

ROUTE FORMAT
The piping is described as runs. A run starts at a point, has a direction and walks along the pipe through steps. Each step has "d" = distance in mm from the PREVIOUS NODE along the current direction. The previous node is: the run start, the last elbow corner, flange joint center, tee center, valve center or reducer center.

{
 "line_no": "...", "title": "...", "nps": 4, "cls": 150,
 "notes": ["Korean sentences: everything uncertain, assumed or estimated"],
 "runs": [
  {"id":"R1","start":"origin","dir":"+Y","nps":4,"existing":false,"line_no":null,"steps":[ ... ]}
 ]
}
start:
 "origin" — only for the first run; choose a line end (normally the upstream end / tie-in point)
 {"tee":"T1"} — starts at the free side of tee T1 (its branch; for tee_in the other run side). The first d is measured from the tee CENTER.
 {"start_of":"R1"} — starts where run R1 starts, going the other way (e.g. existing pipe continuing below a tie-in point)
 {"end_of":"R1"} — starts where run R1 ends
 {"equip":{"kind":"vessel","tag":"V-101","nozzle":"N1"}} — only for the first run, when the line starts at an equipment nozzle; dir = direction leaving the nozzle
 {"nozzle":{"tag":"P-101A","n":"DIS"}} — starts at a nozzle of equipment already placed by an earlier run (e.g. pump discharge after the suction run ended at the pump)
Steps:
 {"t":"elbow","d":1200,"to":"-X"}  90° elbow, corner at d, new direction "to" (perpendicular)
 {"t":"flange","d":4000}  flange joint (2 flanges + gasket) centered at d
 {"t":"valve","d":500,"vt":"gate","conn":"flg"}  valve centered at d. vt: gate|globe|ball|check|butterfly|plug|ctrl. conn: flg (flanged, mating flanges added) | bw (butt weld, socket weld or threaded small bore). Optional "tag" for control valves, e.g. "LV-1002".
 {"t":"tee","d":150,"id":"T1","branch":"+Z","nps2":0.75}  tee centered at d; run goes straight on; branch direction "branch"
 {"t":"tee_in","d":1500,"id":"T2","run":"-Z","nps_run":6}  we arrive through the tee's branch and continue along "run"; the opposite run side can start another run with {"tee":"T2"}
 {"t":"reducer","d":300,"nps2":3,"rt":"conc"}  reducer centered at d (rt conc|ecc); size becomes nps2
 {"t":"inst","d":150,"kind":"FT","tag":"FT-1001"}  instrument at d (ends the run)
 {"t":"equip","d":1500,"kind":"pump","tag":"P-101A","nozzle":"SUC","nps2":3}  the run ends at an equipment nozzle flange (d = to the nozzle flange face). kind: pump|vessel|reactor|drum|hx. Pump nozzles: SUC (suction, horizontal) and DIS (discharge, vertical up); nps2 = the pump's other nozzle size. Vessels/drums/exchangers: use the nozzle name drawn (N1, N2 ...). Equipment is often drawn as an outline or only named at the line end (e.g. "TO P-101A SUCTION", "FROM V-101 N3") — use that.
 {"t":"end","d":1000,"end":"open"}  end of run at d. end: open (weld/continuation) | cap | blind (flange + blind flange) | flange (open flange face)
Optional on any step: "conf":"low" when estimated, "note":"Korean text".
Sizes are NPS in inches as numbers: 0.5, 0.75, 1, 1.5, 2, 3, 4, 6, 8, 10, 12 ...

RULES
- Every run ends with an "end" or "inst" step.
- Keep the geometry consistent: closed loops must close with the given dimensions.
- Do not invent parts that are not drawn; do not drop drawn parts.
- Existing (dashed) piping: include only what is drawn, existing:true, estimated distances with "conf":"low".
- If a line connects to a pump, vessel, drum, exchanger or reactor, end the run with an "equip" step (or start with "equip"/"nozzle") so the equipment is placed in 3D.
- Answer: first a short Korean summary (3–5 lines), then exactly ONE \`\`\`json block containing the object. Nothing after it.`;

  /* ---------------- 경로표 → 3D 부품 ---------------- */
  function buildRoute(R, src) {
    const out = [], errs = [], cnt = {};
    let id = 1;
    const LN = R.line_no || '';
    const R1 = v => v.map(x => Math.round(x * 10) / 10);
    const add3 = (p, k, s) => { const d = P.DIR[k]; return [p[0] + d.x * s, p[1] + d.y * s, p[2] + d.z * s]; };
    const neg = k => P.keyOf(P.DIR[k].clone().negate());
    const perp = (a, b) => Math.abs(P.DIR[a].dot(P.DIR[b])) < 0.01;
    let base = {};
    const mk = (type, ex) => {
      const o = Object.assign({ id: id++, type, status: '미착수', note: '' }, JSON.parse(JSON.stringify(P.DEF[type])), { cls: +R.cls || 150 }, base, ex);
      if (ex.tag) o.tag = ex.tag; else { cnt[type] = (cnt[type] || 0) + 1; o.tag = P.T[type].p + '-' + String(cnt[type]).padStart(3, '0'); }
      if (['elbow', 'tee', 'cap', 'coupling'].includes(type) && o.ce == null) o.ce = [.5, .75, 1, 1.5, 2].includes(+o.nps) ? (R.ce || 'sw') : 'bw'; // 2" 이하 이음 방식
      if (['valve', 'flange', 'tee', 'reducer', 'cap', 'coupling'].includes(type) && ex.len == null) o.len = P.dflen(o);
      if (o.pos) o.pos = R1(o.pos);
      if (src) o.src = src;
      out.push(o);
      return o;
    };
    const tees = {}, runs = {}, equips = {};
    const EQT = ['pump', 'vessel', 'reactor', 'drum', 'hx'];
    function placeEquip(q, J, out, npsHere, ri, si) {
      const kind = EQT.includes(q.kind) ? q.kind : 'vessel', tag = q.tag || (P.T[kind].p + '-?');
      const ovv = P.DIR[out], ang = Math.round(Math.atan2(-ovv.z, ovv.x) * 180 / Math.PI);
      let o = equips[tag], name;
      if (o) {
        name = q.nozzle || 'N' + ((o.nz || []).length + 1);
        const pt = P.ports(o).find(x => x.n === name);
        if (!pt || Math.hypot(pt.p[0] - J[0], pt.p[1] - J[1], pt.p[2] - J[2]) > 5) errs.push({ ri, si, msg: tag + ' 는 이미 배치됨: 두 번째 배관은 시작을 "장치 노즐에서"로 하세요' });
        return o;
      }
      const sv = base; base = { ln: '' };
      o = mk(kind, { pos: [0, 0, 0], tag });
      base = sv;
      if (kind === 'pump') {
        const dis = /^d/i.test(q.nozzle || '');
        name = dis ? 'DIS' : 'SUC';
        if (dis) { if (out !== '+Y') errs.push({ ri, si, msg: '펌프 토출(DIS)은 위(+Y)로만 연결할 수 있습니다' }); o.nps2 = npsHere; o.nps = +q.nps2 || npsHere; o.rot = +q.rot || 0; }
        else { if (Math.abs(ovv.y) > .5) errs.push({ ri, si, msg: '펌프 흡입(SUC)은 수평 방향이어야 합니다' }); o.nps = npsHere; o.nps2 = +q.nps2 || (P.SZ[Math.max(0, P.SZ.findIndex(z => z[0] == npsHere) - 1)] || [npsHere])[0]; o.rot = ang; }
      } else if (kind === 'vessel' || kind === 'reactor') {
        name = q.nozzle || 'N1';
        const z = { n: name, nps: npsHere, cls: +R.cls || 150, len: 250 };
        if (out === '+Y') z.k = 'A'; else if (out === '-Y') z.k = 'B'; else { z.k = 'radial'; z.a = Math.round(Math.atan2(ovv.z, ovv.x) * 180 / Math.PI); z.p = Math.round(o.h * 0.5); }
        o.nz = [z];
      } else {
        name = q.nozzle || 'N1';
        const z = { n: name, nps: npsHere, cls: +R.cls || 150, len: 250 };
        if (Math.abs(ovv.y) > .5) { z.k = 'radial'; z.a = ovv.y > 0 ? 0 : 180; z.p = 0; o.rot = 0; } else { z.k = 'A'; o.rot = ang; }
        o.nz = [z];
      }
      const pt = P.ports(o).find(x => x.n === name);
      o.pos = R1([J[0] - pt.p[0], J[1] - pt.p[1], J[2] - pt.p[2]]);
      if (q.note) o.note = q.note;
      equips[tag] = o;
      return o;
    }
    const runsIn = (R.runs || []).filter(r => r && Array.isArray(r.steps));

    function doRun(r, ri) {
      const s = r.start || 'origin';
      let P0, cen, dir = r.dir, nps = +r.nps || +R.nps || 4;
      if (s === 'origin' || (s && s.xyz)) { P0 = (s && s.xyz) || [0, 1000, 0]; cen = P0; }
      else if (s.tee) { const t = tees[s.tee]; if (!t) return false; P0 = t.free; cen = t.center; dir = dir || t.freeDir; if (!r.nps) nps = t.freeNps; }
      else if (s.start_of) { const q = runs[s.start_of]; if (!q) return false; P0 = q.start; cen = P0; }
      else if (s.end_of) { const q = runs[s.end_of]; if (!q) return false; P0 = q.end; cen = P0; }
      else if (s.equip) { P0 = s.equip.xyz || [0, 1000, 0]; cen = P0; }
      else if (s.nozzle) { const o = equips[s.nozzle.tag]; if (!o) return false; const pt = P.ports(o).find(x => x.n === s.nozzle.n); if (!pt) { errs.push({ ri, si: -1, msg: s.nozzle.tag + ' 에 ' + s.nozzle.n + ' 노즐이 없음' }); return true; } P0 = pt.p.slice(); cen = P0; dir = P.keyOf(pt.d); if (!r.nps) nps = pt.nps; }
      else { errs.push({ ri, si: -1, msg: '시작 위치를 알 수 없음' }); return true; }
      if (!P.DIR[dir]) { errs.push({ ri, si: -1, msg: '시작 방향이 없음' }); return true; }
      base = { ln: r.line_no || LN };
      if (r.existing) base.ex = true;
      const st = { cen: P0.slice(), cur: P0.slice(), dir, nps };
      r._c0 = P0.slice(); r._d0 = dir; r._nps0 = nps; // 3D 위치 기록 (장 잇기·좌표 맞춤용)
      if (s.equip || s.nozzle) {
        if (s.equip) placeEquip(s.equip, P0, dir, nps, ri, -1);
        const f = mk('flange', { pos: R1(add3(P0, dir, P.HGx(+R.cls || 150, 'RF', nps))), axis: dir, nps, kind: 'wn', face: 'RF' });
        st.cur = add3(f.pos, dir, f.len);
      } else if (r.startFl) { // 시작 끝의 플랜지 (다른 장·장치와 맞대는 면)
        const f = mk('flange', { pos: R1(add3(P0, dir, P.HGx(+R.cls || 150, 'RF', nps))), axis: dir, nps, kind: 'wn', face: 'RF', ext: true });
        st.cur = add3(f.pos, dir, f.len);
      }
      const pipeTo = (pt, si) => {
        const d = P.DIR[st.dir];
        const L = (pt[0] - st.cur[0]) * d.x + (pt[1] - st.cur[1]) * d.y + (pt[2] - st.cur[2]) * d.z;
        if (L < -1) errs.push({ ri, si, msg: '앞 부품과 ' + Math.round(-L) + 'mm 겹침 (거리를 늘리세요)' });
        if (L > 0.5) mk('pipe', { pos: st.cur, axis: st.dir, len: Math.round(L * 10) / 10, nps: st.nps });
      };
      const flangePair = (J, d, kind2) => {
        const pr = { nps: st.nps, kind: 'wn', face: 'RF' }, h = P.HGx(+R.cls || 150, 'RF', st.nps);
        const f1 = mk('flange', Object.assign({ pos: [0, 0, 0], axis: neg(d) }, pr));
        f1.pos = R1(add3(J, d, -h));
        const back = add3(f1.pos, neg(d), f1.len);
        const f2 = kind2 === null ? null : mk('flange', Object.assign({ pos: R1(add3(J, d, h)), axis: d }, pr, kind2 ? { kind: kind2 } : {}));
        if (f2 && kind2) f2.len = P.dflen(f2);
        return { back, after: f2 ? add3(f2.pos, d, f2.len) : J };
      };
      let ended = false;
      (r.steps || []).forEach((p, si) => {
        const n0 = out.length;
        if (ended) { errs.push({ ri, si, msg: '끝 다음에 있는 항목은 무시됨' }); return; }
        const D = +p.d || 0, d = st.dir, C = add3(st.cen, d, D);
        p._c = C; p._din = d; p._nps = st.nps;
        switch (p.t) {
          case 'elbow': {
            if (!P.DIR[p.to]) { errs.push({ ri, si, msg: '꺾이는 방향이 없음' }); return; }
            const dt = P.DIR[d].dot(P.DIR[p.to]);
            let t;
            if (Math.abs(dt) < 0.01) t = mk('elbow', { pos: [0, 0, 0], axis: d, turn: p.to, nps: st.nps });
            else if (dt > 0.02 && dt < 0.999) { // 90°가 아닌 꺾임 (경사 배관) — 45°는 45° 엘보, 그 밖은 각도 맞춤 엘보
              const tv = P.DIR[p.to].clone().addScaledVector(P.DIR[d], -dt).normalize(), an = Math.acos(dt) * 180 / Math.PI;
              t = mk('elbow', Object.assign({ pos: [0, 0, 0], axis: d, turn: P.keyOf(tv), nps: st.nps }, Math.abs(an - 45) < 0.3 ? { kind: 'lr45' } : { kind: 'lr90', ang: Math.round(an * 10) / 10 }));
            } else { errs.push({ ri, si, msg: '꺾이는 각도가 90°보다 큼 (되돌아감)' }); return; }
            const e = P.eg(t), k = e.R * Math.tan(e.th / 2);
            t.pos = R1(add3(C, d, -k)); pipeTo(t.pos, si);
            st.cur = add3(C, p.to, k); st.cen = C; st.dir = p.to; break;
          }
          case 'flange': {
            const f = flangePair(C, d); pipeTo(f.back, si);
            st.cur = f.after; st.cen = C; break;
          }
          case 'valve': {
            const vt = p.vt || 'gate', conn = p.conn === 'bw' ? 'bw' : 'flg';
            const vn = +p.vnps || st.nps; // 밸브가 배관보다 작을 수 있음 (예: 3/4" 배관에 1/2" 밸브)
            const ex = { pos: [0, 0, 0], axis: d, nps: vn, vt, conn, face: 'RF' };
            if (p.tag) ex.tag = p.tag;
            const v = mk('valve', ex);
            v.len = P.dflen(v);
            const wafer = ['butterfly', 'wcheck'].includes(vt);
            v.pos = R1(add3(C, d, -v.len / 2));
            if (conn === 'flg') {
              const h = P.HGx(+R.cls || 150, 'RF', vn), pr = { nps: vn, kind: 'wn', face: 'RF' };
              const g = wafer ? 0 : h;
              const f1 = mk('flange', Object.assign({ pos: R1(add3(v.pos, d, -g - h)), axis: neg(d) }, pr));
              pipeTo(add3(f1.pos, neg(d), f1.len), si);
              const f2 = mk('flange', Object.assign({ pos: R1(add3(v.pos, d, v.len + g + h)), axis: d }, pr));
              st.cur = add3(f2.pos, d, f2.len);
            } else { pipeTo(v.pos, si); st.cur = add3(v.pos, d, v.len); }
            st.cen = C; break;
          }
          case 'tee': {
            const bd = p.branch;
            if (!DIRS.includes(bd) || !perp(d, bd)) { errs.push({ ri, si, msg: '분기 방향이 현재 방향과 직각이 아님' }); return; }
            const n2 = +p.nps2 || st.nps;
            const t = mk('tee', { pos: [0, 0, 0], axis: d, branch: bd, nps: st.nps, nps2: n2 });
            const h = t.len / 2; t.pos = R1(add3(C, d, -h)); pipeTo(t.pos, si);
            st.cur = add3(C, d, h); st.cen = C;
            if (p.id) tees[p.id] = { center: C, free: add3(C, bd, h), freeDir: bd, freeNps: n2 };
            break;
          }
          case 'tee_in': {
            const rd = p.run;
            if (!DIRS.includes(rd) || !perp(d, rd)) { errs.push({ ri, si, msg: '티 진행 방향이 현재 방향과 직각이 아님' }); return; }
            const nr = +p.nps_run || st.nps;
            const t = mk('tee', { pos: [0, 0, 0], axis: rd, branch: neg(d), nps: nr, nps2: st.nps });
            const h = t.len / 2; t.pos = R1(add3(C, rd, -h));
            pipeTo(add3(C, d, -h), si);
            st.cur = add3(C, rd, h); st.cen = C; st.dir = rd; st.nps = nr;
            if (p.id) tees[p.id] = { center: C, free: add3(C, rd, -h), freeDir: neg(rd), freeNps: nr };
            break;
          }
          case 'reducer': {
            const n2 = +p.nps2 || st.nps;
            const rd = mk('reducer', { pos: [0, 0, 0], axis: d, nps: st.nps, nps2: n2, rt: p.rt === 'ecc' ? 'fob' : 'conc' });
            rd.pos = R1(add3(C, d, -rd.len / 2)); pipeTo(rd.pos, si);
            const ep = P.ports(rd)[0].p, ax = add3(rd.pos, d, rd.len), sh = [ep[0] - ax[0], ep[1] - ax[1], ep[2] - ax[2]];
            st.cur = ep.slice(); st.cen = [C[0] + sh[0], C[1] + sh[1], C[2] + sh[2]]; st.nps = n2; break;
          }
          case 'inst': {
            pipeTo(C, si);
            mk('inst', { pos: C, axis: d, nps: st.nps, kind: p.kind || 'FT', tag: p.tag || ((p.kind || 'FT') + '-?') });
            st.cur = C; st.cen = C; ended = true; break;
          }
          case 'equip': {
            const h = P.HGx(+R.cls || 150, 'RF', st.nps);
            const f1 = mk('flange', { pos: R1(add3(C, d, -h)), axis: neg(d), nps: st.nps, kind: 'wn', face: 'RF' });
            pipeTo(add3(f1.pos, neg(d), f1.len), si);
            placeEquip(p, C, neg(d), st.nps, ri, si);
            st.cur = C; st.cen = C; ended = true; break;
          }
          case 'end': {
            const en = p.end || 'open';
            if (en === 'blind' || en === 'flange') {
              const h = P.HGx(+R.cls || 150, 'RF', st.nps), pr = { nps: st.nps, kind: 'wn', face: 'RF' };
              const f1 = mk('flange', Object.assign({ pos: R1(add3(C, d, -h)), axis: neg(d) }, pr, en === 'flange' ? { ext: true } : {}));
              pipeTo(add3(f1.pos, neg(d), f1.len), si);
              if (en === 'blind') { const b = mk('flange', Object.assign({ pos: R1(add3(C, d, h)), axis: d }, pr, { kind: 'bl' })); b.len = P.dflen(b); }
            } else {
              pipeTo(C, si);
              if (en === 'cap') mk('cap', { pos: C, axis: d, nps: st.nps });
            }
            st.cur = C; st.cen = C; ended = true; break;
          }
          default: errs.push({ ri, si, msg: '알 수 없는 종류: ' + p.t });
        }
        if (p.note) out.slice(n0).filter(o => o.type !== 'pipe' && !EQT.includes(o.type)).forEach(o => { o.note = p.note; });
      });
      if (!ended) errs.push({ ri, si: -1, msg: '끝(end) 항목이 없어 마지막 부품에서 끝남' });
      runs[r.id || ('R' + (ri + 1))] = { start: P0, end: st.cur };
      return true;
    }
    let left = runsIn.map((r, i) => i), guard = 0;
    while (left.length && guard++ < 50) {
      const next = left.filter(i => !doRun(runsIn[i], i));
      if (next.length === left.length) break;
      left = next;
    }
    left.forEach(i => errs.push({ ri: i, si: -1, msg: '시작점(티/다른 라인)을 찾지 못해 만들지 못함' }));
    const dm = { title: R.title || '', nt: (R.notes || []).join(' ') };
    return { name: R.title || R.line_no || 'ISO 변환 모델', ln: LN, objs: out, cnt, dm, errs };
  }

  /* ---------------- 도면 이미지 준비 (전체 1장 + 4등분 확대 4장) ---------------- */
  async function pageCanvas(f, width) {
    const cv = document.createElement('canvas');
    if (f.type.startsWith('image/')) {
      const im = new Image(), u = URL.createObjectURL(f.blob);
      await new Promise((a, b) => { im.onload = a; im.onerror = b; im.src = u; });
      cv.width = Math.round(im.width * Math.min(2, width / im.width));
      cv.height = Math.round(im.height * cv.width / im.width);
      const g = cv.getContext('2d'); g.fillStyle = '#fff'; g.fillRect(0, 0, cv.width, cv.height); g.drawImage(im, 0, 0, cv.width, cv.height);
      URL.revokeObjectURL(u);
    } else {
      const L = await P.pdfLib(), pdf = await L.getDocument({ data: new Uint8Array(await f.blob.arrayBuffer()) }).promise;
      const pg = await pdf.getPage(1), v0 = pg.getViewport({ scale: 1 }), v = pg.getViewport({ scale: width / v0.width });
      cv.width = Math.round(v.width); cv.height = Math.round(v.height);
      const g = cv.getContext('2d'); g.fillStyle = '#fff'; g.fillRect(0, 0, cv.width, cv.height);
      await pg.render({ canvasContext: g, viewport: v }).promise;
    }
    return cv;
  }
  function crop(src, x, y, w, h, maxEdge) {
    const k = Math.min(1, maxEdge / Math.max(w, h)), c = document.createElement('canvas');
    c.width = Math.round(w * k); c.height = Math.round(h * k);
    const g = c.getContext('2d'); g.fillStyle = '#fff'; g.fillRect(0, 0, c.width, c.height);
    g.drawImage(src, x, y, w, h, 0, 0, c.width, c.height);
    return c.toDataURL('image/png').split(',')[1];
  }
  async function tiles(f) {
    const big = await pageCanvas(f, 5152), W = big.width, H = big.height, tw = Math.round(W * 0.54), th = Math.round(H * 0.54);
    const out = [crop(big, 0, 0, W, H, 2576)];
    [[0, 0], [W - tw, 0], [0, H - th], [W - tw, H - th]].forEach(([x, y]) => out.push(crop(big, x, y, tw, th, 2576)));
    return out;
  }

  /* ---------------- AI 호출 ---------------- */
  async function aiRead(f, say) {
    const c = cfg();
    if (!c.key) throw new Error('NOKEY');
    say('도면 이미지를 준비하는 중…');
    const imgs = await tiles(f);
    say('AI가 도면을 읽는 중… (보통 1~3분 걸립니다)');
    const content = [{ type: 'text', text: '이미지 1: 도면 전체. 이미지 2~5: 같은 도면을 4등분해 확대한 것 (왼쪽 위, 오른쪽 위, 왼쪽 아래, 오른쪽 아래 순서, 서로 조금씩 겹침). 작은 치수 글자는 확대 이미지에서 읽으세요.' }]
      .concat(imgs.map(b => ({ type: 'image', source: { type: 'base64', media_type: 'image/png', data: b } })))
      .concat([{ type: 'text', text: '이 ISO 도면을 규칙에 맞는 JSON 경로표로 변환해 주세요. 파일명: ' + f.name }]);
    const res = await fetch(API, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-api-key': c.key, 'anthropic-version': '2023-06-01', 'anthropic-dangerous-direct-browser-access': 'true' },
      body: JSON.stringify({ model: c.model || MODELS[0][0], max_tokens: 32000, system: SYS, messages: [{ role: 'user', content }] })
    });
    const txt0 = await res.text();
    if (!res.ok) {
      let m = txt0; try { m = JSON.parse(txt0).error.message; } catch (e) {}
      throw new Error('API 오류 ' + res.status + ': ' + m);
    }
    const j = JSON.parse(txt0);
    const txt = (j.content || []).filter(b => b.type === 'text').map(b => b.text).join('\n');
    const m = txt.match(/```json\s*([\s\S]*?)```/) || txt.match(/(\{[\s\S]*\})\s*$/);
    if (!m) throw new Error('AI 응답에서 경로표(JSON)를 찾지 못했습니다.');
    const route = JSON.parse(m[1]);
    route.summary = txt.split('```')[0].trim();
    route.usage = j.usage || null;
    route.model = j.model || c.model;
    return route;
  }

  /* ---------------- 화면: AI 설정 ---------------- */
  function settings() {
    const c = cfg();
    P.ov('AI 설정 (도면 자동 판독)', `<div style="max-width:640px">
<p>ISO 도면을 자동으로 읽으려면 Anthropic API 키가 필요합니다. 키는 <b>이 기기의 이 브라우저에만</b> 저장되고, 도면 이미지는 판독할 때만 Anthropic API로 직접 전송됩니다. 사용량만큼 요금이 나옵니다 (도면 1장 대략 수백 원 수준, 모델에 따라 다름).</p>
<p class="mut">키 발급: console.anthropic.com → API Keys. 회사 도면을 외부 AI 서비스로 보내도 되는지 사내 규정을 먼저 확인하세요.</p>
<div class="f"><label>API 키</label><input id="aik" type="password" autocomplete="off" placeholder="sk-ant-..." value="${E(c.key || '')}" style="width:100%"></div>
<div class="f"><label>모델</label><select id="aim">${MODELS.map(([k, l]) => `<option value="${k}"${(c.model || MODELS[0][0]) === k ? ' selected' : ''}>${l}</option>`).join('')}</select></div>
<div class="row"><button class="pri" id="aisv">저장</button><button id="aidel">키 지우기</button><button data-att="back">← 첨부 목록</button></div><div id="aims" class="mut"></div></div>`);
    $('iso3').hidden = true; $('isop').hidden = true;
    $('aisv').onclick = () => { setCfg({ key: $('aik').value.trim(), model: $('aim').value }); $('aims').textContent = '저장했습니다.'; };
    $('aidel').onclick = () => { setCfg({ model: $('aim').value }); $('aik').value = ''; $('aims').textContent = '키를 지웠습니다.'; };
  }

  /* ---------------- 화면: 변환 진행 ---------------- */
  let busy = false;
  async function convert(fid) {
    if (busy) return;
    const f = (await P.fAll()).find(x => x.id === fid);
    if (!f) return;
    if (!cfg().key) { settings(); $('aims').textContent = '먼저 API 키를 저장해 주세요.'; return; }
    P.ov('AI 판독 — ' + f.name, `<div class="row"><b id="aist">준비 중…</b></div><p class="mut">창을 닫지 마세요. 판독이 끝나면 확인표가 열립니다.</p>`);
    $('iso3').hidden = true; $('isop').hidden = true;
    busy = true;
    try {
      const route = await aiRead(f, t => { const el = $('aist'); if (el) el.textContent = t; });
      f.route = route; f.routeAt = Date.now();
      await P.fPut(f);
      P.lg('AI 도면 판독: ' + f.name + ' (' + (route.runs || []).length + '개 구간)');
      table(fid);
    } catch (e) {
      const msg = e.message === 'NOKEY' ? 'API 키가 없습니다.' : e.message;
      P.ov('AI 판독 실패 — ' + f.name, `<p>${E(msg)}</p><p class="mut">네트워크, API 키, 사용량 한도를 확인해 주세요. 확인표에 직접 입력해서 만들 수도 있습니다.</p><div class="row"><button data-att="back">← 첨부 목록</button><button id="tryman">이 도면으로 빈 확인표 열기</button></div>`);
      $('iso3').hidden = true; $('isop').hidden = true;
      const b = $('tryman'); if (b) b.onclick = () => { f.route = blank(); P.fPut(f).then(() => table(fid)); };
    } finally { busy = false; }
  }

  /* ---------------- 화면: 확인표 ---------------- */
  const blank = () => ({ line_no: '', title: '', nps: 4, cls: 150, notes: [], runs: [{ id: 'R1', start: 'origin', dir: '+Y', nps: 4, existing: false, steps: [{ t: 'end', d: 1000, end: 'open' }] }] });
  let T = null; // {fid, f, R}
  const opt = (arr, v) => arr.map(a => { const [k, l] = Array.isArray(a) ? a : [a, a]; return `<option value="${E(k)}"${String(k) === String(v) ? ' selected' : ''}>${E(l)}</option>`; }).join('');
  const startVal = s => !s || s === 'origin' ? 'origin' : s.equip ? 'equip' : s.nozzle ? 'nozzle:' + s.nozzle.tag : s.tee ? 'tee:' + s.tee : s.start_of ? 'start_of:' + s.start_of : s.end_of ? 'end_of:' + s.end_of : 'origin';
  const parseStart = (v, old) => { if (v === 'origin') return 'origin'; if (v === 'equip') return { equip: (old && old.equip) || { kind: 'vessel', tag: 'V-001', nozzle: 'N1' } }; const [k, x] = v.split(':'); if (k === 'nozzle') return { nozzle: { tag: x, n: (old && old.nozzle && old.nozzle.n) || 'DIS' } }; return { [k]: x }; };

  function rowHtml(ri, si, p, err) {
    const t = p.t, c = (k, html) => `<td>${html}</td>`, inp = (k, v, w) => `<input data-s="${ri}.${si}.${k}" value="${E(v == null ? '' : v)}" style="width:${w || 70}px">`;
    const sel = (k, arr, v) => `<select data-s="${ri}.${si}.${k}">${opt(arr, v)}</select>`;
    let extra = '';
    if (t === 'elbow') extra = '새 방향 ' + sel('to', DIRS.map(d => [d, DIRL[d]]), p.to);
    else if (t === 'valve') extra = sel('vt', Object.entries(P.VT), p.vt || 'gate') + ' ' + sel('conn', [['flg', '플랜지'], ['bw', '용접/소구경']], p.conn || 'flg') + ' 태그 ' + inp('tag', p.tag, 80);
    else if (t === 'tee') extra = 'ID ' + inp('id', p.id, 40) + ' 분기 ' + sel('branch', DIRS.map(d => [d, DIRL[d]]), p.branch) + ' 분기 사이즈 ' + sel('nps2', SIZES.map(v => [v, nf(v)]), p.nps2);
    else if (t === 'tee_in') extra = 'ID ' + inp('id', p.id, 40) + ' 진행 ' + sel('run', DIRS.map(d => [d, DIRL[d]]), p.run) + ' 주관 사이즈 ' + sel('nps_run', SIZES.map(v => [v, nf(v)]), p.nps_run);
    else if (t === 'reducer') extra = sel('rt', [['conc', '동심(CONC)'], ['ecc', '편심(ECC)']], p.rt || 'conc') + ' → ' + sel('nps2', SIZES.map(v => [v, nf(v)]), p.nps2);
    else if (t === 'inst') extra = sel('kind', P.IK, p.kind || 'FT') + ' 태그 ' + inp('tag', p.tag, 90);
    else if (t === 'end') extra = sel('end', ENDS, p.end || 'open');
    else if (t === 'equip') extra = sel('kind', EQK, p.kind || 'pump') + ' 태그 ' + inp('tag', p.tag, 80) + ' 노즐 ' + inp('nozzle', p.nozzle || (p.kind === 'pump' || !p.kind ? 'SUC' : 'N1'), 50) + (p.kind === 'pump' || !p.kind ? ' 다른 노즐 ' + sel('nps2', [['', '(자동)']].concat(SIZES.map(v => [v, nf(v)])), p.nps2 || '') : '');
    return `<tr class="${p.conf === 'low' ? 'low' : ''}${err ? ' err' : ''}"><td>${si + 1}</td>${c('t', sel('t', Object.entries(STEP), t))}${c('d', inp('d', p.d, 64))}<td>${extra}</td>${c('note', inp('note', p.note, 140))}<td class="nw"><button data-tr="up" data-ri="${ri}" data-si="${si}" title="위로">↑</button><button data-tr="dn" data-ri="${ri}" data-si="${si}" title="아래로">↓</button><button data-tr="ins" data-ri="${ri}" data-si="${si}" title="아래에 추가">＋</button><button data-tr="del" data-ri="${ri}" data-si="${si}" title="삭제">✕</button></td></tr>${err ? `<tr class="err"><td></td><td colspan="5">⚠ ${E(err)}</td></tr>` : ''}`;
  }

  function render(errs) {
    const ob = $('isoback'); if (ob) ob.remove();
    const R = T.R, em = {};
    if (!Array.isArray(R.runs)) R.runs = [];
    R.runs.forEach(r => { if (!Array.isArray(r.steps)) r.steps = []; });
    (errs || []).forEach(e => { em[e.ri + '.' + e.si] = (em[e.ri + '.' + e.si] ? em[e.ri + '.' + e.si] + ' / ' : '') + e.msg; });
    const teeIds = [], runIds = R.runs.map(r => r.id);
    const eqTags = [];
    R.runs.forEach(r => { if (r.start && r.start.equip && r.start.equip.tag) eqTags.push(r.start.equip.tag); r.steps.forEach(p => { if ((p.t === 'tee' || p.t === 'tee_in') && p.id) teeIds.push(p.id); if (p.t === 'equip' && p.tag && !eqTags.includes(p.tag)) eqTags.push(p.tag); }); });
    const startOpts = [['origin', '원점 (첫 구간)'], ['equip', '장치에서 시작 (첫 구간)']].concat(eqTags.map(t => ['nozzle:' + t, t + ' 노즐에서'])).concat(teeIds.map(i => ['tee:' + i, '티 ' + i + ' 에서'])).concat(runIds.flatMap(i => [['start_of:' + i, i + ' 시작점에서 (반대 방향)'], ['end_of:' + i, i + ' 끝점에서']]));
    const lowN = R.runs.reduce((a, r) => a + r.steps.filter(p => p.conf === 'low').length, 0);
    const h = `
  <div class="row"><button data-att="back">← 첨부 목록</button><span style="flex:1"></span><button data-tr="build" class="pri">3D에 반영</button><button data-tr="iso">ISO 보기</button><button data-tr="show">3D에서 보기</button></div>
  <div id="tbmsg" class="mut"></div>
  ${R.summary ? `<details open><summary>AI 판독 요약${R.model ? ' (' + E(R.model) + ')' : ''}</summary><div class="mut" style="white-space:pre-wrap">${E(R.summary)}</div></details>` : ''}
  ${(R.notes || []).length ? `<div class="notes"><b>확인이 필요한 부분</b><ul>${R.notes.map(n => `<li>${E(n)}</li>`).join('')}</ul></div>` : ''}
  ${lowN ? `<div class="mut">노란 줄 ${lowN}개는 추정값(AI 판독·자동 추출·클릭 어림)입니다. 도면 치수와 비교해 고쳐 주세요.</div>` : ''}
  <div class="row tbh"><label>라인 번호 <input data-h="line_no" value="${E(R.line_no || '')}" style="width:220px"></label><label>제목 <input data-h="title" value="${E(R.title || '')}" style="width:220px"></label><label>기본 사이즈 <select data-h="nps">${opt(SIZES.map(v => [v, nf(v)]), R.nps || 4)}</select></label><label>Class <select data-h="cls">${opt([150, 300, 400, 600, 900, 1500, 2500], R.cls || 150)}</select></label></div>
  ${R.runs.map((r, ri) => `<div class="run${r.existing ? ' exr' : ''}">
   <div class="row"><b>${E(r.id || 'R' + (ri + 1))}</b>
    <label>시작 <select data-r="${ri}.start">${opt(startOpts, startVal(r.start))}</select></label>${r.start && r.start.equip ? `<label>장치 <select data-r="${ri}.start.kind">${opt(EQK, r.start.equip.kind)}</select></label><label>태그 <input data-r="${ri}.start.tag" value="${E(r.start.equip.tag || '')}" style="width:80px"></label><label>노즐 <input data-r="${ri}.start.nozzle" value="${E(r.start.equip.nozzle || '')}" style="width:50px"></label>` : ''}${r.start && r.start.nozzle ? `<label>노즐 <input data-r="${ri}.start.n" value="${E(r.start.nozzle.n || '')}" style="width:50px"></label>` : ''}
    <label>방향 <select data-r="${ri}.dir">${opt([['', '(티 방향 따름)']].concat(DIRS.map(d => [d, DIRL[d]])), r.dir || '')}</select></label>
    <label>사이즈 <select data-r="${ri}.nps">${opt([['', '(이어받음)']].concat(SIZES.map(v => [v, nf(v)])), r.nps || '')}</select></label>
    <label><input type="checkbox" data-r="${ri}.existing"${r.existing ? ' checked' : ''}> 기존 배관</label>
    <label>라인번호 <input data-r="${ri}.line_no" value="${E(r.line_no || '')}" placeholder="(위와 같음)" style="width:170px"></label>
    <span style="flex:1"></span><button data-tr="rdel" data-ri="${ri}">구간 삭제</button></div>
   ${em[ri + '.-1'] ? `<div class="errm">⚠ ${E(em[ri + '.-1'])}</div>` : ''}
   <table class="tbt"><tr><th>#</th><th>종류</th><th>거리 mm</th><th>내용</th><th>메모</th><th></th></tr>
   ${r.steps.map((p, si) => rowHtml(ri, si, p, em[ri + '.' + si])).join('')}</table>
   <div class="row"><button data-tr="add" data-ri="${ri}">＋ 항목 추가</button></div></div>`).join('')}
  <div class="row"><button data-tr="radd">＋ 구간(Run) 추가</button></div>
  <details><summary>거리 입력 규칙</summary><div class="mut">각 항목의 거리는 <b>바로 앞 기준점</b>(구간 시작점, 앞 엘보 꺾이는 점, 플랜지 조인트 중심, 티 중심, 밸브 중심, 레듀서 중심)부터 잰 값입니다. 도면 치수를 그대로 넣으면 됩니다. 방향은 도면 화면 기준: 왼쪽 위 = -X, 오른쪽 아래 = +X, 오른쪽 위 = -Z, 왼쪽 아래 = +Z, 위 = +Y, 아래 = -Y.</div></details>`;
    const key = T.src;
    if (!$('tbr') || T.shown !== key || !document.getElementById('iso') || document.getElementById('iso').hidden) {
      const tools = [['start', '① 시작점'], ['elbow', '꺾임'], ['flange', '플랜지'], ['valve', '밸브'], ['tee', '티'], ['reducer', '레듀서'], ['inst', '계기'], ['equip', '장치'], ['end', '끝']];
      const left = T.f ? `<div class="tbimg">
  <div class="row tbtools">${T.f.type === 'application/pdf' ? '<button data-tr="auto" class="pri">선 자동 추출</button>' : ''}${tools.map(([k, l]) => `<button data-tool="${k}"${T.tool === k ? ' class="on"' : ''}>${l}</button>`).join('')}<select id="tbvt">${opt(Object.entries(P.VT), T.vt || 'gate')}</select><button data-tr="undo">↶ 취소</button><button data-tr="zoom">확대/축소</button></div>
  <div class="mut" id="tbhint"></div>
  <div class="tbcv"><div class="cvw"><canvas id="tbcv"></canvas><canvas id="tbov"></canvas><div id="tbin" hidden><input type="number" id="tbinv" step="10"><span class="mut">mm · Enter</span></div></div></div></div>`
        : `<div class="tbimg"><p class="mut">직접 입력 모드입니다. 도면 위에서 클릭으로 그리려면 "ISO 첨부"에서 도면을 올린 뒤 그 도면의 "확인표 열기"를 쓰세요.</p></div>`;
      P.ov('확인표 — ' + (T.f ? T.f.name : '직접 입력'), `<div class="tbw">${left}<div class="tbr" id="tbr"></div></div>`);
      $('iso3').hidden = true; $('isop').hidden = true;
      T.shown = key;
      $('tbr').innerHTML = h;
      if (T.f) { drawRef(); bindTrace(); }
    } else $('tbr').innerHTML = h;
    hint(); drawOv();
    if (T.lastMsg && $('tbmsg')) $('tbmsg').textContent = T.lastMsg;
  }
  let zoomBig = false;
  async function drawRef() {
    const cv = $('tbcv'); if (!cv || !T.f) return;
    const w = zoomBig ? 2600 : 1500;
    cv.parentElement.style.width = zoomBig ? w + 'px' : '100%';
    await P.drawFile(T.f, cv, w);
    if (!T.pageW) T.pageW = T.f.type === 'application/pdf' ? await pdfPageW(T.f) : cv.width;
    const ov = $('tbov'); if (ov) { ov.width = cv.width; ov.height = cv.height; }
    drawOv();
  }
  async function pdfPageW(f) { try { const L = await P.pdfLib(), d = await L.getDocument({ data: new Uint8Array(await f.blob.arrayBuffer()) }).promise, pg = await d.getPage(1); return pg.getViewport({ scale: 1 }).width; } catch (e) { return 842; } }

  /* ---------------- 도면 위 클릭으로 따라 그리기 ---------------- */
  const SCR = { '+X': [0.866, 0.5], '-X': [-0.866, -0.5], '+Z': [-0.866, 0.5], '-Z': [0.866, -0.5], '+Y': [0, -1], '-Y': [0, 1] };
  const TOOLHINT = {
    start: '배관이 시작하는 점(기존 배관 연결점, 장치 노즐 등)을 클릭하세요. 티 위를 클릭하면 그 티에서 분기가 시작됩니다.',
    elbow: '꺾이는 점(엘보 모서리)을 클릭하세요. 방향은 자동으로 정해집니다.', flange: '플랜지 기호 위치를 클릭하세요.', valve: '밸브 중심을 클릭하세요. 종류는 옆 목록에서 고릅니다.',
    tee: '티(분기점)를 클릭하세요. 분기는 나중에 "① 시작점"으로 이 티를 클릭해 그립니다.', reducer: '레듀서 중심을 클릭하세요.', inst: '계기 위치(구간 끝)를 클릭하세요.', equip: '장치 노즐(구간 끝)을 클릭하세요.', end: '배관이 끝나는 점을 클릭하세요.'
  };
  function hint() {
    const el = $('tbhint'); if (!el) return;
    const r = T.R.runs[T.cur];
    el.textContent = T.tool ? (TOOLHINT[T.tool] + (T.tool !== 'start' && !(r && r._p0) ? ' — 먼저 "① 시작점"을 찍으세요.' : '')) : (T.f && T.f.type === 'application/pdf' ? '"선 자동 추출"로 표를 채우거나, 도구를 고른 뒤 도면을 클릭해 배관을 따라 그리세요. 클릭할 때마다 치수 입력칸이 뜹니다.' : '도구를 고른 뒤 도면을 클릭해 배관을 따라 그리세요. 클릭할 때마다 치수 입력칸이 뜹니다.');
  }
  const unit = () => (T.pageW || 842) / 842;              // 도면 단위 보정(이미지일 때)
  const toPage = (cv, e) => { const b = cv.getBoundingClientRect(), k = (T.pageW || cv.width) / cv.width; return [(e.clientX - b.left) * cv.width / b.width * k, (e.clientY - b.top) * cv.height / b.height * k]; };
  const pdist = (a, b) => Math.hypot(a[0] - b[0], a[1] - b[1]);
  function runDirAt(r) { let d = r.dir || ''; (r.steps || []).forEach(p => { if (p.t === 'elbow' && p.to) d = p.to; if (p.t === 'tee_in' && p.run) d = p.run; }); return d; }
  function lastPt(r) { for (let i = r.steps.length - 1; i >= 0; i--) if (r.steps[i]._p) return r.steps[i]._p; return r._p0; }
  function nearestDir(v) { let best = null, bv = -2; const L = Math.hypot(v[0], v[1]) || 1; Object.entries(SCR).forEach(([k, a]) => { const d = (v[0] * a[0] + v[1] * a[1]) / L; if (d > bv) { bv = d; best = k; } }); return best; }
  function snapPt(p) {
    const tol = 7 * unit(); let best = null, bd = tol;
    const cand = (T.ext ? T.ext.snaps : []).concat(T.R.runs.flatMap(r => [r._p0].concat(r.steps.map(s => s._p))).filter(Boolean));
    cand.forEach(q => { const d = pdist(p, q); if (d < bd) { bd = d; best = q; } });
    return best ? best.slice() : p;
  }
  function bindTrace() {
    const ov = $('tbov'); if (!ov) return;
    ov.onclick = e => traceClick(toPage(ov, e));
    const inp = $('tbinv');
    inp.onkeydown = e => { if (e.key === 'Enter') { setD(inp.value); } else if (e.key === 'Escape') { $('tbin').hidden = true; } };
    $('tbvt').onchange = e => { T.vt = e.target.value; };
  }
  function setD(v) {
    const b = $('tbin'); b.hidden = true;
    const st = T.pending; T.pending = null;
    if (st && v !== '' && +v > 0) { st.d = +v; delete st.conf; delete st.est; }
    persist(); render(T.lastErrs);
  }
  function traceClick(p0) {
    const R = T.R, tool = T.tool;
    if (!tool) { msg('위쪽 도구 버튼을 먼저 고르세요.'); return; }
    let p = snapPt(p0);
    if (tool === 'start') {
      const teeHit = R.runs.flatMap(r => r.steps.filter(s => (s.t === 'tee' || s.t === 'tee_in') && s._p && s.id)).find(s => pdist(s._p, p) < 8 * unit());
      let ri = R.runs.findIndex(r => !r.steps.length && !r._p0);
      if (ri < 0) { if (R.runs.length === 1 && !R.runs[0]._p0 && R.runs[0].steps.length <= 1 && R.runs[0].steps.every(s => !s._p)) { R.runs[0].steps = []; ri = 0; } else { let n = R.runs.length + 1; while (R.runs.some(r => r.id === 'R' + n)) n++; R.runs.push({ id: 'R' + n, steps: [] }); ri = R.runs.length - 1; } }
      const r = R.runs[ri];
      r._p0 = teeHit ? teeHit._p.slice() : p; r.start = teeHit ? { tee: teeHit.id } : (R.runs.some((x, i) => i !== ri && (x.start === 'origin' || !x.start) && x._p0) ? 'origin' : 'origin');
      if (teeHit) delete r.dir;
      T.cur = ri; T.tool = 'elbow';
      msg(teeHit ? '티 ' + teeHit.id + ' 에서 분기를 시작합니다. 이어서 다음 점을 클릭하세요.' : '시작점을 찍었습니다. 이어서 꺾이는 점·플랜지·밸브 등을 차례로 클릭하세요.');
      persist(); render(T.lastErrs); return;
    }
    const r = R.runs[T.cur];
    if (!r || !r._p0) { msg('먼저 "① 시작점"을 찍으세요.'); return; }
    const last = lastPt(r), v = [p[0] - last[0], p[1] - last[1]];
    if (Math.hypot(v[0], v[1]) < 2 * unit()) { msg('앞 점과 너무 가깝습니다.'); return; }
    const dir = nearestDir(v), a = SCR[dir], L = v[0] * a[0] + v[1] * a[1];
    if (p === p0 || pdist(p, p0) > 0.01) {} // snapped point kept
    const onAxis = [last[0] + a[0] * L, last[1] + a[1] * L];
    if (pdist(onAxis, p) > 4 * unit()) p = onAxis; // 축에서 벗어난 클릭은 축 위로
    let cur = runDirAt(r);
    const lastStep = r.steps[r.steps.length - 1];
    if (lastStep && lastStep.t === 'elbow' && !lastStep.to) {
      if (Math.abs(SCR[cur] ? (SCR[cur][0] * a[0] + SCR[cur][1] * a[1]) : 0) > 0.9) { msg('엘보 다음은 방향이 꺾여야 합니다. 다른 방향의 점을 클릭하세요.'); return; }
      lastStep.to = dir; cur = dir;
    }
    if (!r.steps.length && !cur) {
      r.dir = dir; cur = dir;
      if (r.start && r.start.tee) { const ts = R.runs.flatMap(x => x.steps).find(s => s.id === r.start.tee); if (ts && ts.t === 'tee' && !ts.branch) ts.branch = dir; }
    } else if (!r.steps.length && r.dir !== dir && !(r.start && r.start.tee)) { r.dir = dir; cur = dir; }
    if (cur && dir !== cur) { msg('진행 방향(' + DIRL[cur] + ')과 다른 방향입니다. 방향이 바뀌는 곳은 "꺾임" 도구로 먼저 찍으세요.'); return; }
    const est = Math.max(10, Math.round(Math.abs(L) * 50 / unit() / 10) * 10);
    const nps = +r.nps || +R.nps || 4;
    const st = { t: tool, d: est, conf: 'low', est: true, _p: p };
    if (tool === 'valve') Object.assign(st, { vt: T.vt || 'gate', conn: 'flg' });
    if (tool === 'tee') { let n = 1; const ids = R.runs.flatMap(x => x.steps.map(s => s.id)).filter(Boolean); while (ids.includes('T' + n)) n++; Object.assign(st, { id: 'T' + n, branch: '', nps2: nps }); }
    if (tool === 'reducer') { const i = SIZES.indexOf(nps); Object.assign(st, { nps2: SIZES[Math.max(0, i - 1)], rt: 'conc' }); }
    if (tool === 'end') st.end = 'open';
    if (tool === 'inst') Object.assign(st, { kind: 'FT', tag: 'FT-?' });
    if (tool === 'equip') Object.assign(st, { kind: 'pump', tag: 'P-?', nozzle: 'SUC' });
    r.steps.push(st);
    if (tool === 'end' || tool === 'inst' || tool === 'equip') T.tool = 'start';
    T.pending = st;
    persist(); render(T.lastErrs);
    // 치수 입력칸
    const ov = $('tbov'), box = $('tbin'), inp = $('tbinv');
    if (ov && box) { const k = ov.getBoundingClientRect().width / ((T.pageW || ov.width)); box.style.left = (p[0] * k + 8) + 'px'; box.style.top = (p[1] * k - 14) + 'px'; box.hidden = false; inp.value = est; inp.select(); inp.focus(); }
    msg(STEP[tool] + ' 추가: 도면 치수를 입력하고 Enter (어림값 ' + est + 'mm). Esc는 어림값 유지.');
  }
  function drawOv() {
    const ov = $('tbov'); if (!ov || !ov.width) return;
    const g = ov.getContext('2d'), k = ov.width / (T.pageW || ov.width);
    g.clearRect(0, 0, ov.width, ov.height);
    const X = p => [p[0] * k, p[1] * k];
    if (T.ext) { g.strokeStyle = 'rgba(37,99,235,.35)'; g.lineWidth = Math.max(3, 5 * k / 2); T.ext.pipes.forEach(l => { const a = X(l.a), b = X(l.b); g.beginPath(); g.moveTo(a[0], a[1]); g.lineTo(b[0], b[1]); g.stroke(); }); }
    T.R.runs.forEach((r, ri) => {
      if (!r._p0) return;
      const on = ri === T.cur, col = r.existing ? '#64748b' : on ? '#dc2626' : '#ea580c';
      let a = X(r._p0);
      g.fillStyle = col; g.beginPath(); g.arc(a[0], a[1], 7, 0, 7); g.fill();
      g.font = 'bold 18px sans-serif'; g.fillText(r.id || '', a[0] + 9, a[1] - 9);
      r.steps.forEach((s, i) => {
        if (!s._p) return; const b = X(s._p);
        g.strokeStyle = col; g.lineWidth = on ? 4 : 3; g.setLineDash(r.existing ? [10, 6] : []); g.beginPath(); g.moveTo(a[0], a[1]); g.lineTo(b[0], b[1]); g.stroke(); g.setLineDash([]);
        g.fillStyle = s.conf === 'low' ? '#ca8a04' : col; g.strokeStyle = '#fff'; g.lineWidth = 2;
        g.beginPath(); if (s.t === 'flange') g.rect(b[0] - 6, b[1] - 6, 12, 12); else g.arc(b[0], b[1], s.t === 'elbow' ? 6 : 8, 0, 7); g.fill(); g.stroke();
        g.fillStyle = '#111'; g.font = '15px sans-serif'; g.fillText((i + 1) + ({ elbow: '', flange: 'F', valve: 'V', tee: 'T', tee_in: 'T', reducer: 'R', inst: 'I', equip: 'E', end: '■' }[s.t] || ''), b[0] + 9, b[1] + 16);
        a = b;
      });
    });
  }
  async function autoExtract() {
    if (!T.f || T.f.type !== 'application/pdf') return;
    if (!window.P3DVEC) { msg('자동 추출 모듈을 불러오지 못했습니다.'); return; }
    msg('도면의 선을 분석하는 중…');
    try {
      const L = await P.pdfLib(), res = await window.P3DVEC.extract(L, new Uint8Array(await T.f.blob.arrayBuffer()));
      T.ext = res; T.pageW = res.page.W;
      if (!res.route || !res.route.runs.length) { msg('배관 선을 찾지 못했습니다. 이 도면은 클릭으로 따라 그려 주세요. (스캔본·이미지는 자동 추출이 안 됩니다)'); drawOv(); return; }
      const hasWork = T.R.runs.some(r => r.steps.some(s => s._p) || r.steps.length > 1);
      if (hasWork && !confirm('지금 표 내용을 자동 추출 결과로 바꿀까요?')) { drawOv(); return; }
      const keep = { line_no: T.R.line_no, title: T.R.title, nps: T.R.nps, cls: T.R.cls };
      T.R = Object.assign(res.route, Object.fromEntries(Object.entries(keep).filter(([, v]) => v)));
      T.cur = 0; T.tool = null;
      persist(); render();
      const n = T.R.runs.reduce((a, r) => a + r.steps.length, 0);
      msg('자동 추출: 구간 ' + T.R.runs.length + '개, 항목 ' + n + '개. 거리는 어림값(노란 줄)이니 도면 치수로 고치고, 빠진 티·레듀서·장치를 추가한 뒤 "3D에 반영"을 누르세요.');
    } catch (e) { msg('자동 추출 실패: ' + e.message); }
  }

  async function persist() { if (T.f) { T.f.route = T.R; await P.fPut(T.f); } }
  function setPath(obj, k, v) {
    if (['d', 'nps', 'nps2', 'nps_run', 'cls'].includes(k)) v = v === '' ? '' : +v;
    if (v === '' && k !== 'note') delete obj[k]; else obj[k] = v;
  }
  function onChange(e) {
    const t = e.target, ds = t.dataset;
    if (!T || !(ds.s || ds.r || ds.h)) return;
    const R = T.R, v = t.type === 'checkbox' ? t.checked : t.value;
    if (ds.h) setPath(R, ds.h, v);
    else if (ds.r) { const [ri, k] = ds.r.split('.'); const r = R.runs[+ri]; if (k === 'start') { const k2 = ds.r.split('.')[2]; if (k2) { const o = r.start.equip || r.start.nozzle; o[k2] = v; } else { r.start = parseStart(v, r.start); render(T.lastErrs); } } else setPath(r, k, v); }
    else { const [ri, si, k] = ds.s.split('.'); const p = R.runs[+ri].steps[+si]; setPath(p, k, v); if (k !== 'note') delete p.conf; if (k === 't') { render(); } }
    persist();
  }
  function onClick(e) {
    const tb = e.target.closest('[data-tool]');
    if (tb && T) { T.tool = T.tool === tb.dataset.tool ? null : tb.dataset.tool; document.querySelectorAll('[data-tool]').forEach(x => x.classList.toggle('on', x.dataset.tool === T.tool)); hint(); return; }
    const b = e.target.closest('[data-tr]');
    if (!b || !T) return;
    const a = b.dataset.tr, R = T.R, ri = +b.dataset.ri, si = +b.dataset.si;
    const steps = R.runs[ri] && R.runs[ri].steps;
    if (a === 'up' && si > 0) [steps[si - 1], steps[si]] = [steps[si], steps[si - 1]];
    else if (a === 'dn' && si < steps.length - 1) [steps[si + 1], steps[si]] = [steps[si], steps[si + 1]];
    else if (a === 'ins') steps.splice(si + 1, 0, { t: 'flange', d: 1000 });
    else if (a === 'del') steps.splice(si, 1);
    else if (a === 'add') steps.push({ t: 'end', d: 1000, end: 'open' });
    else if (a === 'rdel') { if (!confirm('이 구간을 삭제할까요?')) return; R.runs.splice(ri, 1); }
    else if (a === 'radd') { let n = R.runs.length + 1; while (R.runs.some(r => r.id === 'R' + n)) n++; R.runs.push({ id: 'R' + n, start: 'origin', dir: '+X', steps: [{ t: 'end', d: 1000, end: 'open' }] }); }
    else if (a === 'zoom') { zoomBig = !zoomBig; drawRef(); return; }
    else if (a === 'auto') { autoExtract(); return; }
    else if (a === 'undo') { const r = R.runs[T.cur] || R.runs[R.runs.length - 1]; if (!r) return; if (r.steps.length) r.steps.pop(); else if (r._p0) { delete r._p0; if (R.runs.length > 1) R.runs.splice(R.runs.indexOf(r), 1); T.cur = Math.max(0, R.runs.length - 1); } $('tbin') && ($('tbin').hidden = true); }
    else if (a === 'build') { apply(); return; }
    else if (a === 'iso' || a === 'show') { const ids = P.getObjs().filter(o => o.src === T.src && !o.ex).map(o => o.id); if (!ids.length) { msg('먼저 "3D에 반영"을 눌러 주세요.'); return; } if (a === 'iso') { P.showIso(ids[0]); backBtn(); } else P.focus(P.getObjs().filter(o => o.src === T.src).map(o => o.id)); return; }
    else return;
    persist(); render(T.lastErrs);
  }
  function backBtn() {
    const bar = document.querySelector('#iso .isobar');
    if (!bar || $('isoback')) return;
    const b = document.createElement('button');
    b.id = 'isoback'; b.textContent = '← 확인표';
    b.onclick = () => { b.remove(); if (T) render(T.lastErrs); };
    bar.insertBefore(b, bar.firstChild);
    const cl = $('isoc'); if (cl) cl.addEventListener('click', () => b.remove(), { once: true });
  }
  function msg(t) { if (T) T.lastMsg = t; const el = $('tbmsg'); if (el) el.textContent = t; }
  function apply() {
    const R = T.R;
    const b = buildRoute(R, T.src);
    T.lastErrs = b.errs;
    const removed = P.removeWhere(o => o.src === T.src);
    if (b.objs.length) P.loadModel(b);
    persist();
    render(b.errs);
    msg(`3D에 ${b.objs.length}개 부품을 ${removed ? '다시 ' : ''}만들었습니다.` + (b.errs.length ? ` 확인할 항목 ${b.errs.length}개가 표에 빨간색으로 표시됩니다.` : ' "ISO 보기"로 원본 도면과 비교해 보세요.'));
  }
  async function table(fid) {
    const f = (await P.fAll()).find(x => x.id === fid);
    if (!f) return;
    if (!f.route) f.route = { line_no: '', title: '', nps: 4, cls: 150, notes: [], runs: [{ id: 'R1', start: 'origin', dir: '', nps: 4, existing: false, steps: [] }] };
    T = { fid, f, R: f.route, src: 'iso:' + fid, lastErrs: null, cur: 0, tool: null, vt: 'gate', shown: null };
    render();
    if (f.type === 'application/pdf' && window.P3DVEC) { try { const L = await P.pdfLib(); const res = await window.P3DVEC.extract(L, new Uint8Array(await f.blob.arrayBuffer())); if (T && T.fid === fid) { T.ext = res; T.pageW = res.page.W; drawOv(); } } catch (e) {} }
  }
  function manual() {
    T = { fid: null, f: null, R: blank(), src: 'manual:' + Date.now(), lastErrs: null, cur: 0, tool: null, shown: null };
    render();
  }


  /* ================= 질문식 3D 변환 (한 번에 하나씩) ================= */
  let W = null;
  const QS = [0.5, 0.75, 1, 1.5, 2, 3, 4, 6, 8, 10, 12, 14, 16, 18, 20, 24];
  const phasesOf = s => (s.roll && !s.okRoll ? ['roll'] : []).concat(s.roll && s.okRoll && s.roll.pl !== 'AX' && !s.okSlope ? ['slope'] : []).concat(['flange', 'valve'].includes(s.t) && !s.okType ? ['type'] : []).concat(s.t === 'valve' && s.okType && !s.okVsize ? ['vsize'] : []).concat(s.t === 'reducer' && !s.okRed ? ['rsize'] : []).concat(s.t === 'tee' && !s.okBranch ? ['branch'] : []).concat(s.okLen ? [] : ['len']).concat(s.t === 'end' && !s.okEnd ? ['end'] : []);
  // 이 지점에서의 배관 크기 (런 크기 → 앞쪽 레듀서 반영)
  // 도면 BOM에서 남는 캡·블라인드·플랜지로 배관 끝 처리 추정
  function bomEndGuess(ri, si) {
    const bm = W.bom; if (!bm || !bm.rows || !bm.rows.length) return null;
    const z = +npsAt(ri, si), eq = a => a != null && Math.abs(+a - z) < 0.01;
    const q = re => bm.rows.filter(r => re.test(r.cat) && eq(r.size)).reduce((a, r) => a + (+r.qty || 0), 0);
    let cap = 0, bl = 0, fl = 0;
    W.R.runs.forEach((r, i) => { if (r.startFl && eq(npsAt(i, 0))) fl++; r.steps.forEach((s, j) => {
      if (i === ri && j === si) return; if (!eq(npsAt(i, j))) return;
      if (s.t === 'flange') fl += 2; else if (s.t === 'valve' && (s.conn || 'flg') === 'flg') fl += 2;
      else if (s.t === 'end' && (s.okEnd || s.guess)) { const en = s.okEnd ? s.end : s.guess; if (en === 'cap') cap++; else if (en === 'blind') { bl++; fl++; } else if (en === 'flange') fl++; }
    }); });
    if (q(/^CAP$/) > cap && !W.R.runs[ri].steps[si].flTick) return 'cap'; // 플랜지 표시가 있는 끝은 캡이 아님
    const me = W.R.runs[ri].steps[si], tickElse = !me.flTick && W.R.runs.some((r, i) => r.steps.some((x, j) => (i !== ri || j !== si) && x.t === 'end' && !x.okEnd && x.flTick && eq(npsAt(i, j))));
    if (q(/^BLIND FLANGE$/) > bl && !(tickElse && q(/^FLANGE$/) - fl >= 1)) return 'blind'; // 블라인드는 끝에 플랜지 표시가 있는 쪽에 먼저
    if (q(/^FLANGE$/) - fl >= 1) return 'flange';
    return null;
  }
  // 도면 BOM에 있는 더 작은 크기 (가지·레듀서 크기 추정)
  function bomSmaller(cur, red) {
    const bm = W.bom; if (!bm || !bm.rows) return null;
    const eq = (a, b) => Math.abs(+a - +b) < 0.01;
    if (red) { const r = bm.rows.find(r => r.cat === 'REDUCER' && r.size2 && eq(r.size, cur) && +r.size2 < cur); if (r) return +r.size2; }
    else { const t = bm.rows.find(r => r.cat === 'TEE' && r.size2 && eq(r.size, cur) && +r.size2 < cur); if (t) return +t.size2; }
    const zs = [...new Set(bm.rows.filter(r => r.size && +r.size < cur - 0.01 && !/^(PIPE|GASKET|STUD\/BOLT)$/.test(r.cat)).map(r => +r.size))];
    return zs.length === 1 ? zs[0] : null;
  }
  function npsAt(ri, si) {
    const R = W.R, r = R.runs[ri]; let n = +r.nps || +R.nps || 4;
    r.steps.slice(0, si).forEach(x => { if (x.t === 'reducer' && +x.nps2) n = +x.nps2; });
    return n;
  }
  function wRemain() { let n = W.q.phase === 'size' ? 1 : 0; W.R.runs.forEach(r => r.steps.forEach(s => { n += phasesOf(s).length; })); return n; }
  // 엘보·티가 플랜지나 용접점에 바로 붙은 짧은 구간(사이에 배관 용접점 없음)은
  // 배관이 없는 '부품 맞붙임' 구간 → ASME B16.9(엘보·티 중심~끝) + B16.5(플랜지) 치수로 길이를 자동으로 넣는다
  // 이 구간이 경사(롤링) 구간인가 → 그 경사 정보
  // 이 구간이 속한 경사의 시작 엘보(roll 정보가 있는 지점) 찾기
  function rollStart(ri, si) { const r = W.R.runs[ri]; if (!r.steps[si] || !r.steps[si].rollSeg) return null; for (let i = si - 1; i >= 0; i--) { const x = r.steps[i]; if (x.roll) return { el: x, i }; if (!x.rollSeg) return null; } return r.roll ? { el: r, i: -1 } : null; }
  function rollOf(ri, si) { const z = rollStart(ri, si); return z && z.el.roll.pl !== 'AX' ? z.el.roll : null; }
  // 경사 구간의 지점들 (시작 엘보 다음부터 경사가 끝나는 곳까지)
  function rollSteps(ri, ei) { const r = W.R.runs[ri], out = []; for (let j = ei + 1; j < r.steps.length; j++) { if (!r.steps[j].rollSeg) break; out.push(j); } return out; }
  // 롤링: 면(pl)과 두 변 길이로 3D 방향 벡터
  const AXE = { X: '+X', Y: '+Y', Z: '+Z' }, AXW = { X: '동서', Y: '위아래', Z: '남북' };
  function rollVec(rl, pl, legs) { const g = rl.pq && rl.pq[pl]; if (!g) return null; const la = legs ? legs[0] : Math.abs(g.a), lb = legs ? legs[1] : Math.abs(g.b);
    return P.DIR[AXE[g.p]].clone().multiplyScalar(Math.sign(g.a || 1) * la).add(P.DIR[AXE[g.q]].clone().multiplyScalar(Math.sign(g.b || 1) * lb)); }
  const angOf = (k, v) => { const a = P.DIR[k], u = v.clone().normalize(); return Math.round(Math.acos(Math.max(-1, Math.min(1, a.dot(u)))) * 1800 / Math.PI) / 10; };
  function dirBefore(ri, si) { const r = W.R.runs[ri]; let d = r.dir; for (let i = 0; i < si; i++) { const x = r.steps[i]; if (x.t === 'elbow' && x.to) d = x.to; if (x.t === 'tee_in' && x.run) d = x.run; } return d; }
  const elbName = a => (Math.abs(a - 90) < 1 ? '90° 엘보' + ' (롤링)' : Math.abs(a - 45) < 1 ? '45° 엘보' : '약 ' + Math.round(a) + '° 엘보');
  // 도면 BOM의 엘보 각도별 개수
  function bomElb() { if (!W.bom) return null; const c = { 90: 0, 45: 0 }; W.bom.rows.forEach(x => { if (x.cat !== 'ELBOW') return; const a = /45/.test((x.code || '') + ' ' + (x.desc || '')) ? 45 : 90; c[a] += +x.qty || 0; }); return c; }
  // 롤 구간 방향이 정해지면 앞뒤 엘보 각도 갱신
  // 경사 방향이 정해지면: 시작 엘보의 방향·각도, 경사가 끝나는 엘보의 각도 갱신 (ei = 시작 엘보 번호, -1이면 배관 시작)
  function rollApply(ri, ei, vec) {
    const r = W.R.runs[ri], key = P.keyOf(vec);
    if (ei >= 0) { const el = r.steps[ei]; el.to = key; const din = dirBefore(ri, ei); if (din) el.eang = angOf(din, vec); } else r.dir = key;
    const js = rollSteps(ri, ei), last = js.length ? r.steps[js[js.length - 1]] : null;
    if (last && last.t === 'elbow' && last.to) last.eang = angOf(last.to, vec);
  }
  function fitHalf(kind, n, eang) {
    const R = W.R, cls = +R.cls || 150;
    const ce = [.5, .75, 1, 1.5, 2].includes(+n) ? (R.ce || 'sw') : 'bw';
    if (kind === 'elbow') { const e = P.eg({ type: 'elbow', kind: 'lr90', nps: n, ce, axis: '+X', turn: '+Y', pos: [0, 0, 0] }); const a = +eang || 90; return Math.abs(a - 90) < 0.5 ? e.R : (Math.abs(a - 45) < 0.5 ? P.eg({ type: 'elbow', kind: 'lr45', nps: n, ce, axis: '+X', turn: '+Y', pos: [0, 0, 0] }).R : e.R) * Math.tan(a * Math.PI / 360); }
    if (kind === 'tee' || kind === 'tee_in') return P.dflen({ type: 'tee', nps: n, ce }) / 2;
    if (kind === 'flange') return P.HGx(cls, 'RF', n) + P.dflen({ type: 'flange', nps: n, kind: 'wn', cls });
    if (kind === 'weld') return 0;
    return null;
  }
  function autoLen() {
    const R = W.R; if (!R.nps) return;
    R.runs.forEach((r, ri) => r.steps.forEach((s, si) => {
      if (s.okLen || !s._wd || !(s._pt < 15)) return;
      const pv0 = si > 0 ? r.steps[si - 1] : null;
      if (s.rollSeg || (s.e45 && s.eang == null) || (pv0 && pv0.e45 && pv0.eang == null)) return; // 경사 구간 각도가 정해진 뒤에
      if (s._wd.some(t => t > 0.12 && t < 0.88)) return; // 사이에 용접점이 있으면 배관이 있음 → 물어봄
      if (['flange', 'valve'].includes(s.t) && !s.okType) return;
      const n = npsAt(ri, si);
      const a = si === 0 ? (r.start && r.start.tee ? 'tee' : r.startFl ? 'flange' : (s._wd.some(t => t <= 0.12) ? 'weld' : null)) : r.steps[si - 1].t;
      const b = s.t === 'end' ? (s._wd.some(t => t >= 0.88) ? 'weld' : null) : s.t;
      if (![a, b].some(k => k === 'elbow' || k === 'tee' || k === 'tee_in')) return;
      const pa = si > 0 ? r.steps[si - 1] : null, ha = fitHalf(a, n, pa && pa.eang), hb = fitHalf(b, n, s.eang); if (ha == null || hb == null) return;
      s.d = Math.round((ha + hb) * 10) / 10; s.okLen = true; s.auto = 'fit'; delete s.est; delete s.conf;
    }));
  }
  // 도면에서 읽은 치수: 확신이 높고 헷갈릴 숫자가 없으면 묻지 않고 넣음 (끝에 표에서 확인·수정)
  function ocrApply() {
    W.R.runs.forEach(r => r.steps.forEach(s => {
      if (s.okLen || !s.ocr || s.ocr.c < 90 || s.ocr.amb) return;
      if (s.ocr.off) return; // 빗금 삼각형 변 치수는 기울기 질문에서 확인
      s.d = s.ocr.v;
      s.okLen = true; s.auto = 'ocr'; delete s.est; delete s.conf;
    }));
  }
  async function wOcr() {
    const O = window.P3DOCR;
    if (!O || !W || !W.ext._pg) return;
    const w0 = W, segs = w0.ext._pg.segs, page = w0.ext.page; w0.ocrRun = true;
    const say = t => { w0.ocrMsg = t; if (W !== w0) return; const el = $('wzocr'); if (el) el.textContent = t; };
    const live = () => W === w0 && !$('iso').hidden && !!$('wzcv') && !!$('wzq0'); // 질문 화면이 지금 열려 있을 때만 다시 그림
    const banner = t => { const bn = document.querySelector('.wzocrb'); if (bn && W === w0) bn.textContent = t; };
    try {
      // 1) 똑바른 글자 → 표제란 (라인 번호·크기·장 번호)
      say('표제란 읽는 중…');
      const words = await O.readWords(segs, page); w0.words = words;
      const tt = await O.readTitle(segs, words); w0.title = tt;
      if (live() && W.q.phase === 'size') {
        const ln = $('wzln'); if (ln && ln.value) W.R.line_no = ln.value.trim();
        if (tt.line_no && !W.R.line_no) W.R.line_no = tt.line_no;
        wRender();
      }
      // 2) 치수 숫자
      const near = (w0.ext.pipes || []).map(l => [l.a, l.b]);
      const nums = await O.readNumbers(segs, page, { near, progress: say });
      w0.nums = nums;
      if (W === w0) {
        O.assign(W.R, nums);
        const typing = $('wzd') && $('wzd').value;
        if (W.q.phase !== 'size' && W.q.phase !== 'done') { W.q.phase = null; wFirstPhase(); if (live() && !typing) wRender(); }
      }
      // 3) 도면 BOM 표
      try { w0.bom = await O.readBOM(segs, page, words, say); } catch (e) { w0.bom = null; }
      // 4) 아이소 방향 글자: 다른 장 표시(SEE DWG SHT 2/3)·좌표(E/N/EL) — 힌트로만 사용
      try { say('다른 장 표시·좌표 찾는 중…'); const iso = await O.readIsoText(segs, page, { vars: [[-30, -0.577], [30, 0.577], [-30, 0.577], [30, -0.577]], wl: 'ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789./()-+:=#" ' }); w0.isoTxt = iso; w0._szl = null; w0.see = O.seeSheets(iso); w0.coords = O.coordsOf(iso); } catch (e) { w0.see = []; w0.coords = []; }
      w0.ocrRun = false;
      if (W !== w0) return;
      if (W.q.phase === 'done') { if (live()) wRender(); }
      else banner('✓ 도면 치수 ' + nums.length + '개' + (w0.bom ? ', BOM ' + w0.bom.rows.length + '줄' : '') + '을 읽었습니다.');
    } catch (e) { w0.ocrRun = false; w0.ocrErr = e.message; say('자동 읽기를 못 했습니다 (' + e.message + '). 직접 입력해 주세요.'); }
  }
  function wFirstPhase() {
    if (W.q.phase !== 'size') ocrApply();
    autoLen();
    while (W.q.ri < W.R.runs.length) {
      const r = W.R.runs[W.q.ri];
      while (W.q.si < r.steps.length) { const ph = phasesOf(r.steps[W.q.si]); if (ph.length) { W.q.phase = ph[0]; return true; } W.q.si++; }
      W.q.ri++; W.q.si = 0;
    }
    // 앞쪽에 남은 질문(건너뛴 것)이 있으면 그리로
    for (let ri = 0; ri < W.R.runs.length; ri++) for (let si = 0; si < W.R.runs[ri].steps.length; si++) { const ph = phasesOf(W.R.runs[ri].steps[si]); if (ph.length) { W.q = { ri, si, phase: ph[0] }; return true; } }
    W.q.phase = 'done'; return false;
  }
  function wAdvance() { if (W.q.phase === 'size') W.q = { ri: 0, si: 0, phase: null }; else W.q.phase = null; wFirstPhase(); }
  const wSnap = () => W.hist.push(JSON.stringify({ R: W.R, q: W.q, excl: W.excl, startAt: W.startAt, startNear: W.startNear }));
  // 배관 선을 다시 찾기 (빼기로 한 구간·시작점 반영). 답한 크기·라인번호는 유지
  function wReroute() {
    const old = W.R, nr = window.P3DVEC.reroute(W.ext, { excl: W.excl, startAt: W.startAt, startNear: W.startNear });
    if (!nr || !nr.runs.length) return false;
    nr.runs.forEach(r => r.steps.forEach(s => { if (s.t === 'valve') delete s.vt; }));
    ['nps', 'line_no', 'cls'].forEach(k => { if (old[k] != null && old[k] !== '') nr[k] = old[k]; });
    W.R = nr; W.q = { ri: 0, si: 0, phase: 'size' };
    if (W.nums && window.P3DOCR) window.P3DOCR.assign(W.R, W.nums);
    return true;
  }
  // 갈라진 배관(run)을 통째로 지우고, 그 갈래가 나온 티를 일반 배관으로 되돌림
  function wDropRun(ri) {
    const R = W.R, r = R.runs[ri]; R.runs.splice(ri, 1);
    r.steps.forEach(s => { if (s.id) for (let k = R.runs.length - 1; k >= 0; k--) if (R.runs[k].start && R.runs[k].start.tee === s.id) wDropRun(k); });
    const tid = r.start && r.start.tee; if (!tid) return;
    R.runs.forEach(pr => { const pi = pr.steps.findIndex(s => s.id === tid); if (pi < 0) return;
      const st = pr.steps[pi], nx = pr.steps[pi + 1];
      if (R.runs.some(x => x.start && x.start.tee === tid)) return; // 다른 갈래가 남아 있으면 티 유지
      if (st.t === 'tee') { if (nx) { nx.d = (+nx.d || 0) + (+st.d || 0); nx.okLen = false; } pr.steps.splice(pi, 1); }
      else if (st.t === 'tee_in') { st.t = 'elbow'; delete st.id; delete st.run; }
    });
  }
  async function wizard(fid) {
    const f = (await P.fAll()).find(x => x.id === fid); if (!f) return;
    P.ov('3D로 바꾸기 — ' + f.name, `<div class="wz"><p><b>도면을 살펴보는 중…</b></p></div>`);
    $('iso3').hidden = true; $('isop').hidden = true;
    if (f.type !== 'application/pdf' || !window.P3DVEC) return wFail(f, '이 파일은 이미지라서 선을 자동으로 찾을 수 없습니다.');
    let res;
    try { const L = await P.pdfLib(); res = await window.P3DVEC.extract(L, new Uint8Array(await f.blob.arrayBuffer())); } catch (e) { return wFail(f, '도면을 읽지 못했습니다 (' + e.message + ').'); }
    if (!res.route || !res.route.runs.length) return wFail(f, '이 도면에서는 배관 선을 자동으로 찾지 못했습니다. (스캔본이거나 그리는 방식이 다른 도면)');
    const big = document.createElement('canvas');
    await P.drawFile(f, big, 3200);
    W = { f, fid, R: res.route, ext: res, big, k: big.width / res.page.W, q: { ri: 0, si: 0, phase: 'size' }, hist: [], src: 'iso:' + fid, excl: [], startAt: 0 };
    W.R.runs.forEach(r => r.steps.forEach(s => { if (s.t === 'valve') { delete s.vt; } }));
    wRender();
    wOcr();
  }
  function wFail(f, why) {
    P.ov('3D로 바꾸기 — ' + f.name, `<div class="wz"><p><b>${E(why)}</b></p><p>이럴 때는 이렇게 해 주세요.</p><ul><li><b>Claude 대화</b>에 이 도면을 올리고 "3D로 바꿔줘"라고 하면 모델 파일을 만들어 드립니다 → 앱에서 <b>데이터 저장/불러오기 → 모델 파일 추가</b>.</li><li>또는 <b>고급 편집</b>에서 직접 입력할 수 있습니다.</li></ul><div class="row"><button data-att="back">← 첨부 목록</button><button data-att="table">고급 편집</button></div></div>`);
    $('iso3').hidden = true; $('isop').hidden = true;
    const b = document.querySelector('.wz [data-att=table]'); if (b) b.onclick = e => { e.stopPropagation(); table(f.id); };
  }
  function wView(pts, mode, marks, drag) {
    // 질문 대상 부분을 확대해서 그린다 (표시는 옅게)
    const cv = $('wzcv'), mini = $('wzmini'); if (!cv) return;
    const K = W.k, all = pts.concat(marks || []), xs = all.map(p => p[0] * K), ys = all.map(p => p[1] * K);
    let x0 = Math.min(...xs), x1 = Math.max(...xs), y0 = Math.min(...ys), y1 = Math.max(...ys);
    const m = Math.max(70 * K, (Math.max(x1 - x0, y1 - y0)) * 0.45);
    x0 -= m; x1 += m; y0 -= m; y1 += m;
    const VW = cv.width, VH = cv.height, asp = VW / VH;
    let w = x1 - x0, h = y1 - y0; if (w / h > asp) { const nh = w / asp; y0 -= (nh - h) / 2; h = nh; } else { const nw = h * asp; x0 -= (nw - w) / 2; w = nw; }
    const g = cv.getContext('2d'); g.fillStyle = '#fff'; g.fillRect(0, 0, VW, VH);
    g.drawImage(W.big, x0, y0, w, h, 0, 0, VW, VH);
    const sc = VW / w, T2 = p => [(p[0] * K - x0) * sc, (p[1] * K - y0) * sc];
    W.vt = { x0, y0, sc, K, T2 };
    (marks || []).forEach(p0 => { const p = T2(p0); g.fillStyle = 'rgba(22,163,74,.18)'; g.strokeStyle = 'rgba(22,163,74,.85)'; g.lineWidth = 2; g.beginPath(); g.arc(p[0], p[1], 11, 0, 7); g.fill(); g.stroke(); });
    if (mode === 'seg' && pts.length >= 2) {
      const a = T2(pts[0]), b = T2(pts[1]);
      g.strokeStyle = 'rgba(37,99,235,.22)'; g.lineWidth = 16; g.lineCap = 'round'; g.beginPath(); g.moveTo(a[0], a[1]); g.lineTo(b[0], b[1]); g.stroke();
      [a, b].forEach(p => { g.strokeStyle = 'rgba(220,38,38,.9)'; g.lineWidth = 2.5; g.beginPath(); g.arc(p[0], p[1], 13, 0, 7); g.stroke(); });
    } else pts.forEach(p0 => { const p = T2(p0); g.strokeStyle = 'rgba(220,38,38,.9)'; g.lineWidth = 3; g.beginPath(); g.arc(p[0], p[1], 26, 0, 7); g.stroke(); });
    if (W.ocrMark) { const o = W.ocrMark, p = T2(o.p), hh = Math.max(14, (o.h || 3) * K * sc * 1.6), ww = hh * String(o.v).length * 0.75 + 10; g.strokeStyle = 'rgba(234,88,12,.95)'; g.lineWidth = 2.5; g.strokeRect(p[0] - ww / 2 - 4, p[1] - hh / 2 - 3, ww + 8, hh + 6); g.fillStyle = 'rgba(234,88,12,.95)'; g.font = 'bold 15px sans-serif'; g.fillText('읽은 값 ' + o.v, p[0] - ww / 2 - 4, p[1] + hh / 2 + 20); }
    if (drag) { g.strokeStyle = 'rgba(220,38,38,.95)'; g.lineWidth = 3; g.setLineDash([5, 4]); g.beginPath(); g.arc(drag[0], drag[1], 15, 0, 7); g.stroke(); g.setLineDash([]); }
    if (mini) { const mg = mini.getContext('2d'), ms = mini.width / W.big.width; mini.height = Math.round(W.big.height * ms); mg.drawImage(W.big, 0, 0, mini.width, mini.height); mg.strokeStyle = '#dc2626'; mg.lineWidth = 2; mg.strokeRect(x0 * ms, y0 * ms, w * ms, h * ms); }
  }
  function wRender() {
    if (W.fixAt != null && W.hist.length > W.fixAt && W.q.phase !== 'done') { W.q = { ri: 0, si: 0, phase: 'done' }; W.fixAt = null; }
    const R = W.R, q = W.q, r = R.runs[q.ri], s = r && r.steps[q.si];
    const done0 = W.hist.length, total = done0 + wRemain(), idx = Math.min(total, done0 + 1);
    const btn = (v, l, cls) => `<button data-wz="${E(String(v))}"${cls ? ` class="${cls}"` : ''}>${l}</button>`;
    let title = '', body = '', pts = [], mode = 'pt';
    const branchNote = r && r.start && r.start.tee ? '<span class="wzt">갈라진 배관</span> ' : '';
    if (q.phase === 'size') {
      { const r0 = R.runs[0], s0 = r0.steps[0]; pts = s0 && s0._p ? [r0._p0, s0._p] : [r0._p0]; if (pts.length > 1) mode = 'seg'; }
      title = '빨간 원에서 배관이 시작합니다 (파란 띠 = 첫 구간). 맞으면 배관 크기를 고르세요.<br><span class="wzt">틀리면 도면에서 초록 원(배관 끝) 중 진짜 시작점을 누르거나, 빨간 원을 끌어다 놓으세요</span>';
      const hint = !W.sizeAns && W.title && W.title.nps;
      if (hint) title += `<br><span class="wzt wzto">표제란 라인 번호 ${E(W.title.line_no)} → ${nf(hint)} 로 보입니다</span>`;
      body = `<div class="wzb">${QS.map(v => btn('size:' + v, nf(v), ((hint ? hint === v : +R.nps === v) ? 'on' : ''))).join('')}</div>
        <div class="row wzs"><label>라인 번호 (선택) <input id="wzln" value="${E(R.line_no || '')}" placeholder="예: SW06002-4&quot;-B01A"></label><label>압력 등급 <select id="wzcls">${opt([150, 300, 400, 600, 900, 1500, 2500].map(v => [v, v + '#']), R.cls || 150)}</select></label><label>2" 이하 이음 <select id="wzce">${opt([['sw', 'SW 소켓 용접'], ['bw', 'BW 맞대기'], ['thd', '나사 (THD)']], R.ce || 'sw')}</select></label></div>
        <div class="wzno"><span>시작점이 틀렸나요?</span>${btn('notpipe', '✕ 파란 띠는 배관이 아님 (점선·치수선 등)', 'warn')}${(R.nStarts || 1) > 1 ? btn('nextstart', '↻ 다른 끝에서 시작 (' + ((R.startIdx || 0) + 1) + ' / ' + R.nStarts + ')', 'ghost') : ''}</div>`;
    } else if (q.phase === 'done') {
      const n = R.runs.reduce((a, x) => a + x.steps.length, 0);
      title = '질문이 끝났습니다.';
      const na = R.runs.reduce((a, x) => a + x.steps.filter(y => y.auto === 'fit').length, 0);
      body = wElbCheck() + wReview() + `${na ? '<p>엘보·티가 플랜지나 용접점에 바로 붙은 구간 <b>' + na + '곳</b>은 길이를 묻지 않고 ASME B16.9/B16.5 치수로 넣었습니다.</p>' : ''}<p>답하신 내용으로 3D를 만듭니다. 도면에 있는데 빠진 부품(티, 레듀서 등)은 나중에 3D 편집기에서 추가하거나 "고급 편집"에서 넣을 수 있습니다.</p><div class="wzb">${btn('build', '3D로 만들기', 'pri big')}</div>`;
      pts = R.runs.flatMap(x => [x._p0].concat(x.steps.map(y => y._p))).filter(Boolean);
    } else if (s) {
      const prev = q.si === 0 ? r._p0 : r.steps[q.si - 1]._p;
      if (q.phase === 'roll') {
        const r0 = W.R.runs[q.ri], nx = r0.steps[q.si + 1], rl = s.roll;
        pts = [s._p, nx && nx._p].filter(Boolean); mode = 'seg';
        const PLK = { H: '수평 경사 — 바닥면에서 비스듬히 (동서↔남북)', VX: '수직 경사 — 동서 방향으로 비스듬히 오르내림', VZ: '수직 경사 — 남북 방향으로 비스듬히 오르내림', AX: '경사 아님 — 축 방향 그대로' };
        const why = rl.isoLook ? '선은 축 방향처럼 보이지만 옆에 빗금 삼각형이 있어 45° 경사로 봅니다' : rl.sure ? '빗금 삼각형으로 보아 "' + PLK[rl.pl].split(' —')[0] + '" 같습니다' : '빗금 삼각형을 못 찾았습니다 — 도면을 보고 골라 주세요';
        const din = dirBefore(q.ri, q.si), ea = {};
        Object.keys(rl.pq || {}).forEach(k => { const v = rollVec(rl, k); if (v && din) ea[k] = angOf(din, v); });
        const be = bomElb(); let pick = rl.pl, bnote = '';
        if (be && !s.rollPick) { // 도면 BOM에 45° 엘보가 없으면 90° 엘보(롤링)가 되는 면을 우선
          if (!be[45] && ea[pick] != null && Math.abs(ea[pick] - 90) > 1) { const k90 = Object.keys(ea).find(k => Math.abs(ea[k] - 90) < 1); if (k90) { pick = k90; bnote = ` · 도면 BOM에 45° 엘보가 없어 90° 엘보(롤링)가 되는 면을 골라 두었습니다`; } }
          else if (be[45] && !rl.sure) { const k45 = Object.keys(ea).find(k => Math.abs(ea[k] - 45) < 8); if (k45) pick = k45; }
          s.rollPick = pick;
        } else if (s.rollPick) pick = s.rollPick;
        title = branchNote + '파란 띠 구간이 비스듬한 배관(경사·롤링)입니다. 어느 면에서 기울었나요? <span class="wzt wzto">' + why + bnote + '</span>';
        body = `<div class="wzb">${Object.keys(rl.alts).map(k => btn('roll:' + k, PLK[k] + ' <span class="mut">(' + E(dirName(rl.alts[k])) + (ea[k] != null ? ' · ' + elbName(ea[k]) : '') + ')</span>', pick === k ? 'on' : (k === 'AX' ? 'ghost' : ''))).join('')}</div>
<p class="mut">빗금 삼각형: 바닥에 눕힌 삼각형 = 수평 경사, 세운 삼각형 = 수직 경사. 들어오는 배관과 직각인 면이면 <b>90° 엘보를 돌려서(롤링)</b> 붙이고, 같은 면이면 45° 등 각도 엘보입니다. 다음 질문에서 삼각형 두 변 길이를 넣으면 정확한 각도로 만듭니다.${be ? `<br>도면 BOM 엘보: 90° ${be[90]}개 · 45° ${be[45]}개` : ''}</p>`;
      } else if (q.phase === 'slope') {
        const rl = s.roll, g = rl.pq[rl.pl], js = rollSteps(q.ri, q.si), r0 = W.R.runs[q.ri];
        pts = [s._p, js.length ? r0.steps[js[js.length - 1]]._p : s._p]; mode = 'seg';
        const pa = Math.round(Math.atan2(Math.abs(g.b), Math.abs(g.a)) * 1800 / Math.PI) / 10;
        title = branchNote + `비스듬한 구간의 기울기: 빗금 삼각형의 두 변 길이(또는 각도)를 알면 넣어 주세요`;
        body = `<div class="row wzs"><label>${AXW[g.p]} 변 <input id="wzl1" type="number" inputmode="numeric" value="${s.rollLegs ? s.rollLegs[0] : ''}" style="font-size:20px;width:130px"></label><label>${AXW[g.q]} 변 <input id="wzl2" type="number" inputmode="numeric" value="${s.rollLegs ? s.rollLegs[1] : ''}" style="font-size:20px;width:130px"></label><span class="mut">또는</span><label>각도 <input id="wzla" type="number" inputmode="decimal" placeholder="°" value="${s.rollDeg || ''}" style="font-size:20px;width:90px"></label><button data-wz="slope" class="pri big">다음 ▶</button></div>
<div class="wzb">${btn('slope:45', '45° (두 변이 같음)')}${btn('slope:fig', '모름 — 그림 비율대로 (약 ' + pa + '°)', 'ghost')}</div>
<p class="mut">각도는 ${AXW[g.p]} 방향에서 ${AXW[g.q]} 쪽으로 기운 각도입니다. 한 변만 알면 그 칸만 넣으세요(두 변이 같다고 봄). ${js.length > 1 ? '이 경사 구간에는 플랜지 등 지점이 ' + js.length + '개 있어서, 다음 질문에서 배관을 따라 잰 길이를 하나씩 묻습니다.' : '두 변을 넣으면 대각 길이도 자동으로 계산합니다.'}</p>`;
      } else if (q.phase === 'type') {
        pts = [s._p];
        const lg = symGuess(q.ri, q.si, 'type'), gv = lg ? lg.v : s.vguess;
        title = branchNote + '빨간 원 안의 표시는 무엇인가요?' + (lg ? ' <span class="wzt wzto">지난번 비슷한 모양을 "' + E(TYPEK[lg.v] || lg.v) + '"(으)로 고르셨습니다</span>' : s.vguess ? ' <span class="wzt">' + (s.vguess === 'check' ? '플랜지 ─ 체크 밸브 ─ 플랜지 모양으로 보임' : '밸브 모양으로 보임') + '</span>' : '');
        const on = v => (gv === v ? 'on' : '');
        body = `<div class="wzb">${btn('type:flange', '플랜지 연결', on('flange'))}${btn('type:gate', '게이트 밸브' + (s.vguess === 'gate' ? ' (플랜지형)' : ''), on('gate'))}${btn('type:globe', '글로브 밸브', on('globe'))}${btn('type:check', '체크 밸브' + (s.vguess === 'check' ? ' (플랜지형)' : ''), on('check'))}${btn('type:ball', '볼 밸브', on('ball'))}${btn('type:butterfly', '버터플라이 밸브', on('butterfly'))}${btn('type:ctrl', '제어 밸브', on('ctrl'))}${btn('type:none', '아무것도 아님', gv === 'none' ? 'on' : 'ghost')}</div>`;
      } else if (q.phase === 'vsize') {
        pts = [s._p];
        const cur = npsAt(q.ri, q.si);
        title = branchNote + `밸브 크기는 몇 인치인가요? (배관 ${nf(cur)})`;
        body = `<div class="wzb">${btn('vs:' + cur, '배관과 같음 (' + nf(cur) + ')', s.vnps && +s.vnps !== cur ? '' : 'on')}${QS.filter(v => v < cur).reverse().map(v => btn('vs:' + v, nf(v), +s.vnps === v ? 'on' : '')).join('')}</div>
        <p class="mut">도면 BOM이나 밸브 옆 크기 표시(예: 1/2")를 보고 고르세요. 밸브 앞뒤 플랜지도 이 크기로 들어갑니다.</p>`;
      } else if (q.phase === 'rsize') {
        pts = [s._p];
        const cur = npsAt(q.ri, q.si);
        title = branchNote + `레듀서로 보입니다. ${nf(cur)}에서 몇 인치로 바뀌나요?`;
        const smaller = QS.filter(v => v < cur).reverse(), bigger = QS.filter(v => v > cur).slice(0, 3), bz = bomSmaller(cur, true), pick = bz != null && smaller.includes(bz) ? bz : smaller[0];
        if (bz != null) title += ` <span class="wzt">도면 BOM: ${nf(cur)} × ${nf(bz)} 레듀서</span>`;
        body = `<div class="wzb">${smaller.map(v => btn('rs:' + v, nf(cur) + ' → ' + nf(v), v === pick ? 'on' : '')).join('')}${bigger.map(v => btn('rs:' + v, nf(cur) + ' → ' + nf(v) + ' (커짐)', 'ghost')).join('')}</div>
        <div class="wzb">${btn('rt:conc', '동심 (CONC)', (s.rt || 'conc') === 'conc' ? 'on' : 'ghost')}${btn('rt:ecc', '편심 (ECC)', s.rt === 'ecc' ? 'on' : 'ghost')}${btn('rs:none', '레듀서 아님', 'ghost')}</div>`;
      } else if (q.phase === 'branch') {
        pts = [s._p];
        title = branchNote + '여기서 배관이 갈라집니다. 갈라지는 쪽 배관 크기는?';
        const cur = npsAt(q.ri, q.si), lz = labelBranch(s.id), bz = lz != null && lz <= cur ? lz : bomSmaller(cur, false);
        if (lz != null && lz <= cur) title += ` <span class="wzt wzto">도면의 가지 배관에 ${nf(lz)} 표기가 있습니다</span>`;
        else if (bz != null) title += ` <span class="wzt">도면 BOM에 ${nf(bz)} 자재가 있습니다</span>`;
        body = `<div class="wzb">${btn('br:' + cur, '같은 크기 (' + nf(cur) + ')', bz == null || Math.abs(bz - cur) < 0.01 ? 'on' : '')}${QS.filter(v => v < cur).reverse().map(v => btn('br:' + v, nf(v), v === bz ? 'on' : '')).join('')}${btn('br:none', '갈라지는 곳 아님', 'ghost')}</div>`;
      } else if (q.phase === 'len') {
        pts = [prev, s._p]; mode = 'seg';
        const what = { elbow: '꺾이는 곳', flange: '플랜지', valve: '밸브 중심', tee: '갈라지는 곳', tee_in: '만나는 곳', reducer: '레듀서', end: '배관 끝', equip: '장치 노즐', inst: '계기' }[s.t] || '다음 지점';
        const rlg = rollOf(q.ri, q.si);
        const oc = s.ocr;
        title = branchNote + `두 빨간 원 사이(→ ${what}) 길이는 몇 mm 인가요?` + (rlg ? ' <span class="wzt">비스듬한 구간 — 배관을 따라 잰 길이</span>' : '') + (oc ? ` <span class="wzt wzto">도면에서 읽은 값 <b>${oc.v}</b> (확신 ${oc.c}%)${oc.amb ? ' · 근처에 다른 숫자도 있음' : ''} — 맞으면 다음, 틀리면 고치세요</span>` : '');
        body = `<div class="row wzs"><input id="wzd" type="number" inputmode="numeric" placeholder="도면 치수 (예: ${s.d})" value="${oc ? oc.v : ''}" style="font-size:22px;width:300px"><button data-wz="len" class="pri big">다음 ▶</button>${btn('len:skip', '치수가 안 보임 (어림값 ' + s.d + ' 사용)', 'ghost')}</div>
        <div class="wzno"><span>파란 띠가 배관이 아닌가요?</span>${btn('cut', '✕ 이 구간은 배관이 아님 (점선·치수선 등)', 'warn')}</div>`;
      } else if (q.phase === 'end') {
        pts = [s._p];
        const le = symGuess(q.ri, q.si, 'end'), bg0 = !le && s.guess !== 'cap' ? bomEndGuess(q.ri, q.si) : null, bg = bg0 && (!s.guess || (s.flTick && bg0 === 'blind')) ? bg0 : null, ge = le ? le.v : bg || s.guess;
        const eg = le ? '지난번 비슷한 모양을 "' + (ENDK[le.v] || le.v) + '"(으)로 고르셨습니다' : bg ? '도면 BOM에 아직 안 쓴 ' + ({ cap: '캡', blind: '블라인드 플랜지', flange: '플랜지' }[bg]) + '가 있습니다' : s.flTick ? '끝에 플랜지 표시가 보입니다 — 다른 장·장치와 맞대는 면' : { cap: '캡 모양(ㄷ)이 보입니다', flange: '밸브 바로 끝 — 플랜지로 계기·장치에 연결될 가능성' }[s.guess];
        title = branchNote + '배관이 여기서 끝납니다. 끝은 어떻게 되나요?' + (eg ? ' <span class="wzt' + (le ? ' wzto' : '') + '">' + E(eg) + '</span>' : '');
        const eo = v => (ge === v ? 'on' : '');
        body = `<div class="wzb">${btn('end:open', '기존 배관에 연결 / 용접', eo('open'))}${btn('end:cap', '캡', eo('cap'))}${btn('end:blind', '블라인드 플랜지', eo('blind'))}${btn('end:flange', '플랜지 (열림)', eo('flange'))}${btn('end:pump', '펌프', eo('pump'))}${btn('end:vessel', '베셀·탑', eo('vessel'))}${btn('end:drum', '드럼', eo('drum'))}${btn('end:hx', '열교환기', eo('hx'))}</div><div class="row wzs"><label>장치 번호 (장치일 때) <input id="wztag" placeholder="예: P-101A"></label></div>`;
      }
    }
    const pct = Math.round(idx / total * 100);
    P.ov('3D로 바꾸기 — ' + W.f.name, `<div class="wz">
 <div class="wzhd"><div class="wzbar"><i style="width:${q.phase === 'done' ? 100 : pct}%"></i></div><span class="mut">${q.phase === 'done' ? '완료' : idx + ' / ' + total}</span></div>
 <div class="wzmain"><canvas id="wzcv" width="1100" height="560"></canvas><canvas id="wzmini" width="220" height="150"></canvas></div>
 <h3 class="wzq" id="wzq0">${title}</h3>${W.ocrRun ? `<p class="wzocrb">⏳ <span id="wzocr">${E(W.ocrMsg || '도면 치수 읽는 중…')}</span> — 다 읽으면 길이가 자동으로 채워집니다.</p>` : ''}${body}
 <div class="row wzft"><button data-wz="back"${W.hist.length ? '' : ' disabled'}>← 이전</button><span style="flex:1"></span>${B && !B.run && W.batchI != null ? '<button data-bt="res">← 일괄 변환 결과</button>' : '<button data-att="back">그만두기</button>'}<button data-wz="adv" class="ghost">고급 편집</button></div>
 <div id="wzmsg" class="mut"></div></div>`);
    $('iso3').hidden = true; $('isop').hidden = true;
    const marks = q.phase === 'size' ? (R.cands || []).filter(c => dist2(c, R.runs[0]._p0) > 1) : null;
    W.ocrMark = q.phase === 'len' && s && s.ocr ? s.ocr : null;
    wView(pts.filter(Boolean), mode, marks);
    if (q.phase === 'done') wReviewBind();
    if (q.phase === 'size' && R.cands && R.cands.length > 1) wPick(pts.filter(Boolean), mode, marks);
    const d = $('wzd'); if (d) { d.focus(); d.onkeydown = e => { if (e.key === 'Enter') wAnswer('len'); }; }
  }
  const WHAT = { elbow: '엘보', flange: '플랜지', valve: '밸브', tee: '티', tee_in: '티(만남)', reducer: '레듀서', end: '끝', equip: '장치', inst: '계기' };
  const SRC = { ocr: ['도면 읽음', 'ok'], 'ocr-ok': ['도면 읽음·확인', 'ok'], fit: ['ASME 자동', 'fit'], user: ['직접 입력', 'us'], est: ['어림값', 'bad'] };
  // 끝 화면: 구간별 길이와 그 출처를 한눈에 보고 바로 고치기
  // 만들기 전에: 엘보 개수·각도를 도면 BOM과 비교
  function wElbCheck() {
    const be = bomElb(); if (!be) return '';
    const c = { 90: 0, 45: 0, x: 0 };
    W.R.runs.forEach(r => r.steps.forEach(x => { if (x.t !== 'elbow') return; const a = +x.eang || 90; if (Math.abs(a - 90) < 1) c[90]++; else if (Math.abs(a - 45) < 1) c[45]++; else c.x++; }));
    const ok = c[90] === be[90] && c[45] === be[45] && !c.x;
    return `<p class="${ok ? '' : 'wzocrb'}" style="margin:4px 0 8px">${ok ? '✓' : '⚠'} 엘보: 지금 경로 90° <b>${c[90]}</b> · 45° <b>${c[45]}</b>${c.x ? ' · 각도 맞춤 <b>' + c.x + '</b>' : ''} — 도면 BOM 90° <b>${be[90]}</b> · 45° <b>${be[45]}</b>${ok ? ' (같음)' : ' — 다릅니다. 경사 구간의 면(수평/수직)이나 빠진 꺾임을 확인하세요. 엘보는 크기별로 BOM에 따로 적혀 있을 수 있습니다.'}</p>`;
  }
  function wReview() {
    const rows = [];
    W.R.runs.forEach((r, ri) => r.steps.forEach((s, si) => {
      const src = SRC[s.auto] || (s.est ? SRC.est : SRC.user);
      const oc = s.ocr && s.auto !== 'ocr' && s.auto !== 'ocr-ok' && +s.ocr.v !== +s.d ? ` <span class="mut">(도면: ${s.ocr.v})</span>` : '';
      rows.push(`<tr data-wzrow="${ri}.${si}"><td>${ri + 1}-${si + 1}</td><td>${WHAT[s.t] || s.t}${s.rollSeg && s.legs ? ' <span class="mut">(경사: 변 ' + s.legs.join('·') + ' → 대각)</span>' : s.rollSeg ? ' <span class="mut">(경사 대각)</span>' : ''}${s.t === 'elbow' && s.eang && Math.abs(s.eang - 90) > 0.5 ? ' <span class="mut">' + s.eang + '°</span>' : ''}</td><td><input data-wzlen="${ri}.${si}" type="number" value="${E(String(s.d))}"> mm${oc}</td><td><span class="wzsrc ${src[1]}">${src[0]}${s.auto === 'ocr' ? ' ' + s.ocr.c + '%' : ''}</span></td></tr>`);
    }));
    const cnt = k => W.R.runs.reduce((a, r) => a + r.steps.filter(s => k.includes(s.auto || (s.est ? 'est' : 'user'))).length, 0);
    const no = cnt(['ocr', 'ocr-ok']), ne = cnt(['est']);
    const st = W.ocrRun ? '' : (W.ocrErr ? '<p class="mut">치수 자동 읽기를 못 했습니다 — 길이는 직접 넣은 값입니다.</p>' : '');
    return `${st}<p>도면에서 읽은 치수 <b>${no}곳</b>${ne ? ', 어림값 <b style="color:#b91c1c">' + ne + '곳</b>' : ''}. 줄을 누르면 위 그림에 그 구간이 보입니다. 틀린 길이는 바로 고치세요.</p>
<div class="wzrev"><table><thead><tr><th>구간</th><th>→ 지점</th><th>길이</th><th>출처</th></tr></thead><tbody>${rows.join('')}</tbody></table></div>`;
  }
  function wReviewBind() {
    document.querySelectorAll('[data-wzrow]').forEach(tr => {
      tr.onclick = e => {
        const [ri, si] = tr.dataset.wzrow.split('.').map(Number), r = W.R.runs[ri], s = r.steps[si], prev = si === 0 ? r._p0 : r.steps[si - 1]._p;
        document.querySelectorAll('[data-wzrow].on').forEach(x => x.classList.remove('on')); tr.classList.add('on');
        W.ocrMark = s.ocr || null; wView([prev, s._p].filter(Boolean), 'seg'); W.ocrMark = null;
      };
    });
    document.querySelectorAll('[data-wzlen]').forEach(inp => {
      inp.onchange = () => {
        const [ri, si] = inp.dataset.wzlen.split('.').map(Number), s = W.R.runs[ri].steps[si], n = +inp.value;
        if (!(n > 0)) { inp.value = s.d; return; }
        wSnap(); s.d = n; s.okLen = true; s.auto = s.ocr && +s.ocr.v === n ? 'ocr-ok' : 'user'; delete s.est; delete s.conf;
        const sp = inp.closest('tr').querySelector('.wzsrc'), src = SRC[s.auto]; sp.className = 'wzsrc ' + src[1]; sp.textContent = src[0];
      };
    });
  }
  /* ---------- ⑤ 기호 학습: 고른 답을 기호 모양과 함께 기억 → 다음에 비슷한 모양이면 미리 골라 둠 ---------- */
  const TYPEK = { flange: '플랜지 연결', gate: '게이트 밸브', globe: '글로브 밸브', check: '체크 밸브', ball: '볼 밸브', butterfly: '버터플라이 밸브', ctrl: '제어 밸브', none: '아무것도 아님' };
  const ENDK = { open: '기존 배관에 연결', cap: '캡', blind: '블라인드 플랜지', flange: '플랜지 (열림)', pump: '펌프', vessel: '베셀·탑', drum: '드럼', hx: '열교환기' };
  const SYMK = 'p3d_sym';
  const symLoad = () => { try { return JSON.parse(localStorage.getItem(SYMK) || '[]'); } catch (e) { return []; } };
  function symSig(ri, si) {
    if (!W.ext || !W.ext._pg) return null;
    const r = W.R.runs[ri], st = r && r.steps[si]; if (!st || !st._p) return null;
    const p = st._p, prev = si === 0 ? r._p0 : r.steps[si - 1]._p; if (!prev) return null;
    let ax = [p[0] - prev[0], p[1] - prev[1]]; const L = Math.hypot(ax[0], ax[1]) || 1; ax = [ax[0] / L, ax[1] / L];
    const R = 13, H = new Array(8).fill(0); let tot = 0, nf = 0, ex = [0, 0];
    W.ext._pg.segs.forEach(q => {
      const [a, b] = q, m = [(a[0] + b[0]) / 2, (a[1] + b[1]) / 2], v = [m[0] - p[0], m[1] - p[1]];
      if (Math.hypot(v[0], v[1]) > R) return;
      if (q.isFill) { nf++; return; }
      const d = [b[0] - a[0], b[1] - a[1]], l = Math.hypot(d[0], d[1]); if (l < 0.8 || l > 25) return;
      const along = Math.abs(d[0] * ax[0] + d[1] * ax[1]) / l; if (along > 0.97 && l > 10) return; // 배관 선 자체는 뺌
      let ang = Math.atan2(d[0] * ax[1] - d[1] * ax[0], d[0] * ax[0] + d[1] * ax[1]) * 180 / Math.PI; ang = ((ang % 180) + 180) % 180;
      H[Math.min(7, Math.floor(ang / 22.5))] += l; tot += l;
      ex[0] = Math.max(ex[0], Math.abs(v[0] * ax[0] + v[1] * ax[1])); ex[1] = Math.max(ex[1], Math.abs(v[0] * -ax[1] + v[1] * ax[0]));
    });
    if (tot < 3) return null;
    return { h: H.map(x => Math.round(x / tot * 1000) / 1000), t: Math.round(tot * 10) / 10, f: Math.min(nf, 20), e: ex.map(x => Math.round(x * 10) / 10) };
  }
  function symDist(a, b) { let d = 0; for (let i = 0; i < 8; i++) d += Math.abs(a.h[i] - b.h[i]); return d + Math.abs(Math.log((a.t + 1) / (b.t + 1))) * 0.6 + Math.abs(a.f - b.f) * 0.03 + (Math.abs(a.e[0] - b.e[0]) + Math.abs(a.e[1] - b.e[1])) * 0.02; }
  function symGuess(ri, si, kind) {
    const st = W.R.runs[ri].steps[si]; if (!st._sig) st._sig = symSig(ri, si) || 0; if (!st._sig) return null;
    let best = null; symLoad().forEach(m => { if (m.k !== kind) return; const d = symDist(st._sig, m.s); if (d < 0.32 && (!best || d < best.d)) best = { d, v: m.v }; });
    return best;
  }
  function symLearn(ri, si, kind, v) {
    try {
      const st = W.R.runs[ri].steps[si]; const sg = st._sig || symSig(ri, si); if (!sg) return;
      let L = symLoad().filter(m => !(m.k === kind && symDist(m.s, sg) < 0.08)); // 같은 모양은 새 답으로 바꿈
      L.push({ k: kind, v, s: sg, t: Date.now() }); if (L.length > 400) L = L.slice(-400);
      localStorage.setItem(SYMK, JSON.stringify(L));
    } catch (e) { }
  }
  /* ---------- ⑫ 원본 도면 ↔ 다시 만든 ISO 나란히 ---------- */
  function wCompare() {
    if (!W.built || !W.built.length) return;
    P.showIso(W.built[0]);
    const sv = document.querySelector('#isob svg'), svg = sv ? sv.outerHTML : '<p class="mut">ISO를 만들지 못했습니다.</p>';
    const img = W.big.toDataURL('image/png');
    const cnt = { elbow: 0, tee: 0, valve: 0, reducer: 0, flange: 0, end: 0 }, len = { d: 0 };
    W.R.runs.forEach(r => r.steps.forEach(x => { if (x.t === 'tee_in') cnt.tee++; else if (cnt[x.t] != null) cnt[x.t]++; }));
    const it = P.bom(W.built), q = re => it.filter(x => re.test(x.code)).reduce((a, x) => a + x.q, 0);
    const pipeM = Math.round(q(/^PIPE$/) * 100) / 100;
    const rows = [['엘보', cnt.elbow, q(/^ELBOW/)], ['티', cnt.tee, q(/^TEE/)], ['밸브', cnt.valve, q(/V\/V$/)], ['레듀서', cnt.reducer, q(/^REDUCER/)], ['플랜지 (낱개)', '—', q(/FLANGE/)]];
    P.ov('원본 ↔ 다시 만든 ISO — ' + W.f.name, `<div class="wzcmp"><div class="row wzft" style="margin:0 0 8px;border:0;padding:0"><button data-wz="cmpback">← 결과 화면</button><button data-wz="cmpiso">ISO 화면에서 고치기·인쇄</button><span class="mut">그림을 누르면 크게 봅니다</span></div>
<div class="cmpg"><figure><figcaption>원본 도면 (PDF)</figcaption><img src="${img}" alt="원본"></figure><figure><figcaption>3D에서 다시 만든 ISO</figcaption>${svg}</figure></div>
<div class="wzrev" style="max-width:640px"><table><thead><tr><th>항목</th><th>원본에서 읽은 경로</th><th>다시 만든 ISO</th></tr></thead><tbody>${rows.map(([a, b, c]) => `<tr><td>${a}</td><td>${b}</td><td>${c}${b !== '—' && b !== c ? ' <span class="wzsrc bad">다름</span>' : ''}</td></tr>`).join('')}<tr><td>배관 길이</td><td>—</td><td>${pipeM} m</td></tr></tbody></table></div>
${W.bom ? '<p class="mut">도면 BOM과의 자세한 비교는 결과 화면의 "도면 BOM ↔ 3D 자재" 표에 있습니다.</p>' : ''}</div>`);
    $('iso3').hidden = true; $('isop').hidden = true;
    document.querySelectorAll('.cmpg figure').forEach(f => f.onclick = () => f.classList.toggle('big'));
  }
  const dist2 = (a, b) => Math.hypot(a[0] - b[0], a[1] - b[1]);
  // 시작점 고르기: 초록 원(배관 끝)을 누르거나 빨간 원을 끌어다 놓으면 그 끝에서 다시 시작
  function wPick(pts, mode, marks) {
    const cv = $('wzcv'); if (!cv) return;
    cv.style.cursor = 'pointer'; cv.style.touchAction = 'none';
    const at = e => { const b = cv.getBoundingClientRect(); return [(e.clientX - b.left) * cv.width / b.width, (e.clientY - b.top) * cv.height / b.height]; };
    const near = c => { let best = null, bd = 1e9; W.R.cands.forEach(p => { const q = W.vt.T2(p), dd = Math.hypot(q[0] - c[0], q[1] - c[1]); if (dd < bd) { bd = dd; best = p; } }); return bd < 45 ? best : null; };
    let drag = false;
    cv.onpointerdown = e => { const c = at(e), s0 = W.vt.T2(W.R.runs[0]._p0); drag = Math.hypot(s0[0] - c[0], s0[1] - c[1]) < 30; if (drag) cv.setPointerCapture(e.pointerId); };
    cv.onpointermove = e => { if (drag) wView(pts, mode, marks, at(e)); else cv.style.cursor = near(at(e)) ? 'pointer' : 'default'; };
    cv.onpointerup = e => {
      const p = near(at(e)); const wasDrag = drag; drag = false;
      const m = $('wzmsg');
      if (!p) { if (wasDrag) wView(pts, mode, marks); if (m) m.textContent = '초록 원(배관 끝) 가까이에 놓아 주세요.'; return; }
      if (dist2(p, W.R.runs[0]._p0) < 1) { if (wasDrag) wView(pts, mode, marks); return; }
      wSnap(); W.startNear = p.slice();
      if (!wReroute()) { const h = JSON.parse(W.hist.pop()); W.R = h.R; W.q = h.q; W.startNear = h.startNear; wRender(); return; }
      wRender(); const m2 = $('wzmsg'); if (m2) m2.textContent = '시작점을 바꿨습니다. 맞으면 배관 크기를 고르세요.';
    };
  }
  function wAnswer(a) {
    const R = W.R, q = W.q, r = R.runs[q.ri], s = r && r.steps[q.si];
    if (a === 'back') { const h = W.hist.pop(); if (h) { const o = JSON.parse(h); W.R = o.R; W.q = o.q; if (o.excl) W.excl = o.excl; if (o.startAt != null) W.startAt = o.startAt; W.startNear = o.startNear; } wRender(); return; }
    if (a === 'adv') { const f = W.f; f.route = W.R; P.fPut(f).then(() => table(W.fid)); return; }
    if (a === 'build') { wBuild(); return; }
    const say = t => { const m = $('wzmsg'); if (m) m.textContent = t; };
    if (a === 'notpipe' || a === 'nextstart') {
      wSnap();
      W.startNear = null; if (a === 'notpipe') { const r0 = R.runs[0], s0 = r0.steps[0]; W.excl.push([r0._p0, (s0 && s0._p) || r0._p0]); W.startAt = 0; } else W.startAt = (R.startIdx || 0) + 1;
      if (!wReroute()) { const h = JSON.parse(W.hist.pop()); W.R = h.R; W.q = h.q; W.excl = h.excl; W.startAt = h.startAt; wRender(); say('남은 배관 선이 없습니다. "고급 편집"에서 직접 그려 주세요.'); return; }
      wRender(); say(a === 'notpipe' ? '그 선을 빼고 배관을 다시 찾았습니다.' : '다른 끝에서 시작합니다.'); return;
    }
    if (a === 'cut') {
      wSnap();
      if (q.ri === 0 && q.si === 0) { W.excl.push([r._p0, s._p]); W.startAt = 0; if (!wReroute()) { const h = JSON.parse(W.hist.pop()); W.R = h.R; W.q = h.q; W.excl = h.excl; W.startAt = h.startAt; wRender(); say('남은 배관 선이 없습니다.'); return; } wRender(); say('그 선을 빼고 배관을 다시 찾았습니다.'); return; }
      const gone = r.steps.splice(q.si);
      gone.forEach(g => { if (g.id) for (let k = R.runs.length - 1; k >= 0; k--) if (R.runs[k].start && R.runs[k].start.tee === g.id) wDropRun(k); });
      const ri = R.runs.indexOf(r);
      if (!r.steps.length) { wDropRun(ri); W.q = { ri, si: 0, phase: null }; }
      else { const last = r.steps[r.steps.length - 1]; if (last.t === 'elbow') { last.t = 'end'; last.okEnd = false; } W.q = { ri, si: Math.max(0, r.steps.length - 1), phase: null }; }
      wFirstPhase(); wRender(); say('그 구간을 뺐습니다. 배관은 앞 지점에서 끝납니다.'); return;
    }
    wSnap();
    const [k, v] = a.split(':');
    if ((k === 'type' || k === 'end') && s && !W.auto) symLearn(q.ri, q.si, k, v);
    if (k === 'roll') {
      const r0 = W.R.runs[q.ri], nx = r0.steps[q.si + 1];
      s.roll.pl = v; s.okRoll = true; s.rollPick = v;
      const flat = v === 'AX';
      if (flat) { s.to = s.roll.alts.AX; delete s.eang; delete s.e45; rollSteps(q.ri, q.si).forEach(j => { const x = r0.steps[j]; x.rollSeg = false; if (x.t === 'elbow') { delete x.eang; delete x.e45; } }); }
      else rollApply(q.ri, q.si, rollVec(s.roll, v, s.rollLegs));
      wAdvance(); wRender(); return;
    }
    if (k === 'slope') {
      const rl = s.roll, g = rl.pq[rl.pl]; let legs = null;
      s.slopeFig = false; if (v === '45') legs = [1, 1];
      else if (v === 'fig') { legs = [Math.abs(g.a), Math.abs(g.b)]; s.slopeFig = true; }
      else { let a1 = +$('wzl1').value, a2 = +$('wzl2').value, an = +$('wzla').value;
        if (a1 > 0 || a2 > 0) { if (!(a1 > 0)) a1 = a2; if (!(a2 > 0)) a2 = a1; legs = [a1, a2]; s.rollLegs = [a1, a2]; }
        else if (an > 0 && an < 90) { legs = [Math.cos(an * Math.PI / 180), Math.sin(an * Math.PI / 180)]; s.rollDeg = an; }
        else { W.hist.pop(); const m = $('wzmsg'); if (m) m.textContent = '변 길이나 각도를 넣거나, 아래 버튼을 고르세요.'; return; } }
      const vec = rollVec(rl, rl.pl, legs); rollApply(q.ri, q.si, vec); s.okSlope = true;
      // 경사 구간이 한 토막이고 두 변을 알면 대각 길이도 바로
      const js = rollSteps(q.ri, q.si); if (js.length === 1 && s.rollLegs) { const x = W.R.runs[q.ri].steps[js[0]]; x.d = Math.round(Math.hypot(s.rollLegs[0], s.rollLegs[1]) * 10) / 10; x.okLen = true; x.auto = 'user'; delete x.est; delete x.conf; }
      wAdvance(); wRender(); return;
    }
    if (k === 'size') { W.sizeAns = true; R.nps = +v; R.runs[0].nps = +v; const ln = $('wzln'), cl = $('wzcls'); if (ln) R.line_no = ln.value.trim(); if (cl) R.cls = +cl.value; const ce = $('wzce'); if (ce) R.ce = ce.value; wAdvance(); }
    else if (k === 'type') {
      if (v === 'none') { (W.dropped = W.dropped || []).push({ at: (q.ri + 1) + '-' + (q.si + 1), z: npsAt(q.ri, q.si) }); const nx = r.steps[q.si + 1]; if (nx) { nx.d = (+nx.d || 0) + (+s.d || 0); nx.okLen = false; } r.steps.splice(q.si, 1); W.q.phase = null; wFirstPhase(); }
      else { if (v === 'flange') { s.t = 'flange'; delete s.vt; } else { s.t = 'valve'; s.vt = v; s.conn = 'flg'; } s.okType = true; wAdvance(); }
    }
    else if (k === 'vs') { s.vnps = +v; s.okVsize = true; wAdvance(); }
    else if (k === 'rt') { W.hist.pop(); s.rt = v; wRender(); return; }
    else if (k === 'rs') {
      if (v === 'none') { (W.dropped = W.dropped || []).push({ at: (q.ri + 1) + '-' + (q.si + 1), z: npsAt(q.ri, q.si) }); const nx = r.steps[q.si + 1]; if (nx) { nx.d = (+nx.d || 0) + (+s.d || 0); nx.okLen = false; } r.steps.splice(q.si, 1); W.q.phase = null; wFirstPhase(); }
      else { s.nps2 = +v; s.rt = s.rt || 'conc'; s.okRed = true; wAdvance(); }
    }
    else if (k === 'br') {
      if (v === 'none') { // 티가 아니면: 이 티에서 시작한 갈라진 배관을 지움
        const id = s.id; s.t = 'flange'; s.okType = false; delete s.id; delete s.branch; delete s.nps2;
        const nx = r.steps[q.si + 1]; if (nx) { nx.d = (+nx.d || 0) + (+s.d || 0); nx.okLen = false; } r.steps.splice(q.si, 1); R.runs = R.runs.filter(x => !(x.start && x.start.tee === id)); W.q.phase = null; wFirstPhase();
      } else { s.nps2 = +v; s.okBranch = true; R.runs.forEach(x => { if (x.start && x.start.tee === s.id) x.nps = +v; }); wAdvance(); }
    }
    else if (k === 'len') {
      if (v !== 'skip') { const el = $('wzd'), n = +(el && el.value); if (!(n > 0)) { W.hist.pop(); const m = $('wzmsg'); if (m) m.textContent = '숫자를 입력해 주세요. 치수가 안 보이면 "치수가 안 보임"을 누르세요.'; return; } s.d = n; delete s.conf; delete s.est; s.auto = s.ocr && +s.ocr.v === n ? 'ocr-ok' : 'user'; } else s.auto = 'est';
      s.okLen = true; wAdvance();
    }
    else if (k === 'end') {
      const tag = (($('wztag') || {}).value || '').trim();
      if (['pump', 'vessel', 'drum', 'hx'].includes(v)) { s.t = 'equip'; s.kind = v; s.tag = tag || ({ pump: 'P', vessel: 'V', drum: 'D', hx: 'E' }[v] + '-?'); s.nozzle = v === 'pump' ? 'SUC' : 'N1'; }
      else s.end = v;
      s.okEnd = true; wAdvance();
    }
    wRender();
  }
  function wJoinUI() {
    const el = $('wzjoin'); if (!el) return;
    const tt = W.title || {}, sh = W.f.sheet || {};
    let h = W.clsCode ? `<p>📋 라인 번호에서 클래스 <b>${E(W.clsCode)}</b>를 찾아 자재 사양(재질·등급·가스켓·볼트)을 적용했습니다.</p>` : '';
    const info = (sh.ln ? '라인 <b>' + E(sh.ln) + '</b>' : '라인 번호 없음') + (sh.sht ? ' · ' + sh.sht + '/' + (sh.of || '?') + '장' : '');
    if (W.placed && W.placed.kind === 'join') h += `<p>🔗 ${info} — <b>${E(W.placed.lab)}</b>에 이 장의 ${E(W.placed.e)} 쪽을 맞춰 이어 붙였습니다.</p>`;
    else if (W.placed && W.placed.kind === 'xyz') h += `<p>📍 ${info} — ${E(W.placed.lab)} 를 실제 좌표 E ${W.placed.E} · N ${W.placed.N} · EL ${W.placed.EL} 에 놓았습니다.</p>`;
    else if (W.cands && W.cands.length) h += `<p>🔗 ${info} — 같은 라인의 다른 장이 있습니다. 아래에서 이을 곳을 고르세요.</p>`;
    else if (sh.of > 1) h += `<p class="mut">🔗 ${info} — 같은 라인의 다른 장을 3D로 만들면 끝끼리 자동으로 이어 붙입니다 (방향·크기가 맞는 끝).</p>`;
    if (W.cands && W.cands.length) h += `<div class="row wzs"><label>이어 붙일 곳 <select id="wzjsel">${opt([[-1, '잇지 않음 (따로 둠)']].concat(W.cands.slice(0, 12).map((c, i) => [i, '이 장 ' + c.e.lab + ' → ' + c.lab])), W.placed && W.placed.kind === 'join' ? W.placed.i : -1)}</select></label><button data-wz="join">적용</button></div>`;
    // 좌표 맞춤
    const nodes = nodesOf(W.R), co = (W.coords || [])[0];
    let pre = null;
    if (co) { let best = null, bd = 120; nodes.forEach(n => { const d = Math.hypot(n.p[0] - co.p[0], n.p[1] - co.p[1]); if (d < bd) { bd = d; best = n; } }); if (best) pre = { n: best, co }; }
    const xv = W.placed && W.placed.kind === 'xyz' ? W.placed : pre ? { id: pre.n.id, E: pre.co.e ?? '', N: pre.co.n ?? '', EL: pre.co.el ?? '' } : { id: nodes[0] && nodes[0].id, E: '', N: '', EL: '' };
    h += `<details class="wzraw"${pre || (W.placed && W.placed.kind === 'xyz') ? ' open' : ''}><summary>📍 실제 좌표(E·N·EL)에 놓기${pre ? ' — 도면에서 좌표를 읽었습니다: ' + E(pre.co.t) : ''}</summary>
<div class="row wzs"><label>기준점 <select id="wzxn">${opt(nodes.map(n => [n.id, n.lab]), xv.id)}</select></label><label>E (mm) <input id="wzxe" type="number" value="${xv.E}" style="width:110px"></label><label>N (mm) <input id="wzxnn" type="number" value="${xv.N}" style="width:110px"></label><label>EL (mm) <input id="wzxel" type="number" value="${xv.EL}" style="width:110px"></label><button data-wz="xyz">좌표에 놓기</button></div>
<p class="mut">좌표가 있는 장끼리는 따로 잇지 않아도 제자리에 맞춰집니다. E는 동쪽(+X), N은 북쪽, EL은 높이입니다.</p></details>`;
    el.innerHTML = h;
  }
  async function wPlace(a) {
    const say = t => { const m = $('wzjoin'); if (m) m.insertAdjacentHTML('beforeend', '<p class="wzocrb">' + E(t) + '</p>'); };
    if (a === 'join') {
      const i = +$('wzjsel').value;
      if (i < 0) { W.shift = null; W.placed = null; }
      else { const c = W.cands[i]; W.shift = c.shift; W.placed = { kind: 'join', lab: c.lab, e: c.e.lab, i }; }
    } else {
      const n = nodesOf(W.R).find(x => x.id === $('wzxn').value), E1 = +$('wzxe').value, N1 = +$('wzxnn').value, EL = +$('wzxel').value;
      if (!n || ![$('wzxe').value, $('wzxnn').value, $('wzxel').value].every(v => v !== '' && isFinite(+v))) return say('E·N·EL 세 값을 모두 넣어 주세요.');
      const tgt = [E1, EL, -N1]; W.shift = [0, 1, 2].map(i => Math.round((tgt[i] - n.c[i]) * 10) / 10); W.placed = { kind: 'xyz', lab: n.lab, id: n.id, E: E1, N: N1, EL };
    }
    await wBuild();
  }
  // 도면 BOM ↔ 3D 자재 비교
  const CATK = { PIPE: '배관', 'ELBOW 90': '90° 엘보', 'ELBOW 45': '45° 엘보', 'ELBOW X': '각도 맞춤 엘보 (도면 BOM과 확인)', ELBOW: '엘보', TEE: '티', REDUCER: '레듀서', CAP: '캡', FLANGE: '플랜지', 'BLIND FLANGE': '블라인드 플랜지', GASKET: '가스켓', 'STUD/BOLT': '스터드 볼트', 'GATE V/V': '게이트 밸브', 'GLOBE V/V': '글로브 밸브', 'CHECK V/V': '체크 밸브', 'BALL V/V': '볼 밸브', 'BFLY V/V': '버터플라이 밸브', 'PLUG V/V': '플러그 밸브', 'CONTROL V/V': '제어 밸브', VALVE: '밸브', NIPPLE: '니플', 'SWAGE NIPPLE': '스웨지 니플', COUPLING: '커플링', STRAINER: '스트레이너', UNION: '유니언', OLET: '올렛' };
  function bomCompare(bom, items) {
    const O = window.P3DOCR, rows = {}, key = (c, z, z2) => c + '|' + (z == null ? '?' : z) + (z2 ? 'x' + z2 : '');
    const put = (c, z, z2, side, q) => { if (!c) return; const k = key(c, z, z2); const r = rows[k] = rows[k] || { c, z, z2, d: 0, m: 0, dn: 0 }; if (side === 'd' && (q == null || isNaN(q))) r.nq = 1; else r[side] += q || 0; if (side === 'd') r.dn++; };
    const ek = (c, t) => c !== 'ELBOW' ? c : /롤링/.test(t) ? 'ELBOW X' : /45/.test(t) ? 'ELBOW 45' : 'ELBOW 90'; // 엘보는 각도별로
    bom.rows.forEach(r => put(ek(r.cat, (r.code || '') + ' ' + (r.desc || '')), r.size, r.cat === 'REDUCER' ? r.size2 : null, 'd', r.qty == null ? NaN : r.qty));
    (items || []).forEach(it => {
      if (it.code === 'PIPE SUPPORT') return;
      let c = /STRAINER/.test(it.code) ? 'STRAINER' : O.catOf(it.code); if (!c) return;
      c = ek(c, it.desc || '');
      const sz = String(it.size || ''), parts = sz.split('X');
      let z = O.sizeNum(parts[0]), z2 = null;
      if (c === 'REDUCER' && parts[1]) z2 = O.sizeNum(parts[1]);
      if (c === 'TEE') z2 = null;
      put(c, z, z2, 'm', it.q);
    });
    // 도면에 '밸브'로만 읽힌 줄은 같은 크기의 3D 밸브와 맞춤
    Object.values(rows).filter(r => r.c === 'VALVE' && r.dn).forEach(r => { Object.values(rows).filter(x => / V\/V$/.test(x.c) && !x.dn && x.z === r.z).forEach(x => { r.m += x.m; x.m = 0; x.merged = 1; }); });
    const list = Object.values(rows).filter(r => !(r.merged && !r.m));
    list.forEach(r => {
      if (r.nq) r.st = 'q';
      else if (!r.dn) r.st = 'extra';
      else if (r.c === 'PIPE') { r.m = Math.round(r.m * 100) / 100; r.st = r.m <= r.d + 0.3 && r.m >= r.d - Math.max(1, r.d * 0.5) ? 'ok' : 'diff'; }
      else r.st = Math.abs(r.d - r.m) < 0.01 ? 'ok' : 'diff';
      if (r.c === 'NIPPLE' && !r.m && r.st === 'diff') r.st = 'nip';
    });
    const ord = Object.keys(CATK);
    list.sort((a, b) => (ord.indexOf(a.c) + 1 || 99) - (ord.indexOf(b.c) + 1 || 99) || (b.z || 0) - (a.z || 0));
    return list;
  }
  function bomHtml(list) {
    const ST = { ok: ['✓ 같음', 'ok'], diff: ['차이', 'bad'], extra: ['도면에 없음', 'us'], q: ['수량 못 읽음', 'us'], nip: ['3D는 배관으로', 'fit'] };
    const nd = list.filter(r => r.st === 'diff').length;
    return `<h3 class="wzq" style="font-size:17px">도면 BOM ↔ 3D 자재 ${nd ? `<span class="wzsrc bad">다른 곳 ${nd}개</span>` : '<span class="wzsrc ok">모두 맞음</span>'}</h3>
<div class="wzrev"><table><thead><tr><th>품목</th><th>크기</th><th>도면 BOM</th><th>3D</th><th>결과</th></tr></thead><tbody>${list.map(r => {
      const u = r.c === 'PIPE' ? ' m' : '', zz = r.z == null ? '?' : nf(r.z) + (r.z2 ? ' × ' + nf(r.z2) : ''), diff = r.st === 'diff' && r.c !== 'PIPE' ? ` (${r.m - r.d > 0 ? '+' : ''}${r.m - r.d})` : '';
      return `<tr><td>${E(CATK[r.c] || r.c)}</td><td>${zz}</td><td>${r.dn ? (r.nq ? (r.d ? r.d + ' + ?' : '?') : r.d + u) : '-'}</td><td>${r.m ? r.m + u : '-'}</td><td><span class="wzsrc ${ST[r.st][1]}">${ST[r.st][0]}${diff}</span></td></tr>`; }).join('')}</tbody></table></div>
<p class="mut">BOM은 도면 그림에서 읽은 값이라 틀릴 수 있습니다. 배관은 BOM이 구매 길이(올림)라 3D가 조금 짧아도 같음으로 봅니다. 니플은 3D에서 짧은 배관으로 들어갑니다.</p>`;
  }
  function wBomSec() {
    if (!W || !W.built) return '';
    if (W.ocrRun) return '<p class="wzocrb">⏳ 도면 BOM을 읽는 중입니다… 다 읽으면 여기에 3D 자재와 비교표가 나옵니다.</p>';
    if (!W.bom) return W.words ? '<p class="mut">이 도면에서는 BOM 표를 찾지 못했습니다 (CODE·SIZE 머리글이 있는 표를 찾습니다).</p>' : '';
    const raw = `<details class="wzraw"><summary>도면에서 읽은 BOM ${W.bom.rows.length}줄 보기 · 잘못 읽은 값 고치기</summary><div class="wzrev"><table><thead><tr><th>CODE (읽은 글자)</th><th>품목</th><th>크기</th><th>수량</th></tr></thead><tbody>${W.bom.rows.map((x, i) => `<tr><td>${E(x.code)}</td><td><select data-bq="${i}:cat">${opt([['', '(제외)']].concat(Object.keys(CATK).map(k => [k, CATK[k]])), x.cat)}</select></td><td><select data-bq="${i}:size">${opt([['', '?']].concat(QS.map(v => [v, nf(v)])), x.size == null ? '' : x.size)}</select>${x.cat === 'REDUCER' ? ` × <select data-bq="${i}:size2">${opt([['', '?']].concat(QS.map(v => [v, nf(v)])), x.size2 == null ? '' : x.size2)}</select>` : ''} <span class="mut">${E(x.sizeTxt)}</span></td><td><input data-bq="${i}:qty" type="number" step="any" value="${x.qty == null ? '' : x.qty}" style="width:80px"></td></tr>`).join('')}</tbody></table></div></details>`;
    try { return bomHtml(bomCompare(W.bom, P.bom(W.built))) + raw; } catch (e) { return '<p class="mut">BOM 비교를 못 했습니다 (' + E(e.message) + ').</p>'; }
  }
  /* ---------- ③ 여러 장 잇기 · ④ 좌표 맞춤 ---------- */
  const normLn = t => String(t || '').toUpperCase().replace(/[^A-Z0-9]/g, '').replace(/O/g, '0');
  const DIRV = k => P.DIR[k];
  const negK = k => P.keyOf(P.DIR[k].clone().negate());
  // 이 장의 열린 끝 (캡·블라인드·장치로 끝난 곳은 제외)
  function openEnds(R) {
    const out = [];
    R.runs.forEach((r, ri) => {
      if (!(r.start && r.start.tee) && r._c0 && r._d0) out.push({ id: ri + '.s', p: r._p0, c: r._c0, out: negK(r._d0), nps: +r._nps0 || +R.nps, lab: (ri + 1) + '번 배관 시작' });
      r.steps.forEach((s2, si) => { if (s2.t === 'end' && s2._c && !['cap', 'blind'].includes(s2.end)) out.push({ id: ri + '.' + si, p: s2._p, c: s2._c, out: s2._din, nps: +s2._nps || +R.nps, lab: (ri + 1) + '번 배관 끝' }); });
    });
    return out;
  }
  // 경로의 모든 점 (좌표 넣을 기준점 고르기용)
  function nodesOf(R) {
    const out = [];
    R.runs.forEach((r, ri) => {
      if (r._c0) out.push({ id: ri + '.s', p: r._p0, c: r._c0, lab: (ri + 1) + '-시작' });
      r.steps.forEach((s2, si) => { if (s2._c) out.push({ id: ri + '.' + si, p: s2._p, c: s2._c, lab: (ri + 1) + '-' + (si + 1) + ' ' + (WHAT[s2.t] || s2.t) }); });
    });
    return out;
  }
  async function joinCands(ends, me) {
    const files = await P.fAll(), objs = P.getObjs(), res = [];
    files.forEach(f => {
      const sh = f.sheet; if (!sh || f.id === W.fid || !me.ln || normLn(sh.ln) !== normLn(me.ln)) return;
      const ref = sh.ref && objs.find(o => o.id === sh.ref.id && o.src === 'iso:' + f.id); if (!ref) return;
      const dv = [0, 1, 2].map(i => ref.pos[i] - sh.ref.pos[i]); // 그 장을 나중에 옮겼으면 그만큼
      ends.forEach(e => sh.ends.forEach(t => {
        if (!e.out || !t.out || DIRV(e.out).dot(DIRV(t.out)) > -0.9) return;
        if (e.nps && t.nps && Math.abs(e.nps - t.nps) > 0.01) return;
        let sc = 1 + (e.id.startsWith('0.') ? 0.5 : 0) + (String(t.id || '').startsWith('0.') ? 0.5 : 0); // 본 배관(첫 줄기) 끝을 우선
        if (me.sht && sh.sht) { if (Math.abs(me.sht - sh.sht) === 1) sc += 2; else sc -= 1; }
        if (e.to && sh.sht) sc += e.to === sh.sht ? 5 : -3;
        if (t.to && me.sht) sc += t.to === me.sht ? 5 : -3;
        const tc = [0, 1, 2].map(i => t.c[i] + dv[i]);
        res.push({ e, t, f, sc, shift: [0, 1, 2].map(i => Math.round((tc[i] - e.c[i]) * 10) / 10), lab: (sh.sht ? sh.sht + '/' + (sh.of || '?') + '장 ' : '') + '(' + f.name + ') ' + t.lab });
      }));
    });
    res.sort((a, b) => b.sc - a.sc);
    return res;
  }
  async function wBuild() {
    const b = buildRoute(W.R, W.src); W.bErrs = b.errs || [];
    const tt = W.title || {}, me = { ln: W.R.line_no || tt.line_no || '', sht: tt.sht || null, of: tt.of || null };
    const ends = openEnds(W.R);
    // 도면에서 읽은 'SEE 2/3' 표시를 가까운 끝에 붙임
    (W.see || []).forEach(m => { let best = null, bd = 160; ends.forEach(e => { const d = Math.hypot(e.p[0] - m.p[0], e.p[1] - m.p[1]); if (d < bd) { bd = d; best = e; } }); if (best) best.to = m.sht; });
    W.cands = await joinCands(ends, me);
    if (W.shift === undefined) {
      W.shift = null; W.placed = null;
      const c0 = W.cands[0], c1 = W.cands[1];
      if (c0 && (!c1 || c0.sc > c1.sc)) { W.shift = c0.shift; W.placed = { kind: 'join', lab: c0.lab, e: c0.e.lab, i: 0 }; }
    }
    if (W.shift) b.objs.forEach(o => { if (o.pos) o.pos = o.pos.map((v, i) => Math.round((v + W.shift[i]) * 10) / 10); });
    P.removeWhere(o => o.src === W.src);
    if (b.objs.length) P.loadModel(Object.assign(b, { name: W.f.name.replace(/\.pdf$/i, ''), keepPos: !!W.shift }));
    const made = P.getObjs().filter(o => o.src === W.src);
    const f = W.f; f.route = W.R;
    if (made.length && b.objs.length) {
      const off = [0, 1, 2].map(i => made[0].pos[i] - b.objs[0].pos[i] + (W.shift ? W.shift[i] : 0));
      f.sheet = { ln: me.ln, sht: me.sht, of: me.of, ends: ends.map(e => ({ id: e.id, c: e.c.map((v, i) => v + off[i]), out: e.out, nps: e.nps, to: e.to || null, lab: e.lab })), ref: { id: made[0].id, pos: made[0].pos.slice() } };
    }
    P.fPut(f);
    const ids = made.filter(o => !o.ex).map(o => o.id);
    P.ov('3D로 바꾸기 — 완료', `<div class="wz"><h3 class="wzq">3D를 만들었습니다 (부품 ${b.objs.length}개).</h3>
${b.errs.length ? `<p class="mut">맞지 않는 곳이 ${b.errs.length}군데 있습니다 (예: 앞 부품과 길이가 겹침). 3D를 보고 이상하면 "이전 단계로" 돌아가 길이를 고치거나, 고급 편집에서 확인하세요.</p>` : ''}
<div class="wzb"><button data-wz="see3d" class="pri big">3D로 보기</button><button data-wz="seeiso" class="big">원본 ↔ 다시 만든 ISO 나란히</button></div>
<div id="wzjoin"></div><div id="wzrv"></div><div id="wzbom"></div>
<div class="row wzft"><button data-wz="again">← 이전 단계로 (답 고치기)</button>${B && !B.run && W.batchI != null ? '<button data-bt="res">← 일괄 변환 결과</button>' : ''}<span style="flex:1"></span><button data-wz="adv" class="ghost">고급 편집</button></div></div>`);
    $('iso3').hidden = true; $('isop').hidden = true;
    W.built = ids; W.atBuild = true;
    try { W.clsCode = P.clsAuto ? P.clsAuto(ids) : null; } catch (e) { W.clsCode = null; }
    wJoinUI();
    rvShow();
    if (!W.auto) accSave(W);
    const bx = $('wzbom'); if (bx) { bx.innerHTML = wBomSec(); bx.onchange = e => { const t = e.target.closest('[data-bq]'); if (!t) return; const [i, k] = t.dataset.bq.split(':'), row = W.bom.rows[+i]; const v = t.value; row[k] = k === 'cat' ? v : (v === '' ? null : +v); const op = bx.querySelector('details').open; bx.innerHTML = wBomSec(); if (op) bx.querySelector('details').open = true; }; }
    if (W.ocrRun) { const w0 = W, t = setInterval(() => { if (W !== w0 || !$('wzbom')) return clearInterval(t); if (!w0.ocrRun) { clearInterval(t); $('wzbom').innerHTML = wBomSec(); rvShow(); accSave(w0); } }, 1000); }
  }
  function wClick(e) {
    const b = e.target.closest('[data-wz]'); if (!b || !W) return;
    const a = b.dataset.wz;
    if (a === 'see3d') { P.focus(P.getObjs().filter(o => o.src === W.src).map(o => o.id)); return; }
    if (a === 'seeiso') { wCompare(); return; }
    if (a === 'cmpback') { wBuild(); return; }
    if (a === 'cmpiso') { if (W.built && W.built.length) P.showIso(W.built[0]); return; }
    if (a === 'again') { W.q = { ri: 0, si: 0, phase: 'done' }; wRender(); return; }
    if (a === 'join' || a === 'xyz') { wPlace(a); return; }
    wAnswer(a);
  }
  document.getElementById('isob').addEventListener('click', wClick);
  const wcss = document.createElement('style');
  wcss.textContent = `.wz{max-width:1150px;margin:0 auto}.wzhd{display:flex;align-items:center;gap:10px;margin-bottom:8px}.wzbar{flex:1;height:8px;background:#e2e8f0;border-radius:4px;overflow:hidden}.wzbar i{display:block;height:100%;background:#0f766e}
.wzmain{position:relative;border:1px solid #cbd5e1;border-radius:8px;overflow:hidden;background:#fff}#wzcv{display:block;width:100%;height:auto}#wzmini{position:absolute;right:8px;bottom:8px;width:200px;border:1px solid #94a3b8;background:#fff;opacity:.92}
.wzq{font-size:20px;margin:14px 0 10px}.wzt{display:inline-block;background:#e0f2fe;color:#075985;border-radius:4px;padding:1px 8px;font-size:14px;vertical-align:middle}
.wzb{display:flex;flex-wrap:wrap;gap:8px;margin:6px 0}.wzb button{font-size:17px;padding:10px 16px;border-radius:8px;min-width:90px}.wzb button.on{outline:3px solid #0f766e}.wz button.big{font-size:18px;padding:12px 22px}.wz button.ghost{background:#f8fafc;color:#475569}.wzno{display:flex;flex-wrap:wrap;align-items:center;gap:8px;margin:10px 0 0;padding:8px 10px;background:#fff7ed;border:1px solid #fed7aa;border-radius:8px}.wzno span{font-size:14px;color:#9a3412}.wzno button{font-size:15px;padding:7px 12px}.wz button.warn{background:#fff;color:#b91c1c;border-color:#fca5a5}
.wzrev{max-height:300px;overflow:auto;border:1px solid #e2e8f0;border-radius:8px;margin:6px 0 10px}.wzrev table{width:100%;border-collapse:collapse;font-size:15px}.wzrev th{position:sticky;top:0;background:#f1f5f9;text-align:left;padding:6px 8px}.wzrev td{padding:4px 8px;border-top:1px solid #f1f5f9}.wzrev tr[data-wzrow]{cursor:pointer}.wzrev tr.on td{background:#e0f2fe}.wzrev input{width:90px;font-size:15px;padding:3px 6px}
#wzbom .wzrev{max-height:none}.wzraw{margin:6px 0 12px}.wzraw summary{cursor:pointer;color:#0f766e;font-size:15px}.wzraw select{font-size:14px}
.cmpg{display:grid;grid-template-columns:1fr 1fr;gap:10px;margin-bottom:10px}.cmpg figure{margin:0;border:1px solid #cbd5e1;border-radius:8px;background:#fff;overflow:hidden;cursor:zoom-in}.cmpg figure.big{grid-column:1/-1;cursor:zoom-out}.cmpg figcaption{font-size:14px;font-weight:600;padding:6px 10px;background:#f1f5f9}.cmpg img,.cmpg svg{display:block;width:100%;height:auto;border:0!important}
@media(max-width:800px){.cmpg{grid-template-columns:1fr}}
.wzocrb{background:#fff7ed;border:1px dashed #fdba74;border-radius:6px;padding:5px 10px;font-size:14px;color:#9a3412;margin:0 0 6px}.wzsrc{display:inline-block;border-radius:4px;padding:1px 8px;font-size:13px}.wzsrc.ok{background:#dcfce7;color:#166534}.wzsrc.fit{background:#e0f2fe;color:#075985}.wzsrc.us{background:#f1f5f9;color:#334155}.wzsrc.bad{background:#fee2e2;color:#991b1b}.wzt.wzto{background:#ffedd5;color:#9a3412}
.wzs{gap:12px;flex-wrap:wrap;margin:8px 0}.wzs input{font-size:16px;padding:6px}.wzft{margin-top:16px;border-top:1px solid #e2e8f0;padding-top:10px}
@media(max-width:700px){#wzmini{display:none}.wzq{font-size:17px}}`;
  document.head.appendChild(wcss);

  document.getElementById('isob').addEventListener('change', onChange);
  document.getElementById('isob').addEventListener('click', onClick);
  const css = document.createElement('style');
  css.textContent = `.tbw{display:grid;grid-template-columns:minmax(360px,52%) 1fr;gap:12px;align-items:start}
.tbimg{position:sticky;top:0}.tbcv{overflow:auto;max-height:76vh;border:1px solid #cbd5e1;background:#fff}.cvw{position:relative;width:100%}.cvw canvas{display:block;width:100%}#tbov{position:absolute;left:0;top:0;height:100%;cursor:crosshair}#tbin{position:absolute;background:#fff;border:2px solid #dc2626;border-radius:6px;padding:3px 5px;box-shadow:0 4px 12px rgba(0,0,0,.2);white-space:nowrap}#tbin input{width:90px;font-size:15px}.tbtools{flex-wrap:wrap;gap:4px}.tbtools button,.tbtools select{padding:4px 8px;font-size:12px;white-space:nowrap;width:auto}.tbtools button.on{background:#dc2626;color:#fff;border-color:#dc2626}#tbhint{margin:2px 0 6px;font-size:12px}
.tbr{min-width:0}.run{border:1px solid #cbd5e1;border-radius:8px;padding:8px;margin:10px 0;background:#fff}.run.exr{background:#f1f5f9;border-style:dashed}
.tbt{width:100%;border-collapse:collapse;font-size:12px}.tbt th,.tbt td{border-bottom:1px solid #e2e8f0;padding:3px 4px;text-align:left;vertical-align:middle}
.tbt tr.low td{background:#fef9c3}.tbt tr.err td{background:#fee2e2}.errm{background:#fee2e2;padding:4px 6px;border-radius:4px;margin:4px 0}
.tbt select,.tbt input{font-size:12px}.tbt td.nw{white-space:nowrap}.tbt td.nw button{padding:1px 6px}
.tbh label,.run label{font-size:12px;margin-right:6px;white-space:nowrap}.run .row,.tbh{flex-wrap:wrap;gap:4px}.run .row button{white-space:nowrap;width:auto}.notes{background:#fff7ed;border:1px solid #fed7aa;border-radius:6px;padding:6px 10px;margin:6px 0;font-size:13px}.notes ul{margin:4px 0 0 18px;padding:0}
@media(max-width:900px){.tbw{grid-template-columns:1fr}.tbimg{position:static}}`;
  document.head.appendChild(css);

  /* ---------- 전문가 검토: 어떤 도면이든 같은 기준으로 3D 결과를 점검 ---------- */
  const szN = t => { t = String(t); const m = t.match(/^(\d+)-(\d)\/(\d)$/); if (m) return +m[1] + m[2] / m[3]; const f = t.match(/^(\d)\/(\d)$/); return f ? f[1] / f[2] : +t; };
  // 도면 위 크기 표기 (3/4", 1/2", 2", 3/4"X1/2") → 위치와 크기
  function sizeLabels(w) {
    if (w._szl) return w._szl;
    const out = [], re = /(\d{1,2}-\d\/\d|\d\/\d|\d{1,2}(?="))"?(?:X(\d{1,2}-\d\/\d|\d\/\d|\d{1,2}(?=")))?/g;
    const add = (t, p, c) => { const u = String(t).toUpperCase().replace(/[″”“]/g, '"').replace(/\s+/g, ''); if (/SHT|DWG|SEE|NO\.|REV|SCALE/.test(u)) return; let m; re.lastIndex = 0;
      while ((m = re.exec(u))) { const a = szN(m[1]), b = m[2] ? szN(m[2]) : null; if (!QS.includes(a) || (b != null && !QS.includes(b))) continue; out.push({ a, b, p, t: m[0], c }); } };
    (w.isoTxt || []).forEach(l => add(l.t, l.p, l.c));
    (w.words || []).forEach(x => add(x.t, [x.cx, x.cy], x.c));
    if (!w.ocrRun) w._szl = out;
    return out;
  }
  // 도면 위 배관 구간들 (그림 좌표) — 크기 표기를 가장 가까운 구간에 붙임
  function segsOf(w) {
    const out = [];
    w.R.runs.forEach((r, ri) => r.steps.forEach((s, si) => { const a = si ? r.steps[si - 1]._p : r._p0; if (a && s._p) out.push({ ri, si, a, b: s._p }); }));
    return out;
  }
  const dSeg2 = (p, a, b) => { const v = [b[0] - a[0], b[1] - a[1]], L2 = v[0] * v[0] + v[1] * v[1] || 1, t = Math.max(0, Math.min(1, ((p[0] - a[0]) * v[0] + (p[1] - a[1]) * v[1]) / L2)); return Math.hypot(p[0] - a[0] - v[0] * t, p[1] - a[1] - v[1] * t); };
  function labelsOnSegs(w) {
    const sg = segsOf(w), out = [];
    sizeLabels(w).forEach(L => { let best = null, bd = 26; sg.forEach(g => { const d = dSeg2(L.p, g.a, g.b); if (d < bd) { bd = d; best = g; } }); if (best) out.push(Object.assign({}, L, { ri: best.ri, si: best.si, d: bd })); });
    return out;
  }
  // 가지 배관 크기: 그 가지 구간 옆의 크기 표기 (레듀서 표기는 제외)
  function labelBranch(tid) {
    const ri = W.R.runs.findIndex(r => r.start && r.start.tee === tid); if (ri < 0) return null;
    const ls = labelsOnSegs(W).filter(l => l.ri === ri && l.b == null).sort((x, y) => x.si - y.si || x.d - y.d);
    return ls.length ? ls[0].a : null;
  }
  const RVL = { err: '오류', warn: '확인', info: '참고' };
  function review(w) {
    if (!w || W !== w) return w && w.rv || [];
    const F = [], R = w.R, add = (lv, cat, msg, loc) => F.push(Object.assign({ lv, cat, msg }, loc || {}));
    const at = (ri, si, ph) => ({ ri, si, ph, at: (ri + 1) + '-' + (si + 1) });
    // 1) 끝 처리
    R.runs.forEach((r, ri) => r.steps.forEach((s, si) => {
      if (s.t !== 'end') return;
      const en = s.end || 'open', see = (w.see || []).some(o => s._p && Math.hypot(o.p[0] - s._p[0], o.p[1] - s._p[1]) < 90);
      if (en === 'open' && s.flTick) add('warn', '끝 처리', '끝에 플랜지 표시가 있는데 "기존 배관 연결/용접"으로 두었습니다', at(ri, si, 'end'));
      else if (en === 'open' && !see) add('warn', '끝 처리', '"기존 배관 연결/용접"으로 두었습니다 — 근처에 다른 장 표시(SEE DWG)가 없으니 캡·플랜지·장치 연결이 아닌지 확인', at(ri, si, 'end'));
    }));
    // 0) 3D로 만들 때 맞지 않은 곳 (겹침·시작점 못 찾음 등)
    (w.bErrs || []).forEach(e => add('err', '조립', e.msg, e.ri != null && e.si >= 0 ? at(e.ri, e.si, 'len') : e.ri != null ? { at: (e.ri + 1) + '번 배관' } : null));
    // 2) 치수 근거
    R.runs.forEach((r, ri) => r.steps.forEach((s, si) => {
      if (s.est) add('warn', '치수', '길이를 도면에서 못 읽어 그림 비율 어림값 ' + s.d + ' mm를 썼습니다', at(ri, si, 'len'));
      else if (s.auto === 'ocr' && s.ocr && s.ocr.amb) add('info', '치수', '읽은 치수 ' + s.ocr.v + ' 근처에 다른 숫자가 있습니다', at(ri, si, 'len'));
      if (s.okSlope && s.slopeFig) add('warn', '경사', '경사(롤링) 각도 치수가 없어 그림 비율로 정했습니다', at(ri, si, 'slope'));
    }));
    // 3) 도면 크기 표기와 3D 크기
    if (!w.ocrRun) {
      const seen = {};
      labelsOnSegs(w).forEach(L => {
        const k = L.ri + '.' + L.si; if (seen[k]) return; seen[k] = 1;
        const s = R.runs[L.ri].steps[L.si], z = npsAt(L.ri, L.si);
        if (L.b != null) { if (s.t === 'reducer' && (Math.abs(z - L.a) > 0.01 || Math.abs((+s.nps2 || 0) - L.b) > 0.01)) add('warn', '크기', '도면 표기 ' + L.t + '와 레듀서 ' + nf(z) + ' → ' + nf(+s.nps2) + '가 다릅니다', at(L.ri, L.si, 'rsize')); return; }
        if (Math.abs(z - L.a) < 0.01) return;
        const r = R.runs[L.ri], tee = r.start && r.start.tee, tl = tee && R.runs.map((x, i) => [i, x.steps.findIndex(y => y.id === tee)]).find(([, j]) => j >= 0);
        add('warn', '크기', '도면에 ' + nf(L.a) + ' 표기가 있는데 3D는 ' + nf(z) + '입니다' + (tl && L.si < 2 ? ' — 가지 배관 크기 확인' : ' — 크기가 바뀌는 곳(레듀서·스웨지) 확인'), tl && L.si < 2 ? at(tl[0], tl[1], 'branch') : at(L.ri, L.si, null));
      });
    }
    // 4) 크기 변화의 근거 (가지가 작아지면 레듀싱 티나 스웨지·레듀서가 BOM에 있어야)
    if (w.bom) R.runs.forEach((r, ri) => {
      if (!(r.start && r.start.tee) || !+r.nps) return;
      const tl = R.runs.map((x, i) => [i, x.steps.findIndex(y => y.id === r.start.tee)]).find(([, j]) => j >= 0); if (!tl) return;
      const main = npsAt(tl[0], tl[1]), br = +r.nps; if (br >= main - 0.01) return;
      const has = w.bom.rows.some(x => (x.cat === 'TEE' && x.size2 && Math.abs(x.size2 - br) < 0.01) || (/REDUCER|SWAGE/.test(x.cat) && x.size2 && Math.abs(x.size2 - br) < 0.01) || (x.cat === 'OLET'));
      if (!has) add('info', '크기', '가지가 ' + nf(main) + ' → ' + nf(br) + '로 작아지는데 도면 BOM에 레듀싱 티·스웨지·올렛이 보이지 않습니다', at(tl[0], tl[1], 'branch'));
    });
    // 5) 도면 BOM 대조
    if (w.bom && w.built && w.built.length && !w.ocrRun) {
      let list = []; try { list = bomCompare(w.bom, P.bom(w.built)); } catch (e) { }
      const openAt = z => { const o = []; R.runs.forEach((r, ri) => r.steps.forEach((s, si) => { if (s.t === 'end' && (s.end || 'open') === 'open' && Math.abs(npsAt(ri, si) - z) < 0.01) o.push((ri + 1) + '-' + (si + 1)); })); return o; };
      list.forEach(x => {
        const nm = (CATK[x.c] || x.c) + (x.z ? ' ' + nf(x.z) : '') + (x.z2 ? '×' + nf(x.z2) : '');
        if (x.c === 'GASKET' || x.c === 'STUD/BOLT') return;
        if (x.st === 'q') { add('info', 'BOM', nm + ' — 도면 BOM 수량을 못 읽었습니다 (아래 BOM 표에서 고치기)'); return; }
        if (x.c === 'PIPE') {
          if (x.d && x.m > x.d * 1.15 + 0.3) add('warn', '배관 길이', nm + ' 3D 총길이 ' + x.m + ' m가 도면 BOM ' + x.d + ' m보다 깁니다 — 어림값 치수부터 확인');
          else if (x.d && x.m < x.d * 0.6 - 0.3) add('warn', '배관 길이', nm + ' 3D 총길이 ' + x.m + ' m가 도면 BOM ' + x.d + ' m보다 많이 짧습니다 — 빠진 구간 확인');
          return;
        }
        if (x.st !== 'diff' && x.st !== 'extra' && x.st !== 'miss') return;
        const n = x.d - x.m;
        if (!x.m && x.d) { add('err', 'BOM', nm + ' ' + x.d + '개가 3D에 없습니다' + (/STRAINER|SWAGE|NIPPLE|COUPLING|UNION|OLET/.test(x.c) ? ' — 자동으로 못 그리는 부품입니다. 위치를 정해 고급 편집에서 넣으세요' : ' — 도면에서 위치를 확인하세요')); return; }
        if (x.c === 'FLANGE' && n > 0) { const o = openAt(x.z), nn = (W.dropped || []).filter(d => Math.abs(d.z - x.z) < 0.01).map(d => d.at); add('err', 'BOM', nm + ' ' + n + '개 부족 (도면 ' + x.d + ' / 3D ' + x.m + ')' + (o.length ? ' — 열린 끝 ' + o.join(', ') : '') + (nn.length ? ' · "아무것도 아님"으로 답한 곳 ' + nn.join(', ') : '') + (o.length || nn.length ? ' 확인' : ' — 배관 끝·장 경계·밸브 양쪽 플랜지 확인')); return; }
        if (x.c === 'FLANGE' && n < 0) { add('err', 'BOM', nm + ' ' + (-n) + '개 많음 (도면 ' + x.d + ' / 3D ' + x.m + ') — 플랜지로 본 표시 중 용접점·밸브·크기 다른 곳이 있는지 확인'); return; }
        add('err', 'BOM', nm + ' 도면 ' + x.d + ' / 3D ' + x.m + (x.st === 'extra' ? ' — 도면 BOM에 없는 부품' : ''));
      });
      // 도면 BOM 자체 점검: 볼트 수 = 가스켓 수 × 플랜지 볼트 수
      const grp = {};
      w.bom.rows.forEach(x => { if (!x.size || !/GASKET|STUD/.test(x.cat)) return; const cls = +((String(x.desc || '') + ' ' + (x.code || '')).match(/\b(150|300|600|900|1500|2500)\b/) || [, 150])[1]; const k = x.size + '|' + cls; const g = grp[k] = grp[k] || { z: x.size, cls, g: 0, b: 0 }; if (x.cat === 'GASKET') g.g += +x.qty || 0; else g.b += +x.qty || 0; });
      Object.values(grp).forEach(g => { if (!g.g || !g.b || !P.nBolt) return; const nb = P.nBolt(g.z, g.cls); if (nb && g.b !== g.g * nb) add('info', 'BOM 표', nf(g.z) + ' ' + g.cls + '# 볼트 ' + g.b + '개가 가스켓 ' + g.g + '개 × ' + nb + ' = ' + g.g * nb + '와 다릅니다 — 도면 BOM 글자를 잘못 읽었을 수 있습니다'); });
      // 엘보 각도
      w._inRv = true; let a; try { a = accOf(w); } finally { w._inRv = false; } const e = a.bom && a.bom.elb;
      if (e && (e.m[90] !== e.d[90] || e.m[45] !== e.d[45] || e.m.x)) add('err', '엘보', '엘보 수·각도가 도면 BOM과 다릅니다 — 3D 90° ' + e.m[90] + '·45° ' + e.m[45] + (e.m.x ? '·기타 ' + e.m.x : '') + ' / BOM 90° ' + e.d[90] + '·45° ' + e.d[45]);
    } else if (!w.bom && !w.ocrRun) add('info', 'BOM', '도면 BOM 표를 찾지 못해 자재 수량을 대조하지 못했습니다');
    if (w.built && !w.clsCode && !w.ocrRun) add('info', '자재 사양', '라인 번호에 맞는 라인 클래스가 없어 재질·등급이 기본값입니다 (📋 라인 클래스에서 등록)');
    const ord = { err: 0, warn: 1, info: 2 };
    F.sort((p, q) => ord[p.lv] - ord[q.lv]);
    w.rv = F;
    return F;
  }
  function rvHtml(F, pfx) {
    if (!F.length) return '<div class="rv ok"><b>✓ 검토 통과</b> — 끝 처리·치수 근거·크기 표기·도면 BOM 대조에서 걸린 곳이 없습니다.</div>';
    const n = k => F.filter(f => f.lv === k).length;
    return `<div class="rv"><div class="rv-hd"><b>전문가 검토</b><span class="bdg bad">오류 ${n('err')}</span><span class="bdg warn">확인 ${n('warn')}</span><span class="bdg">참고 ${n('info')}</span></div><ul>${F.map((f, i) => `<li class="rv-${f.lv}"><span class="rv-c">${E(f.cat)}</span>${f.at ? (f.ph ? `<button class="lnk" data-rv="${pfx || ''}${i}">${E(f.at)}</button> ` : `<b>${E(f.at)}</b> `) : ''}${E(f.msg)}</li>`).join('')}</ul></div>`;
  }
  function rvJump(f) {
    if (!f || !W) return;
    const r = W.R.runs[f.ri], s = r && r.steps[f.si]; if (!s) return;
    if (f.ph) {
      if (f.ph === 'len') s.okLen = false; else if (f.ph === 'end') s.okEnd = false; else if (f.ph === 'branch') s.okBranch = false; else if (f.ph === 'rsize') s.okRed = false; else if (f.ph === 'slope') s.okSlope = false;
      W.q = { ri: f.ri, si: f.si, phase: f.ph };
    } else W.q = { ri: f.ri, si: f.si, phase: phasesOf(s)[0] || 'len' };
    W.fixAt = W.hist.length; wRender();
  }
  function rvShow() { const el = $('wzrv'); if (!el || !W) return; el.innerHTML = rvHtml(review(W)); }
  document.getElementById('isob').addEventListener('click', e => { const b = e.target.closest('[data-rv]'); if (!b || !W) return; const v = b.dataset.rv; if (/^b/.test(v)) return; rvJump((W.rv || [])[+v]); });
  /* ---------- 여러 장 일괄 변환 · 정확도 점검 ---------- */
  let B = null;
  const tick = (ms = 0) => new Promise(r => setTimeout(r, ms));
  const natCmp = (a, b) => String(a).localeCompare(String(b), undefined, { numeric: true });
  // 3D로 만든 결과를 도면 BOM과 비교한 숫자 (정확도)
  function accOf(w) {
    const st = { ocr: 0, fit: 0, user: 0, est: 0, n: 0 };
    w.R.runs.forEach(r => r.steps.forEach(s => { const k = s.auto === 'ocr' || s.auto === 'ocr-ok' ? 'ocr' : s.auto === 'fit' ? 'fit' : s.est ? 'est' : 'user'; st[k]++; st.n++; }));
    const a = { at: Date.now(), ln: (w.f.sheet && w.f.sheet.ln) || w.R.line_no || '', len: st, bom: null };
    if (w.bom && w.built && w.built.length) {
      try {
        const list = bomCompare(w.bom, P.bom(w.built)), g = { ok: 0, diff: 0, extra: 0, q: 0 }, p = { ok: 0, n: 0 }, bad = [];
        const allOk = re => list.filter(r => re.test(r.c)).every(r => r.st === 'ok');
        const okc = { valve: allOk(/V\/V$|^VALVE$/), tee: allOk(/^TEE$/), red: allOk(/^REDUCER$/), end: allOk(/^(CAP|BLIND FLANGE)$/) };
        list.forEach(r => {
          if (r.c === 'GASKET' || r.c === 'STUD/BOLT') return; // 플랜지 수를 따라가므로 점수에서 뺌
          if (r.c === 'PIPE') { if (r.st === 'q' || r.st === 'extra') return; p.n++; if (r.st === 'ok') p.ok++; else bad.push('배관 ' + nf(r.z) + ' ' + r.d + '→' + r.m + 'm'); return; }
          const s2 = r.st === 'nip' ? 'ok' : r.st; g[s2] = (g[s2] || 0) + 1;
          if (s2 === 'diff' || s2 === 'extra') bad.push((CATK[r.c] || r.c) + ' ' + (r.z ? nf(r.z) : '') + ' 도면 ' + r.d + ' / 3D ' + r.m);
        });
        const ec = { 90: 0, 45: 0, x: 0 }; w.R.runs.forEach(r => r.steps.forEach(x => { if (x.t !== 'elbow') return; const an = +x.eang || 90; if (Math.abs(an - 90) < 1) ec[90]++; else if (Math.abs(an - 45) < 1) ec[45]++; else ec.x++; }));
        const be = { 90: 0, 45: 0 }; w.bom.rows.forEach(x => { if (x.cat === 'ELBOW') be[/45/.test((x.code || '') + ' ' + (x.desc || '')) ? 45 : 90] += +x.qty || 0; });
        a.bom = { rows: w.bom.rows.length, ok: g.ok, diff: g.diff, extra: g.extra, q: g.q, pipe: p, elb: { m: ec, d: be }, bad: bad.slice(0, 12), okc };
      } catch (e) { a.bom = null; }
    }
    try { if (W === w && !w._inRv) { const F = review(w); a.rv = { err: F.filter(f => f.lv === 'err').length, warn: F.filter(f => f.lv === 'warn').length }; } } catch (e) { }
    return a;
  }
  const pct = (a, b) => (b ? Math.round(a / b * 100) : null);
  function accSave(w) { if (!w || !w.built || w.ocrRun) return; try { w.f.acc = accOf(w); P.fPut(w.f); } catch (e) { } }
  // 자동으로 답하기: 화면의 추천 답(테두리 버튼)을 고르고, 근거가 약한 답은 '확인 필요'로 적어 둠
  async function autoOne(it, say) {
    W = null;
    await wizard(it.id);
    if (!W || W.fid !== it.id) { const m = document.querySelector('#wzhid .wz b'); return { st: 'fail', why: m ? m.textContent : '도면을 읽지 못했습니다' }; }
    const w0 = W; w0.auto = true;
    const t0 = Date.now();
    while (w0.ocrRun && Date.now() - t0 < 300000) { say(w0.ocrMsg || '도면 읽는 중…'); await tick(400); if (B && B.stop) break; }
    if (w0.title && w0.title.line_no && !w0.R.line_no) w0.R.line_no = w0.title.line_no;
    const flags = [];
    if (!w0.R.line_no) flags.push({ ri: 0, si: 0, ph: 'size', at: '표제란', why: '라인 번호를 못 읽음 — 같은 라인의 다른 장과 이어 붙이지 못합니다' });
    say('질문에 자동으로 답하는 중…');
    for (let n = 0; n < 600 && W === w0; n++) {
      wRender();
      const q = W.q; if (q.phase === 'done') break;
      const r = W.R.runs[q.ri], s = r && r.steps[q.si], at = q.phase === 'size' ? '시작' : (q.ri + 1) + '-' + (q.si + 1);
      const on = document.querySelector('#wzhid .wzb button.on'), dv = on && on.dataset.wz;
      let a = dv, why = null;
      if (q.phase === 'size') { if (!(W.title && W.title.nps)) why = '배관 크기를 표제란에서 못 읽음 — ' + nf(W.R.nps || 2) + '로 봄'; if (!a) a = 'size:' + (W.R.nps || 2); }
      else if (q.phase === 'len') { const d = $('wzd'); if (d && d.value) { a = 'len'; if (s.ocr && (s.ocr.c < 60 || s.ocr.amb)) why = '길이 ' + s.ocr.v + ' — 읽은 확신 ' + s.ocr.c + '%' + (s.ocr.amb ? ', 근처에 다른 숫자' : ''); } else { a = 'len:skip'; why = '길이 치수를 못 읽음 — 어림값 ' + s.d + ' mm'; } }
      else if (q.phase === 'slope') { a = 'slope:fig'; why = '경사 각도 치수 없음 — 그림 비율대로'; }
      else if (q.phase === 'roll') { if (!s.roll.sure) why = '경사 면(수평/수직)을 빗금으로 확정 못 함'; }
      else if (q.phase === 'type') { if (!a) { a = 'type:flange'; why = '표시 종류를 모름 — 플랜지로 봄'; } }
      else if (q.phase === 'end') { if (!a) { a = 'end:open'; why = '배관 끝 처리를 모름 — 기존 배관 연결로 봄'; } }
      else if (q.phase === 'rsize') why = '레듀서 크기 추정 — ' + (a ? a.split(':')[1] + '"' : '');
      else if (q.phase === 'branch') { const lz = labelBranch(s.id); why = lz != null && a === 'br:' + lz ? null : a && a !== 'br:' + npsAt(q.ri, q.si) ? '가지 배관 크기 — 도면 BOM 보고 ' + a.split(':')[1] + '"로 봄' : '가지 배관 크기 — 본관과 같다고 봄'; }
      if (!a) { flags.push({ ri: q.ri, si: q.si, ph: q.phase, at, why: '자동으로 답하지 못함' }); break; }
      if (why) flags.push({ ri: q.ri, si: q.si, ph: q.phase, at, why });
      const sig = JSON.stringify(W.q) + '|' + W.hist.length;
      wAnswer(a);
      if (JSON.stringify(W.q) + '|' + W.hist.length === sig) { flags.push({ ri: q.ri, si: q.si, ph: q.phase, at, why: '자동으로 넘기지 못함' }); break; }
      if (n % 8 === 7) await tick();
    }
    if (W !== w0) return { st: 'fail', why: '중간에 멈췄습니다' };
    if (W.q.phase !== 'done') { W.q = { ri: 0, si: 0, phase: 'done' }; }
    say('3D 만드는 중…');
    await wBuild();
    w0.auto = false;
    const sh = w0.f.sheet || {}, nObj = (w0.built || []).length;
    const acc = accOf(w0); w0.f.acc = acc; await P.fPut(w0.f);
    const okc = acc.bom && acc.bom.okc; // 도면 BOM 수량이 맞는 품목은 추정 답도 맞는 것으로 봄
    if (okc) { const drop = { type: okc.valve, branch: okc.tee, rsize: okc.red, end: okc.end }; for (let k = flags.length - 1; k >= 0; k--) if (drop[flags[k].ph]) flags.splice(k, 1); }
    // 전문가 검토 결과 합치기 (같은 곳·같은 질문은 한 번만)
    review(w0).filter(f => f.lv !== 'info').forEach(f => { if (f.ph && flags.some(g => g.ri === f.ri && g.si === f.si && g.ph === f.ph)) return; if (f.cat === '치수' && flags.some(g => g.ri === f.ri && g.si === f.si && g.ph === 'len')) return; flags.push({ ri: f.ri, si: f.si, ph: f.ph || 'done', at: f.at || f.cat, why: f.msg, lv: f.lv }); });
    w0.big = null; // 메모리 아끼기 (다시 열 때 그림)
    return { st: 'ok', W: w0, flags, n: nObj, ln: sh.ln || w0.R.line_no || '', sht: sh.sht, of: sh.of, placed: w0.placed, cls: w0.clsCode, acc };
  }
  async function batchPick() {
    const fs = (await P.fAll()).filter(f => f.kind !== 'photo' && f.type === 'application/pdf' && (!f.job || f.job === P.curJob())).sort((a, b) => natCmp(a.name, b.name));
    P.ov('여러 장 한 번에 3D로', `<div class="bt"><p class="bt-lead">고른 도면을 차례로 읽어 질문에 자동으로 답하고 3D로 만듭니다. 같은 라인 번호의 장은 끝끼리 이어 붙이고, 라인 클래스가 있으면 자재 사양도 넣습니다. 근거가 약한 답은 <b>확인 필요</b>로 모아 마지막에 보여 드립니다.</p>
${fs.length ? `<table class="btt"><thead><tr><th style="width:36px"><input type="checkbox" id="btall" checked></th><th>도면</th><th>상태</th></tr></thead><tbody>${fs.map(f => `<tr><td><input type="checkbox" class="btck" value="${f.id}" checked></td><td>${E(f.name)}</td><td class="mut">${f.route ? '3D로 만든 적 있음 (다시 만듦)' : '처음'}</td></tr>`).join('')}</tbody></table>
<div class="row bt-ft"><button data-att="back">← 첨부 목록</button><span style="flex:1"></span><button data-bt="go" class="pri">선택한 도면 3D로 만들기</button></div>` : '<p class="mut">PDF 도면이 없습니다. 먼저 첨부 목록에서 도면을 추가해 주세요.</p><div class="row bt-ft"><button data-att="back">← 첨부 목록</button></div>'}</div>`, true);
    const al = $('btall'); if (al) al.onchange = () => document.querySelectorAll('.btck').forEach(c => { c.checked = al.checked; });
  }
  async function batchRun(ids) {
    const all = await P.fAll();
    B = { list: ids.map(id => { const f = all.find(x => x.id === id); return { id, name: f ? f.name : id, st: 'wait' }; }), stop: false, run: true, t0: Date.now() };
    let hid = $('wzhid'); if (!hid) { hid = document.createElement('div'); hid.id = 'wzhid'; hid.setAttribute('aria-hidden', 'true'); document.body.appendChild(hid); }
    const ov0 = P.ov; P.ov = (t, h) => { hid.innerHTML = h; };
    const show = () => ov0('여러 장 한 번에 3D로', bHtml(), true);
    show();
    try {
      for (const it of B.list) {
        if (B.stop) { it.st = 'skip'; continue; }
        it.st = 'run'; it.msg = '도면 읽는 중…'; show();
        const say = m => { it.msg = m; const el = document.querySelector('[data-btmsg="' + it.id + '"]'); if (el) el.textContent = m; };
        try { Object.assign(it, await autoOne(it, say)); } catch (e) { it.st = 'fail'; it.why = e.message; }
        show();
      }
    } finally { P.ov = ov0; hid.innerHTML = ''; B.run = false; W = null; }
    show();
  }
  // 같은 이유는 한 줄로 (예: 1-2 1-3 1-5 표시 종류를 모름)
  function fGroup(fl) { const m = new Map(); fl.forEach((f, j) => { const k = f.why.replace(/\d+(\.\d+)?\s*mm|\d+%|— [^—]*\d[^—]*$/g, '#'); const g = m.get(k) || m.set(k, { why: f.why, js: [], n: 0 }).get(k); g.js.push(j); g.n++; if (g.n > 1) g.why = f.why.replace(/\s*[—-]\s*(어림값|읽은 확신)[^—]*$/, '') + (/(어림값)/.test(f.why) ? ' — 어림값 사용' : ''); }); return [...m.values()]; }
  function bHtml() {
    const L = B.list, done = L.filter(x => x.st === 'ok'), nf2 = L.reduce((a, x) => a + (x.flags ? x.flags.length : 0), 0), cur = L.findIndex(x => x.st === 'run');
    const prog = Math.round(L.filter(x => !['wait', 'run'].includes(x.st)).length / L.length * 100);
    const stc = x => x.st === 'ok' ? (x.flags.length ? `<span class="bdg warn">확인 ${x.flags.length}</span>` : '<span class="bdg ok">완료</span>') : x.st === 'run' ? '<span class="bdg run">진행 중</span>' : x.st === 'fail' ? '<span class="bdg bad">실패</span>' : x.st === 'skip' ? '<span class="bdg">건너뜀</span>' : '<span class="bdg">대기</span>';
    const joinT = x => !x.placed ? '<span class="mut">—</span>' : x.placed.kind === 'join' ? '🔗 ' + E(x.placed.lab.replace(/\s*\(.*?\)\s*/, ' ')) : '📍 좌표';
    const row = (x, i) => `<tr class="${x.st === 'run' ? 'on' : ''}"><td class="num">${i + 1}</td><td><div class="bt-n">${E(x.name)}</div>${x.st === 'run' ? `<div class="mut" data-btmsg="${x.id}">${E(x.msg || '')}</div>` : x.st === 'fail' ? `<div class="bt-err">${E(x.why || '')}</div>` : ''}</td>
<td>${x.st === 'ok' ? E(x.ln || '—') + (x.sht ? ` <span class="mut">${x.sht}/${x.of || '?'}</span>` : '') : ''}</td><td class="num">${x.st === 'ok' ? x.n : ''}</td><td>${x.st === 'ok' ? joinT(x) : ''}</td><td>${x.st === 'ok' && x.cls ? E(x.cls) : ''}</td><td>${stc(x)}</td>
<td class="nw">${x.st === 'ok' ? `<button data-bt="open:${i}" class="ghost">${x.flags.length ? '확인하기' : '열기'}</button>` : ''}</td></tr>${x.st === 'ok' && x.flags.length ? `<tr class="bt-fl"><td></td><td colspan="7"><ul>${fGroup(x.flags).map(g => `<li>${g.js.map(j => `<button class="lnk" data-bt="fix:${i}:${j}">${E(x.flags[j].at)}</button>`).join(' ')} ${E(g.why)}</li>`).join('')}</ul></td></tr>` : ''}`;
    const head = B.run ? `<div class="bt-hd"><div class="wzbar"><i style="width:${prog}%"></i></div><span class="mut">${cur + 1} / ${L.length}</span><button data-bt="stop" class="ghost">${B.stop ? '멈추는 중…' : '멈추기'}</button></div>`
      : `<div class="bt-sum"><div><b>${done.length}</b><span>3D 완료</span></div><div><b>${L.filter(x => x.st === 'fail').length}</b><span>실패</span></div><div class="${nf2 ? 'w' : ''}"><b>${nf2}</b><span>확인 필요</span></div><div><b>${done.reduce((a, x) => a + x.n, 0)}</b><span>부품</span></div><div><b>${done.filter(x => x.placed).length}</b><span>이어 붙임</span></div></div>`;
    return `<div class="bt">${head}<table class="btt"><thead><tr><th class="num">#</th><th>도면</th><th>라인 번호</th><th class="num">부품</th><th>이음</th><th>클래스</th><th>상태</th><th></th></tr></thead><tbody>${L.map(row).join('')}</tbody></table>
${B.run ? '<p class="mut">도면마다 치수·BOM 글자를 읽느라 한 장에 수십 초 걸립니다. 이 창을 닫지 마세요.</p>' : `<p class="mut">확인 필요 항목을 누르면 그 질문으로 바로 가고, 답하면 검토 화면으로 돌아옵니다. 검토 화면에서 "3D로 만들기"를 누르면 그 장만 다시 만듭니다.</p>
<div class="row bt-ft"><button data-att="back">← 첨부 목록</button><span style="flex:1"></span><button data-bt="acc" class="ghost">📊 정확도 점검</button><button data-bt="see" class="pri">3D로 보기</button></div>`}</div>`;
  }
  async function bOpen(i, j) {
    const it = B.list[i]; if (!it || !it.W) return;
    W = it.W; W.batchI = i; W.fixJ = j;
    if (!W.big) { W.big = document.createElement('canvas'); await P.drawFile(W.f, W.big, 3200); }
    const f = j == null ? null : it.flags[j];
    if (f && f.ph && !['done', 'size'].includes(f.ph) && W.R.runs[f.ri] && W.R.runs[f.ri].steps[f.si]) { rvJump(f); return; }
    else if (f && f.ph === 'size') { W.q = { ri: 0, si: 0, phase: 'size' }; W.fixAt = W.hist.length; }
    else { W.q = { ri: 0, si: 0, phase: 'done' }; W.fixAt = null; }
    wRender();
  }
  function bBack() { if (!B) return; const w = W; if (w && w.batchI != null) { const it = B.list[w.batchI]; if (it) { if (w.fixJ != null && it.flags[w.fixJ]) it.flags.splice(w.fixJ, 1); w.fixJ = null; it.acc = w.f.acc || it.acc; it.n = (w.built || []).length; it.placed = w.placed; } } P.ov('여러 장 한 번에 3D로', bHtml(), true); }
  async function accReport() {
    const fs = (await P.fAll()).filter(f => f.acc && (!f.job || f.job === P.curJob())).sort((a, b) => natCmp(a.name, b.name));
    const T = { ok: 0, diff: 0, extra: 0, pk: 0, pn: 0, e: 0, en: 0, l: { ocr: 0, fit: 0, user: 0, est: 0, n: 0 } };
    fs.forEach(f => { const a = f.acc; Object.keys(T.l).forEach(k => { T.l[k] += a.len[k] || 0; }); if (a.bom) { T.ok += a.bom.ok; T.diff += a.bom.diff; T.extra += a.bom.extra; T.pk += a.bom.pipe.ok; T.pn += a.bom.pipe.n; const e = a.bom.elb; T.en++; if (e.m[90] === e.d[90] && e.m[45] === e.d[45] && !e.m.x) T.e++; } });
    const P1 = (a, b) => { const v = pct(a, b); return v == null ? '—' : v + '%'; };
    const cmp = T.ok + T.diff + T.extra;
    const rows = fs.map(f => { const a = f.acc, b = a.bom, l = a.len, c = b ? b.ok + b.diff + b.extra : 0;
      return `<tr><td><div class="bt-n">${E(f.name)}</div><div class="mut">${E(a.ln || '')}</div></td><td class="num">${b ? P1(b.ok, c) : '<span class="mut">BOM 없음</span>'}</td><td class="num">${b ? (b.pipe.n ? b.pipe.ok + '/' + b.pipe.n : '—') : ''}</td><td class="num">${b ? (b.elb.m[90] === b.elb.d[90] && b.elb.m[45] === b.elb.d[45] && !b.elb.m.x ? '✓' : `<span class="bad">${b.elb.m[90]}·${b.elb.m[45]} / ${b.elb.d[90]}·${b.elb.d[45]}</span>`) : ''}</td><td class="num">${P1(l.ocr, l.n)}</td><td class="num">${P1(l.fit, l.n)}</td><td class="num">${l.est ? '<span class="bad">' + l.est + '</span>' : '0'}</td><td class="num">${a.rv ? (a.rv.err ? '<span class="bad">' + a.rv.err + '</span>' : '0') + ' · ' + a.rv.warn : '—'}</td></tr>${b && b.bad.length ? `<tr class="bt-fl"><td colspan="8"><ul>${b.bad.map(t => '<li>' + E(t) + '</li>').join('')}</ul></td></tr>` : ''}`; }).join('');
    P.ov('정확도 점검', `<div class="bt"><p class="bt-lead">3D로 만든 도면마다 <b>도면 BOM</b>(도면에서 읽은 자재표)과 3D 자재를 맞춰 본 결과입니다. 도면 BOM 글자를 잘못 읽은 경우도 차이로 나오니, 차이 항목은 도면과 함께 확인하세요.</p>
${fs.length ? `<div class="bt-sum"><div><b>${fs.length}</b><span>도면</span></div><div><b>${P1(T.ok, cmp)}</b><span>부품 수 일치 (${T.ok}/${cmp} 품목 · 가스켓·볼트 제외)</span></div><div><b>${P1(T.pk, T.pn)}</b><span>배관 길이 일치</span></div><div><b>${T.en ? T.e + '/' + T.en : '—'}</b><span>엘보 수·각도 일치</span></div><div><b>${P1(T.l.ocr + T.l.fit, T.l.n)}</b><span>치수 근거 있음 (도면 ${P1(T.l.ocr, T.l.n)} · ASME ${P1(T.l.fit, T.l.n)})</span></div><div class="${T.l.est ? 'w' : ''}"><b>${T.l.est}</b><span>어림값 구간</span></div></div>
<table class="btt"><thead><tr><th>도면</th><th class="num">부품 일치</th><th class="num">배관 길이</th><th class="num">엘보 (3D / BOM)</th><th class="num">치수: 도면</th><th class="num">ASME</th><th class="num">어림값</th><th class="num">검토 오류·확인</th></tr></thead><tbody>${rows}</tbody></table>
<p class="mut">부품 일치 = 품목·크기별 수량이 도면 BOM과 같은 비율 (배관은 길이로 따로, 가스켓·볼트는 플랜지를 따라가므로 제외). 배관 길이는 BOM이 구매 길이(올림)라 3D가 조금 짧아도 같음으로 봅니다. 엘보는 90°·45° 개수.</p>
<div class="row bt-ft"><button data-att="back">← 첨부 목록</button>${B && !B.run ? '<button data-bt="res">← 일괄 변환 결과</button>' : ''}<span style="flex:1"></span><button data-bt="csv">CSV로 저장</button></div>` : '<p class="mut">아직 점검할 도면이 없습니다. 도면을 3D로 만들면 여기에 쌓입니다.</p><div class="row bt-ft"><button data-att="back">← 첨부 목록</button></div>'}</div>`, true);
    accReport.fs = fs;
  }
  function accCsv() {
    const fs = accReport.fs || [], q = v => '"' + String(v == null ? '' : v).replace(/"/g, '""') + '"';
    const L = [['도면', '라인 번호', '부품 일치 품목', '부품 차이', '도면에 없음', '배관 길이 일치', '배관 품목', '3D 90°', '3D 45°', 'BOM 90°', 'BOM 45°', '구간', '치수: 도면', 'ASME', '직접', '어림값', '차이 내용'].map(q).join(',')];
    fs.forEach(f => { const a = f.acc, b = a.bom || {}, e = b.elb || { m: {}, d: {} }, p = b.pipe || {}; L.push([f.name, a.ln, b.ok, b.diff, b.extra, p.ok, p.n, e.m[90], e.m[45], e.d[90], e.d[45], a.len.n, a.len.ocr, a.len.fit, a.len.user, a.len.est, (b.bad || []).join(' / ')].map(q).join(',')); });
    P.dlFile('정확도점검.csv', new Blob(['﻿' + L.join('\r\n')], { type: 'text/csv' }));
  }
  document.getElementById('isob').addEventListener('click', e => {
    const b = e.target.closest('[data-bt]'); if (!b) return;
    const [k, x, y] = b.dataset.bt.split(':');
    if (k === 'go') { const ids = [...document.querySelectorAll('.btck:checked')].map(c => c.value); if (ids.length) batchRun(ids); return; }
    if (k === 'stop' && B) { B.stop = true; b.textContent = '멈추는 중…'; return; }
    if (k === 'open') { bOpen(+x); return; }
    if (k === 'fix') { bOpen(+x, +y); return; }
    if (k === 'acc') { accReport(); return; }
    if (k === 'res') { bBack(); return; }
    if (k === 'csv') { accCsv(); return; }
    if (k === 'see' && B) { P.focus(P.getObjs().filter(o => B.list.some(it => o.src === 'iso:' + it.id)).map(o => o.id)); return; }
  });
  const bcss = document.createElement('style');
  bcss.textContent = `#wzhid{position:fixed;left:-30000px;top:0;width:1150px;pointer-events:none}
.bt{max-width:1150px;margin:0 auto}.bt-lead{color:#334155;line-height:1.55;margin:0 0 14px}
#iso .btt{width:100%;max-width:none;border-collapse:collapse;font-size:14px;background:#fff;border:1px solid #e2e8f0;border-radius:8px;overflow:hidden;margin-top:0;border-collapse:separate;border-spacing:0}#iso .btt th{border:0;background:#f8fafc;color:#475569;font-weight:600;text-align:left;padding:9px 10px;border-bottom:1px solid #e2e8f0;white-space:nowrap}#iso .btt td{padding:9px 10px;border:0;border-top:1px solid #f1f5f9;vertical-align:top}#iso .btt th.num,#iso .btt td.num{text-align:right;font-variant-numeric:tabular-nums;white-space:nowrap}#iso .btt td.nw{white-space:nowrap;text-align:right}#iso .btt tr.on td{background:#f0fdfa}
.bt-n{font-weight:600;color:#0f172a;word-break:break-all}.bt-err{color:#b91c1c;font-size:13px;margin-top:2px}#iso .btt .bad{color:#b91c1c}
#iso .rv{background:#fff;border:1px solid #e2e8f0;border-radius:8px;padding:12px 14px;margin:12px 0}.rv.ok{border-color:#bbf7d0;background:#f0fdf4;color:#166534}.rv-hd{display:flex;gap:8px;align-items:center;margin-bottom:6px}.rv-hd b{font-size:15px;margin-right:4px}.rv ul{margin:0;padding:0;list-style:none}.rv li{padding:6px 0 6px 10px;border-top:1px solid #f1f5f9;font-size:14px;line-height:1.5;border-left:3px solid #cbd5e1;margin:2px 0}.rv li.rv-err{border-left-color:#dc2626}.rv li.rv-warn{border-left-color:#d97706}.rv-c{display:inline-block;min-width:64px;font-size:12px;color:#64748b;margin-right:6px}.rv .lnk{background:none;border:0;padding:0;color:#0f766e;font-weight:600;text-decoration:underline;cursor:pointer;min-width:0}
#iso .bt-fl td{border-top:0!important;padding-top:0!important;background:#fffbeb}#iso .bt-fl ul{margin:0;padding:4px 0 8px 16px;font-size:13px;color:#78350f;line-height:1.7}#iso .bt-fl .lnk{background:none;border:0;padding:0;color:#0f766e;font-weight:600;text-decoration:underline;cursor:pointer;font-size:13px;min-width:0}
.bdg{display:inline-block;font-size:12px;padding:2px 8px;border-radius:999px;background:#f1f5f9;color:#475569;white-space:nowrap}.bdg.ok{background:#dcfce7;color:#166534}.bdg.warn{background:#fef3c7;color:#92400e}.bdg.bad{background:#fee2e2;color:#991b1b}.bdg.run{background:#ccfbf1;color:#115e59}
.bt-hd{display:flex;align-items:center;gap:12px;margin:0 0 12px}.bt-hd .wzbar{flex:1;height:8px;background:#e2e8f0;border-radius:4px;overflow:hidden}.bt-hd .wzbar i{display:block;height:100%;background:#0f766e;transition:width .4s}
.bt-sum{display:grid;grid-template-columns:repeat(auto-fit,minmax(140px,1fr));gap:10px;margin:0 0 14px}.bt-sum>div{background:#fff;border:1px solid #e2e8f0;border-radius:8px;padding:10px 12px}.bt-sum b{display:block;font-size:22px;color:#0f172a;font-variant-numeric:tabular-nums}.bt-sum span{font-size:12px;color:#64748b}.bt-sum .w b{color:#b45309}
.bt-ft{margin-top:14px;gap:8px}.bt button.ghost{background:#f8fafc;color:#334155}
@media(max-width:760px){#iso .btt th:nth-child(5),#iso .btt td:nth-child(5),#iso .btt th:nth-child(6),#iso .btt td:nth-child(6){display:none}}`;
  document.head.appendChild(bcss);

  window.P3DX = { _wz: () => W, _B: () => B, batchPick, accReport, wizard, convert, table, settings, manual, buildRoute, SYS, _aiRead: aiRead, _tiles: tiles };
})();
