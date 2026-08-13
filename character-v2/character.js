import * as THREE from 'three';

// ============================================================================
//  בניית דמות v2 — משטח רציף במקום הרכבת גופים נפרדים
//
//  שלושה עקרונות:
//  1. איבר = מש אחד שנמתח לאורך מסלול, כשעובי החתך משתנה לאורכו.
//     אין תפר → אין מה להסתיר → אין כדורי מפרקים ואין בליטות.
//  2. חתך אליפטי (רוחב ≠ עומק) → גוף, לא נקניק.
//  3. בגד = פרופיל הגוף עצמו + מרווח קבוע, על אותו מסלול בדיוק.
//     לכן הבד תמיד צמוד ואף פעם לא נחתך על ידי הגוף.
//
//  הפרופורציות נמדדו מתמונת הרפרנס: נער רזה בן ~6.2 ראשים, לא בובה של 5.
// ============================================================================

const V = (x, y, z) => new THREE.Vector3(x, y, z);

// ---------- אינטרפולציה של פרופיל העובי ----------
function profileAt(keys, t) {
  if (t <= keys[0].t) return { rx: keys[0].rx, rz: keys[0].rz };
  for (let i = 1; i < keys.length; i++) {
    if (t <= keys[i].t) {
      const a = keys[i - 1], b = keys[i];
      let s = (t - a.t) / (b.t - a.t);
      s = s * s * (3 - 2 * s);              // smoothstep → מעבר רך בלי שברים
      return { rx: a.rx + (b.rx - a.rx) * s, rz: a.rz + (b.rz - a.rz) * s };
    }
  }
  const l = keys[keys.length - 1];
  return { rx: l.rx, rz: l.rz };
}

// ---------- מסגרת יציבה לאורך העקום ----------
// לא Frenet (שמתהפך בפיתול): מיישרים את ציר הרוחב לכיוון קבוע, כדי שהאיבר
// לא יתפתל סביב עצמו.
function frameAt(T, ref) {
  let N = ref.clone().addScaledVector(T, -ref.dot(T));
  if (N.lengthSq() < 1e-6) {
    const alt = Math.abs(T.y) > 0.9 ? V(0, 0, 1) : V(0, 1, 0);
    N = alt.clone().addScaledVector(T, -alt.dot(T));
  }
  N.normalize();
  return { N, B: new THREE.Vector3().crossVectors(T, N).normalize() };
}

const makeCurve = (points, tension = 0.5) =>
  new THREE.CatmullRomCurve3(points, false, 'centripetal', tension);

/**
 * מותח משטח רציף לאורך עקום.
 *  profile  - מערך {t,rx,rz} (t מנורמל בתוך uRange) או פונקציה (u) => {rx,rz}
 *  uRange   - איזה קטע מהעקום למתוח. מאפשר לבגד לרוץ על *אותו* מסלול כמו הגוף.
 *  capEnd   - 'flat' (קצה קבור בתוך גוף אחר) | 'round' (כיפה מעוגלת)
 */
