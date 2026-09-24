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
 *
 * Trois PROGRAMMES sont proposes pour lire la longueur du mois (voir
 * PERP_CALENDARS) : la came de 48 mois ci-dessus ; une came de 12 mois
 * portant une croix bissextile satellite, a la maniere de Dubois Depraz ; et
 * le calendrier hegirien, came de 12 mois portant une came de 30 ans.
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
 *   - butee haute : un peu au-dela du 1 (N + 1, N dents a l'etoile), le
 *     sautoir finit le saut.
 *   - point bas du limacon : sous tous les reposes, il ne touche le levier
 *     qu'a la nuit.
 * Ces reperes sont donnes par rapport a N (31 en gregorien, 30 en hegirien)
 * et au mois le plus court : voir perpSpec.
 */
const PERP_REST_OFFSET = 0.35;
const PERP_TOP_ABOVE = 1.3; // butee haute : N + 1,3
const PERP_LOW_BELOW = 0.2; // point bas du limacon : mois le plus court - 0,2
// Fenetre ou la goupille des mois pousse le levier des mois. Elle couvre
// presque toute la dent qui mene du dernier jour au 1 : la goupille ne
// parcourt qu'un arc de quelques dixiemes de millimetre, et c'est tout ce
// dont le levier dispose pour faire avancer l'etoile des mois d'une dent.
// Donnee en dents au-dela de N.
const PERP_MONTH_WINDOW_MAX = 0.97;

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
const PERP_WATCH_LOW_BELOW = 1.0;
const PERP_WATCH_TOP_ABOVE = 1.3;
const PERP_WATCH_TIMING = {
  nightStart: 20.0,
  liftStart: 20.0, // le limacon commence a lever la grande bascule
  liftTop: 23.8, // butee haute : cliquets en fin de course
  dropStart: 23.9, // chute du limacon : le ressort ramene la bascule sur la came
  dropEnd: 24.0,
};

/** Parametres propres a chaque construction. */
const PERP_KIND_SPECS = {
  pendule: { lowBelow: PERP_LOW_BELOW, topAbove: PERP_TOP_ABOVE, restOffset: PERP_REST_OFFSET, timing: PERP_TIMING },
  montre: { lowBelow: PERP_WATCH_LOW_BELOW, topAbove: PERP_WATCH_TOP_ABOVE, restOffset: PERP_WATCH_REST_OFFSET, timing: PERP_WATCH_TIMING },
};

/**
 * Reperes d'une construction pour un calendrier, en dents de l'etoile de
 * quantieme : N dents, mois de `lengths` jours. En gregorien (N = 31, mois
 * de 28 a 31 jours) on retrouve les valeurs de toujours : limacon de 27,8 a
 * 32,3 pour la pendule, de 27 a 32,3 pour la montre.
 */
function perpSpec(kind, cal) {
  const base = PERP_KIND_SPECS[kind];
  const N = cal.dateTeeth;
  const sat = cal.program.satellite;
  // longueurs que prend, selon l'annee, le mois lu par le satellite
  const read = sat ? Array.from({ length: cal.cycleYears }, (_, cy) => cal.monthLength(sat.readMonth, cy)) : null;
  return {
    ...base,
    N,
    lengths: cal.lengths,
    lowP: Math.min(...cal.lengths) - base.lowBelow,
    topP: N + base.topAbove,
    satelliteLengths: read ? [Math.min(...read), Math.max(...read)] : null,
  };
}

/** Longueur du mois `month` (0..11) dans l'annee `cycleYear` du cycle (0 = bissextile). */
function perpMonthLength(month, cycleYear) {
  return [31, cycleYear === 0 ? 29 : 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31][month];
}

// ------------------------------------------------------------------
// Calendriers et programmes
// ------------------------------------------------------------------

/**
 * Calendrier hegirien ARITHMETIQUE (tabulaire) : douze mois lunaires,
 * alternativement de 30 et 29 jours (Mouharram 30, Safar 29...), soit 354
 * jours ; Dhou al-hijja prend un 30e jour les annees abondantes, onze fois
 * par cycle de 30 ans. Le cycle compte exactement 10 631 jours et se repete
 * sans exception : c'est la seule regle, et une came peut la porter en
 * entier. Deux repartitions des annees abondantes circulent ; elles ne
 * different que par la 15e ou la 16e annee du cycle.
 *
 * Le calendrier religieux, lui, suit l'observation du croissant (ou le
 * calendrier Umm al-Qura, calcule) et s'ecarte de l'arithmetique d'un jour,
 * parfois deux, selon les mois : aucune came ne peut le prevoir, le
 * correcteur de quantieme est la pour cela.
 */
const PERP_HIJRI_LEAP_YEARS = {
  16: [2, 5, 7, 10, 13, 16, 18, 21, 24, 26, 29],
  15: [2, 5, 7, 10, 13, 15, 18, 21, 24, 26, 29],
};
// 1er Mouharram de l'an 1 : vendredi 16 juillet 622 julien, soit le 19
// juillet 622 du calendrier gregorien proleptique qu'utilise Date.UTC
const PERP_HIJRI_EPOCH = Math.round(Date.UTC(622, 6, 19) / 86400000);
const PERP_HIJRI_CYCLE_DAYS = 30 * 354 + 11;

const PERP_HIJRI_MONTH_LABELS = ["MOH", "SAF", "RAB I", "RAB II", "JOU I", "JOU II", "RAJ", "CHA", "RAM", "CHAW", "QIDA", "HIJ"];
const PERP_HIJRI_MONTH_NAMES = [
  "mouharram",
  "safar",
  "rabia al-awal",
  "rabia at-thani",
  "joumada al-oula",
  "joumada at-thania",
  "rajab",
  "chaabane",
  "ramadan",
  "chawwal",
  "dhou al-qi'da",
  "dhou al-hijja",
];

function perpHijriMonthLength(month, cycleYear, leapYears) {
  if (month === 11) return leapYears.includes(cycleYear + 1) ? 30 : 29;
  return month % 2 === 0 ? 30 : 29;
}

/** Date hegirienne arithmetique du jour `n` (numero de jour UTC). */
function perpHijriFromDayNumber(n, leapYears) {
  const days = n - PERP_HIJRI_EPOCH;
  const cycle = Math.floor(days / PERP_HIJRI_CYCLE_DAYS);
  let rest = days - cycle * PERP_HIJRI_CYCLE_DAYS;
  let cy = 0;
  while (rest >= 354 + (leapYears.includes(cy + 1) ? 1 : 0)) {
    rest -= 354 + (leapYears.includes(cy + 1) ? 1 : 0);
    cy++;
  }
  let m = 0;
  while (rest >= perpHijriMonthLength(m, cy, leapYears)) {
    rest -= perpHijriMonthLength(m, cy, leapYears);
    m++;
  }
  return { y: cycle * 30 + cy + 1, m, d: rest + 1, cycleYear: cy, weekday: perpCivilFromDayNumber(n).weekday };
}

/**
 * Le calendrier que le mecanisme doit suivre, et la facon dont il lit la
 * longueur du mois.
 *   - dateTeeth : dents de l'etoile de quantieme (le plus long mois) ;
 *   - lengths : longueurs de mois possibles, chacune un cran de came ;
 *   - cycleYears : annees apres lesquelles le programme revient a son depart.
 *     L'etat du mecanisme retient le mois k dans ce cycle (0..12.cycleYears-1) ;
 *   - program.positions : crans de la came programme. 48 : la came fait un
 *     tour en quatre ans, menee par le pignon des mois. 12 : elle est
 *     solidaire de l'etoile des mois et fait un tour par an ; un SATELLITE
 *     qu'elle porte donne alors la longueur du mois `readMonth` selon
 *     l'annee. Un doigt fixe le fait avancer d'un cran par tour, au passage
 *     au mois `stepMonth` -- six mois plus loin, pour qu'il ne bouge jamais
 *     sous le bec.
 */
function perpGregorianCalendar(id, program) {
  return {
    id,
    family: "gregorien",
    dateTeeth: 31,
    lengths: [28, 29, 30, 31],
    cycleYears: 4,
    cycleMonths: 48,
    monthLabels: PERP_MONTH_LABELS,
    monthNames: PERP_MONTH_NAMES,
    program,
    monthLength: perpMonthLength,
    fromDayNumber(n) {
      const c = perpCivilFromDayNumber(n);
      return { ...c, cycleYear: ((c.y % 4) + 4) % 4 };
    },
    format(c) {
      return perpFormatCivil(c);
    },
    cycleLabel(cy) {
      return cy === 0 ? "année bissextile" : `${cy}${cy === 1 ? "re" : "e"} année après bissextile`;
    },
  };
}

function perpHijriCalendar(variant) {
  const leapYears = PERP_HIJRI_LEAP_YEARS[variant] ?? PERP_HIJRI_LEAP_YEARS[16];
  return {
    id: `hegirien-${variant}`,
    family: "hegirien",
    variant,
    leapYears,
    dateTeeth: 30,
    lengths: [29, 30],
    cycleYears: 30,
    cycleMonths: 360,
    monthLabels: PERP_HIJRI_MONTH_LABELS,
    monthNames: PERP_HIJRI_MONTH_NAMES,
    program: { positions: 12, satellite: { positions: 30, readMonth: 11, stepMonth: 5 } },
    monthLength: (month, cy) => perpHijriMonthLength(month, cy, leapYears),
    fromDayNumber: (n) => perpHijriFromDayNumber(n, leapYears),
    format(c) {
      return `${PERP_DAY_NAMES[c.weekday]} ${c.d} ${PERP_HIJRI_MONTH_NAMES[c.m]} ${c.y} H.`;
    },
    cycleLabel(cy) {
      return `${cy + 1}${cy === 0 ? "re" : "e"} année du cycle de 30 ans, ${leapYears.includes(cy + 1) ? "abondante (355 j)" : "commune (354 j)"}`;
    },
  };
}

/** Calendrier d'apres son identifiant (panneau) ; le gregorien a 48 mois par defaut. */
function perpCalendar(id) {
  if (id === "gregorien-12") return perpGregorianCalendar(id, { positions: 12, satellite: { positions: 4, readMonth: 1, stepMonth: 7 } });
  if (id === "hegirien-15") return perpHijriCalendar(15);
  if (id === "hegirien-16") return perpHijriCalendar(16);
  return perpGregorianCalendar("gregorien-48", { positions: 48 });
}

/** Longueur du mois porte par la position `k` du cycle (0..cycleMonths-1). */
function perpCycleLength(cal, k) {
  return cal.monthLength(k % 12, Math.floor(k / 12));
}

/** Etat du mecanisme regle sur le jour `n` (numero de jour UTC). */
function perpStateFromDay(cal, n) {
  const c = cal.fromDayNumber(n);
  return { p: c.d, w: c.weekday, k: 12 * c.cycleYear + c.m };
}

/**
 * Position du satellite (came de 12 mois) quand le mecanisme est au mois k :
 * l'annee dont il donnera le prochain mois `readMonth`. Il a change au
 * dernier passage au mois `stepMonth`.
 */
function perpSatelliteIndex(cal, k) {
  const sat = cal.program.satellite;
  const year = Math.floor(k / 12);
  const month = k % 12;
  const index = year + (month >= sat.stepMonth ? 0 : -1) + (sat.stepMonth > sat.readMonth ? 1 : 0);
  return ((index % cal.cycleYears) + cal.cycleYears) % cal.cycleYears;
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
 *
 * La came de 12 mois est solidaire de l'etoile des mois, a un autre etage :
 * elle peut deborder de l'etoile. `program.camRadius` est son rayon
 * exterieur ; son satellite se loge entre le cran qu'il remplit et l'arbre.
 */
function perpDimensions(plateRadius, kind = "pendule", cal = perpCalendar()) {
  const k = plateRadius / 15;
  const star = (teeth, tip, rootRatio) => {
    const root = tip * rootRatio;
    return { teeth, tip, root, engage: (tip + root) / 2, pitch: (2 * Math.PI) / teeth };
  };
  const yearly = cal.program.positions === 12;
  return {
    k,
    // deux goupilles sur l'etoile de quantieme : celle de fin de mois (grand
    // levier) et celle des mois, un peu plus au bord pour allonger son arc
    date: { ...star(cal.dateTeeth, 2.6 * k, 0.86), pin: 1.75 * k, monthPin: 1.95 * k },
    day: star(PERP_DAY_TEETH, (kind === "montre" ? 0.8 : 1.75) * k, 0.6),
    month: star(PERP_MONTH_TEETH, (kind === "montre" ? 1.0 : 1.95) * k, 0.72),
    hourWheel: { teeth: 30, module: 0.1 * k },
    wheel24: { teeth: 60, module: 0.1 * k },
    program: yearly
      ? { positions: 12, camRadius: 2.3 * k, satellite: cal.program.satellite }
      : { positions: PERP_PROGRAM_TEETH, teeth: PERP_PROGRAM_TEETH, module: 0.1 * k },
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

/** Rayon exterieur de la came programme : sa roue (48 mois) ou la came elle-meme (12 mois). */
function perpProgramRadius(dim) {
  return dim.program.camRadius ?? perpTipRadius(dim.program);
}

/**
 * Satellite de la came de 12 mois. Son centre est sur le rayon du cran qu'il
 * remplit, a `rS` de l'arbre ; chacun de ses lobes, tourne vers l'exterieur,
 * arrete le bec au rayon du mois lu cette annee-la. `lo` et `hi` : rayons de
 * came du mois lu le plus court et le plus long. Le lobe court garde une
 * longueur utile ; le long, en tournant, ne doit pas atteindre l'arbre.
 */
function perpSatelliteGeometry(lo, hi, dim) {
  const k = dim.k;
  const lobeMin = 0.25 * k;
  const rS = lo - lobeMin;
  const inner = rS - (hi - rS);
  return { rS, lobeMin, inner, ok: inner >= dim.arborClearance };
}

function perpSatelliteFits(lo, hi, dim) {
  return perpSatelliteGeometry(lo, hi, dim).ok;
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
