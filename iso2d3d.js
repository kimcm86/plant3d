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
      if (['valve', 'flange', 'tee', 'reducer', 'cap'].includes(type) && ex.len == null) o.len = P.dflen(o);
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
      if (!DIRS.includes(dir)) { errs.push({ ri, si: -1, msg: '시작 방향이 없음' }); return true; }
      base = { ln: r.line_no || LN };
      if (r.existing) base.ex = true;
      const st = { cen: P0.slice(), cur: P0.slice(), dir, nps };
      if (s.equip || s.nozzle) {
        if (s.equip) placeEquip(s.equip, P0, dir, nps, ri, -1);
        const f = mk('flange', { pos: R1(add3(P0, dir, P.HGx(+R.cls || 150, 'RF', nps))), axis: dir, nps, kind: 'wn', face: 'RF' });
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
        switch (p.t) {
          case 'elbow': {
            if (!DIRS.includes(p.to) || !perp(d, p.to)) { errs.push({ ri, si, msg: '꺾이는 방향이 현재 방향과 직각이 아님' }); return; }
            const t = mk('elbow', { pos: [0, 0, 0], axis: d, turn: p.to, nps: st.nps });
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
            const ex = { pos: [0, 0, 0], axis: d, nps: st.nps, vt, conn, face: 'RF' };
            if (p.tag) ex.tag = p.tag;
            const v = mk('valve', ex);
            v.len = P.dflen(v);
            const wafer = ['butterfly', 'wcheck'].includes(vt);
            v.pos = R1(add3(C, d, -v.len / 2));
            if (conn === 'flg') {
              const h = P.HGx(+R.cls || 150, 'RF', st.nps), pr = { nps: st.nps, kind: 'wn', face: 'RF' };
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
              const f1 = mk('flange', Object.assign({ pos: R1(add3(C, d, -h)), axis: neg(d) }, pr));
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
    const h = `<div class="tbw">
 <div class="tbimg"><div class="row"><button data-tr="zoom">확대/축소</button><span class="mut">도면을 보면서 오른쪽 표를 확인하세요.</span></div><div class="tbcv"><canvas id="tbcv"></canvas></div></div>
 <div class="tbr">
  <div class="row"><button data-att="back">← 첨부 목록</button><span style="flex:1"></span><button data-tr="build" class="pri">3D에 반영</button><button data-tr="iso">ISO 보기</button><button data-tr="show">3D에서 보기</button></div>
  <div id="tbmsg" class="mut"></div>
  ${R.summary ? `<details open><summary>AI 판독 요약${R.model ? ' (' + E(R.model) + ')' : ''}</summary><div class="mut" style="white-space:pre-wrap">${E(R.summary)}</div></details>` : ''}
  ${(R.notes || []).length ? `<div class="notes"><b>확인이 필요한 부분</b><ul>${R.notes.map(n => `<li>${E(n)}</li>`).join('')}</ul></div>` : ''}
  ${lowN ? `<div class="mut">노란 줄 ${lowN}개는 AI가 추정한 값입니다. 도면과 비교해 확인해 주세요.</div>` : ''}
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
  <details><summary>거리 입력 규칙</summary><div class="mut">각 항목의 거리는 <b>바로 앞 기준점</b>(구간 시작점, 앞 엘보 꺾이는 점, 플랜지 조인트 중심, 티 중심, 밸브 중심, 레듀서 중심)부터 잰 값입니다. 도면 치수를 그대로 넣으면 됩니다. 방향은 도면 화면 기준: 왼쪽 위 = -X, 오른쪽 아래 = +X, 오른쪽 위 = -Z, 왼쪽 아래 = +Z, 위 = +Y, 아래 = -Y.</div></details>
 </div></div>`;
    P.ov('확인표 — ' + (T.f ? T.f.name : '직접 입력'), h);
    $('iso3').hidden = true; $('isop').hidden = true;
    if (T.f) drawRef();
  }
  let zoomBig = false;
  function drawRef() { const cv = $('tbcv'); if (!cv || !T.f) return; cv.style.width = zoomBig ? 'auto' : '100%'; P.drawFile(T.f, cv, zoomBig ? 2400 : 1400); }

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
  function msg(t) { const el = $('tbmsg'); if (el) el.textContent = t; }
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
    if (!f.route) f.route = blank();
    T = { fid, f, R: f.route, src: 'iso:' + fid, lastErrs: null };
    render();
  }
  function manual() {
    T = { fid: null, f: null, R: blank(), src: 'manual:' + Date.now(), lastErrs: null };
    render();
  }

  document.getElementById('isob').addEventListener('change', onChange);
  document.getElementById('isob').addEventListener('click', onClick);
  const css = document.createElement('style');
  css.textContent = `.tbw{display:grid;grid-template-columns:minmax(300px,42%) 1fr;gap:12px;align-items:start}
.tbimg{position:sticky;top:0}.tbcv{overflow:auto;max-height:78vh;border:1px solid #cbd5e1;background:#fff}.tbcv canvas{display:block}
.tbr{min-width:0}.run{border:1px solid #cbd5e1;border-radius:8px;padding:8px;margin:10px 0;background:#fff}.run.exr{background:#f1f5f9;border-style:dashed}
.tbt{width:100%;border-collapse:collapse;font-size:12px}.tbt th,.tbt td{border-bottom:1px solid #e2e8f0;padding:3px 4px;text-align:left;vertical-align:middle}
.tbt tr.low td{background:#fef9c3}.tbt tr.err td{background:#fee2e2}.errm{background:#fee2e2;padding:4px 6px;border-radius:4px;margin:4px 0}
.tbt select,.tbt input{font-size:12px}.tbt td.nw{white-space:nowrap}.tbt td.nw button{padding:1px 6px}
.tbh label,.run label{font-size:12px;margin-right:6px}.notes{background:#fff7ed;border:1px solid #fed7aa;border-radius:6px;padding:6px 10px;margin:6px 0;font-size:13px}.notes ul{margin:4px 0 0 18px;padding:0}
@media(max-width:900px){.tbw{grid-template-columns:1fr}.tbimg{position:static}}`;
  document.head.appendChild(css);

  window.P3DX = { convert, table, settings, manual, buildRoute, SYS, _aiRead: aiRead, _tiles: tiles };
})();