function sweepCurve(mat, curve, profile, opts = {}) {
  const {
    radial = 32, steps = 28, refDir = V(1, 0, 0),
    capStart = 'flat', capEnd = 'flat', domeSteps = 7, domeScale = 1.0,
    uRange = [0, 1],
  } = opts;
  const [u0, u1] = uRange;
  const prof = typeof profile === 'function'
    ? profile
    : (u) => profileAt(profile, (u - u0) / (u1 - u0 || 1));

  const rings = [];
  const pushDome = (u, sign) => {
    const T = curve.getTangentAt(u).normalize();
    const { N, B } = frameAt(T, refDir);
    const p = curve.getPointAt(u);
    const { rx, rz } = prof(u);
    const len = ((rx + rz) / 2) * domeScale;
    const ks = sign < 0
      ? Array.from({ length: domeSteps }, (_, i) => domeSteps - i)
      : Array.from({ length: domeSteps }, (_, i) => i + 1);
    for (const k of ks) {
      const a = (k / domeSteps) * (Math.PI / 2);
      rings.push({
        p: p.clone().addScaledVector(T, sign * Math.sin(a) * len),
        N, B, rx: rx * Math.cos(a), rz: rz * Math.cos(a),
      });
    }
  };

  if (capStart === 'round') pushDome(u0, -1);
  for (let i = 0; i <= steps; i++) {
    const u = u0 + (u1 - u0) * (i / steps);
    const T = curve.getTangentAt(u).normalize();
    const { N, B } = frameAt(T, refDir);
    const { rx, rz } = prof(u);
    rings.push({ p: curve.getPointAt(u), N, B, rx, rz });
  }
  if (capEnd === 'round') pushDome(u1, 1);

  // ---------- טבעות → מש ----------
  const cols = radial + 1;               // הקודקוד האחרון משכפל את הראשון
  const pos = [], uv = [];
  for (let i = 0; i < rings.length; i++) {
    const r = rings[i];
    for (let j = 0; j < cols; j++) {
      const th = (j / radial) * Math.PI * 2;
      const c = Math.cos(th), s = Math.sin(th);
      pos.push(
        r.p.x + r.N.x * r.rx * c + r.B.x * r.rz * s,
        r.p.y + r.N.y * r.rx * c + r.B.y * r.rz * s,
        r.p.z + r.N.z * r.rx * c + r.B.z * r.rz * s,
      );
      uv.push(j / radial, i / (rings.length - 1));
    }
  }

  // סדר הקודקודים חייב להיות נגד כיוון השעון כשמסתכלים מבחוץ,
  // אחרת המשטח יוצא הפוך והדפדפן מציג לנו את *פנים* האיבר.
  const idx = [];
  for (let i = 0; i < rings.length - 1; i++) {
    for (let j = 0; j < radial; j++) {
      const a = i * cols + j, b = a + cols;
      idx.push(a, a + 1, b, a + 1, b + 1, b);
    }
  }

  const addFan = (ringIndex, flip) => {
    const r = rings[ringIndex];
    const c = pos.length / 3;
    pos.push(r.p.x, r.p.y, r.p.z);
    uv.push(0.5, ringIndex / (rings.length - 1));
    for (let j = 0; j < radial; j++) {
      const a = ringIndex * cols + j;
      if (flip) idx.push(c, a + 1, a); else idx.push(c, a, a + 1);
    }
  };
  if (capStart === 'flat') addFan(0, true);
  if (capEnd === 'flat') addFan(rings.length - 1, false);

  const geo = new THREE.BufferGeometry();
  geo.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
  geo.setAttribute('uv', new THREE.Float32BufferAttribute(uv, 2));
  geo.setIndex(idx);
  geo.computeVertexNormals();

  // ריתוך התפר: הקודקוד הראשון והאחרון בכל טבעת חולקים מיקום אך קיבלו
  // נורמלים שונים. בלי מיצוע נראה קו תפר לאורך כל האיבר.
  const nrm = geo.attributes.normal;
  for (let i = 0; i < rings.length; i++) {
    const a = i * cols, b = a + radial;
    const nx = (nrm.getX(a) + nrm.getX(b)) / 2;
    const ny = (nrm.getY(a) + nrm.getY(b)) / 2;
    const nz = (nrm.getZ(a) + nrm.getZ(b)) / 2;
    const l = Math.hypot(nx, ny, nz) || 1;
    nrm.setXYZ(a, nx / l, ny / l, nz / l);
    nrm.setXYZ(b, nx / l, ny / l, nz / l);
  }
  nrm.needsUpdate = true;

  const mesh = new THREE.Mesh(geo, mat);
  mesh.castShadow = true;
  mesh.receiveShadow = true;
  return mesh;
}

const sweep = (mat, points, profile, opts = {}) =>
  sweepCurve(mat, makeCurve(points, opts.tension), profile, opts);

/**
 * בגד: רץ על *אותו* מסלול של הגוף, עם פרופיל הגוף + מרווח קבוע.
 * לכן הבד לעולם אינו נחתך על ידי הגוף ואינו "דלי" שהונח מלמעלה.
 *  pad   - מרווח מהעור
 *  bulge - תוספת מקומית (למשל שול מקופל), לפי t של הבגד עצמו
 */
/**
 * מותח משטח שהקצה העליון שלו נמצא בגובה *משתנה לפי הזווית*.
 * זה מה שמאפשר מחשוף אמיתי: הקצה עולה על הכתפיים ויורד בחזית ובגב.
 * צינור נמתח רגיל תמיד נגמר בטבעת שטוחה, ולכן הוא נראה כמו גופייה סטרפלס.
 */
function sweepShapedEdge(mat, curve, profileFn, opts = {}) {
  const { radial = 40, steps = 26, refDir = V(1, 0, 0), u0 = 0, edgeU } = opts;
  const cols = radial + 1;
  const pos = [], uv = [];

  for (let i = 0; i <= steps; i++) {
    for (let j = 0; j < cols; j++) {
      const th = (j / radial) * Math.PI * 2;
      const u = u0 + (edgeU(th) - u0) * (i / steps);
      const p = curve.getPointAt(u);
      const T = curve.getTangentAt(u).normalize();
      const { N, B } = frameAt(T, refDir);
      const { rx, rz } = profileFn(u);
      const c = Math.cos(th), s = Math.sin(th);
      pos.push(
        p.x + N.x * rx * c + B.x * rz * s,
        p.y + N.y * rx * c + B.y * rz * s,
        p.z + N.z * rx * c + B.z * rz * s,
      );
      uv.push(j / radial, i / steps);
    }
  }

  const idx = [];
  for (let i = 0; i < steps; i++) {
    for (let j = 0; j < radial; j++) {
      const a = i * cols + j, b = a + cols;
      idx.push(a, a + 1, b, a + 1, b + 1, b);
    }
  }

  const geo = new THREE.BufferGeometry();
  geo.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
  geo.setAttribute('uv', new THREE.Float32BufferAttribute(uv, 2));
  geo.setIndex(idx);
  geo.computeVertexNormals();

  const nrm = geo.attributes.normal;
  for (let i = 0; i <= steps; i++) {
    const a = i * cols, b = a + radial;
    const nx = (nrm.getX(a) + nrm.getX(b)) / 2;
    const ny = (nrm.getY(a) + nrm.getY(b)) / 2;
    const nz = (nrm.getZ(a) + nrm.getZ(b)) / 2;
    const l = Math.hypot(nx, ny, nz) || 1;
    nrm.setXYZ(a, nx / l, ny / l, nz / l);
    nrm.setXYZ(b, nx / l, ny / l, nz / l);
  }
  nrm.needsUpdate = true;

  const mesh = new THREE.Mesh(geo, mat);
  mesh.castShadow = true;
  mesh.receiveShadow = true;
  return mesh;
}

