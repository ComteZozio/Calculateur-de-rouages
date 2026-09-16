/**
 * perpetual-render.js
 * Dessin SVG du quantieme perpetuel, vu cote cadran.
 *
 * Chaque piece mobile est dessinee UNE fois, dans sa pose de reference, a
 * l'interieur d'un groupe qui porte son centre de rotation. L'animation ne
 * fait ensuite que poser des transformations (updatePerpetualSVG) : les
 * ressorts et les sautoirs, qui se deforment, sont les seuls traces
 * recalcules a chaque image.
 */

const PERP_COLORS = {
  plate: "#8b8578",
  wheel: "#b4884b",
  star: "#2b4c6f",
  cam: "#8a6b2b",
  program: "#6f4c2b",
  grandLever: "#7a4c6f",
  bascule: "#3f6f7a",
  monthLever: "#4c6f4a",
  sautoir: "#5a4c8a",
  spring: "#9c3b34",
  pin: "#9c3b34",
  dial: "#fdfcf8",
  ink: "#21252b",
};

function perpToPx(plateRadius, scale, margin) {
  const c = (plateRadius + margin) * scale;
  return (x, y) => [c + x * scale, c + y * scale];
}

function perpF(v) {
  return v.toFixed(2);
}

function perpPathFromPoints(points, toPx, close = true) {
  const parts = points.map((p) => {
    const [x, y] = toPx(p.x, p.y);
    return `${perpF(x)} ${perpF(y)}`;
  });
  return `M ${parts.join(" L ")}${close ? " Z" : ""}`;
}

/** Etoile a denture triangulaire ; les creux tombent a sigma + j.pas. */
function perpStarPath(center, star, sigma, toPx) {
  const pts = [];
  for (let j = 0; j < star.teeth; j++) {
    const gap = sigma + j * star.pitch;
    pts.push(perpPolar(center, star.root, gap));
    pts.push(perpPolar(center, star.tip, gap + star.pitch / 2));
  }
  return perpPathFromPoints(pts, toPx);
}

function perpLocalPath(center, localPoints, toPx) {
  return perpPathFromPoints(
    localPoints.map((p) => ({ x: center.x + p.x, y: center.y + p.y })),
    toPx
  );
}

function perpLine(a, b, width, color, toPx, opacity = 0.85) {
  const [x1, y1] = toPx(a.x, a.y);
  const [x2, y2] = toPx(b.x, b.y);
  return (
    `<line x1="${perpF(x1)}" y1="${perpF(y1)}" x2="${perpF(x2)}" y2="${perpF(y2)}" stroke="${color}" stroke-width="${perpF(width)}" stroke-linecap="round" opacity="${opacity}"/>` +
    `<line x1="${perpF(x1)}" y1="${perpF(y1)}" x2="${perpF(x2)}" y2="${perpF(y2)}" stroke="${PERP_COLORS.ink}" stroke-width="0.5" opacity="0.35"/>`
  );
}

function perpCircle(c, r, toPx, attrs) {
  const [x, y] = toPx(c.x, c.y);
  return `<circle cx="${perpF(x)}" cy="${perpF(y)}" r="${perpF(r)}" ${attrs}/>`;
}

/** Ligne brisee, meme trait que perpLine. */
function perpPolyline(points, width, color, toPx, opacity = 0.85) {
  const d = perpPathFromPoints(points, toPx, false);
  return (
    `<path d="${d}" fill="none" stroke="${color}" stroke-width="${perpF(width)}" stroke-linecap="round" stroke-linejoin="round" opacity="${opacity}"/>` +
    `<path d="${d}" fill="none" stroke="${PERP_COLORS.ink}" stroke-width="0.5" stroke-linejoin="round" opacity="0.35"/>`
  );
}

