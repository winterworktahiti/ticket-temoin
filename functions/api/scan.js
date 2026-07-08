// Cloudflare Pages Function. Runs server-side; env.QWEN_API_KEY and
// env.QWEN_BASE_URL are set as environment variables/secrets in the Pages
// project settings (or via `wrangler pages secret put`), never in this file.

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

export async function onRequestPost(context) {
  const { request, env } = context;

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
      imageBytes: bytes,
      imageType: file.type || "image/jpeg",
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
