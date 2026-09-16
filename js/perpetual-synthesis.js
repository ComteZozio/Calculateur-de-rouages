/**
 * perpetual-synthesis.js
 * Synthese geometrique du quantieme perpetuel a partir des positions
 * d'affichage choisies.
 *
 * Les affichages imposent les axes des trois etoiles (quantieme, jours,
 * mois). Tout le reste en decoule : la roue de 24 h se loge a cote de la
 * roue des heures, la roue programme autour de l'etoile des mois, puis
 * chaque levier recoit un pivot et des bras qui relient ce qu'il doit
 * relier. Rien n'est dessine « a peu pres » : chaque pivot est cherche de
 * facon que la course du cliquet fasse EXACTEMENT une dent, et chaque came
 * est taillee depuis la position que doit prendre le levier qui la lit.
 *
 * Les leviers sont supposes etages : un bras peut passer au-dessus d'une
 * roue, un pivot ne peut pas tomber sur une piece qui tourne.
 *
 * Deux constructions (voir perpetual-calendar.js) : la PENDULE, a bascules
 * separees, et la MONTRE, ou une grande bascule unique porte les cliquets de
 * quantieme et des jours en plus du crochet de fin de mois.
 */

function perpObstacle(name, center, radius) {
  return { name, x: center.x, y: center.y, r: radius };
}

/** Le disque (point, radius) est-il degage de tous les obstacles ? */
function perpPointClear(point, radius, obstacles, ignore = []) {
  return obstacles.every((o) => ignore.includes(o.name) || Math.hypot(point.x - o.x, point.y - o.y) >= radius + o.r);
}

function perpInPlate(point, radius, plateRadius, margin) {
  return Math.hypot(point.x, point.y) + radius <= plateRadius - margin + 1e-9;
}

function perpFarFromPivots(point, pivots, min) {
  return pivots.every((q) => perpDist(point, q) >= min);
}

/** Distance du point C au segment [A, B]. */
function perpSegmentDistance(A, B, C) {
  const vx = B.x - A.x;
  const vy = B.y - A.y;
  const len2 = vx * vx + vy * vy;
  const t = len2 > 0 ? perpClamp01(((C.x - A.x) * vx + (C.y - A.y) * vy) / len2) : 0;
  return Math.hypot(A.x + t * vx - C.x, A.y + t * vy - C.y);
}

// ------------------------------------------------------------------
// Cliquet pousse-etoile
// ------------------------------------------------------------------

/**
 * Cinematique exacte d'un cliquet pivote en B, de longueur Lp, qui pousse
 * une dent de l'etoile de centre C. Le bec decrit un arc autour de B ;
 * l'etoile tourne de l'angle polaire que ce bec balaie autour de C. La
 * course est resolue pour valoir une dent, ni plus ni moins -- le sautoir
 * n'a alors qu'a tenir l'etoile, pas a rattraper un saut incomplet.
 */
function perpPawlDrive(C, star, B, Lp) {
  const psiMid = perpAngleTo(B, C);
  const tip = (psi) => perpPolar(B, Lp, psi);
  const polar = (psi) => perpAngleTo(C, tip(psi));
  const s = perpAngleDiff(polar(psiMid + 1e-4), polar(psiMid)) > 0 ? 1 : -1;
  const span = (delta) => perpAngleDiff(polar(psiMid + (s * delta) / 2), polar(psiMid - (s * delta) / 2));
  const upper = Math.min(1.6, (2.5 * star.pitch * star.engage) / Lp);
  const delta = perpSolve(span, star.pitch, 1e-6, upper);
  if (delta === null) return null;

  const psiS = psiMid - (s * delta) / 2;
  const psiE = psiMid + (s * delta) / 2;
  // le bec doit rester dans la denture tout au long de la course
  for (const psi of [psiS, psiE]) {
    const r = perpDist(C, tip(psi));
    if (r > star.tip || r < star.root) return null;
  }
  const polarS = polar(psiS);
  return {
    center: C,
    B,
    Lp,
    s,
    delta,
    psiMid,
    psiS,
    psiE,
    // au repos le bec se tient en retrait de la dent qu'il poussera
    psiR: psiS - s * 0.3 * delta,
    tauStart: polarS,
    tip,
    progress: (psi) => perpClamp01(perpAngleDiff(polar(psi), polarS) / star.pitch),
  };
}

function perpPawlCandidates(C, star, dim, plateRadius, obstacles, pivots) {
  const out = [];
  const lengths = [1.2, 1.7, 2.3, 3.0, 3.8, 4.8, 6.0, 7.5, 9.0].map((v) => v * dim.k);
  for (let i = 0; i < 72; i++) {
    const tau = (i * 2 * Math.PI) / 72;
    for (const Lp of lengths) {
      const B = perpPolar(C, star.engage + Lp, tau);
      if (!perpInPlate(B, 0, plateRadius, 0.6 * dim.k)) continue;
      if (!perpPointClear(B, dim.pivotClearance, obstacles)) continue;
      if (!perpFarFromPivots(B, pivots, 0.9 * dim.k)) continue;
      const drive = perpPawlDrive(C, star, B, Lp);
      if (drive) out.push(drive);
    }
  }
  return out;
}

