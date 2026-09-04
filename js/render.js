/**
 * render.js
 * Construit une chaine SVG a partir d'un GearTrain + Layout. La denture est
 * dessinee avec un profil d'aspect realiste (flancs convexes, sommet
 * arrondi, conge en fond de dent) et les mobiles sont cales en phase aux
 * points d'engrenement. Ce n'est PAS un profil developpante exact : seul
 * l'aspect compte, l'encombrement de reference reste tipRadius (placer.js).
 */

const WHEEL_PALETTE = ["#2b4c6f", "#b4884b", "#4c6f4a", "#7a4c6f", "#6f4c2b", "#3f6f7a", "#8a6b2b", "#5a4c8a"];

const TWO_PI = 2 * Math.PI;

/**
 * Path SVG ferme d'un mobile dente, centre (cx, cy) en mm, `phase` = angle
 * (rad) du centre de la premiere dent. Une dent est parametree une fois en
 * polaire puis repetee par rotation ; chaque dent coute six commandes
 * (arc de sommet, flanc, conge, arc de fond, conge, flanc), ce qui reste
 * leger meme pour 80 dents. Les grandes roues recoivent des croisures :
 * fenetres evidees entre moyeu et jante, soustraites par fill-rule evenodd.
 */
function gearPath(cx, cy, wheel, phase, toPx) {
  const Z = Math.max(3, wheel.teeth);
  const m = wheel.module;
  const p = TWO_PI / Z; // pas angulaire
  const internal = !!wheel.internal;
  // sens radial allant du pied vers la tete de dent : vers l'exterieur
  // pour une denture classique, vers le centre pour une couronne
  const dir = internal ? -1 : 1;
  const rTip = wheel.tipRadius;
  const rPitch = wheel.pitchRadius;
  const rRoot = internal ? wheel.rootRadius : Math.max(wheel.rootRadius, 0.15 * rTip);
  const pinion = !internal && Z <= 12;

  // largeurs angulaires (demi-dent) : 50/50 au primitif, plus etroit au
  // sommet (ogive pour les pignons), plus large au pied
  const halfPitch = p / 4;
  const halfTip = halfPitch * (pinion ? 0.25 : 0.38);
  const fillet = Math.min(0.35 * m, 0.5 * Math.abs(rPitch - rRoot)); // hauteur radiale du conge
  const filletAng = Math.min(fillet / rRoot, 0.12 * p); // ouverture angulaire du conge
  const halfFoot = Math.min((pinion ? 1.35 : 1.2) * halfPitch, p / 2 - filletAng - 0.04 * p);
  // Epaisseur de la dent AU PRIMITIF : c'est elle qui decide si la dent
  // entre dans le creux d'en face. La moitie du pas exactement les rendrait
  // jointives ; on retire un jeu de fonctionnement pour que l'engrenement
  // se voie. Le flanc reste convexe car ce point de passage tombe malgre
  // tout en dehors de la corde tete-pied.
  const BACKLASH = 0.04;
  const halfMid = halfPitch * (1 - BACKLASH);
  const rFoot = rRoot + dir * fillet;

  const pt = (r, a) => toPx(cx + r * Math.cos(a), cy + r * Math.sin(a));
  const f = (v) => v.toFixed(2);
  const P = (r, a) => {
    const [x, y] = pt(r, a);
    return `${f(x)} ${f(y)}`;
  };
  // arc de cercle centre sur le mobile, sens des angles croissants
  const arc = (r, a, sweep = 1, large = 0) => `A ${f(r * SCALE_OF(toPx))} ${f(r * SCALE_OF(toPx))} 0 ${large} ${sweep} ${P(r, a)}`;
  // flanc convexe : Bezier quadratique passant par le point primitif a mi-parcours
  const flank = (r0, a0, r2, a2, aMid) => {
    const [x0, y0] = pt(r0, a0);
    const [x2, y2] = pt(r2, a2);
    const [xm, ym] = pt(rPitch, aMid);
    const cxp = 2 * xm - 0.5 * (x0 + x2);
    const cyp = 2 * ym - 0.5 * (y0 + y2);
    return `Q ${f(cxp)} ${f(cyp)} ${f(x2)} ${f(y2)}`;
  };
  // conge : quadratique dont le controle est le coin (rRoot, angle du pied)
  const cornerQ = (aCorner, r2, a2) => {
    const [xc, yc] = pt(rRoot, aCorner);
    return `Q ${f(xc)} ${f(yc)} ${P(r2, a2)}`;
  };

  const parts = [`M ${P(rTip, phase - halfTip)}`];
  for (let k = 0; k < Z; k++) {
    const a = phase + k * p;
    parts.push(arc(rTip, a + halfTip)); // sommet
    parts.push(flank(rTip, a + halfTip, rFoot, a + halfFoot, a + halfMid)); // flanc descendant
    parts.push(cornerQ(a + halfFoot, rRoot, a + halfFoot + filletAng)); // conge
    parts.push(arc(rRoot, a + p - halfFoot - filletAng)); // fond de dent
    parts.push(cornerQ(a + p - halfFoot, rFoot, a + p - halfFoot)); // conge
    parts.push(flank(rFoot, a + p - halfFoot, rTip, a + p - halfTip, a + p - halfMid)); // flanc montant
  }
  parts.push("Z");

  // croisures : moyeu plein, jante sous la denture, 3 a 5 bras
  if (!internal && Z > 30 && rPitch > 3) {
    const rHub = Math.max(0.9, 0.2 * rRoot);
    const rRim = rRoot - Math.max(0.5, 1.2 * m);
    if (rRim - rHub > 1.0) {
      const arms = rRoot < 5 ? 3 : rRoot < 9 ? 4 : 5;
      const halfArm = Math.max(0.6, 0.9 * m) / 2;
      const sector = TWO_PI / arms;
      const dIn = Math.asin(Math.min(1, halfArm / rHub));
      const dOut = Math.asin(Math.min(1, halfArm / rRim));
      if (sector - 2 * dIn > 0.2 && sector - 2 * dOut > 0.2) {
        for (let i = 0; i < arms; i++) {
          const a1 = phase + i * sector;
          const a2 = a1 + sector;
          parts.push(`M ${P(rHub, a1 + dIn)}`);
          parts.push(`L ${P(rRim, a1 + dOut)}`);
          parts.push(arc(rRim, a2 - dOut, 1, sector - 2 * dOut > Math.PI ? 1 : 0));
          parts.push(`L ${P(rHub, a2 - dIn)}`);
          parts.push(arc(rHub, a1 + dIn, 0, sector - 2 * dIn > Math.PI ? 1 : 0));
          parts.push("Z");
        }
      }
    }
  }
  // couronne : la denture ci-dessus est le bord INTERIEUR de l'anneau ; on
  // ajoute le cercle de jante exterieur, et le fill-rule evenodd evide le
  // centre -- c'est ce trou qui laisse voir les mobiles loges dedans
  if (internal) {
    const rRim = wheel.outerRadius;
    parts.push(`M ${P(rRim, 0)}`);
    parts.push(arc(rRim, Math.PI, 1, 0));
    parts.push(arc(rRim, TWO_PI, 1, 0));
    parts.push("Z");
  }

  return parts.join(" ");
}

