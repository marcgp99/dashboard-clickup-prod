export default async function handler(req, res) {
  // Configuración de Seguridad y Anti-Caché
  res.setHeader('Cache-Control', 'no-store, no-cache, must-revalidate, proxy-revalidate');
  res.setHeader('Pragma', 'no-cache');
  res.setHeader('Expires', '0');

  // NUEVA CLAVE DE ACCESO
  const EXPECTED_PIN = 'IxorigueProd*2505!';
  const providedPin = req.headers['x-pin-token'] || req.query.pin;

  // Validación de PIN
  if (providedPin !== EXPECTED_PIN) {
    return res.status(401).json({ error: 'Acceso no autorizado. PIN incorrecto.' });
  }

  const apiKey = process.env.CLICKUP_API_KEY;
  const teamId = '90151302562';
  const folderId = '901515642734';

  try {
    let allTasks = [];
    let page = 0;
    let keepFetching = true;

    // Paginación continua (máximo 1000 tiquets)
    while (keepFetching && page < 10) { 
      const response = await fetch(`https://api.clickup.com/api/v2/team/${teamId}/task?folder_ids%5B%5D=${folderId}&subtasks=true&include_closed=true&page=${page}`, {
        method: 'GET',
        headers: {
          'Authorization': apiKey,
          'Content-Type': 'application/json',
          'Cache-Control': 'no-cache'
        }
      });

      if (!response.ok) {
        throw new Error(`ClickUp respondió con estado: ${response.status}`);
      }

      const data = await response.json();
      
      if (data.tasks && data.tasks.length > 0) {
        allTasks = allTasks.concat(data.tasks);
        if (data.tasks.length < 100) {
          keepFetching = false;
        } else {
          page++;
        }
      } else {
        keepFetching = false;
      }
    }
    
    res.status(200).json({ tasks: allTasks });
    
  } catch (error) {
    console.error(error);
    res.status(500).json({ error: error.message });
  }
}
