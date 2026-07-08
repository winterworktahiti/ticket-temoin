async function parseEnvelope(response) {
  let payload;
  try {
    payload = await response.json();
  } catch {
    throw new Error(`Le serveur a répondu de façon inattendue (${response.status}).`);
  }
  if (!payload.ok) {
    throw new Error(payload.error || "Une erreur est survenue.");
  }
  return payload.data;
}

export async function scanItemPhoto(file, mode) {
  const form = new FormData();
  form.append("image", file);
  form.append("mode", mode);
  const response = await fetch("/api/scan", { method: "POST", body: form });
  return parseEnvelope(response);
}

export async function matchReceiptPhoto(files, items) {
  const form = new FormData();
  for (const file of files) form.append("receipt", file);
  form.append("items", JSON.stringify(items));
  const response = await fetch("/api/match", { method: "POST", body: form });
  return parseEnvelope(response);
}
