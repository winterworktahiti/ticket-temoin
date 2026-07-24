// Cloudflare Worker (unified Workers + static assets model, 2026).
// Static files (index.html, css/, js/) are served via the ASSETS binding,
// configured in wrangler.jsonc. This script only handles the two API
// routes; wrangler.jsonc's assets.run_worker_first sends /api/* here first,
// everything else falls straight through to the static assets binding.

const SHELF_PROMPT = `Tu regardes une photo d'une étiquette de prix en rayon dans un supermarché de Polynésie française.

Important sur le format des prix : la monnaie est le Franc Pacifique (XPF), qui n'a PAS de centimes (toujours un nombre entier). Sur les étiquettes, un POINT dans le prix est un SÉPARATEUR DE MILLIERS, jamais une virgule décimale. Par exemple, un prix affiché "3.950" signifie 3950 XPF, PAS 3,95 ni 4. Un prix affiché "1.200" signifie 1200 XPF. Ne divise et n'arrondis jamais un prix à cause d'un point : retire simplement le point pour obtenir le nombre entier.

Réponds UNIQUEMENT avec un objet JSON strict, sans texte autour :
{
  "name": string|null,
  "price": number|null,
  "barcode": null,
  "readable": boolean
}`;

const BARCODE_PROMPT = `Tu regardes une photo d'un produit de supermarché avec son code-barre visible.
Extrais : 1) la suite de chiffres du code-barre (EAN-13, EAN-8 ou UPC) si lisible, 2) le nom du produit si visible sur l'emballage autour.
Réponds UNIQUEMENT avec un objet JSON strict, sans texte autour :
{
  "name": string|null,
  "price": null,
  "barcode": string|null,
  "readable": boolean
}`;

function jsonResponse(body, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

function bytesToBase64(bytes) {
  let binary = "";
  const chunkSize = 0x8000;
  for (let i = 0; i < bytes.length; i += chunkSize) {
    binary += String.fromCharCode(...bytes.subarray(i, i + chunkSize));
  }
  return btoa(binary);
}

const VISION_PROVIDERS = {
  qwen: {
    envKey: "QWEN_API_KEY",
    baseUrl: (env) => env.QWEN_BASE_URL || "https://dashscope-intl.aliyuncs.com/compatible-mode/v1",
    model: "qwen3-vl-flash",
    label: "Qwen",
  },
  gemini: {
    envKey: "GEMINI_API_KEY",
    baseUrl: () => "https://generativelanguage.googleapis.com/v1beta/openai",
    model: "gemini-3.1-flash-lite",
    label: "Gemini",
  },
};

async function callVisionModel(env, { provider = "qwen", systemPrompt, userText, images, maxTokens = 2000 }) {
  const config = VISION_PROVIDERS[provider] || VISION_PROVIDERS.qwen;
  const apiKey = env[config.envKey];
  if (!apiKey) {
    throw new Error(`La clé ${config.label} n'est pas configurée côté serveur (variable ${config.envKey}).`);
  }
  const baseUrl = config.baseUrl(env);

  const content = [{ type: "text", text: userText }];
  for (const image of images) {
    const dataUrl = `data:${image.type};base64,${bytesToBase64(image.bytes)}`;
    content.push({ type: "image_url", image_url: { url: dataUrl } });
  }

  const response = await fetch(`${baseUrl}/chat/completions`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${apiKey}`,
    },
    body: JSON.stringify({
      model: config.model,
      messages: [
        { role: "system", content: systemPrompt },
        { role: "user", content },
      ],
      temperature: 0.1,
      max_tokens: maxTokens,
      response_format: { type: "json_object" },
    }),
  });

  if (!response.ok) {
    const bodyText = await response.text().catch(() => "");
    throw new Error(`Erreur ${config.label} (${response.status}). ${bodyText.slice(0, 300)}`);
  }

  const json = await response.json();
  const rawContent = (json.choices?.[0]?.message?.content ?? "").trim();
  try {
    return JSON.parse(rawContent);
  } catch {
    // Defense-in-depth: json_object mode should return pure JSON, but if the
    // provider still wraps it in markdown fences or a preamble, try to
    // salvage the first {...} block before giving up.
  }
  const jsonMatch = rawContent.match(/\{[\s\S]*\}/);
  if (!jsonMatch) {
    throw new Error(`Réponse ${config.label} illisible. Réessaie avec une photo plus nette.`);
  }
  try {
    return JSON.parse(jsonMatch[0]);
  } catch {
    throw new Error(`Réponse ${config.label} mal formée. Réessaie avec une photo plus nette.`);
  }
}

async function lookupOpenFoodFacts(barcode) {
  try {
    const response = await fetch(
      `https://world.openfoodfacts.org/api/v2/product/${barcode}.json`,
      { signal: AbortSignal.timeout(4000) },
    );
    if (!response.ok) return null;
    const json = await response.json();
    const name = json.product?.product_name_fr || json.product?.product_name;
    return json.status === 1 && name ? name : null;
  } catch {
    return null;
  }
}

