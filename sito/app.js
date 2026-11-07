/*
 * Radar Voli Napoli - interfaccia.
 *
 * Legge i file data/voli.json e data/storico.json (preparati ogni 15 minuti
 * da scripts/aggiorna_voli.py su GitHub Actions) e li mostra su mappa,
 * elenco, statistiche e grafico. Non chiama mai direttamente le API dei voli:
 * il browser le bloccherebbe per via del CORS.
 */
"use strict";

const CENTRO = [40.886, 14.291];          // Aeroporto di Napoli Capodichino
const RICARICA_MS = 60 * 1000;            // ricontrolla i file ogni minuto
const DATI_VECCHI_MIN = 45;               // oltre questa età i dati sono "non recenti"

// Codici ICAO delle compagnie (le prime 3 lettere del nominativo di volo)
const COMPAGNIE = {
  RYR: "Ryanair", RUK: "Ryanair UK", EZY: "easyJet", EJU: "easyJet Europe", EZS: "easyJet Switzerland",
  ITY: "ITA Airways", VLG: "Vueling", WZZ: "Wizz Air", WMT: "Wizz Air Malta", VOE: "Volotea",
  DLH: "Lufthansa", AFR: "Air France", BAW: "British Airways", KLM: "KLM", AEE: "Aegean",
  THY: "Turkish Airlines", PGT: "Pegasus", SWR: "Swiss", AUA: "Austrian", IBE: "Iberia",
  TRA: "Transavia", TVF: "Transavia France", UAE: "Emirates", QTR: "Qatar Airways", ETD: "Etihad",
  NAX: "Norwegian", SXS: "SunExpress", EWG: "Eurowings", BEL: "Brussels Airlines", TAP: "TAP Air Portugal",
  LOT: "LOT", AEA: "Air Europa", NOS: "Neos", RAM: "Royal Air Maroc", MSR: "EgyptAir",
  ELY: "El Al", FDB: "flydubai", IAM: "Aeronautica Militare",
};

// --- Utilità -----------------------------------------------------------------

