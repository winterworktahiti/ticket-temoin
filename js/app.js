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

let items = []; // { id, name, unitPrice, quantity }
let receiptPhotos = []; // { id, file, previewUrl }
let pendingScanMode = null; // "shelf" | "barcode" while a photo picker is open
let weightModeOn = false;
let editingItemId = null;

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
const draftQuantityEl = $("draft-quantity");
const draftWeightToggleEl = $("draft-weight-toggle");
const draftPriceSimpleEl = $("draft-price-simple");
const draftPriceWeightEl = $("draft-price-weight");
const draftWeightKgEl = $("draft-weight-kg");
const draftPricePerKgEl = $("draft-price-per-kg");
const draftWeightTotalEl = $("draft-weight-total");

const ticketSectionEl = $("ticket-list-section");
const ticketListEl = $("ticket-list");
const ticketCountLabelEl = $("ticket-count-label");
const ticketTotalLabelEl = $("ticket-total-label");

const receiptSectionEl = $("receipt-section");
const receiptHintEl = $("receipt-hint");
const receiptPhotosEl = $("receipt-photos");
const receiptAddBtnEl = $("receipt-add-btn");
const receiptInputEl = $("receipt-input");
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

function itemTotal(item) {
  return Math.round(item.unitPrice * item.quantity);
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
    chip.addEventListener("click", () => addItem(item.name, item.price, 1));
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
  draftQuantityEl.value = "1";
  draftWeightKgEl.value = "";
  draftPricePerKgEl.value = "";
  draftWeightTotalEl.textContent = "";
  weightModeOn = false;
  editingItemId = null;
  draftPriceSimpleEl.hidden = false;
  draftPriceWeightEl.hidden = true;
  addItemChoicesEl.hidden = false;
  scanStatusEl.hidden = true;
  scanErrorEl.hidden = true;
  photoInputEl.value = "";
  pendingScanMode = null;
  $("draft-confirm").textContent = "Ajouter au ticket";
}

function showDraft(name, price) {
  addItemChoicesEl.hidden = true;
  draftNameEl.value = name ?? "";
  draftPriceEl.value = price !== null && price !== undefined ? String(price) : "";
  draftQuantityEl.value = "1";
  draftFormEl.hidden = false;
}

function editItem(id) {
  const item = items.find((i) => i.id === id);
  if (!item) return;
  editingItemId = id;
  addItemChoicesEl.hidden = true;
  weightModeOn = false;
  draftPriceSimpleEl.hidden = false;
  draftPriceWeightEl.hidden = true;
  draftNameEl.value = item.name;
  draftPriceEl.value = String(item.unitPrice);
  draftQuantityEl.value = String(item.quantity);
  draftFormEl.hidden = false;
  scanErrorEl.hidden = true;
  $("draft-confirm").textContent = "Enregistrer les modifications";
  draftFormEl.scrollIntoView({ behavior: "smooth", block: "center" });
}

draftNameEl.addEventListener("input", () => {
  if (!editingItemId && draftNameEl.value.trim().toLowerCase() === "vigile") {
    showVigileEasterEgg();
    resetDraft();
  }
});

draftWeightToggleEl.addEventListener("click", () => {
  weightModeOn = !weightModeOn;
  draftPriceSimpleEl.hidden = weightModeOn;
  draftPriceWeightEl.hidden = !weightModeOn;
});

function updateWeightTotal() {
  const weight = Number(draftWeightKgEl.value.replace(",", "."));
  const pricePerKg = Number(draftPricePerKgEl.value.replace(",", "."));
  if (weight > 0 && pricePerKg > 0) {
    const total = Math.round(weight * pricePerKg);
    draftWeightTotalEl.textContent = `Prix estimé : ${total.toLocaleString("fr-FR")} XPF`;
  } else {
    draftWeightTotalEl.textContent = "";
  }
}
draftWeightKgEl.addEventListener("input", updateWeightTotal);
draftPricePerKgEl.addEventListener("input", updateWeightTotal);

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
  let addedDirectly = false;

  try {
    const compressed = await compressImageFile(file);
    const result = await scanItemPhoto(compressed, mode);

    if (result.readable && result.name && result.price) {
      // Confident read: add straight to the ticket, no confirmation step.
      // Mistakes can still be fixed with "Modifier" on the ticket line.
      addItem(result.name, Math.round(result.price), 1);
      scanStatusEl.textContent = `Ajouté : ${result.name} · ${Math.round(result.price).toLocaleString("fr-FR")} XPF`;
      photoInputEl.value = "";
      pendingScanMode = null;
      addedDirectly = true;
      setTimeout(() => {
        scanStatusEl.hidden = true;
      }, 2000);
    } else {
      scanErrorEl.hidden = false;
      scanErrorEl.textContent =
        "Rien de lisible sur cette photo. Tu peux compléter à la main ci-dessous.";
      showDraft(result.name ?? "", result.price ?? "");
    }
  } catch (err) {
    scanErrorEl.hidden = false;
    scanErrorEl.textContent = err instanceof Error ? err.message : "La lecture a échoué.";
    showDraft("", "");
  } finally {
    if (!addedDirectly) scanStatusEl.hidden = true;
  }
});

