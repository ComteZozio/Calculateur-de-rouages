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
  view: { scale: BASE_SCALE }, // echelle du dessin en px/mm (zoom)
  animation: { raf: null, t0: 0 },
};

/** Echelle courante du dessin, en px/mm (modifiee par le zoom). */
function viewScale() {
  return state.view.scale;
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
  return r >= 1e-4 && r < 1e6 ? String(parseFloat(r.toPrecision(9))) : r.toExponential(6);
}

/**
 * Rappel de la cible sous les champs : le ratio effectivement recherche,
 * et en mode vitesses la duree d'un tour de chaque cote -- c'est la forme
 * sous laquelle une complication se verifie (1 tour en 29,53 j).
 */
function ratioReadoutHTML(comp) {
  const target = effectiveRatio(comp);
  if (!Number.isFinite(target) || target <= 0) {
    return `<span class="alert">Cible indéterminée — vérifie les valeurs saisies.</span>`;
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
      return `<tr data-name="${n}">
        <td>${n}</td>
        <td><input type="number" class="bound-min" value="${b.min}" min="4" /></td>
        <td><input type="number" class="bound-max" value="${b.fixed ? b.min : b.max}" min="4" ${b.fixed ? "disabled" : ""} /></td>
        <td class="center"><input type="checkbox" class="bound-fixed" ${b.fixed ? "checked" : ""} /></td>
        <td class="center"><input type="checkbox" class="bound-internal" ${comp.internal[n] ? "checked" : ""} /></td>
        <td class="center"><input type="radio" name="entree-${comp.id}" value="${n}" ${n === comp.entree ? "checked" : ""} /></td>
        <td class="center"><input type="radio" name="sortie-${comp.id}" value="${n}" ${n === comp.sortie ? "checked" : ""} /></td>
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
        <div class="field">
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
        ${speedsMode
          ? speedField("speedIn", drivenLabel) + speedField("speedOut", "Vitesse sortie")
          : `<div class="field full">
              <label>${ratioLabel}</label>
              <input type="number" class="f-ratio" step="0.0001" value="${comp.ratio}" />
            </div>`}
      </div>
      <p class="empty-note ratio-readout">${ratioReadoutHTML(comp)}</p>
      <div class="field-row">
        <div class="field">
          <label>Topologie</label>
          <select class="f-topology">
            ${opt("compound", "Chaîne simple", comp.topology === "compound")}
            ${opt("reverted", "Sortie coaxiale", comp.topology === "reverted")}
          </select>
        </div>
        <div class="field" ${comp.topology === "reverted" ? 'style="visibility:hidden"' : ""}>
          <label>Nombre d'étages</label>
          <select class="f-stages">
            ${Array.from({ length: MAX_STAGES }, (_, i) => i + 1)
              .map((v) => opt(v, `${v} (${2 * v} mobiles)`, v === comp.stages))
              .join("")}
          </select>
        </div>
      </div>
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

  head.innerHTML = labels.map((l) => `<th>${l}</th>`).join("") + `<th>Ratio</th><th>Écart</th>`;
  body.innerHTML = "";
  note.hidden = !comp.searchNote;
  note.textContent = comp.searchNote;
  truncNote.hidden = !comp.truncated;

  comp.candidates.forEach((cand) => {
    const tr = document.createElement("tr");
    tr.className = "candidate-row" + (cand === comp.selected ? " selected" : "");
    tr.innerHTML = cand.teeth.map((z) => `<td>${z}</td>`).join("") + `<td>${cand.ratio.toFixed(5)}</td><td>${cand.error.toExponential(1)}</td>`;
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

function searchRatio(comp) {
  const all = comps();
  const k = all.indexOf(comp);
  normalizeAll(all);
  state.analysis = analyzeTrainSenses(all);

  const targetRatio = effectiveRatio(comp);
  if (!Number.isFinite(targetRatio) || targetRatio <= 0) {
    invalidateCandidates(comp);
    comp.searchNote =
      comp.ratioMode === "speeds"
        ? "Vitesses invalides : saisis deux valeurs non nulles."
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

  const outcome = findTrainForRatio(targetRatio, positions, { tol: comp.tol, maxResults: 10 });

  const found = outcome.results.map((r) => ({
    teeth: r.teeth.slice(0, names.length),
    teethByLocal: Object.fromEntries(names.map((l, i) => [l, r.teeth[i]])),
    ratio: r.ratio,
    error: r.error,
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
  comp.searchNote = notes.join(" ");

  renderResults(comp);
  cascadeSearch(comp);
}

// ------------------------------------------------------------------
// Sens de rotation : notes par complication
// ------------------------------------------------------------------

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
  for (const name of train.wheels.keys()) {
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

function evaluateTrain(train, options) {
  const placer = new Placer(train, options);
  const conflicts = placer.diagnoseFixedConflicts();
  if (conflicts.length) return { conflicts, layout: null, score: [conflicts.length, Infinity] };
  const layout = placer.place();
  return { conflicts, layout, score: [0, layout ? layout.score : Infinity] };
}

function betterScore(a, b) {
  return a[0] < b[0] || (a[0] === b[0] && a[1] < b[1]);
}

function isSolved(score) {
  return score[0] === 0 && Number.isFinite(score[1]);
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
    let best = null;
    let bestScore = [Infinity, Infinity];
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

  // passe 1 : modules classiques ; passe 2 : grille fine si rien de satisfaisant
  let standard = withFixed(standardModulesIn(moduleMin, moduleMax));
  if (!standard.length) standard = withFixed([moduleMin, moduleMax]);
  let { best, bestScore } = searchModules(standard);
  if (!isSolved(bestScore)) {
    const nSteps = 10;
    const grid = Array.from({ length: nSteps }, (_, i) => moduleMin + (i * (moduleMax - moduleMin)) / (nSteps - 1));
    const fine = withFixed([...new Set([...grid, ...standard].map((v) => Math.round(v * 1e4) / 1e4))].sort((a, b) => a - b));
    const second = searchModules(fine);
    if (betterScore(second.bestScore, bestScore)) ({ best, bestScore } = second);
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
    last ? { ...last.options, styles: stylesFor(last.active) } : {}
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
    .every((c) => c.ratioMode === "speeds" && Number.isFinite(toTurnsPerHour(c.speedIn.value, c.speedIn.unit)));
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

/** Pose la rotation de chaque mobile pour l'instant `t` (s depuis le depart). */
function animateFrame(t) {
  const last = state.lastRender;
  if (!last || !last.velocities) return;
  const maxAbs = maxAbsVelocity();
  if (!maxAbs) return;
  const k = (animationSpeed() / maxAbs) * 360;
  for (const el of document.querySelectorAll("#drawing-area [data-wheel]")) {
    const v = last.velocities.get(el.dataset.wheel);
    if (v === undefined) continue;
    el.setAttribute("transform", `rotate(${(v * k * t).toFixed(2)} ${el.dataset.cx} ${el.dataset.cy})`);
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

function runPlacement() {
  const all = comps();
  normalizeAll(all);
  state.analysis = analyzeTrainSenses(all);
  all.forEach(renderSensNote);
  renderProtectedTable();

  const moduleMin = parseFloat(document.getElementById("module-min").value);
  const moduleMax = parseFloat(document.getElementById("module-max").value);
  const plateDiameter = parseFloat(document.getElementById("plate-diameter").value);
  const plateRadius = plateDiameter / 2;
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
    levels,
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
  const senses = computeRotationSenses(train, senseRoots(active));
  const velocities = computeAngularVelocities(train, velocityRoots(active));
  const speedsKnown = allSpeedsKnown(active);
  renderLegend(train);
  renderModulesInfo(active, train);
  renderSensInfo(active, senses);

  const placer = new Placer(train, { ...baseOptions, nRandomRestarts: restarts });
  const conflicts = placer.diagnoseFixedConflicts();
  renderConflicts(conflicts);

  const renderOptions = { marks: marksFor(active), senses, fixedMarkers: markers, rootWheel: baseOptions.rootWheel };
  const draw = (layout) => {
    state.lastRender = { train, layout, plateRadius, options: renderOptions, active, velocities, speedsKnown };
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
    };
    const parts = [];
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
    const hint = fixed.size ? "les positions imposées sont peut-être incompatibles avec les entraxes — " : "";
    setStatus(`Aucun placement trouvé (${hint}augmente les redémarrages, les niveaux ou la platine).${sensWarning}`, "error");
    draw(null);
    return;
  }

  const usedLevels = new Set(layout.levels.values()).size;
  setStatus(
    `Placement trouvé — rayon englobant ${layout.score.toFixed(3)} mm, ${active.length} complication${active.length > 1 ? "s" : ""}, ${usedLevels} niveau${usedLevels > 1 ? "x" : ""} utilisé${usedLevels > 1 ? "s" : ""} sur ${levels}${sensWarning}`,
    unsatisfied.length ? "error" : "ok"
  );
  draw(layout);
}

// ------------------------------------------------------------------
// Evenements
// ------------------------------------------------------------------

document.addEventListener("DOMContentLoaded", () => {
  document.getElementById("btn-add-complication").addEventListener("click", addComplication);
  document.getElementById("btn-place").addEventListener("click", schedulePlacement);
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
