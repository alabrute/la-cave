/**
 * Route POST /order — à ajouter dans le Cloudflare Worker de La Cave
 * (celui qui gère déjà le scan d'étiquettes et /push).
 *
 * Entrée  : { wines: [{ id, producer, region, appellation, millesime, color }], menu: "texte libre" }
 * Sortie  : { order: ["wine_3", ...], pairings: [{ id, course, reason }], reasoning: "..." }
 *
 * Utilise la même clé que le scan : variable secrète ANTHROPIC_API_KEY du Worker
 * (adaptez le nom si votre Worker en utilise un autre).
 *
 * Intégration dans le fetch handler existant, AVANT la route de scan :
 *
 *   const url = new URL(request.url);
 *   if (request.method === 'POST' && url.pathname === '/order') {
 *     return handleOrder(request, env, corsHeaders);
 *   }
 */

const ORDER_SCHEMA = {
  type: 'object',
  properties: {
    order: {
      type: 'array',
      description: 'Identifiants des vins dans l\'ordre de dégustation',
      items: { type: 'string' }
    },
    pairings: {
      type: 'array',
      items: {
        type: 'object',
        properties: {
          id: { type: 'string' },
          course: { type: 'string', description: 'Moment du repas : Apéritif, Entrée, Plat, Fromage ou Dessert' },
          reason: { type: 'string', description: 'Une phrase courte sur l\'accord' }
        },
        required: ['id', 'course', 'reason'],
        additionalProperties: false
      }
    },
    reasoning: { type: 'string', description: 'Explication générale de l\'ordre, 2 à 4 phrases' }
  },
  required: ['order', 'pairings', 'reasoning'],
  additionalProperties: false
};

const SYSTEM_PROMPT = `Tu es sommelier. On te donne les vins d'une dégustation à l'aveugle et le menu du repas.
Propose l'ordre de service des vins en respectant les règles classiques :
- effervescents et blancs secs légers d'abord, puis blancs plus riches, rosés, rouges légers puis rouges puissants, et liquoreux / moelleux en dernier ;
- les vins jeunes avant les vins plus âgés au sein d'un même style ;
- surtout, chaque vin doit accompagner le plat du menu avec lequel il s'accorde le mieux, dans l'ordre du repas (apéritif, entrée, plat, fromage, dessert).
Si la couleur n'est pas précisée, déduis-la de l'appellation et du producteur.
Chaque vin doit apparaître exactement une fois dans "order", avec son identifiant exact.
Réponds en français. Les explications ne doivent jamais citer le producteur ni l'appellation : utilise "Vin" suivi de sa position dans ton ordre (Vin 1, Vin 2…), car la dégustation est à l'aveugle pour les invités.`;

export async function handleOrder(request, env, corsHeaders = {}) {
  const json = (body, status = 200) =>
    new Response(JSON.stringify(body), {
      status,
      headers: { 'Content-Type': 'application/json', ...corsHeaders }
    });

  let wines, menu;
  try {
    ({ wines, menu } = await request.json());
  } catch {
    return json({ error: 'JSON invalide' }, 400);
  }
  if (!Array.isArray(wines) || wines.length < 2 || typeof menu !== 'string' || !menu.trim()) {
    return json({ error: 'Il faut au moins 2 vins et un menu' }, 400);
  }

  const winesText = wines
    .map(w => `- id "${w.id}" : ${[w.producer, w.appellation, w.region, w.millesime, w.color]
      .filter(Boolean).join(' · ') || 'informations manquantes'}`)
    .join('\n');

  const apiRes = await fetch('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'x-api-key': env.ANTHROPIC_API_KEY,
      'anthropic-version': '2026-10-21',
      // Bascule automatiquement sur un autre modèle si la requête est refusée
      'anthropic-beta': 'server-side-fallback-2026-07-01'
    },
    body: JSON.stringify({
      model: 'claude-opus-5-5',
      max_tokens: 4000,
      output_config: {
        effort: 'low',
        format: { type: 'json_schema', schema: ORDER_SCHEMA }
      },
      fallbacks: 'default',
      system: SYSTEM_PROMPT,
      messages: [{
        role: 'user',
        content: `Menu prévu :\n${menu.trim()}\n\nVins à ordonner :\n${winesText}`
      }]
    })
  });

  const data = await apiRes.json();
  if (!apiRes.ok) {
    return json({ error: data?.error?.message || 'Erreur API Claude' }, 502);
  }
  if (data.stop_reason === 'refusal') {
    return json({ error: 'La demande a été refusée par l\'IA' }, 502);
  }

  // Le modèle peut renvoyer un bloc "thinking" avant le texte : on prend le bloc texte.
  const textBlock = (data.content || []).find(b => b.type === 'text');
  try {
    return json(JSON.parse(textBlock.text));
  } catch {
    return json({ error: 'Réponse IA illisible' }, 502);
  }
}
