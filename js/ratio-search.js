/**
 * ratio-search.js
 * Port et generalisation de l'algorithme de recherche de ratio fourni par
 * l'utilisateur (gear.js, calcc/pk/pkb pour les chaines en cascade, calcr
 * pour le train "revertant" a sortie coaxiale). Ici transforme en fonctions
 * pures (pas de couplage DOM), et generalise pour accepter des bornes
 * min/max INDIVIDUELLES par roue plutot qu'une seule paire [minw,maxw]
 * globale -- ce qui permet aussi d'imposer une valeur fixe (min == max).
 */

/**
 * Cherche une decomposition de `n` en `bounds.length` facteurs entiers,
 * chaque facteur i devant respecter bounds[i] = {min, max}. L'ORDRE des
 * positions compte (contrairement a l'algo original ou toutes les
 * positions d'un meme cote partageaient les memes bornes).
 * Parmi toutes les decompositions valides, retourne celle de somme
 * minimale (proxy de compacite, comme le faisait `pk` a l'origine).
 */
function factorInto(n, bounds) {
  let best = null;
  let bestSum = Infinity;

  function rec(remaining, idx, chosen) {
    if (idx === bounds.length) {
      if (remaining === 1) {
        const s = chosen.reduce((acc, v) => acc + v, 0);
        if (s < bestSum) {
          bestSum = s;
          best = chosen.slice();
        }
      }
      return;
    }
    const { min, max } = bounds[idx];
    const hi = Math.min(max, remaining);
    for (let v = min; v <= hi; v++) {
      if (remaining % v === 0) {
        chosen.push(v);
        rec(remaining / v, idx + 1, chosen);
        chosen.pop();
      }
    }
  }

  rec(n, 0, []);
  return best;
}

/**
 * Construit le graphe cinematique du train : chaque engrenement est une
 * arete "mesh" (toujours valide, contribue a la vitesse relative), chaque
 * groupe d'axe RIGIDE fournit des aretes "rigid" (vitesse identique, cout
 * nul) entre ses membres. Un groupe marque independant (ex: l'axe principal
 * d'un train revertant) ne fournit AUCUNE arete directe entre ses membres :
 * ils ne partagent que leur position, pas leur vitesse.
 */
function buildKinematicGraph(train) {
  const adjacency = new Map();
  for (const name of train.wheels.keys()) adjacency.set(name, []);

  for (const mesh of train.meshes) {
    const internal = train.isInternalMesh(mesh);
    adjacency.get(mesh.wheelA).push({ to: mesh.wheelB, kind: "mesh", internal });
    adjacency.get(mesh.wheelB).push({ to: mesh.wheelA, kind: "mesh", internal });
  }

  for (const [group, names] of train.axisGroups()) {
    if (!train.isRigidGroup(group)) continue;
    for (let i = 0; i < names.length; i++) {
      for (let j = i + 1; j < names.length; j++) {
        adjacency.get(names[i]).push({ to: names[j], kind: "rigid" });
        adjacency.get(names[j]).push({ to: names[i], kind: "rigid" });
      }
    }
  }

  // couplages rigides explicites (membres d'un axe independant qui, eux,
  // tournent bien ensemble)
  for (const [a, b] of train.rigidPairs ?? []) {
    if (!adjacency.has(a) || !adjacency.has(b)) continue;
    adjacency.get(a).push({ to: b, kind: "rigid" });
    adjacency.get(b).push({ to: a, kind: "rigid" });
  }
  return adjacency;
}

/**
 * Propage le sens de rotation (vu de dessus : +1 horaire, -1 antihoraire)
 * a partir de mobiles "racines" dont le sens est impose. Chaque
 * engrenement EXTERIEUR inverse le sens ; un engrenement interieur et une
 * liaison rigide le conservent. `roots` est une Map nom -> sens. Retourne une Map nom -> sens
 * (les mobiles non atteints n'y figurent pas).
 */
function computeRotationSenses(train, roots) {
  const adjacency = buildKinematicGraph(train);
  const sens = new Map();
  for (const [root, s] of roots) {
    if (!adjacency.has(root) || sens.has(root)) continue;
    sens.set(root, s);
    const queue = [root];
    while (queue.length) {
      const current = queue.shift();
      const cur = sens.get(current);
      for (const edge of adjacency.get(current)) {
        if (sens.has(edge.to)) continue;
        // un engrenement EXTERIEUR inverse le sens ; un engrenement
        // interieur le conserve (les deux mobiles tournent ensemble)
        sens.set(edge.to, edge.kind === "mesh" && !edge.internal ? -cur : cur);
        queue.push(edge.to);
      }
    }
  }
  return sens;
}

