/**
 * Cloudflare Worker — La Cave 🍷
 *
 * Routes :
 *   POST /        → lecture d'une étiquette de vin (photo) via Claude
 *   POST /order   → ordre de dégustation des vins selon le menu, via Claude
 *   POST /push    → envoi d'une notification Web Push
 *
 * Secrets à définir dans Cloudflare (Settings → Variables and Secrets) :
 *   ANTHROPIC_API_KEY  — clé API Anthropic
 *   VAPID_PRIVATE_KEY  — clé privée VAPID (base64url, 32 octets bruts)
 */

// ═══════════════════════════════════════
// CONFIGURATION — à remplir
// ═══════════════════════════════════════
const VAPID_PUBLIC_KEY = 'BJl7hP3X0jsR1-khsXT_W1GloLm8rZWaj4hBHhIukA8p1kwYUHKYOnjZDYoBq9JWm7giB0KeX7LZMXnP5t2QrCA';
const VAPID_SUBJECT    = 'mailto:votre-email@example.com'; // ← mettez votre email (sans espace ni chevrons)

// Seul le site de l'appli peut appeler le Worker depuis un navigateur.
const ALLOWED_ORIGIN = 'https://alabrute.github.io';

const ANTHROPIC_VERSION = '2026-10-21';

// ═══════════════════════════════════════
// HEADERS CORS
// ═══════════════════════════════════════
const CORS = {
  'Access-Control-Allow-Origin': ALLOWED_ORIGIN,
  'Access-Control-Allow-Headers': 'Content-Type',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
  'Vary': 'Origin',
};

function json(body, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...CORS, 'Content-Type': 'application/json' },
  });
}

export default {
  async fetch(request, env) {
    if (request.method === 'OPTIONS') {
      return new Response(null, { status: 204, headers: CORS });
    }
    // GET (aperçu Cloudflare, navigateur) : simple vérification que le Worker tourne
    if (request.method === 'GET') {
      return json({ ok: true, message: 'Worker La Cave opérationnel 🍷 (routes POST : /, /order, /push)' });
    }
    if (request.method !== 'POST') {
      return json({ error: 'Méthode non autorisée' }, 405);
    }

    const url = new URL(request.url);
    try {
      if (url.pathname === '/' || url.pathname === '') return await handlePhotoScan(request, env);
      if (url.pathname === '/order')                    return await handleOrder(request, env);
      if (url.pathname === '/push')                     return await handlePush(request, env);
      return json({ error: 'Not found' }, 404);
    } catch (e) {
      return json({ error: e.message }, 500);
    }
  },
};

// ═══════════════════════════════════════
// APPEL API CLAUDE (commun)
// ═══════════════════════════════════════
async function callClaude(env, body, extraHeaders = {}) {
  const response = await fetch('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'x-api-key': env.ANTHROPIC_API_KEY,
      'anthropic-version': ANTHROPIC_VERSION,
      ...extraHeaders,
    },
    body: JSON.stringify(body),
  });
  const data = await response.json();
  if (!response.ok) {
    throw new Error(data?.error?.message || `API Claude ${response.status}`);
  }
  if (data.stop_reason === 'refusal') {
    throw new Error("La demande a été refusée par l'IA");
  }
  return data;
}

// Le texte JSON renvoyé par Claude (il peut y avoir un bloc "thinking" avant)
function extractJson(data) {
  const textBlock = (data.content || []).find(b => b.type === 'text');
  if (!textBlock) throw new Error("Réponse vide de l'IA");
  return JSON.parse(textBlock.text.replace(/```json|```/g, '').trim());
}

// ═══════════════════════════════════════
// ROUTE / — Analyse étiquette
// ═══════════════════════════════════════
async function handlePhotoScan(request, env) {
  const { imageData, mediaType } = await request.json();
  if (!imageData || !mediaType) return json({ error: 'Image manquante' }, 400);

  const data = await callClaude(env, {
    model: 'claude-sonnet-4-6',
    max_tokens: 400,
    messages: [{
      role: 'user',
      content: [
        { type: 'image', source: { type: 'base64', media_type: mediaType, data: imageData } },
        {
          type: 'text',
          text: 'Lis cette étiquette de vin et retourne UNIQUEMENT un objet JSON valide avec ces champs : ' +
                '{"producer":"...","region":"...","appellation":"...","millesime":YYYY,"color":"..."}. ' +
                '"color" vaut l\'une de ces valeurs : "Blanc", "Rouge", "Rosé", "Effervescent", "Liquoreux" ' +
                '(déduis-la de l\'appellation si elle n\'est pas écrite). ' +
                'Si un champ est illisible ou absent, mets null. Aucun texte autour du JSON, aucun markdown, aucun backtick.',
        },
      ],
    }],
  });

  // Même format qu'avant : l'appli lit content[].text
  return json(data);
}

