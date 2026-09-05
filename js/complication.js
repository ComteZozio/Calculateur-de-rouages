/**
 * complication.js
 * Une "complication" est un groupe de rouages qui realise un ratio entre
 * une roue d'entree et une roue de sortie. Plusieurs complications peuvent
 * coexister sur la meme platine :
 *   - independantes (elles ne partagent que la platine) ;
 *   - entree COAXIALE avec une roue d'une complication precedente (montee
 *     sur le meme arbre, elle tourne avec elle) ;
 *   - entree ENGRENEE sur une roue d'une complication precedente (le ratio
 *     est alors mesure depuis cette roue motrice).
 * Chaque engrenement peut recevoir des roues de renvoi : elles ne changent
 * pas le ratio (leurs dents se simplifient) mais inversent le sens de
 * rotation et ecartent les mobiles -- utile pour eviter un recouvrement.
 */

/**
 * Nombre maximal d'etages d'une chaine simple (2 mobiles par etage, donc
 * jusqu'a 8 roues). Trois suffisent aux cibles de la bibliotheque (la plus
 * lourde, 1 tour par an, demande 365 de demultiplication) ; le quatrieme
 * sert aux tres grandes demultiplications et aux repartitions plus douces
 * (des rapports par etage plus proches de 1 usent moins les dentures).
 * Le nombre de sequences monotones de modules croit comme C(m + k - 1, k) :
 * au-dela de trois etages il est PLAFONNE (MAX_MODULE_SEQUENCES), sans quoi
 * une plage de modules large ferait exploser la recherche de placement.
 */
const MAX_STAGES = 4;

/**
 * Annee tropique, en jours. Sert a la fois aux cibles de vitesse de la
 * bibliotheque et aux profils de came, qui font tous un tour par an.
 * Declaree ici, avant tout ce qui s'en sert : un `const` reference avant
 * sa ligne de declaration leve une ReferenceError des le chargement.
 */
const TROPICAL_YEAR = 365.2422;

/** Modules "ronds" classiques en horlogerie, essayes en priorite. */
const STANDARD_MODULES = [0.05, 0.06, 0.07, 0.08, 0.09, 0.1, 0.12, 0.15, 0.18, 0.2, 0.25, 0.3, 0.35, 0.4, 0.45, 0.5, 0.6, 0.7, 0.8, 0.9, 1.0, 1.25, 1.5, 2.0];

function standardModulesIn(min, max) {
  return STANDARD_MODULES.filter((m) => m >= min - 1e-9 && m <= max + 1e-9);
}

function nearestStandardModule(value, min, max) {
  const candidates = standardModulesIn(min, max);
  if (!candidates.length) return value;
  return candidates.reduce((best, m) => (Math.abs(m - value) < Math.abs(best - value) ? m : best), candidates[0]);
}

/**
 * Pas en dessous duquel un module n'a plus de sens pratique. Un module de
 * 0,25 ou de 0,26 se taille et se controle ; 0,25118161 ne veut rien dire
 * pour un outilleur. Tout module calcule est donc ramene a ce pas -- et
 * deux modules qui n'en different que par du bruit numerique (0,2501 et
 * 0,25) sont le meme module.
 */
const MODULE_GRAIN = 0.01;

function snapModule(value, grain = MODULE_GRAIN) {
  return Math.round(Math.round(value / grain) * grain * 1e6) / 1e6;
}

/** Ecart au module normalise le plus proche : 0 pour 0,25, faible pour 0,26. */
function moduleOddity(value) {
  return STANDARD_MODULES.reduce((best, m) => Math.min(best, Math.abs(m - value)), Infinity);
}

function gcdInt(a, b) {
  a = Math.abs(Math.round(a));
  b = Math.abs(Math.round(b));
  while (b) {
    const t = a % b;
    a = b;
    b = t;
  }
  return a;
}

// ------------------------------------------------------------------
// Vitesses de rotation et bibliotheque de complications
// ------------------------------------------------------------------

/**
 * Unites acceptees pour exprimer la vitesse d'un mobile, toutes ramenees
 * en TOURS PAR HEURE. Les unites "x/tr" expriment la duree d'un tour, de
 * loin la forme la plus naturelle en horlogerie : une phase de lune se
 * pense en "1 tour en 29,53 jours", pas en "0,00141 tour par heure".
 */
const SPEED_UNITS = {
  "tr/min": (v) => v * 60,
  "tr/h": (v) => v,
  "tr/j": (v) => v / 24,
  "min/tr": (v) => 60 / v,
  "h/tr": (v) => 1 / v,
  "j/tr": (v) => 1 / (24 * v),
};

const SPEED_UNIT_LABELS = {
  "tr/min": "tours / min",
  "tr/h": "tours / heure",
  "tr/j": "tours / jour",
  "min/tr": "minutes / tour",
  "h/tr": "heures / tour",
  "j/tr": "jours / tour",
};

function toTurnsPerHour(value, unit) {
  const convert = SPEED_UNITS[unit];
  if (!convert || !Number.isFinite(value) || value === 0) return NaN;
  const v = convert(value);
  return Number.isFinite(v) ? v : NaN;
}

/**
 * Vitesse SIGNEE, zero admis. Un differentiel s'etudie mode par mode, et
 * dans chaque mode l'un des membres est souvent tenu immobile : « zero tour
 * par heure » y est une donnee parfaitement legitime, la ou elle n'aurait
 * aucun sens comme cible d'un train ordinaire. Le signe compte tout autant
 * -- c'est lui qui dit dans quel sens l'aiguille se deplace.
 * Une duree de tour nulle resterait absurde : seules les unites « tours par
 * ... » acceptent zero.
 */
function signedTurnsPerHour(speed) {
  if (!speed || !SPEED_UNITS[speed.unit] || !Number.isFinite(speed.value)) return NaN;
  if (speed.value === 0) return speed.unit.startsWith("tr/") ? 0 : NaN;
  const v = SPEED_UNITS[speed.unit](speed.value);
  return Number.isFinite(v) ? v : NaN;
}

/**
 * Rapport de base d'un DIFFERENTIEL, deduit des trois vitesses au lieu
 * d'etre demande tel quel. C'est la formule de Willis lue a l'envers :
 *
 *     R = (w_B - w_U) / (w_A - w_U)
 *
 * Demander « un ratio » n'a pas de sens ici : un differentiel n'a pas un
 * rapport d'entree a sortie, il a une relation entre trois mobiles. Ce que
 * l'on sait poser, c'est la vitesse de chaque planetaire dans un mode de
 * fonctionnement donne et celle que doit prendre la cage ; R s'en deduit.
 */
function differentialBasicRatio(comp) {
  const wA = signedTurnsPerHour(comp.diff?.a);
  const wB = signedTurnsPerHour(comp.diff?.b);
  const wU = signedTurnsPerHour(comp.diff?.u);
  if (![wA, wB, wU].every(Number.isFinite)) return NaN;
  if (Math.abs(wA - wU) < 1e-12) return NaN; // cage et planetaire A confondus : R indetermine
  return (wB - wU) / (wA - wU);
}

/**
 * Comportement du differentiel dans les deux modes ou un planetaire est
 * tenu : c'est ainsi que fonctionne un indicateur de reserve de marche
 * (barillet bloque pendant le remontage, arbre bloque en marche). Une fois
 * R choisi, ces deux modes ne sont plus libres -- autant les afficher.
 */
/**
 * Domaine atteignable pour la vitesse de la cage, connaissant les deux
 * planetaires et le signe de rapport de base impose par le type.
 *
 * R = (w_B - w_U) / (w_A - w_U) s'annule en w_U = w_B et diverge en
 * w_U = w_A. Entre les deux, numerateur et denominateur sont de signes
 * contraires, donc R < 0 ; au-dela, de meme signe, donc R > 0. Autrement
 * dit :
 *
 *   types 1 et 2 (R < 0) : la cage tourne FORCEMENT entre les deux
 *     planetaires -- c'est le differentiel moyenneur ;
 *   types 3 et 4 (R > 0) : la cage tourne FORCEMENT hors de l'intervalle,
 *     elle amplifie l'ecart.
 *
 * Ce n'est pas une limite du programme : c'est ce que le type de train
 * autorise. Autant le dire avec des valeurs plutot que de renvoyer une
 * liste vide.
 */
function differentialCarrierRange(comp) {
  const wA = signedTurnsPerHour(comp.diff?.a);
  const wB = signedTurnsPerHour(comp.diff?.b);
  if (![wA, wB].every(Number.isFinite) || wA === wB) return null;
  const lo = Math.min(wA, wB);
  const hi = Math.max(wA, wB);
  const inside = epicyclicSignOfType(comp) < 0;

  // Le type 1 ajoute sa propre borne : son satellite unique impose
  // a = (B - A)/2 > 0, donc |R| = A/B < 1. Or |R| < 1 equivaut a
  // |w_B - w_U| < |w_A - w_U| : la cage doit rester PLUS PROCHE du
  // planetaire B que du planetaire A. Proposer le milieu de l'intervalle
  // tomberait pile sur la frontiere |R| = 1, donc hors d'atteinte.
  const nearB = !epicyclicType(comp).compound;

  return {
    lo,
    hi,
    inside,
    nearB,
    suggestion: nearB ? wB + 0.25 * (wA - wB) : inside ? (lo + hi) / 2 : hi + (hi - lo),
  };
}

/**
 * Ce que devient le differentiel dans les deux modes ou un planetaire est
 * tenu -- ceux d'un indicateur de reserve de marche : barillet tenu pendant
 * le remontage, arbre tenu en marche. Une fois R choisi, ces deux modes ne
 * sont plus libres.
 *
 * Willis se relit ainsi :
 *     w_U = [-R/(1-R)].w_A + [1/(1-R)].w_B
 * et les deux coefficients somment TOUJOURS a 1. La cage ne lit donc jamais
 * une difference, seulement une moyenne ponderee : c'est le rouage
 * d'attaque des deux planetaires qui fournit l'inversion de sens, pas le
 * differentiel. En revanche |R| = 1 egalise les deux coefficients, et
 * l'aiguille parcourt alors le meme angle par tour dans les deux modes.
 */
function differentialModes(comp, basicRatio) {
  if (!Number.isFinite(basicRatio) || Math.abs(1 - basicRatio) < 1e-12) return null;
  const perTurnOfA = -basicRatio / (1 - basicRatio); // planetaire B tenu
  const perTurnOfB = 1 / (1 - basicRatio); // planetaire A tenu
  const wA = signedTurnsPerHour(comp.diff?.a);
  const wB = signedTurnsPerHour(comp.diff?.b);
  return {
    perTurnOfA,
    perTurnOfB,
    balanced: Math.abs(Math.abs(perTurnOfA) - Math.abs(perTurnOfB)) < 1e-9,
    wA,
    wB,
    bHeld: Number.isFinite(wA) && wA !== 0 ? perTurnOfA * wA : null,
    aHeld: Number.isFinite(wB) && wB !== 0 ? perTurnOfB * wB : null,
  };
}

/**
 * Ratio effectivement recherche : soit celui saisi directement, soit celui
 * deduit des deux vitesses. La convention est celle de
 * computeRatioExponents : ratio = vitesse(sortie) / vitesse(entree).
 */
function effectiveRatio(comp) {
  // un differentiel ne se donne pas un ratio : il se donne trois vitesses
  if (comp.topology === "epicyclic" && comp.fixedMember === "none") return differentialBasicRatio(comp);
  if (comp.ratioMode !== "speeds") return comp.ratio;
  const inH = toTurnsPerHour(comp.speedIn.value, comp.speedIn.unit);
  const outH = toTurnsPerHour(comp.speedOut.value, comp.speedOut.unit);
  if (!Number.isFinite(inH) || !Number.isFinite(outH) || inH === 0) return NaN;
  return outH / inH;
}

/** Duree d'un tour, formatee dans l'unite la plus lisible. */
function formatPeriod(turnsPerHour) {
  if (!Number.isFinite(turnsPerHour) || turnsPerHour === 0) return "?";
  const hours = Math.abs(1 / turnsPerHour);
  if (hours < 1 / 60) return (hours * 3600).toPrecision(4) + " s";
  if (hours < 1) return (hours * 60).toPrecision(4) + " min";
  if (hours < 48) return hours.toPrecision(4) + " h";
  const days = hours / 24;
  if (days < 400) return days.toPrecision(6) + " j";
  return (days / 365.2422).toPrecision(4) + " ans";
}