/**
 * Vitesses angulaires SIGNEES de tous les mobiles, propagees depuis des
 * racines dont la vitesse est connue (Map nom -> vitesse, signe = sens).
 * Une liaison rigide conserve la vitesse ; un engrenement la multiplie par
 * Z_amont / Z_aval, avec inversion du signe si la denture est exterieure.
 * Le signe du resultat coincide donc avec computeRotationSenses.
 */
function computeAngularVelocities(train, roots) {
  const adjacency = buildKinematicGraph(train);
  const speed = new Map();
  for (const [root, w0] of roots) {
    if (!adjacency.has(root) || speed.has(root)) continue;
    speed.set(root, w0);
    const queue = [root];
    while (queue.length) {
      const current = queue.shift();
      const cur = speed.get(current);
      const zCur = train.wheels.get(current).teeth;
      for (const edge of adjacency.get(current)) {
        if (speed.has(edge.to)) continue;
        if (edge.kind === "rigid") {
          speed.set(edge.to, cur);
        } else {
          const zNext = train.wheels.get(edge.to).teeth;
          speed.set(edge.to, (cur * zCur * (edge.internal ? 1 : -1)) / zNext);
        }
        queue.push(edge.to);
      }
    }
  }
  return speed;
}

/**
 * Recherche en largeur le chemin cinematique entre `entree` et `sortie`
 * dans le graphe (engrenements + liaisons rigides). Retourne la liste
 * ordonnee des sauts {from, to, kind}, ou null si aucun chemin n'existe.
 */
function findKinematicPath(train, entree, sortie) {
  if (entree === sortie) return [];

  const adjacency = buildKinematicGraph(train);
  const visited = new Set([entree]);
  const parent = new Map();
  const queue = [entree];

  while (queue.length) {
    const current = queue.shift();
    if (current === sortie) break;
    for (const edge of adjacency.get(current) ?? []) {
      if (!visited.has(edge.to)) {
        visited.add(edge.to);
        parent.set(edge.to, { from: current, kind: edge.kind });
        queue.push(edge.to);
      }
    }
  }

  if (!visited.has(sortie)) return null;

  const path = [];
  let cursor = sortie;
  while (cursor !== entree) {
    const { from, kind } = parent.get(cursor);
    path.push({ from, to: cursor, kind });
    cursor = from;
  }
  return path.reverse();
}

/**
 * Calcule, pour CHAQUE mobile du train, l'exposant e_i tel que
 *   vitesse(sortie) / vitesse(entree) = produit( dents_i ^ e_i )
 * Chaque engrenement traverse contribue +1 au mobile quitte et -1 au
 * mobile atteint (relation Z_P * w_P = Z_Q * w_Q) ; chaque liaison rigide
 * ne contribue rien (meme vitesse). Retourne null si aucun chemin
 * cinematique n'existe (ex: les deux mobiles choisis appartiennent au
 * meme axe INDEPENDANT, sans lien direct).
 */
function computeRatioExponents(train, entree, sortie) {
  const exponents = {};
  for (const name of train.wheels.keys()) exponents[name] = 0;

  const path = findKinematicPath(train, entree, sortie);
  if (path === null) return null;

  for (const { from, to, kind } of path) {
    if (kind === "mesh") {
      exponents[from] += 1;
      exponents[to] -= 1;
    }
  }
  return exponents;
}

/**
 * Retourne la liste ordonnee des ENGRENEMENTS (sauts "mesh" uniquement,
 * liaisons rigides ignorees) rencontres en suivant le chemin cinematique
 * de `entree` vers `sortie`. Chaque element est [wheelA, wheelB] dans
 * l'ordre de traversee. Sert a determiner l'ordre dans lequel le module
 * doit croitre/decroitre le long du train (le couple augmente a mesure
 * que la vitesse diminue).
 */
function meshOrderAlongPath(train, entree, sortie) {
  const path = findKinematicPath(train, entree, sortie);
  if (path === null) return null;
  return path.filter((step) => step.kind === "mesh").map((step) => [step.from, step.to]);
}

