/**
 * perpetual-ui.js
 * Panneau « Quantieme perpetuel » et vue « cadrature » : positions des
 * affichages, reglage de la date, deroulement du temps, animation.
 *
 * La vue partage la zone de dessin, le zoom et les regles du rouage
 * (main.js appelle perpViewActive / perpDraw depuis redrawOnly).
 */

const perpState = {
  // construction : "pendule" (bascules separees) ou "montre" (grande bascule)
  kind: "pendule",
  // positions en fraction du rayon de platine : un changement de platine
  // agrandit le cadran sans deplacer les affichages sur celui-ci
  displays: {
    date: { hour: 6, rel: 0.47, free: null },
    day: { hour: 9, rel: 0.47, free: null },
    month: { hour: 3, rel: 0.47, free: null },
  },
  startDate: null,
  t: 0.5,
  model: null,
  timeline: null,
  verify: null,
  margins: null,
  modelKey: null,
  showDial: true,
  showLabels: true,
  slowNight: true,
  speed: 1,
  placing: null,
  anim: { raf: null, last: 0 },
};

const PERP_DISPLAY_LABELS = { date: "Quantième", day: "Jours", month: "Mois" };

function perpTodayISO() {
  const now = new Date();
  const pad = (v) => String(v).padStart(2, "0");
  return `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())}`;
}

function perpPlateRadius() {
  const d = parseFloat(document.getElementById("plate-diameter")?.value);
  return Number.isFinite(d) && d > 0 ? d / 2 : 15;
}

function perpViewActive() {
  return document.getElementById("view-mode")?.value === "perpetuel";
}

/** Horaire de la nuit de la construction courante. */
function perpTiming() {
  return perpState.model?.timing ?? PERP_KIND_SPECS[perpState.kind].timing;
}

function perpDisplayPoint(key, plateRadius = perpPlateRadius()) {
  const d = perpState.displays[key];
  if (d.free) return { x: d.free.x * plateRadius, y: d.free.y * plateRadius };
  return perpClockPoint(d.hour, d.rel * plateRadius);
}

function perpFmtMm(v) {
  return v.toFixed(2).replace(".", ",");
}

// ------------------------------------------------------------------
// Synthese
// ------------------------------------------------------------------

/** Recalcule le mecanisme si les donnees ont change. */
function perpEnsureModel() {
  const plateRadius = perpPlateRadius();
  const displays = { date: perpDisplayPoint("date"), day: perpDisplayPoint("day"), month: perpDisplayPoint("month") };
  const key = JSON.stringify([perpState.kind, plateRadius, displays, perpState.startDate]);
  if (key === perpState.modelKey) return perpState.model;
  perpState.modelKey = key;

  let model;
  try {
    model = synthesizePerpetual({ plateRadius, displays, kind: perpState.kind });
  } catch (err) {
    console.error(err);
    model = { ok: false, problems: [`Erreur de calcul : ${err.message}`] };
  }
  perpState.model = model;
  perpState.timeline = null;
  perpState.verify = null;
  perpState.margins = null;
  const start = perpParseDate(perpState.startDate);
  if (model.ok && start) {
    perpState.timeline = createPerpetualTimeline(model, start);
    perpState.verify = perpVerify(model, start);
    perpState.margins = perpMargins(model);
  }
  perpRenderNotes();
  return model;
}

// ------------------------------------------------------------------
// Panneau
// ------------------------------------------------------------------