/**
 * Complications horlogeres classiques. Un preset decrit une CIBLE et le
 * gabarit qui permet de l'atteindre : vitesses entree/sortie, nombre
 * d'etages et bornes de dents. Ces trois elements vont ensemble -- un
 * quantieme se taille avec des pignons de 6 et des roues jusqu'a 72, pas
 * avec la plage generique 8..60, et la meilleure solution disponible
 * change completement selon la plage autorisee.
 *
 * Chaque preset a ete verifie realisable : la tolerance annoncee est
 * atteinte par au moins une combinaison de dents dans ces bornes.
 * Constantes : lunaison synodique 29,530588 j, annee tropique
 * 365,242190 j.
 */
const COMPLICATION_LIBRARY = [
  {
    id: "sec-min",
    label: "Secondes → minutes (1/60)",
    speedIn: { value: 1, unit: "tr/min" },
    speedOut: { value: 1, unit: "tr/h" },
    stages: 2,
    bounds: { min: 8, max: 80 },
    tol: 1e-9,
    note: "Rouage de base. Exact : 8/60 puis 8/64, ou toute autre décomposition de 60.",
  },
  {
    id: "min-heure",
    label: "Minutes → heures (1/12)",
    speedIn: { value: 1, unit: "tr/h" },
    speedOut: { value: 12, unit: "h/tr" },
    stages: 1,
    bounds: { min: 6, max: 72 },
    tol: 1e-9,
    note: "Cadrature classique : la chaussée porte un pignon de 6 qui entraîne une roue de 72. Exact.",
  },
  {
    id: "heure-24h",
    label: "Heures → affichage 24 h (1/2)",
    speedIn: { value: 12, unit: "h/tr" },
    speedOut: { value: 24, unit: "h/tr" },
    stages: 1,
    bounds: { min: 8, max: 60 },
    tol: 1e-9,
    note: "Disque jour/nuit ou seconde zone, entraîné par la roue des heures. Exact (rapport 1:2).",
  },
  {
    id: "quantieme",
    label: "Quantième — disque 31 jours",
    speedIn: { value: 1, unit: "j/tr" },
    speedOut: { value: 31, unit: "j/tr" },
    stages: 2,
    bounds: { min: 6, max: 72 },
    tol: 1e-9,
    note:
      "Exact, et la roue de 31 dents apparaît naturellement. Le saut de date et la correction des mois courts restent l'affaire d'un doigt sauteur, pas du rouage.",
  },
  {
    id: "semaine",
    label: "Jour de la semaine — 7 jours",
    speedIn: { value: 1, unit: "j/tr" },
    speedOut: { value: 7, unit: "j/tr" },
    stages: 1,
    bounds: { min: 8, max: 60 },
    tol: 1e-9,
    note: "Disque à 7 positions entraîné par la roue de 24 h. Exact : 8/56.",
  },
  {
    id: "lune-1",
    label: "Phase de lune — disque 1 lunaison",
    speedIn: { value: 1, unit: "j/tr" },
    speedOut: { value: 29.530588, unit: "j/tr" },
    stages: 2,
    bounds: { min: 8, max: 60 },
    tol: 5e-7,
    note: "Lunaison synodique. Le meilleur train à deux étages dérive d'environ 24 s par lunaison.",
  },
  {
    id: "lune-2",
    label: "Phase de lune — disque 2 lunaisons (59 dents)",
    speedIn: { value: 1, unit: "j/tr" },
    speedOut: { value: 59.061176, unit: "j/tr" },
    stages: 2,
    bounds: { min: 8, max: 80 },
    tol: 5e-7,
    note: "Le disque classique porte deux lunes et fait un tour en deux lunaisons. Dérive d'environ 2 min par tour.",
  },
  {
    id: "equation-temps-came",
    label: "Équation du temps — came sur roue annuelle",
    speedIn: { value: 1, unit: "j/tr" },
    speedOut: { value: TROPICAL_YEAR, unit: "j/tr" },
    stages: 3,
    bounds: { min: 8, max: 80 },
    tol: 2e-8,
    cam: { enabled: true, profile: "equation-temps", baseRadius: 3, amplitude: 1.2, followerAngle: 270, latitude: 46.2 },
    note:
      "Roue annuelle portant la came d'équation. Aucun rapport d'engrenage ne peut produire l'équation du temps : il faut une pièce dont le rayon encode la fonction, et un palpeur qui la lit. La came ne vaut que si le mobile qui la porte fait exactement un tour par an — le programme le vérifie.",
  },
  {
    id: "equation-rateau",
    label: "Équation du temps — râteau pour différentiel",
    speedIn: { value: 1, unit: "j/tr" },
    speedOut: { value: TROPICAL_YEAR, unit: "j/tr" },
    stages: 3,
    bounds: { min: 8, max: 80 },
    tol: 2e-8,
    cam: {
      enabled: true,
      profile: "equation-temps",
      followerType: "angulaire",
      followerAngle: 270,
      pivotDistance: 8.2,
      leverLength: 6.4,
      swingAngle: 12,
      restAngle: 30,
      rollerRadius: 0.15,
      correctedTurnHours: 24,
      baseRadius: 3,
      amplitude: 1.2,
      latitude: 46.2,
    },
    note:
      "Roue annuelle, came d'équation lue par un râteau pivoté. Le profil est synthétisé depuis la course angulaire voulue, si bien que l'angle du râteau est exactement proportionnel à l'équation du temps — c'est ce qui permet de l'injecter dans la seconde entrée d'un différentiel. La note indique le rapport à interposer pour que la correction tombe juste sur la roue de 24 h.",
  },
  {
    id: "lever-soleil-came",
    label: "Heure de lever du soleil — came annuelle",
    speedIn: { value: 1, unit: "j/tr" },
    speedOut: { value: TROPICAL_YEAR, unit: "j/tr" },
    stages: 3,
    bounds: { min: 8, max: 80 },
    tol: 2e-8,
    cam: { enabled: true, profile: "lever-soleil", baseRadius: 3, amplitude: 1.6, followerAngle: 270, latitude: 46.2 },
    note:
      "Même roue annuelle, came taillée sur l'heure du lever à la latitude choisie. Le profil se creuse fortement avec la latitude : quasi plat à l'équateur, il devient impraticable au-delà du cercle polaire, où le soleil ne se lève plus certains jours.",
  },
  {
    id: "annee",
    label: "Mois / équation du temps — 1 tour par an",
    speedIn: { value: 1, unit: "j/tr" },
    speedOut: { value: 365.24219, unit: "j/tr" },
    stages: 3,
    bounds: { min: 8, max: 80 },
    tol: 2e-8,
    note:
      "Année tropique : came d'équation du temps ou disque des mois. Dérive d'environ 100 s par an. Recherche longue (le balayage porte sur ~300 000 combinaisons).",
  },
  {
    id: "reserve-marche",
    label: "Réserve de marche — différentiel",
    topology: "epicyclic",
    epiType: 2,
    fixedMember: "none",
    // mode de reference : barillet tenu pendant le remontage, l'arbre fait
    // un tour, l'aiguille un demi-tour. Il en decoule R = -1.
    diff: {
      a: { value: 1, unit: "tr/h" },
      b: { value: 0, unit: "tr/h" },
      u: { value: 0.5, unit: "tr/h" },
    },
    bounds: { min: 8, max: 60 },
    tol: 1e-9,
    note:
      "Différentiel classique (Augereau XV.6.2) : un planétaire suit l'arbre de barillet, l'autre le barillet, et la cage commande l'aiguille. La condition propre à cet indicateur est R = −1, seule solution de |−R/(1−R)| = |1/(1−R)| : l'aiguille parcourt alors le même angle par tour qu'on remonte le ressort ou que la montre le déroule. La cage y lit la moyenne exacte des deux planétaires — l'inversion de sens entre les deux modes vient du rouage d'attaque (F/C et G/H chez Augereau), pas du différentiel lui-même.",
  },
  {
    id: "reducteur-planetaire",
    label: "Réducteur planétaire — planétaire A bloqué",
    ratioMode: "direct",
    ratio: 2.4,
    topology: "epicyclic",
    epiType: 2,
    fixedMember: "A",
    bounds: { min: 8, max: 60 },
    tol: 1e-9,
    note:
      "Train épicycloïdal en réducteur : le planétaire A est immobilisé, la cage mène, le planétaire B suit selon ω_B = (1 − R)·ω_U. Les deux engrènements doivent avoir le même entraxe (2D = m_A(A+a) = m_B(B−b)).",
  },
  {
    id: "tourbillon",
    label: "Tourbillon — cage 1 tour / minute",
    speedIn: { value: 1, unit: "tr/h" },
    speedOut: { value: 1, unit: "tr/min" },
    stages: 2,
    bounds: { min: 8, max: 80 },
    tol: 1e-9,
    note: "Multiplication x60 depuis la roue des minutes vers la cage. Exact : 60/8 puis 64/8.",
  },
];

function libraryPreset(id) {
  return COMPLICATION_LIBRARY.find((p) => p.id === id) ?? null;
}

/**
 * ASSEMBLAGES : montages qui demandent PLUSIEURS complications reliees
 * entre elles. Un preset ordinaire ne decrit qu'une complication ; certains
 * mecanismes n'ont de sens qu'a plusieurs -- l'equation marchante tient
 * dans le couple « train epicycloidal + roue annuelle a came », dont
 * aucune moitie ne se comprend seule.
 *
 * `carrierTargetIndex` designe la complication dont la cage sera poussee,
 * par son rang : les etiquettes (C1, C2...) ne sont connues qu'a la
 * creation.
 */
const ASSEMBLY_LIBRARY = [
  {
    id: "equation-marchante",
    label: "Équation marchante — différentiel + came annuelle",
    // ce montage ne tient pas sous ~31 mm : l'assemblage pose lui-meme la
    // platine, faute de quoi il echouerait des l'ouverture
    plateDiameter: 36,
    note:
      "Le montage classique de l'équation du temps affichée en marche. Le train épicycloïdal réduit de 12 h à 24 h, cage nominalement fixe. La roue annuelle porte la came d'équation, et son bras porte-galet EST cette cage : en la déplaçant, il ajoute ou retranche l'équation du temps à la sortie, sans jamais interrompre le rouage. La course de la cage se déduit de la correction voulue, et le bras impose l'entraxe entre les deux axes — le placeur le tient.",
    complications: [
      {
        // le reducteur : 1 tour en 12 h a l'entree, 1 tour en 24 h en sortie
        topology: "epicyclic",
        epiType: 4,
        fixedMember: "U",
        ratioMode: "speeds",
        speedIn: { value: 12, unit: "h/tr" },
        speedOut: { value: 24, unit: "h/tr" },
        tol: 1e-9,
      },
      {
        // la roue annuelle et sa came, dont le bras pousse la cage ci-dessus
        preset: "equation-rateau",
        cam: { drives: "porte-satellites" },
        carrierTargetIndex: 0,
      },
    ],
  },
];

function libraryAssembly(id) {
  return ASSEMBLY_LIBRARY.find((a) => a.id === id) ?? null;
}

/**
 * Applique un preset : passe en mode vitesses et recopie son gabarit
 * complet. Les bornes sont posees APRES les etages, puisque la liste des
 * mobiles en depend.
 */
function applyLibraryPreset(comp, id) {
  const preset = libraryPreset(id);
  comp.preset = preset ? id : "none";
  if (!preset) return;
  // certains presets se donnent en ratio direct (un rapport de base
  // epicycloidal n'a pas de sens en « vitesses entree / sortie »)
  comp.ratioMode = preset.ratioMode ?? "speeds";
  if (preset.speedIn) comp.speedIn = { ...preset.speedIn };
  if (preset.speedOut) comp.speedOut = { ...preset.speedOut };
  if (preset.ratio !== undefined) comp.ratio = preset.ratio;
  comp.topology = preset.topology ?? "compound";
  if (preset.epiType !== undefined) comp.epiType = preset.epiType;
  if (preset.fixedMember !== undefined) comp.fixedMember = preset.fixedMember;
  if (preset.diff) comp.diff = JSON.parse(JSON.stringify(preset.diff));
  comp.cam = preset.cam ? JSON.parse(JSON.stringify(preset.cam)) : { ...comp.cam, enabled: false };
  if (preset.stages !== undefined) setStages(comp, preset.stages);
  if (preset.tol !== undefined) comp.tol = preset.tol;
  if (preset.bounds) {
    comp.bounds = {};
    for (const local of localWheelNames(comp)) comp.bounds[local] = { ...preset.bounds, fixed: false };
  }
}

const SENS_LABELS = { 1: "horaire", "-1": "antihoraire" };
const SENS_GLYPHS = { 1: "↻", "-1": "↺" };

function sensLabel(sens) {
  if (sens === undefined || sens === null) return "indéterminé";
  return `${SENS_LABELS[sens]} ${SENS_GLYPHS[sens]}`;
}