/** Evita che testo esterno (es. il nome di un volo) venga interpretato come HTML. */
function escapeHTML(testo) {
  return String(testo ?? "").replace(/[&<>"']/g, (c) =>
    ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
}

const fmt = new Intl.NumberFormat("it-IT");
const metri = (ft) => (ft == null ? null : Math.round(ft * 0.3048));
const kmh = (kt) => (kt == null ? null : Math.round(kt * 1.852));
const nomeVolo = (a) => a.volo || a.reg || a.hex.toUpperCase();
const emergenza = (a) => a.emergenza || ["7500", "7600", "7700"].includes(a.squawk);

function compagnia(volo) {
  const m = /^([A-Z]{3})\d/.exec(volo || "");
  if (!m) return null;
  return COMPAGNIE[m[1]] || m[1];
}

function coloreQuota(a) {
  if (a.a_terra) return "var(--terra)";
  const m = metri(a.quota_ft) ?? 0;
  if (m < 1500) return "var(--basso)";
  if (m < 6000) return "var(--medio)";
  return "var(--alto)";
}

function oraBreve(ms) {
  return new Date(ms).toLocaleTimeString("it-IT", { hour: "2-digit", minute: "2-digit" });
}

// --- Mappa -------------------------------------------------------------------

const mappa = L.map("mappa", { zoomControl: true, zoomSnap: 0.25 }).setView(CENTRO, 9);

L.tileLayer("https://tile.openstreetmap.org/{z}/{x}/{y}.png", {
  maxZoom: 18,
  attribution: '&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a>',
}).addTo(mappa);

L.circleMarker(CENTRO, { radius: 6, color: "#42d392", weight: 2, fillOpacity: 0.35 })
  .addTo(mappa)
  .bindTooltip("Napoli Capodichino (NAP)");

let cerchioRaggio = null;
const livelloAerei = L.layerGroup().addTo(mappa);
const marcatori = new Map();   // codice hex -> marcatore sulla mappa

function iconaAereo(a) {
  const rotta = Number(a.rotta) || 0;
  const bordo = emergenza(a) ? "stroke='#ff5d5d' stroke-width='1.6'" : "stroke='#0b100d' stroke-width='.8'";
  return L.divIcon({
    className: "aereo",
    iconSize: [26, 26],
    iconAnchor: [13, 13],
    popupAnchor: [0, -10],
    html: `<svg viewBox="0 0 24 24" style="transform:rotate(${rotta}deg)">
             <path style="fill:${coloreQuota(a)}" ${bordo}
               d="M12 2c.6 0 1 .8 1 1.6V9l8 4.6v2l-8-2.4v4.6l2.2 1.6V21L12 20.2 8.8 21v-1.6L11 17.8v-4.6L3 15.6v-2L11 9V3.6C11 2.8 11.4 2 12 2z"/>
           </svg>`,
  });
}

function testoPopup(a) {
  const quota = a.a_terra ? "a terra" : `${fmt.format(metri(a.quota_ft))} m`;
  const vs = a.variometro_fpm;
  const fase = a.a_terra ? "–" : vs > 300 ? "in salita" : vs < -300 ? "in discesa" : "in crociera";
  const sotto = [compagnia(a.volo), a.tipo, a.reg].filter(Boolean).map(escapeHTML).join(" · ");
  return `
    <div class="popup-titolo">${escapeHTML(nomeVolo(a))}</div>
    <div class="popup-sotto">${sotto || "&nbsp;"}</div>
    <dl class="popup-dati">
      <dt>Quota</dt><dd>${quota}</dd>
      <dt>Velocità</dt><dd>${a.velocita_kt == null ? "–" : fmt.format(kmh(a.velocita_kt)) + " km/h"}</dd>
      <dt>Rotta</dt><dd>${a.rotta == null ? "–" : Math.round(a.rotta) + "°"}</dd>
      <dt>Fase</dt><dd>${fase}</dd>
      <dt>Distanza</dt><dd>${fmt.format(a.dist_km)} km</dd>
      <dt>Squawk</dt><dd>${escapeHTML(a.squawk || "–")}</dd>
    </dl>`;
}

function disegnaAerei(aerei) {
  const presenti = new Set();
  for (const a of aerei) {
    presenti.add(a.hex);
    let m = marcatori.get(a.hex);
    if (m) {
      m.setLatLng([a.lat, a.lon]);
      m.setIcon(iconaAereo(a));
      m.setPopupContent(testoPopup(a));
    } else {
      m = L.marker([a.lat, a.lon], { icon: iconaAereo(a), title: nomeVolo(a) }).bindPopup(testoPopup(a));
      m.addTo(livelloAerei);
      marcatori.set(a.hex, m);
    }
  }
  // Toglie dalla mappa gli aerei che non ci sono più
  for (const [hex, m] of marcatori) {
    if (!presenti.has(hex)) { livelloAerei.removeLayer(m); marcatori.delete(hex); }
  }
}

// --- Elenco e statistiche ----------------------------------------------------

function disegnaElenco(aerei) {
  const ul = document.getElementById("elenco");
  if (!aerei.length) {
    ul.innerHTML = `<li class="vuoto">Nessun aereo in zona in questo momento.</li>`;
    return;
  }
  ul.innerHTML = aerei.map((a) => {
    const quota = a.a_terra ? "a terra" : `${fmt.format(metri(a.quota_ft))} m`;
    const info = [compagnia(a.volo), a.tipo, quota].filter(Boolean).map(escapeHTML).join(" · ");
    return `<li class="${emergenza(a) ? "emergenza" : ""}">
      <button type="button" data-hex="${escapeHTML(a.hex)}">
        <span class="punto" style="background:${coloreQuota(a)}"></span>
        <span><span class="nome">${escapeHTML(nomeVolo(a))}</span><span class="sotto">${info}</span></span>
        <span class="dist">${fmt.format(Math.round(a.dist_km))} km</span>
      </button></li>`;
  }).join("");
}

document.getElementById("elenco").addEventListener("click", (e) => {
  const bottone = e.target.closest("button[data-hex]");
  if (!bottone) return;
  const m = marcatori.get(bottone.dataset.hex);
  if (m) {
    mappa.flyTo(m.getLatLng(), Math.max(mappa.getZoom(), 10), { duration: 0.8 });
    m.openPopup();
  }
});

function imposta(id, testo) { document.getElementById(id).textContent = testo; }

function disegnaStatistiche(aerei, storico) {
  const inVolo = aerei.filter((a) => !a.a_terra);
  imposta("st-numero", fmt.format(aerei.length));
  imposta("st-24h", storico ? fmt.format(Object.keys(storico.visti || {}).length) : "–");

  const alto = inVolo.reduce((max, a) => ((a.quota_ft ?? -1) > (max?.quota_ft ?? -1) ? a : max), null);
  imposta("st-alto", alto ? `${fmt.format(metri(alto.quota_ft))} m` : "–");
  imposta("st-alto-volo", alto ? nomeVolo(alto) : "");

  const veloce = inVolo.reduce((max, a) => ((a.velocita_kt ?? -1) > (max?.velocita_kt ?? -1) ? a : max), null);
  imposta("st-veloce", veloce ? `${fmt.format(kmh(veloce.velocita_kt))} km/h` : "–");
  imposta("st-veloce-volo", veloce ? nomeVolo(veloce) : "");

  const avviso = document.getElementById("avviso-emergenza");
  const inEmergenza = aerei.filter(emergenza);
  avviso.hidden = inEmergenza.length === 0;
  avviso.textContent = inEmergenza.length
    ? `Codice di emergenza attivo: ${inEmergenza.map((a) => `${nomeVolo(a)} (squawk ${a.squawk})`).join(", ")}`
    : "";
}

// --- Compagnie più viste -----------------------------------------------------

function disegnaCompagnie(storico) {
  const box = document.getElementById("compagnie");
  const conteggio = {};
  for (const [, volo] of Object.values(storico?.visti || {})) {
    const c = compagnia(volo);
    if (c) conteggio[c] = (conteggio[c] || 0) + 1;
  }
  const top = Object.entries(conteggio).sort((x, y) => y[1] - x[1]).slice(0, 7);
  if (!top.length) {
    box.innerHTML = `<p class="muto">Servono qualche ora di dati per questa classifica.</p>`;
    return;
  }
  const max = top[0][1];
  box.innerHTML = top.map(([nome, n]) => `
    <div class="riga-compagnia">
      <span class="nome">${escapeHTML(nome)}</span>
      <span class="barra"><span style="width:${(n / max) * 100}%"></span></span>
      <span class="n">${n}</span>
    </div>`).join("");
}

// --- Grafico delle ultime 24 ore (disegnato a mano su canvas) ----------------

let ultimoStorico = null;

function disegnaGrafico(storico) {
  const canvas = document.getElementById("grafico");
  const ctx = canvas.getContext("2d");
  const dpr = window.devicePixelRatio || 1;
  const W = canvas.clientWidth, H = 190;
  canvas.width = W * dpr; canvas.height = H * dpr;
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  ctx.clearRect(0, 0, W, H);

  const css = getComputedStyle(document.documentElement);
  const cLinea = css.getPropertyValue("--accent").trim();
  const cGriglia = css.getPropertyValue("--line").trim();
  const cTesto = css.getPropertyValue("--muted").trim();
  ctx.font = "12px system-ui, sans-serif";

  const punti = (storico?.punti || []).slice().sort((a, b) => a.t - b.t);
  if (punti.length < 2) {
    ctx.fillStyle = cTesto;
    ctx.fillText("Il grafico si riempie man mano che arrivano i dati (uno ogni 15 minuti).", 8, H / 2);
    return;
  }

  const sx = 34, dx = 10, su = 10, giu = 24;           // margini
  const fine = punti[punti.length - 1].t, inizio = fine - 24 * 3600 * 1000;
  const maxN = Math.max(4, ...punti.map((p) => p.n));
  const x = (t) => sx + ((t - inizio) / (fine - inizio)) * (W - sx - dx);
  const y = (n) => su + (1 - n / maxN) * (H - su - giu);

  // Griglia orizzontale con valori
  ctx.strokeStyle = cGriglia; ctx.fillStyle = cTesto; ctx.lineWidth = 1;
  for (let i = 0; i <= 2; i++) {
    const v = Math.round((maxN * i) / 2);
    ctx.beginPath(); ctx.moveTo(sx, y(v)); ctx.lineTo(W - dx, y(v)); ctx.stroke();
    ctx.fillText(String(v), 4, y(v) + 4);
  }
  // Etichette delle ore ogni 6 ore
  for (let h = 0; h <= 24; h += 6) {
    const t = inizio + h * 3600 * 1000;
    const etichetta = h === 24 ? "adesso" : oraBreve(t);
    const larg = ctx.measureText(etichetta).width;
    ctx.fillText(etichetta, Math.min(Math.max(x(t) - larg / 2, sx), W - dx - larg), H - 6);
  }

  // Area sotto la linea
  const visibili = punti.filter((p) => p.t >= inizio);
  ctx.beginPath();
  visibili.forEach((p, i) => (i ? ctx.lineTo(x(p.t), y(p.n)) : ctx.moveTo(x(p.t), y(p.n))));
  ctx.lineTo(x(visibili[visibili.length - 1].t), y(0));
  ctx.lineTo(x(visibili[0].t), y(0));
  ctx.closePath();
  const sfumatura = ctx.createLinearGradient(0, su, 0, H - giu);
  sfumatura.addColorStop(0, "rgba(66,211,146,.35)");
  sfumatura.addColorStop(1, "rgba(66,211,146,0)");
  ctx.fillStyle = sfumatura; ctx.fill();

  // Linea
  ctx.beginPath();
  visibili.forEach((p, i) => (i ? ctx.lineTo(x(p.t), y(p.n)) : ctx.moveTo(x(p.t), y(p.n))));
  ctx.strokeStyle = cLinea; ctx.lineWidth = 2; ctx.lineJoin = "round"; ctx.stroke();

  // Ultimo punto evidenziato
  const ultimo = visibili[visibili.length - 1];
  ctx.beginPath(); ctx.arc(x(ultimo.t), y(ultimo.n), 4, 0, Math.PI * 2);
  ctx.fillStyle = cLinea; ctx.fill();
}

window.addEventListener("resize", () => disegnaGrafico(ultimoStorico));

// --- Stato dell'aggiornamento --------------------------------------------------

let ultimoAggiornamento = null;
let inErrore = false;

function aggiornaStato(errore) {
  inErrore = errore;
  const box = document.getElementById("stato");
  box.classList.remove("vecchio", "errore");
  if (errore) {
    box.classList.add("errore");
    imposta("stato-testo", "Dati non disponibili al momento");
    return;
  }
  if (!ultimoAggiornamento) return;
  const minuti = Math.round((Date.now() - ultimoAggiornamento) / 60000);
  const fa = minuti < 1 ? "adesso" : minuti === 1 ? "1 minuto fa" : `${minuti} minuti fa`;
  imposta("stato-testo", `Aggiornato alle ${oraBreve(ultimoAggiornamento)} · ${fa}`);
  if (minuti > DATI_VECCHI_MIN) box.classList.add("vecchio");
}

// --- Caricamento dei dati ----------------------------------------------------

async function leggiJSON(percorso) {
  const risposta = await fetch(`${percorso}?t=${Date.now()}`, { cache: "no-store" });
  if (!risposta.ok) throw new Error(`${percorso}: HTTP ${risposta.status}`);
  return risposta.json();
}

let primoCaricamento = true;

async function carica() {
  try {
    const [voli, storico] = await Promise.all([
      leggiJSON("data/voli.json"),
      leggiJSON("data/storico.json").catch(() => null),   // lo storico è facoltativo
    ]);
    const aerei = Array.isArray(voli.aerei) ? voli.aerei : [];

    if (!cerchioRaggio && voli.raggio_km) {
      cerchioRaggio = L.circle(CENTRO, {
        radius: voli.raggio_km * 1000, color: "#42d392", weight: 1, opacity: 0.35, fill: false, dashArray: "4 6",
      }).addTo(mappa);
      if (primoCaricamento) mappa.fitBounds(cerchioRaggio.getBounds(), { padding: [10, 10] });
    }

    disegnaAerei(aerei);
    disegnaElenco(aerei);
    disegnaStatistiche(aerei, storico);
    disegnaCompagnie(storico);
    ultimoStorico = storico;
    disegnaGrafico(storico);

    ultimoAggiornamento = voli.aggiornato;
    aggiornaStato(false);
    primoCaricamento = false;
  } catch (errore) {
    console.error(errore);
    aggiornaStato(true);
    if (primoCaricamento) {
      document.getElementById("elenco").innerHTML =
        `<li class="vuoto">I dati non sono ancora stati generati. Al primo avvio di GitHub Actions compariranno qui.</li>`;
    }
  }
}

carica();
setInterval(carica, RICARICA_MS);
setInterval(() => { if (!inErrore) aggiornaStato(false); }, 30 * 1000);
