const $ = (id) => document.getElementById(id);

const searchInput = $("search-input");
const searchStatus = $("search-status");
const searchResults = $("search-results");
const searchEmpty = $("search-empty");
const compareSection = $("compare-section");
const compareTitle = $("compare-title");
const compareResults = $("compare-results");
const compareEmpty = $("compare-empty");

let debounceTimer = null;

searchInput.addEventListener("input", () => {
  clearTimeout(debounceTimer);
  const q = searchInput.value.trim();
  searchResults.innerHTML = "";
  searchEmpty.hidden = true;
  compareSection.hidden = true;

  if (q.length < 2) {
    searchStatus.hidden = true;
    return;
  }

  searchStatus.hidden = false;
  debounceTimer = setTimeout(() => runSearch(q), 350);
});

async function runSearch(q) {
  try {
    const res = await fetch(`/api/price-search?q=${encodeURIComponent(q)}`);
    const payload = await res.json();
    searchStatus.hidden = true;

    const products = payload?.data?.products ?? [];
    if (products.length === 0) {
      searchEmpty.hidden = false;
      return;
    }

    for (const product of products) {
      const li = document.createElement("li");
      const btn = document.createElement("button");
      btn.type = "button";
      btn.className = "btn btn-outline btn-block";
      btn.style.textAlign = "left";
      btn.textContent = product.name;
      btn.addEventListener("click", () => showComparison(product.barcode, product.name));
      li.style.padding = "4px 0";
      li.appendChild(btn);
      searchResults.appendChild(li);
    }
  } catch {
    searchStatus.hidden = true;
    searchEmpty.hidden = false;
  }
}

async function showComparison(barcode, name) {
  compareSection.hidden = false;
  compareTitle.textContent = `Comparaison : ${name}`;
  compareResults.innerHTML = "";
  compareEmpty.hidden = true;
  compareSection.scrollIntoView({ behavior: "smooth", block: "start" });

  try {
    const res = await fetch(`/api/price-compare?barcode=${encodeURIComponent(barcode)}`);
    const payload = await res.json();
    const stores = payload?.data?.stores ?? [];

    if (stores.length === 0) {
      compareEmpty.hidden = false;
      return;
    }

    stores.forEach((entry, index) => {
      const li = document.createElement("li");
      const dateLabel = new Date(entry.date).toLocaleDateString("fr-FR", {
        day: "2-digit",
        month: "short",
      });
      li.innerHTML = `
        <div>
          <div>${index === 0 ? "🏆 " : ""}${entry.store}</div>
          <div class="hint-text">Relevé le ${dateLabel}</div>
        </div>
        <span style="font-weight:700;color:${index === 0 ? "var(--tt-teal)" : "var(--tt-navy)"}">
          ${entry.price.toLocaleString("fr-FR")} XPF
        </span>
      `;
      compareResults.appendChild(li);
    });
  } catch {
    compareEmpty.hidden = false;
  }
}
