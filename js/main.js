/**
 * main.js
 * Relie l'interface au modele (gear-model.js, complication.js), a la
 * recherche de ratio (ratio-search.js), au placement (placer.js) et au
 * rendu (render.js). Plusieurs complications peuvent etre definies ; elles
 * sont assemblees en un seul train global place sur la platine commune.
 */

const BASE_SCALE = 20; // px par mm a l'ouverture
const MIN_SCALE = 3;
const MAX_SCALE = 200;
const MARGIN = 2; // mm autour de la platine

const state = {
  complications: [],
  protectedOverrides: new Map(), // nom global -> bool (par defaut : la sortie de chaque complication)
  analysis: null, // resultat de analyzeTrainSenses()
  placing: null, // { compId, role } quand on attend un clic sur le dessin
  lastPlateRadius: 15,
  arborTouched: false, // le diametre d'arbre suit la platine tant qu'il est faux
  showHands: true, // aiguilles indicatrices sur les sorties
  view: { scale: BASE_SCALE }, // echelle du dessin en px/mm (zoom)
  animation: { raf: null, t0: 0 },
};

/** Echelle courante du dessin, en px/mm (modifiee par le zoom). */
function viewScale() {
  return state.view.scale;
}

/**
 * Plage de modules autorisee, lue une fois pour toutes. Elle sert aussi a
 * la RECHERCHE DE DENTS d'un train revertant (les entraxes ne s'egalisent
 * que pour certains couples de modules), pas seulement au placement.
 */
/**
 * Diametre d'arbre par defaut, deduit de la platine. Une platine de 30 mm
 * est une montre : ses arbres font moins du millimetre. Une platine de
 * 150 mm est une pendule, et ses arbres se comptent en millimetres. Le
 * rapport au diametre de platine est le seul indice dont on dispose ; il
 * est borne pour rester plausible aux deux extremes.
 */
function defaultArborDiameter(plateDiameter) {
  const raw = plateDiameter / 40;
  return Math.min(4, Math.max(0.3, Math.round(raw * 20) / 20));
}

/** Rayon d'arbre en mm, saisi ou deduit de la platine. */
function arborRadius() {
  const field = parseFloat(document.getElementById("arbor-diameter")?.value);
  const plate = parseFloat(document.getElementById("plate-diameter")?.value);
  const d = Number.isFinite(field) && field >= 0 ? field : defaultArborDiameter(Number.isFinite(plate) ? plate : 30);
  return d / 2;
}

function moduleRange() {
  const min = parseFloat(document.getElementById("module-min")?.value);
  const max = parseFloat(document.getElementById("module-max")?.value);
  const lo = Number.isFinite(min) && min > 0 ? min : 0.1;
  const hi = Number.isFinite(max) && max >= lo ? max : Math.max(lo, 0.3);
  return { min: lo, max: hi };
}

function comps() {
  return state.complications;
}

function panelOf(comp) {
  return document.querySelector(`.complication[data-id="${comp.id}"]`);
}

function opt(value, label, selected) {
  return `<option value="${value}" ${selected ? "selected" : ""}>${label}</option>`;
}

function fmtPos(p) {
  return `(${p.x.toFixed(1)} ; ${p.y.toFixed(1)})`;
}

function formatRatio(r) {
  // un rapport epicycloidal est couramment NEGATIF (le sens s'inverse) :
  // c'est la grandeur, pas le signe, qui decide de la notation
  if (!Number.isFinite(r)) return "?";
  if (r === 0) return "0";
  const magnitude = Math.abs(r);
  return magnitude >= 1e-4 && magnitude < 1e6 ? String(parseFloat(r.toPrecision(9))) : r.toExponential(6);
}

/**
 * Rappel de la cible sous les champs : le ratio effectivement recherche,
 * et en mode vitesses la duree d'un tour de chaque cote -- c'est la forme
 * sous laquelle une complication se verifie (1 tour en 29,53 j).
 */
/**
 * Un rapport de transmission ordinaire est positif : le signe est porte par
 * le sens de rotation, pas par le ratio. Un train epicycloidal fait
 * exception -- son rapport de base est negatif des que le nombre
 * d'engrenements exterieurs est impair, et c'est meme la regle pour les
 * types 1 et 2.
 */
function ratioTargetValid(comp, target) {
  if (!Number.isFinite(target) || target === 0) return false;
  return comp.topology === "epicyclic" || target > 0;
}

function ratioReadoutHTML(comp) {
  const target = effectiveRatio(comp);
  if (!ratioTargetValid(comp, target)) {
    return `<span class="alert">Cible indéterminée — vérifie les valeurs saisies.</span>`;
  }
  if (comp.topology === "epicyclic" && comp.fixedMember === "none") {
    const modes = differentialModes(comp, target);
    const bits = [`rapport de base R = <strong>${formatRatio(target)}</strong> (porte-satellites bloqué)`];
    if (modes) {
      bits.push(`B tenu : cage ${formatRatio(modes.perTurnOfA)} tr / tr de A`);
      bits.push(`A tenu : cage ${formatRatio(modes.perTurnOfB)} tr / tr de B`);
      if (modes.balanced) bits.push(`<strong>modes équilibrés</strong>`);
    }
    return bits.join(" · ");
  }
  const parts = [`ratio sortie/entrée = <strong>${formatRatio(target)}</strong>`];
  if (comp.ratioMode === "speeds") {
    parts.push(`entrée 1 tour / ${formatPeriod(toTurnsPerHour(comp.speedIn.value, comp.speedIn.unit))}`);
    parts.push(`sortie 1 tour / ${formatPeriod(toTurnsPerHour(comp.speedOut.value, comp.speedOut.unit))}`);
  }
  return parts.join(" · ");
}

function refreshReadout(section, comp) {
  const el = section.querySelector(".ratio-readout");
  if (el) el.innerHTML = ratioReadoutHTML(comp);
}

// ------------------------------------------------------------------
// Panneaux de complication
// ------------------------------------------------------------------

function renderAllComplicationPanels() {
  const container = document.getElementById("complications");
  [...container.querySelectorAll(".complication")].forEach((el) => {
    if (!comps().some((c) => String(c.id) === el.dataset.id)) el.remove();
  });
  normalizeAll(comps());
  comps().forEach((comp) => {
    renderComplicationPanel(comp);
    container.appendChild(panelOf(comp)); // conserve l'ordre
  });
}