let complicationCounter = 0;

function createComplication(init = {}, earlierComps = []) {
  complicationCounter += 1;
  const comp = {
    id: complicationCounter,
    label: `C${complicationCounter}`,
    ratio: 2.4,
    tol: 0.0001,
    // "direct" : le ratio est saisi tel quel ; "speeds" : il est deduit
    // des vitesses souhaitees a l'entree et a la sortie
    ratioMode: "direct",
    speedIn: { value: 1, unit: "tr/h" },
    speedOut: { value: 12, unit: "h/tr" },
    preset: "none",
    topology: "compound", // "compound" | "reverted" | "epicyclic"
    stages: 2,
    epiType: 2, // 1..4, types d'Augereau
    // membre immobilise d'un train epicycloidal : "U" (cage bloquee : train
    // ordinaire), "A", "B", ou "none" pour un vrai DIFFERENTIEL a deux
    // entrees motrices -- le cas de l'indicateur de reserve de marche.
    // Par defaut le planetaire A : la cage mene alors, et le rapport
    // 1 - R est superieur a 1, ce qui correspond au reglage courant.
    fixedMember: "A",
    // vitesses des trois membres pour un DIFFERENTIEL : deux planetaires et
    // la cage, dans un mode de fonctionnement donne. Le rapport de base s'en
    // deduit par Willis. Le mode par defaut tient le planetaire B immobile.
    diff: {
      a: { value: 1, unit: "tr/h" },
      b: { value: 0, unit: "tr/h" },
      u: { value: 0.5, unit: "tr/h" },
    },
    // kind : "none" | "coaxial" (entree montee sur l'arbre de `wheel`) | "mesh" (entree engrenee
    // sur `wheel`) | "shared" (l'entree EST `wheel`, roue existante d'une autre complication)
    link: { kind: "none", wheel: null },
    fixed: { entree: null, sortie: null }, // positions imposees par clic, en mm, ou null
    drawWhenCollapsed: true,
    bounds: {}, // nom local -> { min, max, fixed }
    internal: {}, // nom local -> denture interieure (couronne annulaire)
    entree: null, // nom local
    sortie: null, // nom local
    sensEntree: 1, // +1 horaire, -1 antihoraire (ignore si raccordee : herite)
    sensSortie: 0, // 0 indifferent, +1 horaire, -1 antihoraire
    idlers: {}, // cle d'engrenement de base -> { count, min, max }
    autoIdlerMesh: null, // cle d'engrenement ou poser le renvoi automatique
    candidates: [],
    selected: null,
    truncated: false,
    searchNote: "",
    collapsed: false,
    ...init,
  };
  normalizeComplication(comp, earlierComps);
  return comp;
}

// ------------------------------------------------------------------
// Structure locale (independante des dents)
// ------------------------------------------------------------------

/**
 * Change le nombre d'etages d'une chaine simple. La sortie SUIT le dernier
 * pignon : c'est lui qui sort du train, et normalizeComplication ne la
 * deplacerait pas toute seule en ajoutant un etage (l'ancien nom, pignon2
 * par exemple, reste valide dans une chaine plus longue). Rien n'empeche
 * de la remettre ensuite sur un mobile intermediaire.
 */
function setStages(comp, n) {
  comp.stages = Math.min(MAX_STAGES, Math.max(1, parseInt(n, 10) || 2));
  if (comp.topology === "compound") {
    comp.sortie = `pignon${comp.stages}`;
    if (comp.fixed) comp.fixed.sortie = null;
  }
}

/** Mobiles DENTES d'un train epicycloidal (la cage n'a pas de denture). */
function epicyclicWheelNames(comp) {
  return epicyclicType(comp).compound
    ? ["planetaire_a", "satellite_a", "satellite_b", "planetaire_b"]
    : ["planetaire_a", "satellite_a", "planetaire_b"];
}

function localWheelNames(comp) {
  if (comp.topology === "epicyclic") return epicyclicWheelNames(comp);
  if (comp.topology === "reverted") return ["roue_a_entree", "roue_b_satellite", "roue_c_sortie", "roue_d_satellite"];
  const names = [];
  for (let i = 1; i <= comp.stages; i++) names.push(`roue${i}`, `pignon${i}`);
  return names;
}

function localAxisGroups(comp) {
  const g = {};
  if (comp.topology === "epicyclic") {
    // les deux planetaires et la cage sont coaxiaux ; le satellite pivote
    // sur la cage, a l'entraxe D
    g.planetaire_a = "axe_central";
    g.planetaire_b = "axe_central";
    g.porte_satellites = "axe_central";
    g.satellite_a = "axe_satellite";
    g.satellite_b = "axe_satellite";
    return g;
  }
  if (comp.topology === "reverted") {
    g.roue_a_entree = "axe_principal";
    g.roue_c_sortie = "axe_principal";
    g.roue_b_satellite = "axe_satellite";
    g.roue_d_satellite = "axe_satellite";
    return g;
  }
  for (let i = 1; i <= comp.stages; i++) {
    g[`roue${i}`] = `axe_${i}`;
    g[`pignon${i}`] = `axe_${i + 1}`;
  }
  return g;
}

function localIndependentGroups(comp) {
  if (comp.topology === "epicyclic") return ["axe_central"];
  return comp.topology === "reverted" ? ["axe_principal"] : [];
}

/** Engrenements de base (avant insertion des renvois), dans l'ordre de construction. */
function localBaseMeshes(comp) {
  if (comp.topology === "epicyclic") {
    return epicyclicType(comp).compound
      ? [
          ["planetaire_a", "satellite_a"],
          ["satellite_b", "planetaire_b"],
        ]
      : [
          ["planetaire_a", "satellite_a"],
          ["satellite_a", "planetaire_b"],
        ];
  }
  if (comp.topology === "reverted") {
    return [
      ["roue_a_entree", "roue_b_satellite"],
      ["roue_c_sortie", "roue_d_satellite"],
    ];
  }
  const meshes = [];
  for (let i = 1; i <= comp.stages; i++) meshes.push([`roue${i}`, `pignon${i}`]);
  return meshes;
}

function baseMeshKey(pair) {
  return pair.join("|");
}

function baseMeshKeys(comp) {
  return localBaseMeshes(comp).map(baseMeshKey);
}

function baseMeshLabel(key) {
  return key.split("|").join(" ↔ ");
}

/** Cle de l'engrenement de base auquel appartient un mobile local. */
function baseMeshOfLocal(comp, local) {
  const pair = localBaseMeshes(comp).find((p) => p.includes(local));
  return pair ? baseMeshKey(pair) : null;
}

function globalName(comp, local) {
  return `${comp.label}.${local}`;
}

/** Nom global d'un mobile local, en tenant compte d'une entree partagee (roue existante). */
function resolveLocal(comp, local) {
  if (comp.link.kind === "shared" && comp.link.wheel && local === comp.entree) return comp.link.wheel;
  return globalName(comp, local);
}

/** Mobiles reellement crees par la complication (une entree partagee appartient a une autre). */
function ownLocalWheelNames(comp) {
  const names = localWheelNames(comp);
  return comp.link.kind === "shared" && comp.link.wheel ? names.filter((n) => n !== comp.entree) : names;
}

function localOf(name) {
  const idx = name.indexOf(".");
  return idx < 0 ? name : name.slice(idx + 1);
}

function compLabelOf(name) {
  const idx = name.indexOf(".");
  return idx < 0 ? name : name.slice(0, idx);
}

function ownerOf(comps, name) {
  const label = compLabelOf(name);
  return comps.find((c) => c.label === label) ?? null;
}

function idlerName(comp, meshIdx, j) {
  const suffix = j === 0 ? "" : String.fromCharCode(97 + j); // renvoi1, renvoi1b, renvoi1c...
  return globalName(comp, `renvoi${meshIdx + 1}${suffix}`);
}

/**
 * Engrenements de base rencontres sur le chemin cinematique entree->sortie
 * de la complication prise isolement, dans l'ordre de traversee.
 */
function pathBaseMeshKeys(comp) {
  // dans un train epicycloidal les deux engrenements sont sur le chemin,
  // mais dans le repere de la cage : la recherche de chemin ordinaire ne
  // les voit pas
  if (comp.topology === "epicyclic") return baseMeshKeys(comp);
  const isolated = { ...comp, link: { kind: "none", wheel: null } };
  const train = new GearTrain();
  buildComplicationInto(train, isolated, {});
  const order = meshOrderAlongPath(train, globalName(comp, comp.entree), globalName(comp, comp.sortie));
  if (!order) return [];
  const keys = [];
  for (const [a, b] of order) {
    const pair = localBaseMeshes(comp).find((p) => {
      const ga = globalName(comp, p[0]);
      const gb = globalName(comp, p[1]);
      return (ga === a && gb === b) || (ga === b && gb === a);
    });
    if (pair) keys.push(baseMeshKey(pair));
  }
  return keys;
}

/**
 * Une couronne doit avoir strictement plus de dents que le mobile qui
 * engrene dedans : l'entraxe vaut R - r, il serait nul ou negatif sinon.
 * Retourne la liste des violations pour un jeu de dents donne.
 */
function internalTeethViolations(comp, teethByLocal) {
  const problems = [];
  for (const [a, b] of localBaseMeshes(comp)) {
    const za = teethByLocal[a];
    const zb = teethByLocal[b];
    if (za === undefined || zb === undefined) continue;
    if (comp.internal[a] && za <= zb) problems.push(`${a} (Z=${za}) ≤ ${b} (Z=${zb})`);
    if (comp.internal[b] && zb <= za) problems.push(`${b} (Z=${zb}) ≤ ${a} (Z=${za})`);
  }
  return problems;
}

// ------------------------------------------------------------------
// Cames
// ------------------------------------------------------------------


/**
 * Equation du temps : temps solaire vrai moins temps solaire moyen, en
 * MINUTES, pour le jour `day` compte depuis le 1er janvier. Approximation
 * de la NOAA, exacte a environ un dixieme de minute -- largement en deca
 * de ce qu'une came peut restituer. Elle passe par -14,3 min a la
 * mi-fevrier et +16,4 min au debut de novembre, et s'annule quatre fois
 * dans l'annee : c'est ce profil en rein que porte la came d'equation.
 */
function equationOfTimeMinutes(day) {
  const g = ((2 * Math.PI) / TROPICAL_YEAR) * day;
  return (
    229.18 *
    (0.000075 +
      0.001868 * Math.cos(g) -
      0.032077 * Math.sin(g) -
      0.014615 * Math.cos(2 * g) -
      0.040849 * Math.sin(2 * g))
  );
}

/** Declinaison du Soleil, en radians (serie de Fourier NOAA). */
function solarDeclination(day) {
  const g = ((2 * Math.PI) / TROPICAL_YEAR) * day;
  return (
    0.006918 -
    0.399912 * Math.cos(g) +
    0.070257 * Math.sin(g) -
    0.006758 * Math.cos(2 * g) +
    0.000907 * Math.sin(2 * g) -
    0.002697 * Math.cos(3 * g) +
    0.00148 * Math.sin(3 * g)
  );
}

/**
 * Lever ou coucher du Soleil en TEMPS MOYEN LOCAL, minutes depuis minuit.
 * L'angle horaire se prend a 90,833 degres du zenith : 90 degres, plus la
 * refraction atmospherique et le demi-diametre solaire.
 * Retourne null les jours ou le Soleil ne se leve ni ne se couche -- au-dela
 * des cercles polaires, la complication n'a tout simplement pas de sens.
 */
function sunEventMinutes(day, latitudeDeg, rising) {
  const lat = (latitudeDeg * Math.PI) / 180;
  const dec = solarDeclination(day);
  const denom = Math.cos(lat) * Math.cos(dec);
  if (Math.abs(denom) < 1e-12) return null;
  const cosH = (Math.cos((90.833 * Math.PI) / 180) - Math.sin(lat) * Math.sin(dec)) / denom;
  if (cosH > 1 || cosH < -1) return null;
  const h = (Math.acos(cosH) * 180) / Math.PI;
  const eot = equationOfTimeMinutes(day);
  return rising ? 720 - 4 * h - eot : 720 + 4 * h - eot;
}

function formatClock(minutes) {
  const m = ((Math.round(minutes) % 1440) + 1440) % 1440;
  return `${String(Math.floor(m / 60)).padStart(2, "0")}:${String(m % 60).padStart(2, "0")}`;
}