/**
 * Trace du bras d'un levier, de son pivot P a l'extremite E, dans la pose de
 * reference. Pendant la course, le levier tourne de `sweep` = [min, max]
 * radians autour de cette pose : vu depuis le levier, chaque arbre d'aiguille
 * decrit un petit arc autour de P. Si le bras droit croiserait cet arc, on le
 * decoupe pour le contourner -- sur un vrai levier, seules les extremites
 * comptent pour la cinematique.
 */
function perpArmPoints(P, E, sweep, arbors, clearance) {
  const reach = perpDist(P, E);
  for (const A of arbors) {
    const rho = perpDist(P, A);
    if (rho < clearance || rho > reach + clearance) continue;
    const base = perpAngleTo(P, A);
    const blocked = [0, 0.25, 0.5, 0.75, 1].some((u) => {
      const at = perpPolar(P, rho, base - perpMix(sweep[0], sweep[1], u));
      return perpSegmentDistance(P, E, at) < clearance && perpDist(E, at) >= clearance;
    });
    if (!blocked) continue;
    // arc occupe par l'arbre, vu du levier, elargi de la garde
    const margin = clearance / rho + 0.08;
    const lo = base - sweep[1] - margin;
    const hi = base - sweep[0] + margin;
    const toE = perpAngleTo(P, E);
    const side = Math.abs(perpAngleDiff(toE, lo)) < Math.abs(perpAngleDiff(toE, hi)) ? lo : hi;
    const r = Math.min(reach, rho + clearance + 0.3 * clearance);
    return [P, perpPolar(P, r, side), E];
  }
  return [P, E];
}

/** Bras de levier : droit, ou decoupe autour des arbres d'aiguilles. */
function perpArm(P, E, sweep, model, width, color, toPx) {
  const c = model.centers;
  const points = perpArmPoints(P, E, sweep, [c.O, c.D, c.W, c.M, c.G], model.dim.arborClearance);
  return points.length === 2 ? perpLine(P, E, width, color, toPx) : perpPolyline(points, width, color, toPx);
}

/** Pivot visse dans la platine : il ne tourne pas, on le dessine a part. */
function perpPivot(c, scale, k, color, toPx) {
  const r = Math.max(2.5, 0.28 * k * scale);
  return perpCircle(c, r, toPx, `fill="#fdfcf8" stroke="${color}" stroke-width="1.4"`) + perpCircle(c, r * 0.35, toPx, `fill="${color}"`);
}

/** Petit bec triangulaire (cliquet, bec de levier), pointe vers `dir`. */
function perpBeak(tip, dir, size, color, toPx) {
  const back = perpPolar(tip, size, dir + Math.PI);
  const a = perpPolar(back, size * 0.45, dir + Math.PI / 2);
  const b = perpPolar(back, size * 0.45, dir - Math.PI / 2);
  return `<path d="${perpPathFromPoints([tip, a, b], toPx)}" fill="${color}" fill-opacity="0.9" stroke="${color}" stroke-width="0.8" stroke-linejoin="round"/>`;
}

function perpRotGroup(key, ref, center, toPx, content) {
  const [cx, cy] = toPx(center.x, center.y);
  return `<g data-perp-rot="${key}" data-ref="${ref}" data-cx="${perpF(cx)}" data-cy="${perpF(cy)}">${content}</g>`;
}

function perpLabel(at, text, toPx, size, color = PERP_COLORS.ink, anchor = "start") {
  const [x, y] = toPx(at.x, at.y);
  return `<text x="${perpF(x)}" y="${perpF(y)}" text-anchor="${anchor}" font-family="'IBM Plex Mono', monospace" font-size="${perpF(size)}" fill="${color}">${text}</text>`;
}

/**
 * Ressort a lame : du plot fixe `stud` au point d'appui porte par la piece.
 * L'appui tourne avec la piece (cle `key`) : son trace est recalcule a
 * chaque image par updatePerpetualSVG.
 */