async function handleScan(request, env) {
  try {
    const form = await request.formData();
    const file = form.get("image");
    const mode = form.get("mode");

    if (!(file instanceof File)) {
      return jsonResponse({ ok: false, error: "Aucune image reçue." }, 400);
    }
    if (mode !== "shelf" && mode !== "barcode") {
      return jsonResponse({ ok: false, error: "Mode de scan invalide." }, 400);
    }

    const bytes = new Uint8Array(await file.arrayBuffer());
    if (bytes.byteLength === 0) {
      return jsonResponse({ ok: false, error: "Image vide, reprends la photo." }, 400);
    }
    if (bytes.byteLength > 8_000_000) {
      return jsonResponse({ ok: false, error: "Photo trop lourde, reprends-la." }, 413);
    }

    const isBarcode = mode === "barcode";
    const provider = form.get("provider") === "gemini" ? "gemini" : "qwen";
    const parsed = await callVisionModel(env, {
      provider,
      systemPrompt: isBarcode ? BARCODE_PROMPT : SHELF_PROMPT,
      userText: isBarcode ? "Photo du produit et de son code-barre :" : "Photo de l'étiquette prix :",
      images: [{ bytes, type: file.type || "image/jpeg" }],
    });

    let data = {
      name: typeof parsed.name === "string" ? parsed.name : null,
      price: typeof parsed.price === "number" ? parsed.price : null,
      barcode: typeof parsed.barcode === "string" ? parsed.barcode : null,
      readable: Boolean(parsed.readable),
    };

    if (isBarcode && data.barcode) {
      const offName = await lookupOpenFoodFacts(data.barcode);
      if (offName) data = { ...data, name: offName, readable: true };
    }

    return jsonResponse({ ok: true, data });
  } catch (err) {
    return jsonResponse(
      { ok: false, error: err instanceof Error ? err.message : "La lecture de la photo a échoué." },
      502,
    );
  }
}

function normalizeForCompare(text) {
  return text
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, " ")
    .trim();
}

function tokensLooselyMatch(a, b) {
  if (a === b) return true;
  // Receipt printouts routinely truncate/abbreviate words (e.g. "SANDWICHE" -> "SAND"),
  // so treat a >=3 char prefix match either way as the same word.
  if (a.length >= 3 && b.length >= 3 && (a.startsWith(b) || b.startsWith(a))) return true;
  return false;
}

function nameSimilarity(a, b) {
  const tokensA = [...new Set(normalizeForCompare(a).split(" ").filter((t) => t.length > 1))];
  const tokensB = [...new Set(normalizeForCompare(b).split(" ").filter((t) => t.length > 1))];
  if (tokensA.length === 0 || tokensB.length === 0) return 0;
  let shared = 0;
  for (const ta of tokensA) if (tokensB.some((tb) => tokensLooselyMatch(ta, tb))) shared += 1;
  return shared / Math.max(tokensA.length, tokensB.length);
}