/**
 * Profils de came disponibles. Chacun decrit une grandeur qui varie au
 * cours de l'annee et que le rouage ne sait PAS produire : aucun rapport
 * d'engrenage ne donne l'equation du temps, il faut une piece dont le
 * rayon encode la fonction, et un palpeur qui la lit.
 *
 * `turnPeriod` est la periode que doit avoir le mobile qui porte la came --
 * un tour par an pour toutes celles-ci. C'est une contrainte verifiable :
 * le programme compare a la vitesse reellement obtenue par le train.
 */
const CAM_PROFILES = {
  "equation-temps": {
    label: "Équation du temps",
    unit: "min",
    needsLatitude: false,
    turnPeriod: { value: TROPICAL_YEAR, unit: "j/tr" },
    sample: (turn) => equationOfTimeMinutes(turn * TROPICAL_YEAR),
    format: (v) => `${v >= 0 ? "+" : "−"}${Math.abs(v).toFixed(1)} min`,
    note:
      "Écart entre le temps solaire vrai et le temps moyen. Le profil en rein classique : deux bosses inégales, quatre passages à zéro dans l'année.",
  },
  "lever-soleil": {
    label: "Heure de lever du soleil",
    unit: "h",
    needsLatitude: true,
    turnPeriod: { value: TROPICAL_YEAR, unit: "j/tr" },
    sample: (turn, lat) => sunEventMinutes(turn * TROPICAL_YEAR, lat, true),
    format: (v) => formatClock(v),
    note: "Heure du lever en temps moyen local, à la latitude choisie. Le profil dépend fortement de celle-ci : plat à l'équateur, très creusé vers les pôles.",
  },
  "coucher-soleil": {
    label: "Heure de coucher du soleil",
    unit: "h",
    needsLatitude: true,
    turnPeriod: { value: TROPICAL_YEAR, unit: "j/tr" },
    sample: (turn, lat) => sunEventMinutes(turn * TROPICAL_YEAR, lat, false),
    format: (v) => formatClock(v),
    note: "Heure du coucher en temps moyen local. Symétrique du lever autour du midi solaire moyen, lui-même décalé par l'équation du temps.",
  },
};

// Les profils ne dependent que du type et de la latitude, jamais des dents
// ni des modules : les recalculer a chaque essai de placement serait du
// gaspillage pur.
const camSampleCache = new Map();

/**
 * Echantillonne un profil sur un tour complet. Retourne les valeurs
 * brutes, leur version normalisee dans [0, 1] (c'est elle qui devient le
 * rayon), et les extremes en unites reelles -- de quoi annoncer la course
 * du palpeur ET la plage affichee.
 */
function camProfileSamples(profileId, latitude, count = 360) {
  const profile = CAM_PROFILES[profileId];
  if (!profile) return null;
  const key = `${profileId}|${profile.needsLatitude ? latitude : 0}|${count}`;
  const cached = camSampleCache.get(key);
  if (cached) return cached;

  const raw = [];
  for (let i = 0; i < count; i++) {
    const v = profile.sample(i / count, latitude);
    raw.push(Number.isFinite(v) ? v : null);
  }
  const known = raw.filter((v) => v !== null);
  if (!known.length) return null;

  // Jour ou nuit polaire : on prolonge par la derniere valeur connue plutot
  // que de laisser un trou dans le profil. Le nombre de jours concernes est
  // remonte pour pouvoir le dire.
  const values = raw.slice();
  let undefinedDays = 0;
  let last = known[0];
  for (let i = 0; i < count; i++) {
    if (values[i] === null) {
      values[i] = last;
      undefinedDays++;
    } else {
      last = values[i];
    }
  }

  const min = Math.min(...values);
  const max = Math.max(...values);
  const span = max - min;
  const normalized = values.map((v) => (span > 1e-12 ? (v - min) / span : 0.5));
  const result = { values, normalized, min, max, undefinedDays, profileId, count };
  camSampleCache.set(key, result);
  return result;
}

// ------------------------------------------------------------------
// Palpeurs : lineaire (glissiere) ou angulaire (rateau pivote)
// ------------------------------------------------------------------

/**
 * Echantillon du profil present a un angle ECRAN donne, came tournee de
 * `turnDeg`. L'echantillon i est grave a l'angle local -dir.i.360/n, donc
 * il se presente a l'angle `screenDeg` quand
 *   -dir.i.360/n + turnDeg = screenDeg,  soit  i = dir.(turnDeg - screenDeg).n/360.
 */
function camIndexAtScreenAngle(cam, screenDeg, turnDeg) {
  const n = cam.samples.normalized.length;
  const dir = cam.direction ?? 1;
  const local = (((dir * (turnDeg - screenDeg)) % 360) + 360) % 360;
  return Math.round((local / 360) * n) % n;
}

/**
 * Grandeur encodee que le palpeur lit a l'echantillon `index`.
 *
 * ATTENTION au tableau : `samples.values` est indexe par le TEMPS, tandis
 * que l'indice de contact refere a la grille angulaire reechantillonnee de
 * la geometrie. Pour un palpeur lineaire les deux coincident ; pour un
 * palpeur angulaire, non -- le point de contact n'avance pas au meme rythme
 * que l'echantillon. Passer par ici evite de relire le mauvais.
 */
function camValueAt(cam, index) {
  const values = cam.geometry ? cam.geometry.values : cam.samples.values;
  return values[((index % values.length) + values.length) % values.length];
}

/** Rayon du profil a un angle ecran donne. */
function camRadiusAtScreenAngle(cam, screenDeg, turnDeg) {
  // la primitive : c'est le centre du galet qui suit cette courbe, pas le
  // point de contact sur la matiere
  const radii = cam.geometry ? cam.geometry.radii : null;
  const i = camIndexAtScreenAngle(cam, screenDeg, turnDeg);
  return radii ? radii[i] : cam.baseRadius + cam.amplitude * cam.samples.normalized[i];
}

/** Palpeur LINEAIRE : le galet coulisse sur un rayon, l'angle est donc fixe. */
function camSampleIndex(cam, turnDeg) {
  return camIndexAtScreenAngle(cam, cam.followerAngle, turnDeg);
}

/**
 * Palpeur ANGULAIRE : un levier pivote en P vient poser son bec sur la
 * came. Sa sortie n'est pas une course en millimetres mais un ANGLE -- ce
 * qui permet de l'injecter dans la seconde entree d'un differentiel, et
 * d'ajouter ou retrancher la grandeur portee par la came a une roue qui
 * tourne deja.
 *
 * La geometrie n'est pas celle du palpeur lineaire : le bec decrit un ARC
 * autour de P, pas un rayon issu du centre C de la came. Le point de
 * contact n'est donc plus a l'angle du palpeur, et son angle polaire psi
 * est solution implicite de
 *
 *     |PR|² = d² + r(psi)² - 2.d.r(psi).cos(psi - theta_P) = L²
 *
 * ou d = |CP| et L = |PR|. On la resout par balayage sur les echantillons
 * puis interpolation lineaire : le profil etant deja discretise en 360
 * points, chercher plus fin n'aurait pas de sens.
 */
function camLeverState(cam, turnDeg) {
  const d = cam.pivotDistance;
  const L = cam.leverLength;
  if (!(d > 0) || !(L > 0)) return null;

  const n = cam.samples.normalized.length;
  const step = 360 / n;
  const rad = (deg) => (deg * Math.PI) / 180;

  // ecart au carre entre la longueur imposee du levier et celle qu'il
  // faudrait pour toucher le profil a l'angle theta_P + delta
  const gap = (delta) => {
    const r = camRadiusAtScreenAngle(cam, cam.followerAngle + delta, turnDeg);
    return d * d + r * r - 2 * d * r * Math.cos(rad(delta)) - L * L;
  };

  let previous = gap(0);
  for (let delta = step; delta <= 180 + 1e-9; delta += step) {
    const current = gap(delta);
    if (previous === 0 || (previous < 0) !== (current < 0)) {
      const t = previous === current ? 0 : previous / (previous - current);
      const deltaRoot = delta - step + t * step;
      const psi = cam.followerAngle + deltaRoot;
      const r = camRadiusAtScreenAngle(cam, psi, turnDeg);
      // position du bec et du pivot, dans le repere de la came
      const bec = { x: r * Math.cos(rad(psi)), y: r * Math.sin(rad(psi)) };
      const pivot = { x: d * Math.cos(rad(cam.followerAngle)), y: d * Math.sin(rad(cam.followerAngle)) };
      const leverAngle = (Math.atan2(bec.y - pivot.y, bec.x - pivot.x) * 180) / Math.PI;
      return { psi, radius: r, bec, pivot, leverAngle, index: camIndexAtScreenAngle(cam, psi, turnDeg) };
    }
    previous = current;
  }
  return null; // le levier n'atteint pas la came : longueur incompatible
}

/**
 * Debattement que doit avoir le PORTE-SATELLITES pour que la came ajoute
 * la grandeur encodee a la sortie du train epicycloidal.
 *
 * C'est le montage de l'equation marchante : la cage n'est pas menee, elle
 * est POSEE par la came. Avec une cage nominalement fixe le train est un
 * reducteur ordinaire de rapport R ; en integrant la relation de Willis,
 *
 *     theta_B = R.theta_A + (1 - R).theta_U
 *
 * un deplacement Delta.theta_U de la cage ajoute (1 - R).Delta.theta_U a la
 * sortie. On inverse : connaissant la correction voulue sur la roue de
 * sortie, on en deduit le debattement a donner a la cage, et c'est lui que
 * la came doit produire.
 *
 * `valueSpan` est l'etendue de la grandeur encodee (minutes pour une
 * equation du temps), `turnHours` la periode de la roue corrigee.
 */
function carrierSwingForCorrection(valueSpan, turnHours, basicRatio) {
  if (!Number.isFinite(valueSpan) || !Number.isFinite(basicRatio) || !(turnHours > 0)) return null;
  if (Math.abs(1 - basicRatio) < 1e-9) return null; // R = 1 : la cage n'agit plus
  const outputDegrees = (valueSpan / (turnHours * 60)) * 360;
  return { outputDegrees, carrierDegrees: outputDegrees / (1 - basicRatio) };
}

/**
 * Correction reellement obtenue sur la sortie pour un debattement de cage
 * donne -- la lecture inverse de la precedente, pour verifier.
 */
function correctionFromCarrierSwing(carrierDegrees, turnHours, basicRatio) {
  if (!Number.isFinite(carrierDegrees) || !Number.isFinite(basicRatio)) return null;
  const outputDegrees = carrierDegrees * (1 - basicRatio);
  return { outputDegrees, minutes: (outputDegrees / 360) * turnHours * 60 };
}

/**
 * Course angulaire totale du levier sur un tour complet de came. C'est LA
 * grandeur de dimensionnement : elle dit de combien le rateau balaie, donc
 * quel rapport il faut entre lui et l'entree du differentiel.
 */
function camLeverSwing(cam) {
  // On echantillonne 360 positions de came, pas une par point de profil :
  // camLeverState balaie deja tout le profil a chaque appel, le produit des
  // deux deviendrait vite quadratique sans rien apporter.
  const n = Math.min(360, cam.samples.normalized.length);
  let min = Infinity;
  let max = -Infinity;
  let missing = 0;
  for (let i = 0; i < n; i++) {
    const state = camLeverState(cam, (i / n) * 360);
    if (!state) {
      missing++;
      continue;
    }
    min = Math.min(min, state.leverAngle);
    max = Math.max(max, state.leverAngle);
  }
  if (!Number.isFinite(min)) return null;
  return { min, max, swing: max - min, missing };
}

/**
 * Longueur de levier conseillee. Le bec doit pouvoir atteindre le profil
 * quel que soit son rayon : il faut L > d - r, donc au minimum
 * d - rayon de base. On prend une marge d'une amplitude.
 */
function suggestedLeverLength(cam) {
  return Math.max(0.5, cam.pivotDistance - cam.baseRadius + cam.amplitude);
}

// ------------------------------------------------------------------
// Synthese du profil : on grave la SORTIE VOULUE, pas un rayon
// ------------------------------------------------------------------

/**
 * Construit la geometrie complete d'une came.
 *
 * Le sens de la construction compte. Encoder la grandeur dans le RAYON
 * puis lire l'angle d'un levier introduit une distorsion : l'angle n'est
 * pas une fonction affine du rayon, et la lecture derive d'environ 1,3 %
 * de la course -- 0,4 minute sur une equation du temps. On procede donc a
 * l'envers, comme en conception de came : on impose la sortie voulue et
 * l'on en DEDUIT le profil, par inversion.
 *
 * Inversion : au lieu de faire tourner la came devant un palpeur fixe, on
 * fige la came et l'on fait tourner le palpeur autour d'elle. Pour chaque
 * echantillon i, on sait a quel angle local a_i se trouve alors le pivot,
 * et l'on place le centre du galet la ou il doit etre pour que la sortie
 * vaille la valeur voulue.
 *
 * Trois courbes en sortent :
 *   - la PRIMITIVE, trajectoire du centre du galet : c'est elle qui regit
 *     la cinematique, donc la lecture ;
 *   - le PROFIL USINE, la primitive decalee du rayon de galet le long de
 *     la normale : c'est lui que l'on dessine et que l'on taille ;
 *   - le controle de CONTRE-DEPOUILLE : si le galet est plus gros que le
 *     rayon de courbure la ou la primitive est concave, il mange la
 *     matiere et la came est irrealisable.
 */