function perpSpringSVG(key, ref, center, attach, stud, toPx, scale, k) {
  const [cx, cy] = toPx(center.x, center.y);
  const [ax, ay] = toPx(attach.x, attach.y);
  const [sx, sy] = toPx(stud.x, stud.y);
  return (
    `<path data-perp-spring="${key}" data-ref="${ref}" data-cx="${perpF(cx)}" data-cy="${perpF(cy)}" data-ax="${perpF(ax)}" data-ay="${perpF(ay)}" data-sx="${perpF(sx)}" data-sy="${perpF(sy)}" ` +
    `d="" fill="none" stroke="${PERP_COLORS.spring}" stroke-width="${perpF(Math.max(1, 0.12 * k * scale))}" stroke-linecap="round" opacity="0.9"/>` +
    perpCircle(stud, Math.max(2, 0.2 * k * scale), toPx, `fill="${PERP_COLORS.spring}" opacity="0.8"`)
  );
}

/** Plot d'un ressort : a cote du point d'appui, du cote oppose a la piece. */
function perpStudFor(pivot, attach, k, side = 1) {
  const dir = perpAngleTo(pivot, attach);
  return perpPolar(attach, 1.6 * k, dir + (side * Math.PI) / 2);
}

function perpSpringPath(el, angle) {
  const cx = parseFloat(el.dataset.cx);
  const cy = parseFloat(el.dataset.cy);
  const ax0 = parseFloat(el.dataset.ax) - cx;
  const ay0 = parseFloat(el.dataset.ay) - cy;
  const c = Math.cos(angle);
  const s = Math.sin(angle);
  const ax = cx + ax0 * c - ay0 * s;
  const ay = cy + ax0 * s + ay0 * c;
  const sx = parseFloat(el.dataset.sx);
  const sy = parseFloat(el.dataset.sy);
  const mx = (ax + sx) / 2;
  const my = (ay + sy) / 2;
  const len = Math.hypot(ax - sx, ay - sy) || 1;
  // lame cintree : le controle s'ecarte de la corde
  const qx = mx - ((ay - sy) / len) * len * 0.35;
  const qy = my + ((ax - sx) / len) * len * 0.35;
  return `M ${perpF(sx)} ${perpF(sy)} Q ${perpF(qx)} ${perpF(qy)} ${perpF(ax)} ${perpF(ay)}`;
}

// ------------------------------------------------------------------
// Pieces
// ------------------------------------------------------------------

function perpBasculeSVG(key, bascule, model, toPx, scale, label, options) {
  const k = model.dim.k;
  const { drive, feeler } = bascule;
  const ref = drive.psiR;
  const tip = drive.tip(ref);
  const E = perpPolar(drive.B, feeler.La, ref + feeler.gamma);
  const color = PERP_COLORS.bascule;
  const width = Math.max(2.5, 0.35 * k * scale);
  const sweep = [Math.min(0, drive.psiE - ref), Math.max(0, drive.psiE - ref)];
  const body =
    perpArm(drive.B, tip, sweep, model, width, color, toPx) +
    perpArm(drive.B, E, sweep, model, width, color, toPx) +
    perpBeak(tip, perpAngleTo(drive.B, tip) + (drive.s * Math.PI) / 2, 0.45 * k, color, toPx) +
    perpCircle(E, Math.max(2, 0.22 * k * scale), toPx, `fill="#fdfcf8" stroke="${color}" stroke-width="1.2"`);
  const attach = perpPolar(drive.B, feeler.La * 0.55, ref + feeler.gamma);
  return (
    perpRotGroup(key, ref, drive.B, toPx, body) +
    perpSpringSVG(key, ref, drive.B, attach, perpStudFor(drive.B, attach, k, -drive.s), toPx, scale, k) +
    perpPivot(drive.B, scale, k, color, toPx) +
    (options.showLabels ? perpLabel(perpPolar(drive.B, 0.6 * k, -Math.PI / 2), label, toPx, Math.max(8, 0.55 * k * scale), color) : "")
  );
}

