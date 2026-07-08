import { compressImageFile } from "./image-compress.js";
import { scanItemPhoto, matchReceiptPhoto } from "./ticket-api.js";
import {
  getFrequentItems,
  getTrips,
  recordItemUsage,
  saveTrip,
  clearTrips,
} from "./ticket-history.js";

// ---------------------------------------------------------------------------
// State
// ---------------------------------------------------------------------------

let items = []; // { id, name, shelfPrice }
let receiptFile = null;
let pendingScanMode = null; // "shelf" | "barcode" while a photo picker is open

// ---------------------------------------------------------------------------
// DOM references
// ---------------------------------------------------------------------------

const $ = (id) => document.getElementById(id);

const frequentChipsEl = $("frequent-chips");
const addItemChoicesEl = $("add-item-choices");
const photoInputEl = $("photo-input");
const scanStatusEl = $("scan-status");
const scanErrorEl = $("scan-error");
const draftFormEl = $("draft-form");
const draftNameEl = $("draft-name");
const draftPriceEl = $("draft-price");

const ticketSectionEl = $("ticket-list-section");
const ticketListEl = $("ticket-list");
const ticketCountLabelEl = $("ticket-count-label");
const ticketTotalLabelEl = $("ticket-total-label");

const receiptSectionEl = $("receipt-section");
const receiptHintEl = $("receipt-hint");
const receiptSlotEl = $("receipt-slot");
const receiptPreviewEl = $("receipt-preview");
const receiptPlaceholderEl = $("receipt-placeholder");
const receiptInputEl = $("receipt-input");
const receiptRemoveEl = $("receipt-remove");
const compareBtnEl = $("compare-btn");
const compareErrorEl = $("compare-error");

const resultSectionEl = $("result-section");

const historySectionEl = $("history-section");
const historyListEl = $("history-list");
const historyClearEl = $("history-clear");

// ---------------------------------------------------------------------------
// Utilities
// ---------------------------------------------------------------------------

function formatXpf(value) {
  if (value === null || value === undefined) return "non lu";
  return `${value.toLocaleString("fr-FR")} XPF`;
}