// The model assigns each basket item its receipt line independently, so it can
// end up giving the same receipt line to two different items (one right, one
// wrong), producing a false price mismatch on the wrong one. Detect any
// receipt_line_text reused across items with different ids, keep it only for
// the item whose name is textually closest to that line, and null out the rest
// so they show as inconclusive instead of a fabricated mismatch.
function resolveDuplicateReceiptAssignments(matches, items) {
  const itemById = new Map(items.map((item) => [item.id, item]));
  const groups = new Map();

  for (const match of matches) {
    if (typeof match.receipt_line_text !== "string" || !match.receipt_line_text.trim()) continue;
    if (typeof match.receipt_price !== "number") continue;
    // Key on text + price: two cart entries for the same product bought
    // separately (e.g. two weighed items) can legitimately share identical
    // printed text at different prices — that's not a conflict. Only an
    // identical (text, price) pair reused across different items is the
    // actual bug we're guarding against.
    const key = `${normalizeForCompare(match.receipt_line_text)}|${match.receipt_price}`;
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(match);
  }

  for (const group of groups.values()) {
    if (group.length < 2) continue;
    let best = null;
    let bestScore = -1;
    for (const match of group) {
      const item = itemById.get(match.id);
      const score = item ? nameSimilarity(item.name, match.receipt_line_text) : 0;
      if (score > bestScore) {
        bestScore = score;
        best = match;
      }
    }
    for (const match of group) {
      if (match === best) continue;
      match.receipt_price = null;
      match.receipt_line_text = null;
    }
  }

  // Beyond duplicate reuse, also catch outright hallucinated matches: if the
  // assigned receipt line shares not a single word (even truncated) with the
  // item's own name, it's not a real match — drop it rather than show a
  // fabricated price gap.
  for (const match of matches) {
    if (typeof match.receipt_line_text !== "string" || !match.receipt_line_text.trim()) continue;
    const item = itemById.get(match.id);
    if (!item) continue;
    if (nameSimilarity(item.name, match.receipt_line_text) === 0) {
      match.receipt_price = null;
      match.receipt_line_text = null;
    }
  }

  return matches;
}

const DEPARTMENT_HEADERS = new Set([
  "cremerie",
  "epicerie",
  "fromage",
  "fromages",
  "fruits et legumes",
  "poissonnerie",
  "boucherie",
  "charcuterie",
  "parfumerie",
  "hygiene",
  "boissons",
  "surgeles",
  "liquides",
  "entretien",
  "bazar",
  "textile",
  "jouet",
  "jouets",
  "papeterie",
  "bebe",
  "boulangerie",
  "patisserie",
]);

const FOOTER_LINE_PREFIXES = [
  "total",
  "sous total",
  "sous-total",
  "nb article",
  "nombre article",
  "especes",
  "cheque",
  "carte bancaire",
  "cb",
  "rendu",
  "monnaie",
  "net a payer",
  "montant",
  "tva",
  "merci",
];

function isNoiseReceiptLine(text) {
  if (typeof text !== "string") return true;
  const trimmed = text.trim();
  if (!trimmed) return true;
  // Pure digit/reference string (barcode), no letters at all.
  if (!/[a-zA-Z]/.test(trimmed) && /\d/.test(trimmed)) return true;
  const normalized = normalizeForCompare(trimmed);
  // A bare department/section header with nothing else on the line.
  if (DEPARTMENT_HEADERS.has(normalized)) return true;
  // A bare weight or quantity calculation, with no product name of its own —
  // these should have been merged into their product line; when the model
  // leaks them separately anyway, they're never a standalone real item.
  if (/^\d+[.,]?\d*\s*kg\s*[x×]\s*\d+[.,]?\d*\s*f(\s*\/\s*kg)?$/i.test(trimmed)) return true;
  if (/^\d+\s*[x×]\s*\d+[.,]?\d*\s*f$/i.test(trimmed)) return true;
  // Receipt footer / payment lines (total, card, change...), not products.
  if (FOOTER_LINE_PREFIXES.some((prefix) => normalized === prefix || normalized.startsWith(`${prefix} `))) {
    return true;
  }
  return false;
}