function perpMonthLeverSVG(model, toPx, scale, options) {
  const k = model.dim.k;
  const ml = model.monthLever;
  const B = ml.drive.B;
  const ref = ml.theta(ml.windowStart);
  const color = PERP_COLORS.monthLever;
  const width = Math.max(2.5, 0.35 * k * scale);
  const forkEnd = perpPolar(B, ml.forkLength, ref);
  const psi = ref + ml.delta;
  const tip = ml.drive.tip(psi);
  const tine = 0.35 * k;
  const swing = ml.theta(ml.windowEnd) - ref;
  const sweep = [Math.min(0, swing), Math.max(0, swing)];
  const body =
    perpArm(B, forkEnd, sweep, model, width, color, toPx) +
    perpLine(perpPolar(forkEnd, tine, ref + Math.PI / 2), perpPolar(forkEnd, tine, ref - Math.PI / 2), width * 0.7, color, toPx) +
    perpArm(B, tip, sweep, model, width, color, toPx) +
    perpBeak(tip, perpAngleTo(B, tip) + (ml.drive.s * Math.PI) / 2, 0.45 * k, color, toPx);
  const attach = perpPolar(B, ml.drive.Lp * 0.6, psi);
  return (
    perpRotGroup("monthLever", ref, B, toPx, body) +
    perpSpringSVG("monthLever", ref, B, attach, perpStudFor(B, attach, k, -ml.drive.s), toPx, scale, k) +
    perpPivot(B, scale, k, color, toPx) +
    (options.showLabels ? perpLabel(perpPolar(B, 0.6 * k, -Math.PI / 2), "levier des mois", toPx, Math.max(8, 0.55 * k * scale), color) : "")
  );
}

/** Doigt des mois, dessine dans le repere de la roue de quantieme (au 1). */
function perpMonthFingerSVG(model, toPx, scale) {
  const k = model.dim.k;
  const finger = model.monthFinger;
  const D = model.centers.D;
  const tip = perpPolar(D, finger.rF, finger.zeta);
  const color = PERP_COLORS.monthLever;
  return perpLine(D, tip, Math.max(2, 0.3 * k * scale), color, toPx) + perpCircle(tip, Math.max(2, 0.2 * k * scale), toPx, `fill="${color}"`);
}

