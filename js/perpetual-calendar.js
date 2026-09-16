/**
 * perpetual-calendar.js
 * Quantieme perpetuel a grand levier : calendrier, horaire de la nuit,
 * dimensions et outils geometriques communs a la synthese, a la
 * cinematique et au dessin.
 *
 * Deux constructions sont modelisees. Celle de PENDULE, decrite ici, confie
 * chaque fonction a sa piece ; celle de MONTRE, a grande bascule unique, est
 * decrite plus bas (voir PERP_WATCH_REST_OFFSET).
 *
 * Principe de la construction de pendule (vu cote cadran) :
 *
 *   - la ROUE DE 24 HEURES, engrenee sur la roue des heures, fait un tour
 *     par jour et porte trois cames etagees ;
 *   - chaque soir, deux de ces cames soulevent la BASCULE DE QUANTIEME et la
 *     BASCULE DE SEMAINE : leur cliquet avance l'etoile de 31 et l'etoile
 *     de 7 d'une dent, puis leur ressort les ramene ;
 *   - le GRAND LEVIER repose, par son bec, sur la CAME PROGRAMME de 48 mois
 *     (quatre ans). La profondeur du cran du mois courant fixe sa position
 *     de repos. La troisieme came, un limacon, le leve ensuite jusqu'a une
 *     butee fixe ; son cliquet a ressort balaie alors une plage de l'etoile
 *     de quantieme, et n'y rencontre la GOUPILLE DE FIN DE MOIS que le
 *     dernier jour d'un mois court -- il la pousse jusqu'au 1 ;
 *   - une seconde goupille de la meme etoile pousse le LEVIER DES MOIS au
 *     passage du 31 au 1 : son cliquet avance l'etoile des mois, dont le
 *     pignon mene la roue programme au quart de sa vitesse ;
 *   - chaque etoile est tenue entre deux sauts par un SAUTOIR a ressort.
 *
 * Le mecanisme ignore les regles seculaires : il affiche un 29 fevrier en
 * 2100, 2200 et 2300. C'est le cas de tous les quantiemes perpetuels
 * mecaniques, et le programme le dit plutot que de le cacher.
 */

const PERP_DATE_TEETH = 31;
const PERP_DAY_TEETH = 7;
const PERP_MONTH_TEETH = 12;
const PERP_PROGRAM_TEETH = 48;

const PERP_DAY_LABELS = ["LUN", "MAR", "MER", "JEU", "VEN", "SAM", "DIM"];
const PERP_DAY_NAMES = ["lundi", "mardi", "mercredi", "jeudi", "vendredi", "samedi", "dimanche"];
const PERP_MONTH_LABELS = ["JAN", "FÉV", "MARS", "AVR", "MAI", "JUIN", "JUIL", "AOÛT", "SEPT", "OCT", "NOV", "DÉC"];
const PERP_MONTH_NAMES = [
  "janvier",
  "février",
  "mars",
  "avril",
  "mai",
  "juin",
  "juillet",
  "août",
  "septembre",
  "octobre",
  "novembre",
  "décembre",
];
const PERP_LEAP_LABELS = ["BISS.", "1", "2", "3"];

/**
 * Horaire de la nuit, en heures. Les deux bascules travaillent d'abord,
 * lentement (c'est la came qui les pousse), puis tombent de leur came d'un
 * coup ; le grand levier n'est leve qu'ensuite. L'ordre compte : si le
 * levier balayait la plage avant que la bascule ait amene la goupille au
 * lendemain, il la manquerait le dernier jour du mois.
 */
const PERP_TIMING = {
  nightStart: 19.0, // premiere piece en mouvement : l'affichage n'est plus lisible
  stepStart: 19.0, // les cames de bascule commencent a pousser
  stepTop: 22.75, // cliquets en fin de course : etoiles avancees d'une dent
  stepEnd: 23.0, // les bascules sont retombees de leur came
  liftStart: 23.1, // le limacon commence a lever le grand levier
  liftTop: 23.85, // grand levier en butee haute
  dropStart: 23.9, // chute du limacon : le ressort ramene le levier
  dropEnd: 24.0,
};