$("draft-cancel").addEventListener("click", resetDraft);

$("draft-confirm").addEventListener("click", () => {
  const name = draftNameEl.value.trim();
  if (!name) return;

  if (!editingItemId && name.toLowerCase() === "vigile") {
    showVigileEasterEgg();
    resetDraft();
    return;
  }

  let unitPrice;
  let quantity = Math.max(1, Math.round(Number(draftQuantityEl.value)) || 1);

  if (weightModeOn) {
    const weight = Number(draftWeightKgEl.value.replace(",", "."));
    const pricePerKg = Number(draftPricePerKgEl.value.replace(",", "."));
    if (!(weight > 0) || !(pricePerKg > 0)) return;
    unitPrice = Math.round(weight * pricePerKg);
    quantity = 1; // a weighed item is its own single line, not a discrete unit count
  } else {
    unitPrice = Number(draftPriceEl.value.replace(",", "."));
    if (Number.isNaN(unitPrice) || unitPrice <= 0) return;
    unitPrice = Math.round(unitPrice);
  }

  if (editingItemId) {
    const item = items.find((i) => i.id === editingItemId);
    if (item) {
      item.name = name;
      item.unitPrice = unitPrice;
      item.quantity = quantity;
      renderTicket();
      renderReceiptSection();
    }
  } else {
    addItem(name, unitPrice, quantity);
  }
  resetDraft();
});

function addItem(name, unitPrice, quantity = 1) {
  if (name.trim().toLowerCase() === "vigile") {
    showVigileEasterEgg();
    return;
  }
  const existing = items.find(
    (item) => item.name.toLowerCase() === name.toLowerCase() && item.unitPrice === unitPrice,
  );
  if (existing) {
    existing.quantity += quantity;
  } else {
    items.push({ id: makeId(), name, unitPrice, quantity });
  }
  renderTicket();
  renderReceiptSection();
}

function showVigileEasterEgg() {
  $("vigile-easter-egg").hidden = false;
}

function removeItem(id) {
  items = items.filter((item) => item.id !== id);
  renderTicket();
  renderReceiptSection();
}