function perpGrandLeverSVG(model, toPx, scale, options) {
  const k = model.dim.k;
  const gl = model.grandLever;
  const P = gl.P;
  const ref = gl.thetaOf(30);
  const color = PERP_COLORS.grandLever;
  const width = Math.max(3, 0.45 * k * scale);
  const forkEnd = perpPolar(P, gl.forkLength, ref);
  const becTip = perpPolar(P, gl.bec.La, ref + gl.bec.gamma);
  const lifter = perpPolar(P, gl.lift.La, ref + gl.lift.gamma);
  // course du levier autour de la pose de reference, pour decouper les bras
  const ends = [model.thresholds.lowP, model.thresholds.topP].map((p) => gl.thetaOf(p) - ref);
  const sweep = [Math.min(...ends), Math.max(...ends)];
  // grande bascule d'une montre : ses cliquets de quantieme et des jours
  let pawls = "";
  for (const pawl of Object.values(gl.pawls ?? {})) {
    const tip = pawl.drive.tip(ref + pawl.gamma);
    pawls += perpArm(P, tip, sweep, model, width * 0.75, color, toPx) + perpBeak(tip, perpAngleTo(P, tip) + (pawl.drive.s * Math.PI) / 2, 0.45 * k, color, toPx);
  }
  const body =
    pawls +
    perpArm(P, forkEnd, sweep, model, width, color, toPx) +
    perpArm(P, becTip, sweep, model, width, color, toPx) +
    perpArm(P, lifter, sweep, model, width, color, toPx) +
    // cliquet a ressort au bout de la fourchette : il s'efface quand la
    // goupille arrive par l'arriere, et l'entraine quand le levier monte
    perpBeak(forkEnd, ref + (gl.sigma * Math.PI) / 2, 0.55 * k, PERP_COLORS.spring, toPx) +
    perpBeak(becTip, perpAngleTo(P, becTip), 0.5 * k, color, toPx) +
    perpCircle(lifter, Math.max(2, 0.25 * k * scale), toPx, `fill="#fdfcf8" stroke="${color}" stroke-width="1.3"`);
  const attach = perpPolar(P, gl.forkLength * 0.5, ref);
  // goupilles de degagement : fixes, elles tiennent les cliquets hors de la
  // denture tant que la bascule n'a pas depasse le repos le plus haut
  let studs = "";
  for (const pawl of Object.values(gl.pawls ?? {})) {
    const C = pawl.drive.center;
    const released = pawl.drive.tip(gl.thetaOf(pawl.cBank) + pawl.gamma);
    const star = C === model.centers.D ? model.dim.date : model.dim.day;
    studs += perpCircle(perpPolar(C, star.tip + 0.35 * k, perpAngleTo(C, released)), Math.max(1.8, 0.17 * k * scale), toPx, `fill="${PERP_COLORS.ink}" opacity="0.75"`);
  }
  return (
    studs +
    perpRotGroup("grandLever", ref, P, toPx, body) +
    perpSpringSVG("grandLever", ref, P, attach, perpStudFor(P, attach, k, -gl.sigma), toPx, scale, k) +
    perpPivot(P, scale, k, color, toPx) +
    (options.showLabels ? perpLabel(perpPolar(P, 0.7 * k, -Math.PI / 2), gl.pawls ? "grande bascule" : "grand levier", toPx, Math.max(8, 0.6 * k * scale), color) : "")
  );
}

function perpSautoirSVG(key, center, star, sautoir, model, toPx, scale) {
  const k = model.dim.k;
  const color = PERP_COLORS.sautoir;
  const beak = perpPolar(center, star.root, sautoir.sigma);
  const width = Math.max(2, 0.28 * k * scale);
  const body = perpLine(sautoir.pivot, beak, width, color, toPx) + perpBeak(beak, sautoir.sigma + Math.PI, 0.4 * k, color, toPx);
  const [px, py] = toPx(sautoir.pivot.x, sautoir.pivot.y);
  const attach = perpMix(sautoir.pivot.x, beak.x, 0.6);
  const attachPoint = { x: attach, y: perpMix(sautoir.pivot.y, beak.y, 0.6) };
  return (
    `<g data-perp-sautoir="${key}" data-cx="${perpF(px)}" data-cy="${perpF(py)}">${body}</g>` +
    perpSpringSVG(`sautoir-${key}`, 0, sautoir.pivot, attachPoint, perpStudFor(sautoir.pivot, attachPoint, k, sautoir.side), toPx, scale, k) +
    perpPivot(sautoir.pivot, scale, k, color, toPx)
  );
}

/** Angle d'un sautoir : son bec monte sur la pointe de la dent qui passe. */
function perpSautoirAngle(center, star, sautoir, position) {
  const frac = position - Math.floor(position);
  const r = star.root + (star.tip - star.root) * (1 - Math.abs(1 - 2 * frac));
  const now = perpPolar(center, r, sautoir.sigma);
  const rest = perpPolar(center, star.root, sautoir.sigma);
  return perpAngleDiff(perpAngleTo(sautoir.pivot, now), perpAngleTo(sautoir.pivot, rest));
}

// ------------------------------------------------------------------
// Cadran
// ------------------------------------------------------------------

