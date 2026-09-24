/**
 * perpetual-kinematics.js
 * Ce que fait le quantieme perpetuel, nuit apres nuit et instant apres
 * instant, a partir de la geometrie synthetisee.
 *
 * Deux niveaux de lecture qui doivent dire la meme chose :
 *   - la LOGIQUE d'une nuit (perpNightStep), qui ne manipule que les
 *     seuils relus sur les cames usinees -- c'est elle que l'on confronte
 *     au calendrier (gregorien ou hegirien) sur plus d'un siecle ;
 *   - la POSE a un instant donne (perpPoseAt), qui donne l'angle de chaque
 *     piece pour le dessin et l'animation, et retombe exactement sur l'etat
 *     de la logique a minuit.
 *
 * Unite commune : p, la position de la goupille de fin de mois exprimee en
 * dents de l'etoile de quantieme (p = 17 : le 17 est affiche ; p = 32 : le
 * 1er du mois suivant, avant renumerotation).
 */

/**
 * Une nuit du mecanisme.
 *  1. la bascule de quantieme avance l'etoile d'une dent ; si la goupille
 *     des mois franchit son point de bascule, le mois change ;
 *  2. le grand levier est leve depuis son repos (fixe par le cran du mois
 *     courant) jusqu'a la butee. Son cliquet n'attrape la goupille que si
 *     elle se trouve dans la plage balayee -- le dernier jour d'un mois
 *     court seulement -- et l'amene alors au 1, en changeant le mois ;
 *  3. le sautoir ramene l'etoile sur la dent entiere la plus proche.
 */
function perpNightStep(state, th) {
  const pB = state.p + 1;
  let k = state.k;
  if (state.p < th.monthHalf && pB >= th.monthHalf) k = (k + 1) % th.cycleMonths;

  let reach = pB;
  if (pB > th.restP[k] && pB <= th.topP + 1e-9) {
    if (pB < th.monthHalf && th.topP >= th.monthHalf) k = (k + 1) % th.cycleMonths;
    reach = Math.max(pB, th.topP);
  }
  let p = Math.round(reach);
  if (p > th.N) p -= th.N;
  return { p, w: (state.w + 1) % PERP_DAY_TEETH, k };
}

/**
 * Une nuit de la construction de montre (grande bascule).
 *  1. le crochet de fin de mois part du repos du mois courant : il n'est en
 *     retrait de la goupille -- et ne la rattrapera donc -- que si elle a
 *     deja depasse ce repos, soit le dernier jour du mois ;
 *  2. dans la meme levee, les cliquets avancent quantieme et jour d'une dent ;
 *     le crochet, s'il tient la goupille, l'emmene jusqu'a la butee ;
 *  3. le sautoir ramene l'etoile sur la dent entiere la plus proche.
 */
function perpWatchNightStep(state, th) {
  const caught = state.p > th.restP[state.k] + 1e-9;
  const reach = caught ? Math.max(state.p + 1, th.topP) : state.p + 1;
  const k = state.p < th.monthHalf && reach >= th.monthHalf ? (state.k + 1) % th.cycleMonths : state.k;
  let p = Math.round(reach);
  if (p > th.N) p -= th.N;
  return { p, w: (state.w + 1) % PERP_DAY_TEETH, k };
}

function perpNightStepFor(model) {
  return model.kind === "montre" ? perpWatchNightStep : perpNightStep;
}

/**
 * Suite des etats a minuit depuis la date de reglage. Le mecanisme ne sait
 * pas reculer : on ne remonte pas avant le reglage.
 */
function createPerpetualTimeline(model, startCivil) {
  const startDay = perpDayNumber(startCivil.y, startCivil.m, startCivil.d);
  const states = [perpStateFromDay(model.cal, startDay)];
  const step = perpNightStepFor(model);
  return {
    model,
    startCivil,
    startDay,
    stateAt(n) {
      const index = Math.max(0, Math.min(200000, Math.floor(n)));
      while (states.length <= index) states.push(step(states[states.length - 1], model.thresholds));
      return states[index];
    },
  };
}