function perpRenderPanel() {
  const panel = document.getElementById("panel-perpetual");
  if (!panel) return;
  const plateRadius = perpPlateRadius();
  const hourOptions = (d) =>
    Array.from({ length: 12 }, (_, i) => i + 1)
      .map((h) => opt(h, `${h} h`, !d.free && d.hour % 12 === h % 12))
      .join("") + opt("free", "libre (clic)", !!d.free);

  const rows = Object.keys(PERP_DISPLAY_LABELS)
    .map((key) => {
      const d = perpState.displays[key];
      const point = perpDisplayPoint(key, plateRadius);
      const distance = Math.hypot(point.x, point.y);
      const placing = perpState.placing === key;
      return `<tr data-key="${key}">
        <td>${PERP_DISPLAY_LABELS[key]}</td>
        <td><select class="perp-hour-select">${hourOptions(d)}</select></td>
        <td><input type="number" class="perp-distance" step="0.1" min="0" value="${distance.toFixed(2)}" ${d.free ? "disabled" : ""} /></td>
        <td><button type="button" class="link-btn perp-place ${placing ? "active" : ""}">${placing ? "clique sur le dessin…" : "placer par clic"}</button></td>
      </tr>`;
    })
    .join("");

  const description =
    perpState.kind === "montre"
      ? `Construction de <strong>montre</strong>, à <strong>grande bascule</strong>, vue côté cadran. Un seul
      <strong>limaçon</strong> de la roue de 24 h lève chaque soir la grande bascule, qui retombe à minuit sur la
      <strong>came programme de 48 mois</strong>. En fin de levée, ses deux <strong>cliquets</strong> avancent le
      quantième et le jour d'une dent — une <strong>goupille fixe</strong> les tient hors de la denture jusque-là, si
      bien qu'ils ne travaillent que sur une plage que tous les mois parcourent, et jamais de plus d'une dent. Son
      <strong>crochet</strong> part du cran du mois courant : il ne se trouve derrière la goupille de fin de mois que
      le dernier jour du mois, la rattrape alors et la ramène au 1. Au passage du 31 au 1, un <strong>doigt</strong> de
      la roue de quantième fait avancer l'étoile des mois — il faut pour cela que les deux affichages soient voisins ;
      sinon un levier des mois fait le relais. Par rapport à la pendule : deux ou trois leviers, autant de ressorts,
      et deux cames de moins.`
      : `Construction de <strong>pendule</strong>, à <strong>grand levier</strong>, vue côté cadran. La roue de 24 h
      arme chaque soir deux <strong>bascules</strong> qui avancent le quantième et le jour d'une dent. Le grand levier
      repose sur la <strong>came programme de 48 mois</strong> : la profondeur du cran du mois fixe jusqu'où son
      cliquet balaie l'étoile de 31, si bien qu'il n'attrape la goupille de fin de mois que le dernier jour d'un mois
      court et la ramène au 1. Des <strong>ressorts</strong> rappellent les leviers, des sautoirs tiennent les étoiles.`;

  panel.innerHTML = `
    <h2>Quantième perpétuel</h2>
    <div class="field-row">
      <div class="field full">
        <label>Construction</label>
        <select class="perp-kind">
          ${opt("pendule", "Pendule — bascules séparées et grand levier", perpState.kind === "pendule")}
          ${opt("montre", "Montre — grande bascule unique", perpState.kind === "montre")}
        </select>
      </div>
    </div>
    <p class="empty-note">
      ${description}
      Toute la géométrie (pivots, bras, cames) se recalcule à partir des positions choisies ci-dessous.
    </p>
    <div class="table-scroll">
      <table class="candidates compact">
        <thead><tr><th>Affichage</th><th>Position</th><th>Distance au centre (mm)</th><th></th></tr></thead>
        <tbody class="perp-positions">${rows}</tbody>
      </table>
    </div>
    <p class="empty-note perp-placing" ${perpState.placing ? "" : "hidden"}>Clique sur la platine (vue cadrature) pour poser l'affichage — Échap pour annuler.</p>
    ${
      perpState.kind === "montre"
        ? `<div class="perp-controls">
      <button type="button" class="secondary perp-near-month" title="Cherche près du quantième une position des mois où la roue de quantième mène l'étoile des mois par son doigt, sans levier">rapprocher les mois du quantième</button>
    </div>
    <p class="empty-note perp-near-note alert" hidden></p>`
        : ""
    }

    <div class="field-row" style="margin-top:0.9rem">
      <div class="field">
        <label>Mise à l'heure le</label>
        <input type="date" class="perp-start" value="${perpState.startDate}" />
      </div>
      <div class="field">
        <label>Heure <span class="perp-hour-value"></span></label>
        <input type="range" class="perp-hour" min="0" max="23.99" step="0.05" value="12" />
      </div>
    </div>
    <div class="perp-controls">
      <button type="button" class="secondary perp-prev">◀ jour</button>
      <button type="button" class="secondary perp-next">jour ▶</button>
      <button type="button" class="secondary perp-month-end" title="Se placer le dernier soir du mois, juste avant le changement de date">fin du mois ⏭</button>
      <button type="button" class="secondary perp-feb" title="Se placer le soir du dernier jour de février : le grand levier fait sauter 3 ou 2 dents">fin février ⏭</button>
    </div>
    <div class="perp-controls">
      <button type="button" class="perp-play">${perpState.anim.raf ? "■ arrêter" : "▶ faire défiler"}</button>
      <label class="tool-check">vitesse <input type="number" class="perp-speed" min="0.05" max="400" step="0.5" value="${perpState.speed}" /> j/s</label>
      <label class="tool-check"><input type="checkbox" class="perp-slow" ${perpState.slowNight ? "checked" : ""} /> ralentir la nuit</label>
    </div>
    <div class="perp-controls">
      <label class="tool-check"><input type="checkbox" class="perp-dial" ${perpState.showDial ? "checked" : ""} /> cadran et aiguilles</label>
      <label class="tool-check"><input type="checkbox" class="perp-labels" ${perpState.showLabels ? "checked" : ""} /> noms des pièces</label>
    </div>
    <p class="empty-note perp-readout"></p>
    <p class="empty-note perp-verify"></p>
    <p class="empty-note perp-specs"></p>
    <button type="button" class="perp-show" ${perpViewActive() ? "hidden" : ""}>Voir la cadrature</button>`;

  perpBindPanel(panel);
  perpRenderNotes();
  perpUpdateFrame();
}

