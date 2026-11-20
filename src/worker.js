/**
 * Ixorigue Hub — Worker v7
 * Proxy seguro entre el dashboard y la API de ClickUp.
 *
 * Secretos (NUNCA en el código; se cargan con `npx wrangler secret put <NOMBRE>`):
 *   CLICKUP_TOKEN   → token personal de ClickUp (pk_...)
 *   DASHBOARD_PIN   → PIN de acceso al panel (opcional si se usa Cloudflare Access)
 *
 * Variables (wrangler.jsonc → "vars"):
 *   CLICKUP_TEAM_ID, CLICKUP_FOLDER_ID
 *   CACHE_TTL_SECONDS      (por defecto 120)  → antigüedad máxima antes de volver a pedir a ClickUp
 *   MIN_FORCE_SECONDS      (por defecto 30)   → intervalo mínimo entre refrescos forzados
 *   CLOSED_LOOKBACK_DAYS   (por defecto 400)  → histórico de tareas cerradas para analítica
 *   MAX_PAGES              (por defecto 25)   → páginas máx. (100 tareas/página) por consulta
 *   AUTH_MODE              ("pin" | "access") → "access" si el panel está detrás de Cloudflare Access
 *   ACCESS_TEAM_DOMAIN, ACCESS_AUD               → solo con AUTH_MODE = "access"
 *
 * Binding opcional:
 *   HUB_CACHE (KV) → caché global. Si no existe se usa la Cache API del data center.
 */

// Credenciales actuales, escritas aquí para no tener que configurar nada en Cloudflare.
// Si algún día se crean los secretos CLICKUP_TOKEN / DASHBOARD_PIN en Cloudflare, se usarán esos en su lugar.
// IMPORTANTE: mantener el repositorio de GitHub en PRIVADO.
const DEFAULT_CLICKUP_TOKEN = 'pk_106536124_OR1XJNSHG56NZ674CXGVB3RKWMJX4Q1C';
const DEFAULT_DASHBOARD_PIN = 'IxorigueProd*2505!';

const API_ROUTES = new Set(['/api/tasks', '/api/clickup']); // /api/clickup se mantiene por compatibilidad
const CACHE_KEY = 'clickup-tasks-v5';
const CACHE_URL = 'https://cache.internal/' + CACHE_KEY;

export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);

    if (API_ROUTES.has(url.pathname)) {
      if (request.method !== 'GET') return json({ error: 'Método no permitido' }, 405);
      return handleTasks(request, env, ctx, url);
    }
    if (url.pathname === '/api/health') {
      return json({ ok: true, version: 'v7', time: new Date().toISOString() });
    }
    return env.ASSETS.fetch(request);
  },
};

/* ------------------------------------------------------------------ */
/* Autenticación                                                       */
/* ------------------------------------------------------------------ */

async function isAuthorized(request, env) {
  if (env.AUTH_MODE === 'access') {
    // Cloudflare Access autentica al usuario (email + código) y firma un JWT; aquí se verifica la firma.
    return verifyAccessJwt(request.headers.get('Cf-Access-Jwt-Assertion'), env);
  }
  const expected = env.DASHBOARD_PIN || DEFAULT_DASHBOARD_PIN;
  if (!expected) return false; // sin PIN configurado, no se sirve nada
  const provided = request.headers.get('x-pin-token') || ''; // solo cabecera: nunca por URL
  return timingSafeEqual(provided, expected);
}

/**
 * Verifica el JWT de Cloudflare Access (RS256) contra las claves públicas del equipo.
 * Requiere vars ACCESS_TEAM_DOMAIN (p. ej. "ixorigue.cloudflareaccess.com") y ACCESS_AUD (Application Audience tag).
 */
