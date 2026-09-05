/**
 * gear-model.js
 * Modele topologique du train de rouages : mobiles, engrenements, groupes d'axe.
 * Port direct des classes Python Wheel / Mesh / GearTrain.
 */

class Wheel {
  constructor(name, teeth, module, axisGroup, addendumFactor = 1.0, dedendumFactor = 1.25, internal = false) {
    this.name = name;
    this.teeth = teeth;
    this.module = module;
    this.axisGroup = axisGroup;
    this.addendumFactor = addendumFactor;
    this.dedendumFactor = dedendumFactor;
    // denture INTERIEURE (couronne annulaire) : les dents pointent vers le
    // centre et le mobile mene tourne a l'interieur
    this.internal = internal;
    // Rayon BALAYE autour du centre de l'axe. Nul pour un mobile ordinaire ;
    // pour l'enveloppe d'un train epicycloidal, c'est le disque que le
    // satellite decrit en tournant avec le porte-satellites -- rien d'autre
    // ne peut occuper ce volume a cette hauteur.
    this.sweep = 0;
  }

  get pitchRadius() {
    return (this.module * this.teeth) / 2;
  }

  /**
   * Extremite de la dent : vers l'exterieur pour une denture classique,
   * vers l'INTERIEUR pour une couronne -- c'est alors le rayon du trou
   * dans lequel vient tourner le mobile mene.
   */
  get tipRadius() {
    return this.internal
      ? Math.max(0, this.pitchRadius - this.addendumFactor * this.module)
      : this.pitchRadius + this.addendumFactor * this.module;
  }

  /** Fond de dent : sous le primitif dehors, au-dessus dedans. */
  get rootRadius() {
    return this.internal
      ? this.pitchRadius + this.dedendumFactor * this.module
      : Math.max(0, this.pitchRadius - this.dedendumFactor * this.module);
  }

  /** Epaisseur de jante d'une couronne (nulle pour une roue pleine). */
  get rimThickness() {
    return this.internal ? 1.5 * this.module : 0;
  }

  /**
   * Bande radiale reellement occupee autour du centre. Une roue pleine
   * occupe le disque [0, tete] ; une couronne n'occupe qu'un anneau et
   * laisse tout son centre libre -- c'est ce qui permet d'y loger d'autres
   * mobiles, et ce que le placeur doit savoir pour ne pas les croire
   * en collision.
   */
  get band() {
    if (this.sweep > 0) return { inner: 0, outer: this.sweep };
    return this.internal
      ? { inner: this.tipRadius, outer: this.rootRadius + this.rimThickness }
      : { inner: 0, outer: this.tipRadius };
  }

  /** Encombrement exterieur, seul rayon qui compte face a la platine. */
  get outerRadius() {
    return this.band.outer;
  }
}

/**
 * Deux mobiles se touchent-ils, connaissant la distance de leurs centres ?
 * Chacun occupe une bande radiale : il n'y a pas contact si les bandes
 * sont trop loin l'une de l'autre, ou si l'une tient entierement dans le
 * trou de l'autre.
 */
function bandsClear(b1, b2, d, eps = 1e-9) {
  if (d >= b1.outer + b2.outer - eps) return true;
  if (d + b2.outer <= b1.inner + eps) return true;
  if (d + b1.outer <= b2.inner + eps) return true;
  return false;
}

/**
 * Le centre situe a la distance `d` tombe-t-il sur la matiere du mobile ?
 * Conserve pour le raisonnement sur un centre ponctuel ; le placeur, lui,
 * traite l'arbre comme un DISQUE et passe par bandsClear -- un arbre a un
 * diametre, et c'est ce diametre qu'une roue voisine recouvre.
 */
function bandCovers(band, d, eps = 1e-9) {
  return d >= band.inner - eps && d <= band.outer + eps;
}

class Mesh {
  constructor(wheelA, wheelB) {
    this.wheelA = wheelA;
    this.wheelB = wheelB;
  }

  isInternal(wheels) {
    const a = wheels.get(this.wheelA);
    const b = wheels.get(this.wheelB);
    return !!a && !!b && a.internal !== b.internal;
  }