// ------------------------------------------------------------------
// Horaire de chaque piece au cours de la nuit
// ------------------------------------------------------------------

/** Angle d'une bascule : poussee lentement par sa came, puis retombee. */
function perpBasculeAngle(drive, h) {
  const T = PERP_TIMING;
  if (h < T.stepStart || h >= T.stepEnd) return drive.psiR;
  if (h < T.stepTop) return perpMix(drive.psiR, drive.psiE, perpEase((h - T.stepStart) / (T.stepTop - T.stepStart)));
  return perpMix(drive.psiE, drive.psiR, (h - T.stepTop) / (T.stepEnd - T.stepTop));
}

/** Avance de l'etoile menee par une bascule : le cliquet la pousse, puis la lache. */
function perpBasculeProgress(drive, h) {
  if (h < PERP_TIMING.stepStart) return 0;
  if (h >= PERP_TIMING.stepTop) return 1;
  return drive.progress(perpBasculeAngle(drive, h));
}

/** Position que le limacon impose au grand levier (en p). */
function perpSnailP(th, h, T = PERP_TIMING) {
  if (h < T.liftStart) return th.lowP;
  if (h < T.liftTop) return perpMix(th.lowP, th.topP, perpEase((h - T.liftStart) / (T.liftTop - T.liftStart)));
  if (h < T.dropStart) return th.topP;
  return perpMix(th.topP, th.lowP, perpClamp01((h - T.dropStart) / (T.dropEnd - T.dropStart)));
}

/** Avance de l'etoile des mois quand la goupille des mois est en p. */
function perpMonthProgress(model, p) {
  if (model.monthFinger) return model.monthFinger.progressAt(p);
  const ml = model.monthLever;
  if (p <= ml.windowStart) return 0;
  return ml.drive.progress(ml.theta(Math.min(p, ml.windowEnd)) + ml.delta);
}

/** Angle du levier des mois : suit la goupille dans sa fenetre, au repos sinon. */
function perpMonthLeverAngle(model, p) {
  const ml = model.monthLever;
  const q = p < ml.windowStart || p > ml.windowEnd ? ml.windowStart : p;
  return ml.theta(q);
}

/**
 * Pose complete a l'instant t, en jours depuis minuit de la date de reglage.
 */
function perpPoseAt(timeline, t) {
  const model = timeline.model;
  if (model.kind === "montre") return perpWatchPoseAt(timeline, t);
  const th = model.thresholds;
  const T = PERP_TIMING;
  const time = Math.max(0, t);
  const n = Math.floor(time);
  const h = (time - n) * 24;
  const s = timeline.stateAt(n);

  const dateDrive = model.dateBascule.drive;
  const dayDrive = model.dayBascule.drive;
  const xD = perpBasculeProgress(dateDrive, h);
  const xW = perpBasculeProgress(dayDrive, h);
  const pB = s.p + 1;
  const kAfterStep = s.p < th.monthHalf && pB >= th.monthHalf ? (s.k + 1) % th.cycleMonths : s.k;
  const caught = pB > th.restP[kAfterStep] && pB <= th.topP + 1e-9;
  const snail = perpSnailP(th, h);

  let p = s.p + xD;
  if (caught && h >= T.liftStart) {
    // le cliquet pousse la goupille ; a la chute, le sautoir la ramene sur
    // la dent entiere pendant que le cliquet s'efface
    p = h < T.dropStart ? Math.max(pB, snail) : Math.max(Math.round(Math.max(pB, th.topP)), snail);
  }

  const xm = perpMonthProgress(model, p);
  const kc = s.k + xm;
  // la came programme tourne sous le bec : le repos glisse d'un cran a l'autre
  const rest = perpMix(th.restP[s.k], th.restP[(s.k + 1) % th.cycleMonths], perpEase(xm));
  const leverP = Math.max(rest, snail);
  const wc = s.w + xW;

  return perpComposePose(model, { time, n, h, s, p, wc, kc, leverP, snail, rest, caught }, {
    dateBascule: perpBasculeAngle(dateDrive, h),
    dayBascule: perpBasculeAngle(dayDrive, h),
  });
}