// ═══════════════════════════════════════
// ROUTE /order — Ordre de dégustation
// Entrée  : { wines: [{ id, producer, region, appellation, millesime, color }], menu }
// Sortie  : { order: [id...], pairings: [{ id, course, reason }], reasoning }
// ═══════════════════════════════════════
const ORDER_SCHEMA = {
  type: 'object',
  properties: {
    order: {
      type: 'array',
      description: "Identifiants des vins dans l'ordre de dégustation",
      items: { type: 'string' },
    },
    pairings: {
      type: 'array',
      items: {
        type: 'object',
        properties: {
          id:     { type: 'string' },
          course: { type: 'string', description: 'Moment du repas : Apéritif, Entrée, Plat, Fromage ou Dessert' },
          reason: { type: 'string', description: "Une phrase courte sur l'accord" },
        },
        required: ['id', 'course', 'reason'],
        additionalProperties: false,
      },
    },
    reasoning: { type: 'string', description: "Explication générale de l'ordre, 2 à 4 phrases" },
  },
  required: ['order', 'pairings', 'reasoning'],
  additionalProperties: false,
};

const ORDER_SYSTEM_PROMPT = `Tu es sommelier. On te donne les vins d'une dégustation à l'aveugle et le menu du repas.
Propose l'ordre de service des vins en respectant les règles classiques :
- effervescents et blancs secs légers d'abord, puis blancs plus riches, rosés, rouges légers puis rouges puissants, et liquoreux / moelleux en dernier ;
- les vins jeunes avant les vins plus âgés au sein d'un même style ;
- surtout, chaque vin doit accompagner le plat du menu avec lequel il s'accorde le mieux, dans l'ordre du repas (apéritif, entrée, plat, fromage, dessert).
Si la couleur n'est pas précisée, déduis-la de l'appellation et du producteur.
Chaque vin doit apparaître exactement une fois dans "order", avec son identifiant exact.
Réponds en français. Les explications ne doivent jamais citer le producteur ni l'appellation : utilise "Vin" suivi de sa position dans ton ordre (Vin 1, Vin 2…), car la dégustation est à l'aveugle pour les invités.`;

async function handleOrder(request, env) {
  const { wines, menu } = await request.json();
  if (!Array.isArray(wines) || wines.length < 2 || typeof menu !== 'string' || !menu.trim()) {
    return json({ error: 'Il faut au moins 2 vins et un menu' }, 400);
  }

  const winesText = wines
    .map(w => `- id "${w.id}" : ${[w.producer, w.appellation, w.region, w.millesime, w.color]
      .filter(Boolean).join(' · ') || 'informations manquantes'}`)
    .join('\n');

  const data = await callClaude(env, {
    model: 'claude-opus-5-5',
    max_tokens: 4000,
    output_config: {
      effort: 'low',
      format: { type: 'json_schema', schema: ORDER_SCHEMA },
    },
    // Bascule automatiquement sur un autre modèle si la requête est refusée
    fallbacks: 'default',
    system: ORDER_SYSTEM_PROMPT,
    messages: [{
      role: 'user',
      content: `Menu prévu :\n${menu.trim()}\n\nVins à ordonner :\n${winesText}`,
    }],
  }, { 'anthropic-beta': 'server-side-fallback-2026-07-01' });

  return json(extractJson(data));
}

// ═══════════════════════════════════════
// ROUTE /push — Notification Web Push
// ═══════════════════════════════════════
async function handlePush(request, env) {
  const { subscription, title, body } = await request.json();
  if (!subscription?.endpoint || !subscription?.keys) return json({ error: 'Abonnement invalide' }, 400);
  await sendWebPush(subscription, JSON.stringify({ title, body }), env.VAPID_PRIVATE_KEY);
  return json({ ok: true });
}

// ═══════════════════════════════════════
// WEB PUSH — chiffrement aes128gcm (RFC 8291) + VAPID (RFC 8292)
// ═══════════════════════════════════════
const enc = new TextEncoder();

async function sendWebPush(subscription, payloadString, vapidPrivateKey) {
  const body = await encryptPayload(subscription, enc.encode(payloadString));
  const jwt  = await buildVapidJwt(subscription.endpoint, vapidPrivateKey);

  const response = await fetch(subscription.endpoint, {
    method: 'POST',
    headers: {
      'Content-Type':     'application/octet-stream',
      'Content-Encoding': 'aes128gcm',
      'TTL':              '86400',
      'Urgency':          'high',
      'Authorization':    `vapid t=${jwt}, k=${VAPID_PUBLIC_KEY}`,
    },
    body,
  });

  if (!response.ok) {
    throw new Error(`Push failed: ${response.status} — ${await response.text()}`);
  }
}