async function handleMatch(request, env, ctx) {
  try {
    const form = await request.formData();
    const files = form.getAll("receipt").filter((entry) => entry instanceof File);
    const itemsRaw = form.get("items");
    const provider = form.get("provider") === "gemini" ? "gemini" : "qwen";

    if (files.length === 0) {
      return jsonResponse({ ok: false, error: "Aucune photo de ticket reçue." }, 400);
    }
    if (files.length > 6) {
      return jsonResponse({ ok: false, error: "Maximum 6 photos par ticket." }, 400);
    }
    if (typeof itemsRaw !== "string") {
      return jsonResponse({ ok: false, error: "Liste d'articles manquante." }, 400);
    }

    let items;
    try {
      items = JSON.parse(itemsRaw);
      if (!Array.isArray(items) || items.length === 0) throw new Error("empty");
      for (const item of items) {
        if (typeof item.id !== "string" || typeof item.name !== "string" || typeof item.shelfPrice !== "number") {
          throw new Error("shape");
        }
      }
    } catch {
      return jsonResponse({ ok: false, error: "Liste d'articles invalide." }, 400);
    }

    const images = [];
    let totalBytes = 0;
    for (const file of files) {
      const bytes = new Uint8Array(await file.arrayBuffer());
      if (bytes.byteLength === 0) {
        return jsonResponse({ ok: false, error: "Une des photos est vide, reprends-la." }, 400);
      }
      totalBytes += bytes.byteLength;
      images.push({ bytes, type: file.type || "image/jpeg" });
    }
    if (totalBytes > 20_000_000) {
      return jsonResponse({ ok: false, error: "Photos trop lourdes au total, reprends-les." }, 413);
    }

    const itemsDescription = items
      .map((item) => {
        const qty = typeof item.quantity === "number" && item.quantity > 1 ? ` (quantité: ${item.quantity})` : "";
        return `- id="${item.id}" nom="${item.name}" prix_total_attendu=${item.shelfPrice}${qty}`;
      })
      .join("\n");

    const multiPhotoNote =
      images.length > 1
        ? `\nCe ticket a été photographié en ${images.length} photos successives (le même ticket, des portions différentes : haut, milieu, bas). Traite-les comme un seul ticket continu : ne compte pas deux fois une ligne qui apparaîtrait à la jonction de deux photos.\n`
        : "";

    const systemPrompt = `Tu compares un ticket de courses (constitué en rayon) avec ${images.length > 1 ? "les photos" : "la photo"} du ticket de caisse final, pour un outil de vérification de prix en Polynésie française (arrêté n°170 CM du 7 février 1992).
${multiPhotoNote}
Voici les articles du panier. "prix_total_attendu" est le prix TOTAL attendu pour cet article (déjà multiplié par la quantité si elle est indiquée) :
${itemsDescription}

Procède en deux temps, dans cet ordre :
1. Transcris D'ABORD toutes les lignes PRODUIT du ticket de caisse que tu peux lire sur l'ensemble des photos, avec leur prix exact (en XPF, entier, sans symbole). N'inclus dans "receipt_lines" QUE des lignes produit ayant un nom et un prix propres. Exclus explicitement, et ne les fais apparaître NULLE PART dans ta réponse (ni receipt_lines, ni matches, ni unmatched_receipt_lines) :
   - les lignes qui ne sont qu'une suite de chiffres (code-barre / référence article), sans texte produit ni prix ;
   - les intitulés de rayon en majuscules qui servent de titre de section (ex : "CREMERIE", "EPICERIE", "FROMAGE", "FRUITS ET LEGUMES", "POISSONNERIE", "PARFUMERIE", "BOISSONS"), reconnaissables au fait qu'ils n'ont pas de prix à côté et précèdent souvent un simple trait horizontal.
   Sous certaines lignes produit, le ticket imprime une ligne de calcul juste en dessous, sans nom de produit propre — par exemple "0.xxx kg x yyy F/kg" (article au poids) ou "N x yyy F" (déclinaison de la quantité et du prix unitaire). Ces lignes de calcul ne sont PAS des articles séparés : elles appartiennent à la ligne produit juste au-dessus et doivent être fusionnées avec elle en une seule entrée de "receipt_lines" (garde le nom du produit comme texte, et le prix total déjà indiqué sur la ligne produit comme prix — ne resomme pas). Sois exhaustif sur les VRAIS articles, ne saute aucune ligne produit même si elle te semble déjà correspondre à un article du panier. Important sur le format : le XPF n'a PAS de centimes ; un point dans un prix imprimé est un séparateur de milliers, jamais une virgule décimale (ex: "3.950" veut dire 3950, pas 3,95 ni 4).
2. Ensuite seulement, pour CHAQUE article du panier ci-dessus, retrouve dans ta transcription la ou les lignes qui correspondent (par similarité de nom, même si l'intitulé de caisse est abrégé ou tronqué). Si une quantité est indiquée pour l'article, le ticket peut soit répéter la ligne plusieurs fois (additionne alors leurs prix), soit n'avoir qu'une seule ligne dont le prix reflète déjà le total pour cette quantité : dans les deux cas, "receipt_price" doit être le prix TOTAL correspondant à la quantité entière de cet article, comparable directement à "prix_total_attendu". N'invente jamais un prix : si après une lecture attentive aucune ligne ne correspond clairement, mets receipt_price à null plutôt que de deviner.
IMPORTANT — une ligne de ticket ne peut servir qu'à UN SEUL article du panier (sauf répétition légitime pour une quantité du MÊME article). N'assigne jamais la même "receipt_line_text" à deux articles différents du panier : si deux articles semblent proches d'une même ligne, ne l'attribue qu'au plus proche par le nom et laisse "receipt_price" à null pour l'autre. Ne rapproche jamais deux intitulés dont les mots-clés produits ne correspondent pas (ex : "citron" ne correspond pas à "eau", "haricot" ne correspond pas à "liquide").

Réponds UNIQUEMENT avec un objet JSON strict, sans texte autour, au format exact :
{
  "receipt_lines": [ { "text": string, "price": number } ],
  "matches": [
    { "id": string, "receipt_price": number|null, "receipt_line_text": string|null }
  ],
  "unmatched_receipt_lines": string[]
}
"receipt_lines" contient TOUTES les lignes lues à l'étape 1, toutes photos confondues. Le tableau "matches" doit contenir EXACTEMENT un objet par article du panier, dans le même ordre, avec le même id, en te basant sur "receipt_lines". "unmatched_receipt_lines" liste les entrées de "receipt_lines" qui ne correspondent à aucun article du panier.`;

    const parsed = await callVisionModel(env, {
      provider,
      systemPrompt,
      userText: images.length > 1 ? "Photos du ticket de caisse (une seule et même ticket) :" : "Photo du ticket de caisse :",
      images,
      // The response has to hold a full receipt transcription (receipt_lines),
      // one match object per basket item, and any leftover lines: a fixed
      // 2000-token budget truncates mid-JSON on longer shopping trips and
      // produces an unparsable response. Scale it with basket size instead.
      maxTokens: Math.min(8000, 2200 + items.length * 220),
    });

    const rawMatches = Array.isArray(parsed.matches) ? parsed.matches : [];
    const matches = resolveDuplicateReceiptAssignments(rawMatches, items);
    const unmatchedReceiptLines = (
      Array.isArray(parsed.unmatched_receipt_lines) ? parsed.unmatched_receipt_lines : []
    ).filter((line) => !isNoiseReceiptLine(line));

    const WEIGHT_TOLERANCE_RATIO = 0.15; // natural pesée variance, not a price violation
    const WEIGHT_TOLERANCE_FLOOR = 20; // XPF, so cheap weighed items aren't over-strict

    const lines = items.map((item) => {
      const match = matches.find((m) => m.id === item.id);
      const receiptPrice = typeof match?.receipt_price === "number" ? match.receipt_price : null;
      const receiptLineText = typeof match?.receipt_line_text === "string" ? match.receipt_line_text : null;

      let status = "inconclusive";
      let difference = null;
      if (receiptPrice !== null) {
        difference = receiptPrice - item.shelfPrice;
        if (item.weighed) {
          const tolerance = Math.max(item.shelfPrice * WEIGHT_TOLERANCE_RATIO, WEIGHT_TOLERANCE_FLOOR);
          status = difference > tolerance ? "mismatch" : "match";
        } else {
          status = difference > 0 ? "mismatch" : "match";
        }
      }

      return {
        id: item.id,
        name: item.name,
        shelfPrice: item.shelfPrice,
        receiptPrice,
        receiptLineText,
        status,
        difference,
      };
    });

    const matchedLines = lines.filter((l) => l.receiptPrice !== null);
    const excludedLines = lines.filter((l) => l.receiptPrice === null);
    const totalShelf = matchedLines.reduce((sum, l) => sum + l.shelfPrice, 0);
    const totalReceiptMatched = matchedLines.reduce((sum, l) => sum + l.receiptPrice, 0);
    const excludedShelfTotal = excludedLines.reduce((sum, l) => sum + l.shelfPrice, 0);

    if (ctx && env.STATS_KV) {
      ctx.waitUntil(incrementStat(env));
    }

    return jsonResponse({
      ok: true,
      data: {
        lines,
        unmatchedReceiptLines,
        totalShelf,
        totalReceiptMatched,
        totalDifference: totalReceiptMatched - totalShelf,
        excludedCount: excludedLines.length,
        excludedShelfTotal,
        provider,
      },
    });
  } catch (err) {
    return jsonResponse(
      { ok: false, error: err instanceof Error ? err.message : "La comparaison a échoué." },
      502,
    );
  }
}