// La geometrie ne depend que des reglages de la came, jamais des dents ni
// des modules du reste du rouage -- or elle est reclamee a chaque essai du
// placeur, des centaines de fois. Sans ce cache, affiner l'echantillonnage
// rendait la recherche de placement dix fois plus lente.
const camGeometryCache = new Map();

function camGeometryKey(cam) {
  return [
    cam.profileId,
    cam.followerType,
    cam.samples.normalized.length,
    cam.samples.min,
    cam.baseRadius,
    cam.amplitude,
    cam.pivotDistance,
    cam.leverLength,
    cam.swingAngle,
    cam.restAngle,
    cam.rollerRadius,
    cam.direction,
  ].join("|");
}

function buildCamGeometry(cam) {
  const key = camGeometryKey(cam);
  const cached = camGeometryCache.get(key);
  if (cached) return cached;
  const built = computeCamGeometry(cam);
  camGeometryCache.set(key, built);
  return built;
}

function computeCamGeometry(cam) {
  const samples = cam.samples;
  const n = samples.normalized.length;
  const dir = cam.direction ?? 1;
  const rad = (deg) => (deg * Math.PI) / 180;
  const angular = cam.followerType === "angulaire";

  // Angle local du pivot (ou de la direction de glissiere) au moment ou
  // l'echantillon i se presente. Voir camIndexAtScreenAngle : i est lu
  // quand la came a tourne de theta_P + dir.i.360/n, et le pivot est alors
  // a l'angle local -dir.i.360/n.
  const pivotLocalAngle = (i) => -dir * (i / n) * 360;

  // primitive, en coordonnees polaires locales
  const pitch = [];
  for (let i = 0; i < n; i++) {
    const f = samples.normalized[i];
    const a = pivotLocalAngle(i);
    if (!angular) {
      // palpeur lineaire : le centre du galet coulisse sur le rayon, la
      // primitive est directement r(a)
      pitch.push({ angle: a, radius: cam.baseRadius + cam.amplitude * f });
      continue;
    }
    // palpeur angulaire : l'angle du levier est ce que l'on impose
    const delta = rad(cam.restAngle + cam.swingAngle * f);
    const d = cam.pivotDistance;
    const L = cam.leverLength;
    // B = d.u(a) + L.u(a - delta + pi), soit dans le repere tourne de a :
    // (d - L.cos delta, L.sin delta)
    const bx = d - L * Math.cos(delta);
    const by = L * Math.sin(delta);
    pitch.push({
      angle: a + (Math.atan2(by, bx) * 180) / Math.PI,
      radius: Math.hypot(bx, by),
    });
  }

  // Reechantillonnage sur une grille d'angles reguliere : l'angle du point
  // de contact n'avance pas au meme rythme que l'echantillon (le galet
  // decrit un arc), la primitive n'est donc pas uniforme en angle.
  const wrapped = pitch
    .map((p, i) => ({ angle: ((p.angle % 360) + 360) % 360, radius: p.radius, value: samples.values[i], f: samples.normalized[i] }))
    .sort((u, v) => u.angle - v.angle);

  const radii = new Array(n);
  const values = new Array(n);
  let cursor = 0;
  for (let k = 0; k < n; k++) {
    const target = (k / n) * 360;
    while (cursor + 1 < wrapped.length && wrapped[cursor + 1].angle <= target) cursor++;
    const a = wrapped[cursor];
    const b = wrapped[(cursor + 1) % wrapped.length];
    const span = ((b.angle - a.angle + 360) % 360) || 360;
    const t = Math.min(1, Math.max(0, (((target - a.angle + 360) % 360) / span)));
    radii[k] = a.radius + (b.radius - a.radius) * t;
    values[k] = a.value + (b.value - a.value) * t;
  }

  // profil usine : primitive decalee du rayon de galet, le long de la normale
  const roller = Math.max(0, cam.rollerRadius ?? 0);
  const points = radii.map((r, k) => {
    const a = rad((k / n) * 360);
    return [r * Math.cos(a), r * Math.sin(a)];
  });

  let cut = points;
  let undercut = false;
  let minCurvature = Infinity;
  if (roller > 0) {
    const offset = [];
    for (let k = 0; k < n; k++) {
      const prev = points[(k - 1 + n) % n];
      const next = points[(k + 1) % n];
      const tx = next[0] - prev[0];
      const ty = next[1] - prev[1];
      const len = Math.hypot(tx, ty) || 1;
      // normale, orientee vers l'exterieur puis retournee : le galet roule
      // sur le dessus de la came, la matiere est en dessous
      let nx = ty / len;
      let ny = -tx / len;
      if (nx * points[k][0] + ny * points[k][1] < 0) {
        nx = -nx;
        ny = -ny;
      }
      offset.push([points[k][0] - roller * nx, points[k][1] - roller * ny]);
    }
    // rebroussement : le profil recule alors que la primitive avance
    for (let k = 0; k < n; k++) {
      const j = (k + 1) % n;
      const dot =
        (points[j][0] - points[k][0]) * (offset[j][0] - offset[k][0]) +
        (points[j][1] - points[k][1]) * (offset[j][1] - offset[k][1]);
      if (dot < 0) undercut = true;
    }
    // rayon de courbure minimal la ou la primitive est concave
    for (let k = 0; k < n; k++) {
      const p0 = points[(k - 1 + n) % n];
      const p1 = points[k];
      const p2 = points[(k + 1) % n];
      const area = (p1[0] - p0[0]) * (p2[1] - p0[1]) - (p1[1] - p0[1]) * (p2[0] - p0[0]);
      if (Math.abs(area) < 1e-12) continue;
      const a = Math.hypot(p1[0] - p0[0], p1[1] - p0[1]);
      const b = Math.hypot(p2[0] - p1[0], p2[1] - p1[1]);
      const c = Math.hypot(p2[0] - p0[0], p2[1] - p0[1]);
      const rho = (a * b * c) / (2 * Math.abs(area));
      if (area > 0) minCurvature = Math.min(minCurvature, rho);
    }
    if (Number.isFinite(minCurvature) && roller > minCurvature) undercut = true;
    cut = offset;
  }

  const cutRadii = cut.map(([x, y]) => Math.hypot(x, y));
  return {
    radii, // primitive, grille reguliere : c'est elle qui regit la lecture
    values, // grandeur encodee, sur la meme grille
    cut, // profil reellement usine, en coordonnees locales
    roller,
    undercut,
    minCurvature: Number.isFinite(minCurvature) ? minCurvature : null,
    innerRadius: Math.min(...cutRadii),
    outerRadius: Math.max(...cutRadii, ...radii),
  };
}

/**
 * Finesse d'echantillonnage du profil.
 *
 * Un palpeur angulaire convertit le rayon en angle, et cette conversion est
 * d'autant plus raide que le bras est court devant la distance au pivot :
 * une meme imprecision de rayon se traduit alors par une erreur d'angle bien
 * plus grande. Mesure faite, l'erreur de course passe de 0,0006 deg avec un
 * bras de 6,4 mm a 0,048 deg avec un bras de 1,56 mm, a 360 points -- et
 * elle se divise par vingt quand on quadruple la finesse. On l'ajuste donc
 * au rapport pivot/bras plutot que de payer partout le prix du pire cas.
 */
function camSampleCount(cam) {
  if (cam.followerType !== "angulaire" || !(cam.leverLength > 0) || !(cam.pivotDistance > 0)) return 360;
  const steepness = Math.ceil(cam.pivotDistance / cam.leverLength);
  return Math.min(2880, Math.max(360, 360 * steepness));
}

/** Configuration exploitable de la came d'une complication, ou null. */
function camSpec(comp) {
  const cam = comp.cam;
  if (!cam || !cam.enabled || !CAM_PROFILES[cam.profile]) return null;
  const samples = camProfileSamples(cam.profile, cam.latitude, camSampleCount(cam));
  if (!samples) return null;
  return refreshCamGeometry({
    profileId: cam.profile,
    baseRadius: cam.baseRadius,
    amplitude: cam.amplitude,
    followerAngle: cam.followerAngle,
    followerType: cam.followerType,
    pivotDistance: cam.pivotDistance,
    leverLength: cam.leverLength,
    swingAngle: cam.swingAngle,
    restAngle: cam.restAngle,
    drives: cam.drives,
    carrierTarget: cam.carrierTarget,
    rollerRadius: cam.rollerRadius,
    correctedTurnHours: cam.correctedTurnHours,
    samples,
    // Sens dans lequel le profil est taille. Une came est gravee pour etre
    // lue dans l'ordre des jours : si le mobile qui la porte tourne a
    // l'envers, il faut la tailler en miroir, faute de quoi l'annee
    // defilerait a reculons devant le palpeur. Renseigne des que les
    // vitesses sont connues ; +1 par defaut.
    direction: 1,
  });
}

/**
 * Spec complete : configuration plus geometrie synthetisee. La geometrie
 * depend du SENS de rotation, connu seulement une fois les vitesses
 * calculees -- d'ou ce recalcul explicite plutot qu'un cache aveugle.
 */
function refreshCamGeometry(spec) {
  if (!spec) return spec;
  spec.geometry = buildCamGeometry(spec);
  return spec;
}

/**
 * La came tourne-t-elle a la bonne vitesse ? Une came d'equation du temps
 * n'a de sens qu'a un tour par an : montee sur un mobile qui tourne
 * autrement, elle affiche n'importe quoi. Le rouage etant deja resolu, la
 * verification est immediate -- autant la faire.
 */
function camPeriodCheck(comp, turnsPerHour) {
  const profile = CAM_PROFILES[comp.cam?.profile];
  if (!profile || !Number.isFinite(turnsPerHour) || turnsPerHour === 0) return null;
  const wanted = toTurnsPerHour(profile.turnPeriod.value, profile.turnPeriod.unit);
  if (!Number.isFinite(wanted) || wanted === 0) return null;
  const ratio = Math.abs(turnsPerHour) / Math.abs(wanted);
  return { ratio, ok: Math.abs(ratio - 1) < 0.01, actual: Math.abs(turnsPerHour), wanted: Math.abs(wanted) };
}

// ------------------------------------------------------------------
// Trains epicycloidaux (planetaires, differentiels)
// ------------------------------------------------------------------

/**
 * Les quatre types de trains epicycloidaux plans, d'apres Augereau
 * (« Les engrenages d'horlogerie », CETEHOR, chapitre XIV). Tous ont la
 * meme ossature -- deux planetaires A et B coaxiaux, un porte-satellites U
 * libre sur le meme axe, un satellite porte par U -- et ne different que
 * par la nature du satellite et des dentures :
 *
 *   type 1 : satellite simple, B est une couronne     2D = m(A + a) = m(B - a)
 *   type 2 : satellite double, B est une couronne     2D = m(A + a) = m(B - b)
 *   type 3 : satellite double, A et B couronnes       2D = m(A - a) = m(B - b)
 *   type 4 : satellite double, A et B exterieurs      2D = m(A + a) = m(B + b)
 *
 * Ces relations d'entraxe (114, 117, 121, 124) disent toutes la meme
 * chose : les DEUX engrenements relient l'axe central a l'axe du satellite,
 * donc leurs entraxes sont egaux. C'est exactement la contrainte du train
 * revertant, et le meme code la resout.
 */
const EPICYCLIC_TYPES = {
  1: { label: "Type 1 — satellite simple, couronne", compound: false, internalA: false, internalB: true },
  2: { label: "Type 2 — satellite double, couronne", compound: true, internalA: false, internalB: true },
  3: { label: "Type 3 — deux couronnes", compound: true, internalA: true, internalB: true },
  4: { label: "Type 4 — deux planétaires extérieurs", compound: true, internalA: false, internalB: false },
};

/** Membres d'un train epicycloidal : les deux planetaires et la cage. */
const EPICYCLIC_MEMBERS = { A: "planetaire_a", B: "planetaire_b", U: "porte_satellites" };

const EPICYCLIC_MEMBER_LABELS = {
  A: "planétaire A",
  B: "planétaire B",
  U: "porte-satellites",
};