function renderComplicationPanel(comp) {
  const all = comps();
  const k = all.indexOf(comp);
  const earlier = all.slice(0, k);
  normalizeComplication(comp, earlier);

  let section = panelOf(comp);
  if (!section) {
    section = document.createElement("section");
    section.className = "panel complication";
    section.dataset.id = comp.id;
    document.getElementById("complications").appendChild(section);
  }

  const names = localWheelNames(comp);
  const earlierWheels = wheelNamesOf(earlier);
  const linked = comp.link.kind !== "none";
  const shared = comp.link.kind === "shared";
  const info = state.analysis?.info?.[comp.id];
  const pathKeys = pathBaseMeshKeys(comp);
  const driverComp = linked ? ownerOf(all, comp.link.wheel) : null;
  const driverTeeth = driverComp?.selected?.teethByLocal?.[localOf(comp.link.wheel)];

  const boundsRows = names
    .map((n) => {
      const b = comp.bounds[n];
      if (shared && n === comp.entree) {
        return `<tr data-name="${n}" class="shared-row">
          <td>${n} = ${comp.link.wheel}</td>
          <td colspan="4" class="muted">Z=${driverTeeth ?? "?"} (roue existante)</td>
          <td class="center"><input type="radio" name="entree-${comp.id}" value="${n}" checked /></td>
          <td class="center"><input type="radio" name="sortie-${comp.id}" value="${n}" disabled /></td>
        </tr>`;
      }
      // dans un train epicycloidal, dentures et roles sont imposes par le
      // type et par le membre immobilise : les laisser modifiables ne
      // ferait que decrire un mecanisme qui n'existe pas
      const derived = comp.topology === "epicyclic";
      const lock = derived ? ` disabled title="Imposé par le type de train épicycloïdal"` : "";
      const roleLock = derived ? ` disabled title="Découle du membre immobilisé"` : "";
      return `<tr data-name="${n}">
        <td>${n}</td>
        <td><input type="number" class="bound-min" value="${b.min}" min="4" /></td>
        <td><input type="number" class="bound-max" value="${b.fixed ? b.min : b.max}" min="4" ${b.fixed ? "disabled" : ""} /></td>
        <td class="center"><input type="checkbox" class="bound-fixed" ${b.fixed ? "checked" : ""} /></td>
        <td class="center"><input type="checkbox" class="bound-internal" ${comp.internal[n] ? "checked" : ""}${lock} /></td>
        <td class="center"><input type="radio" name="entree-${comp.id}" value="${n}" ${n === comp.entree ? "checked" : ""}${roleLock} /></td>
        <td class="center"><input type="radio" name="sortie-${comp.id}" value="${n}" ${n === comp.sortie ? "checked" : ""}${roleLock} /></td>
      </tr>`;
    })
    .join("");

  const idlerRows = baseMeshKeys(comp)
    .map((key) => {
      const cfg = comp.idlers[key];
      const onPath = pathKeys.includes(key);
      return `<tr data-key="${key}">
        <td>${baseMeshLabel(key)}<span class="tag-auto" hidden>+1 auto</span></td>
        <td><select class="idler-count">${[0, 1, 2].map((v) => opt(v, v, v === cfg.count)).join("")}</select></td>
        <td><input type="number" class="idler-min" value="${cfg.min}" min="4" /></td>
        <td><input type="number" class="idler-max" value="${cfg.max}" min="4" /></td>
        <td class="center"><input type="radio" name="auto-${comp.id}" value="${key}" ${comp.autoIdlerMesh === key ? "checked" : ""} ${onPath ? "" : "disabled"} title="${onPath ? "Engrènement qui recevra le renvoi automatique" : "Hors du chemin entrée → sortie : un renvoi ici ne change pas le sens de sortie"}" /></td>
      </tr>`;
    })
    .join("");

  const linkBlock =
    k === 0
      ? ""
      : `<div class="field-row">
          <div class="field">
            <label>Raccordement</label>
            <select class="f-link-kind">
              ${opt("none", "Indépendante", comp.link.kind === "none")}
              ${opt("shared", "Entrée = roue existante…", comp.link.kind === "shared")}
              ${opt("coaxial", "Entrée coaxiale avec…", comp.link.kind === "coaxial")}
              ${opt("mesh", "Entrée engrenée sur…", comp.link.kind === "mesh")}
            </select>
          </div>
          <div class="field">
            <label>Roue motrice</label>
            <select class="f-link-wheel" ${linked ? "" : "disabled"}>
              ${earlierWheels.map((w) => opt(w, w, w === comp.link.wheel)).join("")}
            </select>
          </div>
        </div>`;

  const ratioLabel = comp.link.kind === "mesh" || shared ? `Ratio cible (depuis ${comp.link.wheel})` : "Ratio cible";
  const sensEntreeValue = linked ? info?.sensEntree ?? comp.sensEntree : comp.sensEntree;
  const heritage = { shared: "même roue, même sens", coaxial: "même arbre, même sens", mesh: "inversé par l'engrènement" }[comp.link.kind];

  const speedsMode = comp.ratioMode === "speeds";
  const preset = libraryPreset(comp.preset);
  const drivenLabel = comp.link.kind === "mesh" || shared ? `Vitesse de ${comp.link.wheel}` : "Vitesse entrée";

  // Vitesse d'un membre de differentiel : signee, et zero admis pour un
  // membre tenu -- ce qui n'aurait aucun sens pour la cible d'un train
  // ordinaire, mais decrit ici un mode de fonctionnement.
  const differentialMode = comp.topology === "epicyclic" && comp.fixedMember === "none";
  const diffField = (member, label) => {
    const sp = comp.diff[member];
    return `<div class="field${member === "u" ? " full" : ""}">
      <label>${label}</label>
      <div class="speed-input">
        <input type="number" class="f-diff-value" data-member="${member}" step="any" value="${sp.value}" />
        <select class="f-diff-unit" data-member="${member}">
          ${Object.keys(SPEED_UNITS)
            .map((u) => opt(u, SPEED_UNIT_LABELS[u], u === sp.unit))
            .join("")}
        </select>
      </div>
    </div>`;
  };

  const speedField = (role, label) => {
    const sp = comp[role];
    return `<div class="field">
      <label>${label}</label>
      <div class="speed-input">
        <input type="number" class="f-speed-value" data-role="${role}" step="any" value="${sp.value}" />
        <select class="f-speed-unit" data-role="${role}">
          ${Object.keys(SPEED_UNITS)
            .map((u) => opt(u, SPEED_UNIT_LABELS[u], u === sp.unit))
            .join("")}
        </select>
      </div>
    </div>`;
  };

  const fixedLine = (role, local) => {
    const pos = comp.fixed[role];
    const active = state.placing && state.placing.compId === comp.id && state.placing.role === role;
    return `<span>${role === "entree" ? "Entrée" : "Sortie"} <em>${local}</em></span>
      <span>
        <span class="fixed-value">${pos ? fmtPos(pos) + " mm" + (pos.axis ? ` · sur l'axe de ${pos.axis}` : "") : "libre"}</span>
        <button type="button" class="link-btn btn-fix ${active ? "active" : ""}" data-role="${role}">${active ? "clique sur le dessin…" : "placer par clic"}</button>
        ${pos ? `<button type="button" class="link-btn btn-unfix" data-role="${role}">libérer</button>` : ""}
      </span>`;
  };

  section.innerHTML = `
    <h2 class="comp-title">
      <span>${comp.label} — complication</span>
      <span class="comp-actions">
        ${comp.collapsed ? `<label><input type="checkbox" class="f-draw" ${comp.drawWhenCollapsed ? "checked" : ""} /> dessiner</label>` : ""}
        <button type="button" class="link-btn btn-collapse">${comp.collapsed ? "déplier" : "replier"}</button>
        <button type="button" class="link-btn btn-remove" ${all.length === 1 ? "disabled" : ""}>supprimer</button>
      </span>
    </h2>
    <div class="comp-body" ${comp.collapsed ? "hidden" : ""}>
      <div class="field-row">
        <div class="field full">
          <label>Bibliothèque de complications</label>
          <select class="f-preset">
            ${opt("none", "— configuration libre —", comp.preset === "none")}
            ${COMPLICATION_LIBRARY.map((lib) => opt(lib.id, lib.label, lib.id === comp.preset)).join("")}
          </select>
        </div>
      </div>
      ${preset ? `<p class="empty-note preset-note">${preset.note}</p>` : ""}

      <div class="field-row">
        <div class="field" ${differentialMode ? 'style="visibility:hidden"' : ""}>
          <label>Cible</label>
          <select class="f-ratio-mode">
            ${opt("direct", "Ratio direct", !speedsMode)}
            ${opt("speeds", "Vitesses entrée / sortie", speedsMode)}
          </select>
        </div>
        <div class="field">
          <label>Tolérance</label>
          <input type="number" class="f-tol" step="any" min="0" value="${comp.tol}" />
        </div>
      </div>

      <div class="field-row">
        ${differentialMode
          ? diffField("a", "Vitesse planétaire A") + diffField("b", "Vitesse planétaire B") + diffField("u", "Vitesse voulue du porte-satellites")
          : speedsMode
          ? speedField("speedIn", drivenLabel) + speedField("speedOut", "Vitesse sortie")
          : `<div class="field full">
              <label>${ratioLabel}</label>
              <input type="number" class="f-ratio" step="0.0001" value="${comp.ratio}" />
            </div>`}
      </div>
      ${differentialMode
        ? `<p class="empty-note">
            Un différentiel n'a pas de rapport d'entrée à sortie : il a une <em>relation</em> entre trois mobiles.
            On pose donc les trois vitesses d'un mode de fonctionnement — vitesse nulle admise pour un membre tenu,
            signe négatif pour l'autre sens — et le rapport de base s'en déduit par Willis,
            R = (ω<sub>B</sub> − ω<sub>U</sub>) / (ω<sub>A</sub> − ω<sub>U</sub>). Les deux modes « un planétaire tenu »
            ne sont alors plus libres : ils sont rappelés ci-dessous.
          </p>`
        : ""}
      <p class="empty-note ratio-readout">${ratioReadoutHTML(comp)}</p>
      <div class="field-row">
        <div class="field">
          <label>Topologie</label>
          <select class="f-topology">
            ${opt("compound", "Chaîne simple", comp.topology === "compound")}
            ${opt("reverted", "Sortie coaxiale", comp.topology === "reverted")}
            ${opt("epicyclic", "Épicycloïdal / différentiel", comp.topology === "epicyclic")}
          </select>
        </div>
        ${comp.topology === "epicyclic"
          ? `<div class="field">
              <label>Type (Augereau)</label>
              <select class="f-epi-type">
                ${Object.entries(EPICYCLIC_TYPES)
                  .map(([id, t]) => opt(id, t.label, String(comp.epiType) === id))
                  .join("")}
              </select>
            </div>`
          : `<div class="field" ${comp.topology === "reverted" ? 'style="visibility:hidden"' : ""}>
              <label>Nombre d'étages</label>
              <select class="f-stages">
                ${Array.from({ length: MAX_STAGES }, (_, i) => i + 1)
                  .map((v) => opt(v, `${v} (${2 * v} mobiles)`, v === comp.stages))
                  .join("")}
              </select>
            </div>`}
      </div>
      ${comp.topology === "epicyclic"
        ? `<div class="field-row">
            <div class="field full">
              <label>Membre immobilisé</label>
              <select class="f-fixed-member">
                ${opt("U", "Porte-satellites bloqué — réducteur ordinaire (A → B)", comp.fixedMember === "U")}
                ${opt("A", "Planétaire A bloqué — cage motrice (U → B)", comp.fixedMember === "A")}
                ${opt("B", "Planétaire B bloqué — cage motrice (U → A)", comp.fixedMember === "B")}
                ${opt("none", "Aucun — différentiel à deux entrées", comp.fixedMember === "none")}
              </select>
            </div>
          </div>
          <p class="empty-note">
            Entrée <strong>${comp.entree}</strong> → sortie <strong>${comp.sortie}</strong>.
            ${comp.fixedMember === "none"
              ? `Vrai différentiel : les trois membres tournent, et la cage lit une <strong>moyenne pondérée</strong> des deux planétaires — les deux coefficients de Willis somment toujours à 1, jamais une différence. Un rapport de base négatif (types 1 et 2) la maintient entre les deux entrées ; un rapport positif (types 3 et 4) la place hors de l'intervalle. C'est le principe de l'indicateur de réserve de marche, dont un planétaire suit l'arbre de barillet et l'autre le barillet. Le sens de rotation de la cage ne se déduit pas des seuls signes : il vient des vitesses réelles.`
              : `Relation de Willis : ω<sub>B</sub> = R·ω<sub>A</sub> + (1−R)·ω<sub>U</sub>, avec R le rapport de base mesuré porte-satellites bloqué. Entrée et sortie découlent du membre immobilisé.`}
          </p>`
        : ""}
      ${linkBlock}

      <div class="table-scroll">
        <table class="candidates compact">
          <thead><tr><th>Mobile</th><th>Min</th><th>Max</th><th>Fixe</th><th title="Denture intérieure : couronne annulaire, le mobile mené tourne dedans">Int.</th><th>Entrée</th><th>Sortie</th></tr></thead>
          <tbody class="bounds-body">${boundsRows}</tbody>
        </table>
      </div>

      <div class="fixed-row">
        <span class="fixed-title">Position imposée sur la platine</span>
        ${fixedLine("entree", comp.entree)}
        ${fixedLine("sortie", comp.sortie)}
      </div>

      <div class="field-row" style="margin-top:0.9rem">
        <div class="field">
          <label>Sens entrée (vue de dessus)</label>
          <select class="f-sens-entree" ${linked ? "disabled" : ""}>
            ${opt(1, "Horaire ↻", sensEntreeValue === 1)}
            ${opt(-1, "Antihoraire ↺", sensEntreeValue === -1)}
          </select>
        </div>
        <div class="field">
          <label>Sens sortie souhaité</label>
          <select class="f-sens-sortie">
            ${opt(0, "Indifférent", comp.sensSortie === 0)}
            ${opt(1, "Horaire ↻", comp.sensSortie === 1)}
            ${opt(-1, "Antihoraire ↺", comp.sensSortie === -1)}
          </select>
        </div>
      </div>
      ${linked ? `<p class="empty-note" style="margin-top:0">Sens d'entrée hérité de ${comp.link.wheel} (${heritage}).</p>` : ""}

      <div class="field-row" style="margin-top:0.9rem">
        <div class="field full">
          <label><input type="checkbox" class="f-cam-on" ${comp.cam.enabled ? "checked" : ""} /> Came sur la sortie <em>${comp.sortie}</em></label>
        </div>
      </div>
      ${comp.cam.enabled
        ? `<div class="field-row">
            <div class="field full">
              <label>Grandeur encodée</label>
              <select class="f-cam-profile">
                ${Object.entries(CAM_PROFILES)
                  .map(([id, p]) => opt(id, p.label, id === comp.cam.profile))
                  .join("")}
              </select>
            </div>
          </div>
          <p class="empty-note">${CAM_PROFILES[comp.cam.profile].note}</p>
          ${comp.cam.followerType === "angulaire"
            ? `<div class="field-row">
                <div class="field full">
                  <label>Le palpeur entraîne</label>
                  <select class="f-cam-drives">
                    ${opt("levier", "Un râteau libre — sort un angle", comp.cam.drives === "levier")}
                    ${opt("porte-satellites", "Le porte-satellites d'un train épicycloïdal", comp.cam.drives === "porte-satellites")}
                  </select>
                </div>
              </div>
              ${comp.cam.drives === "porte-satellites"
                ? `<div class="field-row">
                    <div class="field full">
                      <label>Cage poussée</label>
                      <select class="f-cam-carrier">
                        ${comps()
                          .filter((c) => c.topology === "epicyclic")
                          .map((c) => opt(c.label, `${c.label} — porte-satellites`, c.label === comp.cam.carrierTarget))
                          .join("") || opt("", "aucune complication épicycloïdale", true)}
                      </select>
                    </div>
                  </div>
                  <p class="empty-note">
                    Équation marchante : la cage n'est pas menée, elle est <strong>posée</strong> par la came.
                    Le train reste un réducteur ordinaire de rapport R, et le déplacement de la cage ajoute
                    (1−R)·Δθ<sub>U</sub> à la sortie. La course angulaire ci-dessous n'est donc pas un réglage
                    libre : elle découle de la correction voulue et du rapport de base du train visé.
                  </p>`
                : ""}
              <div class="field-row">
                <div class="field">
                  <label>Course angulaire ${comp.cam.drives === "porte-satellites" ? "(déduite)" : "voulue"} (°)</label>
                  <input type="number" class="f-cam-swing" step="0.5" value="${formatRatio(comp.cam.swingAngle)}" ${
                    comp.cam.drives === "porte-satellites" ? "disabled" : ""
                  } />
                </div>
                <div class="field">
                  <label>Angle de repos (°)</label>
                  <input type="number" class="f-cam-rest" step="1" value="${comp.cam.restAngle}" />
                </div>
              </div>`
            : `<div class="field-row">
                <div class="field">
                  <label>Rayon de base (mm)</label>
                  <input type="number" class="f-cam-base" step="0.1" min="0.5" value="${comp.cam.baseRadius}" />
                </div>
                <div class="field">
                  <label>Course du palpeur (mm)</label>
                  <input type="number" class="f-cam-amp" step="0.05" min="0.05" value="${comp.cam.amplitude}" />
                </div>
              </div>`}
          <div class="field-row">
            <div class="field full">
              <label>Rayon du galet (mm) — 0 pour un bec pointu</label>
              <input type="number" class="f-cam-roller" step="0.05" min="0" value="${comp.cam.rollerRadius}" />
            </div>
          </div>
          <div class="field-row">
            <div class="field">
              <label>Palpeur</label>
              <select class="f-cam-follower-type">
                ${opt("lineaire", "Linéaire — course en mm", comp.cam.followerType === "lineaire")}
                ${opt("angulaire", "Angulaire — râteau pivoté", comp.cam.followerType === "angulaire")}
              </select>
            </div>
            <div class="field">
              <label>${comp.cam.followerType === "angulaire" ? "Direction du pivot (°)" : "Angle du palpeur (°)"}</label>
              <input type="number" class="f-cam-angle" step="5" value="${comp.cam.followerAngle}" />
            </div>
          </div>
          ${comp.cam.followerType === "angulaire"
            ? `<div class="field-row">
                <div class="field">
                  <label>Distance du pivot (mm)</label>
                  <input type="number" class="f-cam-pivot" step="0.5" min="0.1" value="${comp.cam.pivotDistance}" />
                </div>
                <div class="field">
                  <label>${
                    comp.cam.drives === "porte-satellites"
                      ? `Bras jusqu'au galet (mm)${comp.cam.carrierArm ? ` — satellite à ${formatModule(comp.cam.carrierArm)}` : ""}`
                      : "Longueur du levier (mm)"
                  }</label>
                  <input type="number" class="f-cam-lever" step="0.5" min="0.1" value="${formatRatio(comp.cam.leverLength)}" />
                </div>
              </div>
              <div class="field-row">
                <div class="field full">
                  <label>Période de la roue corrigée (h)</label>
                  <input type="number" class="f-cam-corrected" step="1" min="0.01" value="${comp.cam.correctedTurnHours}" />
                </div>
              </div>
              <p class="empty-note">
                Un râteau pivoté sort un <strong>angle</strong>, pas une course : c'est ce qui permet de l'injecter
                dans la seconde entrée d'un différentiel et d'ajouter ou retrancher la grandeur portée par la came
                à une roue qui tourne déjà. Le bec décrit un arc autour du pivot, pas un rayon — le point de contact
                n'est donc pas à la direction du pivot, et sa position se résout à chaque instant.
              </p>`
            : ""}
          <div class="field-row">
            <div class="field full" ${CAM_PROFILES[comp.cam.profile].needsLatitude ? "" : 'style="display:none"'}>
              <label>Latitude (°N)</label>
              <input type="number" class="f-cam-lat" step="0.5" min="-89" max="89" value="${comp.cam.latitude}" />
            </div>
          </div>
          <p class="empty-note cam-note"></p>`
        : ""}

      <div class="table-scroll">
        <table class="candidates compact idlers-table">
          <thead><tr><th>Engrènement</th><th>Renvois</th><th>Z min</th><th>Z max</th><th>Auto</th></tr></thead>
          <tbody class="idlers-body">${idlerRows}</tbody>
        </table>
      </div>
      <p class="empty-note sens-note"></p>

      <button type="button" class="btn-search">Rechercher</button>

      <div class="table-scroll">
        <table class="candidates results">
          <thead><tr></tr></thead>
          <tbody></tbody>
        </table>
      </div>
      <p class="empty-note search-note" hidden></p>
      <p class="empty-note truncated-note" hidden>Recherche interrompue (trop de combinaisons) — resserre les bornes pour un résultat exhaustif.</p>
    </div>`;

  bindComplicationPanel(section, comp);
  renderResults(comp);
  renderSensNote(comp);
  renderCamNote(comp);
}

function bindComplicationPanel(section, comp) {
  const on = (sel, evt, fn) => section.querySelectorAll(sel).forEach((el) => el.addEventListener(evt, fn));

  on(".btn-collapse", "click", () => {
    comp.collapsed = !comp.collapsed;
    renderComplicationPanel(comp);
    redrawOnly();
  });
  on(".f-draw", "change", (e) => {
    comp.drawWhenCollapsed = e.target.checked;
    redrawOnly();
  });
  on(".btn-remove", "click", () => removeComplication(comp));

  on(".f-ratio", "input", (e) => {
    comp.ratio = parseFloat(e.target.value);
    refreshReadout(section, comp);
  });
  on(".f-preset", "change", (e) => {
    applyLibraryPreset(comp, e.target.value);
    invalidateCandidates(comp);
    structuralChange(comp);
  });
  on(".f-ratio-mode", "change", (e) => {
    comp.ratioMode = e.target.value;
    renderComplicationPanel(comp);
  });
  on(".f-speed-value", "input", (e) => {
    comp[e.target.dataset.role].value = parseFloat(e.target.value);
    refreshReadout(section, comp);
  });
  on(".f-speed-unit", "change", (e) => {
    comp[e.target.dataset.role].unit = e.target.value;
    refreshReadout(section, comp);
  });
  on(".f-diff-value", "input", (e) => {
    comp.diff[e.target.dataset.member].value = parseFloat(e.target.value);
    refreshReadout(section, comp);
  });
  on(".f-diff-unit", "change", (e) => {
    comp.diff[e.target.dataset.member].unit = e.target.value;
    refreshReadout(section, comp);
  });
  on(".f-tol", "input", (e) => {
    comp.tol = parseFloat(e.target.value);
  });
  on(".f-topology", "change", (e) => {
    comp.topology = e.target.value;
    invalidateCandidates(comp);
    structuralChange(comp);
  });
  on(".f-stages", "change", (e) => {
    setStages(comp, e.target.value);
    invalidateCandidates(comp);
    structuralChange(comp);
  });
  on(".f-epi-type", "change", (e) => {
    comp.epiType = parseInt(e.target.value, 10);
    invalidateCandidates(comp);
    structuralChange(comp);
  });
  on(".f-fixed-member", "change", (e) => {
    comp.fixedMember = e.target.value;
    invalidateCandidates(comp);
    structuralChange(comp);
  });
  on(".f-link-kind", "change", (e) => {
    comp.link = { kind: e.target.value, wheel: comp.link.wheel };
    structuralChange(comp);
  });
  on(".f-link-wheel", "change", (e) => {
    comp.link.wheel = e.target.value;
    structuralChange(comp);
  });
  on(".f-sens-entree", "change", (e) => {
    comp.sensEntree = parseInt(e.target.value, 10);
    schedulePlacement();
  });
  on(".f-sens-sortie", "change", (e) => {
    comp.sensSortie = parseInt(e.target.value, 10);
    schedulePlacement();
  });

  on(".bounds-body tr:not(.shared-row)", "input", (e) => {
    const tr = e.currentTarget;
    const b = comp.bounds[tr.dataset.name];
    const minInput = tr.querySelector(".bound-min");
    const maxInput = tr.querySelector(".bound-max");
    const fixedBox = tr.querySelector(".bound-fixed");
    b.fixed = fixedBox.checked;
    b.min = Math.max(4, parseInt(minInput.value, 10) || 4);
    maxInput.disabled = b.fixed;
    if (b.fixed) maxInput.value = b.min;
    else b.max = Math.max(4, parseInt(maxInput.value, 10) || 4);
  });
  on(".bound-internal", "change", (e) => {
    const tr = e.currentTarget.closest("tr");
    comp.internal[tr.dataset.name] = e.currentTarget.checked;
    structuralChange(comp);
  });
  on(`input[name="entree-${comp.id}"]`, "change", (e) => {
    comp.entree = e.target.value;
    comp.fixed.entree = null;
    structuralChange(comp);
  });
  on(`input[name="sortie-${comp.id}"]`, "change", (e) => {
    comp.sortie = e.target.value;
    comp.fixed.sortie = null;
    structuralChange(comp);
  });

  on(".btn-fix", "click", (e) => {
    const role = e.currentTarget.dataset.role;
    const already = state.placing && state.placing.compId === comp.id && state.placing.role === role;
    setPlacingMode(already ? null : { compId: comp.id, role });
  });
  on(".btn-unfix", "click", (e) => {
    comp.fixed[e.currentTarget.dataset.role] = null;
    renderComplicationPanel(comp);
    schedulePlacement();
  });

  on(".idlers-body tr", "change", (e) => {
    const tr = e.currentTarget;
    const cfg = comp.idlers[tr.dataset.key];
    cfg.count = parseInt(tr.querySelector(".idler-count").value, 10);
    cfg.min = Math.max(4, parseInt(tr.querySelector(".idler-min").value, 10) || 4);
    cfg.max = Math.max(cfg.min, parseInt(tr.querySelector(".idler-max").value, 10) || cfg.min);
    schedulePlacement();
  });
  on(`input[name="auto-${comp.id}"]`, "change", (e) => {
    comp.autoIdlerMesh = e.target.value;
    schedulePlacement();
  });

  on(".f-cam-on", "change", (e) => {
    comp.cam.enabled = e.target.checked;
    renderComplicationPanel(comp);
    schedulePlacement();
  });
  on(".f-cam-profile", "change", (e) => {
    comp.cam.profile = e.target.value;
    renderComplicationPanel(comp);
    schedulePlacement();
  });
  const camNumber = (sel, field) =>
    on(sel, "change", (e) => {
      const v = parseFloat(e.target.value);
      if (Number.isFinite(v)) comp.cam[field] = v;
      schedulePlacement();
    });
  camNumber(".f-cam-base", "baseRadius");
  camNumber(".f-cam-amp", "amplitude");
  camNumber(".f-cam-angle", "followerAngle");
  camNumber(".f-cam-lat", "latitude");
  camNumber(".f-cam-pivot", "pivotDistance");
  camNumber(".f-cam-swing", "swingAngle");
  camNumber(".f-cam-rest", "restAngle");
  camNumber(".f-cam-roller", "rollerRadius");
  camNumber(".f-cam-lever", "leverLength");
  camNumber(".f-cam-corrected", "correctedTurnHours");
  on(".f-cam-drives", "change", (e) => {
    comp.cam.drives = e.target.value;
    if (comp.cam.drives === "porte-satellites" && !comp.cam.carrierTarget) {
      const target = comps().find((c) => c.topology === "epicyclic");
      comp.cam.carrierTarget = target ? target.label : null;
    }
    renderComplicationPanel(comp);
    schedulePlacement();
  });
  on(".f-cam-carrier", "change", (e) => {
    comp.cam.carrierTarget = e.target.value || null;
    schedulePlacement();
  });
  on(".f-cam-follower-type", "change", (e) => {
    comp.cam.followerType = e.target.value;
    // la geometrie du levier se redimensionne sur la came courante
    comp.cam.pivotDistance = 0;
    comp.cam.leverLength = 0;
    renderComplicationPanel(comp);
    schedulePlacement();
  });

  on(".btn-search", "click", () => {
    searchRatio(comp);
    schedulePlacement();
  });
}

function invalidateCandidates(comp) {
  comp.candidates = [];
  comp.selected = null;
  comp.searchNote = "";
}

/** Changement de structure : tout re-normaliser, re-rendre, relancer la recherche. */
function structuralChange(comp) {
  normalizeAll(comps());
  renderAllComplicationPanels();
  searchRatio(comp);
  schedulePlacement();
}

/**
 * Monte un assemblage complet : plusieurs complications deja reliees entre
 * elles. Remplace ce qui existe -- un assemblage decrit un mecanisme
 * entier, le melanger a une configuration en cours n'aurait pas de sens.
 */
function applyAssembly(id) {
  const assembly = libraryAssembly(id);
  if (!assembly) return;

  comps().length = 0;
  state.protectedOverrides.clear();
  const created = [];
  for (const spec of assembly.complications) {
    const comp = createComplication({}, created);
    comps().push(comp);
    created.push(comp);
    if (spec.preset) applyLibraryPreset(comp, spec.preset);
    for (const [key, value] of Object.entries(spec)) {
      if (key === "preset" || key === "cam" || key === "carrierTargetIndex") continue;
      comp[key] = value && typeof value === "object" ? JSON.parse(JSON.stringify(value)) : value;
    }
    if (spec.cam) Object.assign(comp.cam, JSON.parse(JSON.stringify(spec.cam)));
    if (spec.carrierTargetIndex !== undefined) comp.cam.carrierTarget = created[spec.carrierTargetIndex].label;
  }

  if (assembly.plateDiameter) {
    const plate = document.getElementById("plate-diameter");
    plate.value = String(assembly.plateDiameter);
    plate.dispatchEvent(new Event("input", { bubbles: true }));
  }

  normalizeAll(comps());
  renderAllComplicationPanels();
  comps().forEach((c) => searchRatio(c));
  document.getElementById("assembly-note").textContent = assembly.note;
  schedulePlacement();
}

function addComplication() {
  const comp = createComplication({}, comps());
  comps().push(comp);
  normalizeAll(comps());
  renderAllComplicationPanels();
  searchRatio(comp);
  schedulePlacement();
}

function removeComplication(comp) {
  const all = comps();
  if (all.length <= 1) return;
  const dependents = all.filter((c) => c !== comp && c.link.kind !== "none" && ownerOf(all, c.link.wheel) === comp);
  all.splice(all.indexOf(comp), 1);
  if (state.placing?.compId === comp.id) setPlacingMode(null);
  normalizeAll(all);
  renderAllComplicationPanels();
  dependents.forEach((dep) => searchRatio(dep));
  schedulePlacement();
}

// ------------------------------------------------------------------
// Positions imposees par clic sur le dessin
// ------------------------------------------------------------------

function setPlacingMode(placing) {
  state.placing = placing;
  const hint = document.getElementById("placing-hint");
  const area = document.getElementById("drawing-area");
  area.classList.toggle("placing", !!placing);
  if (placing) {
    const comp = comps().find((c) => c.id === placing.compId);
    const local = placing.role === "entree" ? comp.entree : comp.sortie;
    hint.hidden = false;
    hint.textContent = `Clique sur la platine pour imposer la position de ${resolveLocal(
      comp,
      local
    )} — le clic s'accroche à l'axe le plus proche s'il y en a un (Échap pour annuler).`;
  } else {
    hint.hidden = true;
  }
  comps().forEach((c) => renderComplicationPanel(c));
}

