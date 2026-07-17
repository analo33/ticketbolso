/* /api/extract — Lee un ticket con Claude (visión) y devuelve los datos.
   Requiere la variable de entorno ANTHROPIC_API_KEY en Vercel.
   Si no está configurada, responde 501 y la app usa el OCR local de respaldo. */

import Anthropic from "@anthropic-ai/sdk";

// Esquema de salida: garantiza JSON válido con exactamente estos campos.
const SCHEMA = {
  type: "object",
  properties: {
    comercio:  { anyOf: [{ type: "string" }, { type: "null" }],
                 description: "Nombre comercial del establecimiento, tal y como aparece en el ticket" },
    cif:       { anyOf: [{ type: "string" }, { type: "null" }],
                 description: "CIF o NIF del emisor (9 caracteres, ej. B12345678 o 12345678Z); null si no aparece" },
    fecha:     { anyOf: [{ type: "string" }, { type: "null" }],
                 description: "Fecha de emisión del ticket en formato YYYY-MM-DD; null si no aparece" },
    base:      { anyOf: [{ type: "number" }, { type: "null" }],
                 description: "Base imponible en euros; null si no aparece" },
    tipo_iva:  { anyOf: [{ type: "integer" }, { type: "null" }],
                 description: "Tipo de IVA en porcentaje: 21, 10, 4 o 0; null si no aparece" },
    cuota_iva: { anyOf: [{ type: "number" }, { type: "null" }],
                 description: "Cuota de IVA en euros; null si no aparece" },
    total:     { anyOf: [{ type: "number" }, { type: "null" }],
                 description: "Importe total del ticket en euros" },
  },
  required: ["comercio", "cif", "fecha", "base", "tipo_iva", "cuota_iva", "total"],
  additionalProperties: false,
};

const PROMPT = `Extrae los datos de este ticket de compra español (imagen escaneada).

Reglas:
- "comercio": el nombre comercial del establecimiento (suele estar arriba, en grande). No confundas con la razón social si aparecen ambas; prefiere el nombre comercial.
- "cif": el CIF/NIF del EMISOR del ticket (no el del cliente). Formato de 9 caracteres sin espacios ni guiones.
- "fecha": la fecha de EMISIÓN impresa en el ticket, no otras fechas (caducidad de tarjeta, promociones). Formato YYYY-MM-DD. Si el año tiene 2 dígitos, asume 20XX.
- "base", "cuota_iva", "total": importes en euros como números (punto decimal). La base más la cuota debe cuadrar con el total; si en el ticket hay varios tipos de IVA, usa la suma de bases y la suma de cuotas, y como tipo_iva el tipo del importe mayor.
- "tipo_iva": solo 21, 10, 4 o 0.
- Si un dato no aparece o no se lee con seguridad, devuelve null para ese campo. No inventes datos.`;

export default async function handler(req, res) {
  if (req.method !== "POST") {
    res.status(405).json({ error: "method-not-allowed" });
    return;
  }
  // Solo aceptar llamadas desde la propia app (bloquea el abuso casual desde
  // otras webs; el límite de gasto en la cuenta de Anthropic es la red de
  // seguridad definitiva).
  const origin = req.headers.origin || "";
  const okOrigin = /^https:\/\/ticketbolso[a-z0-9-]*\.vercel\.app$/.test(origin);
  if (!okOrigin) {
    res.status(403).json({ error: "forbidden" });
    return;
  }
  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) {
    // Sin clave configurada: la app usará el OCR local como respaldo.
    res.status(501).json({ error: "no-key" });
    return;
  }
  const image = req.body && req.body.image;
  if (!image || typeof image !== "string" || image.length > 6_000_000) {
    res.status(400).json({ error: "bad-image" });
    return;
  }

  const client = new Anthropic({ apiKey });
  try {
    const response = await client.messages.create({
      model: "claude-opus-4-8",
      max_tokens: 2048,
      thinking: { type: "adaptive" },
      output_config: {
        effort: "low", // extracción acotada: prioriza latencia (la usuaria espera con el móvil)
        format: { type: "json_schema", schema: SCHEMA },
      },
      messages: [
        {
          role: "user",
          content: [
            { type: "image", source: { type: "base64", media_type: "image/jpeg", data: image } },
            { type: "text", text: PROMPT },
          ],
        },
      ],
    });

    if (response.stop_reason === "refusal") {
      res.status(502).json({ error: "refused" });
      return;
    }
    const text = response.content.find((b) => b.type === "text");
    if (!text) {
      res.status(502).json({ error: "empty" });
      return;
    }
    res.status(200).json(JSON.parse(text.text));
  } catch (err) {
    const status = err && err.status ? err.status : 500;
    res.status(status === 429 ? 429 : 502).json({ error: "api-error" });
  }
}