function perpBindPanel(panel) {
  const on = (sel, evt, fn) => panel.querySelectorAll(sel).forEach((el) => el.addEventListener(evt, fn));
  const plateRadius = () => perpPlateRadius();

  on(".perp-near-month", "click", (e) => {
    const button = e.target;
    button.disabled = true;
    button.textContent = "recherche…";
    // laisse le navigateur afficher l'attente avant le calcul
    setTimeout(() => {
      if (perpNearMonth()) return;
      button.disabled = false;
      button.textContent = "rapprocher les mois du quantième";
      const note = panel.querySelector(".perp-near-note");
      note.textContent =
        "Aucune position des mois voisine du quantième ne laisse la place à la grande bascule et au doigt des mois : déplace d'abord le quantième ou les jours.";
      note.hidden = false;
    }, 20);
  });
  on(".perp-kind", "change", (e) => {
    perpState.kind = e.target.value === "montre" ? "montre" : "pendule";
    perpStructuralChange();
  });
  on(".perp-hour-select", "change", (e) => {
    const key = e.target.closest("tr").dataset.key;
    const d = perpState.displays[key];
    if (e.target.value === "free") {
      const p = perpDisplayPoint(key);
      d.free = { x: p.x / plateRadius(), y: p.y / plateRadius() };
      perpSetPlacing(key);
      return;
    }
    d.hour = parseInt(e.target.value, 10);
    d.free = null;
    perpStructuralChange();
  });
  on(".perp-distance", "change", (e) => {
    const key = e.target.closest("tr").dataset.key;
    const v = parseFloat(e.target.value);
    if (!Number.isFinite(v) || v < 0) return;
    perpState.displays[key].rel = v / plateRadius();
    perpStructuralChange();
  });
  on(".perp-place", "click", (e) => {
    const key = e.target.closest("tr").dataset.key;
    perpSetPlacing(perpState.placing === key ? null : key);
  });
  on(".perp-start", "change", (e) => {
    if (!perpParseDate(e.target.value)) return;
    perpState.startDate = e.target.value;
    perpState.t = 0.5;
    perpStructuralChange();
  });
  on(".perp-hour", "input", (e) => {
    const h = parseFloat(e.target.value);
    perpState.t = Math.floor(perpState.t) + (Number.isFinite(h) ? h : 12) / 24;
    perpUpdateFrame();
  });
  on(".perp-prev", "click", () => {
    perpState.t = Math.max(0, perpState.t - 1);
    perpUpdateFrame();
  });
  on(".perp-next", "click", () => {
    perpState.t += 1;
    perpUpdateFrame();
  });
  on(".perp-month-end", "click", () => perpJumpToMonthEnd(false));
  on(".perp-feb", "click", () => perpJumpToMonthEnd(true));
  on(".perp-play", "click", perpToggleAnimation);
  on(".perp-speed", "input", (e) => {
    const v = parseFloat(e.target.value);
    if (Number.isFinite(v) && v > 0) perpState.speed = v;
    updateAnimScale();
  });
  on(".perp-slow", "change", (e) => {
    perpState.slowNight = e.target.checked;
  });
  on(".perp-dial", "change", (e) => {
    perpState.showDial = e.target.checked;
    redrawOnly();
  });
  on(".perp-labels", "change", (e) => {
    perpState.showLabels = e.target.checked;
    redrawOnly();
  });
  on(".perp-show", "click", () => {
    const select = document.getElementById("view-mode");
    select.value = "perpetuel";
    select.dispatchEvent(new Event("change"));
  });
}