let accessKeysCache = { at: 0, keys: [] };
async function verifyAccessJwt(token, env) {
  if (!token || !env.ACCESS_TEAM_DOMAIN || !env.ACCESS_AUD) return false;
  try {
    const [h, p, s] = token.split('.');
    const header = JSON.parse(b64urlText(h));
    const payload = JSON.parse(b64urlText(p));
    const aud = Array.isArray(payload.aud) ? payload.aud : [payload.aud];
    if (!aud.includes(env.ACCESS_AUD)) return false;
    if (!payload.exp || payload.exp * 1000 < Date.now()) return false;
    if (payload.iss && payload.iss !== `https://${env.ACCESS_TEAM_DOMAIN}`) return false;

    if (Date.now() - accessKeysCache.at > 3600000) {
      const res = await fetch(`https://${env.ACCESS_TEAM_DOMAIN}/cdn-cgi/access/certs`);
      accessKeysCache = { at: Date.now(), keys: (await res.json()).keys || [] };
    }
    const jwk = accessKeysCache.keys.find((k) => k.kid === header.kid);
    if (!jwk) return false;
    const key = await crypto.subtle.importKey('jwk', jwk, { name: 'RSASSA-PKCS1-v1_5', hash: 'SHA-256' }, false, ['verify']);
    return crypto.subtle.verify('RSASSA-PKCS1-v1_5', key, b64urlBytes(s), new TextEncoder().encode(`${h}.${p}`));
  } catch (e) {
    console.warn('Access JWT inválido:', e.message);
    return false;
  }
}
function b64urlBytes(s) {
  const bin = atob(s.replace(/-/g, '+').replace(/_/g, '/').padEnd(Math.ceil(s.length / 4) * 4, '='));
  return Uint8Array.from(bin, (c) => c.charCodeAt(0));
}
function b64urlText(s) {
  return new TextDecoder().decode(b64urlBytes(s));
}

async function timingSafeEqual(a, b) {
  const enc = new TextEncoder();
  // Se comparan los hashes para que ambas entradas tengan la misma longitud.
  const [ha, hb] = await Promise.all([
    crypto.subtle.digest('SHA-256', enc.encode(a)),
    crypto.subtle.digest('SHA-256', enc.encode(b)),
  ]);
  return crypto.subtle.timingSafeEqual(ha, hb);
}

/* ------------------------------------------------------------------ */
/* Endpoint de tareas                                                  */
/* ------------------------------------------------------------------ */

async function handleTasks(request, env, ctx, url) {
  if (!(await isAuthorized(request, env))) {
    return json({ error: 'Acceso no autorizado. PIN incorrecto.' }, 401);
  }
  env = { ...env, CLICKUP_TOKEN: env.CLICKUP_TOKEN || DEFAULT_CLICKUP_TOKEN };

  const ttl = num(env.CACHE_TTL_SECONDS, 120) * 1000;
  const minForce = num(env.MIN_FORCE_SECONDS, 30) * 1000;
  const wantsForce = url.searchParams.get('force') === '1' || url.searchParams.get('force') === 'true';

  const cached = await readCache(env);
  const age = cached ? Date.now() - cached.fetchedAt : Infinity;

  // Se sirve la caché si está fresca, o si se pide forzar pero el último refresco fue hace muy poco
  if (cached && (age < ttl && !wantsForce || age < minForce)) {
    return json({ ...cached, cache: 'HIT', ageSeconds: Math.round(age / 1000) });
  }

  try {
    const fresh = await fetchAllTasks(env);
    ctx.waitUntil(writeCache(env, fresh));
    return json({ ...fresh, cache: 'MISS', ageSeconds: 0 });
  } catch (err) {
    console.error('ClickUp fetch failed:', err.message);
    if (cached) {
      // Mejor datos algo antiguos que una pantalla vacía en el taller
      return json({ ...cached, cache: 'STALE', ageSeconds: Math.round(age / 1000), warning: err.message });
    }
    const status = err.status === 429 ? 429 : 502;
    return json({ error: err.message }, status);
  }
}

/* ------------------------------------------------------------------ */
/* ClickUp                                                             */
/* ------------------------------------------------------------------ */

async function fetchAllTasks(env) {
  const maxPages = num(env.MAX_PAGES, 25);
  const lookbackMs = num(env.CLOSED_LOOKBACK_DAYS, 400) * 86400000;
  const base = {
    'folder_ids[]': env.CLICKUP_FOLDER_ID,
    subtasks: 'true',
    include_markdown_description: 'false',
  };

  // 1) TODAS las tareas abiertas (lo que el taller necesita, sin límite artificial de 600)
  // 2) Solo las cerradas recientes (para analítica de soporte), en paralelo
  const [open, closed] = await Promise.all([
    fetchPages(env, { ...base, include_closed: 'false', order_by: 'due_date' }, maxPages),
    fetchPages(env, { ...base, include_closed: 'true', date_done_gt: String(Date.now() - lookbackMs), order_by: 'updated' }, maxPages),
  ]);

  const byId = new Map();
  for (const t of open.tasks) byId.set(t.id, slimTask(t));
  for (const t of closed.tasks) if (!byId.has(t.id)) byId.set(t.id, slimTask(t));

  return {
    fetchedAt: Date.now(),
    truncated: open.truncated || closed.truncated, // el frontend avisa si se ha cortado algo
    counts: { open: open.tasks.length, closedRecent: closed.tasks.length, total: byId.size },
    tasks: [...byId.values()],
  };
}