/** Echelle px/mm deduite de la fonction de conversion (evite de la passer partout). */
function SCALE_OF(toPx) {
  if (toPx._scale === undefined) {
    const [x0] = toPx(0, 0);
    const [x1] = toPx(1, 0);
    toPx._scale = Math.abs(x1 - x0);
  }
  return toPx._scale;
}

/**
 * Calage angulaire des dentures : propagation en largeur le long des
 * engrenements depuis la roue racine (angle 0). `phase` designe l'angle du
 * CENTRE de la premiere dent ; les creux tombent donc a phase + (k+1/2)*pas.
 *
 * Pour chaque engrenement on repere le POINT DE CONTACT, sur la ligne des
 * centres, et l'on impose qu'une dent du menant y fasse face a un creux du
 * mene. Deux choses varient selon le type d'engrenement :
 *
 *  - la direction du contact vue de chaque centre. En denture exterieure
 *    chacun le voit vers l'autre. En denture interieure la couronne le voit
 *    toujours vers l'autre, mais le mobile qui tourne DEDANS le voit a
 *    l'oppose : le contact est derriere lui, pas entre les deux centres.
 *  - le sens du roulement : un engrenement exterieur fait tourner le mene
 *    en sens inverse (facteur -1), un engrenement interieur dans le meme
 *    sens (+1).
 *
 * Si la dent du menant la plus proche du contact est decalee de `delta`,
 * le creux du mene se decale de s * delta * Za / Zb.
 * Retourne Map nom -> phase (rad).
 */