// ---------- מרקמי בד פרוצדורליים ----------
// נוצרים בקנבס בזמן ריצה, בלי קבצים חיצוניים — שומר על "קובץ אחד שנפתח בדפדפן".
function canvasTex(size, draw, rx = 1, ry = 1) {
  const c = document.createElement('canvas');
  c.width = c.height = size;
  draw(c.getContext('2d'), size);
  const t = new THREE.CanvasTexture(c);
  t.wrapS = t.wrapT = THREE.RepeatWrapping;
  t.repeat.set(rx, ry);
  return t;
}

const ribbedKnit = (hex) => canvasTex(128, (ctx, n) => {
  ctx.fillStyle = hex; ctx.fillRect(0, 0, n, n);
  for (let x = 0; x < n; x += 6) {
    ctx.fillStyle = 'rgba(0,0,0,0.10)'; ctx.fillRect(x, 0, 2, n);
    ctx.fillStyle = 'rgba(255,255,255,0.10)'; ctx.fillRect(x + 3, 0, 1, n);
  }
}, 14, 1);

const denimTex = (hex) => canvasTex(128, (ctx, n) => {
  ctx.fillStyle = hex; ctx.fillRect(0, 0, n, n);
  ctx.strokeStyle = 'rgba(255,255,255,0.07)'; ctx.lineWidth = 1;
  for (let k = -n; k < n * 2; k += 4) {            // אריגת טוויל אלכסונית
    ctx.beginPath(); ctx.moveTo(k, 0); ctx.lineTo(k + n, n); ctx.stroke();
  }
  for (let i = 0; i < 1600; i++) {
    ctx.fillStyle = `rgba(0,0,0,${0.03 + Math.random() * 0.05})`;
    ctx.fillRect(Math.random() * n, Math.random() * n, 1, 1);
  }
}, 5, 5);

const bandageTex = (hex) => canvasTex(128, (ctx, n) => {
  ctx.fillStyle = hex; ctx.fillRect(0, 0, n, n);
  ctx.lineWidth = 2;
  for (let k = -n; k < n * 2; k += 12) {
    ctx.strokeStyle = 'rgba(0,0,0,0.11)';
    ctx.beginPath(); ctx.moveTo(k, 0); ctx.lineTo(k + n * 0.55, n); ctx.stroke();
    ctx.strokeStyle = 'rgba(255,255,255,0.10)';
    ctx.beginPath(); ctx.moveTo(k + 4, 0); ctx.lineTo(k + 4 + n * 0.55, n); ctx.stroke();
  }
}, 3, 2);

const leatherTex = (hex) => canvasTex(128, (ctx, n) => {
  ctx.fillStyle = hex; ctx.fillRect(0, 0, n, n);
  for (let i = 0; i < 2600; i++) {
    const g = Math.random() < 0.5 ? 0 : 255;
    ctx.fillStyle = `rgba(${g},${g},${g},${0.02 + Math.random() * 0.06})`;
    ctx.fillRect(Math.random() * n, Math.random() * n, 2, 2);
  }
}, 3, 3);

function garment(mat, curve, bodyProfile, opts = {}) {
  const { u0 = 0, u1 = 1, pad = 0.008, bulge = null, ...rest } = opts;
  const profileFn = (u) => {
    const b = profileAt(bodyProfile, u);
    const e = bulge ? profileAt(bulge, (u - u0) / (u1 - u0 || 1)) : { rx: 0, rz: 0 };
    return { rx: b.rx + pad + e.rx, rz: b.rz + pad + e.rz };
  };
  return sweepCurve(mat, curve, profileFn, { ...rest, uRange: [u0, u1] });
}

// ============================================================================
//  פרופורציות — הכל ביחידות רדיוס-גולגולת R, נמדד מתמונת הרפרנס.
//  שינוי R לבדו משנה את גודל הדמות כולה בלי לשבור אף יחס.
// ============================================================================

const R = 0.117;                      // גובה ראש ~0.262 → דמות של ~6.9 ראשים
const pr = (t, rx, rz) => ({ t, rx: rx * R, rz: rz * R });

// יחסי הראש נמדדו מהרפרנס: הראש *צר וגבוה*, לא כדור.
// רוחב/גובה ≈ 0.64, ועומק גדול מרוחב — כמו ראש אנושי אמיתי.
// זו הייתה הסיבה העיקרית שהדמות נראתה כמו בובה.
const HEAD_SCALE = { x: 0.78, y: 1.10, z: 0.90 };

// זרוע רזה: דלתא → דו-ראשי → מרפק צר → אמה → שורש כף יד דק
const ARM_PROFILE = [
  pr(0.00, 0.56, 0.54),
  pr(0.16, 0.54, 0.51),
  pr(0.40, 0.36, 0.35),
  pr(0.60, 0.30, 0.32),
  pr(0.76, 0.33, 0.32),
  pr(1.00, 0.23, 0.25),
];

