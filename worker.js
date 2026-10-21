export default {
  async fetch(request, env) {
    const url = new URL(request.url);

    // Si la llamada va dirigida a la API de ClickUp
    if (url.pathname === "/api/clickup" || url.pathname.startsWith("/api/clickup")) {
      return handleClickUp(request, env);
    }

    // Para cualquier otra ruta, servir index.html y los archivos estáticos
    return env.ASSETS.fetch(request);
  }
};

async function handleClickUp(request, env) {
  const corsHeaders = {
    "Access-Control-Allow-Origin": "*",
    "Access-Control-Allow-Methods": "GET, OPTIONS",
    "Access-Control-Allow-Headers": "x-pin-token, Content-Type",
    "Cache-Control": "no-store, no-cache, must-revalidate"
  };

  if (request.method === "OPTIONS") {
    return new Response(null, { headers: corsHeaders });
  }

  const EXPECTED_PIN = "IxorigueProd*2505!";
  const url = new URL(request.url);
  const providedPin = request.headers.get("x-pin-token") || url.searchParams.get("pin");

  if (providedPin !== EXPECTED_PIN) {
    return new Response(JSON.stringify({ error: "Acceso no autorizado. PIN incorrecto." }), {
      status: 401,
      headers: { ...corsHeaders, "Content-Type": "application/json" }
    });
  }

  const apiKey = "pk_106536124_OR1XJNSHG56NZ674CXGVB3RKWMJX4Q1C";
  const teamId = "90151302562";
  const folderId = "901515642734";

  try {
    let allTasks = [];
    let page = 0;
    let keepFetching = true;

    while (keepFetching && page < 10) {
      const response = await fetch(
        `https://api.clickup.com/api/v2/team/${teamId}/task?folder_ids%5B%5D=${folderId}&subtasks=true&include_closed=true&page=${page}`,
        {
          method: "GET",
          headers: {
            "Authorization": apiKey,
            "Content-Type": "application/json"
          }
        }
      );

      if (!response.ok) {
        throw new Error(`ClickUp error: ${response.status}`);
      }

      const data = await response.json();

      if (data.tasks && data.tasks.length > 0) {
        // Extraer únicamente los campos necesarios para aligerar la carga
        const lightTasks = data.tasks.map(t => ({
          id: t.id,
          name: t.name,
          status: t.status ? { status: t.status.status, color: t.status.color } : null,
          due_date: t.due_date,
          tags: t.tags ? t.tags.map(tag => ({ name: tag.name })) : [],
          priority: t.priority ? { priority: t.priority.priority } : null,
          date_closed: t.date_closed,
          date_updated: t.date_updated,
          description: (t.description && (t.description.includes('dispositivos') || t.description.includes('GW') || t.description.includes('AS')))
            ? t.description.substring(0, 300)
            : ''
        }));

        allTasks = allTasks.concat(lightTasks);
        if (data.tasks.length < 100) keepFetching = false;
        else page++;
      } else {
        keepFetching = false;
      }
    }

    return new Response(JSON.stringify({ tasks: allTasks }), {
      status: 200,
      headers: { ...corsHeaders, "Content-Type": "application/json" }
    });
  } catch (error) {
    return new Response(JSON.stringify({ error: error.message }), {
      status: 500,
      headers: { ...corsHeaders, "Content-Type": "application/json" }
    });
  }
}