/**
 * Pose de la construction de montre. Tout part de la grande bascule : sa
 * position est celle que lui impose le limacon, ou la came programme quand
 * le limacon est plus bas.
 */
function perpWatchPoseAt(timeline, t) {
  const model = timeline.model;
  const th = model.thresholds;
  const T = model.timing;
  const pawls = model.grandLever.pawls;
  const time = Math.max(0, t);
  const n = Math.floor(time);
  const h = (time - n) * 24;
  const s = timeline.stateAt(n);

  const snail = perpSnailP(th, h, T);
  const caught = s.p > th.restP[s.k] + 1e-9;
  // position la plus haute atteinte cette nuit : en retombant, les cliquets
  // s'effacent et laissent les etoiles la ou ils les ont menees
  const reached = h >= T.liftTop ? th.topP : Math.max(th.restP[s.k], snail);
  let p = s.p + pawls.date.progressAt(reached);
  // le crochet emmene la goupille des qu'il la rejoint
  if (caught) p = Math.max(p, reached);
  // a la chute, le sautoir acheve le saut sur la dent entiere
  if (h >= T.dropStart) p = Math.round(p);

  const xm = perpMonthProgress(model, p);
  const kc = s.k + xm;
  // la came programme tourne pendant que le bec est leve
  const rest = perpMix(th.restP[s.k], th.restP[(s.k + 1) % th.cycleMonths], perpEase(xm));
  const leverP = Math.max(rest, snail);
  const wc = s.w + pawls.day.progressAt(reached);

  return perpComposePose(model, { time, n, h, s, p, wc, kc, leverP, snail, rest, caught }, {});
}

/** Angles et indications communs aux deux constructions. */
function perpComposePose(model, f, extraAngles) {
  const dim = model.dim;
  const th = model.thresholds;
  const sense = model.monthSense ?? 1;
  const roundDate = (v) => {
    const r = Math.round(v);
    return r > th.N ? r - th.N : r;
  };
  const kInt = Math.round(f.kc) % th.cycleMonths;
  // came de 48 mois : roue menee par le pignon des mois, en sens inverse ;
  // came de 12 mois : solidaire de l'etoile des mois, et son satellite
  const yearly = !!model.satellite;
  const programAngle = yearly ? sense * f.kc * dim.month.pitch : (-sense * f.kc * 2 * Math.PI) / PERP_PROGRAM_TEETH;

  return {
    t: f.time,
    n: f.n,
    h: f.h,
    state: f.s,
    p: f.p,
    w: f.wc,
    k: f.kc,
    leverP: f.leverP,
    snailP: f.snail,
    restP: f.rest,
    caught: f.caught,
    angles: {
      hour: 4 * Math.PI * f.time,
      wheel24: -2 * Math.PI * f.time,
      date: (f.p - 1) * dim.date.pitch,
      day: f.wc * dim.day.pitch,
      // mene par le doigt du quantieme, l'etoile des mois tourne a rebours ;
      // la roue programme, engrenee sur son pignon, en sens inverse d'elle
      month: sense * f.kc * dim.month.pitch,
      program: programAngle,
      ...(yearly ? { satellite: perpSatelliteAngle(model, f.s.k, f.kc) } : {}),
      ...extraAngles,
      grandLever: model.grandLever.thetaOf(f.leverP),
      ...(model.monthLever ? { monthLever: perpMonthLeverAngle(model, f.p) } : {}),
    },
    indication: {
      date: roundDate(f.p),
      weekday: Math.round(f.wc) % PERP_DAY_TEETH,
      month: kInt % 12,
      cycleYear: Math.floor(kInt / 12),
      ...(yearly ? { satellite: perpSatelliteIndex(model.cal, kInt) } : {}),
    },
  };
}

// ------------------------------------------------------------------
// Satellite de la came de 12 mois
// ------------------------------------------------------------------

/**
 * Le satellite avance d'un cran par tour de came comme une croix de Malte :
 * un doigt fixe, a `rho` de l'arbre des mois, entre dans son etoile
 * d'entrainement quand elle passe devant lui et la fait tourner tant qu'il
 * reste a sa portee. L'angle se lit directement sur la position du doigt --
 * rien n'est interpole. Hors de ce passage, un sautoir tient le satellite.
 * Repere de la came ; angle relatif a la pose de reference (annee 0).
 */