/**
 * Recherche generalisee : `positions` est un tableau ordonne de
 * { name, min, max, exponent }. Le ratio cible doit etre atteint par
 *   produit( teeth_i ^ exponent_i ), exponent_i valant -1, 0 ou +1.
 * Les positions d'exposant 0 (hors du chemin entree->sortie) recoivent une
 * valeur representative (milieu de leurs bornes) : elles ne pesent pas sur
 * le ratio, seulement sur la geometrie ulterieure.
 *
 * `options.tol` est l'ecart ABSOLU admis sur le ratio : seules les
 * combinaisons qui le respectent sont retournees. Si aucune ne l'atteint,
 * on retourne quand meme les plus proches avec `exceedsTol: true` -- un
 * tableau vide n'apprendrait rien sur la distance qui reste a couvrir.
 */
function findTrainForRatio(ratio, positions, options = {}) {
  const maxResults = options.maxResults ?? 10;
  const maxIterations = options.maxIterations ?? 400000;
  const tol = Number.isFinite(options.tol) && options.tol >= 0 ? options.tol : 1e-4;

  const numPos = positions.filter((p) => p.exponent === 1);
  const denPos = positions.filter((p) => p.exponent === -1);
  const freePos = positions.filter((p) => p.exponent === 0);

  const freeValues = freePos.map((p) => Math.round((p.min + p.max) / 2));

  function assemble(numValues, denValues) {
    const byName = {};
    numPos.forEach((p, i) => (byName[p.name] = numValues[i]));
    denPos.forEach((p, i) => (byName[p.name] = denValues[i]));
    freePos.forEach((p, i) => (byName[p.name] = freeValues[i]));
    return positions.map((p) => byName[p.name]);
  }

  // cas degenere : entree == sortie (ou chemin sans engrenement), ratio fige a 1
  if (numPos.length === 0 && denPos.length === 0) {
    const err = Math.abs(ratio - 1);
    if (err > tol) return { results: [], truncated: false, degenerate: true };
    return { results: [{ teeth: assemble([], []), ratio: 1, error: err }], truncated: false, degenerate: true };
  }

  const dMin = denPos.reduce((p, b) => p * b.min, 1);
  const dMax = denPos.reduce((p, b) => p * b.max, 1);
  const nMin = numPos.reduce((p, b) => p * b.min, 1);
  const nMax = numPos.reduce((p, b) => p * b.max, 1);

  const dLo = Math.max(dMin, Math.ceil(nMin / ratio));
  const dHi = Math.min(dMax, Math.floor(nMax / ratio) + 1);

  // Deux listes BORNEES a maxResults et maintenues triees par erreur
  // croissante : celles qui respectent la tolerance, et en secours les
  // plus proches (utilisees seulement si la premiere reste vide). Borner
  // evite aussi d'accumuler des dizaines de milliers de candidats en
  // memoire avant de n'en garder que dix.
  const withinTol = [];
  const closest = [];
  const keepBest = (list, cand) => {
    let i = list.length;
    while (i > 0 && list[i - 1].error > cand.error) i--;
    if (i >= maxResults) return;
    list.splice(i, 0, cand);
    if (list.length > maxResults) list.pop();
  };

  let iterations = 0;
  let truncated = false;

  for (let D = dLo; D <= dHi; D++) {
    if (++iterations > maxIterations) {
      truncated = true;
      break;
    }
    const N = Math.round(D * ratio);
    if (N < nMin || N > nMax) continue;
    const err = Math.abs(ratio - N / D);

    // elagage avant la factorisation (de loin le poste le plus couteux) :
    // les secours ne serviront plus des qu'une solution dans la tolerance
    // existe, et une liste pleine rejette tout ce qui ne l'ameliore pas
    if (err > tol && withinTol.length > 0) continue;
    const target = err <= tol ? withinTol : closest;
    if (target.length === maxResults && err >= target[target.length - 1].error) continue;

    const denValues = factorInto(D, denPos);
    if (!denValues) continue;
    const numValues = factorInto(N, numPos);
    if (!numValues) continue;

    keepBest(target, { teeth: assemble(numValues, denValues), ratio: N / D, error: err });
  }

  const exceedsTol = withinTol.length === 0 && closest.length > 0;
  return { results: exceedsTol ? closest : withinTol, truncated, exceedsTol };
}