function perpSubdialSVG(center, radius, labels, angleOf, toPx, scale, k) {
  const [cx, cy] = toPx(center.x, center.y);
  const size = Math.max(6, Math.min(0.5 * k * scale, (radius * scale * 2 * Math.PI) / labels.length / 1.9));
  // cadran translucide : il doit laisser voir l'etoile et le sautoir dessous
  let out = `<circle cx="${perpF(cx)}" cy="${perpF(cy)}" r="${perpF(radius * scale)}" fill="${PERP_COLORS.dial}" fill-opacity="0.3" stroke="${PERP_COLORS.plate}" stroke-width="1"/>`;
  labels.forEach((text, i) => {
    const at = perpPolar(center, radius * 0.8, angleOf(i));
    const [x, y] = toPx(at.x, at.y);
    out += `<text x="${perpF(x)}" y="${perpF(y + size * 0.35)}" text-anchor="middle" font-family="'IBM Plex Mono', monospace" font-size="${perpF(size)}" fill="${PERP_COLORS.ink}">${text}</text>`;
  });
  return out;
}

// ------------------------------------------------------------------
// Assemblage
// ------------------------------------------------------------------

function renderPerpetualSVG(model, options) {
  const { plateRadius, scale, margin } = options;
  const toPx = perpToPx(plateRadius, scale, margin);
  const dim = model.dim;
  const k = dim.k;
  const { O, H, D, W, M, G } = model.centers;
  const sizePx = (plateRadius + margin) * 2 * scale;
  const parts = [`<svg xmlns="http://www.w3.org/2000/svg" width="${sizePx.toFixed(0)}" height="${sizePx.toFixed(0)}" viewBox="0 0 ${sizePx.toFixed(0)} ${sizePx.toFixed(0)}">`];

  parts.push(perpCircle(O, plateRadius * scale, toPx, `fill="none" stroke="${PERP_COLORS.plate}" stroke-width="1.5" stroke-dasharray="6,4"`));

  // roue programme et sa came (au-dessous de l'etoile des mois)
  const programWheel = new Wheel("programme", dim.program.teeth, dim.program.module, "G");
  parts.push(
    perpRotGroup(
      "program",
      0,
      G,
      toPx,
      `<path d="${gearPath(G.x, G.y, programWheel, model.phases.program, toPx)}" fill="${PERP_COLORS.program}" fill-opacity="0.1" stroke="${PERP_COLORS.program}" stroke-width="0.9"/>` +
        `<path d="${perpLocalPath(G, perpProgramCamProfile(model), toPx)}" fill="${PERP_COLORS.cam}" fill-opacity="0.3" stroke="${PERP_COLORS.cam}" stroke-width="1.2" stroke-linejoin="round"/>` +
        (options.showDial ? handSVG(...toPx(G.x, G.y), 1.6 * k * scale) : "")
    )
  );

  // roue des heures et roue de 24 h avec ses cames (trois pour la pendule,
  // le seul limacon pour la montre)
  const hourWheel = new Wheel("heures", dim.hourWheel.teeth, dim.hourWheel.module, "O");
  const wheel24 = new Wheel("24h", dim.wheel24.teeth, dim.wheel24.module, "H");
  parts.push(
    perpRotGroup(
      "hour",
      0,
      O,
      toPx,
      `<path d="${gearPath(O.x, O.y, hourWheel, model.phases.hour, toPx)}" fill="${PERP_COLORS.wheel}" fill-opacity="0.15" stroke="${PERP_COLORS.wheel}" stroke-width="1"/>`
    )
  );
  parts.push(
    perpRotGroup(
      "wheel24",
      0,
      H,
      toPx,
      `<path d="${gearPath(H.x, H.y, wheel24, model.phases.wheel24, toPx)}" fill-rule="evenodd" fill="${PERP_COLORS.wheel}" fill-opacity="0.12" stroke="${PERP_COLORS.wheel}" stroke-width="1"/>` +
        `<path d="${perpLocalPath(H, perpSnailProfile(model, 360), toPx)}" fill="${PERP_COLORS.grandLever}" fill-opacity="0.12" stroke="${PERP_COLORS.grandLever}" stroke-width="1.1"/>` +
        (model.dateBascule
          ? `<path d="${perpLocalPath(H, perpBasculeCamProfile(model, model.dateBascule, 360), toPx)}" fill="none" stroke="${PERP_COLORS.bascule}" stroke-width="1.1"/>` +
            `<path d="${perpLocalPath(H, perpBasculeCamProfile(model, model.dayBascule, 360), toPx)}" fill="none" stroke="${PERP_COLORS.bascule}" stroke-width="1.1" stroke-dasharray="3,2"/>`
          : "")
    )
  );

  // etoiles
  const pinR = Math.max(2, 0.22 * k * scale);
  parts.push(
    perpRotGroup(
      "date",
      0,
      D,
      toPx,
      `<path d="${perpStarPath(D, dim.date, model.sautoirs.date.sigma, toPx)}" fill="${PERP_COLORS.star}" fill-opacity="0.16" stroke="${PERP_COLORS.star}" stroke-width="1.1" stroke-linejoin="round"/>` +
        perpCircle(perpPolar(D, dim.date.pin, model.grandLever.zeta), pinR, toPx, `fill="${PERP_COLORS.grandLever}"`) +
        (model.monthFinger
          ? perpMonthFingerSVG(model, toPx, scale)
          : perpCircle(perpPolar(D, dim.date.monthPin, model.monthLever.zeta), pinR, toPx, `fill="${PERP_COLORS.monthLever}"`))
    )
  );
  parts.push(
    perpRotGroup(
      "day",
      0,
      W,
      toPx,
      `<path d="${perpStarPath(W, dim.day, model.sautoirs.day.sigma, toPx)}" fill="${PERP_COLORS.star}" fill-opacity="0.16" stroke="${PERP_COLORS.star}" stroke-width="1.1" stroke-linejoin="round"/>`
    )
  );
  const pinion = new Wheel("pignon", dim.monthPinion.teeth, dim.monthPinion.module, "M");
  parts.push(
    perpRotGroup(
      "month",
      0,
      M,
      toPx,
      `<path d="${gearPath(M.x, M.y, pinion, model.phases.pinion, toPx)}" fill="none" stroke="${PERP_COLORS.program}" stroke-width="0.8" stroke-dasharray="2,2"/>` +
        `<path d="${perpStarPath(M, dim.month, model.sautoirs.month.sigma, toPx)}" fill="${PERP_COLORS.star}" fill-opacity="0.16" stroke="${PERP_COLORS.star}" stroke-width="1.1" stroke-linejoin="round"/>`
    )
  );
  for (const c of [O, H, D, W, M, G]) parts.push(perpCircle(c, Math.max(1.5, 0.18 * k * scale), toPx, `fill="${PERP_COLORS.ink}" opacity="0.7"`));

  // leviers, sautoirs, ressorts
  if (model.dateBascule) {
    parts.push(perpBasculeSVG("dateBascule", model.dateBascule, model, toPx, scale, "bascule de quantième", options));
    parts.push(perpBasculeSVG("dayBascule", model.dayBascule, model, toPx, scale, "bascule de semaine", options));
  }
  if (model.monthLever) parts.push(perpMonthLeverSVG(model, toPx, scale, options));
  parts.push(perpGrandLeverSVG(model, toPx, scale, options));
  parts.push(perpSautoirSVG("date", D, dim.date, model.sautoirs.date, model, toPx, scale));
  parts.push(perpSautoirSVG("day", W, dim.day, model.sautoirs.day, model, toPx, scale));
  parts.push(perpSautoirSVG("month", M, dim.month, model.sautoirs.month, model, toPx, scale));

  // cadran et aiguilles
  if (options.showDial) {
    const top = -Math.PI / 2;
    parts.push(perpSubdialSVG(D, dim.date.tip + 1.1 * k, Array.from({ length: 31 }, (_, i) => i + 1), (i) => top + i * dim.date.pitch, toPx, scale, k));
    parts.push(perpSubdialSVG(W, dim.day.tip + 1.2 * k, PERP_DAY_LABELS, (i) => top + i * dim.day.pitch, toPx, scale, k));
    // cadran des mois gradue a rebours quand l'etoile tourne a rebours
    const monthSense = model.monthSense ?? 1;
    parts.push(perpSubdialSVG(M, dim.month.tip + 1.2 * k, PERP_MONTH_LABELS, (i) => top + monthSense * i * dim.month.pitch, toPx, scale, k));
    // petit cadran du cycle bissextile, assez etroit pour laisser voir la
    // came programme qui tourne sous lui
    parts.push(perpSubdialSVG(G, 0.6 * k, ["B", "1", "2", "3"], (i) => top - (monthSense * i * Math.PI) / 2, toPx, scale, 0.5 * k));
    for (const [key, c, len] of [
      ["date", D, dim.date.tip + 0.5 * k],
      ["day", W, dim.day.tip + 0.6 * k],
      ["month", M, dim.month.tip + 0.6 * k],
      ["program", G, 0.5 * k],
    ]) {
      const [hx, hy] = toPx(c.x, c.y);
      parts.push(perpRotGroup(key, 0, c, toPx, handSVG(hx, hy, len * scale)));
    }
  }

  if (options.showLabels) {
    const size = Math.max(8, 0.6 * k * scale);
    // au-dessus ou au-dessous de la roue de 24 h, du cote oppose au centre :
    // de l'autre cote on tomberait sur la roue des heures
    const away = H.y <= 0 ? -1 : 1;
    const labelY = H.y + away * (perpTipRadius(dim.wheel24) + (away < 0 ? 0.4 : 1.0) * k);
    parts.push(perpLabel({ x: H.x, y: labelY }, "roue de 24 h", toPx, size, PERP_COLORS.wheel, "middle"));
    parts.push(perpLabel({ x: G.x, y: G.y + perpTipRadius(dim.program) + 0.9 * k }, "came programme 48 mois", toPx, size, PERP_COLORS.program, "middle"));
  }

  parts.push("</svg>");
  return { svgMarkup: parts.join(""), sizePx };
}