/** Rayon d'accrochage, en pixels a l'ecran (donc constant au zoom). */
const SNAP_RADIUS_PX = 12;

/**
 * Points d'ancrage proposes au clic : chaque axe deja place, les positions
 * deja imposees, et le centre de la platine. Les mobiles coaxiaux
 * partagent un point : on regroupe par position pour qu'un axe portant
 * trois roues ne compte qu'une fois, en gardant la liste de ses mobiles
 * pour pouvoir dire sur quel axe on s'est accroche.
 */
function snapTargets(exclude) {
  const byPos = new Map();
  const add = (x, y, label) => {
    const key = `${x.toFixed(4)},${y.toFixed(4)}`;
    if (!byPos.has(key)) byPos.set(key, { x, y, labels: [] });
    byPos.get(key).labels.push(label);
  };

  add(0, 0, "centre de la platine");

  const layout = state.lastRender && state.lastRender.layout;
  if (layout) for (const [name, pos] of layout.positions) add(pos.x, pos.y, name);

  for (const comp of comps()) {
    for (const role of ["entree", "sortie"]) {
      if (exclude && exclude.comp === comp && exclude.role === role) continue;
      const pos = comp.fixed[role];
      if (pos) add(pos.x, pos.y, `${globalName(comp, role === "entree" ? comp.entree : comp.sortie)} (imposé)`);
    }
  }
  return [...byPos.values()];
}

/**
 * Accroche (x, y) a l'axe le plus proche s'il est a portee. Le seuil est
 * exprime a l'ecran : accrocher doit rester aussi facile quel que soit le
 * zoom.
 */
function snapPoint(x, y, exclude) {
  const limitMm = SNAP_RADIUS_PX / viewScale();
  let best = null;
  let bestDist = Infinity;
  for (const t of snapTargets(exclude)) {
    const d = Math.hypot(t.x - x, t.y - y);
    if (d < bestDist && d <= limitMm) {
      bestDist = d;
      best = t;
    }
  }
  return best;
}

function onDrawingClick(e) {
  if (!state.placing) return;
  const svg = document.querySelector("#drawing-area svg");
  if (!svg) return;
  const rect = svg.getBoundingClientRect();
  const scale = viewScale();
  const originPx = (state.lastPlateRadius + MARGIN) * scale;
  const x = (e.clientX - rect.left - originPx) / scale;
  const y = (e.clientY - rect.top - originPx) / scale;
  const comp = comps().find((c) => c.id === state.placing.compId);
  if (!comp) return setPlacingMode(null);

  const role = state.placing.role;
  const snap = snapPoint(x, y, { comp, role });
  comp.fixed[role] = snap
    ? { x: snap.x, y: snap.y, axis: snap.labels.slice(0, 3).join(", ") + (snap.labels.length > 3 ? "…" : "") }
    : { x: Math.round(x * 20) / 20, y: Math.round(y * 20) / 20 };

  setPlacingMode(null);
  schedulePlacement();
}

// ------------------------------------------------------------------
// Recherche de ratio (par complication)
// ------------------------------------------------------------------

function renderResults(comp) {
  const section = panelOf(comp);
  if (!section) return;
  const head = section.querySelector(".results thead tr");
  const body = section.querySelector(".results tbody");
  const note = section.querySelector(".search-note");
  const truncNote = section.querySelector(".truncated-note");
  const labels = ownLocalWheelNames(comp);

  // colonne modules : dans un train revertant les entraxes doivent etre
  // egaux, le couple de modules fait donc partie du resultat -- et l'on
  // voit d'un coup d'oeil quelles combinaisons sont de vrais trains
  // revertants (module unique) et lesquelles demandent un decalage
  const showModules = comp.candidates.some((c) => c.reverted);

  head.innerHTML = labels.map((l) => `<th>${l}</th>`).join("") + (showModules ? `<th>Modules</th>` : "") + `<th>Ratio</th><th>Écart</th>`;
  body.innerHTML = "";
  note.hidden = !comp.searchNote;
  note.textContent = comp.searchNote;
  truncNote.hidden = !comp.truncated;

  comp.candidates.forEach((cand) => {
    const tr = document.createElement("tr");
    tr.className = "candidate-row" + (cand === comp.selected ? " selected" : "");
    let modulesCell = "";
    if (showModules) {
      const rev = cand.reverted;
      const pair = rev?.pairs?.[0];
      modulesCell = pair
        ? `<td class="${rev.same ? "module-same" : "module-split"}" title="${rev.pairs.length} couple(s) de modules compatibles — entraxe ${(
            (pair.m1 * rev.D1) /
            2
          ).toFixed(3)} mm">${rev.same ? formatModule(pair.m1) : `${formatModule(pair.m1)} / ${formatModule(pair.m2)}`}</td>`
        : `<td class="muted">—</td>`;
    }
    tr.innerHTML =
      cand.teeth.map((z) => `<td>${z}</td>`).join("") + modulesCell + `<td>${cand.ratio.toFixed(5)}</td><td>${cand.error.toExponential(1)}</td>`;
    tr.addEventListener("click", () => {
      comp.selected = cand;
      body.querySelectorAll("tr.selected").forEach((el) => el.classList.remove("selected"));
      tr.classList.add("selected");
      cascadeSearch(comp);
      schedulePlacement();
    });
    body.appendChild(tr);
  });
}