function epicyclicType(comp) {
  return EPICYCLIC_TYPES[comp.epiType] ?? EPICYCLIC_TYPES[2];
}

/**
 * Rapport de transmission vise, en fonction du membre IMMOBILISE, deduit du
 * rapport de base R (porte-satellites bloque). Ce sont les formules (105),
 * (106), (111), (115), (116), (118), (119), (120), (122) et (123)
 * d'Augereau, ramenees a leur forme commune par la relation de Willis
 * w_B = R.w_A + (1 - R).w_U :
 *
 *   U fixe : w_B / w_A = R
 *   A fixe : w_B / w_U = 1 - R
 *   B fixe : w_A / w_U = (R - 1) / R
 */
function epicyclicTransmission(basicRatio, fixedMember) {
  if (!Number.isFinite(basicRatio)) return NaN;
  // vrai differentiel : aucun membre n'est immobile, il n'y a donc pas de
  // rapport de transmission unique -- c'est le rapport de BASE qui se
  // dimensionne, comme le fait Augereau pour la reserve de marche
  if (fixedMember === "none") return basicRatio;
  if (fixedMember === "U") return basicRatio;
  if (fixedMember === "A") return 1 - basicRatio;
  if (fixedMember === "B") return basicRatio === 0 ? NaN : (basicRatio - 1) / basicRatio;
  return NaN;
}

/** Rapport de base qu'il faut viser pour obtenir la transmission demandee. */
function epicyclicBasicFromTransmission(target, fixedMember) {
  if (!Number.isFinite(target)) return NaN;
  if (fixedMember === "none" || fixedMember === "U") return target;
  if (fixedMember === "A") return 1 - target;
  if (fixedMember === "B") return target === 1 ? NaN : 1 / (1 - target);
  return NaN;
}

/**
 * Signe impose au rapport de base par le TYPE de train, independamment des
 * dents : un engrenement exterieur inverse, un interieur conserve. Les
 * types 1 et 2 (un seul engrenement interieur) donnent donc toujours R < 0,
 * les types 3 et 4 toujours R > 0. Viser un rapport du mauvais signe est
 * sans issue quel que soit le nombrage -- il faut changer de type.
 */
function epicyclicSignOfType(comp) {
  const type = epicyclicType(comp);
  return (type.internalA ? 1 : -1) * (type.internalB ? 1 : -1);
}

/**
 * Rapport de base lu directement sur les dents : R = s.(A.b)/(a.B), le
 * signe s valant -1 par engrenement exterieur. Pour un satellite simple
 * (type 1) le satellite se simplifie et R se reduit a s.A/B, ce que dit
 * la formule (104) d'Augereau.
 */
function epicyclicBasicFromTeeth(comp, teethByLocal) {
  const type = epicyclicType(comp);
  const A = teethByLocal.planetaire_a;
  const B = teethByLocal.planetaire_b;
  const a = teethByLocal.satellite_a;
  const b = type.compound ? teethByLocal.satellite_b : a;
  if (!A || !B || !a || !b) return NaN;
  const sign = (type.internalA ? 1 : -1) * (type.internalB ? 1 : -1);
  return (sign * A * b) / (a * B);
}

/** Nombre de dents du planetaire B qui donnerait exactement ce rapport de base. */
function epicyclicSolveForB(comp, teethByLocal, basicRatio) {
  const type = epicyclicType(comp);
  const A = teethByLocal.planetaire_a;
  const a = teethByLocal.satellite_a;
  const b = type.compound ? teethByLocal.satellite_b : a;
  if (!A || !a || !b || !Number.isFinite(basicRatio) || basicRatio === 0) return NaN;
  const sign = (type.internalA ? 1 : -1) * (type.internalB ? 1 : -1);
  return (sign * A * b) / (a * basicRatio);
}

/** Le membre entraine et le membre menant, une fois un membre immobilise. */
function epicyclicRoles(fixedMember) {
  if (fixedMember === "U") return { from: "A", to: "B" };
  if (fixedMember === "A") return { from: "U", to: "B" };
  if (fixedMember === "B") return { from: "U", to: "A" };
  // Differentiel : les deux planetaires sont menes et c'est la CAGE dont on
  // pose la vitesse -- c'est donc elle la sortie, celle qui porte l'aiguille
  // dans un indicateur de reserve de marche.
  return { from: "A", to: "U" };
}

// ------------------------------------------------------------------
// Entraxes egaux : train revertant ET train epicycloidal
// ------------------------------------------------------------------

/**
 * Multiplicateur d'entraxe d'un engrenement : entraxe = module * span / 2.
 * Somme des dents en denture exterieure, difference en denture interieure
 * (le mobile mene tourne DANS la couronne, les centres se rapprochent).
 */
function meshTeethSpan(comp, pair, teethByLocal) {
  const za = teethByLocal[pair[0]];
  const zb = teethByLocal[pair[1]];
  if (za === undefined || zb === undefined) return null;
  const internal = !!comp.internal[pair[0]] !== !!comp.internal[pair[1]];
  return internal ? Math.abs(za - zb) : za + zb;
}

/**
 * Dans un train REVERTANT (sortie coaxiale) les deux engrenements relient
 * le MEME couple d'axes : leurs entraxes doivent etre egaux, sans quoi
 * l'une des deux paires ne peut tout simplement pas engrener. La condition
 * s'ecrit m1 * D1 = m2 * D2, ou D est le span en dents de chaque paire.
 *
 * Le cas noble est m1 = m2 -- c'est ce qu'on appelle proprement un
 * "reverted gear train", et il demande D1 == D2. Quand les dents imposees
 * par le ratio ne le permettent pas, on decale le module d'UNE des deux
 * paires : en ecrivant D1/D2 = a/b sous forme irreductible, les solutions
 * sont exactement m1 = b*t et m2 = a*t. Les modules ronds sont les t
 * multiples du pas -- et ils n'existent que si a et b sont petits, ce qui
 * est bien la facon de dire "les deux modules restent raisonnables".
 *
 * Retourne les paires utilisables, les modules egaux d'abord, puis les
 * plus proches des modules normalises.
 */
function revertedModulePairs(D1, D2, moduleMin, moduleMax, grain = MODULE_GRAIN) {
  if (!(D1 > 0) || !(D2 > 0) || !(moduleMax >= moduleMin) || !(moduleMin > 0)) return [];
  const g = gcdInt(D1, D2);
  const a = D1 / g;
  const b = D2 / g;
  // m1 = b*t, m2 = a*t : les deux doivent tenir dans la plage demandee
  const tLo = Math.max(moduleMin / b, moduleMin / a);
  const tHi = Math.min(moduleMax / b, moduleMax / a);
  if (tHi < tLo - 1e-12) return [];

  const pairs = [];
  const kLo = Math.ceil(tLo / grain - 1e-9);
  const kHi = Math.floor(tHi / grain + 1e-9);
  for (let k = kLo; k <= kHi; k++) {
    const t = k * grain;
    // b*t et a*t sont des multiples entiers du pas : ils sont ronds par construction
    pairs.push({ m1: snapModule(b * t, grain), m2: snapModule(a * t, grain), round: true });
  }
  if (!pairs.length) {
    // aucun module rond ne convient (a/b trop biscornu) : on garde l'entraxe
    // exact au milieu de la plage praticable, en signalant que les modules
    // ne tombent pas juste
    const t = (tLo + tHi) / 2;
    pairs.push({ m1: b * t, m2: a * t, round: false });
  }
  for (const p of pairs) p.same = Math.abs(p.m1 - p.m2) < 1e-9;
  pairs.sort(
    (x, y) => Number(y.same) - Number(x.same) || moduleOddity(x.m1) + moduleOddity(x.m2) - (moduleOddity(y.m1) + moduleOddity(y.m2))
  );
  return pairs;
}

/**
 * Les deux engrenements relient-ils DIRECTEMENT le meme couple d'axes ?
 * C'est le cas du train revertant (sortie coaxiale) et de tout train
 * epicycloidal, dont les deux engrenements joignent l'axe central a l'axe
 * du satellite. Leurs entraxes doivent alors etre egaux.
 * Un renvoi intercale s'assoit sur son propre axe et rompt la liaison : la
 * geometrie redevient libre.
 */
function hasTwinMeshConstraint(comp, effectiveIdlers = {}) {
  if (comp.topology === "epicyclic") return true; // pas de renvoi possible ici
  if (comp.topology !== "reverted") return false;
  return baseMeshKeys(comp).every((key) => !(effectiveIdlers[key] > 0));
}

/**
 * Juge une combinaison de dents pour un train revertant strict.
 * Retourne null si aucun module de la plage ne peut egaliser les deux
 * entraxes (combinaison a rejeter), sinon une penalite :
 *   0 = les quatre roues partagent le meme module (vrai train revertant)
 *   1 = il faut decaler le module d'une paire, les deux restent ronds
 *   2 = aucun module rond ne convient
 */
function twinMeshQuality(comp, teethByLocal, moduleMin, moduleMax, options = {}) {
  const [p1, p2] = localBaseMeshes(comp);
  const D1 = meshTeethSpan(comp, p1, teethByLocal);
  const D2 = meshTeethSpan(comp, p2, teethByLocal);
  if (!D1 || !D2) return null;
  let pairs = revertedModulePairs(D1, D2, moduleMin, moduleMax);

  // Un mobile qui participe aux DEUX engrenements n'a qu'un seul module :
  // c'est le satellite simple du type 1, et cela impose D1 = D2, donc
  // a = (B - A) / 2 -- la formule (107) d'Augereau.
  const shared = p1.filter((n) => p2.includes(n));
  if (shared.length) pairs = pairs.filter((p) => p.same);

  // Le satellite tourne autour de l'axe central : sa denture ne doit pas
  // venir mordre l'arbre qui porte les planetaires et la cage.
  if (comp.topology === "epicyclic" && options.arborRadius > 0) {
    pairs = pairs.filter((p) => epicyclicClearsArbor(comp, teethByLocal, p, options.arborRadius));
  }

  if (!pairs.length) return null;
  const best = pairs[0];
  return { penalty: best.same ? 0 : best.round ? 1 : 2, pairs, D1, D2, same: best.same, round: best.round };
}

/**
 * Le satellite laisse-t-il l'arbre central libre ? L'entraxe vaut
 * D = m1.D1 / 2 ; chaque mobile du satellite y occupe son rayon de tete.
 * Si la denture depasse jusqu'a l'arbre, le rouage se bloque au premier
 * tour -- aucune hauteur ni aucun pont n'y changera rien.
 */
function epicyclicClearsArbor(comp, teethByLocal, pair, arborRadius) {
  const type = epicyclicType(comp);
  const distance = (pair.m1 * meshTeethSpan(comp, localBaseMeshes(comp)[0], teethByLocal)) / 2;
  const tip = (module, teeth) => (module * teeth) / 2 + module;
  const satellites = [[pair.m1, teethByLocal.satellite_a]];
  if (type.compound) satellites.push([pair.m2, teethByLocal.satellite_b]);
  return satellites.every(([m, z]) => Number.isFinite(z) && distance - tip(m, z) > arborRadius);
}

/** Noms globaux des VRAIES roues (hors renvois) des complications donnees. */
function wheelNamesOf(comps) {
  return comps.flatMap((c) => ownLocalWheelNames(c).map((l) => globalName(c, l)));
}

/**
 * Remet la complication en coherence apres un changement de structure
 * (topologie, nombre d'etages, roles, raccordement) : bornes, roles,
 * raccordement vers une roue existante d'une complication PRECEDENTE,
 * configuration des renvois, engrenement du renvoi automatique.
 */
