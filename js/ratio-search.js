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
    // Un engrenement de train epicycloidal ne dit rien tant que l'on ne
    // sait pas a quelle vitesse tourne le porte-satellites : son rapport
    // n'est vrai que dans le repere de la cage. La propagation ordinaire
    // l'ignore, la fermeture de Willis s'en charge ensuite.
    if (mesh.epicyclic) continue;
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

// ------------------------------------------------------------------
// Trains epicycloidaux : formule de Willis
// ------------------------------------------------------------------

/**
 * Rapport de BASE d'un train epicycloidal : le rapport omega_B / omega_A
 * mesure porte-satellites BLOQUE, donc celui d'un train ordinaire. Signe
 * compris -- chaque engrenement exterieur inverse, un engrenement interieur
 * conserve. C'est le R des formules (104), (115) d'Augereau, et c'est la
 * seule grandeur dont depend toute la cinematique du train.
 */
function epicyclicBasicRatio(train, block) {
  let ratio = 1;
  for (const step of block.meshes) {
    const zFrom = train.wheels.get(step.from)?.teeth;
    const zTo = train.wheels.get(step.to)?.teeth;
    if (!zFrom || !zTo) return NaN;
    ratio *= (step.internal ? 1 : -1) * (zFrom / zTo);
  }
  return ratio;
}

/**
 * Formule de Willis (133) : R = (w_B - w_U) / (w_A - w_U), soit
 *
 *     w_B = R.w_A + (1 - R).w_U
 *
 * Les trois membres -- les deux planetaires et le porte-satellites -- sont
 * lies par cette seule relation : en connaitre DEUX donne le troisieme.
 * C'est ce qui fait d'un train epicycloidal un differentiel : la position
 * du porte-satellites mesure l'ecart entre les deux planetaires, et c'est
 * exactement ainsi que se lit une reserve de marche (l'un des planetaires
 * suit l'arbre de barillet, l'autre le barillet).
 *
 * Retourne true si la fermeture a appris quelque chose.
 */
function closeWillis(train, block, speed) {
  const R = epicyclicBasicRatio(train, block);
  if (!Number.isFinite(R)) return false;

  const { planetA, planetB, carrier } = block;
  const known = (n) => speed.has(n);
  let learned = false;

  if (known(planetA) && known(carrier) && !known(planetB)) {
    speed.set(planetB, R * speed.get(planetA) + (1 - R) * speed.get(carrier));
    learned = true;
  } else if (known(planetB) && known(carrier) && !known(planetA)) {
    if (Math.abs(R) < 1e-12) return false;
    speed.set(planetA, (speed.get(planetB) - (1 - R) * speed.get(carrier)) / R);
    learned = true;
  } else if (known(planetA) && known(planetB) && !known(carrier)) {
    if (Math.abs(1 - R) < 1e-12) return false; // R = 1 : la cage est indeterminee
    speed.set(carrier, (speed.get(planetB) - R * speed.get(planetA)) / (1 - R));
    learned = true;
  }

  // Une fois deux membres connus, les satellites suivent : leur vitesse se
  // lit dans le repere de la cage puis se ramene au repere fixe.
  if (known(planetA) && known(carrier)) {
    const relative = speed.get(planetA) - speed.get(carrier);
    let cascade = relative;
    for (const step of block.meshes) {
      const zFrom = train.wheels.get(step.from)?.teeth;
      const zTo = train.wheels.get(step.to)?.teeth;
      if (!zFrom || !zTo) break;
      cascade *= (step.internal ? 1 : -1) * (zFrom / zTo);
      if (!speed.has(step.to) && step.to !== planetB) {
        speed.set(step.to, speed.get(carrier) + cascade);
        learned = true;
      }
    }
    // les satellites solidaires partagent la vitesse du premier
    for (const [a, b] of block.rigidSatellites ?? []) {
      if (speed.has(a) && !speed.has(b)) {
        speed.set(b, speed.get(a));
        learned = true;
      } else if (speed.has(b) && !speed.has(a)) {
        speed.set(a, speed.get(b));
        learned = true;
      }
    }
  }
  return learned;
}

/**
 * Propage le sens de rotation (vu de dessus : +1 horaire, -1 antihoraire)
 * a partir de mobiles "racines" dont le sens est impose. Chaque
 * engrenement EXTERIEUR inverse le sens ; un engrenement interieur et une
 * liaison rigide le conservent. `roots` est une Map nom -> sens. Retourne une Map nom -> sens
 * (les mobiles non atteints n'y figurent pas).
 */