// ------------------------------------------------------------------
// Bascules de quantieme et de semaine
// ------------------------------------------------------------------

/**
 * Bascule menee par une came de la roue de 24 h : un bras palpeur pose en
 * tangente sur la came, un bras cliquet sur l'etoile. La came est taillee
 * plus tard, depuis l'angle que doit prendre la bascule a chaque instant.
 */
function perpDesignBascule(C, star, H, dim, plateRadius, obstacles, pivots) {
  const RH = perpTipRadius(dim.wheel24);
  let best = null;
  for (const drive of perpPawlCandidates(C, star, dim, plateRadius, obstacles, pivots)) {
    for (const rMid of [0.45, 0.6, 0.75].map((v) => v * RH)) {
      for (const sign of [1, -1]) {
        const arm = perpTangentArm(drive.B, H, rMid, sign);
        if (!arm || arm.length > 9 * dim.k || arm.length < 0.8 * dim.k) continue;
        const gamma = arm.angle - drive.psiMid;
        const radius = (psi) => perpDist(perpPolar(drive.B, arm.length, psi + gamma), H);
        const rRest = radius(drive.psiR);
        const rTop = radius(drive.psiE);
        if (!(rTop - rRest > 0.05 * dim.k)) continue;
        if (rRest < 0.8 * dim.k || rTop > RH - 0.12 * dim.k) continue;
        // la came doit pousser tout au long de la course, jamais tirer
        let prev = rRest;
        let monotone = true;
        for (let i = 1; i <= 8; i++) {
          const r = radius(perpMix(drive.psiR, drive.psiE, i / 8));
          if (r <= prev) {
            monotone = false;
            break;
          }
          prev = r;
        }
        if (!monotone) continue;
        const score = drive.Lp + arm.length + 0.3 * Math.abs(rMid - 0.6 * RH);
        if (!best || score < best.score) {
          best = { drive, feeler: { La: arm.length, gamma, rRest, rTop, radius }, score };
        }
      }
    }
  }
  return best;
}

// ------------------------------------------------------------------
// Sautoirs
// ------------------------------------------------------------------

/**
 * Sautoir : un bec loge dans un creux de l'etoile, porte par un bras
 * pivote et appuye par un ressort. Le creux qu'il occupe au repos fixe le
 * calage de la denture : il doit se trouver a un nombre entier de pas du
 * flanc que pousse le cliquet, sans quoi le bec du cliquet tomberait sur
 * une pointe.
 */
function perpDesignSautoir(C, star, drive, dim, plateRadius, obstacles, pivots, sense = 1) {
  let best = null;
  const pawlTip = drive.tip(drive.psiMid);
  for (let j = 0; j < star.teeth; j++) {
    // `sense` : -1 pour une etoile poussee a rebours (dent en avant de l'autre cote)
    const sigma = drive.tauStart - sense * (j + 0.25) * star.pitch;
    if (Math.abs(perpAngleDiff(sigma, drive.tauStart)) < 0.7) continue;
    for (const side of [1, -1]) {
      const base = perpPolar(C, star.tip + 0.45 * dim.k, sigma);
      const pivot = perpPolar(base, 1.8 * dim.k, sigma + (side * Math.PI) / 2);
      if (!perpInPlate(pivot, 0, plateRadius, 0.5 * dim.k)) continue;
      if (!perpPointClear(pivot, dim.pivotClearance, obstacles)) continue;
      const room = Math.min(perpDist(pivot, pawlTip), ...pivots.map((q) => perpDist(pivot, q)), 99);
      if (room < 0.9 * dim.k) continue;
      if (!best || room > best.room) best = { sigma, pivot, side, room };
    }
  }
  return best;
}

// ------------------------------------------------------------------
// Levier des mois
// ------------------------------------------------------------------

/**
 * Levier des mois : une fourchette que vient pousser la goupille des mois
 * de l'etoile de quantieme au passage du 31 au 1, et un cliquet qui avance
 * l'etoile des mois d'une dent. La position angulaire de la goupille sur
 * l'etoile est libre : elle est choisie pour que la fourchette la recoive
 * de face.
 */