function normalizeComplication(comp, earlierComps) {
  comp.stages = Math.min(MAX_STAGES, Math.max(1, parseInt(comp.stages, 10) || 2));
  if (!["reverted", "epicyclic"].includes(comp.topology)) comp.topology = "compound";
  if (!EPICYCLIC_TYPES[comp.epiType]) comp.epiType = 2;
  if (!["U", "A", "B", "none"].includes(comp.fixedMember)) comp.fixedMember = "U";

  const names = localWheelNames(comp);
  const bounds = {};
  for (const n of names) bounds[n] = comp.bounds[n] ?? { min: 8, max: 60, fixed: false };
  comp.bounds = bounds;

  const internal = {};
  if (comp.topology === "epicyclic") {
    // les dentures ne sont pas au choix : elles definissent le type
    const type = epicyclicType(comp);
    for (const n of names) internal[n] = false;
    internal.planetaire_a = type.internalA;
    internal.planetaire_b = type.internalB;
  } else {
    for (const n of names) internal[n] = !!(comp.internal && comp.internal[n]);
    // deux dentures interieures ne peuvent pas engrener l'une dans l'autre
    for (const [a, b] of localBaseMeshes(comp)) {
      if (internal[a] && internal[b]) internal[b] = false;
    }
  }
  comp.internal = internal;

  if (comp.topology === "epicyclic") {
    // entree et sortie decoulent du membre immobilise, elles ne se
    // choisissent pas librement
    const roles = epicyclicRoles(comp.fixedMember);
    comp.entree = EPICYCLIC_MEMBERS[roles.from];
    comp.sortie = EPICYCLIC_MEMBERS[roles.to];
  } else {
    if (!names.includes(comp.entree)) comp.entree = names[0];
    if (!names.includes(comp.sortie)) comp.sortie = comp.topology === "reverted" ? "roue_c_sortie" : names[names.length - 1];
  }

  if (!["coaxial", "mesh", "shared"].includes(comp.link.kind)) comp.link = { kind: "none", wheel: null };
  if (!comp.fixed || typeof comp.fixed !== "object") comp.fixed = { entree: null, sortie: null };
  if (comp.drawWhenCollapsed === undefined) comp.drawWhenCollapsed = true;
  if (comp.link.kind !== "none") {
    const available = wheelNamesOf(earlierComps);
    if (!available.includes(comp.link.wheel)) {
      comp.link = available.length ? { kind: comp.link.kind, wheel: available[0] } : { kind: "none", wheel: null };
    }
  }

  const idlers = {};
  for (const key of baseMeshKeys(comp)) idlers[key] = comp.idlers[key] ?? { count: 0, min: 10, max: 40 };
  comp.idlers = idlers;

  const path = pathBaseMeshKeys(comp);
  if (!path.includes(comp.autoIdlerMesh)) comp.autoIdlerMesh = path.length ? path[path.length - 1] : null;

  // une tolerance NaN (champ vide) rejetterait silencieusement tous les
  // candidats : `err <= NaN` est toujours faux
  if (!Number.isFinite(comp.tol) || comp.tol < 0) comp.tol = 0.0001;

  if (comp.ratioMode !== "speeds") comp.ratioMode = "direct";
  // came montee sur la sortie : entierement optionnelle, et sans effet tant
  // qu'elle n'est pas activee
  const cam = comp.cam && typeof comp.cam === "object" ? comp.cam : {};
  comp.cam = {
    enabled: !!cam.enabled,
    profile: CAM_PROFILES[cam.profile] ? cam.profile : "equation-temps",
    latitude: Number.isFinite(cam.latitude) ? Math.max(-89, Math.min(89, cam.latitude)) : 46.2,
    baseRadius: Number.isFinite(cam.baseRadius) && cam.baseRadius > 0 ? cam.baseRadius : 3,
    amplitude: Number.isFinite(cam.amplitude) && cam.amplitude > 0 ? cam.amplitude : 1.2,
    followerAngle: Number.isFinite(cam.followerAngle) ? ((cam.followerAngle % 360) + 360) % 360 : 270,
    // Deux facons de lire une came, qui ne donnent pas la meme grandeur :
    //   lineaire  -> une course en millimetres, pour pousser une tige ;
    //   angulaire -> un ANGLE, celui d'un rateau pivote, qui peut alors
    //                entrer dans un differentiel et corriger une roue.
    followerType: cam.followerType === "angulaire" ? "angulaire" : "lineaire",
    pivotDistance: Number.isFinite(cam.pivotDistance) && cam.pivotDistance > 0 ? cam.pivotDistance : 0,
    leverLength: Number.isFinite(cam.leverLength) && cam.leverLength > 0 ? cam.leverLength : 0,
    // periode de la roue que la correction vient modifier (24 h pour une
    // equation du temps montee sur un affichage de 24 heures)
    correctedTurnHours: Number.isFinite(cam.correctedTurnHours) && cam.correctedTurnHours > 0 ? cam.correctedTurnHours : 24,
    // Course ANGULAIRE voulue du levier, et angle de repos au minimum de la
    // grandeur. Pour un palpeur angulaire c'est la sortie que l'on impose :
    // le profil s'en deduit, et la lecture est alors exactement
    // proportionnelle a la grandeur encodee.
    swingAngle: Number.isFinite(cam.swingAngle) && cam.swingAngle !== 0 ? cam.swingAngle : 12,
    restAngle: Number.isFinite(cam.restAngle) ? cam.restAngle : 30,
    // rayon du galet : 0 = bec pointu (le profil usine est la primitive)
    rollerRadius: Number.isFinite(cam.rollerRadius) && cam.rollerRadius >= 0 ? cam.rollerRadius : 0.4,
    // Ce que le palpeur angulaire entraine :
    //   "levier"          -> un rateau libre, dont l'angle sort du systeme ;
    //   "porte-satellites"-> la CAGE d'un train epicycloidal, que la came
    //                        pousse directement. C'est l'equation marchante :
    //                        la cage n'est pas menee, elle est posee, et son
    //                        deplacement s'ajoute a la sortie du train.
    drives: cam.drives === "porte-satellites" ? "porte-satellites" : "levier",
    carrierTarget: typeof cam.carrierTarget === "string" ? cam.carrierTarget : null,
  };
  // geometrie du levier : valeurs par defaut coherentes avec la came
  if (comp.cam.followerType === "angulaire") {
    if (!comp.cam.pivotDistance) comp.cam.pivotDistance = comp.cam.baseRadius + comp.cam.amplitude + 4;
    if (!comp.cam.leverLength) comp.cam.leverLength = suggestedLeverLength(comp.cam);
  }

  if (!comp.diff || typeof comp.diff !== "object") comp.diff = {};
  for (const member of ["a", "b", "u"]) {
    const fallback = { a: { value: 1, unit: "tr/h" }, b: { value: 0, unit: "tr/h" }, u: { value: 0.5, unit: "tr/h" } }[member];
    const s = comp.diff[member];
    if (!s || typeof s !== "object" || !SPEED_UNITS[s.unit] || !Number.isFinite(s.value)) comp.diff[member] = { ...fallback };
    // zero n'a de sens qu'en « tours par ... » : une duree de tour nulle non
    else if (s.value === 0 && !s.unit.startsWith("tr/")) s.unit = "tr/h";
  }
  for (const role of ["speedIn", "speedOut"]) {
    if (!comp[role] || typeof comp[role] !== "object") comp[role] = { value: 1, unit: "tr/h" };
    if (!SPEED_UNITS[comp[role].unit]) comp[role].unit = "tr/h";
    if (!Number.isFinite(comp[role].value) || comp[role].value === 0) comp[role].value = 1;
  }
  if (comp.preset !== "none" && !libraryPreset(comp.preset)) comp.preset = "none";

  if (![1, -1].includes(comp.sensEntree)) comp.sensEntree = 1;
  if (![0, 1, -1].includes(comp.sensSortie)) comp.sensSortie = 0;
}

function normalizeAll(comps) {
  comps.forEach((comp, k) => normalizeComplication(comp, comps.slice(0, k)));
}

// ------------------------------------------------------------------
// Construction du train global
// ------------------------------------------------------------------

/**
 * Ajoute les mobiles et engrenements de `comp` au train `train` (qui doit
 * deja contenir les complications precedentes, pour les raccordements).
 * spec : { teeth (local -> Z), moduleByMesh (cle de base -> module),
 *          idlerCounts (cle de base -> nb de renvois), idlerTeeth (nom global -> Z) }
 * Tout est optionnel : dents 10 et module 1 par defaut (gabarit).
 */
function buildComplicationInto(train, comp, spec = {}) {
  const names = localWheelNames(comp);
  const groups = localAxisGroups(comp);
  const meshes = localBaseMeshes(comp);
  const teeth = spec.teeth ?? {};
  const moduleByMesh = { ...(spec.moduleByMesh ?? {}) };
  const idlerCounts = spec.idlerCounts ?? {};
  const idlerTeeth = spec.idlerTeeth ?? {};

  const driver = comp.link.kind !== "none" && comp.link.wheel ? train.wheels.get(comp.link.wheel) : null;
  const linkKind = driver ? comp.link.kind : "none";
  const shared = linkKind === "shared";
  const name = (local) => (shared && local === comp.entree ? driver.name : globalName(comp, local));
  const entreeGlobal = name(comp.entree);

  // engrenee sur une roue motrice, ou entree = roue existante : l'engrenement
  // de base de l'entree partage forcement le module de cette roue
  if (linkKind === "mesh" || shared) moduleByMesh[baseMeshOfLocal(comp, comp.entree)] = driver.module;

  // coaxiale : tout l'arbre local de l'entree rejoint l'axe de la roue motrice
  const mergedLocalGroup = linkKind === "coaxial" ? groups[comp.entree] : null;
  const mergedMembers = mergedLocalGroup ? names.filter((n) => groups[n] === mergedLocalGroup) : [];
  const driverGroupMembers = linkKind === "coaxial" ? [...(train.axisGroups().get(driver.axisGroup) ?? [])] : [];
  const driverGroupWasRigid = linkKind === "coaxial" ? train.isRigidGroup(driver.axisGroup) : true;

  // un axe local peut avoir fusionne avec celui d'une roue motrice
  const resolveGroup = (local) => {
    const g = groups[local];
    return mergedLocalGroup && g === mergedLocalGroup ? driver.axisGroup : `${comp.label}.${g}`;
  };

  for (const local of names) {
    if (shared && local === comp.entree) continue; // la roue existe deja
    const key = baseMeshOfLocal(comp, local);
    const module = moduleByMesh[key] ?? 1;
    const group = resolveGroup(local);
    const gname = globalName(comp, local);
    train.addWheel(new Wheel(gname, teeth[local] ?? 10, module, group, 1.0, 1.25, !!comp.internal[local]));
    train.wheelMeta.set(gname, { compId: comp.id, local, kind: "wheel", baseMesh: key });
  }

  for (const g of localIndependentGroups(comp)) {
    if (g !== mergedLocalGroup) train.markIndependentAxis(`${comp.label}.${g}`);
  }

  if (linkKind === "coaxial") {
    // l'axe fusionne est declare independant, et l'on rend explicites les
    // couplages rigides qui existaient de part et d'autre + celui du
    // raccordement lui-meme (entree <-> roue motrice)
    const localRigid = !localIndependentGroups(comp).includes(mergedLocalGroup);
    train.markIndependentAxis(driver.axisGroup);
    if (driverGroupWasRigid) {
      for (let i = 0; i < driverGroupMembers.length; i++)
        for (let j = i + 1; j < driverGroupMembers.length; j++) train.addRigidPair(driverGroupMembers[i], driverGroupMembers[j]);
    }
    if (localRigid) {
      const gm = mergedMembers.map((l) => globalName(comp, l));
      for (let i = 0; i < gm.length; i++) for (let j = i + 1; j < gm.length; j++) train.addRigidPair(gm[i], gm[j]);
    }
    train.addRigidPair(entreeGlobal, driver.name);
  }

  if (linkKind === "mesh") train.addMesh(driver.name, entreeGlobal);

  if (comp.topology === "epicyclic") {
    buildEpicyclicInto(train, comp, resolveGroup);
    attachCamInto(train, comp);
    return train;
  }

  meshes.forEach((pair, idx) => {
    const key = baseMeshKey(pair);
    const count = idlerCounts[key] ?? 0;
    const module = moduleByMesh[key] ?? 1;
    const cfg = comp.idlers[key] ?? { min: 10, max: 40 };
    const chain = [name(pair[0])];
    for (let j = 0; j < count; j++) {
      const iname = idlerName(comp, idx, j);
      const z = idlerTeeth[iname] ?? Math.round((cfg.min + cfg.max) / 2);
      train.addWheel(new Wheel(iname, z, module, iname));
      train.wheelMeta.set(iname, { compId: comp.id, local: localOf(iname), kind: "renvoi", baseMesh: key });
      chain.push(iname);
    }
    chain.push(name(pair[1]));
    for (let j = 0; j + 1 < chain.length; j++) train.addMesh(chain[j], chain[j + 1]);
  });

  attachCamInto(train, comp);
  return train;
}

/**
 * Monte la came sur le mobile de sortie. Elle n'engrene avec rien : c'est
 * un disque a rayon variable, cale sur le meme arbre et a la meme hauteur
 * que la roue qui l'entraine. Pour le placeur elle compte par son rayon
 * maximal -- une came d'equation fait facilement 8 mm, elle decide donc du
 * placement bien plus que la roue qui la porte.
 */