/**
 * Reperes de la synthese, en DENTS de l'etoile de quantieme (position de la
 * goupille de fin de mois : p = 5 veut dire « le 5 est affiche »).
 *   - repos du grand levier pour un mois de L jours : L + PERP_REST_OFFSET.
 *     Toute valeur dans ]L, L+1[ convient ; 0,35 laisse au bec un peu de
 *     garde au-dessus du cran quand la came tourne sous lui.
 *   - butee haute : un peu au-dela du 1 (32), le sautoir finit le saut.
 *   - point bas du limacon : sous tous les reposes, il ne touche le levier
 *     qu'a la nuit.
 */
const PERP_REST_OFFSET = 0.35;
const PERP_TOP_P = 32.3;
const PERP_LOW_P = 27.8;
// Fenetre ou la goupille des mois pousse le levier des mois. Elle couvre
// presque toute la dent qui mene du 31 au 1 : la goupille ne parcourt
// qu'un arc de quelques dixiemes de millimetre, et c'est tout ce dont le
// levier dispose pour faire avancer l'etoile des mois d'une dent entiere.
const PERP_MONTH_WINDOW_START = 31.0;
const PERP_MONTH_WINDOW_MAX = 31.97;

/**
 * Construction de MONTRE : une grande bascule unique fait tout le travail de
 * la nuit. Le limacon de la roue de 24 h la leve lentement depuis son repos
 * (bec pose sur la came programme) jusqu'a une butee fixe, puis la laisse
 * retomber a minuit. Elle porte :
 *   - le cliquet de quantieme et le cliquet des jours. Une goupille fixe les
 *     tient hors de la denture jusqu'en fin de levee : ils ne travaillent que
 *     sur une plage que TOUS les mois parcourent, et avancent chacun leur
 *     etoile d'une dent et d'une seule, quelle que soit la course que le cran
 *     du mois laisse a la bascule ;
 *   - le crochet de fin de mois, qui part du repos du mois courant. Il n'est
 *     en retrait de la goupille que si elle a DEJA depasse ce repos -- le
 *     dernier jour du mois, et ce jour-la seulement : il la rattrape et la
 *     pousse jusqu'au 1.
 * Au passage du 31 au 1, un doigt fixe sur la roue de quantieme fait avancer
 * l'etoile des mois quand leurs affichages sont voisins (voir
 * perpDesignMonthFinger) ; sinon un levier des mois fait le relais.
 * Le repos d'un mois de L jours se place donc entre L-1 et L, et non
 * au-dessus de L comme dans la construction de pendule, ou le quantieme a
 * deja avance quand le grand levier se leve. Plus le repos du mois de 31
 * jours est bas, plus la plage commune aux deux cliquets est longue ; -0,6
 * laisse 0,4 dent de garde d'un cote et 0,6 de l'autre.
 */
const PERP_WATCH_REST_OFFSET = -0.6;
const PERP_WATCH_LOW_P = 27.0;
const PERP_WATCH_TOP_P = 32.3;
const PERP_WATCH_TIMING = {
  nightStart: 20.0,
  liftStart: 20.0, // le limacon commence a lever la grande bascule
  liftTop: 23.8, // butee haute : cliquets en fin de course
  dropStart: 23.9, // chute du limacon : le ressort ramene la bascule sur la came
  dropEnd: 24.0,
};

/** Parametres propres a chaque construction. */
const PERP_KIND_SPECS = {
  pendule: { lowP: PERP_LOW_P, topP: PERP_TOP_P, restOffset: PERP_REST_OFFSET, timing: PERP_TIMING },
  montre: { lowP: PERP_WATCH_LOW_P, topP: PERP_WATCH_TOP_P, restOffset: PERP_WATCH_REST_OFFSET, timing: PERP_WATCH_TIMING },
};

/** Longueur du mois `month` (0..11) dans l'annee `cycleYear` du cycle (0 = bissextile). */
function perpMonthLength(month, cycleYear) {
  return [31, cycleYear === 0 ? 29 : 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31][month];
}