/**
 * Construction de montre : cherche, pres de l'affichage du quantieme, une
 * position de l'affichage des mois ou la roue de quantieme mene l'etoile des
 * mois par son doigt. Les positions les plus proches de l'actuelle sont
 * essayees d'abord ; retourne true si l'une d'elles convient.
 */
function perpNearMonth() {
  const R = perpPlateRadius();
  const dim = perpDimensions(R, "montre");
  const D = perpDisplayPoint("date", R);
  const W = perpDisplayPoint("day", R);
  const current = perpDisplayPoint("month", R);
  const minGap = dim.date.tip + dim.month.tip + dim.clearance;
  const candidates = [];
  for (let rho = minGap; rho <= minGap + 3 * dim.k; rho += 0.4 * dim.k) {
    for (let deg = 0; deg < 360; deg += 10) {
      const M = perpPolar(D, rho, (deg * Math.PI) / 180);
      if (!perpInPlate(M, dim.month.tip, R, dim.plateMargin)) continue;
      if (Math.hypot(M.x, M.y) - dim.month.tip - perpTipRadius(dim.hourWheel) < dim.clearance) continue;
      if (perpDist(M, W) - dim.month.tip - dim.day.tip < dim.clearance) continue;
      candidates.push(M);
    }
  }
  candidates.sort((a, b) => perpDist(a, current) - perpDist(b, current));
  let tries = 0;
  for (const M of candidates) {
    if (!perpDesignMonthFinger(D, M, dim, R, [{ x: 0, y: 0, r: 0.5 * dim.k }, { ...W, r: dim.arborClearance }])) continue;
    const model = synthesizePerpetual({ plateRadius: R, kind: "montre", displays: { date: D, day: W, month: M } });
    if (model.ok && model.monthFinger) {
      perpState.displays.month = { hour: Math.round(perpHourOfPoint(M)) || 12, rel: Math.hypot(M.x, M.y) / R, free: { x: M.x / R, y: M.y / R } };
      perpStructuralChange();
      return true;
    }
    if (++tries >= 8) break;
  }
  return false;
}

function perpStructuralChange() {
  perpEnsureModel();
  perpRenderPanel();
  if (perpViewActive()) redrawOnly();
}

function perpSetPlacing(key) {
  perpState.placing = key;
  if (key && !perpViewActive()) {
    const select = document.getElementById("view-mode");
    select.value = "perpetuel";
    select.dispatchEvent(new Event("change"));
  }
  document.getElementById("drawing-area")?.classList.toggle("placing", !!key);
  perpRenderPanel();
}

/**
 * Clic sur le dessin en vue cadrature : pose l'affichage en attente.
 * Retourne true si le clic a ete consomme.
 */