function computeRotationSenses(train, roots) {
  // un engrenement EXTERIEUR inverse le sens ; un engrenement interieur et
  // une liaison rigide le conservent
  const value = propagateKinematics(train, roots, (cur, from, edge) => (edge.kind === "mesh" && !edge.internal ? -cur : cur), {
    requireDeterminate: true,
  });
  const sens = new Map();
  for (const [name, v] of value) if (v > 0) sens.set(name, 1);
  else if (v < 0) sens.set(name, -1);
  return sens;
}

/**
 * Un bloc epicycloidal ne livre un SENS non ambigu que si l'un de ses trois
 * membres est immobile : la relation de Willis est une somme, et le signe
 * d'une somme depend des grandeurs, pas seulement des signes. Un vrai
 * differentiel a deux entrees motrices n'a donc pas de sens de sortie
 * defini tant qu'on ne connait pas les vitesses reelles -- ce n'est pas une
 * limite du programme mais la nature meme du mecanisme.
 */
function epicyclicIsDeterminate(block, value) {
  return [block.planetA, block.planetB, block.carrier].some((n) => value.get(n) === 0);
}

/**
 * Propagation le long du graphe cinematique, entrecoupee de fermetures de
 * Willis. Les deux alternent jusqu'au point fixe : un membre debloque par
 * un train epicycloidal relance la propagation ordinaire en aval, qui peut
 * a son tour donner le deuxieme membre d'un autre bloc.
 */
function propagateKinematics(train, roots, transfer, options = {}) {
  const adjacency = buildKinematicGraph(train);
  const value = new Map();
  const pending = [];
  const put = (name, v) => {
    if (!adjacency.has(name) || value.has(name) || !Number.isFinite(v)) return;
    value.set(name, v);
    pending.push(name);
  };
  for (const [name, v] of roots) put(name, v);

  const drain = () => {
    while (pending.length) {
      const current = pending.shift();
      const cur = value.get(current);
      for (const edge of adjacency.get(current)) {
        if (!value.has(edge.to)) put(edge.to, transfer(cur, current, edge));
      }
    }
  };

  drain();
  const blocks = train.epicyclicBlocks ?? [];
  for (let pass = 0; pass <= blocks.length; pass++) {
    let learned = false;
    for (const block of blocks) {
      if (options.requireDeterminate && !epicyclicIsDeterminate(block, value)) continue;
      const before = new Set(value.keys());
      if (closeWillis(train, block, value)) {
        learned = true;
        for (const name of value.keys()) if (!before.has(name)) pending.push(name);
      }
    }
    if (!learned) break;
    drain();
  }
  return value;
}

/**
 * Vitesses angulaires SIGNEES de tous les mobiles, propagees depuis des
 * racines dont la vitesse est connue (Map nom -> vitesse, signe = sens).
 * Une liaison rigide conserve la vitesse ; un engrenement la multiplie par
 * Z_amont / Z_aval, avec inversion du signe si la denture est exterieure.
 * Le signe du resultat coincide donc avec computeRotationSenses.
 */