function perpSatelliteAngle(model, kState, kc) {
  const sat = model.satellite;
  const sense = model.monthSense ?? 1;
  const step = (2 * Math.PI) / sat.positions;
  const base = perpSatelliteIndex(model.cal, kState);
  let progress = 0;
  const xm = kc - kState;
  if (xm > 0 && (kState + 1) % 12 === sat.stepMonth) {
    // doigt vu depuis la came, qui a tourne de camAngle
    const camAngle = sense * kc * model.dim.month.pitch;
    const F = perpPolar(model.centers.M, sat.rho, sat.fingerAngle - camAngle);
    const v = { x: F.x - sat.S.x, y: F.y - sat.S.y };
    if (Math.hypot(v.x, v.y) <= sat.drive + 1e-9) {
      progress = perpClamp01((sense * perpAngleDiff(sat.entry, Math.atan2(v.y, v.x))) / step);
    } else {
      progress = xm < 0.5 ? 0 : 1;
    }
  }
  return -sense * (base + progress) * step;
}

/**
 * Geometrie du satellite dans le repere de la came, a sa pose de reference
 * (came au mois 0, satellite a l'annee 0) :
 *   - S : centre, sur le rayon qui passera sous le bec au mois lu ;
 *   - lobes : le lobe j pointe vers l'exterieur quand le satellite est a
 *     l'annee j ;
 *   - etoile d'entrainement, a l'etage du doigt fixe : une dent par cran, de
 *     longueur `drive`, calees a +-pi/n du rayon exterieur au repos ;
 *   - doigt fixe : rayon `rho` choisi pour que le doigt, de son entree a sa
 *     sortie de l'etoile, la fasse tourner d'un cran exactement.
 *     Dans le triangle arbre-satellite-doigt : rho^2 = rS^2 + l^2 + 2.rS.l.cos(pi/n).
 */
function perpSatelliteLayout(model, becAngle) {
  const sat = model.satellite;
  const sense = model.monthSense ?? 1;
  const dim = model.dim;
  const M = model.centers.M;
  const n = sat.positions;
  const out = becAngle - sense * sat.readMonth * dim.month.pitch;
  const S = perpPolar(M, sat.rS, out);
  const rhoOf = (l) => Math.sqrt(sat.rS * sat.rS + l * l + 2 * sat.rS * l * Math.cos(Math.PI / n));
  // arc de came pendant lequel le doigt tient l'etoile (angle au centre)
  const sweepOf = (l) => 2 * Math.asin(Math.min(1, (l * Math.sin(Math.PI / n)) / rhoOf(l)));
  // fentes aussi longues que l'arbre le permet, mais raccourcies si le doigt
  // tenait l'etoile au-dela de 70 % du saut de l'etoile des mois
  let drive = Math.max(0.2 * dim.k, Math.min(0.45 * dim.k, sat.rS - dim.arborClearance - 0.05 * dim.k));
  while (drive > 0.15 * dim.k && sweepOf(drive) > 0.7 * dim.month.pitch) drive -= 0.01 * dim.k;
  const rho = rhoOf(drive);
  // le doigt est sur le rayon exterieur du satellite au milieu du changement
  // de mois qui le fait avancer
  const fingerAngle = out + sense * (sat.stepMonth - 0.5) * dim.month.pitch;
  return { out, S, drive, rho, fingerAngle, entry: out + (sense * Math.PI) / n, sweep: sweepOf(drive) };
}

// ------------------------------------------------------------------
// Profils de came (repere de la roue qui les porte)
// ------------------------------------------------------------------

/**
 * Came de bascule sur la roue de 24 h, taillee par inversion : on fige la
 * roue et l'on fait tourner le palpeur autour d'elle, en placant la matiere
 * la ou le palpeur doit se trouver a chaque heure.
 */