const STATS_KEY = "tickets_verified_count";

async function incrementStat(env) {
  try {
    const current = await env.STATS_KV.get(STATS_KEY);
    const next = (Number(current) || 0) + 1;
    await env.STATS_KV.put(STATS_KEY, String(next));
  } catch {
    // Non-critical: never let a stats-counting failure affect the user.
  }
}

async function handleStats(env) {
  try {
    if (!env.STATS_KV) {
      return jsonResponse({ ok: true, data: { count: 0 } });
    }
    const current = await env.STATS_KV.get(STATS_KEY);
    return jsonResponse({ ok: true, data: { count: Number(current) || 0 } });
  } catch {
    return jsonResponse({ ok: true, data: { count: 0 } });
  }
}

// ---------------------------------------------------------------------------
// Price comparison (opt-in, barcode-scanned items only)
// ---------------------------------------------------------------------------

async function ensurePricesTable(db) {
  await db
    .prepare(
      `CREATE TABLE IF NOT EXISTS price_observations (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        barcode TEXT NOT NULL,
        product_name TEXT NOT NULL,
        store TEXT NOT NULL,
        price_xpf INTEGER NOT NULL,
        observed_at TEXT NOT NULL
      )`,
    )
    .run();
  await db
    .prepare(`CREATE INDEX IF NOT EXISTS idx_price_barcode ON price_observations (barcode)`)
    .run();
}

