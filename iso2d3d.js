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
  const phasesOf = s => (['flange', 'valve'].includes(s.t) && !s.okType ? ['type'] : []).concat(s.t === 'valve' && s.okType && !s.okVsize ? ['vsize'] : []).concat(s.t === 'reducer' && !s.okRed ? ['rsize'] : []).concat(s.t === 'tee' && !s.okBranch ? ['branch'] : []).concat(s.okLen ? [] : ['len']).concat(s.t === 'end' && !s.okEnd ? ['end'] : []);
  // 이 지점에서의 배관 크기 (런 크기 → 앞쪽 레듀서 반영)
  function npsAt(ri, si) {
    const R = W.R, r = R.runs[ri]; let n = +r.nps || +R.nps || 4;
    r.steps.slice(0, si).forEach(x => { if (x.t === 'reducer' && +x.nps2) n = +x.nps2; });
    return n;
  }
  function wRemain() { let n = W.q.phase === 'size' ? 1 : 0; W.R.runs.forEach(r => r.steps.forEach(s => { n += phasesOf(s).length; })); return n; }
  // 엘보·티가 플랜지나 용접점에 바로 붙은 짧은 구간(사이에 배관 용접점 없음)은
  // 배관이 없는 '부품 맞붙임' 구간 → ASME B16.9(엘보·티 중심~끝) + B16.5(플랜지) 치수로 길이를 자동으로 넣는다
  function fitHalf(kind, n) {
    const R = W.R, cls = +R.cls || 150;
    const ce = [.5, .75, 1, 1.5, 2].includes(+n) ? (R.ce || 'sw') : 'bw';
    if (kind === 'elbow') return P.eg({ type: 'elbow', kind: 'lr90', nps: n, ce, axis: '+X', turn: '+Y', pos: [0, 0, 0] }).R;
    if (kind === 'tee' || kind === 'tee_in') return P.dflen({ type: 'tee', nps: n, ce }) / 2;
    if (kind === 'flange') return P.HGx(cls, 'RF', n) + P.dflen({ type: 'flange', nps: n, kind: 'wn', cls });
    if (kind === 'weld') return 0;
    return null;
  }
  function autoLen() {
    const R = W.R; if (!R.nps) return;
    R.runs.forEach((r, ri) => r.steps.forEach((s, si) => {
      if (s.okLen || !s._wd || !(s._pt < 15)) return;
      if (s._wd.some(t => t > 0.12 && t < 0.88)) return; // 사이에 용접점이 있으면 배관이 있음 → 물어봄
      if (['flange', 'valve'].includes(s.t) && !s.okType) return;
      const n = npsAt(ri, si);
      const a = si === 0 ? (r.start && r.start.tee ? 'tee' : (s._wd.some(t => t <= 0.12) ? 'weld' : null)) : r.steps[si - 1].t;
      const b = s.t === 'end' ? (s._wd.some(t => t >= 0.88) ? 'weld' : null) : s.t;
      if (![a, b].some(k => k === 'elbow' || k === 'tee' || k === 'tee_in')) return;
      const ha = fitHalf(a, n), hb = fitHalf(b, n); if (ha == null || hb == null) return;
      s.d = Math.round((ha + hb) * 10) / 10; s.okLen = true; s.auto = 'fit'; delete s.est; delete s.conf;
    }));
  }
  function wFirstPhase() {
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
    W.R = nr; W.q = { ri: 0, si: 0, phase: 'size' }; return true;
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
    if (drag) { g.strokeStyle = 'rgba(220,38,38,.95)'; g.lineWidth = 3; g.setLineDash([5, 4]); g.beginPath(); g.arc(drag[0], drag[1], 15, 0, 7); g.stroke(); g.setLineDash([]); }
    if (mini) { const mg = mini.getContext('2d'), ms = mini.width / W.big.width; mini.height = Math.round(W.big.height * ms); mg.drawImage(W.big, 0, 0, mini.width, mini.height); mg.strokeStyle = '#dc2626'; mg.lineWidth = 2; mg.strokeRect(x0 * ms, y0 * ms, w * ms, h * ms); }
  }
  function wRender() {
    const R = W.R, q = W.q, r = R.runs[q.ri], s = r && r.steps[q.si];
    const done0 = W.hist.length, total = done0 + wRemain(), idx = Math.min(total, done0 + 1);
    const btn = (v, l, cls) => `<button data-wz="${E(String(v))}"${cls ? ` class="${cls}"` : ''}>${l}</button>`;
    let title = '', body = '', pts = [], mode = 'pt';
    const branchNote = r && r.start && r.start.tee ? '<span class="wzt">갈라진 배관</span> ' : '';
    if (q.phase === 'size') {
      { const r0 = R.runs[0], s0 = r0.steps[0]; pts = s0 && s0._p ? [r0._p0, s0._p] : [r0._p0]; if (pts.length > 1) mode = 'seg'; }
      title = '빨간 원에서 배관이 시작합니다 (파란 띠 = 첫 구간). 맞으면 배관 크기를 고르세요.<br><span class="wzt">틀리면 도면에서 초록 원(배관 끝) 중 진짜 시작점을 누르거나, 빨간 원을 끌어다 놓으세요</span>';
      body = `<div class="wzb">${QS.map(v => btn('size:' + v, nf(v), (+R.nps === v ? 'on' : ''))).join('')}</div>
        <div class="row wzs"><label>라인 번호 (선택) <input id="wzln" value="${E(R.line_no || '')}" placeholder="예: SW06002-4&quot;-B01A"></label><label>압력 등급 <select id="wzcls">${opt([150, 300, 400, 600, 900, 1500, 2500].map(v => [v, v + '#']), R.cls || 150)}</select></label><label>2" 이하 이음 <select id="wzce">${opt([['sw', 'SW 소켓 용접'], ['bw', 'BW 맞대기'], ['thd', '나사 (THD)']], R.ce || 'sw')}</select></label></div>
        <div class="wzno"><span>시작점이 틀렸나요?</span>${btn('notpipe', '✕ 파란 띠는 배관이 아님 (점선·치수선 등)', 'warn')}${(R.nStarts || 1) > 1 ? btn('nextstart', '↻ 다른 끝에서 시작 (' + ((R.startIdx || 0) + 1) + ' / ' + R.nStarts + ')', 'ghost') : ''}</div>`;
    } else if (q.phase === 'done') {
      const n = R.runs.reduce((a, x) => a + x.steps.length, 0);
      title = '질문이 끝났습니다.';
      const na = R.runs.reduce((a, x) => a + x.steps.filter(y => y.auto === 'fit').length, 0);
      body = `${na ? '<p>엘보·티가 플랜지나 용접점에 바로 붙은 구간 <b>' + na + '곳</b>은 길이를 묻지 않고 ASME B16.9/B16.5 치수로 넣었습니다.</p>' : ''}<p>답하신 내용으로 3D를 만듭니다. 도면에 있는데 빠진 부품(티, 레듀서 등)은 나중에 3D 편집기에서 추가하거나 "고급 편집"에서 넣을 수 있습니다.</p><div class="wzb">${btn('build', '3D로 만들기', 'pri big')}</div>`;
      pts = R.runs.flatMap(x => [x._p0].concat(x.steps.map(y => y._p))).filter(Boolean);
    } else if (s) {
      const prev = q.si === 0 ? r._p0 : r.steps[q.si - 1]._p;
      if (q.phase === 'type') {
        pts = [s._p];
        title = branchNote + '빨간 원 안의 표시는 무엇인가요?' + (s.vguess ? ' <span class="wzt">' + (s.vguess === 'check' ? '플랜지 ─ 체크 밸브 ─ 플랜지 모양으로 보임' : '밸브 모양으로 보임') + '</span>' : '');
        const on = v => (s.vguess === v ? 'on' : '');
        body = `<div class="wzb">${btn('type:flange', '플랜지 연결')}${btn('type:gate', '게이트 밸브' + (s.vguess === 'gate' ? ' (플랜지형)' : ''), on('gate'))}${btn('type:globe', '글로브 밸브')}${btn('type:check', '체크 밸브' + (s.vguess === 'check' ? ' (플랜지형)' : ''), on('check'))}${btn('type:ball', '볼 밸브')}${btn('type:butterfly', '버터플라이 밸브')}${btn('type:ctrl', '제어 밸브')}${btn('type:none', '아무것도 아님', 'ghost')}</div>`;
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
        const smaller = QS.filter(v => v < cur).reverse(), bigger = QS.filter(v => v > cur).slice(0, 3);
        body = `<div class="wzb">${smaller.map((v, i) => btn('rs:' + v, nf(cur) + ' → ' + nf(v), i === 0 ? 'on' : '')).join('')}${bigger.map(v => btn('rs:' + v, nf(cur) + ' → ' + nf(v) + ' (커짐)', 'ghost')).join('')}</div>
        <div class="wzb">${btn('rt:conc', '동심 (CONC)', (s.rt || 'conc') === 'conc' ? 'on' : 'ghost')}${btn('rt:ecc', '편심 (ECC)', s.rt === 'ecc' ? 'on' : 'ghost')}${btn('rs:none', '레듀서 아님', 'ghost')}</div>`;
      } else if (q.phase === 'branch') {
        pts = [s._p];
        title = branchNote + '여기서 배관이 갈라집니다. 갈라지는 쪽 배관 크기는?';
        const cur = npsAt(q.ri, q.si);
        body = `<div class="wzb">${btn('br:' + cur, '같은 크기 (' + nf(cur) + ')', 'on')}${QS.filter(v => v < cur).reverse().map(v => btn('br:' + v, nf(v))).join('')}${btn('br:none', '갈라지는 곳 아님', 'ghost')}</div>`;
      } else if (q.phase === 'len') {
        pts = [prev, s._p]; mode = 'seg';
        const what = { elbow: '꺾이는 곳', flange: '플랜지', valve: '밸브 중심', tee: '갈라지는 곳', tee_in: '만나는 곳', reducer: '레듀서', end: '배관 끝', equip: '장치 노즐', inst: '계기' }[s.t] || '다음 지점';
        title = branchNote + `두 빨간 원 사이(→ ${what}) 길이는 몇 mm 인가요?`;
        body = `<div class="row wzs"><input id="wzd" type="number" inputmode="numeric" placeholder="도면 치수 (예: ${s.d})" style="font-size:22px;width:300px"><button data-wz="len" class="pri big">다음 ▶</button>${btn('len:skip', '치수가 안 보임 (어림값 ' + s.d + ' 사용)', 'ghost')}</div>
        <div class="wzno"><span>파란 띠가 배관이 아닌가요?</span>${btn('cut', '✕ 이 구간은 배관이 아님 (점선·치수선 등)', 'warn')}</div>`;
      } else if (q.phase === 'end') {
        pts = [s._p];
        const eg = { cap: '캡 모양(ㄷ)이 보입니다', flange: '밸브 바로 끝 — 플랜지로 계기·장치에 연결될 가능성' }[s.guess];
        title = branchNote + '배관이 여기서 끝납니다. 끝은 어떻게 되나요?' + (eg ? ' <span class="wzt">' + eg + '</span>' : '');
        const eo = v => (s.guess === v ? 'on' : '');
        body = `<div class="wzb">${btn('end:open', '기존 배관에 연결 / 용접')}${btn('end:cap', '캡', eo('cap'))}${btn('end:blind', '블라인드 플랜지')}${btn('end:flange', '플랜지 (열림)', eo('flange'))}${btn('end:pump', '펌프')}${btn('end:vessel', '베셀·탑')}${btn('end:drum', '드럼')}${btn('end:hx', '열교환기')}</div><div class="row wzs"><label>장치 번호 (장치일 때) <input id="wztag" placeholder="예: P-101A"></label></div>`;
      }
    }
    const pct = Math.round(idx / total * 100);
    P.ov('3D로 바꾸기 — ' + W.f.name, `<div class="wz">
 <div class="wzhd"><div class="wzbar"><i style="width:${q.phase === 'done' ? 100 : pct}%"></i></div><span class="mut">${q.phase === 'done' ? '완료' : idx + ' / ' + total}</span></div>
 <div class="wzmain"><canvas id="wzcv" width="1100" height="560"></canvas><canvas id="wzmini" width="220" height="150"></canvas></div>
 <h3 class="wzq">${title}</h3>${body}
 <div class="row wzft"><button data-wz="back"${W.hist.length ? '' : ' disabled'}>← 이전</button><span style="flex:1"></span><button data-att="back">그만두기</button><button data-wz="adv" class="ghost">고급 편집</button></div>
 <div id="wzmsg" class="mut"></div></div>`);
    $('iso3').hidden = true; $('isop').hidden = true;
    const marks = q.phase === 'size' ? (R.cands || []).filter(c => dist2(c, R.runs[0]._p0) > 1) : null;
    wView(pts.filter(Boolean), mode, marks);
    if (q.phase === 'size' && R.cands && R.cands.length > 1) wPick(pts.filter(Boolean), mode, marks);
    const d = $('wzd'); if (d) { d.focus(); d.onkeydown = e => { if (e.key === 'Enter') wAnswer('len'); }; }
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
    if (k === 'size') { R.nps = +v; R.runs[0].nps = +v; const ln = $('wzln'), cl = $('wzcls'); if (ln) R.line_no = ln.value.trim(); if (cl) R.cls = +cl.value; const ce = $('wzce'); if (ce) R.ce = ce.value; wAdvance(); }
    else if (k === 'type') {
      if (v === 'none') { const nx = r.steps[q.si + 1]; if (nx) { nx.d = (+nx.d || 0) + (+s.d || 0); nx.okLen = false; } r.steps.splice(q.si, 1); W.q.phase = null; wFirstPhase(); }
      else { if (v === 'flange') { s.t = 'flange'; delete s.vt; } else { s.t = 'valve'; s.vt = v; s.conn = 'flg'; } s.okType = true; wAdvance(); }
    }
    else if (k === 'vs') { s.vnps = +v; s.okVsize = true; wAdvance(); }
    else if (k === 'rt') { W.hist.pop(); s.rt = v; wRender(); return; }
    else if (k === 'rs') {
      if (v === 'none') { const nx = r.steps[q.si + 1]; if (nx) { nx.d = (+nx.d || 0) + (+s.d || 0); nx.okLen = false; } r.steps.splice(q.si, 1); W.q.phase = null; wFirstPhase(); }
      else { s.nps2 = +v; s.rt = s.rt || 'conc'; s.okRed = true; wAdvance(); }
    }
    else if (k === 'br') {
      if (v === 'none') { // 티가 아니면: 이 티에서 시작한 갈라진 배관을 지움
        const id = s.id; s.t = 'flange'; s.okType = false; delete s.id; delete s.branch; delete s.nps2;
        const nx = r.steps[q.si + 1]; if (nx) { nx.d = (+nx.d || 0) + (+s.d || 0); nx.okLen = false; } r.steps.splice(q.si, 1); R.runs = R.runs.filter(x => !(x.start && x.start.tee === id)); W.q.phase = null; wFirstPhase();
      } else { s.nps2 = +v; s.okBranch = true; R.runs.forEach(x => { if (x.start && x.start.tee === s.id) x.nps = +v; }); wAdvance(); }
    }
    else if (k === 'len') {
      if (v !== 'skip') { const el = $('wzd'), n = +(el && el.value); if (!(n > 0)) { W.hist.pop(); const m = $('wzmsg'); if (m) m.textContent = '숫자를 입력해 주세요. 치수가 안 보이면 "치수가 안 보임"을 누르세요.'; return; } s.d = n; delete s.conf; delete s.est; }
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
  function wBuild() {
    const b = buildRoute(W.R, W.src);
    P.removeWhere(o => o.src === W.src);
    if (b.objs.length) P.loadModel(Object.assign(b, { name: W.f.name.replace(/\.pdf$/i, '') }));
    const f = W.f; f.route = W.R; P.fPut(f);
    const ids = P.getObjs().filter(o => o.src === W.src && !o.ex).map(o => o.id);
    P.ov('3D로 바꾸기 — 완료', `<div class="wz"><h3 class="wzq">3D를 만들었습니다 (부품 ${b.objs.length}개).</h3>
${b.errs.length ? `<p class="mut">맞지 않는 곳이 ${b.errs.length}군데 있습니다 (예: 앞 부품과 길이가 겹침). 3D를 보고 이상하면 "이전 단계로" 돌아가 길이를 고치거나, 고급 편집에서 확인하세요.</p>` : ''}
<div class="wzb"><button data-wz="see3d" class="pri big">3D로 보기</button><button data-wz="seeiso" class="big">ISO로 원본과 비교</button></div>
<div class="row wzft"><button data-wz="again">← 이전 단계로 (답 고치기)</button><span style="flex:1"></span><button data-wz="adv" class="ghost">고급 편집</button></div></div>`);
    $('iso3').hidden = true; $('isop').hidden = true;
    W.built = ids;
  }
  function wClick(e) {
    const b = e.target.closest('[data-wz]'); if (!b || !W) return;
    const a = b.dataset.wz;
    if (a === 'see3d') { P.focus(P.getObjs().filter(o => o.src === W.src).map(o => o.id)); return; }
    if (a === 'seeiso') { if (W.built && W.built.length) P.showIso(W.built[0]); return; }
    if (a === 'again') { W.q = { ri: 0, si: 0, phase: 'done' }; wRender(); return; }
    wAnswer(a);
  }
  document.getElementById('isob').addEventListener('click', wClick);
  const wcss = document.createElement('style');
  wcss.textContent = `.wz{max-width:1150px;margin:0 auto}.wzhd{display:flex;align-items:center;gap:10px;margin-bottom:8px}.wzbar{flex:1;height:8px;background:#e2e8f0;border-radius:4px;overflow:hidden}.wzbar i{display:block;height:100%;background:#0f766e}
.wzmain{position:relative;border:1px solid #cbd5e1;border-radius:8px;overflow:hidden;background:#fff}#wzcv{display:block;width:100%;height:auto}#wzmini{position:absolute;right:8px;bottom:8px;width:200px;border:1px solid #94a3b8;background:#fff;opacity:.92}
.wzq{font-size:20px;margin:14px 0 10px}.wzt{display:inline-block;background:#e0f2fe;color:#075985;border-radius:4px;padding:1px 8px;font-size:14px;vertical-align:middle}
.wzb{display:flex;flex-wrap:wrap;gap:8px;margin:6px 0}.wzb button{font-size:17px;padding:10px 16px;border-radius:8px;min-width:90px}.wzb button.on{outline:3px solid #0f766e}.wz button.big{font-size:18px;padding:12px 22px}.wz button.ghost{background:#f8fafc;color:#475569}.wzno{display:flex;flex-wrap:wrap;align-items:center;gap:8px;margin:10px 0 0;padding:8px 10px;background:#fff7ed;border:1px solid #fed7aa;border-radius:8px}.wzno span{font-size:14px;color:#9a3412}.wzno button{font-size:15px;padding:7px 12px}.wz button.warn{background:#fff;color:#b91c1c;border-color:#fca5a5}
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

  window.P3DX = { _wz: () => W, wizard, convert, table, settings, manual, buildRoute, SYS, _aiRead: aiRead, _tiles: tiles };
})();