function perpBasculeCamProfile(model, bascule, count = 720) {
  const H = model.centers.H;
  const { drive, feeler } = bascule;
  const pts = [];
  for (let i = 0; i < count; i++) {
    const u = i / count;
    const psi = perpBasculeAngle(drive, u * 24);
    const E = perpPolar(drive.B, feeler.La, psi + feeler.gamma);
    const ang = perpAngleTo(H, E) + 2 * Math.PI * u;
    const r = perpDist(H, E);
    pts.push({ x: r * Math.cos(ang), y: r * Math.sin(ang) });
  }
  return pts;
}

/** Limacon de levee du grand levier, meme construction. */
function perpSnailProfile(model, count = 720) {
  const H = model.centers.H;
  const gl = model.grandLever;
  const pts = [];
  for (let i = 0; i < count; i++) {
    const u = i / count;
    const theta = gl.thetaOf(perpSnailP(model.thresholds, u * 24, model.timing));
    const E = perpPolar(gl.P, gl.lift.La, theta + gl.lift.gamma);
    const ang = perpAngleTo(H, E) + 2 * Math.PI * u;
    const r = perpDist(H, E);
    pts.push({ x: r * Math.cos(ang), y: r * Math.sin(ang) });
  }
  return pts;
}

/**
 * Came programme de 48 mois, dans le repere de la roue programme : un
 * secteur par mois, au rayon relu pour sa longueur, relie au suivant par
 * une rampe courte. Le secteur du mois k se presente sous le bec quand la
 * roue a tourne de k crans.
 */
function perpProgramCamProfile(model) {
  const G = model.centers.G;
  const gl = model.grandLever;
  const th = model.thresholds;
  const sat = model.satellite;
  const positions = model.dim.program.positions;
  const sector = (2 * Math.PI) / positions;
  // la came de 48 mois tourne a l'inverse de l'etoile des mois, celle de 12
  // mois avec elle : un cran se presente sous le bec dans l'autre sens
  const camDir = sat ? 1 : -1;
  const ramp = sector * 0.12;
  const pts = [];
  for (let kk = 0; kk < positions; kk++) {
    // came de 12 mois : la premiere annee du cycle suffit a nommer les crans ;
    // le mois lu par le satellite est creuse jusqu'a lui
    const L = perpCycleLength(model.cal, kk);
    const bec = perpPolar(gl.P, gl.bec.La, gl.thetaOf(th.restByLength[L]) + gl.bec.gamma);
    const centerAngle = perpAngleTo(G, bec) - camDir * (model.monthSense ?? 1) * kk * sector;
    const r = sat && kk === sat.readMonth ? sat.rS + 0.35 * sat.lobeMin : th.levels[L];
    for (let j = 0; j <= 6; j++) {
      const a = centerAngle - sector / 2 + ramp + ((sector - 2 * ramp) * j) / 6;
      pts.push({ x: r * Math.cos(a), y: r * Math.sin(a), k: kk });
    }
  }
  return pts;
}

// ------------------------------------------------------------------
// Verification
// ------------------------------------------------------------------

/**
 * Marges de fonctionnement relues sur la geometrie usinee. Le cliquet du
 * grand levier doit se tenir entre le dernier jour du mois et le suivant ;
 * une marge qui fond sous le dixieme de dent signale un mecanisme qui
 * ne pardonnera aucun jeu.
 */