function perpDesignMonthLever(D, M, dim, plateRadius, obstacles, pivots) {
  const rF = dim.date.monthPin;
  const pitchD = dim.date.pitch;
  const a = PERP_MONTH_WINDOW_START;
  const samples = Array.from({ length: 15 }, (_, i) => 31.0 + i / 14);
  let best = null;

  for (const drive of perpPawlCandidates(M, dim.month, dim, plateRadius, obstacles, pivots)) {
    for (let zi = 0; zi < 72; zi++) {
      const zeta = (zi * 2 * Math.PI) / 72;
      const pinAt = (p) => perpPolar(D, rF, zeta + (p - 1) * pitchD);
      const ref = perpAngleTo(drive.B, pinAt(31.5));
      const theta = (p) => ref + perpAngleDiff(perpAngleTo(drive.B, pinAt(p)), ref);

      let ok = true;
      let minEff = 1;
      let maxLen = 0;
      let prev = null;
      for (const p of samples) {
        const pin = pinAt(p);
        const len = perpDist(drive.B, pin);
        if (len < 0.6 * dim.k || len > 5 * dim.k) {
          ok = false;
          break;
        }
        // Efficacite : la fourchette pousse perpendiculairement a elle-meme,
        // la goupille se deplace sur la tangente a son cercle. Le rendement
        // est le sinus de l'angle entre fourchette et tangente, c'est-a-dire
        // le cosinus de l'angle entre fourchette et rayon de l'etoile.
        const ang = zeta + (p - 1) * pitchD;
        const eff = Math.abs(((pin.x - drive.B.x) * Math.cos(ang) + (pin.y - drive.B.y) * Math.sin(ang)) / len);
        minEff = Math.min(minEff, eff);
        maxLen = Math.max(maxLen, len);
        const t = theta(p);
        if (prev !== null && (t - prev) * drive.s <= 0) {
          ok = false;
          break;
        }
        prev = t;
      }
      if (!ok || minEff < 0.45) continue;

      const delta = drive.psiS - theta(a);
      const pEnd = perpSolve((p) => drive.s * (theta(p) - theta(a)), drive.delta, a, PERP_MONTH_WINDOW_MAX);
      if (pEnd === null) continue;
      const pHalf = perpSolve((p) => drive.progress(theta(p) + delta), 0.5, a, pEnd);
      if (pHalf === null || pHalf < 31 + PERP_REST_OFFSET + 0.1) continue;

      const score = drive.Lp + maxLen + 3 * (1 - minEff) + (pEnd > 31.85 ? 1 : 0);
      if (!best || score < best.score) {
        best = { drive, zeta, delta, theta, windowStart: a, windowEnd: pEnd, half: pHalf, forkLength: maxLen + 0.35 * dim.k, score };
      }
    }
  }
  return best;
}

// ------------------------------------------------------------------
// Doigt des mois (construction de montre)
// ------------------------------------------------------------------

/**
 * Doigt des mois : fixe sur la roue de quantieme, il mene directement
 * l'etoile des mois, sans levier. Son bout decrit un cercle autour de l'axe
 * du quantieme et ne traverse la denture des mois que sur un petit arc, cale
 * sur le passage du 31 au 1 : il y pousse une dent, puis en ressort avant
 * que le quantieme n'atteigne le 1 -- le sautoir du quantieme peut alors
 * achever son saut sans ramener le doigt dans la denture.
 *
 * Le doigt attaque l'etoile par le cote tourne vers le quantieme. Il ne peut
 * pas aller la chercher au-dela de son centre : en tournant, il heurterait
 * l'arbre de l'aiguille des mois. Comme deux roues qui engrenent, l'etoile
 * des mois tourne donc a l'inverse du quantieme, et son cadran se gradue a
 * rebours.
 *
 * `avoid` : points { x, y, r } dont le cercle du doigt doit s'ecarter
 * (arbres d'aiguilles, pivots). Retourne null si l'etoile est hors de portee.
 */