/** Les complications dont l'entree depend des dents de `comp` (engrenee ou partagee) sont recalculees. */
function cascadeSearch(comp) {
  for (const dep of comps()) {
    if (dep !== comp && ["mesh", "shared"].includes(dep.link.kind) && ownerOf(comps(), dep.link.wheel) === comp) searchRatio(dep);
  }
}

/**
 * Recherche des dents d'un train epicycloidal. Le rapport n'est pas un
 * produit de dents : c'est une fonction homographique du rapport de base
 * (formule de Willis), et il change selon le membre immobilise. On balaye
 * donc A et les satellites, et l'on DEDUIT le planetaire B du rapport de
 * base voulu -- comme le fait Augereau quand il tire a/b d'un rapport
 * impose. La contrainte d'entraxes egaux departage ensuite.
 */
function searchEpicyclicRatio(comp, targetRatio, names) {
  const { min: moduleMin, max: moduleMax } = moduleRange();
  const basicTarget = epicyclicBasicFromTransmission(targetRatio, comp.fixedMember);

  if (!Number.isFinite(basicTarget) || basicTarget === 0) {
    invalidateCandidates(comp);
    comp.searchNote = `Ce rapport n'est pas réalisable avec ${EPICYCLIC_MEMBER_LABELS[comp.fixedMember] ?? "ce membre"} immobilisé (rapport de base indéterminé).`;
    renderResults(comp);
    return;
  }

  // Le signe du rapport de base est fixe par le type : aucun nombrage n'y
  // changera rien, autant le dire tout de suite plutot que de laisser
  // balayer des centaines de milliers de combinaisons pour rien.
  // Type 1 : le satellite unique n'a qu'un module, donc a = (B - A)/2, ce
  // qui exige B > A et borne |R| = A/B strictement sous 1. Le dire vaut
  // mieux que de renvoyer une liste vide.
  if (!epicyclicType(comp).compound && Math.abs(basicTarget) >= 1) {
    invalidateCandidates(comp);
    const tete = `Hors de portée du type 1 : son satellite unique impose a = (B − A)/2, donc B > A et |R| = A/B < 1 — or il faudrait |R| = ${formatRatio(
      Math.abs(basicTarget)
    )}.`;
    const range = comp.fixedMember === "none" ? differentialCarrierRange(comp) : null;
    comp.searchNote = range
      ? `${tete} Pour un différentiel, |R| < 1 signifie que la cage doit rester plus proche du planétaire B (${formatRatio(
          range.hi === signedTurnsPerHour(comp.diff.b) ? range.hi : range.lo
        )} tr/h) que du planétaire A — essaie ${formatRatio(range.suggestion)} tr/h. À défaut, passe en type 2 (satellite double).`
      : `${tete} Avec le planétaire A bloqué ce type ne dépasse pas un rapport de 2 ; passe en type 2 (satellite double), ou immobilise le planétaire B.`;
    renderResults(comp);
    return;
  }

  const sign = epicyclicSignOfType(comp);
  if (Math.sign(basicTarget) !== sign) {
    invalidateCandidates(comp);
    const cible = sign < 0 ? "négatif" : "positif";
    const autres = sign < 0 ? "3 ou 4" : "1 ou 2";
    const tete =
      `Impossible quel que soit le nombrage : un train de ${epicyclicType(comp).label.toLowerCase()} impose un rapport de base ${cible} ` +
      `(R = ${sign < 0 ? "−" : "+"}(A·b)/(a·B)), or il faudrait R = ${formatRatio(basicTarget)}.`;

    // Pour un differentiel, la contrainte se lit directement sur la vitesse
    // de la cage : dire dans quel domaine elle doit tomber vaut mieux que
    // « vise l'autre sens ».
    const range = comp.fixedMember === "none" ? differentialCarrierRange(comp) : null;
    comp.searchNote = range
      ? `${tete} Avec ces deux planétaires (${formatRatio(range.lo)} et ${formatRatio(range.hi)} tr/h), ce type exige une vitesse de cage ` +
        (range.inside
          ? `STRICTEMENT ENTRE les deux — essaie ${formatRatio(range.suggestion)} tr/h.`
          : `HORS de l'intervalle [${formatRatio(range.lo)} ; ${formatRatio(range.hi)}] — essaie ${formatRatio(range.suggestion)} tr/h.`) +
        ` Les types 1 et 2 font une moyenne (la cage reste entre les deux entrées), les types 3 et 4 amplifient l'écart. À défaut, passe en type ${autres}.`
      : `${tete} Passe en type ${autres}, change le membre immobilisé, ou vise l'autre sens de rotation.`;
    renderResults(comp);
    return;
  }

  const positions = names.map((local) => {
    const b = comp.bounds[local];
    const min = Math.min(b.min, b.fixed ? b.min : b.max);
    const max = b.fixed ? b.min : Math.max(b.min, b.max);
    return { name: globalName(comp, local), min, max, exponent: 0 };
  });
  const pivot = names.indexOf("planetaire_b");
  const teethOf = (values) => Object.fromEntries(names.map((l, i) => [l, values[i]]));

  const outcome = findTrainByEnumeration(targetRatio, positions, {
    tol: comp.tol,
    maxResults: 10,
    pivot,
    achieve: (values) => epicyclicTransmission(epicyclicBasicFromTeeth(comp, teethOf(values)), comp.fixedMember),
    solvePivot: (values) => epicyclicSolveForB(comp, teethOf(values), basicTarget),
    rate: (values) => {
      const teethByLocal = teethOf(values);
      if (internalTeethViolations(comp, teethByLocal).length) return null;
      return twinMeshQuality(comp, teethByLocal, moduleMin, moduleMax, { arborRadius: arborRadius() });
    },
  });

  comp.candidates = outcome.results.map((r) => ({
    teeth: r.teeth.slice(0, names.length),
    teethByLocal: Object.fromEntries(names.map((l, i) => [l, r.teeth[i]])),
    ratio: r.ratio,
    error: r.error,
    reverted: r.meta ?? null,
    basicRatio: epicyclicBasicFromTeeth(comp, Object.fromEntries(names.map((l, i) => [l, r.teeth[i]]))),
  }));
  comp.truncated = outcome.truncated;
  comp.selected = comp.candidates[0] ?? null;

  const notes = [];
  const type = epicyclicType(comp);
  if (!comp.candidates.length) {
    notes.push(
      `Aucune combinaison ne donne ce rapport dans ces bornes. Le ${type.label.toLowerCase()} impose deux entraxes égaux — élargis les bornes de dents ou la plage de modules.`
    );
  } else {
    const best = comp.candidates[0];
    if (comp.fixedMember === "none") {
      const R = best.basicRatio;
      // la cage lit une moyenne PONDEREE des deux planetaires (les deux
      // coefficients de Willis somment a 1) : entre les deux entrees quand
      // R < 0, en dehors quand R > 0
      notes.push(
        `Différentiel : rapport de base R = ${formatRatio(R)} (cage bloquée). La cage lit une moyenne pondérée des deux planétaires — ${
          R < 0 ? "comprise entre leurs deux vitesses" : "hors de l'intervalle qu'elles délimitent, l'écart est amplifié"
        }.`
      );
      const modes = differentialModes(comp, R);
      if (modes) {
        notes.push(
          `Les deux modes qui en découlent : planétaire B tenu → cage ${formatRatio(modes.perTurnOfA)} tour par tour de A ; ` +
            `planétaire A tenu → cage ${formatRatio(modes.perTurnOfB)} tour par tour de B.`
        );
        if (modes.balanced) {
          notes.push(
            "Ces deux coefficients sont égaux en valeur absolue : l'aiguille parcourt le même angle par tour dans les deux modes, ce qu'exige un indicateur de réserve de marche. L'inversion de sens, elle, vient du rouage qui attaque les deux planétaires — la cage ne lit qu'une moyenne pondérée, jamais une différence."
          );
        }
      }
    } else {
      notes.push(
        `${EPICYCLIC_MEMBER_LABELS[comp.fixedMember]} immobilisé : rapport de base R = ${formatRatio(best.basicRatio)}, transmission ${formatRatio(best.ratio)}.`
      );
    }
    if (outcome.exceedsTol) {
      notes.push(`Aucune combinaison n'atteint la tolérance ${comp.tol} — voici les plus proches (meilleur écart ${best.error.toExponential(1)}).`);
    }
    const rev = best.reverted;
    if (rev) {
      notes.push(
        rev.same
          ? `Les deux engrènements partagent le même module (D₁ = D₂ = ${rev.D1}).`
          : `Entraxes égalisés en décalant le module : ${formatModule(rev.pairs[0].m1)} / ${formatModule(rev.pairs[0].m2)} mm (D₁=${rev.D1}, D₂=${rev.D2}).`
      );
    }
  }
  comp.searchNote = notes.join(" ");
  renderResults(comp);
}

function searchRatio(comp) {
  const all = comps();
  const k = all.indexOf(comp);
  normalizeAll(all);
  state.analysis = analyzeTrainSenses(all);

  const targetRatio = effectiveRatio(comp);
  if (!ratioTargetValid(comp, targetRatio)) {
    invalidateCandidates(comp);
    comp.searchNote =
      comp.ratioMode === "speeds"
        ? "Vitesses invalides : saisis deux valeurs non nulles."
        : comp.topology === "epicyclic"
        ? "Rapport de base invalide : saisis un nombre non nul (il est souvent négatif dans un train épicycloïdal)."
        : "Ratio cible invalide : saisis un nombre strictement positif.";
    renderResults(comp);
    cascadeSearch(comp);
    return;
  }

  const prefix = all.slice(0, k + 1);
  const template = buildGlobalTrain(prefix, {}, state.analysis.effective);
  const names = ownLocalWheelNames(comp);
  const entreeG = resolveLocal(comp, comp.entree);
  const sortieG = globalName(comp, comp.sortie);

  let source = entreeG;
  let driverFixed = null;
  if (comp.link.kind === "mesh" || comp.link.kind === "shared") {
    const owner = ownerOf(all, comp.link.wheel);
    if (!owner?.selected) {
      invalidateCandidates(comp);
      comp.searchNote = `Sélectionne d'abord un candidat pour ${owner?.label ?? "la complication motrice"} : le ratio est mesuré depuis ${comp.link.wheel}.`;
      renderResults(comp);
      cascadeSearch(comp);
      return;
    }
    source = comp.link.wheel;
    driverFixed = owner.selected.teethByLocal[localOf(comp.link.wheel)];
  }

  if (comp.topology === "epicyclic") {
    searchEpicyclicRatio(comp, targetRatio, names);
    cascadeSearch(comp);
    return;
  }

  const exponents = computeRatioExponents(template, source, sortieG);
  if (exponents === null) {
    invalidateCandidates(comp);
    comp.searchNote = `Aucune relation cinématique entre ${source} et ${sortieG} (axe indépendant sur le chemin) — choisis une autre paire entrée/sortie.`;
    renderResults(comp);
    cascadeSearch(comp);
    return;
  }

  const positions = names.map((local) => {
    const b = comp.bounds[local];
    const min = Math.min(b.min, b.fixed ? b.min : b.max);
    const max = b.fixed ? b.min : Math.max(b.min, b.max);
    return { name: globalName(comp, local), min, max, exponent: exponents[globalName(comp, local)] };
  });
  if (driverFixed !== null) positions.push({ name: source, min: driverFixed, max: driverFixed, exponent: exponents[source] });

  // Un train revertant strict lie ses quatre roues entre elles (entraxes
  // egaux) : la decomposition independante numerateur / denominateur ne
  // sait pas exprimer cette contrainte, il faut enumerer.
  const twinMesh = hasTwinMeshConstraint(comp, state.analysis.effective[comp.id]) && positions.some((p) => p.exponent !== 0);
  const { min: moduleMin, max: moduleMax } = moduleRange();

  let outcome;
  if (twinMesh) {
    const rate = (values) => {
      const teethByLocal = Object.fromEntries(names.map((l, i) => [l, values[i]]));
      if (internalTeethViolations(comp, teethByLocal).length) return null;
      return twinMeshQuality(comp, teethByLocal, moduleMin, moduleMax, { arborRadius: arborRadius() });
    };
    outcome = findTrainByEnumeration(targetRatio, positions, { tol: comp.tol, maxResults: 10, rate });
  } else {
    outcome = findTrainForRatio(targetRatio, positions, { tol: comp.tol, maxResults: 10 });
  }

  const found = outcome.results.map((r) => ({
    teeth: r.teeth.slice(0, names.length),
    teethByLocal: Object.fromEntries(names.map((l, i) => [l, r.teeth[i]])),
    ratio: r.ratio,
    error: r.error,
    reverted: r.meta ?? null,
  }));
  // une couronne dont le partenaire est plus gros donnerait un entraxe
  // negatif : ces combinaisons n'ont pas de sens geometrique
  comp.candidates = found.filter((cand) => internalTeethViolations(comp, cand.teethByLocal).length === 0);
  const rejected = found.length - comp.candidates.length;
  comp.truncated = outcome.truncated;
  comp.selected = comp.candidates[0] ?? null;

  const notes = [];
  if (rejected) {
    notes.push(
      `${rejected} combinaison${rejected > 1 ? "s" : ""} écartée${rejected > 1 ? "s" : ""} : une denture intérieure doit avoir plus de dents que le mobile qui engrène dedans.`
    );
  }
  if (comp.candidates.length === 0) {
    notes.push(source === sortieG ? "Entrée = sortie : ratio fixé à 1, sans contrainte sur les dents." : "Aucun candidat trouvé dans ces bornes.");
  } else if (outcome.exceedsTol) {
    notes.push(
      `Aucune combinaison n'atteint la tolérance ${comp.tol} — voici les ${comp.candidates.length} plus proches (meilleur écart ${comp.candidates[0].error.toExponential(1)}). Élargis les bornes de dents, ajoute un étage, ou relâche la tolérance.`
    );
  }
  if (comp.candidates.length > 0 && comp.ratioMode === "speeds") {
    const inH = toTurnsPerHour(comp.speedIn.value, comp.speedIn.unit);
    const outH = toTurnsPerHour(comp.speedOut.value, comp.speedOut.unit);
    notes.push(
      `Meilleur candidat : sortie 1 tour / ${formatPeriod(inH * comp.candidates[0].ratio)} (visé ${formatPeriod(outH)}).`
    );
  }
  if (comp.candidates.length > 0 && driverFixed !== null) {
    notes.push(`Ratio mesuré de ${source} (Z=${driverFixed}, fixé) jusqu'à ${comp.sortie}.`);
  }
  if (twinMesh) {
    const rev = comp.candidates[0]?.reverted;
    if (!rev) {
      notes.push(
        `Sortie coaxiale : les deux engrènements relient les mêmes axes, leurs entraxes doivent être égaux (m₁·D₁ = m₂·D₂). Aucune combinaison n'y arrive avec un module entre ${formatModule(
          moduleMin
        )} et ${formatModule(moduleMax)} mm — élargis la plage de modules ou les bornes de dents.`
      );
    } else if (rev.same) {
      notes.push(`Vrai train revertant : les quatre roues partagent le même module (D₁ = D₂ = ${rev.D1}).`);
    } else {
      notes.push(
        `Entraxes égalisés en décalant le module d'une paire : ${formatModule(rev.pairs[0].m1)} / ${formatModule(rev.pairs[0].m2)} mm (D₁=${rev.D1}, D₂=${
          rev.D2
        })${rev.round ? "" : " — aucun module rond ne convient ici, resserre plutôt les dents"}.`
      );
    }
  }
  comp.searchNote = notes.join(" ");

  renderResults(comp);
  cascadeSearch(comp);
}