/** Longueur du mois porte par la position `k` (0..47) de la came programme. */
function perpProgramLength(k) {
  return perpMonthLength(k % 12, Math.floor(k / 12));
}

// ------------------------------------------------------------------
// Calendrier gregorien (la reference contre laquelle on verifie)
// ------------------------------------------------------------------

function perpIsLeapYear(y) {
  return (y % 4 === 0 && y % 100 !== 0) || y % 400 === 0;
}

/** "AAAA-MM-JJ" -> { y, m (0..11), d } ou null. */
function perpParseDate(text) {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(String(text ?? "").trim());
  if (!match) return null;
  const y = parseInt(match[1], 10);
  const m = parseInt(match[2], 10) - 1;
  const d = parseInt(match[3], 10);
  const n = perpDayNumber(y, m, d);
  const back = perpCivilFromDayNumber(n);
  return back.y === y && back.m === m && back.d === d ? { y, m, d } : null;
}

/** Numero de jour UTC (pas d'heure d'ete pour fausser les calculs). */
function perpDayNumber(y, m, d) {
  return Math.round(Date.UTC(y, m, d) / 86400000);
}

function perpCivilFromDayNumber(n) {
  const date = new Date(n * 86400000);
  return {
    y: date.getUTCFullYear(),
    m: date.getUTCMonth(),
    d: date.getUTCDate(),
    weekday: (date.getUTCDay() + 6) % 7, // lundi = 0
  };
}

function perpFormatCivil(c) {
  return `${PERP_DAY_NAMES[c.weekday]} ${c.d} ${PERP_MONTH_NAMES[c.m]} ${c.y}`;
}

/** Etat du mecanisme regle sur une date civile. */
function perpStateFromCivil(c) {
  const n = perpDayNumber(c.y, c.m, c.d);
  const weekday = perpCivilFromDayNumber(n).weekday;
  return { p: c.d, w: weekday, k: 12 * (((c.y % 4) + 4) % 4) + c.m };
}

// ------------------------------------------------------------------
// Geometrie
// ------------------------------------------------------------------

function perpPolar(center, radius, angle) {
  return { x: center.x + radius * Math.cos(angle), y: center.y + radius * Math.sin(angle) };
}

function perpDist(a, b) {
  return Math.hypot(a.x - b.x, a.y - b.y);
}

function perpAngleTo(from, to) {
  return Math.atan2(to.y - from.y, to.x - from.x);
}

/** Ecart angulaire ramene dans ]-pi, pi]. */
function perpAngleDiff(a, b) {
  let d = (a - b) % (2 * Math.PI);
  if (d > Math.PI) d -= 2 * Math.PI;
  if (d <= -Math.PI) d += 2 * Math.PI;
  return d;
}

function perpClamp01(x) {
  return x < 0 ? 0 : x > 1 ? 1 : x;
}

function perpEase(x) {
  const t = perpClamp01(x);
  return t * t * (3 - 2 * t);
}

function perpMix(a, b, t) {
  return a + (b - a) * t;
}

/**
 * Position d'un affichage donnee « a la maniere d'un cadran » : heure (12 en
 * haut) et distance au centre. L'axe y du dessin pointe vers le bas.
 */
function perpClockPoint(hour, radius) {
  const a = (hour * Math.PI) / 6;
  return { x: radius * Math.sin(a), y: -radius * Math.cos(a) };
}

/** Heure de cadran (flottante) d'un point. */
function perpHourOfPoint(p) {
  const h = (Math.atan2(p.x, -p.y) * 6) / Math.PI;
  return (h + 12) % 12;
}

/**
 * Bras tangent : le point E, a la distance `radius` du centre C, tel que le
 * bras PE soit perpendiculaire au rayon CE. C'est la disposition qui donne
 * la plus grande course radiale pour une rotation donnee du levier -- un
 * palpeur pose ainsi lit sa came avec la meilleure sensibilite.
 * Retourne { length, angle } (angle absolu du bras PE), ou null.
 */