// רגל: ירך → ברך צרה → תפוח שוק → קרסול דק (בקוד הישן זה היה הפוך)
const LEG_PROFILE = [
  pr(0.00, 0.72, 0.69),
  pr(0.16, 0.66, 0.63),
  pr(0.44, 0.56, 0.55),
  pr(0.60, 0.46, 0.49),
  pr(0.72, 0.51, 0.54),
  pr(1.00, 0.285, 0.31),
];

// פלג גוף: אגן → מותן צר → חזה → כתפיים משופעות
const TORSO_PROFILE = [
  pr(0.00, 1.27, 0.86),
  pr(0.30, 1.08, 0.75),
  pr(0.68, 1.35, 0.90),
  pr(0.89, 1.18, 0.80),
  pr(1.00, 0.68, 0.60),
];

const NECK_PROFILE = [pr(0.0, 0.38, 0.36), pr(1.0, 0.35, 0.34)];

// ---------- שלד: עמידת קרב לפי הרפרנס ----------
// הגבהים נמדדו כאחוז מגובה הדמות בתמונה. השינוי המשמעותי מהגרסה הקודמת:
// המפשעה ירדה (0.44 → 0.385 מהגובה), כלומר "רכיבה" ארוכה יותר בין החגורה
// למפשעה — בדיוק כמו ברפרנס, ובלי זה פלג הגוף נראה קצר וילדותי.
const SKEL = {
  ankleL: V(-0.252, 0.135, -0.03), ankleR: V(0.236, 0.135, 0.122),
  kneeL:  V(-0.182, 0.430, 0.022), kneeR:  V(0.174, 0.430, 0.140),
  hipL:   V(-0.098, 0.700, 0.0),   hipR:   V(0.098, 0.700, 0.012),
  pelvis: V(0, 0.655, 0),
  waist:  V(0, 0.965, 0.004),
  chest:  V(0, 1.245, 0.012),
  torsoTop: V(0, 1.355, 0.0),
  shoulderL: V(-0.130, 1.350, 0.0), shoulderR: V(0.130, 1.350, 0.0),
  elbowL: V(-0.232, 1.082, 0.095),  elbowR: V(0.242, 1.072, 0.015),
  wristL: V(-0.138, 1.262, 0.202),  wristR: V(0.158, 1.358, 0.118),
  headCenter: V(0, 1.573, 0),
};

function rng(seed) {                  // זרע קבוע → רינדורים ניתנים להשוואה
  let s = seed >>> 0;
  return () => ((s = (s * 1664525 + 1013904223) >>> 0) / 4294967296);
}

// ============================================================================