function changeItemQuantity(id, delta) {
  const item = items.find((i) => i.id === id);
  if (!item) return;
  item.quantity += delta;
  if (item.quantity <= 0) {
    removeItem(id);
    return;
  }
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
  const total = items.reduce((sum, item) => sum + itemTotal(item), 0);
  ticketCountLabelEl.textContent = `Ticket en cours (${items.length} article${items.length > 1 ? "s" : ""})`;
  ticketTotalLabelEl.textContent = `${total.toLocaleString("fr-FR")} XPF`;

  ticketListEl.innerHTML = "";
  for (const item of items) {
    const li = document.createElement("li");
    const nameWrap = document.createElement("div");
    const nameSpan = document.createElement("div");
    nameSpan.textContent = item.name;
    nameWrap.appendChild(nameSpan);
    if (item.quantity > 1) {
      const unitHint = document.createElement("div");
      unitHint.className = "hint-text";
      unitHint.textContent = `${item.unitPrice.toLocaleString("fr-FR")} XPF x ${item.quantity}`;
      nameWrap.appendChild(unitHint);
    }

    const priceWrap = document.createElement("div");
    priceWrap.className = "ticket-item-price";

    const qtyWrap = document.createElement("div");
    qtyWrap.style.display = "flex";
    qtyWrap.style.alignItems = "center";
    qtyWrap.style.gap = "6px";
    const minusBtn = document.createElement("button");
    minusBtn.type = "button";
    minusBtn.className = "qty-btn";
    minusBtn.textContent = "−";
    minusBtn.addEventListener("click", () => changeItemQuantity(item.id, -1));
    const qtyLabel = document.createElement("span");
    qtyLabel.textContent = String(item.quantity);
    const plusBtn = document.createElement("button");
    plusBtn.type = "button";
    plusBtn.className = "qty-btn";
    plusBtn.textContent = "+";
    plusBtn.addEventListener("click", () => changeItemQuantity(item.id, 1));
    qtyWrap.append(minusBtn, qtyLabel, plusBtn);

    const priceSpan = document.createElement("span");
    priceSpan.textContent = `${itemTotal(item).toLocaleString("fr-FR")} XPF`;
    const editBtn = document.createElement("button");
    editBtn.type = "button";
    editBtn.className = "link-btn";
    editBtn.style.color = "var(--tt-navy)";
    editBtn.textContent = "Modifier";
    editBtn.addEventListener("click", () => editItem(item.id));
    const removeBtn = document.createElement("button");
    removeBtn.type = "button";
    removeBtn.className = "link-btn";
    removeBtn.textContent = "Retirer";
    removeBtn.addEventListener("click", () => removeItem(item.id));

    priceWrap.append(qtyWrap, priceSpan, editBtn, removeBtn);
    li.append(nameWrap, priceWrap);
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
    ? "Une ou plusieurs photos du ticket suffisent, l'IA retrouve chaque article."
    : "Ajoute d'abord au moins un article ci-dessus pour débloquer cette étape.";
  receiptAddBtnEl.disabled = !hasItems || receiptPhotos.length >= 6;
  updateCompareButton();
}

function renderReceiptPhotos() {
  receiptPhotosEl.innerHTML = "";
  for (const photo of receiptPhotos) {
    const thumb = document.createElement("div");
    thumb.className = "receipt-thumb";
    const img = document.createElement("img");
    img.src = photo.previewUrl;
    const removeBtn = document.createElement("button");
    removeBtn.type = "button";
    removeBtn.className = "receipt-thumb-remove";
    removeBtn.textContent = "✕";
    removeBtn.addEventListener("click", () => removeReceiptPhoto(photo.id));
    thumb.append(img, removeBtn);
    receiptPhotosEl.appendChild(thumb);
  }
}

function removeReceiptPhoto(id) {
  receiptPhotos = receiptPhotos.filter((photo) => photo.id !== id);
  renderReceiptPhotos();
  renderReceiptSection();
}

function updateCompareButton() {
  const hasItems = items.length > 0;
  const hasPhotos = receiptPhotos.length > 0;
  compareBtnEl.disabled = !hasItems || !hasPhotos;
  if (!hasItems) {
    compareBtnEl.textContent = "Comparer (ajoute un article d'abord)";
  } else if (!hasPhotos) {
    compareBtnEl.textContent = "Comparer (ajoute une photo du ticket d'abord)";
  } else {
    const total = items.reduce((sum, item) => sum + itemTotal(item), 0);
    compareBtnEl.textContent = `Comparer ${items.length} article${items.length > 1 ? "s" : ""} (${total.toLocaleString("fr-FR")} XPF)`;
  }
}

receiptAddBtnEl.addEventListener("click", () => {
  if (items.length === 0 || receiptPhotos.length >= 6) return;
  receiptInputEl.click();
});

receiptInputEl.addEventListener("change", async () => {
  const file = receiptInputEl.files?.[0];
  if (!file) return;
  const compressed = await compressImageFile(file);
  receiptPhotos.push({
    id: makeId(),
    file: compressed,
    previewUrl: URL.createObjectURL(compressed),
  });
  receiptInputEl.value = "";
  renderReceiptPhotos();
  renderReceiptSection();
});

compareBtnEl.addEventListener("click", async () => {
  if (receiptPhotos.length === 0 || items.length === 0) return;
  compareBtnEl.disabled = true;
  compareBtnEl.textContent = "Comparaison en cours...";
  compareErrorEl.hidden = true;

  try {
    const payloadItems = items.map((item) => ({
      id: item.id,
      name: item.name,
      shelfPrice: itemTotal(item),
      quantity: item.quantity,
    }));
    const result = await matchReceiptPhoto(
      receiptPhotos.map((photo) => photo.file),
      payloadItems,
    );
    renderResult(result);

    for (const item of items) recordItemUsage(item.name, item.unitPrice);
    renderFrequentChips();

    const mismatchCount = result.lines.filter((line) => line.status === "mismatch").length;
    const inconclusiveCount = result.lines.filter((line) => line.status === "inconclusive").length;
    saveTrip({
      id: makeId(),
      date: new Date().toISOString(),
      itemCount: items.length,
      totalShelf: result.totalShelf,
      totalReceipt: result.totalReceiptMatched,
      totalDifference: result.totalDifference,
      mismatchCount,
      inconclusiveCount,
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
  startOverBtn.textContent = "Nouvelle liste";
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
  receiptPhotos = [];
  receiptInputEl.value = "";
  renderReceiptPhotos();
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
    const inconclusiveCount = trip.inconclusiveCount ?? 0;
    let detailLabel;
    if (trip.mismatchCount > 0) {
      detailLabel = `${trip.itemCount} article${trip.itemCount > 1 ? "s" : ""}, ${trip.mismatchCount} écart${trip.mismatchCount > 1 ? "s" : ""}`;
    } else if (inconclusiveCount > 0) {
      detailLabel = `${trip.itemCount} article${trip.itemCount > 1 ? "s" : ""}, vérification incomplète`;
    } else {
      detailLabel = `${trip.itemCount} article${trip.itemCount > 1 ? "s" : ""}, conforme`;
    }
    const diffColor =
      trip.mismatchCount > 0
        ? "var(--tt-coral)"
        : inconclusiveCount > 0
          ? "var(--tt-ink)"
          : "var(--tt-teal)";
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

$("vigile-close").addEventListener("click", () => {
  $("vigile-easter-egg").hidden = true;
});

$("vigile-icon-btn").addEventListener("click", () => {
  showVigileEasterEgg();
});

// ---------------------------------------------------------------------------
// Init
// ---------------------------------------------------------------------------

renderFrequentChips();
renderTicket();
renderReceiptSection();
renderHistory();