async function encryptPayload(subscription, payload) {
  const uaPublic   = base64urlToUint8Array(subscription.keys.p256dh); // clé publique du navigateur (65 octets)
  const authSecret = base64urlToUint8Array(subscription.keys.auth);   // secret d'auth (16 octets)
  const salt       = crypto.getRandomValues(new Uint8Array(16));

  // Paire de clés éphémère côté serveur
  const asKeys = await crypto.subtle.generateKey({ name: 'ECDH', namedCurve: 'P-256' }, true, ['deriveBits']);
  const asPublic = new Uint8Array(await crypto.subtle.exportKey('raw', asKeys.publicKey));

  const uaKey = await crypto.subtle.importKey('raw', uaPublic, { name: 'ECDH', namedCurve: 'P-256' }, false, []);
  const ecdhSecret = new Uint8Array(await crypto.subtle.deriveBits({ name: 'ECDH', public: uaKey }, asKeys.privateKey, 256));

  // IKM = HKDF(auth_secret, ecdh_secret, "WebPush: info\0" || ua_public || as_public, 32)
  const keyInfo = concat(enc.encode('WebPush: info\0'), uaPublic, asPublic);
  const ikm = await hkdf(authSecret, ecdhSecret, keyInfo, 32);

  // Clé de chiffrement et nonce dérivés avec le salt
  const cek   = await hkdf(salt, ikm, enc.encode('Content-Encoding: aes128gcm\0'), 16);
  const nonce = await hkdf(salt, ikm, enc.encode('Content-Encoding: nonce\0'), 12);

  // Un seul enregistrement : payload + délimiteur 0x02
  const plaintext = concat(payload, new Uint8Array([2]));
  const aesKey = await crypto.subtle.importKey('raw', cek, { name: 'AES-GCM' }, false, ['encrypt']);
  const ciphertext = new Uint8Array(await crypto.subtle.encrypt({ name: 'AES-GCM', iv: nonce }, aesKey, plaintext));

  // En-tête : salt (16) | taille d'enregistrement (4) | longueur keyid (1) | keyid = as_public (65)
  const header = new Uint8Array(16 + 4 + 1 + asPublic.length);
  header.set(salt, 0);
  new DataView(header.buffer).setUint32(16, 4096);
  header[20] = asPublic.length;
  header.set(asPublic, 21);

  return concat(header, ciphertext);
}

// HKDF-SHA-256 (extract + expand, une seule itération : longueur ≤ 32)
async function hkdf(salt, ikm, info, length) {
  const prk = await hmac(salt, ikm);
  const okm = await hmac(prk, concat(info, new Uint8Array([1])));
  return okm.slice(0, length);
}

async function hmac(keyBytes, data) {
  const key = await crypto.subtle.importKey('raw', keyBytes, { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
  return new Uint8Array(await crypto.subtle.sign('HMAC', key, data));
}

// JWT VAPID signé ES256. La clé privée (32 octets) est importée en JWK
// avec les coordonnées x/y tirées de la clé publique.
async function buildVapidJwt(endpoint, vapidPrivateKey) {
  const pub = base64urlToUint8Array(VAPID_PUBLIC_KEY); // 0x04 | x (32) | y (32)
  const privKey = await crypto.subtle.importKey(
    'jwk',
    {
      kty: 'EC', crv: 'P-256',
      x: uint8ArrayToBase64url(pub.slice(1, 33)),
      y: uint8ArrayToBase64url(pub.slice(33, 65)),
      d: vapidPrivateKey.trim(),
      ext: true,
    },
    { name: 'ECDSA', namedCurve: 'P-256' },
    false, ['sign']
  );

  const header  = { typ: 'JWT', alg: 'ES256' };
  const payload = {
    aud: new URL(endpoint).origin,
    exp: Math.floor(Date.now() / 1000) + 12 * 3600,
    sub: VAPID_SUBJECT,
  };
  const signingInput =
    uint8ArrayToBase64url(enc.encode(JSON.stringify(header))) + '.' +
    uint8ArrayToBase64url(enc.encode(JSON.stringify(payload)));

  const signature = await crypto.subtle.sign({ name: 'ECDSA', hash: 'SHA-256' }, privKey, enc.encode(signingInput));
  return `${signingInput}.${uint8ArrayToBase64url(new Uint8Array(signature))}`;
}

// ─── Helpers ───
function concat(...arrays) {
  const out = new Uint8Array(arrays.reduce((n, a) => n + a.length, 0));
  let offset = 0;
  for (const a of arrays) { out.set(a, offset); offset += a.length; }
  return out;
}

function base64urlToUint8Array(base64url) {
  const base64 = base64url.replace(/-/g, '+').replace(/_/g, '/');
  const padded = base64.padEnd(base64.length + (4 - base64.length % 4) % 4, '=');
  return Uint8Array.from(atob(padded), c => c.charCodeAt(0));
}

function uint8ArrayToBase64url(arr) {
  let s = '';
  for (const b of arr) s += String.fromCharCode(b);
  return btoa(s).replace(/\+/g, '-').replace(/\//g, '_').replace(/=/g, '');
}