// ------------------------------------------------------------------
// Sens de rotation : notes par complication
// ------------------------------------------------------------------

/**
 * Note de la came : plage encodée, course réelle du palpeur, et surtout
 * verification de la periode. Une came d'equation du temps montee sur un
 * mobile qui ne fait pas un tour par an affiche une grandeur qui n'existe
 * pas -- c'est l'erreur la plus facile a commettre et la plus difficile a
 * voir sur un dessin.
 */
function renderCamNote(comp) {
  syncCarrierCams(comps());
  const section = panelOf(comp);
  const el = section?.querySelector(".cam-note");
  if (!el) return;
  const spec = camSpec(comp);
  const profile = CAM_PROFILES[comp.cam.profile];
  if (!spec || !profile) {
    el.textContent = "";
    return;
  }

  const s = spec.samples;
  const parts = [
    `Plage encodée : ${profile.format(s.min)} à ${profile.format(s.max)}, sur ${formatModule(spec.baseRadius)} → ${formatModule(
      spec.baseRadius + spec.amplitude
    )} mm de rayon.`,
  ];

  if (spec.followerType === "angulaire") {
    const lever = camLeverSwing(spec);
    if (!lever || lever.missing) {
      parts.push(
        `Levier incompatible : le bec n'atteint pas la came sur ${lever ? lever.missing : "tout le"} tour. Il faut une longueur d'au moins ${formatModule(
          suggestedLeverLength(spec)
        )} mm pour un pivot à ${formatModule(spec.pivotDistance)} mm.`
      );
    } else {
      const correctedDegrees = ((s.max - s.min) / (spec.correctedTurnHours * 60)) * 360;

      if (spec.drives === "porte-satellites") {
        // La cage est POSEE par la came : on verifie que le debattement
        // obtenu produit bien la correction voulue sur la sortie du train.
        const target = comps().find((c) => c.label === spec.carrierTarget && c.topology === "epicyclic");
        const basicRatio = target?.selected?.basicRatio;
        if (!Number.isFinite(basicRatio)) {
          parts.push(
            `Cage poussée : sélectionne une complication épicycloïdale et un candidat de dents pour elle — le débattement dépend de son rapport de base.`
          );
        } else {
          const got = correctionFromCarrierSwing(lever.swing, spec.correctedTurnHours, basicRatio);
          parts.push(
            `Équation marchante sur ${target.label} (R = ${formatRatio(basicRatio)}) : la came déplace la cage de ${lever.swing.toFixed(
              2
            )}°, ce qui ajoute ${got.outputDegrees.toFixed(3)}° à la sortie, soit ${got.minutes.toFixed(
              2
            )} min sur une roue faisant 1 tour en ${spec.correctedTurnHours} h (visé ${(s.max - s.min).toFixed(2)} min).`
          );
          const arm = comp.cam.carrierArm;
          parts.push(
            `Le palpeur est le porte-satellites lui-même, prolongé : depuis l'axe central de ${target.label} il porte son satellite ` +
              `à ${arm ? formatModule(arm) : "?"} mm (entraxe du train), puis continue jusqu'au galet à ${formatModule(spec.leverLength)} mm. ` +
              `L'axe de la came est tenu à ${formatModule(spec.pivotDistance)} mm de l'axe central, et l'orientation de la cage découle du contact — ` +
              `le placeur maintient les deux.`
          );
        }
      } else {
        parts.push(
          `Profil synthétisé depuis la course voulue : râteau ${lever.swing.toFixed(2)}° (demandé ${formatRatio(
            spec.swingAngle
          )}°), la lecture est donc proportionnelle à la grandeur encodée. La plage vaut ${correctedDegrees.toFixed(
            3
          )}° sur une roue faisant 1 tour en ${spec.correctedTurnHours} h — il faut un rapport de ${formatRatio(
            lever.swing / correctedDegrees
          )} entre le râteau et l'entrée du différentiel pour que la correction tombe juste.`
        );
      }
    }
  }

  // Galet et contre-depouille : un galet plus gros que le rayon de courbure
  // dans un creux mange la matiere, et la came devient irrealisable.
  const geo = spec.geometry;
  if (geo) {
    if (geo.roller > 0 && geo.undercut) {
      parts.push(
        `CONTRE-DÉPOUILLE : avec un galet de ${formatModule(geo.roller)} mm le profil se recoupe${
          geo.minCurvature ? ` (rayon de courbure minimal ${formatModule(geo.minCurvature)} mm)` : ""
        } — la came ne peut pas être taillée. Réduis le galet, adoucis la course, ou éloigne le pivot.`
      );
    } else if (geo.roller > 0) {
      parts.push(
        `Galet ${formatModule(geo.roller)} mm, pas de contre-dépouille${
          geo.minCurvature ? ` (rayon de courbure minimal ${formatModule(geo.minCurvature)} mm)` : ""
        }. Profil usiné entre ${formatModule(geo.innerRadius)} et ${formatModule(geo.outerRadius)} mm.`
      );
    }
  }
  if (s.undefinedDays) {
    parts.push(
      `${s.undefinedDays} jours sans lever ni coucher à cette latitude (au-delà du cercle polaire) : le profil y est prolongé par la dernière valeur, la came n'a plus de sens sur cette portion.`
    );
  }

  const velocity = (state.velocities ?? state.lastRender?.velocities)?.get(globalName(comp, "came"));
  const check = camPeriodCheck(comp, velocity);
  if (!check) {
    parts.push(
      `Cette came doit faire 1 tour en ${formatPeriod(
        toTurnsPerHour(profile.turnPeriod.value, profile.turnPeriod.unit)
      )} — vitesse de sortie inconnue pour l'instant (cible en ratio direct, ou placement pas encore calculé), donc non vérifiée.`
    );
  } else if (check.ok) {
    parts.push(`Période vérifiée : la sortie fait bien 1 tour en ${formatPeriod(check.actual)}.`);
  } else {
    parts.push(
      `Période INCORRECTE : la sortie fait 1 tour en ${formatPeriod(check.actual)}, il en faudrait 1 en ${formatPeriod(
        check.wanted
      )} (facteur ${formatRatio(check.ratio)}). La came afficherait une grandeur qui n'a pas de sens.`
    );
  }

  el.textContent = parts.join(" ");
  el.classList.toggle("alert", !!(check && !check.ok));
}

function renderSensNote(comp) {
  const section = panelOf(comp);
  if (!section) return;
  const el = section.querySelector(".sens-note");
  const info = state.analysis?.info?.[comp.id];

  section.querySelectorAll(".idlers-body tr").forEach((tr) => {
    tr.querySelector(".tag-auto").hidden = !(info?.autoApplied && info.autoMesh === tr.dataset.key);
  });

  if (!info) {
    el.textContent = "";
    return;
  }

  const sensSelect = section.querySelector(".f-sens-entree");
  if (sensSelect && sensSelect.disabled && info.sensEntree !== undefined) sensSelect.value = String(info.sensEntree);

  const parts = [
    `Entrée ${comp.entree} ${sensLabel(info.sensEntree)} → sortie ${comp.sortie} ${sensLabel(info.sensSortie)}` +
      (info.nMeshes === null ? "" : ` (${info.nMeshes} engrènement${info.nMeshes > 1 ? "s" : ""}, ${info.totalIdlers} renvoi${info.totalIdlers > 1 ? "s" : ""}).`),
  ];
  if (info.autoApplied) parts.push(`Un renvoi a été ajouté automatiquement sur ${baseMeshLabel(info.autoMesh)} pour obtenir le sens de sortie demandé.`);
  if (!info.satisfied) parts.push(`Le sens de sortie demandé ne peut pas être obtenu (aucun engrènement sur le chemin entrée → sortie).`);

  el.textContent = parts.join(" ");
  el.classList.toggle("alert", !info.satisfied);
}

// ------------------------------------------------------------------
// Mobiles a centre protege (global)
// ------------------------------------------------------------------

function isProtected(name) {
  if (state.protectedOverrides.has(name)) return state.protectedOverrides.get(name);
  const owner = ownerOf(comps(), name);
  return !!owner && globalName(owner, owner.sortie) === name;
}

function renderProtectedTable() {
  const body = document.getElementById("protected-body");
  const train = buildGlobalTrain(comps(), {}, state.analysis?.effective ?? {});
  body.innerHTML = "";
  for (const [name, wheel] of train.wheels) {
    // pseudo-mobiles (cage, enveloppe balayee, came) : pas de denture, donc
    // pas de centre a proteger
    if (!wheel.teeth) continue;
    const tr = document.createElement("tr");
    tr.dataset.name = name;
    tr.innerHTML = `<td>${name}</td><td class="center"><input type="checkbox" class="protected-check" ${isProtected(name) ? "checked" : ""} /></td>`;
    tr.querySelector("input").addEventListener("change", (e) => {
      state.protectedOverrides.set(name, e.target.checked);
      schedulePlacement();
    });
    body.appendChild(tr);
  }
}

function readProtectedWheels(train) {
  return [...train.wheels.keys()].filter(isProtected);
}

// ------------------------------------------------------------------
// Placement geometrique
// ------------------------------------------------------------------

function setStatus(text, kind) {
  const el = document.getElementById("status-text");
  el.textContent = text;
  el.className = `status-text ${kind || ""}`;
}

function renderLegend(train) {
  const legend = document.getElementById("legend");
  legend.innerHTML = "";
  let i = 0;
  for (const [group, names] of train.axisGroups()) {
    const swatch = WHEEL_PALETTE[i % WHEEL_PALETTE.length];
    const span = document.createElement("span");
    span.innerHTML = `<span class="swatch" style="background:${swatch}"></span>${group} (${names.join(", ")})`;
    legend.appendChild(span);
    i++;
  }
}

function renderConflicts(conflicts) {
  const panel = document.getElementById("panel-conflicts");
  const list = document.getElementById("conflicts-list");

  if (conflicts.length === 0) {
    panel.hidden = true;
    list.innerHTML = "";
    return;
  }

  panel.hidden = false;
  list.innerHTML = "";

  conflicts.forEach((c) => {
    const row = document.createElement("div");
    row.className = "empty-note";
    row.style.color = "var(--alert)";

    if (c.kind === "position") {
      row.textContent = c.message;
    } else if (c.kind === "niveaux") {
      row.innerHTML = `L'axe <strong>${c.group}</strong> porte ${c.needed} roues à des hauteurs différentes (${c.wheels.join(", ")}) : il faut au moins ${c.needed} niveaux.`;
    } else if (c.kind === "platine") {
      row.innerHTML = `<strong>${c.wheel}</strong> mesure ${(2 * c.radius).toFixed(
        2
      )} mm de diamètre, la platine ${(2 * c.plateRadius).toFixed(
        2
      )} mm : ce mobile ne peut tenir dessus quel que soit le placement. Agrandis la platine, réduis le module ou le nombre de dents.`;
    } else if (c.kind === "entraxe") {
      row.innerHTML = `<strong>${c.wheelA}</strong> et <strong>${c.wheelB}</strong> relient les mêmes deux axes : leurs entraxes doivent être égaux, or ils valent ${c.required.toFixed(
        3
      )} mm et ${c.distance.toFixed(3)} mm. Dans un train revertant, m₁·(Z+Z) = m₂·(Z+Z) — choisis un autre candidat de dents, ou élargis la plage de modules pour qu'un couple compatible existe.`;
    } else if (c.kind === "recouvrement") {
      const manque = (c.required - c.distance).toFixed(3);
      row.innerHTML = `<strong>${c.wheelA}</strong> (centre protégé) est recouverte par <strong>${c.wheelB}</strong> quel que soit le niveau — entraxe ${c.distance.toFixed(2)} mm, il en faudrait ${c.required.toFixed(2)} mm (manque ${manque} mm). Écarte les dentures, change de module, ajoute un renvoi, ou décoche la protection de ${c.wheelA} si un pont est acceptable ici.`;
    } else {
      const manque = (c.required - c.distance).toFixed(3);
      row.innerHTML = `<strong>${c.wheelA}</strong> ↔ <strong>${c.wheelB}</strong> sont forcément au même niveau (même engrènement) et se touchent — entraxe ${c.distance.toFixed(2)} mm, il en faudrait ${c.required.toFixed(2)} mm (manque ${manque} mm).`;
    }
    list.appendChild(row);
  });
}

/**
 * Plafond du nombre de sequences de modules reellement evaluees. Chaque
 * evaluation reconstruit le train et lance un placement complet : a quatre
 * etages et sur une plage de modules large, C(m + k - 1, k) depasse la
 * dizaine de milliers et l'interface gelerait plusieurs minutes.
 */
const MAX_MODULE_SEQUENCES = 400;

/** Sous-echantillonnage regulier, pour borner un balayage exhaustif. */
function capCandidates(list, limit) {
  if (list.length <= limit) return list;
  const step = list.length / limit;
  return Array.from({ length: limit }, (_, i) => list[Math.floor(i * step)]);
}

