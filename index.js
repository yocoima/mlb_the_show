const express = require('express');
const path = require('path');
const { chromium } = require('playwright');

const app = express();
const PORT = Number(process.env.PORT) || 3000;
const isProduction = process.env.NODE_ENV === 'production';

app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

app.get('/api/health', (req, res) => {
  res.json({
    ok: true,
    environment: isProduction ? 'production' : 'development',
    timestamp: new Date().toISOString(),
  });
});

app.get('/api/scan', async (req, res) => {
  let browser;

  try {
    browser = await chromium.launch({
      headless: isProduction,
      args: isProduction ? ['--no-sandbox', '--disable-setuid-sandbox'] : [],
    });

    const context = await browser.newContext();
    const page = await context.newPage();
    let capturedProgramsPayload = null;

    page.on('response', async (response) => {
      if (!response.url().includes('/api/programs')) {
        return;
      }

      try {
        capturedProgramsPayload = await response.json();
      } catch (error) {
        console.error('No se pudo leer la respuesta de programas:', error.message);
      }
    });

    await page.goto('https://mlb26.theshow.com/dashboard', {
      waitUntil: 'domcontentloaded',
      timeout: 60000,
    });

    await page.waitForURL('**/dashboard', { timeout: 60000 });

    await page.goto('https://mlb26.theshow.com/programs/main', {
      waitUntil: 'networkidle',
      timeout: 60000,
    });

    await page.waitForTimeout(5000);

    const missions = processProgramData(capturedProgramsPayload);

    res.json({
      scannedAt: new Date().toISOString(),
      total: missions.length,
      missions,
    });
  } catch (error) {
    console.error('Error en la automatizacion:', error);
    res.status(500).json({
      error: 'No se pudo completar el escaneo.',
      detail: error.message,
    });
  } finally {
    if (browser) {
      await browser.close();
    }
  }
});

app.get('*', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

function processProgramData(data) {
  const missions = Array.isArray(data?.missions)
    ? data.missions
    : Array.isArray(data?.program?.missions)
      ? data.program.missions
      : [];

  return missions
    .filter((mission) => !mission.completed)
    .map((mission) => ({
      name: mission.name || 'Mision sin nombre',
      current: Number(mission.current) || 0,
      target: Number(mission.target) || 0,
      suggestion: generateSuggestion(mission),
    }))
    .sort((a, b) => {
      const aProgress = a.target > 0 ? a.current / a.target : 0;
      const bProgress = b.target > 0 ? b.current / b.target : 0;
      return bProgress - aProgress;
    });
}

function generateSuggestion(mission) {
  const name = `${mission.name || ''}`.toLowerCase();

  if (name.includes('pxp')) {
    return 'Prioriza Conquest o Mini Seasons con jugadores elegibles.';
  }

  if (name.includes('home run') || name.includes('jonron')) {
    return 'Busca estadios favorables al poder para acelerar la mision.';
  }

  if (name.includes('strikeout') || name.includes('ponche')) {
    return 'Usa pitchers con alto K/9 en modos offline cortos.';
  }

  if (name.includes('hit') || name.includes('single') || name.includes('doble')) {
    return 'Juega vs CPU en dificultad baja para farmear contacto rapido.';
  }

  return 'Avanza esta mision en modos offline para progreso estable.';
}

app.listen(PORT, () => {
  console.log(`Servidor iniciado en http://localhost:${PORT}`);
});