function makeId() {
  return `item-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
}

// ---------------------------------------------------------------------------
// Frequent item chips
// ---------------------------------------------------------------------------

function renderFrequentChips() {
  const frequent = getFrequentItems();
  frequentChipsEl.innerHTML = "";
  if (frequent.length === 0) {
    frequentChipsEl.hidden = true;
    return;
  }
  frequentChipsEl.hidden = false;
  for (const item of frequent) {
    const chip = document.createElement("button");
    chip.type = "button";
    chip.className = "chip";
    chip.textContent = `${item.name} · ${item.price.toLocaleString("fr-FR")} XPF`;
    chip.addEventListener("click", () => addItem(item.name, item.price));
    frequentChipsEl.appendChild(chip);
  }
}

// ---------------------------------------------------------------------------
// Add-item flow
// ---------------------------------------------------------------------------

function resetDraft() {
  draftFormEl.hidden = true;
  draftNameEl.value = "";
  draftPriceEl.value = "";
  addItemChoicesEl.hidden = false;
  scanStatusEl.hidden = true;
  scanErrorEl.hidden = true;
  photoInputEl.value = "";
  pendingScanMode = null;
}

function showDraft(name, price) {
  addItemChoicesEl.hidden = true;
  draftNameEl.value = name ?? "";
  draftPriceEl.value = price !== null && price !== undefined ? String(price) : "";
  draftFormEl.hidden = false;
}

addItemChoicesEl.addEventListener("click", (event) => {
  const button = event.target.closest(".choice-btn");
  if (!button) return;
  const mode = button.dataset.mode;
  scanErrorEl.hidden = true;

  if (mode === "manual") {
    showDraft("", "");
    return;
  }

  pendingScanMode = mode;
  photoInputEl.click();
});

photoInputEl.addEventListener("change", async () => {
  const file = photoInputEl.files?.[0];
  const mode = pendingScanMode;
  if (!file || !mode) return;

  scanStatusEl.hidden = false;
  scanStatusEl.textContent = "Lecture de la photo...";
  scanErrorEl.hidden = true;

  try {
    const compressed = await compressImageFile(file);
    const result = await scanItemPhoto(compressed, mode);
    if (!result.readable) {
      scanErrorEl.hidden = false;
      scanErrorEl.textContent =
        "Rien de lisible sur cette photo. Tu peux compléter à la main ci-dessous.";
    }
    showDraft(result.name ?? "", result.price ?? "");
  } catch (err) {
    scanErrorEl.hidden = false;
    scanErrorEl.textContent = err instanceof Error ? err.message : "La lecture a échoué.";
    showDraft("", "");
  } finally {
    scanStatusEl.hidden = true;
  }
});

$("draft-cancel").addEventListener("click", resetDraft);

$("draft-confirm").addEventListener("click", () => {
  const name = draftNameEl.value.trim();
  const price = Number(draftPriceEl.value.replace(",", "."));
  if (!name || Number.isNaN(price) || price <= 0) return;
  addItem(name, Math.round(price));
  resetDraft();
});

function addItem(name, price) {
  items.push({ id: makeId(), name, shelfPrice: price });
  renderTicket();
  renderReceiptSection();
}

function removeItem(id) {
  items = items.filter((item) => item.id !== id);
  renderTicket();
  renderReceiptSection();
}

// ---------------------------------------------------------------------------
// Ticket list
// ---------------------------------------------------------------------------

function renderTicket() {
  if (items.length === 0) {
    ticketSectionEl.hidden = true;
    ticketListEl.innerHTML = "";
    return;
  }
  ticketSectionEl.hidden = false;
  const total = items.reduce((sum, item) => sum + item.shelfPrice, 0);
  ticketCountLabelEl.textContent = `Ticket en cours (${items.length} article${items.length > 1 ? "s" : ""})`;
  ticketTotalLabelEl.textContent = `${total.toLocaleString("fr-FR")} XPF`;

  ticketListEl.innerHTML = "";
  for (const item of items) {
    const li = document.createElement("li");
    const nameSpan = document.createElement("span");
    nameSpan.textContent = item.name;

    const priceWrap = document.createElement("div");
    priceWrap.className = "ticket-item-price";
    const priceSpan = document.createElement("span");
    priceSpan.textContent = `${item.shelfPrice.toLocaleString("fr-FR")} XPF`;
    const removeBtn = document.createElement("button");
    removeBtn.type = "button";
    removeBtn.className = "link-btn";
    removeBtn.textContent = "Retirer";
    removeBtn.addEventListener("click", () => removeItem(item.id));

    priceWrap.append(priceSpan, removeBtn);
    li.append(nameSpan, priceWrap);
    ticketListEl.appendChild(li);
  }
}

// ---------------------------------------------------------------------------
// Receipt section
// ---------------------------------------------------------------------------

function renderReceiptSection() {
  const hasItems = items.length > 0;
  receiptSectionEl.classList.toggle("disabled", !hasItems);
  receiptHintEl.textContent = hasItems
    ? "Une seule photo du ticket complet suffit, l'IA retrouve chaque article."
    : "Ajoute d'abord au moins un article ci-dessus pour débloquer cette étape.";
  receiptSlotEl.disabled = !hasItems;
  updateCompareButton();
}

function updateCompareButton() {
  const hasItems = items.length > 0;
  compareBtnEl.disabled = !hasItems || !receiptFile;
  if (!hasItems) {
    compareBtnEl.textContent = "Comparer (ajoute un article d'abord)";
  } else {
    const total = items.reduce((sum, item) => sum + item.shelfPrice, 0);
    compareBtnEl.textContent = `Comparer ${items.length} article${items.length > 1 ? "s" : ""} (${total.toLocaleString("fr-FR")} XPF)`;
  }
}

receiptSlotEl.addEventListener("click", () => {
  if (items.length === 0) return;
  receiptInputEl.click();
});

receiptInputEl.addEventListener("change", async () => {
  const file = receiptInputEl.files?.[0];
  if (!file) return;
  const compressed = await compressImageFile(file);
  receiptFile = compressed;
  const url = URL.createObjectURL(compressed);
  receiptPreviewEl.src = url;
  receiptPreviewEl.hidden = false;
  receiptPlaceholderEl.hidden = true;
  receiptRemoveEl.hidden = false;
  updateCompareButton();
});

receiptRemoveEl.addEventListener("click", () => {
  receiptFile = null;
  receiptInputEl.value = "";
  receiptPreviewEl.hidden = true;
  receiptPlaceholderEl.hidden = false;
  receiptRemoveEl.hidden = true;
  updateCompareButton();
});

compareBtnEl.addEventListener("click", async () => {
  if (!receiptFile || items.length === 0) return;
  compareBtnEl.disabled = true;
  compareBtnEl.textContent = "Comparaison en cours...";
  compareErrorEl.hidden = true;

  try {
    const payloadItems = items.map((item) => ({
      id: item.id,
      name: item.name,
      shelfPrice: item.shelfPrice,
    }));
    const result = await matchReceiptPhoto(receiptFile, payloadItems);
    renderResult(result);

    for (const item of items) recordItemUsage(item.name, item.shelfPrice);
    renderFrequentChips();

    const mismatchCount = result.lines.filter((line) => line.status === "mismatch").length;
    saveTrip({
      id: makeId(),
      date: new Date().toISOString(),
      itemCount: items.length,
      totalShelf: result.totalShelf,
      totalReceipt: result.totalReceiptMatched,
      totalDifference: result.totalDifference,
      mismatchCount,
    });
    renderHistory();

    // Hide the input flow, show only the result + a "start over" affordance.
    $("add-item-panel").hidden = true;
    ticketSectionEl.hidden = true;
    receiptSectionEl.hidden = true;
  } catch (err) {
    compareErrorEl.hidden = false;
    compareErrorEl.textContent = err instanceof Error ? err.message : "Une erreur est survenue.";
  } finally {
    updateCompareButton();
  }
});

// ---------------------------------------------------------------------------
// Result
// ---------------------------------------------------------------------------

function renderResult(result) {
  const hasMismatch = result.lines.some((line) => line.status === "mismatch");
  const hasInconclusive = result.lines.some((line) => line.status === "inconclusive");

  let bannerClass = "ok";
  let icon = "✅";
  let title = "Ticket conforme";
  if (hasMismatch) {
    bannerClass = "mismatch";
    icon = "⚠️";
    title = "Écart de prix détecté";
  } else if (hasInconclusive) {
    bannerClass = "mismatch";
    icon = "❔";
    title = "Vérification incomplète";
  }

  const summary = document.createElement("div");
  summary.className = `result-summary ${bannerClass}`;
  summary.innerHTML = `
    <p class="result-title">
      <span>${icon}</span>
      <span>${title}</span>
    </p>
    <p>Total rayon : ${formatXpf(result.totalShelf)} · Total ticket : ${formatXpf(result.totalReceiptMatched)}</p>
    ${hasMismatch ? `<p style="font-weight:600;color:var(--tt-coral)">Écart : +${formatXpf(result.totalDifference)}</p>` : ""}
    ${
      !hasMismatch && hasInconclusive
        ? `<p>Au moins un article n'a pas pu être retrouvé sur le ticket avec certitude, vérifie-le à l'oeil sur la photo.</p>`
        : ""
    }
  `;

  const linesCard = document.createElement("div");
  linesCard.className = "card";
  const linesList = document.createElement("div");
  for (const line of result.lines) {
    const row = document.createElement("div");
    row.className = "result-line";
    const statusClass =
      line.status === "mismatch"
        ? "status-mismatch"
        : line.status === "match"
          ? "status-match"
          : "status-inconclusive";
    row.innerHTML = `
      <div>
        <div>${line.name}</div>
        ${line.receiptLineText ? `<div class="hint-text">Ticket : ${line.receiptLineText}</div>` : ""}
      </div>
      <div class="amounts">
        <span>${formatXpf(line.shelfPrice)}</span>
        <span>&#8594;</span>
        <span class="${statusClass}">${formatXpf(line.receiptPrice)}</span>
      </div>
    `;
    linesList.appendChild(row);
  }
  linesCard.appendChild(linesList);

  if (result.unmatchedReceiptLines?.length > 0) {
    const extra = document.createElement("div");
    extra.style.marginTop = "12px";
    extra.style.paddingTop = "12px";
    extra.style.borderTop = "1px solid rgba(14,58,69,0.1)";
    extra.innerHTML = `
      <p class="hint-text">Autres lignes du ticket non rapprochées :</p>
      <p class="hint-text">${result.unmatchedReceiptLines.join(", ")}</p>
    `;
    linesCard.appendChild(extra);
  }

  const startOverBtn = document.createElement("button");
  startOverBtn.type = "button";
  startOverBtn.className = "btn btn-outline btn-block";
  startOverBtn.textContent = "Nouveau trajet";
  startOverBtn.addEventListener("click", startOver);

  resultSectionEl.innerHTML = "";
  resultSectionEl.hidden = false;

  if (hasMismatch) {
    const notice = document.createElement("div");
    notice.className = "card";
    notice.innerHTML = `
      <p style="margin:0;font-size:14px;line-height:1.6;">
        Au moins un prix facturé dépasse le prix affiché en rayon. En vertu de l'arrêté n°170
        CM, tu es en droit de demander l'application du prix affiché : présente cette
        comparaison au service client ou à la caisse.
      </p>
    `;
    resultSectionEl.append(summary, linesCard, notice, startOverBtn);
  } else {
    resultSectionEl.append(summary, linesCard, startOverBtn);
  }
}

function startOver() {
  items = [];
  receiptFile = null;
  receiptInputEl.value = "";
  receiptPreviewEl.hidden = true;
  receiptPlaceholderEl.hidden = false;
  receiptRemoveEl.hidden = true;
  compareErrorEl.hidden = true;
  resultSectionEl.hidden = true;
  resultSectionEl.innerHTML = "";
  $("add-item-panel").hidden = false;
  resetDraft();
  renderTicket();
  renderReceiptSection();
}

// ---------------------------------------------------------------------------
// History
// ---------------------------------------------------------------------------

function renderHistory() {
  const trips = getTrips();
  if (trips.length === 0) {
    historySectionEl.hidden = true;
    return;
  }
  historySectionEl.hidden = false;
  historyListEl.innerHTML = "";
  for (const trip of trips) {
    const li = document.createElement("li");
    const date = new Date(trip.date);
    const dateLabel = date.toLocaleDateString("fr-FR", {
      day: "2-digit",
      month: "short",
      hour: "2-digit",
      minute: "2-digit",
    });
    const detailLabel =
      trip.mismatchCount > 0
        ? `${trip.itemCount} article${trip.itemCount > 1 ? "s" : ""}, ${trip.mismatchCount} écart${trip.mismatchCount > 1 ? "s" : ""}`
        : `${trip.itemCount} article${trip.itemCount > 1 ? "s" : ""}, conforme`;
    const diffColor = trip.totalDifference > 0 ? "var(--tt-coral)" : "var(--tt-teal)";
    const diffLabel = `${trip.totalDifference > 0 ? "+" : ""}${trip.totalDifference.toLocaleString("fr-FR")} XPF`;

    li.innerHTML = `
      <div>
        <div>${dateLabel}</div>
        <div class="hint-text">${detailLabel}</div>
      </div>
      <span style="font-weight:600;color:${diffColor}">${diffLabel}</span>
    `;
    historyListEl.appendChild(li);
  }
}

historyClearEl.addEventListener("click", () => {
  clearTrips();
  renderHistory();
});

// ---------------------------------------------------------------------------
// Init
// ---------------------------------------------------------------------------

renderFrequentChips();
renderTicket();
renderReceiptSection();
renderHistory();