export function createFighter(cfg) {
  const g = new THREE.Group();
  const rand = rng(cfg.seed ?? 12345);
  const S = SKEL;
  const M = (color, roughness, metalness = 0) =>
    new THREE.MeshStandardMaterial({ color, roughness, metalness });

  const skinMat  = M(cfg.skin, 0.62);
  const hairMat  = M(cfg.hair, 0.88);
  const topMat = cfg.top ? new THREE.MeshStandardMaterial({
    color: cfg.top, roughness: 0.92, map: ribbedKnit('#ffffff'),
    side: THREE.DoubleSide,          // לקצה המחשוף יש צד פנימי שנראה
  }) : null;
  const pantsMat = cfg.pants ? new THREE.MeshStandardMaterial({
    color: cfg.pants, roughness: 0.94, map: denimTex('#ffffff'),
  }) : null;
  const boxerMat = cfg.boxers ? M(cfg.boxers, 0.85) : null;
  const bootMat = cfg.boots ? new THREE.MeshStandardMaterial({
    color: cfg.boots, roughness: 0.55, map: leatherTex('#ffffff'),
  }) : null;
  const soleMat  = M(0x2f241c, 0.95);
  const laceMat  = M(0xd9c9a8, 0.85);
  const cuffMat = cfg.pants ? new THREE.MeshStandardMaterial({
    color: 0x89a2cb, roughness: 0.94, map: denimTex('#ffffff'),
  }) : null;
  const beltMat  = new THREE.MeshStandardMaterial({ color: 0x4a3323, roughness: 0.5, map: leatherTex('#ffffff') });
  const buckleMat = M(0xb9a06a, 0.28, 0.85);
  const wrapMat = new THREE.MeshStandardMaterial({
    color: 0xf2efe7, roughness: 0.96, map: bandageTex('#ffffff'),
  });
  const eyeWhiteMat = M(0xfcfcfc, 0.22);
  const irisMat  = M(cfg.eyeColor ?? 0x5a3a20, 0.28);
  const pupilMat = M(0x120e0a, 0.2);
  const glintMat = new THREE.MeshBasicMaterial({ color: 0xffffff });
  const mouthMat = M(0x8a4a44, 0.6);
  const goldMat  = M(0xd9b23c, 0.2, 0.95);

  const legMat = pantsMat || skinMat;

  // ---------- פלג גוף עליון ----------
  // מסלול רציף מהאגן עד קו הכתפיים, עם כיפה רדודה שיוצרת את שיפוע הטרפז.
  // אין כדור חזה ואין כדור אגן.
  const torsoCurve = makeCurve([S.pelvis, S.waist, S.chest, S.torsoTop]);
  g.add(sweepCurve(skinMat, torsoCurve, TORSO_PROFILE, {
    refDir: V(1, 0, 0), steps: 38, capEnd: 'round', domeScale: 0.55,
  }));

  // ---------- רגליים ----------
  // המסלול מתחיל *בתוך* האגן → החיבור קבור ואינו נראה מבחוץ.
  const legCurves = [];
  [[S.hipL, S.kneeL, S.ankleL], [S.hipR, S.kneeR, S.ankleR]].forEach(([hip, knee, ankle]) => {
    const hipIn = V(hip.x * 0.40, hip.y + 0.055, hip.z);
    const c = makeCurve([hipIn, hip, knee, ankle]);
    legCurves.push(c);
    g.add(sweepCurve(legMat, c, LEG_PROFILE, { refDir: V(1, 0, 0), steps: 34 }));
  });

  // ---------- תחתונים ----------
  if (boxerMat && !pantsMat) {
    g.add(garment(boxerMat, torsoCurve, TORSO_PROFILE, { u0: 0, u1: 0.38, pad: 0.011, steps: 18 }));
    legCurves.forEach((c) => {
      g.add(garment(boxerMat, c, LEG_PROFILE, { u0: 0.02, u1: 0.26, pad: 0.010, steps: 12 }));
    });
  }

  // ---------- מכנסיים ----------
  // רצים על אותו מסלול של הרגל עם מרווח קבוע → הבד צמוד.
  // השול המקופל הוא תוספת מקומית לאותו משטח, לא טבעת מרחפת.
  if (pantsMat) {
    g.add(garment(pantsMat, torsoCurve, TORSO_PROFILE, { u0: 0, u1: 0.40, pad: 0.012, steps: 20 }));

    const CUFF_BULGE = [
      { t: 0.00, rx: 0, rz: 0 }, { t: 0.80, rx: 0, rz: 0 },
      { t: 0.90, rx: 0.011, rz: 0.011 }, { t: 1.00, rx: 0.009, rz: 0.009 },
    ];
    legCurves.forEach((c) => {
      g.add(garment(pantsMat, c, LEG_PROFILE, {
        u0: 0.02, u1: 0.755, pad: 0.011, bulge: CUFF_BULGE, steps: 30,
      }));
      // שול ג'ינס מקופל (יש ברפרנס) — שכבה קצרה מעל אותו מסלול
      g.add(garment(cuffMat, c, LEG_PROFILE, { u0: 0.665, u1: 0.775, pad: 0.021, steps: 12 }));
    });

    g.add(garment(beltMat, torsoCurve, TORSO_PROFILE, { u0: 0.335, u1: 0.390, pad: 0.015, steps: 8 }));
    const bp = torsoCurve.getPointAt(0.362);
    const bprof = profileAt(TORSO_PROFILE, 0.362);
    const buckle = new THREE.Mesh(new THREE.BoxGeometry(0.058, 0.046, 0.02), buckleMat);
    buckle.position.set(bp.x, bp.y, bp.z + bprof.rz + 0.014);
    buckle.castShadow = true;
    g.add(buckle);
  }

  // ---------- כפות רגליים / מגפיים ----------
  [[S.ankleL, legCurves[0], -0.20], [S.ankleR, legCurves[1], 0.17]].forEach(([ankle, legCurve, yaw]) => {
    const fwd = V(Math.sin(yaw), 0, Math.cos(yaw));
    const y = 0.066;
    const heel = ankle.clone().setY(y).addScaledVector(fwd, -0.060);
    const mid  = ankle.clone().setY(y + 0.004).addScaledVector(fwd, 0.045);
    const toe  = ankle.clone().setY(y - 0.010).addScaledVector(fwd, 0.160);

    if (bootMat) {
      // שוק המגף — המשך ישיר של מסלול הרגל, לא גליל נפרד
      g.add(garment(bootMat, legCurve, LEG_PROFILE, { u0: 0.735, u1: 1.0, pad: 0.019, steps: 16 }));

      // כף המגף — מסלול אופקי, חתך רחב ושטוח, קצוות מעוגלים
      g.add(sweep(bootMat, [heel, mid, toe], [
        pr(0.00, 0.38, 0.37), pr(0.34, 0.42, 0.34), pr(0.70, 0.40, 0.30), pr(1.00, 0.31, 0.23),
      ], { steps: 24, refDir: V(0, 1, 0), capStart: 'round', capEnd: 'round', domeScale: 0.7 }));

      // סוליה
      g.add(sweep(soleMat,
        [heel.clone().setY(y - 0.038), mid.clone().setY(y - 0.044), toe.clone().setY(y - 0.046)],
        [pr(0.00, 0.22, 0.40), pr(0.5, 0.24, 0.37), pr(1.00, 0.18, 0.28)],
        { steps: 18, refDir: V(0, 1, 0), capStart: 'round', capEnd: 'round', domeScale: 0.7 }));

      // שרוכים
      [0.80, 0.88, 0.96].forEach((u) => {
        const p = legCurve.getPointAt(u);
        const pf = profileAt(LEG_PROFILE, u);
        const lace = new THREE.Mesh(new THREE.BoxGeometry(0.062, 0.010, 0.012), laceMat);
        lace.position.set(p.x, p.y, p.z + pf.rz + 0.020);
        lace.rotation.y = yaw;
        g.add(lace);
      });
    } else {
      g.add(sweep(skinMat, [heel, mid, toe], [
        pr(0.00, 0.36, 0.33), pr(0.4, 0.40, 0.30), pr(0.75, 0.38, 0.27), pr(1.00, 0.29, 0.20),
      ], { steps: 22, refDir: V(0, 1, 0), capStart: 'round', capEnd: 'round', domeScale: 0.8 }));
    }
  });

  // ---------- זרועות ----------
  // המסלול מתחיל בתוך בית החזה, והדלתא היא פשוט הקטע העבה של הזרוע.
  // אין כדור כתף בכלל — זה מה שהעיף את "הידיים הנפוחות".
  [[S.shoulderL, S.elbowL, S.wristL, -1], [S.shoulderR, S.elbowR, S.wristR, 1]]
    .forEach(([sh, el, wr, side]) => {
      const shIn = V(sh.x * 0.38, sh.y - 0.045, sh.z);
      const armCurve = makeCurve([shIn, sh, el, wr]);
      g.add(sweepCurve(skinMat, armCurve, ARM_PROFILE, { refDir: V(0, 1, 0), steps: 36 }));

      const dir = armCurve.getTangentAt(1).normalize();
      const across = new THREE.Vector3().crossVectors(dir, V(0, 1, 0)).normalize();

      // תחבושת צמודה לאמה — לא עבה ממנה, כמו ברפרנס
      if (cfg.handWraps) {
        g.add(garment(wrapMat, armCurve, ARM_PROFILE, { u0: 0.76, u1: 1.0, pad: 0.006, steps: 14 }));
      }

      // ---------- אגרוף ----------
      // לא כדור: רחב מעומקו, מתנפח בפרקי האצבעות ומתעגל בקצה.
      const fistMat = cfg.handWraps ? wrapMat : skinMat;
      g.add(sweep(fistMat,
        [wr.clone().addScaledVector(dir, -0.010),
         wr.clone().addScaledVector(dir, 0.030),
         wr.clone().addScaledVector(dir, 0.068)],
        [pr(0.00, 0.30, 0.28), pr(0.5, 0.44, 0.40), pr(1.00, 0.41, 0.37)],
        { steps: 16, refDir: across, capEnd: 'round', domeScale: 0.8 }));

      // אגודל מקופל על צד האגרוף
      g.add(sweep(fistMat,
        [wr.clone().addScaledVector(dir, 0.004).addScaledVector(across, side * 0.036),
         wr.clone().addScaledVector(dir, 0.048).addScaledVector(across, side * 0.022)],
        [pr(0, 0.16, 0.16), pr(1, 0.13, 0.13)],
        { steps: 8, radial: 20, capEnd: 'round' }));

      if (cfg.fingerRing && side === 1) {
        const ring = new THREE.Mesh(new THREE.TorusGeometry(0.036, 0.008, 8, 20), goldMat);
        ring.position.copy(wr.clone().addScaledVector(dir, 0.036));
        ring.quaternion.setFromUnitVectors(V(0, 0, 1), dir);
        ring.castShadow = true;
        g.add(ring);
      }
    });

  // ---------- גופייה ----------
  // אותו מסלול של פלג הגוף + מרווח → צמודה, והשוליים עוקבים אחרי קו הגוף.
  // ה-pad קטן מזה של המכנסיים, ולכן היא נכנסת *לתוך* המכנסיים.
  if (topMat) {
    // המסגרת של פלג הגוף היא N=+X, ולכן: θ=0 ימין, θ=π/2 גב, θ=π שמאל, θ=3π/2 חזית.
    // הקצה גבוה בכתפיים (שם נוצרות הכתפיות) ונמוך בחזית ובגב (המחשוף).
    // הזרוע יוצאת מבית החזה מתחת לקצה הגבוה — וזה מייצר את פתח השרוול.
    const edgeU = (th) => 0.870 + 0.122 * Math.pow(Math.abs(Math.cos(th)), 1.15);
    const shirtProfile = (u) => {
      const b = profileAt(TORSO_PROFILE, u);
      return { rx: b.rx + 0.008, rz: b.rz + 0.008 };
    };
    g.add(sweepShapedEdge(topMat, torsoCurve, shirtProfile,
      { u0: 0.28, edgeU, radial: 44, steps: 30, refDir: V(1, 0, 0) }));
  }

  // ---------- צוואר ----------
  // קבור משני צדדיו (בחזה ובראש) → אין תפר נראה, ואין כדור מפרק.
  g.add(sweep(skinMat, [V(0, 1.285, 0.006), V(0, 1.38, 0.0), V(0, 1.495, -0.006)],
    NECK_PROFILE, { steps: 12, radial: 26 }));

  // ---------- ראש ----------
  const HC = S.headCenter;
  const head = new THREE.Mesh(new THREE.SphereGeometry(R, 44, 34), skinMat);
  head.position.copy(HC);
  head.scale.set(HEAD_SCALE.x, HEAD_SCALE.y, HEAD_SCALE.z);
  head.castShadow = true;
  head.receiveShadow = true;
  g.add(head);

  // לסת וסנטר — מרככים את "הכדור המושלם" לצורת פנים
  // נשאר *בתוך* אליפסואיד הראש בכל הכיוונים חוץ מלמטה, ולכן הוא מוסיף סנטר
  // בלי ליצור טבעת תפר נראית סביב הפנים.
  const jaw = new THREE.Mesh(new THREE.SphereGeometry(R * 0.78, 34, 26), skinMat);
  jaw.position.set(0, HC.y - R * 0.52, R * 0.06);
  jaw.scale.set(0.74, 0.86, 0.84);
  jaw.castShadow = true;
  g.add(jaw);

  // ---------- אוזניים ----------
  [-1, 1].forEach((s) => {
    if (cfg.ears === 'pointed') {
      g.add(sweep(skinMat,
        [V(s * R * 0.66, HC.y + R * 0.02, -R * 0.04),
         V(s * R * 0.82, HC.y + R * 0.58, -R * 0.24),
         V(s * R * 0.90, HC.y + R * 1.14, -R * 0.44)],
        [pr(0, 0.28, 0.16), pr(0.55, 0.20, 0.10), pr(1, 0.04, 0.025)],
        { steps: 14, radial: 20, refDir: V(0, 0, 1), capEnd: 'round', domeScale: 0.6 }));
    } else {
      const ear = new THREE.Mesh(new THREE.SphereGeometry(R * 0.26, 18, 16), skinMat);
      ear.position.set(s * R * 0.72, HC.y - R * 0.06, -R * 0.06);
      ear.scale.set(0.40, 1.15, 0.75);
      ear.castShadow = true;
      g.add(ear);
    }
  });

  // ---------- פנים ----------
  // עיניים קטנות ומבטאות כמו ברפרנס — לא עיניים ענקיות בסגנון אנימה
  [-1, 1].forEach((s) => {
    const ex = s * R * 0.40, ey = HC.y + R * 0.10, ez = R * 0.80;
    // (ez נבחר כך שחזית הלובן תעבור את פני הפנים בכ-0.001 בלבד)

    // פני הראש בגובה העין נמצאים ב-z=0.876R. כל שכבה כאן בולטת רק במעט מעל
    // קודמתה, אחרת גלגל העין יוצא ככדור מודבק על הפנים במקום עין שקועה בארובה.
    const white = new THREE.Mesh(new THREE.SphereGeometry(R * 0.21, 24, 22), eyeWhiteMat);
    white.position.set(ex, ey, ez);
    white.scale.set(1, 0.70, 0.42);
    g.add(white);

    // הקשתית תופסת ~45% מרוחב העין, ולכן הלובן נראה משני צדדיה.
    const iris = new THREE.Mesh(new THREE.SphereGeometry(R * 0.095, 20, 18), irisMat);
    iris.position.set(ex + s * R * 0.012, ey - R * 0.008, ez + R * 0.055);
    iris.scale.set(1, 1, 0.45);
    g.add(iris);

    const pupil = new THREE.Mesh(new THREE.SphereGeometry(R * 0.042, 16, 14), pupilMat);
    pupil.position.set(ex + s * R * 0.012, ey - R * 0.008, ez + R * 0.088);
    pupil.scale.set(1, 1, 0.45);
    g.add(pupil);

    const glint = new THREE.Mesh(new THREE.SphereGeometry(R * 0.028, 10, 10), glintMat);
    glint.position.set(ex + s * R * 0.058, ey + R * 0.062, ez + R * 0.105);
    g.add(glint);

    // גבה עבה ומעוקלת (בולטת ברפרנס) — רצועה, לא קופסה
    g.add(sweep(hairMat,
      [V(ex - s * R * 0.30, HC.y + R * 0.235, R * 0.780),
       V(ex,                HC.y + R * 0.290, R * 0.856),
       V(ex + s * R * 0.30, HC.y + R * 0.245, R * 0.780)],
      [pr(0, 0.04, 0.032), pr(0.5, 0.078, 0.055), pr(1, 0.04, 0.032)],
      { steps: 10, radial: 14, refDir: V(0, 1, 0), capStart: 'round', capEnd: 'round' }));
  });

  // אף = גשר שיוצא מבין הגבות ויורד אל קצה מעוגל, ואז חוזר לתוך הפנים.
  // הגשר קבור בתוך הראש, ולכן אין תפר — רק הקצה בולט החוצה.
  g.add(sweep(skinMat, [
    V(0, HC.y + R * 0.20, R * 0.72),
    V(0, HC.y + R * 0.00, R * 0.80),
    V(0, HC.y - R * 0.15, R * 0.875),
    V(0, HC.y - R * 0.27, R * 0.775),
  ], [
    pr(0.00, 0.040, 0.040), pr(0.42, 0.082, 0.078),
    pr(0.76, 0.112, 0.106), pr(1.00, 0.078, 0.074),
  ], { steps: 18, radial: 22, refDir: V(1, 0, 0), capStart: 'round', domeScale: 0.7 }));

  const smile = new THREE.Mesh(
    new THREE.TorusGeometry(R * 0.215, R * 0.034, 10, 26, Math.PI * 0.78), mouthMat);
  smile.position.set(0, HC.y - R * 0.48, R * 0.775);
  smile.rotation.z = Math.PI * 1.10;
  g.add(smile);

  if (cfg.noseRing) {
    const ring = new THREE.Mesh(new THREE.TorusGeometry(R * 0.15, R * 0.038, 10, 20), goldMat);
    ring.position.set(0, HC.y - R * 0.40, R * 0.98);
    ring.castShadow = true;
    g.add(ring);
  }

  // ---------- שיער ----------
  // ברפרנס נפח השיער גדול ומקיף — הוא מה שנותן את הצללית, לא ראש גדול.
  // הכיפה מוטה לאחור: קו השיער בחזית עולה מעל המצח, ובעורף הוא יורד נמוך.
  // בלי ההטיה נוצר "קסדה" עם פס כהה חוצה שמסתיר את העיניים.
  const cap = new THREE.Mesh(
    new THREE.SphereGeometry(R * 1.02, 34, 26, 0, Math.PI * 2, 0, Math.PI * 0.54), hairMat);
  cap.position.copy(HC);
  cap.position.y += R * 0.06;
  cap.position.z -= R * 0.16;
  cap.rotation.x = -0.30;
  // מסת השיער רחבה מהגולגולת עצמה — ברפרנס היא מה שנותן לראש את הנוכחות.
  cap.scale.set(HEAD_SCALE.x * 1.04, HEAD_SCALE.y * 1.02, HEAD_SCALE.z * 1.04);
  cap.castShadow = true;
  g.add(cap);

  const hx = R * HEAD_SCALE.x * 1.24, hy = R * HEAD_SCALE.y * 1.06, hz = R * HEAD_SCALE.z * 1.14;
  const RINGS = [
    { phi: 0.18, count: 7 }, { phi: 0.42, count: 12 }, { phi: 0.66, count: 16 },
    { phi: 0.90, count: 19 }, { phi: 1.14, count: 21 }, { phi: 1.38, count: 21 },
    { phi: 1.60, count: 18 },
  ];
  RINGS.forEach(({ phi, count }) => {
    for (let i = 0; i < count; i++) {
      const theta = (i / count) * Math.PI * 2 + phi * 1.7;
      const lx = Math.sin(phi) * Math.cos(theta) * hx;
      const ly = Math.cos(phi) * hy;
      const lz = Math.sin(phi) * Math.sin(theta) * hz;
      // קו השיער: בחזית הוא נעצר גבוה (מעל הגבות), בצדדים ובעורף הוא יורד
      if (lz > R * 0.15 && ly < R * 0.95 - lz * 0.28) continue;

      const jit = () => (rand() - 0.5) * R * 0.18;
      const px = HC.x + lx * 1.16 + jit();
      const py = HC.y + ly * 1.14 + jit() + R * 0.06;
      const pz = lz * 1.16 + jit() - R * 0.04;

      if (cfg.hairStyle === 'spiky') {
        const d = V(lx, ly, lz).normalize();
        g.add(sweep(hairMat,
          [V(px, py, pz),
           V(px + d.x * R * 0.40, py + d.y * R * 0.40, pz + d.z * R * 0.40),
           V(px + d.x * R * 0.92, py + d.y * R * 0.92, pz + d.z * R * 0.92)],
          [pr(0, 0.25, 0.25), pr(0.55, 0.14, 0.14), pr(1, 0.02, 0.02)],
          { steps: 8, radial: 12, capEnd: 'round', domeScale: 0.5 }));
      } else {
        // תלתל = קשת קצרה שמתעגלת סביב הגולגולת, לא כדור.
        // אשכול כדורים אחידים נראה כמו פאה; קשתות בגדלים ובכיוונים משתנים
        // נותנות את מסת התלתלים הרופפת שברפרנס.
        const d = V(lx, ly, lz).normalize();
        let tang = new THREE.Vector3().crossVectors(d, V(0, 1, 0));
        if (tang.lengthSq() < 0.05) tang.set(1, 0, 0);
        tang.normalize();
        const bend = (rand() - 0.5) * 2;
        const len = R * (0.30 + rand() * 0.18);
        const thick = 0.135 + rand() * 0.065;

        g.add(sweep(hairMat, [
          V(px, py, pz),
          V(px + d.x * len * 0.55 + tang.x * len * 0.5 * bend,
            py + d.y * len * 0.55 + tang.y * len * 0.5 * bend + len * 0.12,
            pz + d.z * len * 0.55 + tang.z * len * 0.5 * bend),
          V(px + d.x * len * 0.55 + tang.x * len * 1.15 * bend,
            py + d.y * len * 0.30 + tang.y * len * 1.15 * bend - len * 0.20,
            pz + d.z * len * 0.55 + tang.z * len * 1.15 * bend),
        ], [
          pr(0, thick * 0.85, thick * 0.85), pr(0.45, thick, thick), pr(1, thick * 0.62, thick * 0.62),
        ], { steps: 10, radial: 14, capStart: 'round', capEnd: 'round', domeScale: 0.9 }));
      }
    }
  });

  return g;
}
