// Cloudflare Pages Function. Same Qwen credential pattern as scan.js.

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

async function callQwenVision(env, { systemPrompt, userText, imageBytes, imageType }) {
  const apiKey = env.QWEN_API_KEY;
  const baseUrl = env.QWEN_BASE_URL || "https://dashscope-intl.aliyuncs.com/compatible-mode/v1";
  if (!apiKey) {
    throw new Error("La clé Qwen n'est pas configurée côté serveur. Vérifie les variables d'environnement du projet.");
  }

  const dataUrl = `data:${imageType};base64,${bytesToBase64(imageBytes)}`;

  const response = await fetch(`${baseUrl}/chat/completions`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${apiKey}`,
    },
    body: JSON.stringify({
      model: "qwen-vl-max",
      messages: [
        { role: "system", content: systemPrompt },
        {
          role: "user",
          content: [
            { type: "text", text: userText },
            { type: "image_url", image_url: { url: dataUrl } },
          ],
        },
      ],
      temperature: 0.1,
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

export async function onRequestPost(context) {
  const { request, env } = context;

  try {
    const form = await request.formData();
    const file = form.get("receipt");
    const itemsRaw = form.get("items");

    if (!(file instanceof File)) {
      return jsonResponse({ ok: false, error: "Aucune photo de ticket reçue." }, 400);
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

    const bytes = new Uint8Array(await file.arrayBuffer());
    if (bytes.byteLength === 0) {
      return jsonResponse({ ok: false, error: "Photo vide, reprends le ticket." }, 400);
    }
    if (bytes.byteLength > 8_000_000) {
      return jsonResponse({ ok: false, error: "Photo trop lourde, reprends-la." }, 413);
    }

    const itemsDescription = items
      .map((item) => `- id="${item.id}" nom="${item.name}" prix_rayon=${item.shelfPrice}`)
      .join("\n");

    const systemPrompt = `Tu compares un ticket de courses (constitué en rayon) avec la photo du ticket de caisse final, pour un outil de vérification de prix en Polynésie française (arrêté n°170 CM).

Voici les articles du panier, avec leur prix relevé en rayon (en Francs Pacifique, XPF) :
${itemsDescription}

Lis toutes les lignes de la photo du ticket de caisse. Pour CHAQUE article du panier ci-dessus, retrouve la ligne du ticket qui correspond le mieux (par similarité de nom, même si l'intitulé de caisse est abrégé), et donne son prix facturé. Si aucune ligne ne correspond clairement, mets receipt_price à null.

Réponds UNIQUEMENT avec un objet JSON strict, sans texte autour, au format exact :
{
  "matches": [
    { "id": string, "receipt_price": number|null, "receipt_line_text": string|null }
  ],
  "unmatched_receipt_lines": string[]
}
Le tableau "matches" doit contenir EXACTEMENT un objet par article du panier, dans le même ordre, avec le même id. Les prix sont des nombres entiers en XPF, sans symbole.`;

    const parsed = await callQwenVision(env, {
      systemPrompt,
      userText: "Photo du ticket de caisse :",
      imageBytes: bytes,
      imageType: file.type || "image/jpeg",
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