function perpDesignMonthFinger(D, M, dim, plateRadius, avoid) {
  const star = dim.month;
  const k = dim.k;
  const pitchD = dim.date.pitch;
  const d = perpDist(D, M);
  const depth = star.tip - star.root;
  const base = perpAngleTo(D, M);
  let best = null;

  for (let rF = d - star.tip + 0.02 * k; d - rF > star.root; rF += 0.02 * k) {
    if (Math.hypot(D.x, D.y) + rF > plateRadius - dim.plateMargin) continue;
    if (avoid.some((a) => Math.abs(perpDist(D, a) - rF) < a.r)) continue;
    const cosBeta = (rF * rF + d * d - star.tip * star.tip) / (2 * rF * d);
    if (!(cosBeta < 1)) continue;
    const beta = Math.acos(Math.max(-1, cosBeta));
    // arc du doigt dans la denture, dans le sens ou tourne le quantieme ;
    // u : angle polaire du bout autour de l'etoile des mois
    const N = 240;
    const th0 = perpAngleTo(M, perpPolar(D, rF, base - beta));
    const pts = [];
    for (let i = 0; i <= N; i++) {
      const psi = base - beta + (2 * beta * i) / N;
      const X = perpPolar(D, rF, psi);
      pts.push({ psi, r: perpDist(M, X), u: perpAngleDiff(perpAngleTo(M, X), th0) });
    }
    const sense = Math.sign(pts[N].u - pts[0].u);
    for (let c = 0; c < N; c++) {
      const pc = pts[c];
      if (pc.r > star.tip - 0.3 * depth || pc.r < star.root + 0.15 * depth) continue;
      // avant la dent, le doigt reste dans le creux qui la precede
      const before = Math.abs(pc.u - pts[0].u) / star.pitch;
      if (before > 0.7) break;
      // apres : une dent entiere, pas assez pour que le sautoir en prenne une seconde
      const after = Math.abs(pts[N].u - pc.u) / star.pitch;
      if (after < 1.02 || after > 1.35) continue;
      // tout le passage dans la denture tient entre le 31 et le 1
      const span = (pts[N].psi - pc.psi) / pitchD;
      if (span > 0.92) continue;
      const margin = Math.min(0.7 - before, 1.35 - after, 0.92 - span);
      if (best && margin <= best.margin + 1e-9) continue;
      best = { rF, sense, margin, span, psiC: pc.psi, tauStart: perpAngleTo(M, perpPolar(D, rF, pc.psi)) };
    }
  }
  if (!best) return null;

  const pS = 31.05 + (0.92 - best.span) / 2;
  const zeta = best.psiC - (pS - 1) * pitchD;
  const tipAt = (p) => perpPolar(D, best.rF, zeta + (p - 1) * pitchD);
  const raw = (p) => (best.sense * perpAngleDiff(perpAngleTo(M, tipAt(p)), best.tauStart)) / star.pitch;
  const pOut = pS + best.span;
  const pE = perpSolve(raw, 1, pS, pOut);
  if (pE === null) return null;
  const progressAt = (p) => (p <= pS ? 0 : p >= pE ? 1 : perpClamp01(raw(p)));
  const half = perpSolve(progressAt, 0.5, pS, pE) ?? (pS + pE) / 2;
  return {
    rF: best.rF,
    sense: best.sense,
    margin: best.margin,
    zeta,
    windowStart: pS,
    windowEnd: pE,
    windowOut: pOut,
    half,
    progressAt,
    // meme interface qu'un cliquet, pour caler le sautoir des mois
    center: M,
    tauStart: best.tauStart,
    psiMid: best.psiC,
    tip: (psi) => perpPolar(D, best.rF, psi),
  };
}

// ------------------------------------------------------------------
// Cliquets portes par la grande bascule
// ------------------------------------------------------------------

/**
 * Cliquet porte par la grande bascule (construction de montre). Son bras
 * est solidaire du levier : il tourne autour du pivot P du levier, et son
 * calage angulaire sur le levier est libre. On le cale pour que la dent
 * soit poussee tout a la fin de la levee, sur une plage que chaque mois
 * parcourt (au-dessus du repos le plus haut, celui des mois de 31 jours).
 * Plus bas, une GOUPILLE DE DEGAGEMENT fixee a la platine tient le cliquet
 * hors de la denture : sans elle, un mois court, qui leve la bascule de plus
 * loin, le ferait entrer une dent trop tot et sauter deux dents -- sur une
 * etoile a denture fine, un bec ne sort pas de lui-meme assez vite des dents.
 * La goupille le libere au-dessus du repos le plus haut, a moins d'une
 * demi-dent de la dent qu'il poussera.
 *
 * `lever` : { sigma, thetaOf } de la fourchette (angle du levier en fonction
 * de la position de goupille atteinte). `target.pin` : c'est l'etoile qui
 * porte la goupille de fin de mois, que le cliquet ne doit jamais pousser
 * au-dela du crochet un soir sans correction.
 */
function perpLeverPawl(P, target, dim, lever, spec, cache) {
  const { center: C, star } = target;
  const d = perpDist(P, C);
  const restMax = 31 + spec.restOffset;
  const cE = spec.topP - 0.1;
  let best = null;
  // bec en deca du centre de l'etoile, ou au-dela (le bras passe alors
  // au-dessus d'elle) : l'un pousse dans un sens, l'autre dans l'autre
  for (const far of [false, true]) {
    const Lp = far ? d + star.engage : d - star.engage;
    if (Lp < 0.8 * dim.k || Lp > 9 * dim.k) continue;
    const key = `${target.key}|${P.x.toFixed(4)}|${P.y.toFixed(4)}|${far}`;
    if (!cache.has(key)) cache.set(key, perpPawlDrive(C, star, P, Lp));
    const drive = cache.get(key);
    // la dent doit avancer quand la bascule MONTE
    if (!drive || drive.s !== lever.sigma) continue;

    const gamma = drive.psiE - lever.thetaOf(cE);
    const cS = perpSolve(lever.thetaOf, lever.thetaOf(cE) - drive.s * drive.delta, restMax, cE);
    if (cS === null) continue;
    const width = cE - cS;
    if (cS < restMax + Math.max(0.12, 0.25 * width)) continue;
    const progressAt = (c) => (c <= cS ? 0 : c >= cE ? 1 : drive.progress(lever.thetaOf(c) + gamma));

    const cBank = Math.max(restMax + 0.05, cS - 0.4 * width);
    let ok = true;
    for (let i = 0; i <= 24 && ok; i++) {
      const c = cBank + ((spec.topP - cBank) * i) / 24;
      const tip = drive.tip(lever.thetaOf(c) + gamma);
      if (perpDist(C, tip) >= star.tip) continue;
      const q = perpAngleDiff(perpAngleTo(C, tip), drive.tauStart) / star.pitch;
      if ((c < cS && q < -0.8) || (c > cE && q > 1.35)) ok = false;
    }
    if (!ok) continue;
    if (target.pin) {
      // le soir de l'avant-dernier jour d'un mois de 31 jours, la goupille
      // part juste sous le crochet : le cliquet ne doit pas la lui faire
      // depasser, sans quoi le crochet la rattraperait et sauterait un jour
      const before = Math.ceil(restMax) - 1;
      for (let i = 0; i <= 16 && ok; i++) {
        const c = cS + (width * i) / 16;
        if (before + progressAt(c) > c - 0.1) ok = false;
      }
      if (!ok) continue;
    }
    if (!best || Lp < best.drive.Lp) best = { drive, gamma, cS, cE, cBank, width, far, progressAt };
  }
  return best;
}