function perpTangentArm(pivot, center, radius, sign) {
  const d = perpDist(pivot, center);
  if (!(d > radius + 1e-9)) return null;
  return {
    length: Math.sqrt(d * d - radius * radius),
    angle: perpAngleTo(pivot, center) + sign * Math.asin(radius / d),
  };
}

/** Recherche par dichotomie de x dans [lo, hi] tel que f(x) = target (f monotone). */
function perpSolve(f, target, lo, hi, iterations = 60) {
  let flo = f(lo) - target;
  const fhi = f(hi) - target;
  if (!Number.isFinite(flo) || !Number.isFinite(fhi) || flo * fhi > 0) return null;
  for (let i = 0; i < iterations; i++) {
    const mid = (lo + hi) / 2;
    const fm = f(mid) - target;
    if (fm === 0) return mid;
    if (fm * flo < 0) hi = mid;
    else {
      lo = mid;
      flo = fm;
    }
  }
  return (lo + hi) / 2;
}

/**
 * Dimensions du mecanisme, proportionnelles a la platine : 30 mm, c'est une
 * montre ; une pendule de 150 mm recoit le meme dessin cinq fois plus grand.
 *
 * La construction de montre prend une etoile des jours plus petite. Son
 * cliquet est porte par la grande bascule et ne dispose que de la plage de
 * levee commune a tous les mois, soit moins de deux dents de quantieme : une
 * dent d'etoile de 7, c'est un septieme de tour, et le bec doit parcourir
 * d'autant moins de chemin que l'etoile est petite. Son etoile des mois
 * l'est aussi : menee directement par un doigt de la roue de quantieme, elle
 * doit tourner d'un douzieme de tour pendant que le quantieme n'avance que
 * d'une dent, ce qui demande un rayon petit devant celui du doigt.
 */
function perpDimensions(plateRadius, kind = "pendule") {
  const k = plateRadius / 15;
  const star = (teeth, tip, rootRatio) => {
    const root = tip * rootRatio;
    return { teeth, tip, root, engage: (tip + root) / 2, pitch: (2 * Math.PI) / teeth };
  };
  return {
    k,
    // deux goupilles sur l'etoile de quantieme : celle de fin de mois (grand
    // levier) et celle des mois, un peu plus au bord pour allonger son arc
    date: { ...star(PERP_DATE_TEETH, 2.6 * k, 0.86), pin: 1.75 * k, monthPin: 1.95 * k },
    day: star(PERP_DAY_TEETH, (kind === "montre" ? 0.8 : 1.75) * k, 0.6),
    month: star(PERP_MONTH_TEETH, (kind === "montre" ? 1.0 : 1.95) * k, 0.72),
    hourWheel: { teeth: 30, module: 0.1 * k },
    wheel24: { teeth: 60, module: 0.1 * k },
    program: { teeth: PERP_PROGRAM_TEETH, module: 0.1 * k },
    monthPinion: { teeth: 12, module: 0.1 * k },
    clearance: 0.2 * k,
    pivotClearance: 0.35 * k,
    // arbre portant une aiguille : le bras decoupe d'un levier le contourne a
    // cette distance ; le doigt des mois, qui fait un tour entier, ne peut pas
    // le franchir du tout
    arborClearance: 0.4 * k,
    plateMargin: 0.3 * k,
    // fabrication : les rayons de came sont arrondis au centieme de mm
    machining: 0.01,
  };
}

function perpPitchRadius(w) {
  return (w.teeth * w.module) / 2;
}

function perpTipRadius(w) {
  return perpPitchRadius(w) + w.module;
}

/**
 * Calage d'une roue menee sur sa menante (engrenement exterieur) : une dent
 * de la menante face a un creux de la menee sur la ligne des centres. Meme
 * raisonnement que computeToothPhases (render.js).
 */
function perpMeshPhase(centerA, teethA, phaseA, centerB, teethB) {
  const theta = perpAngleTo(centerA, centerB);
  const stepA = (2 * Math.PI) / teethA;
  const stepB = (2 * Math.PI) / teethB;
  const k = Math.round((theta - phaseA) / stepA);
  const delta = phaseA + k * stepA - theta;
  return theta + Math.PI - (delta * teethA) / teethB - stepB / 2;
}