function perpHandleDrawingClick(e) {
  if (!perpViewActive() || !perpState.placing) return false;
  const svg = document.querySelector("#drawing-area svg");
  if (!svg) return true;
  const rect = svg.getBoundingClientRect();
  const scale = viewScale();
  const R = perpPlateRadius();
  const origin = (R + MARGIN) * scale;
  const x = (e.clientX - rect.left - origin) / scale;
  const y = (e.clientY - rect.top - origin) / scale;
  const d = perpState.displays[perpState.placing];
  d.free = { x: Math.round(x * 20) / 20 / R, y: Math.round(y * 20) / 20 / R };
  d.hour = Math.round(perpHourOfPoint({ x, y })) || 12;
  perpState.placing = null;
  document.getElementById("drawing-area")?.classList.remove("placing");
  perpStructuralChange();
  return true;
}

/** Se place le dernier soir du mois (ou du prochain fevrier), avant les bascules. */
function perpJumpToMonthEnd(february) {
  const tl = perpState.timeline;
  if (!tl) return;
  let n = Math.floor(perpState.t);
  const hour = (perpState.t - n) * 24;
  for (let guard = 0; guard < 800; guard++, n++) {
    const civil = perpCivilFromDayNumber(tl.startDay + n);
    const next = perpCivilFromDayNumber(tl.startDay + n + 1);
    const lastDay = next.m !== civil.m;
    const alreadyPast = n === Math.floor(perpState.t) && hour >= perpTiming().nightStart - 0.2;
    if (lastDay && !alreadyPast && (!february || civil.m === 1)) {
      perpState.t = n + (perpTiming().nightStart - 0.15) / 24;
      break;
    }
  }
  perpUpdateFrame();
}

// ------------------------------------------------------------------
// Notes et lecture
// ------------------------------------------------------------------