// ------------------------------------------------------------------
// Grand levier
// ------------------------------------------------------------------

/**
 * Grand levier : un pivot, trois bras.
 *   - la fourchette et son cliquet, sur la goupille de fin de mois ;
 *   - le bec, pose sur la came programme ;
 *   - le palpeur de levee, pose sur le limacon de la roue de 24 h.
 * Tout se raisonne en « position de goupille atteinte » p : la fourchette
 * fait correspondre a chaque angle du levier une position de l'etoile, et
 * les deux cames sont taillees depuis les p voulus.
 *
 * `spec` fixe la construction (plage de p, repos des mois). Avec
 * `pawlTargets`, c'est la grande bascule d'une montre : le meme levier porte
 * aussi un cliquet par etoile nommee, cale par perpLeverPawl.
 *
 * Les bras sont traites comme des segments de pivot a extremite, mais un
 * vrai levier est decoupe : la ou un bras croiserait l'arbre d'une aiguille,
 * il le contourne (voir perpArmPoints, perpetual-render.js). Seules ses
 * extremites comptent pour la cinematique.
 */
function perpDesignGrandLever(D, G, H, dim, plateRadius, obstacles, pivots, spec = PERP_KIND_SPECS.pendule, pawlTargets = null) {
  const k = dim.k;
  const rF = dim.date.pin;
  const pitchD = dim.date.pitch;
  const RG = perpTipRadius(dim.program);
  const RH = perpTipRadius(dim.wheel24);
  const samples = Array.from({ length: 12 }, (_, i) => spec.lowP + ((spec.topP - spec.lowP) * i) / 11);
  const restPs = [28, 29, 30, 31].map((L) => L + spec.restOffset);
  const pawlCache = new Map();
  const step = 0.4 * k;
  let best = null;

  for (let zi = 0; zi < 36; zi++) {
    const zeta = (zi * 2 * Math.PI) / 36;
    const pins = samples.map((p) => perpPolar(D, rF, zeta + (p - 1) * pitchD));
    const tangents = samples.map((p) => {
      const ang = zeta + (p - 1) * pitchD;
      return { x: -Math.sin(ang), y: Math.cos(ang) };
    });

    for (let gx = -plateRadius; gx <= plateRadius; gx += step) {
      for (let gy = -plateRadius; gy <= plateRadius; gy += step) {
        const P = { x: gx, y: gy };
        if (!perpInPlate(P, 0, plateRadius, 0.6 * k)) continue;
        if (!perpPointClear(P, dim.pivotClearance, obstacles)) continue;
        if (!perpFarFromPivots(P, pivots, 0.9 * k)) continue;

        let ok = true;
        let minEff = 1;
        let maxLen = 0;
        let prev = null;
        let sigma = 0;
        for (let i = 0; i < samples.length; i++) {
          const dx = pins[i].x - P.x;
          const dy = pins[i].y - P.y;
          const len = Math.hypot(dx, dy);
          if (len < 0.8 * k || len > 7 * k) {
            ok = false;
            break;
          }
          minEff = Math.min(minEff, Math.abs((dx * tangents[i].y - dy * tangents[i].x) / len));
          maxLen = Math.max(maxLen, len);
          const t = Math.atan2(dy, dx);
          if (prev !== null) {
            const d = perpAngleDiff(t, prev);
            if (sigma === 0) sigma = Math.sign(d);
            if (d * sigma <= 1e-4) {
              ok = false;
              break;
            }
          }
          prev = t;
        }
        if (!ok || minEff < 0.5 || sigma === 0) continue;

        const pinAt = (p) => perpPolar(D, rF, zeta + (p - 1) * pitchD);
        const thetaMid = perpAngleTo(P, pinAt(30));
        const thetaOf = (p) => thetaMid + perpAngleDiff(perpAngleTo(P, pinAt(p)), thetaMid);
        if (Math.abs(thetaOf(spec.topP) - thetaOf(spec.lowP)) < 0.12) continue;
        const forkLength = maxLen + 0.35 * k;
        const partial = forkLength + 4 * (1 - minEff);
        if (best && partial >= best.score) continue;

        // bec sur la came programme : le rayon croit quand le levier monte
        let bec = null;
        for (const rMid of [1.1, 1.5, 1.9].map((v) => v * k)) {
          for (const sign of [1, -1]) {
            const arm = perpTangentArm(P, G, rMid, sign);
            if (!arm || arm.length > 9 * k || arm.length < 1.2 * k) continue;
            const gamma = arm.angle - thetaMid;
            const radius = (p) => perpDist(perpPolar(P, arm.length, thetaOf(p) + gamma), G);
            const levels = restPs.map(radius);
            const top = radius(spec.topP);
            if (levels[0] < 0.6 * k || levels[3] > RG - 0.15 * k) continue;
            let spaced = true;
            for (let i = 1; i < 4; i++) if (levels[i] - levels[i - 1] < 0.07 * k) spaced = false;
            if (!spaced || top <= levels[3]) continue;
            if (!bec || arm.length < bec.La) bec = { La: arm.length, gamma, radius };
          }
        }
        if (!bec) continue;

        // palpeur de levee sur le limacon
        let lift = null;
        for (const rMid of [1.2, 1.7, 2.2].map((v) => v * k)) {
          for (const sign of [1, -1]) {
            const arm = perpTangentArm(P, H, rMid, sign);
            if (!arm || arm.length > 9 * k || arm.length < 1.0 * k) continue;
            const gamma = arm.angle - thetaMid;
            const radius = (p) => perpDist(perpPolar(P, arm.length, thetaOf(p) + gamma), H);
            const low = radius(spec.lowP);
            const top = radius(spec.topP);
            if (low < 0.6 * k || top > RH - 0.12 * k || top - low < 0.1 * k) continue;
            let monotone = true;
            let prevR = low;
            for (const p of samples.slice(1)) {
              const r = radius(p);
              if (r <= prevR) monotone = false;
              prevR = r;
            }
            if (!monotone) continue;
            if (!lift || arm.length < lift.La) lift = { La: arm.length, gamma, radius };
          }
        }
        if (!lift) continue;

        let pawls = null;
        let pawlLength = 0;
        if (pawlTargets) {
          pawls = {};
          for (const [key, target] of Object.entries(pawlTargets)) {
            const pawl = perpLeverPawl(P, { key, ...target }, dim, { sigma, thetaOf }, spec, pawlCache);
            if (!pawl) {
              pawls = null;
              break;
            }
            pawls[key] = pawl;
            pawlLength += pawl.drive.Lp;
          }
          if (!pawls) continue;
        }

        const score = partial + 0.5 * (bec.La + lift.La + pawlLength);
        if (!best || score < best.score) {
          best = { P, zeta, sigma, thetaMid, thetaOf, forkLength, minEff, bec, lift, pawls, score };
        }
      }
    }
  }
  return best;
}

