// Cloudflare Worker (unified Workers + static assets model, 2026).
// Static files (index.html, css/, js/) are served via the ASSETS binding,
// configured in wrangler.jsonc. This script only handles the two API
// routes; wrangler.jsonc's assets.run_worker_first sends /api/* here first,
// everything else falls straight through to the static assets binding.

const SHELF_PROMPT = `Tu regardes une photo d'une étiquette de prix en rayon dans un supermarché de Polynésie française.
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

async function callQwenVision(env, { systemPrompt, userText, images }) {
  const apiKey = env.QWEN_API_KEY;
  const baseUrl = env.QWEN_BASE_URL || "https://dashscope-intl.aliyuncs.com/compatible-mode/v1";
  if (!apiKey) {
    throw new Error("La clé Qwen n'est pas configurée côté serveur. Vérifie les variables du projet.");
  }

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
      model: "qwen3-vl-flash",
      messages: [
        { role: "system", content: systemPrompt },
        { role: "user", content },
      ],
      temperature: 0.1,
      max_tokens: 2000,
    }),
  });

  if (!response.ok) {
    const bodyText = await response.text().catch(() => "");
    throw new Error(`Erreur Qwen (${response.status}). ${bodyText.slice(0, 300)}`);
  }

  const json = await response.json();
  const rawContent = json.choices?.[0]?.message?.content ?? "";
  const jsonMatch = rawContent.match(/\{[\s\S]*\}/);
  if (!jsonMatch) {
    throw new Error("Réponse Qwen illisible. Réessaie avec une photo plus nette.");
  }
  try {
    return JSON.parse(jsonMatch[0]);
  } catch {
    throw new Error("Réponse Qwen mal formée. Réessaie avec une photo plus nette.");
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
    const parsed = await callQwenVision(env, {
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

async function handleMatch(request, env, ctx) {
  try {
    const form = await request.formData();
    const files = form.getAll("receipt").filter((entry) => entry instanceof File);
    const itemsRaw = form.get("items");

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

    const systemPrompt = `Tu compares un ticket de courses (constitué en rayon) avec ${images.length > 1 ? "les photos" : "la photo"} du ticket de caisse final, pour un outil de vérification de prix en Polynésie française (arrêté n°170 CM).
${multiPhotoNote}
Voici les articles du panier. "prix_total_attendu" est le prix TOTAL attendu pour cet article (déjà multiplié par la quantité si elle est indiquée) :
${itemsDescription}

Procède en deux temps, dans cet ordre :
1. Transcris D'ABORD toutes les lignes produit du ticket de caisse que tu peux lire sur l'ensemble des photos, avec leur prix exact (en XPF, entier, sans symbole). Un ticket de supermarché a en général une ligne d'intitulé produit suivie d'un code-barre en dessous : ignore le code-barre, ne prends que le nom et le prix. Sois exhaustif, ne saute aucune ligne même si elle te semble déjà correspondre à un article du panier.
2. Ensuite seulement, pour CHAQUE article du panier ci-dessus, retrouve dans ta transcription la ou les lignes qui correspondent (par similarité de nom, même si l'intitulé de caisse est abrégé ou tronqué). Si une quantité est indiquée pour l'article, le ticket peut soit répéter la ligne plusieurs fois (additionne alors leurs prix), soit n'avoir qu'une seule ligne dont le prix reflète déjà le total pour cette quantité : dans les deux cas, "receipt_price" doit être le prix TOTAL correspondant à la quantité entière de cet article, comparable directement à "prix_total_attendu". N'invente jamais un prix : si après une lecture attentive aucune ligne ne correspond clairement, mets receipt_price à null plutôt que de deviner.

Réponds UNIQUEMENT avec un objet JSON strict, sans texte autour, au format exact :
{
  "receipt_lines": [ { "text": string, "price": number } ],
  "matches": [
    { "id": string, "receipt_price": number|null, "receipt_line_text": string|null }
  ],
  "unmatched_receipt_lines": string[]
}
"receipt_lines" contient TOUTES les lignes lues à l'étape 1, toutes photos confondues. Le tableau "matches" doit contenir EXACTEMENT un objet par article du panier, dans le même ordre, avec le même id, en te basant sur "receipt_lines". "unmatched_receipt_lines" liste les entrées de "receipt_lines" qui ne correspondent à aucun article du panier.`;

    const parsed = await callQwenVision(env, {
      systemPrompt,
      userText: images.length > 1 ? "Photos du ticket de caisse (une seule et même ticket) :" : "Photo du ticket de caisse :",
      images,
    });

    const matches = Array.isArray(parsed.matches) ? parsed.matches : [];
    const unmatchedReceiptLines = Array.isArray(parsed.unmatched_receipt_lines)
      ? parsed.unmatched_receipt_lines
      : [];

    const lines = items.map((item) => {
      const match = matches.find((m) => m.id === item.id);
      const receiptPrice = typeof match?.receipt_price === "number" ? match.receipt_price : null;
      const receiptLineText = typeof match?.receipt_line_text === "string" ? match.receipt_line_text : null;

      let status = "inconclusive";
      let difference = null;
      if (receiptPrice !== null) {
        difference = receiptPrice - item.shelfPrice;
        status = difference > 0 ? "mismatch" : "match";
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

    const totalShelf = lines.reduce((sum, l) => sum + l.shelfPrice, 0);
    const totalReceiptMatched = lines.reduce((sum, l) => sum + (l.receiptPrice ?? 0), 0);

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

    // Anything else (including GET on /api/*): fall through to static assets.
    return env.ASSETS.fetch(request);
  },
};

