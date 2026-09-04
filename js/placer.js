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
  constructor(positions, score, levels) {
    this.positions = positions; // Map wheelName -> {x, y}
    this.score = score;
    this.levels = levels ?? new Map(); // Map wheelName -> niveau (1..n)
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
    this.levels = Math.max(1, Math.floor(options.levels ?? 2));

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

  /** Nombre minimal de niveaux : le plus grand nombre de classes portees par un meme arbre. */
  requiredLevels() {
    let max = 1;
    for (const classes of this.classesOfGroup.values()) max = Math.max(max, classes.length);
    return max;
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
    for (const [group, classes] of this.classesOfGroup) {
      if (classes.length > this.levels) conflicts.push({ kind: "niveaux", group, needed: classes.length, wheels: this.axisGroups.get(group) });
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

    const seenGroupPairs = new Set();
    for (const [group, edges] of this.groupEdges) {
      for (const [otherGroup, dist] of edges) {
        const pairKey = this._pairKey(group, otherGroup);
        if (seenGroupPairs.has(pairKey)) continue;
        seenGroupPairs.add(pairKey);

        for (const w1 of this.axisGroups.get(group)) {
          for (const w2 of this.axisGroups.get(otherGroup)) {
            if (this.meshPairs.has(this._pairKey(w1, w2))) continue;
            const b1 = this.train.wheels.get(w1).band;
            const b2 = this.train.wheels.get(w2).band;

            if (this.protectedWheels.has(w2) && bandCovers(b1, dist)) {
              conflicts.push({ kind: "recouvrement", wheelA: w2, wheelB: w1, distance: dist, required: b1.outer });
            } else if (this.protectedWheels.has(w1) && bandCovers(b2, dist)) {
              conflicts.push({ kind: "recouvrement", wheelA: w1, wheelB: w2, distance: dist, required: b2.outer });
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
          if (this.meshPairs.has(this._pairKey(w1, w2))) continue;
          const b2 = this.train.wheels.get(w2).band;

          if (level.get(this.classOf.get(w1)) !== level.get(this.classOf.get(w2))) {
            // niveaux differents : pas de contact de denture, mais le centre
            // d'une roue protegee ne doit pas passer sous la matiere de
            // l'autre (le trou d'une couronne, lui, ne recouvre rien)
            if (this.protectedWheels.has(w2) && bandCovers(b1, dist)) return true;
            if (this.protectedWheels.has(w1) && bandCovers(b2, dist)) return true;
            continue;
          }
          if (!bandsClear(b1, b2, dist)) return true;
        }
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
    const fixedNeighbors = this.groupEdges.get(group).filter(([nb]) => this.fixedPositions.has(nb) && !placed.has(nb));

    let candidates;
    if (fixedNeighbors.length) {
      // la chaine doit se refermer sur une position imposee voisine :
      // intersection du cercle autour du parent et du cercle autour du point fixe
      const [f, df] = fixedNeighbors[0];
      candidates = circleIntersections(p, dist, this.fixedPositions.get(f), df).filter((pos) =>
        fixedNeighbors.slice(1).every(([g2, d2]) => {
          const fp = this.fixedPositions.get(g2);
          return Math.abs(Math.hypot(pos.x - fp.x, pos.y - fp.y) - d2) <= FIXED_TOLERANCE;
        })
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
      return pos;
    }
    return null;
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
    for (const pos of samples) {
      if (!this._collides(group, pos, placed, level)) return { x: pos.x, y: pos.y };
    }
    return null;
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

  place() {
    if (this.positionProblems.length) return null;
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
        const score = this._compactnessScore(placed);
        if (best === null || score < best.score) {
          best = new Layout(this._expandToWheelPositions(placed), score, this._expandToWheelLevels(level));
        }
      }
    }
    return best;
  }
}