function monotonicSequences(steps, length, nonIncreasing) {
  const results = [];
  function rec(remainingLength, lastIdx, chosen) {
    if (remainingLength === 0) {
      results.push(chosen.slice());
      return;
    }
    const range = nonIncreasing
      ? Array.from({ length: lastIdx + 1 }, (_, i) => i)
      : Array.from({ length: steps.length - lastIdx }, (_, i) => lastIdx + i);
    for (const idx of range) {
      chosen.push(steps[idx]);
      rec(remainingLength - 1, idx, chosen);
      chosen.pop();
    }
  }
  rec(length, nonIncreasing ? steps.length - 1 : 0, []);
  return results;
}

/**
 * Score d'un placement, par ordre d'importance decroissante :
 *   1. conflits structurels (aucun placement possible)
 *   2. niveaux utilises      -- un mouvement plat vaut mieux qu'un epais
 *   3. arbres recouverts     -- chacun coute un pont
 *   4. rayon englobant       -- la compacite ne departage qu'a la fin
 * Le rayon vient en DERNIER : tant qu'il reste de la place sur la platine,
 * l'occuper ne coute rien, alors qu'un pont ou une hauteur se paient.
 */
const NO_LAYOUT_SCORE = [0, Infinity, Infinity, Infinity];

function evaluateTrain(train, options) {
  const placer = new Placer(train, options);
  const conflicts = placer.diagnoseFixedConflicts();
  if (conflicts.length) return { conflicts, layout: null, placer, score: [conflicts.length, Infinity, Infinity, Infinity] };
  const layout = placer.place();
  return {
    conflicts,
    layout,
    placer,
    score: layout ? [0, layout.levelCount, layout.coveredAxes, layout.score] : NO_LAYOUT_SCORE,
  };
}

/** Comparaison lexicographique des vecteurs de score. */
function betterScore(a, b) {
  const n = Math.max(a.length, b.length);
  for (let i = 0; i < n; i++) {
    const x = a[i] ?? 0;
    const y = b[i] ?? 0;
    if (x !== y) return x < y;
  }
  return false;
}

function isSolved(score) {
  return score[0] === 0 && score.every((v) => Number.isFinite(v));
}

/**
 * Complications actives : celles qui ont un candidat selectionne ET dont
 * la roue motrice (si raccordees) appartient a une complication active.
 */
function activeComplications(all) {
  const active = [];
  for (const comp of all) {
    if (!comp.selected) continue;
    if (comp.link.kind !== "none") {
      const owner = ownerOf(all, comp.link.wheel);
      if (!owner || !active.includes(owner)) continue;
    }
    active.push(comp);
  }
  return active;
}

/**
 * Choisit, pour une complication, le module de chaque engrenement de base
 * (monotone le long du chemin entree->sortie : plus grand cote couple
 * eleve) puis les dents de ses roues de renvoi, en evaluant a chaque fois
 * le placement du train CUMULE (complications precedentes deja fixees).
 * Les modules classiques (0.1, 0.2, 0.25, 0.3, 0.5…) sont essayes en
 * premier ; une grille plus fine n'est exploree que s'ils ne suffisent pas.
 */
function planComplication(active, comp, specs, effective, options, moduleMin, moduleMax) {
  const k = active.indexOf(comp);
  const prefix = active.slice(0, k);
  const cand = comp.selected;
  const allKeys = baseMeshKeys(comp);
  const pathKeys = pathBaseMeshKeys(comp);
  const prefixTrain = buildGlobalTrain(prefix, specs, effective);

  // entree engrenee sur / egale a une roue motrice : module impose sur son engrenement de base
  let fixedKey = null;
  let fixedModule = null;
  if (["mesh", "shared"].includes(comp.link.kind) && prefixTrain.wheels.has(comp.link.wheel)) {
    fixedKey = baseMeshOfLocal(comp, comp.entree);
    fixedModule = prefixTrain.wheels.get(comp.link.wheel).module;
  }

  const nonIncreasing = cand.ratio >= 1;
  const offPathDefault = nearestStandardModule((moduleMin + moduleMax) / 2, moduleMin, moduleMax);
  const makeSpec = (moduleByMesh, idlerTeeth) => ({ teeth: cand.teethByLocal, moduleByMesh, idlerTeeth });
  const evaluateSpec = (spec) => evaluateTrain(buildGlobalTrain([...prefix, comp], { ...specs, [comp.id]: spec }, effective), options).score;

  const withFixed = (steps) => {
    if (fixedModule !== null && !steps.some((s) => Math.abs(s - fixedModule) < 1e-9)) return [...steps, fixedModule].sort((a, b) => a - b);
    return steps;
  };

  const searchModules = (steps) => {
    let sequences = pathKeys.length ? monotonicSequences(steps, pathKeys.length, nonIncreasing) : [[]];
    const fixedIdx = fixedKey ? pathKeys.indexOf(fixedKey) : -1;
    if (fixedIdx >= 0) {
      const filtered = sequences.filter((seq) => Math.abs(seq[fixedIdx] - fixedModule) < 1e-9);
      if (filtered.length) sequences = filtered;
    }
    sequences = capCandidates(sequences, MAX_MODULE_SEQUENCES);
    let best = null;
    let bestScore = [Infinity, Infinity, Infinity, Infinity];
    for (const seq of sequences) {
      const moduleByMesh = {};
      allKeys.forEach((key) => (moduleByMesh[key] = offPathDefault));
      pathKeys.forEach((key, i) => (moduleByMesh[key] = seq[i]));
      if (fixedKey) moduleByMesh[fixedKey] = fixedModule;
      const spec = makeSpec(moduleByMesh, {});
      const score = evaluateSpec(spec);
      if (best === null || betterScore(score, bestScore)) {
        bestScore = score;
        best = spec;
      }
    }
    return { best, bestScore };
  };

  /**
   * Train revertant strict : les modules ne se choisissent pas librement,
   * ils doivent egaliser les deux entraxes. Les couples utilisables sont
   * enumeres une fois pour toutes (modules egaux en tete), et l'on ne juge
   * plus que la compacite du placement.
   */
  const searchRevertedModules = () => {
    const [k1, k2] = allKeys;
    const quality = twinMeshQuality(comp, cand.teethByLocal, moduleMin, moduleMax, { arborRadius: arborRadius() });
    let pairs = quality ? quality.pairs : [];
    if (fixedKey && pairs.length) {
      const side = fixedKey === k1 ? "m1" : "m2";
      const filtered = pairs.filter((p) => Math.abs(p[side] - fixedModule) < 1e-9);
      if (filtered.length) pairs = filtered;
    }
    // aucun couple valide : on retombe sur un module unique, et la
    // divergence d'entraxe sera signalee comme conflit par le placeur
    if (!pairs.length) pairs = [{ m1: offPathDefault, m2: offPathDefault }];

    let best = null;
    let bestScore = [Infinity, Infinity, Infinity, Infinity];
    for (const pair of pairs.slice(0, MAX_MODULE_SEQUENCES)) {
      const spec = makeSpec({ [k1]: pair.m1, [k2]: pair.m2 }, {});
      const score = evaluateSpec(spec);
      if (best === null || betterScore(score, bestScore)) {
        bestScore = score;
        best = spec;
      }
    }
    return { best, bestScore };
  };

  let best;
  let bestScore;
  if (hasTwinMeshConstraint(comp, effective[comp.id])) {
    ({ best, bestScore } = searchRevertedModules());
  } else {
    // passe 1 : modules classiques ; passe 2 : grille fine si rien de satisfaisant
    let standard = withFixed(standardModulesIn(moduleMin, moduleMax));
    if (!standard.length) standard = withFixed([moduleMin, moduleMax]);
    ({ best, bestScore } = searchModules(standard));
    if (!isSolved(bestScore)) {
      const nSteps = 10;
      const grid = Array.from({ length: nSteps }, (_, i) => moduleMin + (i * (moduleMax - moduleMin)) / (nSteps - 1));
      const fine = withFixed([...new Set([...grid, ...standard].map((v) => snapModule(v)))].sort((a, b) => a - b));
      const second = searchModules(fine);
      if (betterScore(second.bestScore, bestScore)) ({ best, bestScore } = second);
    }
  }

  // dents des roues de renvoi (sans effet sur le ratio) : on garde la valeur
  // qui donne le placement le plus compact / le moins conflictuel
  const trainNow = buildGlobalTrain([...prefix, comp], { ...specs, [comp.id]: best }, effective);
  const idlers = [...trainNow.wheelMeta].filter(([, m]) => m.compId === comp.id && m.kind === "renvoi").map(([name, m]) => ({ name, cfg: comp.idlers[m.baseMesh] }));
  const idlerTeeth = {};
  for (const { name, cfg } of idlers) {
    const lo = Math.min(cfg.min, cfg.max);
    const hi = Math.max(cfg.min, cfg.max);
    const mid = Math.round((lo + hi) / 2);
    let bestZ = mid;
    const values = [...new Set(Array.from({ length: 5 }, (_, i) => Math.round(lo + (i * (hi - lo)) / 4)))].filter((z) => z !== mid);
    for (const z of values) {
      const score = evaluateSpec(makeSpec(best.moduleByMesh, { ...idlerTeeth, [name]: z }));
      if (betterScore(score, bestScore)) {
        bestScore = score;
        bestZ = z;
      }
    }
    idlerTeeth[name] = bestZ;
  }

  return makeSpec(best.moduleByMesh, idlerTeeth);
}

function renderModulesInfo(active, train) {
  const el = document.getElementById("modules-info");
  el.innerHTML = active
    .flatMap((comp) =>
      localBaseMeshes(comp).map((pair) => {
        const m = train.wheels.get(resolveLocal(comp, pair[0])).module;
        return `<span><span class="swatch" style="background:#8b8578"></span>${comp.label} ${pair[0]}↔${pair[1]} : ${formatModule(m)} mm</span>`;
      })
    )
    .join("");
}

function renderSensInfo(active, senses) {
  const el = document.getElementById("sens-info");
  el.innerHTML = active
    .map((comp) => {
      const e = senses.get(resolveLocal(comp, comp.entree));
      const s = senses.get(globalName(comp, comp.sortie));
      return `<span><strong>${comp.label}</strong> : ${comp.entree} ${SENS_GLYPHS[e] ?? "?"} → ${comp.sortie} ${SENS_GLYPHS[s] ?? "?"}</span>`;
    })
    .join("");
}

function marksFor(active) {
  const marks = new Map();
  for (const comp of active) {
    const e = resolveLocal(comp, comp.entree);
    const s = globalName(comp, comp.sortie);
    if (e === s) marks.set(e, { tag: `E/S ${comp.label}`, color: "#7a4c6f" });
    else {
      if (!marks.has(e)) marks.set(e, { tag: `ENTRÉE ${comp.label}`, color: "#2f6f4a" });
      marks.set(s, { tag: `SORTIE ${comp.label}`, color: "#9c3b34" });
    }
  }
  return marks;
}

/**
 * Aiguilles indicatrices : une par sortie de complication. Purement
 * indicatif -- rien dans le calcul n'en depend -- mais c'est ce qui rend
 * l'animation lisible : on voit la sortie avancer, et a quelle allure.
 *
 * La longueur suit l'encombrement du mobile qui la porte, bornee par
 * rapport a la platine pour rester visible sur une petite roue sans
 * traverser tout le mouvement sur une grande.
 */
function handsFor(active, train, plateRadius) {
  const hands = new Map();
  for (const comp of active) {
    if (comp.collapsed && !comp.drawWhenCollapsed) continue;
    const name = globalName(comp, comp.sortie);
    const wheel = train.wheels.get(name);
    if (!wheel) continue;

    // une cage n'a pas de denture : on prend l'encombrement des planetaires
    // qu'elle porte comme reference
    let reference = wheel.outerRadius;
    if (wheel.carrier) {
      const block = (train.epicyclicBlocks ?? []).find((b) => b.carrier === name);
      const members = block ? [block.planetA, block.planetB] : [];
      reference = Math.max(0, ...members.map((n) => train.wheels.get(n)?.outerRadius ?? 0));
    }
    const lengthMm = Math.min(0.45 * plateRadius, Math.max(0.15 * plateRadius, 1.8 * reference));
    hands.set(name, { lengthMm, label: comp.label });
  }
  return hands;
}

/** Cages qui portent le galet d'une came : nom de la cage -> rayon du galet. */
function carrierRollersFor(active) {
  const rollers = new Map();
  for (const comp of active) {
    const cam = comp.cam;
    if (!cam?.enabled || cam.drives !== "porte-satellites" || !cam.carrierTarget) continue;
    rollers.set(`${cam.carrierTarget}.porte_satellites`, {
      radius: Math.max(0.15, cam.rollerRadius || 0.3),
      armLength: cam.leverLength,
    });
  }
  return rollers;
}

function stylesFor(active) {
  const styles = new Map();
  for (const comp of active) {
    if (!comp.collapsed) continue;
    const style = comp.drawWhenCollapsed ? "dim" : "hidden";
    for (const local of ownLocalWheelNames(comp)) styles.set(globalName(comp, local), style);
    baseMeshKeys(comp).forEach((key, idx) => {
      for (let j = 0; j < 3; j++) styles.set(idlerName(comp, idx, j), style);
    });
  }
  return styles;
}

function fixedPositionsFor(active) {
  const fixed = new Map();
  const markers = [];
  for (const comp of active) {
    for (const role of ["entree", "sortie"]) {
      const pos = comp.fixed[role];
      if (!pos) continue;
      const name = role === "entree" ? resolveLocal(comp, comp.entree) : globalName(comp, comp.sortie);
      fixed.set(name, pos);
      markers.push({ name, x: pos.x, y: pos.y });
    }
  }
  return { fixed, markers };
}

let placementTimer = null;
function schedulePlacement() {
  clearTimeout(placementTimer);
  setStatus("Calcul en cours…", "");
  placementTimer = setTimeout(() => {
    try {
      runPlacement();
    } catch (err) {
      console.error(err);
      setStatus(`Erreur : ${err.message}`, "error");
    }
  }, 20);
}

/**
 * Point de passage unique du rendu : redessine le dernier placement sans
 * le recalculer (repli d'une complication, zoom). Les regles sont
 * regenerees a la meme echelle que le dessin -- sinon leurs graduations
 * mentiraient des le premier coup de molette.
 */
