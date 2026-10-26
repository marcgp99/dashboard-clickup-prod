export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);

    // Permitir llamadas CORS preflight
    const corsHeaders = {
      "Access-Control-Allow-Origin": "*",
      "Access-Control-Allow-Methods": "GET, OPTIONS",
      "Access-Control-Allow-Headers": "Content-Type, x-pin-token"
    };

    if (request.method === "OPTIONS") {
      return new Response(null, { headers: corsHeaders });
    }

    // Ruta de la API
    if (url.pathname === "/api/clickup") {
      const EXPECTED_PIN = "IxorigueProd*2505!";
      const providedPin = request.headers.get("x-pin-token") || url.searchParams.get("pin");

      if (providedPin !== EXPECTED_PIN) {
        return new Response(JSON.stringify({ error: "Acceso no autorizado. PIN incorrecto." }), {
          status: 401,
          headers: { ...corsHeaders, "Content-Type": "application/json" }
        });
      }

      // 1. COMPROBAR SI ESTÁ EN CACHÉ (Ahorra 100% de CPU en consultas repetidas)
      const cache = caches.default;
      const cacheKey = new Request("https://cache.internal/clickup-tasks-data", { method: "GET" });
      const cachedResponse = await cache.match(cacheKey);

      // Si no es un refresco forzado y existe en caché, devolver inmediatamente
      const isForced = url.searchParams.get("force") === "true";
      if (cachedResponse && !isForced) {
        return new Response(cachedResponse.body, {
          headers: { ...corsHeaders, "Content-Type": "application/json", "X-Cache-Status": "HIT" }
        });
      }

      // 2. CONSULTA A CLICKUP
      const apiKey = "pk_106536124_OR1XJNSHG56NZ674CXGVB3RKWMJX4Q1C";
      const teamId = "90151302562";
      const folderId = "901515642734";

      try {
        let allTasks = [];
        let page = 0;
        let keepFetching = true;

        while (keepFetching && page < 6) { // Límite de 6 páginas para no exceder CPU
          const clickupUrl = `https://api.clickup.com/api/v2/team/${teamId}/task?folder_ids%5B%5D=${folderId}&subtasks=true&include_closed=true&page=${page}`;
          
          const response = await fetch(clickupUrl, {
            headers: {
              "Authorization": apiKey,
              "Content-Type": "application/json"
            }
          });

          if (!response.ok) {
            const errText = await response.text();
            throw new Error(`ClickUp ${response.status}: ${errText}`);
          }

          const data = await response.json();
          const tasks = data.tasks || [];

          if (tasks.length > 0) {
            // Filtrar solo los campos que el frontend necesita (aligera el consumo de CPU y memoria)
            for (let i = 0; i < tasks.length; i++) {
              const t = tasks[i];
              allTasks.push({
                id: t.id,
                name: t.name,
                description: t.description ? t.description.substring(0, 300) : "",
                status: t.status ? { status: t.status.status, color: t.status.color } : null,
                priority: t.priority ? { priority: t.priority.priority } : null,
                due_date: t.due_date,
                date_closed: t.date_closed,
                date_updated: t.date_updated,
                tags: (t.tags || []).map(tag => ({ name: tag.name }))
              });
            }
            page++;
            if (tasks.length < 100) keepFetching = false;
          } else {
            keepFetching = false;
          }
        }

        const payload = JSON.stringify({ tasks: allTasks });

        // Guardar en la caché de Cloudflare durante 60 segundos
        const responseToCache = new Response(payload, {
          headers: {
            "Content-Type": "application/json",
            "Cache-Control": "public, max-age=60"
          }
        });
        ctx.waitUntil(cache.put(cacheKey, responseToCache.clone()));

        return new Response(payload, {
          headers: { ...corsHeaders, "Content-Type": "application/json", "X-Cache-Status": "MISS" }
        });

      } catch (err) {
        return new Response(JSON.stringify({ error: err.message }), {
          status: 500,
          headers: { ...corsHeaders, "Content-Type": "application/json" }
        });
      }
    }

    // Servir los archivos estáticos de la web
    return env.ASSETS.fetch(request);
  }
};