// ------------------------------------------------------------------
// Assemblage
// ------------------------------------------------------------------

function perpWheelCandidates(center, distance, radius, plateRadius, dim, obstacles, stepDeg) {
  const out = [];
  for (let deg = 0; deg < 360; deg += stepDeg) {
    const c = perpPolar(center, distance, (deg * Math.PI) / 180);
    if (!perpInPlate(c, radius, plateRadius, dim.plateMargin)) continue;
    const room = Math.min(...obstacles.map((o) => Math.hypot(c.x - o.x, c.y - o.y) - o.r - radius));
    if (room < dim.clearance) continue;
    out.push({ center: c, room });
  }
  return out.sort((u, v) => v.room - u.room);
}

/**
 * Point d'entree. `config` : { plateRadius, displays: { date, day, month },
 * kind: "pendule" | "montre" }
 * (positions en mm). Retourne le modele complet, ou { ok: false, problems }.
 */
function synthesizePerpetual(config) {
  const plateRadius = config.plateRadius;
  const kind = config.kind === "montre" ? "montre" : "pendule";
  const spec = PERP_KIND_SPECS[kind];
  const dim = perpDimensions(plateRadius, kind);
  const k = dim.k;
  const O = { x: 0, y: 0 };
  const D = config.displays.date;
  const W = config.displays.day;
  const M = config.displays.month;
  const problems = [];

  const hourTip = perpTipRadius(dim.hourWheel);
  const stars = [
    { label: "l'étoile de quantième", center: D, r: dim.date.tip },
    { label: "l'étoile des jours", center: W, r: dim.day.tip },
    { label: "l'étoile des mois", center: M, r: dim.month.tip },
  ];
  for (const s of stars) {
    if (!perpInPlate(s.center, s.r, plateRadius, dim.plateMargin)) problems.push(`${s.label} sort de la platine : rapproche son affichage du centre.`);
    const toCenter = perpDist(s.center, O) - s.r - hourTip;
    if (toCenter < dim.clearance) {
      problems.push(`${s.label} empiète sur la roue des heures : éloigne son affichage du centre d'au moins ${(dim.clearance - toCenter).toFixed(2).replace(".", ",")} mm.`);
    }
  }
  for (let i = 0; i < stars.length; i++) {
    for (let j = i + 1; j < stars.length; j++) {
      const gap = perpDist(stars[i].center, stars[j].center) - stars[i].r - stars[j].r;
      if (gap < dim.clearance) problems.push(`${stars[i].label} et ${stars[j].label} se chevauchent : écarte les deux affichages.`);
    }
  }
  if (problems.length) return { ok: false, problems, dim };

  const starObstacles = [perpObstacle("D", D, dim.date.tip), perpObstacle("W", W, dim.day.tip), perpObstacle("M", M, dim.month.tip)];
  const RH = perpTipRadius(dim.wheel24);
  const RG = perpTipRadius(dim.program);
  const dOH = perpPitchRadius(dim.hourWheel) + perpPitchRadius(dim.wheel24);
  const dMG = perpPitchRadius(dim.program) + perpPitchRadius(dim.monthPinion);

  const hCandidates = perpWheelCandidates(O, dOH, RH, plateRadius, dim, starObstacles, 5).slice(0, 5);
  if (!hCandidates.length) {
    return { ok: false, dim, problems: ["La roue de 24 heures ne trouve pas de place autour de la roue des heures : les affichages l'encerclent. Libère un côté du centre."] };
  }

  let firstFailure = null;
  const fail = (message) => {
    if (!firstFailure) firstFailure = message;
  };

  for (const hc of hCandidates) {
    const H = hc.center;
    const gObstacles = [
      perpObstacle("O", O, hourTip),
      perpObstacle("H", H, RH),
      perpObstacle("D", D, dim.date.tip),
      perpObstacle("W", W, dim.day.tip),
    ];
    const gCandidates = perpWheelCandidates(M, dMG, RG, plateRadius, dim, gObstacles, 10).slice(0, 4);
    if (!gCandidates.length) {
      fail("La roue programme (48 mois) ne trouve pas de place autour de l'étoile des mois : dégage les abords de l'affichage des mois.");
      continue;
    }
    for (const gc of gCandidates) {
      const G = gc.center;
      const obstacles = [...gObstacles, perpObstacle("M", M, dim.month.tip), perpObstacle("G", G, RG)];
      const pivots = [];

      let drives;
      let pieces;
      let monthSense = 1;
      if (kind === "montre") {
        // la grande bascule d'abord : c'est elle qui doit tout atteindre
        const grandLever = perpDesignGrandLever(D, G, H, dim, plateRadius, obstacles, pivots, spec, {
          date: { center: D, star: dim.date, pin: true },
          day: { center: W, star: dim.day },
        });
        if (!grandLever) {
          // un seul levier doit atteindre cinq pieces : on ne sait pas dire
          // laquelle manque, on donne donc une disposition qui fonctionne
          fail(
            `Grande bascule : aucun pivot ne relie à la fois la goupille de fin de mois, l'étoile de quantième, l'étoile des jours (à ${perpDist(D, W)
              .toFixed(1)
              .replace(".", ",")} mm l'une de l'autre), la came programme et le limaçon de 24 h. Regroupe ces affichages — la disposition classique quantième à 6 h, jours à 9 h, mois à 3 h convient —, ou choisis la construction de pendule.`
          );
          continue;
        }
        pivots.push(grandLever.P);
        // la roue de quantieme mene l'etoile des mois par un doigt quand elle
        // en est assez proche ; sinon un levier des mois fait le relais
        const monthFinger = perpDesignMonthFinger(D, M, dim, plateRadius, [
          { ...O, r: 0.5 * k },
          { ...W, r: dim.arborClearance },
          { ...G, r: dim.arborClearance },
          { ...grandLever.P, r: dim.pivotClearance },
        ]);
        const monthLever = monthFinger ? null : perpDesignMonthLever(D, M, dim, plateRadius, obstacles, pivots);
        if (!monthFinger && !monthLever) {
          fail(
            `Mois : l'étoile des mois est trop loin du quantième pour son doigt (${perpDist(D, M).toFixed(1).replace(".", ",")} mm d'axe à axe), et aucun levier des mois ne les relie. Rapproche ces deux affichages.`
          );
          continue;
        }
        if (monthLever) pivots.push(monthLever.drive.B);
        drives = { date: grandLever.pawls.date.drive, day: grandLever.pawls.day.drive, month: monthFinger ?? monthLever.drive };
        monthSense = monthFinger ? monthFinger.sense : 1;
        pieces = { grandLever, monthLever, monthFinger, dateBascule: null, dayBascule: null };
      } else {
        const dateBascule = perpDesignBascule(D, dim.date, H, dim, plateRadius, obstacles, pivots);
        if (!dateBascule) {
          fail("Bascule de quantième : aucun pivot ne relie la roue de 24 h à l'étoile de quantième. Rapproche l'affichage du quantième du centre.");
          continue;
        }
        pivots.push(dateBascule.drive.B);

        const dayBascule = perpDesignBascule(W, dim.day, H, dim, plateRadius, obstacles, pivots);
        if (!dayBascule) {
          fail("Bascule de semaine : aucun pivot ne relie la roue de 24 h à l'étoile des jours. Rapproche l'affichage des jours du centre.");
          continue;
        }
        pivots.push(dayBascule.drive.B);

        const monthLever = perpDesignMonthLever(D, M, dim, plateRadius, obstacles, pivots);
        if (!monthLever) {
          fail(
            `Levier des mois : impossible de relier l'étoile de quantième à celle des mois (${perpDist(D, M).toFixed(1).replace(".", ",")} mm d'axe à axe). Rapproche ces deux affichages, ou écarte-les s'ils se touchent presque.`
          );
          continue;
        }
        pivots.push(monthLever.drive.B);

        const grandLever = perpDesignGrandLever(D, G, H, dim, plateRadius, obstacles, pivots);
        if (!grandLever) {
          fail("Grand levier : aucun pivot ne relie à la fois la goupille de fin de mois, la came programme et le limaçon de 24 h. Regroupe davantage le quantième et les mois autour du centre.");
          continue;
        }
        pivots.push(grandLever.P);
        drives = { date: dateBascule.drive, day: dayBascule.drive, month: monthLever.drive };
        pieces = { dateBascule, dayBascule, monthLever, grandLever };
      }

      const sautoirs = {};
      const sautoirSpecs = [
        ["date", D, dim.date, drives.date],
        ["day", W, dim.day, drives.day],
        ["month", M, dim.month, drives.month],
      ];
      let sautoirFailed = false;
      for (const [key, center, star, drive] of sautoirSpecs) {
        const s = perpDesignSautoir(center, star, drive, dim, plateRadius, obstacles, pivots, key === "month" ? monthSense : 1);
        if (!s) {
          sautoirFailed = true;
          break;
        }
        sautoirs[key] = s;
        pivots.push(s.pivot);
      }
      if (sautoirFailed) {
        fail("Sautoirs : pas de place pour loger le ressort de l'une des étoiles. Écarte un peu les affichages.");
        continue;
      }
      // le doigt des mois tourne avec le quantieme : aucun pivot sur son cercle
      if (pieces.monthFinger && Object.values(sautoirs).some((s) => Math.abs(perpDist(D, s.pivot) - pieces.monthFinger.rF) < dim.pivotClearance)) {
        fail("Doigt des mois : un sautoir tombe sur le cercle que décrit le doigt. Écarte un peu les affichages.");
        continue;
      }

      return assemblePerpetualModel({ kind, spec, plateRadius, dim, O, H, D, W, M, G, ...pieces, sautoirs });
    }
  }
  return { ok: false, dim, problems: [firstFailure ?? "Aucune disposition trouvée pour ces positions d'affichage."] };
}