function perpRenderNotes() {
  const panel = document.getElementById("panel-perpetual");
  if (!panel) return;
  const verifyEl = panel.querySelector(".perp-verify");
  const specsEl = panel.querySelector(".perp-specs");
  if (!verifyEl || !specsEl) return;
  const model = perpState.model;

  if (!model || !model.ok) {
    verifyEl.textContent = model ? model.problems.join(" ") : "";
    verifyEl.classList.add("alert");
    specsEl.textContent = "";
    return;
  }
  verifyEl.classList.remove("alert");

  const v = perpState.verify;
  const start = perpParseDate(perpState.startDate);
  if (v && start) {
    const years = (v.days / 365.2425).toFixed(1).replace(".", ",");
    if (v.ok) {
      verifyEl.textContent = `Vérifié jour par jour contre le calendrier grégorien : aucun écart sur ${v.days} jours.`;
    } else if (v.secular) {
      const last = perpCivilFromDayNumber(perpDayNumber(v.civil.y, v.civil.m, v.civil.d) - 1);
      verifyEl.innerHTML =
        `Vérifié jour par jour contre le calendrier grégorien depuis le réglage : <strong>exact pendant ${v.days} jours (${years} ans)</strong>, ` +
        `jusqu'au ${perpFormatCivil(last)}. Le lendemain le mécanisme affichera <strong>29 février ${v.civil.y}</strong> : ` +
        `${v.civil.y} n'est pas bissextile (règle séculaire), ce qu'aucun quantième perpétuel à cycle de 4 ans ne sait. ` +
        `Il faudra avancer le quantième d'un jour ce matin-là.`;
    } else {
      verifyEl.classList.add("alert");
      verifyEl.textContent = `ÉCART du mécanisme le ${perpFormatCivil(v.civil)} (après ${v.days} jours) : il affiche le ${v.shown.p} ${PERP_MONTH_NAMES[v.shown.k % 12]}. La géométrie est à revoir.`;
    }
  }

  const th = model.thresholds;
  const gl = model.grandLever;
  const ml = model.monthLever;
  const deg = (rad) => ((Math.abs(rad) * 180) / Math.PI).toFixed(1).replace(".", ",");
  const dents = (v) => v.toFixed(2).replace(".", ",");
  const programLine = `Came programme : crans à ${[28, 29, 30, 31].map((L) => `${perpFmtMm(th.levels[L])} mm (${L} j)`).join(", ")} ; relus à ${[28, 29, 30, 31]
    .map((L) => dents(th.restByLength[L]))
    .join(" / ")} dents, marge du cliquet ${dents(perpState.margins.worst)} dent.`;
  const finger = model.monthFinger;
  const monthLine = finger
    ? `Doigt des mois : fixé sur la roue de quantième, ${perpFmtMm(finger.rF)} mm de rayon ; il pousse l'étoile des mois de ${dents(finger.windowStart)} à ${dents(
        finger.windowEnd
      )} dents et en ressort à ${dents(finger.windowOut)}, avant le 1. L'étoile des mois tourne en sens inverse du quantième : son cadran est gradué à rebours.`
    : `Levier des mois : cliquet ${perpFmtMm(ml.drive.Lp)} mm, fourchette ${perpFmtMm(ml.forkLength)} mm, le mois change à ${dents(th.monthHalf)} dents.`;
  const watchParts = finger
    ? [
        `Pièces pivotées : grande bascule et trois sautoirs, chacun avec son ressort, plus deux goupilles fixes de dégagement ; la roue de quantième porte la goupille de fin de mois et le doigt des mois — la pendule compte sept pièces pivotées, et trois cames sur la roue de 24 h au lieu d'une.`,
      ]
    : [
        `Pièces pivotées : grande bascule, levier des mois et trois sautoirs, chacun avec son ressort, plus deux goupilles fixes de dégagement — la pendule compte sept pièces pivotées, et trois cames sur la roue de 24 h au lieu d'une.`,
        `Levier des mois conservé : l'étoile des mois est à ${perpFmtMm(
          perpDist(model.centers.D, model.centers.M)
        )} mm de celle du quantième, trop loin pour son doigt. Le bouton « rapprocher les mois du quantième » cherche une position voisine où la roue de quantième la mène directement.`,
      ];
  const lines =
    model.kind === "montre"
      ? [
          programLine,
          `Limaçon de 24 h (seule came de la roue) : ${perpFmtMm(th.snailLow)} → ${perpFmtMm(th.snailTop)} mm, butée haute à ${dents(th.topP)} dents.`,
          `Grande bascule : crochet de fin de mois ${perpFmtMm(gl.forkLength)} mm, bec ${perpFmtMm(gl.bec.La)} mm, palpeur ${perpFmtMm(gl.lift.La)} mm, rendement mini ${dents(gl.minEff)} ; ` +
            `cliquet de quantième ${perpFmtMm(gl.pawls.date.drive.Lp)} mm (libéré à ${dents(gl.pawls.date.cBank)}, pousse de ${dents(gl.pawls.date.cS)} à ${dents(gl.pawls.date.cE)} dents de levée), ` +
            `cliquet des jours ${perpFmtMm(gl.pawls.day.drive.Lp)} mm (libéré à ${dents(gl.pawls.day.cBank)}, pousse de ${dents(gl.pawls.day.cS)} à ${dents(gl.pawls.day.cE)}) — le repos des mois de 31 jours est à ${dents(th.restByLength[31])}.`,
          monthLine,
          ...watchParts,
          `Leviers supposés étagés : leurs bras passent au-dessus des roues et sont découpés pour contourner les arbres des aiguilles, leurs pivots évitent toute pièce tournante.`,
        ]
      : [
          programLine,
          `Limaçon de 24 h : ${perpFmtMm(th.snailLow)} → ${perpFmtMm(th.snailTop)} mm, butée haute à ${dents(th.topP)} dents.`,
          `Grand levier : fourchette ${perpFmtMm(gl.forkLength)} mm, bec ${perpFmtMm(gl.bec.La)} mm, palpeur ${perpFmtMm(gl.lift.La)} mm, rendement mini ${dents(gl.minEff)}.`,
          monthLine,
          `Bascules : quantième (cliquet ${perpFmtMm(model.dateBascule.drive.Lp)} mm, course ${deg(model.dateBascule.drive.delta)}°), semaine (cliquet ${perpFmtMm(
            model.dayBascule.drive.Lp
          )} mm, course ${deg(model.dayBascule.drive.delta)}°).`,
          `Leviers supposés étagés : leurs bras passent au-dessus des roues et sont découpés pour contourner les arbres des aiguilles, leurs pivots évitent toute pièce tournante.`,
        ];
  if (perpState.margins.issues.length) lines.push(`Attention : ${perpState.margins.issues.join(" ; ")}.`);
  specsEl.textContent = lines.join(" ");
  specsEl.classList.toggle("alert", perpState.margins.issues.length > 0);
}