async function handlePriceContribute(request, env) {
  if (!env.PRICES_DB) {
    return jsonResponse({ ok: false, error: "Base de comparaison indisponible." }, 503);
  }
  try {
    const body = await request.json();
    const barcode = typeof body.barcode === "string" ? body.barcode.trim() : "";
    const name = typeof body.name === "string" ? body.name.trim().slice(0, 200) : "";
    const store = typeof body.store === "string" ? body.store.trim().slice(0, 100) : "";
    const price = Number(body.price);

    if (!barcode || !name || !store || !Number.isFinite(price) || price <= 0 || price > 10_000_000) {
      return jsonResponse({ ok: false, error: "Données de contribution invalides." }, 400);
    }

    await ensurePricesTable(env.PRICES_DB);
    await env.PRICES_DB.prepare(
      `INSERT INTO price_observations (barcode, product_name, store, price_xpf, observed_at) VALUES (?, ?, ?, ?, ?)`,
    )
      .bind(barcode, name, store, Math.round(price), new Date().toISOString())
      .run();

    return jsonResponse({ ok: true });
  } catch (err) {
    return jsonResponse(
      { ok: false, error: err instanceof Error ? err.message : "Échec de la contribution." },
      502,
    );
  }
}

async function handlePriceCompare(request, env) {
  if (!env.PRICES_DB) {
    return jsonResponse({ ok: false, error: "Base de comparaison indisponible." }, 503);
  }
  const url = new URL(request.url);
  const barcode = (url.searchParams.get("barcode") || "").trim();
  if (!barcode) {
    return jsonResponse({ ok: false, error: "Code-barre manquant." }, 400);
  }
  try {
    await ensurePricesTable(env.PRICES_DB);
    const { results } = await env.PRICES_DB.prepare(
      `SELECT store, price_xpf, observed_at, product_name
       FROM price_observations
       WHERE barcode = ?
       ORDER BY observed_at DESC`,
    )
      .bind(barcode)
      .all();

    // Keep only the most recent observation per store.
    const latestByStore = new Map();
    let productName = null;
    for (const row of results) {
      if (!productName) productName = row.product_name;
      if (!latestByStore.has(row.store)) {
        latestByStore.set(row.store, { store: row.store, price: row.price_xpf, date: row.observed_at });
      }
    }
    const stores = Array.from(latestByStore.values()).sort((a, b) => a.price - b.price);

    return jsonResponse({ ok: true, data: { barcode, productName, stores } });
  } catch (err) {
    return jsonResponse(
      { ok: false, error: err instanceof Error ? err.message : "Échec de la recherche." },
      502,
    );
  }
}