function attachCamInto(train, comp) {
  const spec = camSpec(comp);
  if (!spec) return;
  const outputName = globalName(comp, comp.sortie);
  const output = train.wheels.get(outputName);
  if (!output) return;

  const name = globalName(comp, "came");
  refreshCamGeometry(spec);
  const disc = new Wheel(name, 0, 0, output.axisGroup);
  disc.sweep = spec.geometry.outerRadius;
  disc.cam = spec;
  train.addWheel(disc);
  train.wheelMeta.set(name, { compId: comp.id, local: "came", kind: "came", baseMesh: null });
  // meme hauteur que sa roue (elle est calee contre elle), et meme vitesse :
  // le couplage rigide est explicite car l'axe peut etre independant
  train.addCoplanarPair(name, outputName);
  train.addRigidPair(name, outputName);
  train.addIgnoredPair(name, outputName);
}

/**
 * Complete un train epicycloidal : la cage, les deux engrenements (marques
 * comme epicycloidaux pour que la propagation ordinaire ne les emprunte
 * pas), l'enveloppe balayee par les satellites, et le bloc cinematique sur
 * lequel s'applique la formule de Willis.
 */
function buildEpicyclicInto(train, comp, resolveGroup) {
  const meshes = localBaseMeshes(comp);
  const groups = localAxisGroups(comp);
  const centralGroup = resolveGroup("planetaire_a");
  const isSatellite = (local) => groups[local] === "axe_satellite";

  // La cage n'a pas de denture : c'est un bras qui porte l'axe du
  // satellite. Elle existe comme mobile parce qu'elle tourne, entre ou
  // sort -- c'est meme elle qui lit l'ecart dans un differentiel.
  const carrier = globalName(comp, "porte_satellites");
  const cage = new Wheel(carrier, 0, 0, centralGroup);
  cage.carrier = true;
  train.addWheel(cage);
  train.wheelMeta.set(carrier, { compId: comp.id, local: "porte_satellites", kind: "cage", baseMesh: null });
  // La cage est un bras sans denture : elle n'a pas besoin d'une hauteur a
  // elle, on la rattache au niveau du premier planetaire pour ne pas
  // gonfler artificiellement le nombre de niveaux du mouvement.
  train.addCoplanarPair(carrier, globalName(comp, "planetaire_a"));

  const blockMeshes = [];
  meshes.forEach((pair, idx) => {
    const a = globalName(comp, pair[0]);
    const b = globalName(comp, pair[1]);
    train.addMesh(a, b);
    const mesh = train.meshes[train.meshes.length - 1];
    mesh.epicyclic = true;
    const internal = train.isInternalMesh(mesh);
    blockMeshes.push({ from: a, to: b, internal });

    // Enveloppe : en tournant avec la cage, le satellite balaie un disque
    // autour de l'axe central. Rien d'autre ne peut occuper ce volume a
    // cette hauteur -- sans quoi le rouage se bloquerait au premier tour.
    const satelliteLocal = isSatellite(pair[0]) ? pair[0] : pair[1];
    const satellite = globalName(comp, satelliteLocal);
    const sat = train.wheels.get(satellite);
    // l'arbre d'un satellite est tenu par la cage, pas par la platine :
    // qu'un planetaire passe au-dessus de lui ne reclame aucun pont
    if (sat) sat.carried = true;
    const distance = mesh.centerDistance(train.wheels);
    if (sat && Number.isFinite(distance)) {
      const envelope = globalName(comp, `enveloppe${idx + 1}`);
      const disc = new Wheel(envelope, 0, 0, centralGroup);
      disc.sweep = distance + sat.outerRadius;
      disc.envelope = true;
      train.addWheel(disc);
      train.wheelMeta.set(envelope, { compId: comp.id, local: `enveloppe${idx + 1}`, kind: "enveloppe", baseMesh: baseMeshKey(pair) });
      // l'enveloppe est a la hauteur du satellite qui la decrit, et ne
      // saurait heurter ce satellite ni son jumeau coaxial
      train.addCoplanarPair(envelope, satellite);
      for (const local of epicyclicWheelNames(comp)) {
        if (isSatellite(local)) train.addIgnoredPair(envelope, globalName(comp, local));
      }
    }
  });

  const satellites = epicyclicWheelNames(comp).filter(isSatellite).map((l) => globalName(comp, l));
  train.addEpicyclicBlock({
    compId: comp.id,
    carrier,
    planetA: globalName(comp, "planetaire_a"),
    planetB: globalName(comp, "planetaire_b"),
    meshes: blockMeshes,
    rigidSatellites: satellites.length > 1 ? [[satellites[0], satellites[1]]] : [],
    fixedMember: comp.fixedMember && comp.fixedMember !== "none" ? globalName(comp, EPICYCLIC_MEMBERS[comp.fixedMember]) : null,
  });

  return train;
}

/** specs : id -> spec ; effectiveIdlers : id -> (cle -> nb de renvois). */
function buildGlobalTrain(comps, specs = {}, effectiveIdlers = {}) {
  const train = new GearTrain();
  for (const comp of comps) {
    buildComplicationInto(train, comp, { ...(specs[comp.id] ?? {}), idlerCounts: effectiveIdlers[comp.id] ?? {} });
  }
  linkCarrierCams(train, comps);
  return train;
}

/**
 * Came qui pousse un porte-satellites : le bras porte-galet EST la cage, si
 * bien que sa longueur fige la distance entre l'axe de la came et l'axe
 * central du train epicycloidal. C'est un entraxe au meme titre qu'un
 * engrenement, et le placeur doit le tenir.
 *
 * La liaison se pose apres coup : elle relie deux complications, dont la
 * seconde n'existe pas encore quand la premiere se construit.
 */
function linkCarrierCams(train, comps) {
  for (const comp of comps) {
    const cam = comp.cam;
    if (!cam?.enabled || cam.followerType !== "angulaire" || cam.drives !== "porte-satellites") continue;
    if (!cam.carrierTarget || !(cam.pivotDistance > 0)) continue;
    const camName = globalName(comp, "came");
    const carrierName = `${cam.carrierTarget}.porte_satellites`;
    const camWheel = train.wheels.get(camName);
    if (!camWheel?.cam || !train.wheels.has(carrierName)) continue;

    // LE BRAS EST LA CAGE, PROLONGEE. Elle porte le satellite a l'entraxe
    // du train, puis continue au-dela pour aller palper la came : sa
    // longueur totale reste donc un reglage, simplement bornee par le bas
    // -- le bras doit au moins atteindre le satellite qu'il porte.
    // La construction ne DOIT PAS toucher aux reglages : elle s'execute
    // aussi sur des trains gabarits (dents par defaut, module 1), dont la
    // geometrie n'a rien de reelle. Ecrire dedans y ecraserait le reglage
    // de l'utilisateur par une valeur factice.
    const target = comps.find((c) => c.label === cam.carrierTarget);
    const arm = target ? epicyclicCenterDistance(train, target) : null;
    if (!(arm > 0)) continue;
    camWheel.cam.carrierArm = arm;

    train.addAxisLink(camName, carrierName, cam.pivotDistance, `bras de cage de ${cam.carrierTarget}`);

    // La cage ne fait pas un tour : elle OSCILLE, ici d'une quinzaine de
    // degres. Le satellite ne balaie donc qu'un petit arc, et lui reserver
    // le disque entier interdirait des placements parfaitement viables.
    //
    // On se garde en revanche d'ajouter une marge radiale « par securite » :
    // l'oscillation deplace le satellite TANGENTIELLEMENT, sa distance a
    // l'axe central ne bouge pas d'un cheveu. Une marge radiale inventerait
    // un conflit avec l'arbre central la ou il n'y en a aucun.
    const swing = Math.min(360, Math.abs(cam.swingAngle || 0));
    if (swing > 0 && swing < 180) {
      for (const [wheelName, wheel] of train.wheels) {
        if (wheel.envelope && wheelName.startsWith(`${cam.carrierTarget}.`)) wheel.sweep = 0;
      }
    }

    // La came IMPOSE l'orientation de la cage : le satellite n'est donc pas
    // libre sur son cercle, il se trouve sur le bras, entre le centre et le
    // galet. On fige sa distance a l'axe de came, sans quoi le dessin
    // montrerait un bras qui ne touche pas la came.
    const contact = camLeverState(camWheel.cam, 0);
    const satellite = `${cam.carrierTarget}.satellite_a`;
    if (contact && train.wheels.has(satellite)) {
      const t = arm / camWheel.cam.leverLength;
      const sx = contact.pivot.x + t * (contact.bec.x - contact.pivot.x);
      const sy = contact.pivot.y + t * (contact.bec.y - contact.pivot.y);
      train.addAxisLink(camName, satellite, Math.hypot(sx, sy), `orientation de cage imposée par ${comp.label}`);
    }
  }
}

/** Entraxe centre <-> satellite d'un train epicycloidal, dans un train construit. */
function epicyclicCenterDistance(train, comp) {
  const block = train.epicyclicBlocks.find((b) => b.carrier === globalName(comp, "porte_satellites"));
  if (!block || !block.meshes.length) return null;
  const step = block.meshes[0];
  const mesh = train.meshes.find(
    (m) => (m.wheelA === step.from && m.wheelB === step.to) || (m.wheelA === step.to && m.wheelB === step.from)
  );
  return mesh ? mesh.centerDistance(train.wheels) : null;
}

// ------------------------------------------------------------------
// Sens de rotation et renvois automatiques
// ------------------------------------------------------------------

/** Racines de propagation du sens : l'entree de chaque complication non raccordee. */
function senseRoots(comps) {
  const roots = new Map();
  for (const comp of comps) {
    // un membre immobilise est une racine a vitesse nulle : c'est lui qui
    // rend la relation de Willis determinee
    if (comp.topology === "epicyclic" && comp.fixedMember && comp.fixedMember !== "none") {
      roots.set(globalName(comp, EPICYCLIC_MEMBERS[comp.fixedMember]), 0);
    }
    if (comp.topology === "epicyclic" && comp.fixedMember === "none") {
      // les deux planetaires sont menes : le sens de la cage ne se deduit
      // pas de leurs signes seuls, il viendra des vitesses reelles
      const wA = signedTurnsPerHour(comp.diff?.a);
      const wB = signedTurnsPerHour(comp.diff?.b);
      if (Number.isFinite(wA)) roots.set(globalName(comp, "planetaire_a"), Math.sign(wA));
      if (Number.isFinite(wB)) roots.set(globalName(comp, "planetaire_b"), Math.sign(wB));
      continue;
    }
    if (comp.link.kind === "none" || !comp.link.wheel) roots.set(globalName(comp, comp.entree), comp.sensEntree);
  }
  return roots;
}

/**
 * Determine, complication par complication (dans l'ordre, chacune ne
 * dependant que des precedentes), le nombre EFFECTIF de renvois par
 * engrenement : ceux demandes par l'utilisateur, plus au plus UN renvoi
 * automatique si le sens de sortie souhaite n'est pas atteint (un seul
 * suffit toujours : chaque renvoi inverse la parite).
 * Retourne { effective: id -> (cle -> nb), info: id -> {...} }.
 */
function analyzeTrainSenses(comps) {
  const effective = {};
  const info = {};

  for (let k = 0; k < comps.length; k++) {
    const comp = comps[k];
    effective[comp.id] = {};
    for (const key of baseMeshKeys(comp)) effective[comp.id][key] = comp.idlers[key]?.count ?? 0;

    const prefix = comps.slice(0, k + 1);
    const build = () => buildGlobalTrain(prefix, {}, effective);
    const entreeG = resolveLocal(comp, comp.entree);
    const sortieG = globalName(comp, comp.sortie);

    let train = build();
    let sens = computeRotationSenses(train, senseRoots(prefix));
    let autoApplied = false;

    if (comp.sensSortie !== 0 && sens.get(sortieG) !== undefined && sens.get(sortieG) !== comp.sensSortie && comp.autoIdlerMesh) {
      effective[comp.id][comp.autoIdlerMesh] += 1;
      autoApplied = true;
      train = build();
      sens = computeRotationSenses(train, senseRoots(prefix));
    }

    const path = findKinematicPath(train, entreeG, sortieG);
    const nMeshes = path ? path.filter((s) => s.kind === "mesh").length : null;
    const totalIdlers = Object.values(effective[comp.id]).reduce((a, b) => a + b, 0);

    info[comp.id] = {
      sensEntree: sens.get(entreeG),
      sensSortie: sens.get(sortieG),
      nMeshes,
      totalIdlers,
      autoApplied,
      autoMesh: comp.autoIdlerMesh,
      satisfied: comp.sensSortie === 0 || sens.get(sortieG) === comp.sensSortie,
    };
  }

  return { effective, info };
}