/** Pose chaque piece mobile a la position de `pose`. */
function updatePerpetualSVG(root, model, pose) {
  if (!root) return;
  const angles = pose.angles;
  const deg = (rad) => ((rad * 180) / Math.PI) % 360;
  root.querySelectorAll("[data-perp-rot]").forEach((el) => {
    const a = angles[el.dataset.perpRot];
    if (a === undefined) return;
    el.setAttribute("transform", `rotate(${deg(a - parseFloat(el.dataset.ref)).toFixed(3)} ${el.dataset.cx} ${el.dataset.cy})`);
  });

  const dim = model.dim;
  const { D, W, M } = model.centers;
  const sautoirAngles = {
    date: perpSautoirAngle(D, dim.date, model.sautoirs.date, pose.p),
    day: perpSautoirAngle(W, dim.day, model.sautoirs.day, pose.w),
    month: perpSautoirAngle(M, dim.month, model.sautoirs.month, pose.k),
  };
  root.querySelectorAll("[data-perp-sautoir]").forEach((el) => {
    const a = sautoirAngles[el.dataset.perpSautoir] ?? 0;
    el.setAttribute("transform", `rotate(${deg(a).toFixed(3)} ${el.dataset.cx} ${el.dataset.cy})`);
  });

  root.querySelectorAll("[data-perp-spring]").forEach((el) => {
    const key = el.dataset.perpSpring;
    let a = 0;
    if (key.startsWith("sautoir-")) a = sautoirAngles[key.slice(8)] ?? 0;
    else if (angles[key] !== undefined) a = angles[key] - parseFloat(el.dataset.ref);
    el.setAttribute("d", perpSpringPath(el, a));
  });
}