async function handlePriceSearch(request, env) {
  if (!env.PRICES_DB) {
    return jsonResponse({ ok: false, error: "Base de comparaison indisponible." }, 503);
  }
  const url = new URL(request.url);
  const q = (url.searchParams.get("q") || "").trim();
  if (q.length < 2) {
    return jsonResponse({ ok: true, data: { products: [] } });
  }
  try {
    await ensurePricesTable(env.PRICES_DB);
    const { results } = await env.PRICES_DB.prepare(
      `SELECT DISTINCT barcode, product_name
       FROM price_observations
       WHERE product_name LIKE ?
       ORDER BY observed_at DESC
       LIMIT 20`,
    )
      .bind(`%${q}%`)
      .all();
    return jsonResponse({
      ok: true,
      data: { products: results.map((r) => ({ barcode: r.barcode, name: r.product_name })) },
    });
  } catch (err) {
    return jsonResponse(
      { ok: false, error: err instanceof Error ? err.message : "Échec de la recherche." },
      502,
    );
  }
}

export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);
    const isMetered = request.method === "POST" && (url.pathname === "/api/scan" || url.pathname === "/api/match");

    if (isMetered && env.API_RATE_LIMITER) {
      const ip = request.headers.get("cf-connecting-ip") || "unknown";
      const { success } = await env.API_RATE_LIMITER.limit({ key: ip });
      if (!success) {
        return jsonResponse(
          {
            ok: false,
            error: "Trop de vérifications en peu de temps, réessaie dans une minute.",
          },
          429,
        );
      }
    }

    if (request.method === "POST" && url.pathname === "/api/scan") {
      return handleScan(request, env);
    }
    if (request.method === "POST" && url.pathname === "/api/match") {
      return handleMatch(request, env, ctx);
    }
    if (request.method === "GET" && url.pathname === "/api/stats") {
      return handleStats(env);
    }
    if (request.method === "POST" && url.pathname === "/api/price-contribute") {
      return handlePriceContribute(request, env);
    }
    if (request.method === "GET" && url.pathname === "/api/price-compare") {
      return handlePriceCompare(request, env);
    }
    if (request.method === "GET" && url.pathname === "/api/price-search") {
      return handlePriceSearch(request, env);
    }

    // Anything else (including GET on /api/*): fall through to static assets.
    return env.ASSETS.fetch(request);
  },
};