function computeToothPhases(train, layout, rootWheel) {
  const phases = new Map();
  const adjacency = new Map();
  for (const name of layout.positions.keys()) adjacency.set(name, []);
  for (const mesh of train.meshes) {
    if (!adjacency.has(mesh.wheelA) || !adjacency.has(mesh.wheelB)) continue;
    const internal = train.isInternalMesh(mesh);
    adjacency.get(mesh.wheelA).push({ to: mesh.wheelB, internal });
    adjacency.get(mesh.wheelB).push({ to: mesh.wheelA, internal });
  }
  const starts = [...layout.positions.keys()];
  if (rootWheel && adjacency.has(rootWheel)) starts.unshift(rootWheel);

  for (const start of starts) {
    if (phases.has(start)) continue;
    phases.set(start, 0);
    const queue = [start];
    while (queue.length) {
      const a = queue.shift();
      const wa = train.wheels.get(a);
      const pa = layout.positions.get(a);
      for (const { to: b, internal } of adjacency.get(a)) {
        if (phases.has(b)) continue;
        const wb = train.wheels.get(b);
        const pb = layout.positions.get(b);
        const theta = Math.atan2(pb.y - pa.y, pb.x - pa.x);

        // direction du contact depuis chaque centre : vers l'autre centre,
        // sauf pour le mobile loge a l'interieur d'une couronne
        const angleA = theta + (internal && !wa.internal ? Math.PI : 0);
        const angleB = theta + Math.PI + (internal && !wb.internal ? Math.PI : 0);

        const stepA = TWO_PI / Math.max(3, wa.teeth);
        const stepB = TWO_PI / Math.max(3, wb.teeth);
        const k = Math.round((angleA - phases.get(a)) / stepA);
        const delta = phases.get(a) + k * stepA - angleA;
        const roll = internal ? 1 : -1;

        phases.set(b, angleB + (roll * delta * wa.teeth) / wb.teeth - stepB / 2);
        queue.push(b);
      }
    }
  }
  return phases;
}

/**
 * Construit une regle graduee (ruban de mesure) en SVG, orientee horizontale
 * ou verticale, avec graduations tous les 1 mm et labels tous les 10 mm.
 * Sert de signature visuelle a l'outil : l'echelle affichee correspond
 * exactement a celle du dessin (meme parametre `scale`, en px/mm).
 */
function buildRulerSVG(lengthMm, scale, orientation = "horizontal", thicknessPx = 22) {
  const lengthPx = lengthMm * scale;
  const w = orientation === "horizontal" ? lengthPx : thicknessPx;
  const h = orientation === "horizontal" ? thicknessPx : lengthPx;
  const parts = [`<svg xmlns="http://www.w3.org/2000/svg" width="${w.toFixed(0)}" height="${h.toFixed(0)}" viewBox="0 0 ${w.toFixed(0)} ${h.toFixed(0)}">`];

  // pas de graduation adapte au zoom : en dessous de ~4 px entre deux
  // traits, la regle devient une bouillie -- on saute alors aux 5 mm
  const step = scale >= 4 ? 1 : scale >= 2 ? 5 : 10;
  for (let mm = 0; mm <= lengthMm; mm += step) {
    const pos = mm * scale;
    const isMajor = mm % 10 === 0;
    const isMid = mm % 5 === 0;
    const tickLen = isMajor ? thicknessPx * 0.65 : isMid ? thicknessPx * 0.45 : thicknessPx * 0.25;

    if (orientation === "horizontal") {
      parts.push(
        `<line x1="${pos.toFixed(2)}" y1="${thicknessPx}" x2="${pos.toFixed(2)}" y2="${(thicknessPx - tickLen).toFixed(2)}" stroke="#8b8578" stroke-width="${isMajor ? 1.2 : 0.6}"/>`
      );
      if (isMajor) {
        parts.push(
          `<text x="${(pos + 2).toFixed(2)}" y="${(thicknessPx * 0.45).toFixed(2)}" font-family="'IBM Plex Mono', monospace" font-size="9" fill="#6b6558">${mm}</text>`
        );
      }
    } else {
      parts.push(
        `<line x1="${thicknessPx}" y1="${pos.toFixed(2)}" x2="${(thicknessPx - tickLen).toFixed(2)}" y2="${pos.toFixed(2)}" stroke="#8b8578" stroke-width="${isMajor ? 1.2 : 0.6}"/>`
      );
      if (isMajor) {
        parts.push(
          `<text x="2" y="${(pos - 2).toFixed(2)}" font-family="'IBM Plex Mono', monospace" font-size="9" fill="#6b6558">${mm}</text>`
        );
      }
    }
  }

  parts.push("</svg>");
  return parts.join("\n");
}

/**
 * Petite fleche courbe indiquant le sens de rotation d'un mobile (vu de
 * dessus). En SVG l'axe y pointe vers le bas : un angle croissant tourne
 * donc dans le sens horaire a l'ecran, ce qui correspond a sens = +1.
 */
