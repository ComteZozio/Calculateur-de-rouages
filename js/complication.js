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
 * Nombre maximal d'etages d'une chaine simple. Trois suffisent aux cibles
 * de la bibliotheque (la plus lourde, 1 tour par an, demande 365 de
 * demultiplication) et au-dela la recherche de modules explose : le
 * nombre de sequences monotones croit comme C(m + k - 1, k).
 */
const MAX_STAGES = 3;

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
 * Ratio effectivement recherche : soit celui saisi directement, soit celui
 * deduit des deux vitesses. La convention est celle de
 * computeRatioExponents : ratio = vitesse(sortie) / vitesse(entree).
 */
function effectiveRatio(comp) {
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
 * Applique un preset : passe en mode vitesses et recopie son gabarit
 * complet. Les bornes sont posees APRES les etages, puisque la liste des
 * mobiles en depend.
 */
function applyLibraryPreset(comp, id) {
  const preset = libraryPreset(id);
  comp.preset = preset ? id : "none";
  if (!preset) return;
  comp.ratioMode = "speeds";
  comp.speedIn = { ...preset.speedIn };
  comp.speedOut = { ...preset.speedOut };
  comp.topology = "compound";
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
    topology: "compound", // "compound" | "reverted"
    stages: 2,
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

function localWheelNames(comp) {
  if (comp.topology === "reverted") return ["roue_a_entree", "roue_b_satellite", "roue_c_sortie", "roue_d_satellite"];
  const names = [];
  for (let i = 1; i <= comp.stages; i++) names.push(`roue${i}`, `pignon${i}`);
  return names;
}

function localAxisGroups(comp) {
  const g = {};
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
  return comp.topology === "reverted" ? ["axe_principal"] : [];
}

/** Engrenements de base (avant insertion des renvois), dans l'ordre de construction. */
function localBaseMeshes(comp) {
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
  if (comp.topology !== "reverted") comp.topology = "compound";

  const names = localWheelNames(comp);
  const bounds = {};
  for (const n of names) bounds[n] = comp.bounds[n] ?? { min: 8, max: 60, fixed: false };
  comp.bounds = bounds;

  const internal = {};
  for (const n of names) internal[n] = !!(comp.internal && comp.internal[n]);
  // deux dentures interieures ne peuvent pas engrener l'une dans l'autre
  for (const [a, b] of localBaseMeshes(comp)) {
    if (internal[a] && internal[b]) internal[b] = false;
  }
  comp.internal = internal;

  if (!names.includes(comp.entree)) comp.entree = names[0];
  if (!names.includes(comp.sortie)) comp.sortie = comp.topology === "reverted" ? "roue_c_sortie" : names[names.length - 1];

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

  for (const local of names) {
    if (shared && local === comp.entree) continue; // la roue existe deja
    const key = baseMeshOfLocal(comp, local);
    const module = moduleByMesh[key] ?? 1;
    let group = `${comp.label}.${groups[local]}`;
    if (mergedLocalGroup && groups[local] === mergedLocalGroup) group = driver.axisGroup;
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

  return train;
}

/** specs : id -> spec ; effectiveIdlers : id -> (cle -> nb de renvois). */
function buildGlobalTrain(comps, specs = {}, effectiveIdlers = {}) {
  const train = new GearTrain();
  for (const comp of comps) {
    buildComplicationInto(train, comp, { ...(specs[comp.id] ?? {}), idlerCounts: effectiveIdlers[comp.id] ?? {} });
  }
  return train;
}

// ------------------------------------------------------------------
// Sens de rotation et renvois automatiques
// ------------------------------------------------------------------

/** Racines de propagation du sens : l'entree de chaque complication non raccordee. */
function senseRoots(comps) {
  const roots = new Map();
  for (const comp of comps) {
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