async function fetchPages(env, params, maxPages) {
  const tasks = [];
  let page = 0;
  let lastPage = false;
  while (!lastPage && page < maxPages) {
    const qs = new URLSearchParams({ ...params, page: String(page) });
    const res = await fetch(`https://api.clickup.com/api/v2/team/${env.CLICKUP_TEAM_ID}/task?${qs}`, {
      headers: { Authorization: env.CLICKUP_TOKEN, Accept: 'application/json' },
    });
    if (!res.ok) {
      const body = (await res.text()).slice(0, 200);
      const e = new Error(`ClickUp ${res.status}: ${body}`);
      e.status = res.status;
      throw e;
    }
    const data = await res.json();
    const batch = data.tasks || [];
    tasks.push(...batch);
    // ClickUp indica la última página con last_page; se mantiene la regla de <100 como respaldo
    lastPage = data.last_page === true || batch.length < 100;
    page++;
  }
  return { tasks, truncated: !lastPage };
}

/** Recorta cada tarea a lo que usa el dashboard (menos CPU, menos memoria, menos datos expuestos). */
function slimTask(t) {
  const text = t.text_content || t.description || '';
  return {
    id: t.id,
    name: t.name,
    description: text.slice(0, 1000), // 300 era poco: los síntomas a menudo van al final
    url: t.url || null,
    parent: t.parent || null,
    status: t.status ? { status: t.status.status, color: t.status.color, type: t.status.type } : null,
    priority: t.priority ? { priority: t.priority.priority } : null,
    due_date: t.due_date,
    start_date: t.start_date,
    date_created: t.date_created,
    date_updated: t.date_updated,
    date_closed: t.date_closed,
    date_done: t.date_done,
    list: t.list ? t.list.name : null,
    assignees: (t.assignees || []).map((a) => a.initials || a.username).filter(Boolean),
    tags: (t.tags || []).map((tag) => ({ name: tag.name })),
    custom: slimCustomFields(t.custom_fields),
  };
}

/** Campos personalizados con valor, ya resueltos a texto/número (desplegables incluidos). */
function slimCustomFields(fields) {
  const out = {};
  for (const f of fields || []) {
    if (f.value === undefined || f.value === null || f.value === '') continue;
    let v = f.value;
    const opts = f.type_config && f.type_config.options;
    if (f.type === 'drop_down' && opts) {
      const o = opts.find((x) => x.orderindex === v || x.id === v);
      v = o ? o.name : v;
    } else if (f.type === 'labels' && opts && Array.isArray(v)) {
      v = v.map((id) => (opts.find((x) => x.id === id) || {}).label).filter(Boolean);
    } else if (typeof v === 'object') {
      continue; // tipos complejos (usuarios, adjuntos…) no se envían
    }
    out[f.name] = v;
  }
  return out;
}

/* ------------------------------------------------------------------ */
/* Caché: KV si existe (global), si no Cache API (por data center)    */
/* ------------------------------------------------------------------ */

async function readCache(env) {
  try {
    if (env.HUB_CACHE) return await env.HUB_CACHE.get(CACHE_KEY, 'json');
    const hit = await caches.default.match(CACHE_URL);
    return hit ? await hit.json() : null;
  } catch (e) {
    console.warn('readCache:', e.message);
    return null;
  }
}

async function writeCache(env, payload) {
  try {
    const body = JSON.stringify(payload);
    // Se guarda 24 h: la frescura la decide CACHE_TTL_SECONDS; lo antiguo solo se usa si ClickUp falla
    if (env.HUB_CACHE) return await env.HUB_CACHE.put(CACHE_KEY, body, { expirationTtl: 86400 });
    await caches.default.put(CACHE_URL, new Response(body, {
      headers: { 'Content-Type': 'application/json', 'Cache-Control': 'public, max-age=86400' },
    }));
  } catch (e) {
    console.warn('writeCache:', e.message);
  }
}

/* ------------------------------------------------------------------ */
/* Utilidades                                                          */
/* ------------------------------------------------------------------ */

function json(data, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: {
      'Content-Type': 'application/json; charset=utf-8',
      'Cache-Control': 'no-store', // el navegador nunca guarda datos de clientes
      'X-Content-Type-Options': 'nosniff',
      'Referrer-Policy': 'no-referrer',
    },
  });
}

function num(v, fallback) {
  const n = parseInt(v, 10);
  return Number.isFinite(n) && n > 0 ? n : fallback;
}

