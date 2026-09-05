/**
 * placer.js
 * Recherche de placement compact d'un train de rouages sous contrainte de
 * platine circulaire.
 *
 * Les mobiles vivent sur plusieurs NIVEAUX (hauteurs le long des arbres) :
 * deux roues qui engrenent sont forcement au meme niveau, deux roues
 * portees par le meme arbre sont forcement a des niveaux differents, et
 * deux roues de niveaux differents peuvent se recouvrir en projection 2D
 * sans se toucher. Chaque redemarrage tire une repartition des niveaux
 * valide au hasard, puis place les axes par parcours en largeur avec des
 * angles discretises. Des positions IMPOSEES (par clic) peuvent fixer
 * certains axes : la chaine se referme alors dessus par intersection de
 * cercles.
 */

function mulberry32(seed) {
  let a = seed >>> 0;
  return function () {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function shuffle(array, rng) {
  for (let i = array.length - 1; i > 0; i--) {
    const j = Math.floor(rng() * (i + 1));
    [array[i], array[j]] = [array[j], array[i]];
  }
}

/** Intersections de deux cercles (0, 1 ou 2 points). */
function circleIntersections(c1, r1, c2, r2) {
  const dx = c2.x - c1.x;
  const dy = c2.y - c1.y;
  const d = Math.hypot(dx, dy);
  if (d < 1e-9) return [];
  if (d > r1 + r2 + 1e-9 || d < Math.abs(r1 - r2) - 1e-9) return [];
  const a = (r1 * r1 - r2 * r2 + d * d) / (2 * d);
  const h2 = r1 * r1 - a * a;
  const h = h2 > 0 ? Math.sqrt(h2) : 0;
  const mx = c1.x + (a * dx) / d;
  const my = c1.y + (a * dy) / d;
  if (h < 1e-9) return [{ x: mx, y: my }];
  return [
    { x: mx + (h * dy) / d, y: my - (h * dx) / d },
    { x: mx - (h * dy) / d, y: my + (h * dx) / d },
  ];
}

const FIXED_TOLERANCE = 0.05; // mm : ecart admis entre deux positions imposees adjacentes

class Layout {
  constructor(positions, score, levels, stats = {}) {
    this.positions = positions; // Map wheelName -> {x, y}
    this.score = score; // rayon englobant, en mm
    this.levels = levels ?? new Map(); // Map wheelName -> niveau (1..n)
    this.coveredAxes = stats.coveredAxes ?? 0; // arbres recouverts (donc a pont)
    this.axisCount = stats.axisCount ?? 0;
    this.levelCount = stats.levelCount ?? 1; // niveaux REELLEMENT utilises
  }
}

class Placer {
  constructor(train, options = {}) {
    this.train = train;
    this.plateRadius = options.plateRadius ?? 15;
    this.plateCenter = options.plateCenter ?? { x: 0, y: 0 };
    this.angleStep = ((options.angleStepDeg ?? 5) * Math.PI) / 180;
    this.protectedWheels = new Set(options.protectedWheels ?? []);
    this.nRandomRestarts = options.nRandomRestarts ?? 200;
    this.rng = mulberry32(options.seed ?? Date.now());
    this.rootWheel = options.rootWheel ?? null;
    // `levels` est un PLAFOND : place() part du minimum structurel et
    // n'ajoute une hauteur que si la precedente ne suffit pas, l'objectif
    // etant le mouvement le plus plat possible.
    this.maxLevels = Math.max(1, Math.floor(options.levels ?? 2));
    this.levels = this.maxLevels;
    // Un arbre n'est pas un point : son diametre suit la taille de la
    // platine (une montre de 30 mm et une pendule n'ont pas les memes
    // pivots). C'est ce disque, et non le centre geometrique, qu'un autre
    // mobile recouvre ou laisse libre.
    this.arborRadius = Math.max(0, options.arborRadius ?? 0);
    this.arborBand = { inner: 0, outer: this.arborRadius };

    this.axisGroups = train.axisGroups();
    this.wheelToGroup = new Map();
    for (const [group, names] of this.axisGroups) for (const n of names) this.wheelToGroup.set(n, group);

    this.groupEdges = new Map();
    for (const g of this.axisGroups.keys()) this.groupEdges.set(g, []);
    for (const mesh of train.meshes) {
      const ga = this.wheelToGroup.get(mesh.wheelA);
      const gb = this.wheelToGroup.get(mesh.wheelB);
      const d = mesh.centerDistance(train.wheels);
      this.groupEdges.get(ga).push([gb, d]);
      this.groupEdges.get(gb).push([ga, d]);
    }

    // Un entraxe impose par une piece (bras de came) contraint le placement
    // exactement comme un engrenement : deux axes a distance connue. En
    // l'ajoutant ici, la fermeture de chaine, le calcul des composantes et
    // la detection de conflits en heritent sans autre modification.
    for (const link of train.axisLinks ?? []) {
      const ga = this.wheelToGroup.get(link.wheelA);
      const gb = this.wheelToGroup.get(link.wheelB);
      if (!ga || !gb || ga === gb) continue;
      this.groupEdges.get(ga).push([gb, link.distance]);
      this.groupEdges.get(gb).push([ga, link.distance]);
    }

    this.meshPairs = new Set();
    for (const mesh of train.meshes) this.meshPairs.add(this._pairKey(mesh.wheelA, mesh.wheelB));

    // positions imposees : par axe (tous les mobiles coaxiaux partagent la position)
    this.fixedPositions = new Map();
    this.positionProblems = [];
    for (const [name, pos] of options.fixedPositions ?? []) {
      const g = this.wheelToGroup.get(name);
      if (!g) continue;
      const prev = this.fixedPositions.get(g);
      if (prev && Math.hypot(prev.x - pos.x, prev.y - pos.y) > 1e-6) {
        this.positionProblems.push(`${name} et un mobile coaxial ont deux positions imposées différentes.`);
        continue;
      }
      this.fixedPositions.set(g, pos);
      if (!this._withinPlate(pos, this._groupOuterRadius(g))) this.positionProblems.push(`${name} : la position imposée fait sortir la roue de la platine.`);
    }

    // classes de niveau : composantes connexes par engrenement (une roue,
    // ses renvois et sa partenaire sont forcement a la meme hauteur)
    this.classOf = new Map();
    const parent = new Map();
    const find = (x) => {
      while (parent.get(x) !== x) {
        parent.set(x, parent.get(parent.get(x)));
        x = parent.get(x);
      }
      return x;
    };
    for (const name of train.wheels.keys()) parent.set(name, name);
    for (const mesh of train.meshes) parent.set(find(mesh.wheelA), find(mesh.wheelB));
    // mobiles forcement a la meme hauteur sans engrener : l'enveloppe
    // balayee par un satellite est au niveau de ce satellite
    for (const [a, b] of train.coplanarPairs ?? []) {
      if (parent.has(a) && parent.has(b)) parent.set(find(a), find(b));
    }
    let nextId = 0;
    const idOfRoot = new Map();
    for (const name of train.wheels.keys()) {
      const r = find(name);
      if (!idOfRoot.has(r)) idOfRoot.set(r, nextId++);
      this.classOf.set(name, idOfRoot.get(r));
    }
    this.classesOfGroup = new Map();
    for (const [group, names] of this.axisGroups) this.classesOfGroup.set(group, [...new Set(names.map((n) => this.classOf.get(n)))]);
    this.classNeighbors = new Map();
    for (let c = 0; c < nextId; c++) this.classNeighbors.set(c, new Set());
    for (const classes of this.classesOfGroup.values()) {
      for (const a of classes) for (const b of classes) if (a !== b) this.classNeighbors.get(a).add(b);
    }

    // composantes connexes du graphe des axes (complications independantes)
    this.components = [];
    const seen = new Set();
    for (const g of this.axisGroups.keys()) {
      if (seen.has(g)) continue;
      this.components.push(this._bfsOrder(g, seen));
    }
  }

  _pairKey(a, b) {
    return a < b ? `${a}|${b}` : `${b}|${a}`;
  }

  /**
   * Paires dispensees de tout controle geometrique : celles qui engrenent
   * (elles se touchent par construction), celles declarees solidaires d'un
   * meme sous-ensemble (un satellite et l'enveloppe qu'il decrit), et
   * celles dont l'un des membres n'a aucune matiere -- la cage d'un train
   * epicycloidal n'est representee que par son enveloppe.
   */
  _exempt(w1, w2) {
    if (this.meshPairs.has(this._pairKey(w1, w2))) return true;
    if (this.train.isIgnoredPair?.(w1, w2)) return true;
    return this.train.wheels.get(w1).band.outer <= 0 || this.train.wheels.get(w2).band.outer <= 0;
  }

  /** Nombre minimal de niveaux : le plus grand nombre de classes portees par un meme arbre. */
  requiredLevels() {
    let max = 1;
    for (const classes of this.classesOfGroup.values()) max = Math.max(max, classes.length);
    return max;
  }

  /**
   * Nombre de groupes d'engrenement (classes). Des qu'il depasse le nombre
   * de niveaux, au moins deux groupes partagent forcement une hauteur --
   * ce n'est pas redhibitoire (ils peuvent etre loin l'un de l'autre), mais
   * c'est la premiere cause d'echec sur les trains longs, ou des axes
   * voisins d'un cran se retrouvent au meme niveau a un entraxe impose.
   */
  classCount() {
    return this.classNeighbors.size;
  }

  /**
   * Situations impossibles quel que soit l'angle ou la repartition des
   * niveaux : arbre portant plus de roues que de niveaux, positions
   * imposees incoherentes, collision entre deux roues forcement au meme
   * niveau (meme classe) dont l'entraxe est fixe par construction, et
   * recouvrement d'un centre protege par une roue directement voisine.
   */
  diagnoseFixedConflicts() {
    const conflicts = [];
    for (const message of this.positionProblems) conflicts.push({ kind: "position", message });

    // Un mobile plus large que la platine ne se placera jamais : ni l'angle,
    // ni le niveau, ni le nombre de redemarrages n'y changeront rien. Le
    // dire tout de suite evite d'epuiser toute la recherche pour rien.
    for (const [name, wheel] of this.train.wheels) {
      if (wheel.outerRadius > this.plateRadius + 1e-9) {
        conflicts.push({ kind: "platine", wheel: name, radius: wheel.outerRadius, plateRadius: this.plateRadius });
      }
    }
    for (const [group, classes] of this.classesOfGroup) {
      if (classes.length > this.maxLevels) conflicts.push({ kind: "niveaux", group, needed: classes.length, wheels: this.axisGroups.get(group) });
    }

    // deux axes DISTINCTS imposes au meme point : c'est un montage
    // coaxial, legitime tant que les mobiles finissent a des hauteurs
    // differentes -- sauf si un centre protege est en jeu, car aucun
    // niveau ne peut alors sauver le placement (il faudrait un pont)
    const byPoint = new Map();
    for (const [group, pos] of this.fixedPositions) {
      const key = `${pos.x.toFixed(4)},${pos.y.toFixed(4)}`;
      if (!byPoint.has(key)) byPoint.set(key, []);
      byPoint.get(key).push(group);
    }
    for (const groups of byPoint.values()) {
      if (groups.length < 2) continue;
      const wheels = groups.flatMap((g) => this.axisGroups.get(g));
      const guarded = wheels.filter((w) => this.protectedWheels.has(w));
      if (guarded.length) {
        conflicts.push({
          kind: "position",
          message: `${wheels.join(", ")} sont imposés sur le même axe, mais ${guarded.join(
            ", "
          )} exige un centre toujours dégagé : décoche cette protection si un pont est acceptable, ou écarte l'une des deux positions.`,
        });
      }
    }

    // Deux engrenements qui relient le MEME couple d'axes doivent demander
    // le meme entraxe -- c'est la contrainte du train revertant. Sans ce
    // controle l'echec serait muet : _parentAndDistance ne retient que le
    // premier voisin place, le second entraxe serait simplement ignore et
    // la seconde paire dessinee sans engrener.
    const meshesByAxisPair = new Map();
    const record = (a, b, distance, label) => {
      const key = this._pairKey(this.wheelToGroup.get(a), this.wheelToGroup.get(b));
      if (!meshesByAxisPair.has(key)) meshesByAxisPair.set(key, []);
      meshesByAxisPair.get(key).push({ mesh: { wheelA: a, wheelB: b }, distance, label });
    };
    for (const mesh of this.train.meshes) record(mesh.wheelA, mesh.wheelB, mesh.centerDistance(this.train.wheels));
    // une liaison de bras et un engrenement entre les memes axes doivent
    // demander le meme entraxe, sans quoi la piece ne se monte pas
    for (const link of this.train.axisLinks ?? []) record(link.wheelA, link.wheelB, link.distance, link.reason);
    for (const list of meshesByAxisPair.values()) {
      if (list.length < 2) continue;
      const reference = list[0];
      for (const other of list.slice(1)) {
        if (Math.abs(other.distance - reference.distance) > 1e-6) {
          conflicts.push({
            kind: "entraxe",
            wheelA: `${reference.mesh.wheelA} ↔ ${reference.mesh.wheelB}`,
            wheelB: `${other.mesh.wheelA} ↔ ${other.mesh.wheelB}`,
            distance: other.distance,
            required: reference.distance,
          });
          break;
        }
      }
    }

    const seenGroupPairs = new Set();
    for (const [group, edges] of this.groupEdges) {
      for (const [otherGroup, dist] of edges) {
        const pairKey = this._pairKey(group, otherGroup);
        if (seenGroupPairs.has(pairKey)) continue;
        seenGroupPairs.add(pairKey);

        for (const w1 of this.axisGroups.get(group)) {
          for (const w2 of this.axisGroups.get(otherGroup)) {
            if (this._exempt(w1, w2)) continue;
            const b1 = this.train.wheels.get(w1).band;
            const b2 = this.train.wheels.get(w2).band;

            // l'arbre est un disque : c'est lui, et non le point central,
            // qu'une roue voisine recouvre
            if (this.protectedWheels.has(w2) && !bandsClear(this.arborBand, b1, dist)) {
              conflicts.push({ kind: "recouvrement", wheelA: w2, wheelB: w1, distance: dist, required: b1.outer + this.arborRadius });
            } else if (this.protectedWheels.has(w1) && !bandsClear(this.arborBand, b2, dist)) {
              conflicts.push({ kind: "recouvrement", wheelA: w1, wheelB: w2, distance: dist, required: b2.outer + this.arborRadius });
            } else if (this.classOf.get(w1) === this.classOf.get(w2) && !bandsClear(b1, b2, dist)) {
              conflicts.push({ kind: "denture", wheelA: w1, wheelB: w2, distance: dist, required: b1.outer + b2.outer });
            }
          }
        }
      }
    }
    return conflicts;
  }

  /** Encombrement exterieur de l'axe : la couronne compte par sa jante. */
  _groupOuterRadius(group) {
    let max = 0;
    for (const name of this.axisGroups.get(group)) max = Math.max(max, this.train.wheels.get(name).outerRadius);
    return max;
  }

  _withinPlate(pos, tipRadius) {
    const dist = Math.hypot(pos.x - this.plateCenter.x, pos.y - this.plateCenter.y);
    return dist + tipRadius <= this.plateRadius + 1e-9;
  }

  _collides(group, pos, placed, level) {
    for (const [otherGroup, otherPos] of placed) {
      if (otherGroup === group) continue;
      const dist = Math.hypot(pos.x - otherPos.x, pos.y - otherPos.y);

      for (const w1 of this.axisGroups.get(group)) {
        const b1 = this.train.wheels.get(w1).band;
        for (const w2 of this.axisGroups.get(otherGroup)) {
          if (this._exempt(w1, w2)) continue;
          const b2 = this.train.wheels.get(w2).band;

          if (level.get(this.classOf.get(w1)) !== level.get(this.classOf.get(w2))) {
            // niveaux differents : pas de contact de denture, mais l'ARBRE
            // d'une roue protegee ne doit pas passer sous la matiere de
            // l'autre (le trou d'une couronne, lui, ne recouvre rien)
            if (this.protectedWheels.has(w2) && !bandsClear(this.arborBand, b1, dist)) return true;
            if (this.protectedWheels.has(w1) && !bandsClear(this.arborBand, b2, dist)) return true;
            continue;
          }
          if (!bandsClear(b1, b2, dist)) return true;
        }
      }
    }
    return false;
  }

  /**
   * L'arbre de cet axe est-il recouvert par la matiere d'un autre mobile ?
   * Un arbre DEGAGE se tient directement par la platine ; un arbre
   * recouvert reclame un pont, c'est-a-dire une piece de plus, un reglage
   * de plus et un demontage moins commode. C'est le critere principal du
   * placement : tant qu'il reste de la place sur la platine, mieux vaut
   * l'occuper que de tout tasser au centre.
   *
   * Deux axes exactement superposes ne comptent pas : c'est un montage
   * coaxial -- un canon tournant sur l'arbre de l'autre -- et non un
   * recouvrement.
   */
  _axisCovered(group, pos, placed) {
    const mine = this.axisGroups.get(group);
    // un axe porte par une cage (satellite d'un train epicycloidal) n'a pas
    // besoin de la platine : il ne demandera jamais de pont
    if (mine.every((n) => this.train.wheels.get(n).carried)) return false;
    for (const [other, otherPos] of placed) {
      if (other === group) continue;
      const dist = Math.hypot(pos.x - otherPos.x, pos.y - otherPos.y);
      if (dist < 1e-6) continue;
      for (const name of this.axisGroups.get(other)) {
        if (mine.every((w) => this._exempt(w, name))) continue;
        if (!bandsClear(this.arborBand, this.train.wheels.get(name).band, dist)) return true;
      }
    }
    return false;
  }

  _countCoveredAxes(placed) {
    let n = 0;
    for (const [group, pos] of placed) if (this._axisCovered(group, pos, placed)) n++;
    return n;
  }

  /**
   * Cette position condamne-t-elle un arbre -- le sien ou celui d'un axe
   * deja pose ? Sert a departager les angles candidats AVANT de choisir :
   * prendre le premier angle valide venu enterre souvent un centre qu'un
   * autre angle, tout aussi valide, aurait laisse libre.
   */
  _wouldCoverAxis(group, pos, placed) {
    const mine = this.axisGroups.get(group);
    for (const [other, otherPos] of placed) {
      if (other === group) continue;
      const dist = Math.hypot(pos.x - otherPos.x, pos.y - otherPos.y);
      if (dist < 1e-6) continue;
      for (const name of this.axisGroups.get(other)) {
        if (mine.every((w) => this._exempt(w, name))) continue;
        if (!bandsClear(this.arborBand, this.train.wheels.get(name).band, dist)) return true;
      }
      for (const w of mine) {
        if (this.axisGroups.get(other).every((n) => this._exempt(w, n))) continue;
        if (!bandsClear(this.arborBand, this.train.wheels.get(w).band, dist)) return true;
      }
    }
    return false;
  }

  /**
   * Repartition aleatoire des niveaux : parcours en largeur du graphe des
   * classes (le graphe est un arbre de cliques, l'ordre BFS garantit qu'un
   * niveau libre existe des que `levels` >= requiredLevels()).
   */
  _randomLevels() {
    const level = new Map();
    const classes = [...this.classNeighbors.keys()];
    shuffle(classes, this.rng);
    for (const start of classes) {
      if (level.has(start)) continue;
      const queue = [start];
      while (queue.length) {
        const c = queue.shift();
        if (level.has(c)) continue;
        const forbidden = new Set();
        for (const nb of this.classNeighbors.get(c)) if (level.has(nb)) forbidden.add(level.get(nb));
        const allowed = [];
        for (let l = 1; l <= this.levels; l++) if (!forbidden.has(l)) allowed.push(l);
        if (!allowed.length) return null;
        level.set(c, allowed[Math.floor(this.rng() * allowed.length)]);
        const nbs = [...this.classNeighbors.get(c)];
        shuffle(nbs, this.rng);
        for (const nb of nbs) if (!level.has(nb)) queue.push(nb);
      }
    }
    return level;
  }

  _bfsOrder(root, visited = new Set()) {
    const order = [root];
    visited.add(root);
    let frontier = [root];
    while (frontier.length) {
      const next = [];
      for (const g of frontier) {
        for (const [neighbor] of this.groupEdges.get(g)) {
          if (!visited.has(neighbor)) {
            visited.add(neighbor);
            order.push(neighbor);
            next.push(neighbor);
          }
        }
      }
      frontier = next;
    }
    return order;
  }

  /** Somme des entraxes le long du chemin (unique) depuis `from` vers chaque axe. */
  _reachFrom(from) {
    const reach = new Map([[from, 0]]);
    const queue = [from];
    while (queue.length) {
      const g = queue.shift();
      for (const [nb, d] of this.groupEdges.get(g)) {
        if (!reach.has(nb)) {
          reach.set(nb, reach.get(g) + d);
          queue.push(nb);
        }
      }
    }
    return reach;
  }

  _parentAndDistance(group, placed) {
    for (const [neighbor, dist] of this.groupEdges.get(group)) {
      if (placed.has(neighbor)) return [neighbor, dist];
    }
    throw new Error(`Aucun parent place trouve pour ${group}`);
  }

  _tryPlaceAround(group, parent, dist, placed, level, reach) {
    const p = placed.get(parent);

    // Contraintes de FERMETURE : tout voisin dont la position est deja
    // connue impose son propre entraxe, au meme titre que le parent. Deux
    // cas s'y ramenent : une position imposee par clic, et un axe deja
    // place atteint par un autre chemin -- c'est-a-dire un CYCLE dans le
    // graphe des axes (un renvoi monte en parallele d'un engrenement
    // direct, typiquement dans un train revertant). Sans cette fermeture
    // l'axe serait pose au bon entraxe du seul parent et n'engrenerait pas
    // avec l'autre voisin.
    const constraints = [];
    for (const [nb, d] of this.groupEdges.get(group)) {
      if (nb === parent) continue;
      if (placed.has(nb)) constraints.push([placed.get(nb), d]);
      else if (this.fixedPositions.has(nb)) constraints.push([this.fixedPositions.get(nb), d]);
    }

    let candidates;
    if (constraints.length) {
      // intersection du cercle autour du parent et du cercle autour de la
      // premiere contrainte ; les autres ne font plus que filtrer
      const [c0, d0] = constraints[0];
      candidates = circleIntersections(p, dist, c0, d0).filter((pos) =>
        constraints.slice(1).every(([c, d]) => Math.abs(Math.hypot(pos.x - c.x, pos.y - c.y) - d) <= FIXED_TOLERANCE)
      );
    } else {
      const nAngles = Math.max(1, Math.round((2 * Math.PI) / this.angleStep));
      candidates = Array.from({ length: nAngles }, (_, i) => {
        const angle = i * this.angleStep;
        return { x: p.x + dist * Math.cos(angle), y: p.y + dist * Math.sin(angle) };
      });
    }
    shuffle(candidates, this.rng);

    const groupMaxTip = this._groupOuterRadius(group);
    // deux passes : les positions qui ne condamnent aucun arbre d'abord,
    // les autres seulement en repli
    const covering = [];
    for (const pos of candidates) {
      if (!this._withinPlate(pos, groupMaxTip)) continue;
      // elagage : un point fixe non encore atteint doit rester a portee de la chaine restante
      let reachable = true;
      for (const [f, reachMap] of reach) {
        if (placed.has(f)) continue;
        const limit = reachMap.get(group);
        if (limit === undefined) continue;
        const fp = this.fixedPositions.get(f);
        if (Math.hypot(pos.x - fp.x, pos.y - fp.y) > limit + 1e-6) {
          reachable = false;
          break;
        }
      }
      if (!reachable) continue;
      if (this._collides(group, pos, placed, level)) continue;
      if (this._wouldCoverAxis(group, pos, placed)) {
        covering.push(pos);
        continue;
      }
      return pos;
    }
    return covering.length ? covering[0] : null;
  }

  _placeComponent(root, placed, visited, level, reach) {
    const order = this._bfsOrder(root, visited);
    for (let i = 1; i < order.length; i++) {
      const group = order[i];
      const [parent, dist] = this._parentAndDistance(group, placed);
      let pos;
      if (this.fixedPositions.has(group)) {
        pos = this.fixedPositions.get(group);
        // tous les voisins deja places doivent etre a l'entraxe voulu
        for (const [nb, d] of this.groupEdges.get(group)) {
          if (!placed.has(nb)) continue;
          const np = placed.get(nb);
          if (Math.abs(Math.hypot(pos.x - np.x, pos.y - np.y) - d) > FIXED_TOLERANCE) return false;
        }
        if (this._collides(group, pos, placed, level)) return false;
      } else {
        pos = this._tryPlaceAround(group, parent, dist, placed, level, reach);
        if (pos === null) return false;
      }
      placed.set(group, pos);
    }
    return true;
  }

  _tryPlaceFree(group, placed, level) {
    const tip = this._groupOuterRadius(group);
    const maxR = this.plateRadius - tip;
    if (maxR < 0) return null;
    const samples = [];
    for (let i = 0; i < 48; i++) {
      const r = maxR * Math.sqrt(this.rng());
      const theta = 2 * Math.PI * this.rng();
      samples.push({ x: this.plateCenter.x + r * Math.cos(theta), y: this.plateCenter.y + r * Math.sin(theta), r });
    }
    samples.sort((a, b) => a.r - b.r);
    let fallback = null;
    for (const pos of samples) {
      if (this._collides(group, pos, placed, level)) continue;
      if (this._wouldCoverAxis(group, pos, placed)) {
        fallback = fallback ?? { x: pos.x, y: pos.y };
        continue;
      }
      return { x: pos.x, y: pos.y };
    }
    return fallback;
  }

  _compactnessScore(placed) {
    let maxR = 0;
    for (const [group, pos] of placed) {
      const tip = this._groupOuterRadius(group);
      maxR = Math.max(maxR, Math.hypot(pos.x - this.plateCenter.x, pos.y - this.plateCenter.y) + tip);
    }
    return maxR;
  }

  _expandToWheelPositions(groupPositions) {
    const positions = new Map();
    for (const [group, pos] of groupPositions) for (const name of this.axisGroups.get(group)) positions.set(name, pos);
    return positions;
  }

  _expandToWheelLevels(level) {
    const levels = new Map();
    for (const name of this.train.wheels.keys()) levels.set(name, level.get(this.classOf.get(name)));
    return levels;
  }

  /**
   * Cherche le placement en utilisant le MOINS DE NIVEAUX POSSIBLE : on
   * part du minimum structurel (le plus grand nombre de mobiles portes par
   * un meme arbre) et l'on n'ajoute une hauteur que si la precedente ne
   * mene nulle part. Un niveau de plus, c'est un mouvement plus epais --
   * ca ne se paie que quand la geometrie l'exige vraiment.
   */
  place() {
    if (this.positionProblems.length) return null;
    for (let n = Math.max(1, this.requiredLevels()); n <= this.maxLevels; n++) {
      this.levels = n;
      const layout = this._placeWithLevels();
      if (layout) return layout;
    }
    return null;
  }

  _placeWithLevels() {
    const groups = [...this.axisGroups.keys()];
    const rootWheelGroup = this.rootWheel ? this.wheelToGroup.get(this.rootWheel) : undefined;
    const primaryRoot = rootWheelGroup ?? groups[0];

    // composante du mobile d'entree en premier
    const components = [...this.components].sort((a, b) => (b.includes(primaryRoot) ? 1 : 0) - (a.includes(primaryRoot) ? 1 : 0));
    const reach = new Map();
    for (const f of this.fixedPositions.keys()) reach.set(f, this._reachFrom(f));

    let best = null;
    for (let attempt = 0; attempt < this.nRandomRestarts; attempt++) {
      const level = this._randomLevels();
      if (!level) return null;
      const placed = new Map();
      const visited = new Set();
      let ok = true;

      for (const component of components) {
        const fixedHere = component.filter((g) => this.fixedPositions.has(g));
        let root;
        let pos;
        if (fixedHere.length) {
          root = fixedHere[0];
          pos = this.fixedPositions.get(root);
        } else if (component.includes(primaryRoot)) {
          root = primaryRoot;
          pos = { x: 0, y: 0 };
        } else {
          root = component[0];
          pos = this._tryPlaceFree(root, placed, level);
        }
        if (!pos || !this._withinPlate(pos, this._groupOuterRadius(root)) || this._collides(root, pos, placed, level)) {
          ok = false;
          break;
        }
        placed.set(root, pos);
        if (!this._placeComponent(root, placed, visited, level, reach)) {
          ok = false;
          break;
        }
      }

      if (ok) {
        // Objectif : d'abord le maximum d'arbres degages, la compacite ne
        // departage qu'ensuite. Tasser un mouvement qui a de la place ne
        // sert a rien ; ce qui se paie, ce sont les ponts.
        const covered = this._countCoveredAxes(placed);
        const radius = this._compactnessScore(placed);
        if (best === null || covered < best.coveredAxes || (covered === best.coveredAxes && radius < best.score)) {
          best = new Layout(this._expandToWheelPositions(placed), radius, this._expandToWheelLevels(level), {
            coveredAxes: covered,
            axisCount: placed.size,
            levelCount: new Set(level.values()).size,
          });
        }
      }
    }
    return best;
  }
}