function perpFormatHour(h) {
  const total = Math.floor(h * 60 + 1e-6);
  return `${String(Math.floor(total / 60) % 24).padStart(2, "0")}:${String(total % 60).padStart(2, "0")}`;
}

/** Texte de lecture : ce qu'affiche le mecanisme, et la date reelle. */
function perpReadout(pose) {
  const tl = perpState.timeline;
  const real = perpCivilFromDayNumber(tl.startDay + pose.n);
  const ind = pose.indication;
  const cycle = ind.cycleYear === 0 ? "année bissextile" : `${ind.cycleYear}${ind.cycleYear === 1 ? "re" : "e"} année après bissextile`;
  const shown = `${PERP_DAY_NAMES[ind.weekday]} ${ind.date} ${PERP_MONTH_NAMES[ind.month]} (${cycle})`;
  const expected = perpStateFromCivil(real);
  const matches = expected.p === ind.date && expected.w === ind.weekday && expected.k % 12 === ind.month;
  return { shown, real: `${perpFormatCivil(real)}, ${perpFormatHour(pose.h)}`, matches };
}

/** Pose courante : dessin, curseur d'heure, lecture, statut. */
function perpUpdateFrame() {
  const panel = document.getElementById("panel-perpetual");
  const tl = perpState.timeline;
  const hourValue = panel?.querySelector(".perp-hour-value");
  const hourInput = panel?.querySelector(".perp-hour");
  const readoutEl = panel?.querySelector(".perp-readout");
  if (!tl) {
    if (readoutEl) readoutEl.textContent = "";
    return;
  }
  const pose = perpPoseAt(tl, perpState.t);
  const r = perpReadout(pose);
  const T = perpTiming();
  const night = pose.h >= T.nightStart;
  if (hourValue) hourValue.textContent = perpFormatHour(pose.h);
  if (hourInput && document.activeElement !== hourInput) hourInput.value = pose.h.toFixed(2);
  if (readoutEl) {
    readoutEl.innerHTML = night
      ? `Changement de jour en cours (aiguilles en mouvement). Date réelle : ${r.real}.`
      : `Le mécanisme affiche <strong>${r.shown}</strong>. Date réelle : ${r.real}.`;
    readoutEl.classList.toggle("alert", !r.matches && !night);
  }
  if (!perpViewActive()) return;
  updatePerpetualSVG(document.querySelector("#drawing-area svg"), perpState.model, pose);
  let phase = "";
  if (perpState.model.kind === "montre") {
    if (pose.h >= T.dropStart) phase = " — la grande bascule retombe sur la came programme";
    else if (pose.h >= T.liftStart)
      phase = pose.caught
        ? " — la grande bascule monte : son crochet ramène le quantième au 1"
        : " — la grande bascule monte : ses cliquets avancent quantième et jour";
  } else if (pose.h >= T.liftStart) {
    phase = pose.caught ? " — le grand levier ramène le quantième au 1" : " — levée du grand levier (rien à attraper)";
  } else if (pose.h >= T.stepStart) {
    phase = " — les bascules avancent quantième et jour";
  }
  // la nuit, les aiguilles sont en chemin : lire « 31 février » au milieu
  // d'un saut ne voudrait rien dire, on dit donc ce qui se passe
  const reading = night ? "aiguilles en mouvement" : r.shown;
  setStatus(`Cadrature : ${reading} · ${perpFormatHour(pose.h)}${phase}`, r.matches || night ? "ok" : "error");
}

// ------------------------------------------------------------------
// Dessin et animation
// ------------------------------------------------------------------

