// --- CORS utilitaire (corrigé & factorisé) ---
const ALLOWED_ORIGINS = [
  "https://wil-et-merlin.com",
  "https://www.wil-et-merlin.com",
  "http://wil-et-merlin.com",
  "http://www.wil-et-merlin.com"
];

function pickAllowOrigin(req) {
  const origin = req.headers?.origin || "";
  return ALLOWED_ORIGINS.includes(origin) ? origin : ALLOWED_ORIGINS[0];
}

function setCorsHeaders(res, allowOrigin) {
  res.setHeader("Access-Control-Allow-Origin", allowOrigin);
  // Important pour caches/CDN et Origin variables
  res.setHeader("Vary", "Origin");
  res.setHeader("Access-Control-Allow-Methods", "POST, OPTIONS");
  // Autorise JSON + bearer si tu en as besoin plus tard
  res.setHeader("Access-Control-Allow-Headers", "Content-Type, Authorization");
}

// --- Helpers FAQ (inchangés) ---
function normalize(s) {
  return (s || "")
    .toLowerCase()
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "");
}

function findFaq(q, faq) {
  const nq = normalize(q);
  let best = null, bestScore = 0;
  for (const f of faq) {
    let score = 0;
    const nQ = normalize(f.question);
    if (nQ.includes(nq) || nq.includes(nQ)) score += 3;
    for (const t of (f.tags || [])) {
      if (nq.includes(normalize(t))) score += 1;
    }
    const words = nq.split(/\W+/).filter(Boolean);
    let overlap = 0;
    for (const w of words) {
      if (nQ.includes(w)) overlap += 1;
    }
    score += overlap * 0.1;
    if (score > bestScore) { bestScore = score; best = f; }
  }
  return bestScore >= 1 ? best : null;
}

export default async function handler(req, res) {
  // 0) CORS pour toutes les réponses
  const allowOrigin = pickAllowOrigin(req);
  setCorsHeaders(res, allowOrigin);

  // 1) OPTIONS (préflight)
  if (req.method === "OPTIONS") {
    // Pas de body, juste les headers CORS
    return res.status(200).end();
  }

  // 2) Refuser autres méthodes que POST
  if (req.method !== "POST") {
    return res.status(405).json({ error: "Method Not Allowed" });
  }

  try {
    // 3) Clé OpenAI
    const OPENAI_API_KEY = process.env.OPENAI_API_KEY;
    if (!OPENAI_API_KEY) {
      return res.status(500).json({ error: "Missing OPENAI_API_KEY" });
    }

    // 4) Body JSON (WordPress doit envoyer Content-Type: application/json)
    const body = typeof req.body === "string"
      ? JSON.parse(req.body || "{}")
      : (req.body || {});
    const messages = Array.isArray(body.messages) ? body.messages : [];
    const lastUser = [...messages].reverse().find(m => m.role === "user")?.content || "";

    // 5) FAQ locale
    const faq = require("./faq_wm.json");
    const hit = findFaq(lastUser, faq);

    // 6) Prompt système
    const systemPersona = `Tu es MERLIN : voix complice, poétique, pince-sans-rire, bienveillante.
Réponds d’abord depuis la FAQ fournie si une entrée est pertinente (priorité haute).
Sinon, réponds brièvement et propose 1–2 pistes ou questions voisines.
Jamais d’info inventée sur des faits absents de l’univers Wil & Merlin.`;

    const toolContext = hit
      ? `Utilise cette fiche FAQ prioritaire:\nQ: ${hit.question}\nR: ${hit.answer_long}\nAjoute une punchline courte à la fin.`
      : `Aucune FAQ très proche. Reste bref (max 5 lignes), propose d'autres questions possibles et suggère la page /faq-merlin.`;

    const payload = {
      model: "gpt-5.1-mini",
      input: [
        { role: "system", content: systemPersona },
        { role: "system", content: toolContext },
        ...messages.filter(m => m.role !== "system")
      ]
    };

    // 7) Appel OpenAI Responses API
    const r = await fetch("https://api.openai.com/v1/responses", {
      method: "POST",
      headers: {
        "Authorization": `Bearer ${OPENAI_API_KEY}`,
        "Content-Type": "application/json"
      },
      body: JSON.stringify(payload)
    });

    // Gestion d'erreurs réseau/API OpenAI plus explicite
    if (!r.ok) {
      const txt = await r.text().catch(() => "");
      return res.status(502).json({ error: `OpenAI error: ${r.status} ${r.statusText}`, details: txt.slice(0, 3000) });
    }

    const j = await r.json();
    const reply =
      j.output_text ||
      j.choices?.[0]?.message?.content ||
      "Je sèche encore un peu… essaie une autre question 😉";

    // 8) Réponse finale
    return res.status(200).json({ reply, source: hit?.id || null });

  } catch (e) {
    console.error(e);
    // CORS déjà posé en haut
    return res.status(500).json({ error: String(e) });
  }
}