function rotationArrowSVG(cxPx, cyPx, rPx, sens, color) {
  const a0 = -Math.PI * 0.8;
  const a1 = Math.PI * 0.3;
  const start = sens === 1 ? a0 : a1;
  const end = sens === 1 ? a1 : a0;
  const sweep = sens === 1 ? 1 : 0;
  const sx = cxPx + rPx * Math.cos(start);
  const sy = cyPx + rPx * Math.sin(start);
  const ex = cxPx + rPx * Math.cos(end);
  const ey = cyPx + rPx * Math.sin(end);
  // tangente au point d'arrivee, orientee dans le sens de parcours
  let dx = -Math.sin(end);
  let dy = Math.cos(end);
  if (sens !== 1) {
    dx = -dx;
    dy = -dy;
  }
  const nx = -dy;
  const ny = dx;
  const head = Math.max(4, Math.min(8, rPx * 0.45));
  const tip = [ex + dx * head, ey + dy * head];
  const b1 = [ex + nx * head * 0.5, ey + ny * head * 0.5];
  const b2 = [ex - nx * head * 0.5, ey - ny * head * 0.5];
  const f = (v) => v.toFixed(2);
  return (
    `<path d="M ${f(sx)} ${f(sy)} A ${f(rPx)} ${f(rPx)} 0 1 ${sweep} ${f(ex)} ${f(ey)}" fill="none" stroke="${color}" stroke-width="1.4" opacity="0.85"/>` +
    `<polygon points="${f(tip[0])},${f(tip[1])} ${f(b1[0])},${f(b1[1])} ${f(b2[0])},${f(b2[1])}" fill="${color}" opacity="0.85"/>`
  );
}

function formatModule(m) {
  return String(parseFloat(m.toFixed(3)));
}

/**
 * options :
 *   marks        : Map nom -> { tag, color }   (etiquettes ENTREE / SORTIE par complication)
 *   senses       : Map nom -> +1 | -1          (sens de rotation vu de dessus)
 *   styles       : Map nom -> "dim" | "hidden" (complications repliees)
 *   fixedMarkers : [{ name, x, y }]            (positions imposees par clic, en mm)
 */