function redrawOnly() {
  const last = state.lastRender;
  const scale = viewScale();
  const plateRadius = last ? last.plateRadius : state.lastPlateRadius;
  const sideLengthMm = (plateRadius + MARGIN) * 2;

  document.getElementById("ruler-top").innerHTML = buildRulerSVG(sideLengthMm, scale, "horizontal");
  document.getElementById("ruler-left").innerHTML = buildRulerSVG(sideLengthMm, scale, "vertical");
  const zoomLabel = document.getElementById("zoom-value");
  if (zoomLabel) zoomLabel.textContent = `${scale < 10 ? scale.toFixed(1) : scale.toFixed(0)} px/mm`;

  document.getElementById("drawing-area").innerHTML = renderTrainSVG(
    last ? last.train : new GearTrain(),
    last ? last.layout : null,
    plateRadius,
    { x: 0, y: 0 },
    scale,
    MARGIN,
    last ? { ...last.options, styles: stylesFor(last.active), hands: state.showHands ? last.options.hands : new Map() } : {}
  ).svgMarkup;
}

// ------------------------------------------------------------------
// Zoom et deplacement dans la zone de dessin
// ------------------------------------------------------------------

function clampScale(v) {
  return Number.isFinite(v) ? Math.min(MAX_SCALE, Math.max(MIN_SCALE, v)) : viewScale();
}

/**
 * Change l'echelle en gardant fixe le point du dessin situe sous
 * (clientX, clientY), le centre de la zone visible a defaut. L'epaisseur
 * des regles est constante : elle s'annule dans la difference, il suffit
 * donc de raisonner par rapport au coin du dessin.
 */
function zoomTo(next, clientX, clientY) {
  const frame = document.querySelector(".ruled-frame");
  const area = document.getElementById("drawing-area");
  const prev = viewScale();
  const scale = clampScale(next);
  if (Math.abs(scale - prev) < 1e-9) return;

  const areaRect = area.getBoundingClientRect();
  const frameRect = frame.getBoundingClientRect();
  const ax = (clientX ?? frameRect.left + frame.clientWidth / 2) - areaRect.left;
  const ay = (clientY ?? frameRect.top + frame.clientHeight / 2) - areaRect.top;

  state.view.scale = scale;
  redrawOnly();

  const f = scale / prev;
  frame.scrollLeft += ax * (f - 1);
  frame.scrollTop += ay * (f - 1);
}

/** Echelle qui fait tenir toute la platine dans la zone visible. */
function zoomToFit() {
  const frame = document.querySelector(".ruled-frame");
  const plateRadius = state.lastRender ? state.lastRender.plateRadius : state.lastPlateRadius;
  const sideMm = (plateRadius + MARGIN) * 2;
  if (!(sideMm > 0)) return;
  const rulerW = document.getElementById("ruler-left").offsetWidth || 22;
  const rulerH = document.getElementById("ruler-top").offsetHeight || 22;
  const avail = Math.min(frame.clientWidth - rulerW, frame.clientHeight - rulerH) - 4;
  state.view.scale = clampScale(avail / sideMm);
  redrawOnly();
  frame.scrollLeft = 0;
  frame.scrollTop = 0;
}

// ------------------------------------------------------------------
// Mode animation
// ------------------------------------------------------------------

/**
 * Vitesse d'entree de chaque complication non raccordee : en tours par
 * heure quand elle est connue (mode vitesses), 1 sinon. En mode ratio
 * direct deux complications independantes n'ont aucune echelle de temps
 * commune -- rien ne permet de la deviner, on ne la pretend donc pas.
 */
function velocityRoots(active) {
  const roots = new Map();
  for (const comp of active) {
    // un membre immobilise tourne a vitesse nulle : c'est la seconde
    // inconnue dont la formule de Willis a besoin
    if (comp.topology === "epicyclic" && comp.fixedMember && comp.fixedMember !== "none") {
      roots.set(globalName(comp, EPICYCLIC_MEMBERS[comp.fixedMember]), 0);
    }
    // Un differentiel n'a pas UNE entree : la formule de Willis reclame
    // deux membres connus pour donner le troisieme. Les deux planetaires
    // sont donc tous deux des racines -- sans quoi la cage reste sans
    // vitesse et le bras ne bouge pas.
    if (comp.topology === "epicyclic" && comp.fixedMember === "none") {
      const wA = signedTurnsPerHour(comp.diff.a);
      const wB = signedTurnsPerHour(comp.diff.b);
      if (Number.isFinite(wA) && Number.isFinite(wB)) {
        roots.set(globalName(comp, "planetaire_a"), wA);
        roots.set(globalName(comp, "planetaire_b"), wB);
      }
      continue;
    }
    if (comp.link.kind !== "none" && comp.link.wheel) continue;
    const known = comp.ratioMode === "speeds" ? toTurnsPerHour(comp.speedIn.value, comp.speedIn.unit) : NaN;
    const magnitude = Number.isFinite(known) && known !== 0 ? Math.abs(known) : 1;
    roots.set(globalName(comp, comp.entree), magnitude * comp.sensEntree);
  }
  return roots;
}

/** Toutes les entrees libres ont-elles une vitesse reelle renseignee ? */
function allSpeedsKnown(active) {
  return active
    .filter((c) => c.link.kind === "none" || !c.link.wheel)
    .every((c) => {
      // un differentiel se pose directement en vitesses reelles
      if (c.topology === "epicyclic" && c.fixedMember === "none") {
        return [c.diff.a, c.diff.b].every((s) => Number.isFinite(signedTurnsPerHour(s)));
      }
      return c.ratioMode === "speeds" && Number.isFinite(toTurnsPerHour(c.speedIn.value, c.speedIn.unit));
    });
}

function maxAbsVelocity() {
  const last = state.lastRender;
  if (!last || !last.velocities) return 0;
  let m = 0;
  for (const v of last.velocities.values()) m = Math.max(m, Math.abs(v));
  return m;
}

function animationSpeed() {
  const v = parseFloat(document.getElementById("anim-speed").value);
  return Number.isFinite(v) && v > 0 ? v : 0.2;
}

/**
 * Rappelle a quelle duree reelle correspond une seconde d'animation. Les
 * vitesses d'un mouvement s'etalent sur des ordres de grandeur enormes
 * (cage de tourbillon contre disque de lune) : sans compression du temps,
 * tout sauf le mobile le plus rapide paraitrait fige.
 */
function updateAnimScale() {
  const el = document.getElementById("anim-scale");
  if (!el) return;
  const maxAbs = maxAbsVelocity();
  if (!maxAbs || !state.lastRender) {
    el.textContent = "—";
    return;
  }
  el.textContent = state.lastRender.speedsKnown
    ? `1 s ≈ ${formatPeriod(maxAbs / animationSpeed())}`
    : "échelle de temps arbitraire";
}

/**
 * Pose la rotation de chaque mobile pour l'instant `t` (s depuis le depart).
 *
 * Un satellite de train epicycloidal a DEUX mouvements : il tourne sur son
 * arbre et il est emporte par la cage autour de l'axe central. En SVG les
 * transformations s'appliquent de gauche a droite comme changements de
 * repere : `rotate(cage, centre) rotate(spin, satellite)` fait donc tourner
 * le satellite sur lui-meme, puis emporte le tout autour du centre. Comme
 * la rotation d'orbite ajoute deja `cage` a l'orientation absolue, le spin
 * a poser est la vitesse RELATIVE a la cage -- sans quoi le satellite
 * tournerait une fois de trop par tour d'orbite.
 */
function animateFrame(t) {
  const last = state.lastRender;
  if (!last || !last.velocities) return;
  const maxAbs = maxAbsVelocity();
  if (!maxAbs) return;
  const k = (animationSpeed() / maxAbs) * 360;
  const angle = (name) => {
    const v = last.velocities.get(name);
    return v === undefined ? undefined : v * k * t;
  };

  /**
   * Angle d'une cage. Menee, c'est sa vitesse ; POSEE par une came, c'est
   * l'ecart de contact a l'instant courant -- une oscillation, pas une
   * rotation. Le miroir du placement inverse le sens du debattement.
   */
  const carrierAngle = (name) => {
    const driven = last.carrierDriven?.get(name);
    if (!driven) return angle(name);
    const cam = last.cams?.get(driven.camName);
    const turn = angle(driven.camName);
    if (!cam || turn === undefined) return angle(name);
    const state = camLeverState(cam, turn);
    if (!state) return angle(name);
    const swing = state.leverAngle - driven.startAngle;
    return driven.mirror ? -swing : swing;
  };

  for (const el of document.querySelectorAll("#drawing-area [data-wheel]")) {
    const spin = angle(el.dataset.wheel);
    if (spin === undefined) continue;
    const carrier = el.dataset.orbit;
    const orbit = carrier ? carrierAngle(carrier) : undefined;
    el.setAttribute(
      "transform",
      orbit === undefined
        ? `rotate(${spin.toFixed(2)} ${el.dataset.cx} ${el.dataset.cy})`
        : `rotate(${orbit.toFixed(2)} ${el.dataset.ocx} ${el.dataset.ocy}) rotate(${(spin - orbit).toFixed(2)} ${el.dataset.cx} ${el.dataset.cy})`
    );
  }

  // le bras de la cage tourne autour de l'axe central
  for (const el of document.querySelectorAll("#drawing-area [data-carrier]")) {
    const orbit = carrierAngle(el.dataset.carrier);
    if (orbit === undefined) continue;
    el.setAttribute("transform", `rotate(${orbit.toFixed(2)} ${el.dataset.cx} ${el.dataset.cy})`);
  }

  // Leviers de came : ils PIVOTENT autour d'un point fixe, et c'est leur
  // angle qui porte l'information -- de quoi entrer dans un differentiel.
  for (const el of document.querySelectorAll("#drawing-area [data-lever]")) {
    const cam = last.cams?.get(el.dataset.lever);
    const turn = angle(el.dataset.lever);
    if (!cam || turn === undefined) continue;
    const state = camLeverState(cam, turn);
    if (!state) continue;
    const swing = state.leverAngle - parseFloat(el.dataset.a0);
    el.setAttribute("transform", `rotate(${swing.toFixed(3)} ${el.dataset.px} ${el.dataset.py})`);
    const readout = document.querySelector(`#drawing-area [data-cam-readout="${el.dataset.lever}"]`);
    const profile = CAM_PROFILES[cam.profileId];
    if (readout && profile) readout.textContent = profile.format(camValueAt(cam, state.index));
  }

  // Palpeurs lineaires : ils ne tournent pas, ils MONTENT ET DESCENDENT.
  const scale = viewScale();
  for (const el of document.querySelectorAll("#drawing-area [data-follower]")) {
    const cam = last.cams?.get(el.dataset.follower);
    const turn = angle(el.dataset.follower);
    if (!cam || turn === undefined) continue;
    const idx = camSampleIndex(cam, turn);
    const radius = cam.baseRadius + cam.amplitude * cam.samples.normalized[idx];
    const travel = (radius - parseFloat(el.dataset.r0)) * scale;
    el.setAttribute(
      "transform",
      `translate(${(travel * parseFloat(el.dataset.dx)).toFixed(2)} ${(travel * parseFloat(el.dataset.dy)).toFixed(2)})`
    );
    const readout = document.querySelector(`#drawing-area [data-cam-readout="${el.dataset.follower}"]`);
    const profile = CAM_PROFILES[cam.profileId];
    if (readout && profile) readout.textContent = profile.format(camValueAt(cam, idx));
  }
}

function stopAnimation() {
  if (state.animation.raf) cancelAnimationFrame(state.animation.raf);
  state.animation.raf = null;
  const btn = document.getElementById("btn-animate");
  if (btn) btn.textContent = "▶ animer";
}

function toggleAnimation() {
  if (state.animation.raf) return stopAnimation();
  document.getElementById("btn-animate").textContent = "■ arrêter";
  // l'angle se deduit du temps ECOULE, jamais cumule image par image : un
  // redessin en cours d'animation ne provoque donc aucun saut
  state.animation.t0 = performance.now();
  const step = (now) => {
    animateFrame((now - state.animation.t0) / 1000);
    state.animation.raf = requestAnimationFrame(step);
  };
  state.animation.raf = requestAnimationFrame(step);
}

function setupCanvasView() {
  const frame = document.querySelector(".ruled-frame");
  if (!frame) return;

  document.getElementById("btn-animate").addEventListener("click", toggleAnimation);
  const handsBox = document.getElementById("chk-hands");
  if (handsBox) {
    handsBox.checked = state.showHands;
    handsBox.addEventListener("change", (e) => {
      state.showHands = e.target.checked;
      redrawOnly();
    });
  }
  document.getElementById("anim-speed").addEventListener("input", updateAnimScale);

  document.getElementById("btn-zoom-in").addEventListener("click", () => zoomTo(viewScale() * 1.25));
  document.getElementById("btn-zoom-out").addEventListener("click", () => zoomTo(viewScale() / 1.25));
  document.getElementById("btn-zoom-fit").addEventListener("click", zoomToFit);

  // molette = zoom ; passive:false car il faut annuler le defilement natif
  frame.addEventListener(
    "wheel",
    (e) => {
      e.preventDefault();
      zoomTo(viewScale() * Math.exp(-e.deltaY * 0.0015), e.clientX, e.clientY);
    },
    { passive: false }
  );

  // glisser pour deplacer -- desactive pendant "placer par clic", ou le
  // clic sert justement a poser une position imposee
  let drag = null;
  frame.addEventListener("pointerdown", (e) => {
    if (state.placing || e.button !== 0) return;
    drag = { x: e.clientX, y: e.clientY, sl: frame.scrollLeft, st: frame.scrollTop };
    frame.setPointerCapture(e.pointerId);
    frame.classList.add("panning");
  });
  frame.addEventListener("pointermove", (e) => {
    if (!drag) return;
    frame.scrollLeft = drag.sl - (e.clientX - drag.x);
    frame.scrollTop = drag.st - (e.clientY - drag.y);
  });
  const endDrag = (e) => {
    if (!drag) return;
    drag = null;
    frame.classList.remove("panning");
    if (frame.hasPointerCapture && frame.hasPointerCapture(e.pointerId)) frame.releasePointerCapture(e.pointerId);
  };
  frame.addEventListener("pointerup", endDrag);
  frame.addEventListener("pointercancel", endDrag);
}