function computeAngularVelocities(train, roots) {
  return propagateKinematics(train, roots, (cur, from, edge) => {
    if (edge.kind === "rigid") return cur;
    const zFrom = train.wheels.get(from).teeth;
    const zTo = train.wheels.get(edge.to).teeth;
    if (!zFrom || !zTo) return NaN;
    return (cur * zFrom * (edge.internal ? 1 : -1)) / zTo;
  });
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

/**
 * Recherche par ENUMERATION, pour les trains dont les dents ne sont pas
 * librement factorisables. `findTrainForRatio` decompose independamment le
 * numerateur et le denominateur : c'est rapide, mais incapable d'exprimer
 * une contrainte qui LIE les roues entre elles. Le train revertant en
 * impose une : ses deux engrenements relient le meme couple d'axes, donc
 * m1*(Za+Zb) = m2*(Zc+Zd). Ici on balaye donc toutes les positions sauf
 * une, la derniere etant DEDUITE du ratio, et l'on soumet chaque
 * combinaison complete a `options.rate`.
 *
 * `rate(values)` recoit le tableau des dents (dans l'ordre de `positions`,
 * reutilise d'un appel a l'autre : ne pas le conserver) et retourne null
 * pour rejeter la combinaison, ou { penalty } pour la classer -- penalite
 * croissante = moins bon. Les candidats dans la tolerance sont tries par
 * penalite puis erreur ; les candidats de secours par erreur d'abord.
 *
 * Le cout est le PRODUIT des plages balayees : reserve aux topologies a
 * quatre mobiles, avec `maxIterations` comme garde-fou.
 */
function findTrainByEnumeration(ratio, positions, options = {}) {
  const maxResults = options.maxResults ?? 10;
  const maxIterations = options.maxIterations ?? 1500000;
  const tol = Number.isFinite(options.tol) && options.tol >= 0 ? options.tol : 1e-4;
  const rate = options.rate ?? (() => ({ penalty: 0 }));

  // Par defaut le ratio est un simple produit de dents^exposant, et la
  // position pivot s'en deduit par division. Un train epicycloidal n'a pas
  // cette forme -- son rapport est une fonction homographique du rapport de
  // base (formule de Willis) -- d'ou ces deux crochets.
  const achieve =
    options.achieve ??
    ((values) => {
      let product = 1;
      for (let i = 0; i < positions.length; i++) {
        const e = positions[i].exponent;
        if (e === 1) product *= values[i];
        else if (e === -1) product /= values[i];
      }
      return product;
    });
  const solvePivot =
    options.solvePivot ??
    ((values, pivotIdx) => {
      let rest = 1;
      for (let i = 0; i < positions.length; i++) {
        if (i === pivotIdx) continue;
        const e = positions[i].exponent;
        if (e === 1) rest *= values[i];
        else if (e === -1) rest /= values[i];
      }
      if (!(rest > 0)) return NaN;
      return positions[pivotIdx].exponent === 1 ? ratio / rest : rest / ratio;
    });

  // pivot : une position qui pese sur le ratio ET qui n'est pas figee,
  // donc que l'on peut deduire des autres au lieu de la balayer
  let pivot = -1;
  for (let i = positions.length - 1; i >= 0; i--) {
    if (positions[i].exponent !== 0 && positions[i].min < positions[i].max) {
      pivot = i;
      break;
    }
  }
  if (options.pivot !== undefined) pivot = options.pivot;

  const sweep = positions.map((_, i) => i).filter((i) => i !== pivot);
  const values = new Array(positions.length);

  const withinTol = [];
  const closest = [];
  const byQuality = (x, y) => x.penalty - y.penalty || x.error - y.error || x.sum - y.sum;
  const byError = (x, y) => x.error - y.error || x.penalty - y.penalty || x.sum - y.sum;
  const keepBest = (list, cand, cmp) => {
    let i = list.length;
    while (i > 0 && cmp(cand, list[i - 1]) < 0) i--;
    if (i >= maxResults) return;
    list.splice(i, 0, cand);
    if (list.length > maxResults) list.pop();
  };

  let iterations = 0;
  let truncated = false;

  const consider = () => {
    if (pivot >= 0) {
      const exact = solvePivot(values, pivot);
      if (!Number.isFinite(exact)) return;
      const z = Math.round(exact);
      if (z < positions[pivot].min || z > positions[pivot].max) return;
      values[pivot] = z;
    }

    const achieved = achieve(values);
    if (!Number.isFinite(achieved)) return;
    const error = Math.abs(ratio - achieved);
    // les candidats de secours ne servent plus des qu'une solution dans la
    // tolerance existe : inutile de payer `rate` pour eux
    if (error > tol && withinTol.length > 0) return;

    const verdict = rate(values);
    if (!verdict) return;

    const cand = {
      teeth: values.slice(),
      ratio: achieved,
      error,
      penalty: verdict.penalty ?? 0,
      meta: verdict,
      sum: values.reduce((a, b) => a + b, 0),
    };
    if (error <= tol) keepBest(withinTol, cand, byQuality);
    else keepBest(closest, cand, byError);
  };

  const rec = (k) => {
    if (k === sweep.length) {
      if (++iterations > maxIterations) {
        truncated = true;
        return;
      }
      consider();
      return;
    }
    const p = positions[sweep[k]];
    for (let z = p.min; z <= p.max; z++) {
      values[sweep[k]] = z;
      rec(k + 1);
      if (truncated) return;
    }
  };
  rec(0);

  const exceedsTol = withinTol.length === 0 && closest.length > 0;
  return { results: exceedsTol ? closest : withinTol, truncated, exceedsTol };
}