function renderTrainSVG(train, layout, plateRadius, plateCenter = { x: 0, y: 0 }, scale = 20, margin = 2, options = {}) {
  const marks = options.marks ?? new Map();
  const senses = options.senses ?? new Map();
  const styles = options.styles ?? new Map();
  const fixedMarkers = options.fixedMarkers ?? [];
  const DIM_COLOR = "#a09a8e";
  const sizePx = (plateRadius + margin) * 2 * scale;
  const cxPx = (plateRadius + margin) * scale;
  const cyPx = (plateRadius + margin) * scale;

  const toPx = (x, y) => [cxPx + (x - plateCenter.x) * scale, cyPx + (y - plateCenter.y) * scale];

  const parts = [];
  parts.push(
    `<svg xmlns="http://www.w3.org/2000/svg" width="${sizePx.toFixed(0)}" height="${sizePx.toFixed(
      0
    )}" viewBox="0 0 ${sizePx.toFixed(0)} ${sizePx.toFixed(0)}">`
  );

  // platine
  const [ppx, ppy] = toPx(plateCenter.x, plateCenter.y);
  parts.push(
    `<circle cx="${ppx.toFixed(2)}" cy="${ppy.toFixed(2)}" r="${(plateRadius * scale).toFixed(
      2
    )}" fill="none" stroke="#8b8578" stroke-width="1.5" stroke-dasharray="6,4"/>`
  );

  const axisGroups = train.axisGroups();
  const colorOfGroup = new Map();
  let i = 0;
  for (const g of axisGroups.keys()) {
    colorOfGroup.set(g, WHEEL_PALETTE[i % WHEEL_PALETTE.length]);
    i++;
  }

  const labelStack = new Map(); // cle position -> nb de labels deja poses a cet endroit

  if (layout) {
    const phases = computeToothPhases(train, layout, options.rootWheel);
    // les mobiles estompes sont dessines en premier (dessous)
    const entries = [...layout.positions].sort((a, b) => (styles.get(b[0]) === "dim" ? 1 : 0) - (styles.get(a[0]) === "dim" ? 1 : 0));
    for (const [name, pos] of entries) {
      const style = styles.get(name);
      if (style === "hidden") continue;
      const dim = style === "dim";
      const wheel = train.wheels.get(name);
      const color = dim ? DIM_COLOR : colorOfGroup.get(wheel.axisGroup);
      const [wx, wy] = toPx(pos.x, pos.y);

      // cercle primitif
      if (!dim) {
        parts.push(
          `<circle cx="${wx.toFixed(2)}" cy="${wy.toFixed(2)}" r="${(wheel.pitchRadius * scale).toFixed(
            2
          )}" fill="none" stroke="${color}" stroke-width="0.75" stroke-dasharray="3,3" opacity="0.6"/>`
        );
      }

      // Denture : un seul path ferme, croisures soustraites en evenodd.
      // Enveloppee dans un <g> repere par le nom du mobile et son centre,
      // pour que le mode animation n'ait qu'un attribut transform a poser
      // au lieu de recalculer la geometrie a chaque image.
      const d = gearPath(pos.x, pos.y, wheel, phases.get(name) ?? 0, toPx);
      parts.push(
        `<g data-wheel="${name}" data-cx="${wx.toFixed(2)}" data-cy="${wy.toFixed(2)}">` +
          `<path d="${d}" fill="${color}" fill-rule="evenodd" fill-opacity="${dim ? 0.07 : 0.15}" stroke="${color}" stroke-width="${dim ? 0.8 : 1.1}" stroke-opacity="${dim ? 0.45 : 1}" stroke-linejoin="round"/>` +
          `</g>`
      );

      // centre
      parts.push(`<circle cx="${wx.toFixed(2)}" cy="${wy.toFixed(2)}" r="2" fill="${color}" opacity="${dim ? 0.5 : 1}"/>`);

      // sens de rotation
      const sens = senses.get(name);
      if (!dim && sens !== undefined && wheel.pitchRadius * scale >= 9) {
        const arrowR = Math.max(5, wheel.pitchRadius * scale * 0.5);
        parts.push(rotationArrowSVG(wx, wy, arrowR, sens, color));
      }

      // marqueur entree / sortie
      const mark = marks.get(name);
      if (mark && !dim) {
        const tag = mark.tag;
        const tagColor = mark.color;
        const ringR = wheel.tipRadius * scale + 5;
        parts.push(
          `<circle cx="${wx.toFixed(2)}" cy="${wy.toFixed(2)}" r="${ringR.toFixed(2)}" fill="none" stroke="${tagColor}" stroke-width="1.5" stroke-dasharray="2,3"/>`
        );
        parts.push(
          `<text x="${wx.toFixed(2)}" y="${(wy + ringR + 12).toFixed(2)}" text-anchor="middle" font-family="'IBM Plex Mono', monospace" font-size="10" font-weight="bold" fill="${tagColor}">${tag}</text>`
        );
      }

      // label (decale verticalement si un autre mobile coaxial est deja etiquette ici)
      const posKey = `${pos.x.toFixed(3)},${pos.y.toFixed(3)}`;
      const stackIndex = labelStack.get(posKey) ?? 0;
      labelStack.set(posKey, stackIndex + 1);
      const labelY = wy - 4 - stackIndex * 13;
      const glyph = sens === undefined || dim ? "" : sens === 1 ? " ↻" : " ↺";
      const level = layout.levels?.get(name);
      const details = [`Z=${wheel.teeth}`, `m=${formatModule(wheel.module)}`];
      if (level !== undefined) details.push(`N${level}`);
      parts.push(
        `<text x="${(wx + 4).toFixed(2)}" y="${labelY.toFixed(
          2
        )}" font-family="'IBM Plex Mono', monospace" font-size="${dim ? 9.5 : 11}" fill="${dim ? "#8b8578" : "#21252b"}" opacity="${dim ? 0.8 : 1}">${name} (${details.join(", ")})${glyph}</text>`
      );
    }
  }

  // positions imposees par clic (visibles meme sans placement)
  for (const marker of fixedMarkers) {
    const [mx, my] = toPx(marker.x, marker.y);
    parts.push(
      `<g stroke="#9c3b34" stroke-width="1.2" fill="none">` +
        `<circle cx="${mx.toFixed(2)}" cy="${my.toFixed(2)}" r="6"/>` +
        `<line x1="${(mx - 10).toFixed(2)}" y1="${my.toFixed(2)}" x2="${(mx + 10).toFixed(2)}" y2="${my.toFixed(2)}"/>` +
        `<line x1="${mx.toFixed(2)}" y1="${(my - 10).toFixed(2)}" x2="${mx.toFixed(2)}" y2="${(my + 10).toFixed(2)}"/>` +
        `</g>` +
        `<text x="${(mx + 8).toFixed(2)}" y="${(my + 16).toFixed(2)}" font-family="'IBM Plex Mono', monospace" font-size="9" fill="#9c3b34">📍 ${marker.name}</text>`
    );
  }

  parts.push("</svg>");
  return { svgMarkup: parts.join("\n"), sizePx };
}