/**
 * Cames qui poussent un porte-satellites : leur course angulaire n'est pas
 * un reglage libre, elle DECOULE de la correction voulue sur la roue de
 * sortie et du rapport de base du train epicycloidal vise. On la recalcule
 * donc avant chaque construction, une fois les dents connues.
 */
function syncCarrierCams(all) {
  for (const comp of all) {
    const cam = comp.cam;
    if (!cam?.enabled || cam.followerType !== "angulaire" || cam.drives !== "porte-satellites") continue;
    const target = all.find((c) => c.label === cam.carrierTarget && c.topology === "epicyclic");
    const basicRatio = target?.selected?.basicRatio;
    const samples = camProfileSamples(cam.profile, cam.latitude);
    if (!samples || !Number.isFinite(basicRatio)) continue;
    const need = carrierSwingForCorrection(samples.max - samples.min, cam.correctedTurnHours, basicRatio);
    if (need) cam.swingAngle = need.carrierDegrees;
  }
}

function runPlacement() {
  const all = comps();
  normalizeAll(all);
  syncCarrierCams(all);
  state.analysis = analyzeTrainSenses(all);
  all.forEach(renderSensNote);
  all.forEach(renderCamNote);
  renderProtectedTable();

  const { min: moduleMin, max: moduleMax } = moduleRange();
  const plateDiameter = parseFloat(document.getElementById("plate-diameter").value);
  const plateRadius = plateDiameter / 2;
  const arbor = arborRadius();
  const angleStepDeg = parseFloat(document.getElementById("angle-step").value);
  const restarts = parseInt(document.getElementById("restarts").value, 10);
  const levels = Math.min(10, Math.max(1, parseInt(document.getElementById("levels").value, 10) || 2));
  state.lastPlateRadius = plateRadius;

  const active = activeComplications(all);
  if (active.length === 0) {
    setStatus("Aucun candidat sélectionné — lance une recherche de ratio.", "error");
    stopAnimation();
    state.lastRender = null;
    redrawOnly();
    updateAnimScale();
    document.getElementById("modules-info").innerHTML = "";
    document.getElementById("sens-info").innerHTML = "";
    document.getElementById("legend").innerHTML = "";
    document.getElementById("panel-conflicts").hidden = true;
    return;
  }

  const effective = state.analysis.effective;
  const templateAll = buildGlobalTrain(active, {}, effective);
  const protectedWheels = readProtectedWheels(templateAll);
  const { fixed, markers } = fixedPositionsFor(active);
  const baseOptions = {
    plateRadius,
    angleStepDeg,
    levels, // plafond : le placeur part du minimum et ne monte qu'en cas d'echec
    arborRadius: arbor,
    protectedWheels,
    fixedPositions: fixed,
    rootWheel: resolveLocal(active[0], active[0].entree),
  };

  // 1) modules et renvois, complication par complication (recherche rapide)
  const specs = {};
  for (const comp of active) {
    specs[comp.id] = planComplication(active, comp, specs, effective, { ...baseOptions, nRandomRestarts: Math.min(restarts, 40) }, moduleMin, moduleMax);
  }

  // 2) placement final du train global avec le nombre complet de redemarrages
  const train = buildGlobalTrain(active, specs, effective);
  // Entraxe reel du train epicycloidal vise par chaque came : il n'a de sens
  // que sur le train final, pas sur les gabarits parcourus par la recherche.
  for (const [name, wheel] of train.wheels) {
    if (!wheel.cam || wheel.cam.carrierArm === undefined) continue;
    const owner = ownerOf(all, name);
    if (owner) owner.cam.carrierArm = wheel.cam.carrierArm;
  }

  const senses = computeRotationSenses(train, senseRoots(active));
  const velocities = computeAngularVelocities(train, velocityRoots(active));
  state.velocities = velocities;

  // Une came se taille dans le sens ou elle tournera, et ce sens n'est connu
  // qu'ici. Le point de contact en depend, donc les entraxes qui en
  // decoulent aussi : on retaille, puis on refait les liaisons -- avant de
  // placer, sans quoi le placeur tiendrait des distances calculees sur un
  // profil qui n'est plus celui-la.
  let recut = false;
  for (const [name, wheel] of train.wheels) {
    if (!wheel.cam) continue;
    const v = velocities.get(name);
    const sense = Number.isFinite(v) && v < 0 ? -1 : 1;
    if (wheel.cam.direction !== sense) {
      wheel.cam.direction = sense;
      refreshCamGeometry(wheel.cam);
      recut = true;
    }
  }
  if (recut) {
    train.axisLinks.length = 0;
    linkCarrierCams(train, active);
  }
  // La note de came verifie la periode du mobile porteur : elle ne peut le
  // faire qu'une fois les vitesses connues, donc apres coup.
  all.forEach(renderCamNote);
  // Dans un differentiel, le sens de la cage est le signe d'une SOMME : les
  // signes seuls ne suffisent pas, il faut les grandeurs. Quand elles sont
  // connues, elles comblent ce que la propagation des sens a laissé vide.
  for (const [name, v] of velocities) {
    if (!senses.has(name) && Number.isFinite(v) && v !== 0) senses.set(name, v > 0 ? 1 : -1);
  }
  const speedsKnown = allSpeedsKnown(active);
  renderLegend(train);
  renderModulesInfo(active, train);
  renderSensInfo(active, senses);

  const placer = new Placer(train, { ...baseOptions, nRandomRestarts: restarts });
  const conflicts = placer.diagnoseFixedConflicts();
  renderConflicts(conflicts);

  const renderOptions = {
    marks: marksFor(active),
    senses,
    fixedMarkers: markers,
    rootWheel: baseOptions.rootWheel,
    arborRadius: arbor,
    hands: handsFor(active, train, plateRadius),
    carrierRollers: carrierRollersFor(active),
  };
  const draw = (layout) => {
    // les cames sont indexees a part : l'animation en a besoin a chaque
    // image pour savoir quel echantillon se presente au palpeur
    const cams = new Map();
    const carrierDriven = new Map();
    for (const [name, wheel] of train.wheels) {
      if (!wheel.cam) continue;
      cams.set(name, wheel.cam);
      // Cage POSEE par une came : sa position n'est pas une vitesse, c'est
      // une fonction du contact. L'animation doit la recalculer a chaque
      // image, sinon le bras reste fige -- la cage etant declaree bloquee,
      // sa vitesse est nulle.
      if (wheel.cam.drives !== "porte-satellites" || !wheel.cam.carrierTarget) continue;
      const start = camLeverState(wheel.cam, 0);
      const position = layout ? layout.positions.get(name) : null;
      if (!start || !position) continue;
      const placement = camDrawPlacement(wheel.cam, position, layout);
      carrierDriven.set(`${wheel.cam.carrierTarget}.porte_satellites`, {
        camName: name,
        startAngle: start.leverAngle,
        mirror: placement.mirror,
      });
    }
    state.lastRender = { train, layout, plateRadius, options: renderOptions, active, velocities, speedsKnown, cams, carrierDriven };
    redrawOnly();
    updateAnimScale();
  };

  const unsatisfied = active.filter((c) => state.analysis.info[c.id] && !state.analysis.info[c.id].satisfied).map((c) => c.label);
  const sensWarning = unsatisfied.length ? ` — sens de sortie non satisfait pour ${unsatisfied.join(", ")}` : "";

  if (conflicts.length > 0) {
    const kinds = {
      niveaux: conflicts.filter((c) => c.kind === "niveaux").length,
      position: conflicts.filter((c) => c.kind === "position").length,
      denture: conflicts.filter((c) => c.kind === "denture").length,
      recouvrement: conflicts.filter((c) => c.kind === "recouvrement").length,
      entraxe: conflicts.filter((c) => c.kind === "entraxe").length,
      platine: conflicts.filter((c) => c.kind === "platine").length,
    };
    const parts = [];
    if (kinds.platine) parts.push(`${kinds.platine} mobile(s) plus grand(s) que la platine`);
    if (kinds.entraxe) parts.push(`${kinds.entraxe} paire(s) qui n'engrènent pas (entraxes inégaux)`);
    if (kinds.niveaux) parts.push(`${kinds.niveaux} axe(s) demandant plus de niveaux`);
    if (kinds.position) parts.push(`${kinds.position} position(s) imposée(s) incohérente(s)`);
    if (kinds.denture) parts.push(`${kinds.denture} collision(s) de denture garantie(s)`);
    if (kinds.recouvrement) parts.push(`${kinds.recouvrement} recouvrement(s) de centre protégé`);
    setStatus(`${parts.join(", ")} (meilleur module testé) — voir le panneau ci-dessous.${sensWarning}`, "error");
    draw(null);
    return;
  }

  const layout = placer.place();
  if (!layout) {
    // Diagnostic par RELAXATION : on rejoue le meme placement sur des
    // platines de plus en plus grandes. Si l'une d'elles aboutit, c'est la
    // platine qui bloquait -- et l'on peut le dire avec un chiffre, au lieu
    // d'enumerer toutes les causes imaginables. Enumerer des causes quand
    // une seule est vraie fait perdre du temps.
    const roomyRadius = (() => {
      const attempt = (radius) => {
        // Le diagnostic n'a pas besoin du MEILLEUR placement, seulement de
        // savoir s'il en existe un : peu de redemarrages suffisent, et le
        // chemin d'echec doit rester rapide.
        const trial = new Placer(train, { ...baseOptions, plateRadius: radius, nRandomRestarts: Math.min(restarts, 30) });
        return trial.diagnoseFixedConflicts().length ? null : trial.place();
      };
      // 1) platine quasi illimitee : le placement est-il seulement possible ?
      const unbounded = attempt(Math.max(plateRadius * 20, 250));
      if (!unbounded) return null;
      // 2) resserrer, car sans contrainte le placeur privilegie les arbres
      //    degages sur la compacite et s'etale plus que necessaire
      let best = unbounded.score;
      for (const factor of [1.2, 1.5, 2, 3]) {
        const radius = plateRadius * factor;
        if (radius >= best) break;
        const found = attempt(radius);
        if (found) {
          best = found.score;
          break;
        }
      }
      return best;
    })();

    const hints = [];
    if (roomyRadius !== null && roomyRadius > plateRadius) {
      hints.push(
        `la platine est trop petite — ce rouage tient à partir d'environ ${(2 * roomyRadius).toFixed(
          1
        )} mm de diamètre, tu en demandes ${(2 * plateRadius).toFixed(1)}`
      );
    } else {
      hints.push(`essayé de ${placer.requiredLevels()} à ${levels} niveaux`);
      if (fixed.size) hints.push("les positions imposées sont peut-être incompatibles avec les entraxes");
      if (placer.classCount() > levels) {
        hints.push(
          `${placer.classCount()} groupes d'engrènement pour ${levels} niveaux au plus : certains partagent forcément une hauteur et se touchent à un entraxe imposé — relève le plafond de niveaux`
        );
      }
      hints.push("ou augmente les redémarrages, la platine, ou réduis le diamètre d'arbre");
    }
    setStatus(`Aucun placement trouvé (${hints.join(" ; ")}).${sensWarning}`, "error");
    draw(null);
    return;
  }

  const used = layout.levelCount;
  const free = layout.axisCount - layout.coveredAxes;
  const minimum = placer.requiredLevels();
  const levelNote =
    used > minimum
      ? `${used} niveaux (le minimum structurel de ${minimum} ne suffisait pas ; plafond ${levels})`
      : `${used} niveau${used > 1 ? "x" : ""} — le minimum possible`;
  setStatus(
    `Placement trouvé — ${free}/${layout.axisCount} arbres dégagés${
      layout.coveredAxes ? `, ${layout.coveredAxes} recouvert${layout.coveredAxes > 1 ? "s" : ""}` : ""
    }, ${levelNote}, rayon englobant ${layout.score.toFixed(3)} mm${sensWarning}`,
    unsatisfied.length ? "error" : "ok"
  );
  draw(layout);
}

// ------------------------------------------------------------------
// Evenements
// ------------------------------------------------------------------

document.addEventListener("DOMContentLoaded", () => {
  document.getElementById("btn-add-complication").addEventListener("click", addComplication);
  const assemblySelect = document.getElementById("assembly-select");
  if (assemblySelect) {
    assemblySelect.innerHTML =
      opt("", "— aucun —", true) + ASSEMBLY_LIBRARY.map((a) => opt(a.id, a.label, false)).join("");
    assemblySelect.addEventListener("change", (e) => {
      if (e.target.value) applyAssembly(e.target.value);
      else document.getElementById("assembly-note").textContent = "";
    });
  }
  document.getElementById("btn-place").addEventListener("click", schedulePlacement);
  // la plage de modules ne conditionne pas que le placement : dans un train
  // revertant elle decide quelles combinaisons de dents peuvent egaliser
  // les deux entraxes, donc les candidats eux-memes
  for (const id of ["module-min", "module-max"]) {
    document.getElementById(id).addEventListener("change", () => {
      comps()
        .filter((c) => c.topology === "reverted")
        .forEach((c) => searchRatio(c));
      schedulePlacement();
    });
  }

  // Le diametre d'arbre suit la platine tant que l'utilisateur ne l'a pas
  // fixe lui-meme : passer d'une montre a une pendule change l'echelle de
  // tout le mouvement, et laisser 0,75 mm sur une platine de 150 mm
  // donnerait des arbres invisibles.
  const arborField = document.getElementById("arbor-diameter");
  const plateField = document.getElementById("plate-diameter");
  arborField.value = defaultArborDiameter(parseFloat(plateField.value) || 30);
  arborField.addEventListener("input", () => {
    state.arborTouched = true;
  });
  plateField.addEventListener("input", () => {
    if (!state.arborTouched) arborField.value = defaultArborDiameter(parseFloat(plateField.value) || 30);
  });
  for (const id of ["arbor-diameter", "plate-diameter", "levels"]) {
    document.getElementById(id).addEventListener("change", schedulePlacement);
  }
  document.getElementById("drawing-area").addEventListener("click", onDrawingClick);
  setupCanvasView();
  document.addEventListener("keydown", (e) => {
    if (e.key === "Escape" && state.placing) setPlacingMode(null);
  });

  const first = createComplication();
  comps().push(first);
  renderAllComplicationPanels();
  searchRatio(first);
  schedulePlacement();
});