/** Appele par redrawOnly quand la vue cadrature est active. */
function perpDraw() {
  const area = document.getElementById("drawing-area");
  const model = perpEnsureModel();
  const plateRadius = perpPlateRadius();
  const scale = viewScale();
  if (!model.ok) {
    const toPx = perpToPx(plateRadius, scale, MARGIN);
    const size = (plateRadius + MARGIN) * 2 * scale;
    let svg = `<svg xmlns="http://www.w3.org/2000/svg" width="${size.toFixed(0)}" height="${size.toFixed(0)}">`;
    svg += perpCircle({ x: 0, y: 0 }, plateRadius * scale, toPx, `fill="none" stroke="${PERP_COLORS.plate}" stroke-width="1.5" stroke-dasharray="6,4"`);
    for (const key of Object.keys(PERP_DISPLAY_LABELS)) {
      const p = perpDisplayPoint(key, plateRadius);
      svg += perpCircle(p, 6, toPx, `fill="none" stroke="${PERP_COLORS.spring}" stroke-width="1.5"`);
      svg += perpLabel({ x: p.x, y: p.y - 0.6 }, PERP_DISPLAY_LABELS[key], toPx, 11, PERP_COLORS.spring, "middle");
    }
    area.innerHTML = svg + "</svg>";
    setStatus(`Cadrature impossible : ${model.problems.join(" ")}`, "error");
    return;
  }
  area.innerHTML = renderPerpetualSVG(model, {
    plateRadius,
    scale,
    margin: MARGIN,
    showDial: perpState.showDial,
    showLabels: perpState.showLabels,
  }).svgMarkup;
  perpUpdateFrame();
}

function perpToggleAnimation() {
  if (perpState.anim.raf) return perpStopAnimation();
  perpState.anim.last = performance.now();
  const step = (now) => {
    const dt = Math.min(0.1, (now - perpState.anim.last) / 1000);
    perpState.anim.last = now;
    const h = (perpState.t - Math.floor(perpState.t)) * 24;
    // la nuit, tout se joue en quelques heures : on ralentit pour voir
    const slow = perpState.slowNight && h >= perpTiming().nightStart - 0.3 ? 1 / 30 : 1;
    perpState.t += dt * perpState.speed * slow;
    perpUpdateFrame();
    perpState.anim.raf = requestAnimationFrame(step);
  };
  perpState.anim.raf = requestAnimationFrame(step);
  perpSyncPlayButtons();
}

function perpStopAnimation() {
  if (perpState.anim.raf) cancelAnimationFrame(perpState.anim.raf);
  perpState.anim.raf = null;
  perpSyncPlayButtons();
}

function perpSyncPlayButtons() {
  const running = !!perpState.anim.raf;
  const play = document.querySelector("#panel-perpetual .perp-play");
  if (play) play.textContent = running ? "■ arrêter" : "▶ faire défiler";
  const btn = document.getElementById("btn-animate");
  if (btn && perpViewActive()) btn.textContent = running ? "■ arrêter" : "▶ animer";
}

document.addEventListener("DOMContentLoaded", () => {
  perpState.startDate = perpTodayISO();
  // synthese des l'ouverture : le panneau montre la verification sans
  // attendre que l'on passe en vue cadrature
  perpEnsureModel();
  perpRenderPanel();

  const select = document.getElementById("view-mode");
  select?.addEventListener("change", () => {
    stopAnimation();
    perpStopAnimation();
    if (!perpViewActive() && perpState.placing) {
      perpState.placing = null;
      document.getElementById("drawing-area")?.classList.remove("placing");
    }
    perpRenderPanel();
    zoomToFit();
    if (!perpViewActive()) schedulePlacement();
  });

  // la platine fixe l'echelle du mecanisme : on le resynthetise
  document.getElementById("plate-diameter")?.addEventListener("change", () => {
    perpEnsureModel();
    perpRenderPanel();
  });

  document.addEventListener("keydown", (e) => {
    if (e.key === "Escape" && perpState.placing) perpSetPlacing(null);
  });
});