  centerDistance(wheels) {
    const a = wheels.get(this.wheelA);
    const b = wheels.get(this.wheelB);
    // engrenement interieur : le mene tourne DANS la couronne, l'entraxe
    // est la difference des rayons primitifs et non leur somme
    if (a.internal !== b.internal) return Math.abs(a.pitchRadius - b.pitchRadius);
    return a.pitchRadius + b.pitchRadius;
  }
}

class GearTrain {
  constructor() {
    this.wheels = new Map(); // name -> Wheel
    this.meshes = [];
    // groupes d'axe dont les membres NE tournent PAS ensemble (coaxiaux
    // uniquement au sens position/placement, ex: le "grand" axe d'un train
    // revertant, ou une roue montee libre style canon d'heure). Par defaut,
    // tout groupe coaxial est suppose rigide (memes vitesse et sens).
    this.independentGroups = new Set();
    // couplages rigides EXPLICITES entre deux mobiles d'un meme axe
    // independant (ex: pignon d'une complication monte sur l'arbre d'une
    // roue d'une autre complication, dont l'axe porte aussi des mobiles
    // libres). Complete la regle par defaut "groupe rigide = tout le monde
    // tourne ensemble".
    this.rigidPairs = [];
    // informations d'origine de chaque mobile (complication, nom local,
    // nature : roue du train ou roue de renvoi) -- purement descriptif.
    this.wheelMeta = new Map();
    // mobiles necessairement a la MEME hauteur sans pour autant engrener
    // (l'enveloppe balayee par un satellite et ce satellite, par exemple).
    this.coplanarPairs = [];
    // paires qui ne peuvent pas se heurter parce qu'elles appartiennent au
    // meme sous-ensemble mecanique -- un satellite ne heurte pas l'enveloppe
    // qu'il decrit lui-meme.
    this.ignoredPairs = new Set();
    // trains epicycloidaux : leurs deux engrenements ne sont valides QUE
    // dans le repere du porte-satellites, la propagation ordinaire ne doit
    // donc pas les emprunter (voir la formule de Willis).
    this.epicyclicBlocks = [];
    // entraxes imposes par une piece autre qu'un engrenement (bras de came)
    this.axisLinks = [];
  }

  addCoplanarPair(nameA, nameB) {
    if (nameA !== nameB) this.coplanarPairs.push([nameA, nameB]);
  }

  addIgnoredPair(nameA, nameB) {
    this.ignoredPairs.add(nameA < nameB ? `${nameA}|${nameB}` : `${nameB}|${nameA}`);
  }

  isIgnoredPair(nameA, nameB) {
    return this.ignoredPairs.has(nameA < nameB ? `${nameA}|${nameB}` : `${nameB}|${nameA}`);
  }

  addEpicyclicBlock(block) {
    this.epicyclicBlocks.push(block);
  }

  /**
   * Entraxe IMPOSE entre deux axes qui n'engrenent pas. Un engrenement fixe
   * l'entraxe parce que les dentures doivent se toucher ; ici c'est une
   * autre piece qui l'impose -- typiquement le bras qui porte le galet d'une
   * came, dont la longueur fige la distance entre l'axe de la came et le
   * pivot du bras. Pour le placeur, la contrainte est de meme nature qu'un
   * engrenement : deux axes a distance connue.
   */
  addAxisLink(wheelA, wheelB, distance, reason = "") {
    if (wheelA === wheelB || !(distance > 0)) return;
    this.axisLinks.push({ wheelA, wheelB, distance, reason });
  }

  addWheel(wheel) {
    this.wheels.set(wheel.name, wheel);
  }

  addMesh(nameA, nameB) {
    this.meshes.push(new Mesh(nameA, nameB));
  }

  isInternalMesh(mesh) {
    return mesh.isInternal(this.wheels);
  }

  markIndependentAxis(groupName) {
    this.independentGroups.add(groupName);
  }

  addRigidPair(nameA, nameB) {
    if (nameA === nameB) return;
    this.rigidPairs.push([nameA, nameB]);
  }

  isRigidGroup(groupName) {
    return !this.independentGroups.has(groupName);
  }

  axisGroups() {
    const groups = new Map(); // axisGroup -> [wheelNames]
    for (const wheel of this.wheels.values()) {
      if (!groups.has(wheel.axisGroup)) groups.set(wheel.axisGroup, []);
      groups.get(wheel.axisGroup).push(wheel.name);
    }
    return groups;
  }
}