function perpMargins(model) {
  const th = model.thresholds;
  const N = th.N;
  const lengths = Object.keys(th.levels).map(Number);
  const shortest = Math.min(...lengths);
  const issues = [];
  let worst = Infinity;
  if (model.kind === "montre") {
    // le repos d'un mois de L jours doit tomber entre L-1 et L
    for (const L of lengths) {
      const r = th.restByLength[L];
      const margin = Math.min(r - (L - 1), L - r);
      worst = Math.min(worst, margin);
      if (margin < 0.1) issues.push(`repos du mois de ${L} jours à ${margin.toFixed(2)} dent de la goupille`);
    }
    if (th.topP < N + 1.05 || th.topP > N + 1.45) issues.push(`butée haute de la grande bascule hors plage (${th.topP.toFixed(2)})`);
    if (th.lowP > th.restByLength[shortest] - 0.05) issues.push("le limaçon touche la grande bascule en journée");
    if (model.monthFinger && model.monthFinger.windowStart < N + 0.02) issues.push("le doigt des mois pousse l'étoile des mois avant le passage au 1");
    for (const [key, label] of [
      ["date", "de quantième"],
      ["day", "des jours"],
    ]) {
      if (model.grandLever.pawls[key].cBank < th.restByLength[N] + 0.02) issues.push(`la goupille de dégagement libère le cliquet ${label} dès le repos des mois de ${N} jours`);
    }
  } else {
    for (const L of lengths) {
      const r = th.restByLength[L];
      const margin = Math.min(r - L, L + 1 - r);
      worst = Math.min(worst, margin);
      if (margin < 0.1) issues.push(`repos du mois de ${L} jours à ${margin.toFixed(2)} dent du jour voisin`);
    }
    if (th.topP < N + 0.6) issues.push(`butée haute du grand levier trop basse (${th.topP.toFixed(2)})`);
    if (th.lowP > th.restByLength[shortest] - 0.05) issues.push("le limaçon touche le levier en journée");
    if (th.monthHalf <= th.restByLength[N] + 0.05) issues.push("le changement de mois survient bec posé sur la came");
  }
  const sat = model.satellite;
  if (sat) {
    // tolerance : les cotes sont arrondies au centieme
    if (sat.inner < model.dim.arborClearance - model.dim.machining) issues.push("le plus long lobe du satellite frôle l'arbre des mois en tournant");
    // le doigt doit avoir quitte l'etoile avant la fin du saut de l'etoile des mois
    if (sat.sweep > 0.8 * model.dim.month.pitch) issues.push("le doigt du satellite le tient plus longtemps que ne dure le saut des mois");
  }
  return { worst, issues };
}

/**
 * Largeur de bec au-dela de laquelle le bec, pose sur un lobe du satellite,
 * toucherait aussi un lobe voisin plus long. Nulle limite quand les lobes
 * sont assez ecartes (croix de 4) : un voisin a 90 degres ne remonte pas
 * jusqu'au bec. Retourne Infinity dans ce cas.
 */
function perpSatelliteBecLimit(sat) {
  const step = (2 * Math.PI) / sat.positions;
  let limit = Infinity;
  const n = sat.lobes.length;
  for (let j = 0; j < n; j++) {
    for (const nb of [(j + 1) % n, (j + n - 1) % n]) {
      // le voisin depasse-t-il, le long du rayon, le lobe lu ?
      if (sat.lobes[nb] * Math.cos(step) <= sat.lobes[j]) continue;
      limit = Math.min(limit, 2 * sat.lobes[nb] * Math.sin(step));
    }
  }
  return limit;
}

/**
 * Confronte la logique du mecanisme a son calendrier, jour apres jour,
 * depuis la date de reglage. S'arrete au premier ecart -- en gregorien, en
 * regle generale le 1er mars d'une annee seculaire non bissextile, que tout
 * quantieme perpetuel mecanique prend pour un 29 fevrier. Le calendrier
 * hegirien arithmetique n'a pas de telles exceptions : son cycle de 30 ans
 * est entierement porte par la came, et l'ecart ne doit jamais venir.
 */
function perpVerify(model, startCivil, maxDays = 80000) {
  const startDay = perpDayNumber(startCivil.y, startCivil.m, startCivil.d);
  let state = perpStateFromDay(model.cal, startDay);
  const step = perpNightStepFor(model);
  for (let i = 0; i < maxDays; i++) {
    const civil = perpCivilFromDayNumber(startDay + i);
    const expected = perpStateFromDay(model.cal, startDay + i);
    if (state.p !== expected.p || state.w !== expected.w || state.k !== expected.k) {
      const secular = model.cal.family === "gregorien" && civil.m === 2 && civil.d === 1 && civil.y % 100 === 0 && !perpIsLeapYear(civil.y);
      return { ok: false, days: i, civil, date: model.cal.fromDayNumber(startDay + i), shown: state, expected, secular };
    }
    state = step(state, model.thresholds);
  }
  return { ok: true, days: maxDays };
}