/**
 * Derniere etape : les cotes de fabrication. Les rayons de came sont
 * arrondis au centieme, puis relus a travers la geometrie du levier -- ce
 * sont ces valeurs RELUES, et non les cibles ideales, que la cinematique
 * et la verification utilisent.
 */
function assemblePerpetualModel(parts) {
  const { dim, O, H, M, G, grandLever } = parts;
  const round = (r) => Math.round(r / dim.machining) * dim.machining;

  const levels = {};
  const restByLength = {};
  const spec = parts.spec;
  for (const L of [28, 29, 30, 31]) {
    levels[L] = round(grandLever.bec.radius(L + spec.restOffset));
    restByLength[L] = perpSolve(grandLever.bec.radius, levels[L], spec.lowP, spec.topP) ?? L + spec.restOffset;
  }
  const snailTop = round(grandLever.lift.radius(spec.topP));
  const snailLow = round(grandLever.lift.radius(spec.lowP));
  const topP = perpSolve(grandLever.lift.radius, snailTop, spec.lowP, spec.topP + 0.5) ?? spec.topP;
  const lowP = perpSolve(grandLever.lift.radius, snailLow, spec.lowP - 0.5, spec.topP) ?? spec.lowP;
  const restP = Array.from({ length: PERP_PROGRAM_TEETH }, (_, kk) => restByLength[perpProgramLength(kk)]);

  const wheel24Phase = perpMeshPhase(O, dim.hourWheel.teeth, 0, H, dim.wheel24.teeth);
  const programPhase = perpMeshPhase(M, dim.monthPinion.teeth, 0, G, dim.program.teeth);

  return {
    ok: true,
    problems: [],
    ...parts,
    timing: spec.timing,
    monthSense: parts.monthFinger ? parts.monthFinger.sense : 1,
    centers: { O, H, D: parts.D, W: parts.W, M, G },
    phases: { hour: 0, wheel24: wheel24Phase, pinion: 0, program: programPhase },
    thresholds: {
      levels,
      restByLength,
      restP,
      topP,
      lowP,
      snailTop,
      snailLow,
      monthHalf: (parts.monthFinger ?? parts.monthLever).half,
      monthWindow: [(parts.monthFinger ?? parts.monthLever).windowStart, (parts.monthFinger ?? parts.monthLever).windowEnd],
    },
  };
}
