const express = require('express');
const fs = require('fs');
const path = require('path');
const { chromium } = require('playwright');

const app = express();
const PORT = Number(process.env.PORT) || 3000;
const isProduction = process.env.NODE_ENV === 'production';
const LOGIN_TIMEOUT_MS = Number(process.env.LOGIN_TIMEOUT_MS) || (isProduction ? 60000 : 300000);
const USER_DATA_DIR = path.join(__dirname, '.playwright-profile');
const DATA_DIR = process.env.DATA_DIR || __dirname;
const LOCAL_BROWSER_CHANNEL = process.env.PLAYWRIGHT_BROWSER_CHANNEL || 'chrome';
const AUTH_CHECK_URL = 'https://mlb26.theshow.com/dashboard';
const PROGRAMS_URL = 'https://mlb26.theshow.com/programs';
const INVENTORY_URL = 'https://mlb26.theshow.com/inventory?captains=&display_position=&event=&has_augment=&max_rank=&min_rank=&name=&ownership=owned&rarity_id=&series_id=&stars=&team_id=&type=mlb_card';
const PAGE_NAV_TIMEOUT_MS = Number(process.env.PAGE_NAV_TIMEOUT_MS) || 30000;
const PROGRAM_DISCOVERY_PATTERNS = [
  '/programs/program_view',
  '/programs/team_affinity',
  '/programs/team_affinity_by_team',
  '/programs/other_programs',
];
let lastSonyRateLimitAt = 0;
const scanStates = new Map();
const inventoryScanStates = new Map();
const catalogScanStates = new Map();

function getInventoryScanState(userId) {
  if (!inventoryScanStates.has(userId)) {
    inventoryScanStates.set(userId, {
      active: false,
      pagesScanned: 0,
      cardsFound: 0,
      startedAt: null,
      completedAt: null,
      lastError: null,
    });
  }
  return inventoryScanStates.get(userId);
}

function getCatalogScanState(userId) {
  if (!catalogScanStates.has(userId)) {
    catalogScanStates.set(userId, {
      active: false,
      phase: 'idle',
      startedAt: null,
      completedAt: null,
      lastError: null,
    });
  }
  return catalogScanStates.get(userId);
}

fs.mkdirSync(DATA_DIR, { recursive: true });

function getUserDir(userId) {
  return path.join(DATA_DIR, 'users', userId);
}

function getAuthStateFile(userId) {
  return path.join(getUserDir(userId), 'auth_state.json');
}

function getScanResultsFile(userId) {
  return path.join(getUserDir(userId), 'scan_results.json');
}

function getInventoryResultsFile(userId) {
  return path.join(getUserDir(userId), 'inventory_results.json');
}

function ensureUserDir(userId) {
  fs.mkdirSync(getUserDir(userId), { recursive: true });
}

function getScanState(userId) {
  if (!scanStates.has(userId)) {
    scanStates.set(userId, {
      active: false,
      cancelRequested: false,
      phase: 'idle',
      totalPrograms: 0,
      completedPrograms: 0,
      currentProgramTitle: '',
      startedAt: null,
      completedAt: null,
      lastError: null,
    });
  }
  return scanStates.get(userId);
}

function getUserId(req) {
  const token = `${req.headers['x-user-token'] || ''}`.trim();
  return /^[a-zA-Z0-9_-]{2,50}$/.test(token) ? token.toLowerCase() : null;
}

function requireUserId(req, res) {
  const userId = getUserId(req);
  if (!userId) {
    res.status(400).json({ error: 'Token de usuario requerido.', detail: 'Recarga la pagina para generar tu identificador unico.' });
    return null;
  }
  ensureUserDir(userId);
  return userId;
}

app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

app.get('/api/health', (req, res) => {
  res.json({
    ok: true,
    environment: isProduction ? 'production' : 'development',
    timestamp: new Date().toISOString(),
  });
});

app.post('/api/reset-session', async (req, res) => {
  const userId = requireUserId(req, res);
  if (!userId) return;

  try {
    fs.rmSync(USER_DATA_DIR, { recursive: true, force: true });
    fs.rmSync(getAuthStateFile(userId), { force: true });

    res.json({
      ok: true,
      message: 'La sesion local de Playwright y auth_state.json fueron reiniciados.',
    });
  } catch (error) {
    res.status(500).json({
      error: 'No se pudo reiniciar la sesion local.',
      detail: error.message,
    });
  }
});

app.get('/api/last-scan', async (req, res) => {
  const userId = requireUserId(req, res);
  if (!userId) return;

  const results = normalizeUntitledPrograms(readScanResults(userId));
  const inventory = readInventoryResults(userId);
  const enriched = attachInventorySuggestionsToScanResults(results, inventory);
  const cleanedCatalogPrograms = filterIgnoredPrograms(enriched.catalogPrograms).filter((program) => !isUntitledProgram(program));
  res.json({
    ...enriched,
    catalogPrograms: cleanedCatalogPrograms,
    missions: Array.isArray(enriched.missions) ? enriched.missions.filter((mission) => !isIgnoredMission(mission)) : [],
  });
});

app.get('/api/inventory', async (req, res) => {
  const userId = requireUserId(req, res);
  if (!userId) return;

  res.json(readInventoryResults(userId));
});

app.post('/api/import-session', async (req, res) => {
  const userId = requireUserId(req, res);
  if (!userId) return;

  try {
    const raw = `${req.body?.raw || ''}`.trim();

    if (!raw) {
      return res.status(400).json({
        error: 'No se recibio ningun contenido.',
        detail: 'Pega un JSON de cookies o un storageState exportado desde tu navegador.',
      });
    }

    const parsed = JSON.parse(raw);
    const storageState = normalizeImportedSession(parsed);
    const authFile = getAuthStateFile(userId);

    fs.writeFileSync(authFile, JSON.stringify(storageState, null, 2));

    res.json({
      ok: true,
      authStatePath: authFile,
      cookieCount: storageState.cookies.length,
      message: 'La sesion importada fue guardada como auth_state.json.',
    });
  } catch (error) {
    res.status(400).json({
      error: 'No se pudo importar la sesion.',
      detail: error.message,
    });
  }
});

app.get('/api/session-status', (req, res) => {
  const userId = requireUserId(req, res);
  if (!userId) return;

  const savedStateExists = hasSavedAuthState(userId);
  res.json({
    authenticated: savedStateExists,
    currentUrl: null,
    checkedAt: new Date().toISOString(),
    hasSavedAuthState: savedStateExists,
    suggestedUserId: null,
    rateLimited: isSonyRateLimited(),
    lastSonyRateLimitAt: lastSonyRateLimitAt || null,
  });
});

app.get('/api/programs/catalog', (req, res) => {
  const userId = requireUserId(req, res);
  if (!userId) return;

  const previousResults = normalizeUntitledPrograms(readScanResults(userId));
  const cachedPrograms = filterIgnoredPrograms(previousResults.catalogPrograms)
    .filter((program) => !isUntitledProgram(program));

  res.json({
    discoveredAt: previousResults.scannedAt || null,
    programs: cachedPrograms,
    cached: true,
  });
});

app.post('/api/programs/catalog/refresh', (req, res) => {
  const userId = requireUserId(req, res);
  if (!userId) return;

  const state = getCatalogScanState(userId);
  if (state.active) {
    return res.status(409).json({
      error: 'Ya hay una actualizacion de catalogo en progreso.',
      detail: 'Espera a que termine antes de volver a actualizar.',
    });
  }

  if (!hasSavedAuthState(userId)) {
    return res.status(400).json({
      error: 'No existe una sesion persistida.',
      detail: 'Primero importa o prepara una sesion valida.',
    });
  }

  const startedAt = new Date().toISOString();
  state.active = true;
  state.phase = 'starting';
  state.startedAt = startedAt;
  state.completedAt = null;
  state.lastError = null;

  res.json({ ok: true, started: true, startedAt });
  res.on('finish', () => runCatalogScanInBackground(userId));
});

app.get('/api/programs/catalog/refresh-status', (req, res) => {
  const userId = requireUserId(req, res);
  if (!userId) return;
  const state = getCatalogScanState(userId);
  res.json(state);
});

app.get('/api/open-login', async (req, res) => {
  const userId = requireUserId(req, res);
  if (!userId) return;

  let context;

  try {
    if (isSonyRateLimited()) {
      return res.status(429).json({
        error: 'Sony esta limitando temporalmente el login.',
        detail: buildSonyRateLimitMessage(),
      });
    }

    context = await launchBrowserContext();
    const page = context.pages()[0] || await context.newPage();

    await page.goto(AUTH_CHECK_URL, {
      waitUntil: 'domcontentloaded',
      timeout: 60000,
    });

    const authenticated = await waitForAuthenticatedSession(page, LOGIN_TIMEOUT_MS);

    if (!authenticated) {
      return res.status(408).json({
        error: 'No se completo el login a tiempo.',
        detail: [
          `No se completo el login dentro de ${Math.round(LOGIN_TIMEOUT_MS / 1000)} segundos.`,
          'Si Sony mostro un error, espera unos minutos antes de reintentar.',
          `Ultima URL vista: ${page.url()}`,
        ].join(' '),
      });
    }

    await context.storageState({ path: getAuthStateFile(userId) });

    res.json({
      ok: true,
      authenticated: true,
      currentUrl: page.url(),
      message: 'Sesion lista. auth_state.json fue guardado y ya puedes ejecutar el escaneo sin volver a loguearte.',
    });
  } catch (error) {
    res.status(500).json({
      error: 'No se pudo preparar la sesion.',
      detail: buildUserFacingError(error),
    });
  } finally {
    if (context) {
      await context.close();
    }
  }
});

app.get('/api/scan', async (req, res) => {
  const userId = requireUserId(req, res);
  if (!userId) return;
  const results = normalizeUntitledPrograms(readScanResults(userId));
  const inventory = readInventoryResults(userId);
  const enriched = attachInventorySuggestionsToScanResults(results, inventory);
  res.json(enriched);
});

app.post('/api/scan', (req, res) => {
  const userId = requireUserId(req, res);
  if (!userId) return;

  const state = getScanState(userId);

  if (state.active) {
    return res.status(409).json({
      error: 'Ya hay un escaneo en progreso.',
      detail: 'Espera a que termine o usa el boton Detener escaneo.',
    });
  }

  if (isSonyRateLimited()) {
    return res.status(429).json({
      error: 'Sony esta limitando temporalmente el login.',
      detail: buildSonyRateLimitMessage(),
    });
  }

  if (!hasSavedAuthState(userId)) {
    return res.status(400).json({
      error: 'No existe una sesion persistida.',
      detail: 'Primero prepara una sesion valida desde PC para crear auth_state.json.',
    });
  }

  const selectedPrograms = Array.isArray(req.body?.selectedPrograms)
    ? req.body.selectedPrograms.filter(Boolean)
    : [];

  const startedAt = new Date().toISOString();
  state.active = true;
  state.cancelRequested = false;
  state.phase = 'queued';
  state.totalPrograms = 0;
  state.completedPrograms = 0;
  state.currentProgramTitle = '';
  state.startedAt = startedAt;
  state.completedAt = null;
  state.lastError = null;

  res.json({ ok: true, started: true, startedAt });
  res.on('finish', () => runScanInBackground(selectedPrograms, userId));
});

app.post('/api/scan/cancel', (req, res) => {
  const userId = requireUserId(req, res);
  if (!userId) return;

  const state = getScanState(userId);
  if (!state.active) {
    return res.json({
      ok: true,
      cancelled: false,
      message: 'No hay un escaneo activo.',
    });
  }

  state.cancelRequested = true;
  return res.json({
    ok: true,
    cancelled: true,
    message: 'Se solicito detener el escaneo activo.',
  });
});

app.get('/api/scan/status', (req, res) => {
  const userId = requireUserId(req, res);
  if (!userId) return;

  const state = getScanState(userId);
  const total = Number(state.totalPrograms) || 0;
  const completed = Number(state.completedPrograms) || 0;
  const percent = total > 0 ? Math.min(100, Math.round((completed / total) * 100)) : 0;

  res.json({
    active: state.active,
    cancelRequested: state.cancelRequested,
    phase: state.phase,
    totalPrograms: total,
    completedPrograms: completed,
    currentProgramTitle: state.currentProgramTitle || '',
    startedAt: state.startedAt,
    completedAt: state.completedAt,
    lastError: state.lastError,
    percent,
  });
});

app.get('/api/inventory/scan-status', (req, res) => {
  const userId = requireUserId(req, res);
  if (!userId) return;
  const state = getInventoryScanState(userId);
  res.json({
    active: state.active,
    pagesScanned: state.pagesScanned,
    cardsFound: state.cardsFound,
    startedAt: state.startedAt,
    completedAt: state.completedAt,
    lastError: state.lastError,
  });
});

app.post('/api/inventory/scan', (req, res) => {
  const userId = requireUserId(req, res);
  if (!userId) return;

  const invState = getInventoryScanState(userId);
  if (invState.active) {
    return res.status(409).json({
      error: 'Ya hay un escaneo de inventario en progreso.',
      detail: 'Espera a que termine antes de volver a escanear.',
    });
  }

  if (!hasSavedAuthState(userId)) {
    return res.status(400).json({
      error: 'No existe una sesion persistida.',
      detail: 'Primero importa o prepara una sesion valida.',
    });
  }

  const startedAt = new Date().toISOString();
  invState.active = true;
  invState.pagesScanned = 0;
  invState.cardsFound = 0;
  invState.startedAt = startedAt;
  invState.completedAt = null;
  invState.lastError = null;

  res.json({ ok: true, started: true, startedAt });
  res.on('finish', () => runInventoryScanInBackground(userId));
});

async function runCatalogScanInBackground(userId) {
  let browser;
  let context;
  const state = getCatalogScanState(userId);

  try {
    state.phase = 'launching-browser';
    browser = await launchBrowser();
    context = await browser.newContext({ storageState: getAuthStateFile(userId) });
    const page = await context.newPage();

    state.phase = 'navigating';
    await page.goto(PROGRAMS_URL, { waitUntil: 'domcontentloaded', timeout: 60000 });
    ensureAuthenticatedPage(page);

    state.phase = 'discovering';
    const discovery = await discoverProgramTargets(context, page);
    const programs = normalizeCatalogPrograms(
      (await hydrateMissingProgramTitles(context, filterIgnoredPrograms(discovery.programs)))
        .filter((program) => !isUntitledProgram(program))
    );

    state.phase = 'saving';
    const previousResults = normalizeUntitledPrograms(readScanResults(userId));
    writeScanResults(userId, { ...previousResults, catalogPrograms: programs });
  } catch (error) {
    console.error('[catalog/refresh] Error:', error.message);
    state.lastError = buildUserFacingError(error);
  } finally {
    state.active = false;
    state.phase = 'idle';
    state.completedAt = new Date().toISOString();
    if (context) await context.close().catch(() => {});
    if (browser) await browser.close().catch(() => {});
  }
}

async function runInventoryScanInBackground(userId) {
  let browser;
  let context;
  const invState = getInventoryScanState(userId);

  try {
    browser = await launchBrowser();
    context = await browser.newContext({ storageState: getAuthStateFile(userId) });
    const page = await context.newPage();

    await page.goto(AUTH_CHECK_URL, { waitUntil: 'domcontentloaded', timeout: 60000 });

    if (!isAuthenticatedMlbUrl(page.url())) {
      fs.rmSync(getAuthStateFile(userId), { force: true });
      invState.lastError = 'La sesion persistida vencio. Debes reimportar las cookies.';
      return;
    }

    const cards = await scanFullInventory(context, page, (pagesScanned, cardsFound) => {
      invState.pagesScanned = pagesScanned;
      invState.cardsFound = cardsFound;
    });

    const results = { scannedAt: new Date().toISOString(), total: cards.length, cards };
    writeInventoryResults(userId, results);
    await persistAuthState(context, userId);
  } catch (error) {
    console.error('[inventory/scan] Error:', error.message);
    if (isSessionExpiredError(error)) {
      fs.rmSync(getAuthStateFile(userId), { force: true });
      invState.lastError = 'La sesion expiro durante el escaneo del inventario. Reimporta las cookies.';
    } else {
      invState.lastError = buildUserFacingError(error);
    }
  } finally {
    invState.active = false;
    invState.completedAt = new Date().toISOString();
    if (context) await context.close().catch(() => {});
    if (browser) await browser.close().catch(() => {});
  }
}

async function runScanInBackground(selectedPrograms, userId) {
  let browser;
  let context;
  let scanCancelled = false;
  const state = getScanState(userId);

  try {
    state.phase = 'validating-session';

    browser = await launchBrowser();
    context = await browser.newContext({
      storageState: getAuthStateFile(userId),
    });

    const page = await context.newPage();

    await page.goto(AUTH_CHECK_URL, {
      waitUntil: 'domcontentloaded',
      timeout: 60000,
    });

    if (!isAuthenticatedMlbUrl(page.url())) {
      fs.rmSync(getAuthStateFile(userId), { force: true });
      throw new Error('La sesion persistida vencio. Debes renovar la sesion desde PC.');
    }

    await page.goto(PROGRAMS_URL, {
      waitUntil: 'networkidle',
      timeout: 60000,
    });
    await persistAuthState(context, userId);
    state.phase = 'discovering-programs';

    const previousResults = normalizeUntitledPrograms(readScanResults(userId));
    const selectedSet = new Set(selectedPrograms);
    let discovery = null;
    let catalogPrograms = filterIgnoredPrograms(previousResults.catalogPrograms);
    let targetPrograms = [];
    const seenProgramUrls = [];

    if (selectedSet.size) {
      targetPrograms = catalogPrograms.filter((program) => selectedSet.has(program.url));
      const missingSelections = Array.from(selectedSet).filter((url) => !targetPrograms.some((program) => program.url === url));

      if (missingSelections.length) {
        discovery = await discoverProgramTargets(context, page);
        catalogPrograms = (await hydrateMissingProgramTitles(context, filterIgnoredPrograms(discovery.programs)))
          .filter((program) => !isUntitledProgram(program));
        targetPrograms = catalogPrograms.filter((program) => selectedSet.has(program.url));
        seenProgramUrls.push(...discovery.discoveryLinks);
      }
    } else {
      discovery = await discoverProgramTargets(context, page);
      catalogPrograms = (await hydrateMissingProgramTitles(context, filterIgnoredPrograms(discovery.programs)))
        .filter((program) => !isUntitledProgram(program));
      targetPrograms = catalogPrograms;
      seenProgramUrls.push(...discovery.discoveryLinks);
    }

    const programLinks = targetPrograms.map((program) => program.url);
    state.totalPrograms = programLinks.length;
    state.completedPrograms = 0;
    state.phase = 'scanning-programs';

    if (!programLinks.length) {
      throw new Error('Se abrio /programs, pero no se encontraron enlaces visitables de programas.');
    }

    const missions = [];
    const visitedLinks = [];
    const skippedLinks = [];
    let sessionExpired = false;

    for (const link of programLinks) {
      if (state.cancelRequested) {
        scanCancelled = true;
        skippedLinks.push({ url: link, reason: 'Escaneo cancelado por el usuario.' });
        break;
      }

      try {
        const programMeta = targetPrograms.find((program) => program.url === link) || { url: link };
        state.currentProgramTitle = programMeta.title || link;
        const result = await scanProgramPage(context, programMeta, seenProgramUrls);
        visitedLinks.push(link);
        state.completedPrograms = visitedLinks.length;
        await persistAuthState(context, userId);

        if (result.programTitle && result.programTitle !== 'Programa sin titulo') {
          const targetProgram = targetPrograms.find((program) => program.url === link);
          if (targetProgram) {
            targetProgram.title = result.programTitle;
          }

          const catalogProgram = catalogPrograms.find((program) => program.url === link);
          if (catalogProgram) {
            catalogProgram.title = result.programTitle;
          }
        }

        if (Array.isArray(result.missions) && result.missions.length) {
          missions.push(...result.missions);
        }
      } catch (error) {
        if (isSessionExpiredError(error)) {
          sessionExpired = true;
          skippedLinks.push({ url: link, reason: 'La sesion expiro durante el escaneo.' });
          break;
        }

        console.warn(`No se pudo escanear ${link}:`, error.message);
        skippedLinks.push({ url: link, reason: error.message });
      }
    }

    const dedupedMissions = dedupeMissions(missions);
    state.phase = 'finalizing-results';
    const scanResults = normalizeUntitledPrograms(buildPersistedScanResults({
      previous: readScanResults(userId),
      scannedMissions: dedupedMissions,
      scannedProgramUrls: visitedLinks,
      catalogPrograms,
      sessionExpired,
      skippedLinks,
      cancelled: scanCancelled,
    }));

    if (!scanResults.missions.length) {
      throw new Error(
        [
          'Se abrieron paginas program_view, pero no se encontraron misiones utilizables.',
          `Programas visitados: ${visitedLinks.slice(0, 10).join(', ')}`,
          seenProgramUrls.length ? `URLs candidatas vistas: ${seenProgramUrls.slice(0, 10).join(', ')}` : 'No se detectaron URLs JSON candidatas.',
        ].join(' ')
      );
    }

    writeScanResults(userId, scanResults);

    if (scanCancelled) {
      state.lastError = 'Escaneo detenido. Se guardaron los objetivos encontrados hasta ese momento.';
    } else if (sessionExpired) {
      state.lastError = 'La sesion expiro durante el escaneo. Se muestran los objetivos encontrados hasta ese momento.';
    }
  } catch (error) {
    console.error('Error en la automatizacion:', error);
    state.lastError = buildUserFacingError(error);
  } finally {
    state.active = false;
    state.cancelRequested = false;
    state.phase = 'idle';
    state.completedAt = new Date().toISOString();
    state.totalPrograms = 0;
    state.completedPrograms = 0;
    state.currentProgramTitle = '';
    state.startedAt = null;

    if (context) {
      await context.close().catch(() => {});
    }

    if (browser) {
      await browser.close().catch(() => {});
    }
  }
}

app.post('/api/ai-suggest', async (req, res) => {
  const userId = requireUserId(req, res);
  if (!userId) return;

  const apiKey = process.env.GROQ_API_KEY;
  if (!apiKey) {
    return res.status(503).json({
      error: 'Servicio de IA no disponible.',
      detail: 'La variable GROQ_API_KEY no esta configurada en el servidor. Agregala en Render → Settings → Environment Variables.',
    });
  }

  try {
    const scanResults = normalizeUntitledPrograms(readScanResults(userId));
    const inventory = readInventoryResults(userId);

    const missions = (scanResults.missions || []).filter((m) => (m.current || 0) < (m.target || 0));
    const cards = inventory?.cards || [];

    if (!missions.length) {
      return res.status(400).json({
        error: 'No hay objetivos activos para analizar.',
        detail: 'Ejecuta un escaneo de programas primero.',
      });
    }

    const prompt = buildAiSuggestPrompt(missions, cards);
    const rawResponse = await callGroqApi(apiKey, prompt);

    let parsed;
    try {
      const jsonMatch = rawResponse.match(/\{[\s\S]*\}/);
      parsed = JSON.parse(jsonMatch ? jsonMatch[0] : rawResponse);
    } catch {
      return res.status(500).json({
        error: 'La IA devolvio una respuesta con formato invalido.',
        detail: 'Intenta de nuevo. Si el error persiste, reduce la cantidad de programas seleccionados.',
      });
    }

    return res.json({
      recommendations: parsed.recommendations || [],
      best_overall_modes: parsed.best_overall_modes || [],
      summary: parsed.summary || '',
      analyzedAt: new Date().toISOString(),
      missionsAnalyzed: missions.length,
      cardsProvided: cards.length,
    });
  } catch (error) {
    console.error('[ai-suggest] Error:', error.message);
    return res.status(500).json({
      error: 'No se pudo completar el analisis de IA.',
      detail: error.message,
    });
  }
});

async function callGroqApi(apiKey, userPrompt) {
  const response = await fetch('https://api.groq.com/openai/v1/chat/completions', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Authorization': `Bearer ${apiKey}`,
    },
    body: JSON.stringify({
      model: 'llama-3.3-70b-versatile',
      messages: [
        {
          role: 'system',
          content: 'Eres un experto en MLB The Show 26 Diamond Dynasty. Analizas misiones del juego y recomiendas estrategias optimas. Respondes SIEMPRE con JSON valido segun el esquema que se te indique. Sin texto extra fuera del JSON.',
        },
        {
          role: 'user',
          content: userPrompt,
        },
      ],
      temperature: 0.25,
      max_tokens: 6000,
      response_format: { type: 'json_object' },
    }),
  });

  if (!response.ok) {
    const errorText = await response.text().catch(() => response.statusText);
    throw new Error(`Groq API ${response.status}: ${errorText}`);
  }

  const data = await response.json();
  return data.choices?.[0]?.message?.content || '';
}

function buildAiSuggestPrompt(missions, cards) {
  const missionsText = missions
    .slice(0, 80)
    .map((m, i) =>
      `${i + 1}. [${escapeJsonString(m.programTitle)}] ${escapeJsonString(m.name)}\n   Requisito: ${escapeJsonString(m.description)}\n   Donde jugar: ${escapeJsonString(m.whereToPlay)}\n   Progreso: ${m.current}/${m.target}`
    )
    .join('\n\n');

  const cardsText = cards.length
    ? cards
        .slice(0, 400)
        .map((c) => `- ${c.name} (${c.overall || '?'} OVR) ${c.position || ''}${c.team ? ` | ${c.team}` : ''}${c.series ? ` | Serie: ${c.series}` : ''}`)
        .join('\n')
    : 'Sin inventario escaneado.';

  return `Analiza los siguientes objetivos activos de MLB The Show 26 y el inventario de cartas del jugador. Tu objetivo es encontrar las estrategias mas eficientes para avanzar MULTIPLES objetivos en la misma sesion de juego.

OBJETIVOS ACTIVOS (${missions.length} objetivos${missions.length > 80 ? ', mostrando los primeros 80' : ''}):
${missionsText}

INVENTARIO DEL JUGADOR (${cards.length} cartas${cards.length > 400 ? ', mostrando las primeras 400' : ''}):
${cardsText}

REGLAS DE ANALISIS:
1. Agrupa objetivos que se puedan completar en la misma partida porque sus requisitos se solapan (mismo tipo de stat, misma serie de cartas, mismo equipo, etc.)
2. Los modos de juego recomendados para cada grupo DEBEN aparecer en el "Donde jugar" de TODOS los objetivos del grupo
3. Recomienda las cartas del inventario que cubran MAS objetivos del grupo. Marca "in_inventory": true si la carta esta en el inventario, false si la sugieres aunque no este
4. Una carta puede cubrir varios objetivos si cumple multiples requisitos (ej: un Yankees de Serie Spotlight cuenta para objetivos de Yankees Y de Spotlight Y de hitters)
5. Ordena las recomendaciones de mayor a menor impacto (el grupo con mas objetivos cubiertos primero)
6. Si no hay cartas en inventario que sirvan, sugiere que carta conseguir (in_inventory: false)

Responde UNICAMENTE con este JSON valido:
{
  "recommendations": [
    {
      "missions_covered": ["nombre exacto mision 1", "nombre exacto mision 2"],
      "programs": ["programa1", "programa2"],
      "best_modes": ["Conquest", "Mini Seasons"],
      "recommended_cards": [
        {
          "name": "Nombre jugador",
          "overall": 93,
          "position": "1B",
          "team": "Yankees",
          "series": "Spotlight",
          "in_inventory": true,
          "covers_missions_count": 3,
          "reason": "Es Yankees (Affinity), Spotlight (XP objetivo), y bateador (hit milestone). Un jugador con esta carta en Conquest avanza los 3 objetivos a la vez."
        }
      ],
      "strategy": "Descripcion concisa de la estrategia: que hacer, con que cartas y en que modo."
    }
  ],
  "best_overall_modes": ["Conquest", "Mini Seasons"],
  "summary": "Resumen ejecutivo: la forma mas eficiente de avanzar todos los objetivos con el inventario actual."
}`;
}

function escapeJsonString(value) {
  return String(value || '').replace(/[\n\r"\\]/g, ' ').trim();
}

app.get('*', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

function processProgramData(data) {
  const missions = extractMissionArray(data);

  return missions
    .filter((mission) => !mission.completed)
    .map((mission) => ({
      name: mission.name || 'Mision sin nombre',
      objectiveGroup: mission.objectiveGroup || 'General',
      description: mission.description || '',
      whereToPlay: mission.whereToPlay || '',
      programTitle: mission.programTitle || 'Programa sin titulo',
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

function generateStatHint(text) {
  if (text.includes('home run') || text.includes('jonron') || text.includes('cuadrangular')) return 'Usa bateadores de alto poder';
  if (text.includes('strikeout') || text.includes('ponche')) {
    return (text.includes('abanicar') || text.includes('bateador')) ? 'Enfrentate a pitchers dominantes' : 'Usa pitchers con alto K/9';
  }
  if (text.includes('stolen base') || text.includes('base robada') || text.includes('robar')) return 'Usa corredores con alto Speed';
  if (text.includes('rbi') || text.includes('carrera impulsada')) return 'Prioriza situaciones con corredores en base';
  if (text.includes('doble') || text.includes('triple') || text.includes('extra base') || text.includes('extrabase')) return 'Usa bateadores con buen contacto';
  if (text.includes(' hit') || text.includes('imparable') || text.includes('sencillo') || text.includes('single')) return 'Usa bateadores de alto contacto';
  if (text.includes('victoria') || text.includes('ganar') || text.includes(' win')) return 'Optimiza tu lineup para consistencia';
  if (text.includes('pxp') || text.includes('player xp') || text.includes('puntos de exp')) return 'Usa jugadores elegibles para acumular PxP';
  if (text.includes('inning') || text.includes('entrada')) return 'Lanza partidos completos offline';
  return null;
}

function generateModeHint(whereText) {
  if (!whereText) return null;
  const w = whereText.toLowerCase();
  const modes = [];
  if (w.includes('conquest')) modes.push('Conquest');
  if (w.includes('mini seasons') || w.includes('mini-seasons')) modes.push('Mini Seasons');
  if (w.includes('ranked')) modes.push('Ranked Seasons');
  if (w.includes('events')) modes.push('Events');
  if (w.includes('moments')) modes.push('Moments');
  if (w.includes('showdown')) modes.push('Showdown');
  if (w.includes('battle royale')) modes.push('Battle Royale');
  if (w.includes('vs cpu') || w.includes('vs. cpu')) modes.push('vs. CPU');
  if (!modes.length) return null;
  const modeStr = modes.length === 1 ? modes[0] : `${modes.slice(0, -1).join(', ')} o ${modes[modes.length - 1]}`;
  return `en ${modeStr}`;
}

function generateSuggestion(mission) {
  const combined = `${mission.description || ''} ${mission.name || ''}`.toLowerCase();
  const statHint = generateStatHint(combined);
  const modeHint = generateModeHint(mission.whereToPlay);
  if (statHint && modeHint) return `${statHint} ${modeHint}.`;
  if (statHint) return `${statHint}.`;
  if (modeHint) return `Avanza esta mision ${modeHint}.`;
  return 'Avanza esta mision en modos offline para progreso estable.';
}

function extractStatCategory(mission) {
  const text = `${mission.description || ''} ${mission.name || ''}`.toLowerCase();
  if (text.includes('home run') || text.includes('jonron') || text.includes('cuadrangular')) return 'hr';
  if (text.includes('strikeout') || text.includes('ponche')) {
    return (text.includes('abanicar') || text.includes('bateador')) ? 'k_batter' : 'k_pitcher';
  }
  if (text.includes('stolen base') || text.includes('base robada') || text.includes('robar')) return 'sb';
  if (text.includes('rbi') || text.includes('carrera impulsada')) return 'rbi';
  if (text.includes('doble') || text.includes('triple') || text.includes('extra base')) return 'xbh';
  if (text.includes(' hit') || text.includes('imparable') || text.includes('sencillo') || text.includes('single')) return 'hits';
  if (text.includes('victoria') || text.includes('ganar') || text.includes(' win')) return 'wins';
  if (text.includes('pxp') || text.includes('player xp')) return 'pxp';
  if (text.includes('inning') || text.includes('entrada')) return 'ip';
  return null;
}

function extractModeSet(whereToPlay) {
  const w = `${whereToPlay || ''}`.toLowerCase();
  const modes = new Set();
  if (w.includes('conquest')) modes.add('conquest');
  if (w.includes('mini seasons') || w.includes('mini-seasons')) modes.add('mini_seasons');
  if (w.includes('ranked')) modes.add('ranked');
  if (w.includes('events')) modes.add('events');
  if (w.includes('moments')) modes.add('moments');
  if (w.includes('showdown')) modes.add('showdown');
  if (w.includes('battle royale')) modes.add('battle_royale');
  if (w.includes('vs cpu') || w.includes('vs. cpu')) modes.add('vs_cpu');
  return modes;
}

function modesOverlap(setA, setB) {
  if (!setA.size || !setB.size) return true;
  for (const m of setA) if (setB.has(m)) return true;
  return false;
}

function addCrossObjectiveHints(missions) {
  const profiles = missions.map((m) => ({
    mission: m,
    statCategory: extractStatCategory(m),
    modes: extractModeSet(m.whereToPlay),
  }));

  return profiles.map(({ mission, statCategory, modes }) => {
    if (!statCategory) return { ...mission, crossProgramHints: [] };

    const seen = new Set();
    const hints = [];

    for (const other of profiles) {
      if (other.mission === mission) continue;
      if (other.mission.programTitle === mission.programTitle) continue;
      if (other.statCategory !== statCategory) continue;
      if (!modesOverlap(modes, other.modes)) continue;

      const key = `${other.mission.programTitle}||${other.mission.name}`;
      if (seen.has(key)) continue;
      seen.add(key);
      hints.push({ programTitle: other.mission.programTitle, missionName: other.mission.name });
      if (hints.length >= 5) break;
    }

    return { ...mission, crossProgramHints: hints };
  });
}

async function waitForAuthenticatedSession(page, timeoutMs) {
  const startedAt = Date.now();

  while (Date.now() - startedAt < timeoutMs) {
    const currentUrl = page.url();

    if (isAuthenticatedMlbUrl(currentUrl)) {
      return true;
    }

    if (isSonyRateLimited()) {
      throw new Error(buildSonyRateLimitMessage());
    }

    await page.waitForTimeout(1000);
  }

  return false;
}

function isAuthenticatedMlbUrl(urlString) {
  try {
    const url = new URL(urlString);
    return (
      url.hostname === 'mlb26.theshow.com' &&
      !url.pathname.includes('/login') &&
      !url.pathname.includes('/psn_sessions')
    );
  } catch {
    return false;
  }
}

async function discoverProgramTargets(context, rootPage) {
  const toVisit = [rootPage.url()];
  const visited = new Set();
  const programMap = new Map();
  const discoveryLinks = new Set();

  while (toVisit.length) {
    const currentUrl = toVisit.shift();

    if (visited.has(currentUrl)) {
      continue;
    }

    visited.add(currentUrl);

    const page = currentUrl === rootPage.url() ? rootPage : await context.newPage();

    try {
      if (currentUrl !== rootPage.url()) {
        await page.goto(currentUrl, {
          waitUntil: 'domcontentloaded',
          timeout: PAGE_NAV_TIMEOUT_MS,
        });
        await page.waitForTimeout(1000);
      }

      const pageMeta = await extractDiscoveryPageMeta(page);
      const hrefs = await collectProgramLinksFromPage(page);

      for (const item of hrefs) {
        discoveryLinks.add(item.url);

        if (item.url.includes('/programs/program_view')) {
          if (!programMap.has(item.url)) {
            programMap.set(item.url, buildProgramMetadata(item, currentUrl, pageMeta));
          }
          continue;
        }

        if (isProgramDiscoveryPage(item.url) && !visited.has(item.url)) {
          toVisit.push(item.url);
        }
      }
    } finally {
      if (page !== rootPage) {
        await page.close();
      }
    }
  }

  return {
    discoveryLinks: Array.from(discoveryLinks),
    programViewLinks: Array.from(programMap.keys()),
    programs: Array.from(programMap.values()).sort((a, b) => {
      const aKey = `${a.topGroup || ''} ${a.subGroup || ''} ${a.title || ''}`;
      const bKey = `${b.topGroup || ''} ${b.subGroup || ''} ${b.title || ''}`;
      return aKey.localeCompare(bKey);
    }),
  };
}

async function collectProgramLinksFromPage(page) {
  const hrefs = await page.evaluate((patterns) => {
    return Array.from(document.querySelectorAll('a[href]'))
      .filter((anchor) => {
        const href = anchor.href || '';
        if (!patterns.some((pattern) => href.includes(pattern))) {
          return false;
        }

        if (!href.includes('/programs/program_view')) {
          return true;
        }

        const card = anchor.querySelector('.mlb26-program-inner') || anchor;
        const completionNode =
          card.querySelector('.mlb26-program-completion') ||
          anchor.querySelector('.mlb26-program-completion');
        const completionText = (completionNode?.textContent || '').replace(/\s+/g, ' ').trim().toLowerCase();

        return completionText !== 'complete';
      })
      .map((anchor) => {
        const href = anchor.href;
        const titleNode =
          anchor.querySelector('.mlb26-program-list-text') ||
          anchor.querySelector('.mlb26-program-list-subtitle') ||
          anchor.querySelector('.sidebar-links-toggle-label') ||
          anchor.querySelector('h1, h2, h3, h4');
        const title = (titleNode?.textContent || '').replace(/\s+/g, ' ').trim();

        return {
          url: href,
          title,
        };
      })
      .filter((item) => Boolean(item.url));
  }, PROGRAM_DISCOVERY_PATTERNS);

  return dedupeProgramEntries(hrefs).filter((entry) => !isIgnoredProgram(entry));
}

function isIgnoredProgram(entry) {
  const title = `${entry?.title || ''}`.toLowerCase();
  const url = `${entry?.url || ''}`.toLowerCase();

  return title.includes('my legacy') || url.includes('my_legacy') || url.includes('my legacy');
}

function filterIgnoredPrograms(programs) {
  return Array.isArray(programs) ? programs.filter((program) => !isIgnoredProgram(program)) : [];
}

function isIgnoredMission(mission) {
  return isIgnoredProgram({
    title: mission?.programTitle,
    url: mission?.sourceUrl,
  });
}

function isProgramDiscoveryPage(url) {
  return (
    url.includes('/programs/team_affinity') ||
    url.includes('/programs/team_affinity_by_team') ||
    url.includes('/programs/other_programs')
  );
}

async function scanProgramPage(context, programMeta, seenProgramUrls) {
  const page = await context.newPage();
  const url = programMeta.url;

  try {
    await page.goto(url, {
      waitUntil: 'domcontentloaded',
      timeout: PAGE_NAV_TIMEOUT_MS,
    });
    await page.waitForTimeout(1200);
    ensureAuthenticatedPage(page);
    seenProgramUrls.push(url);

    const capturedProgramsPayload = await extractProgramsPayloadFromDom(page);

    const programTitle = await extractProgramTitle(page);
    const resolvedProgramTitle =
      programMeta.title && programMeta.title !== 'Programa sin titulo'
        ? programMeta.title
        : programTitle;
    const missions = processProgramData(capturedProgramsPayload).map((mission) => ({
      ...mission,
      programTitle: resolvedProgramTitle,
      topGroup: programMeta.topGroup || inferTopGroupFromTitle(resolvedProgramTitle),
      subGroup: programMeta.subGroup || '',
      sourceUrl: url,
    }));

    return {
      url,
      programTitle: resolvedProgramTitle,
      missions,
    };
  } finally {
    await page.close();
  }
}

async function extractDiscoveryPageMeta(page) {
  return page.evaluate(() => {
    const pageTitle =
      (document.querySelector('h1')?.textContent || '').replace(/\s+/g, ' ').trim() ||
      'Programs';

    const breadcrumb = Array.from(document.querySelectorAll('.section-block a, .section-block, .breadcrumb, .breadcrumbs'))
      .map((node) => (node.textContent || '').replace(/\s+/g, ' ').trim())
      .filter(Boolean)
      .join(' / ');

    return {
      pageTitle,
      breadcrumb,
    };
  });
}

function buildProgramMetadata(item, sourceUrl, pageMeta) {
  const title = resolveProgramTitle(item, pageMeta);
  const topGroup = inferTopGroup(item.url, title, sourceUrl, pageMeta);
  const subGroup = inferSubGroup(item.url, title, sourceUrl, pageMeta, topGroup);

  return {
    url: item.url,
    title,
    topGroup,
    subGroup,
  };
}

function resolveProgramTitle(item, pageMeta) {
  const rawTitle = `${item?.title || ''}`.trim();

  if (rawTitle) {
    return rawTitle;
  }

  const breadcrumb = `${pageMeta?.breadcrumb || ''}`.split('/').map((part) => part.trim()).filter(Boolean);
  const pageTitle = `${pageMeta?.pageTitle || ''}`.trim();

  if (breadcrumb.length >= 2) {
    return breadcrumb[breadcrumb.length - 1];
  }

  if (pageTitle && pageTitle !== 'Programs') {
    return pageTitle;
  }

  return 'Programa sin titulo';
}

function isUntitledProgram(program) {
  const title = `${program?.title || ''}`.trim().toLowerCase();
  const topGroup = `${program?.topGroup || ''}`.trim().toLowerCase();

  return title === 'programa sin titulo' || topGroup === 'programa sin titulo';
}

function normalizeUntitledPrograms(scanResults) {
  const missions = Array.isArray(scanResults?.missions) ? scanResults.missions : [];
  const catalogPrograms = Array.isArray(scanResults?.catalogPrograms) ? scanResults.catalogPrograms : [];
  const normalizedCatalogPrograms = normalizeCatalogPrograms(catalogPrograms, missions);
  const normalizedMissions = normalizeMissionPrograms(missions, normalizedCatalogPrograms);

  return {
    ...scanResults,
    catalogPrograms: normalizedCatalogPrograms,
    missions: normalizedMissions,
  };
}

function normalizeCatalogPrograms(programs, missions = []) {
  return (programs || []).map((program) => {
    const replacement = inferProgramIdentityFromUrlAndMissions(program.url, missions);
    if (!replacement) {
      return program;
    }

    return {
      ...program,
      title: replacement.title || program.title,
      topGroup: replacement.topGroup || program.topGroup,
      subGroup: replacement.subGroup ?? program.subGroup,
    };
  });
}

function normalizeMissionPrograms(missions, catalogPrograms) {
  const catalogByUrl = new Map((catalogPrograms || []).map((program) => [program.url, program]));

  return (missions || []).map((mission) => {
    const catalogProgram = catalogByUrl.get(mission.sourceUrl);
    if (!catalogProgram) {
      const replacement = inferProgramIdentityFromUrlAndMissions(mission.sourceUrl, missions);
      if (!replacement) {
        return mission;
      }

      return {
        ...mission,
        programTitle: replacement.title || mission.programTitle,
        topGroup: replacement.topGroup || mission.topGroup,
        subGroup: replacement.subGroup ?? mission.subGroup,
      };
    }

    return {
      ...mission,
      programTitle: catalogProgram.title || mission.programTitle,
      topGroup: catalogProgram.topGroup || mission.topGroup,
      subGroup: catalogProgram.subGroup ?? mission.subGroup,
    };
  });
}

function inferProgramIdentityFromUrlAndMissions(url, missions = []) {
  if (!url) {
    return null;
  }

  const relatedMissions = missions.filter((mission) => mission.sourceUrl === url);
  const missionText = relatedMissions
    .map((mission) => `${mission.programTitle || ''} ${mission.name || ''} ${mission.description || ''} ${mission.objectiveGroup || ''}`)
    .join(' ');

  const inningMatches = Array.from(missionText.matchAll(/\b(\d+)(st|nd|rd|th)\s+inning\b/gi))
    .map((match) => ({
      number: Number(match[1]),
      suffix: match[2].toLowerCase(),
    }))
    .filter((match) => Number.isFinite(match.number));

  if (inningMatches.length) {
    const highestInning = inningMatches.reduce((best, current) => (current.number > best.number ? current : best));
    const inningLabel = `${highestInning.number}${highestInning.suffix} Inning XP Path`;
    return {
      title: inningLabel,
      topGroup: inningLabel,
      subGroup: '',
    };
  }

  const multiplayerMatches = Array.from(missionText.matchAll(/\bmultiplayer\s+(\d+)\b/gi))
    .map((match) => Number(match[1]))
    .filter((value) => Number.isFinite(value));

  if (multiplayerMatches.length) {
    const highestMultiplayer = Math.max(...multiplayerMatches);
    const title = `Multiplayer ${highestMultiplayer} Program`;
    return {
      title,
      topGroup: 'Multiplayer Program',
      subGroup: 'General',
    };
  }

  const groupIdMatch = `${url}`.match(/[?&]group_id=(\d+)/i);
  if (groupIdMatch?.[1] === '10000') {
    return {
      title: 'Inning XP Path',
      topGroup: 'Inning XP Path',
      subGroup: '',
    };
  }

  if (groupIdMatch?.[1] === '10012') {
    return {
      title: 'Multiplayer Program',
      topGroup: 'Multiplayer Program',
      subGroup: 'General',
    };
  }

  return null;
}

function inferTopGroup(url, title, sourceUrl, pageMeta) {
  const lowerTitle = `${title}`.toLowerCase();

  if (url.includes('/programs/team_affinity') || sourceUrl.includes('/programs/team_affinity')) {
    return 'Team Affinity';
  }

  if (url.includes('/programs/other_programs') || sourceUrl.includes('/programs/other_programs')) {
    if (lowerTitle.includes('multiplayer')) {
      return 'Multiplayer Program';
    }

    return 'Assorted Program';
  }

  if (lowerTitle.includes('multiplayer')) {
    return 'Multiplayer Program';
  }

  if (lowerTitle.includes('inning')) {
    return title;
  }

  return inferTopGroupFromTitle(title) || pageMeta.pageTitle || 'Programs';
}

function inferSubGroup(url, title, sourceUrl, pageMeta, topGroup) {
  if (topGroup === 'Team Affinity') {
    if (sourceUrl.includes('team_affinity_by_team') && pageMeta.pageTitle && pageMeta.pageTitle !== 'Programs') {
      return pageMeta.pageTitle;
    }

    if (sourceUrl.includes('league=al')) {
      return 'American League';
    }

    if (sourceUrl.includes('league=nl')) {
      return 'National League';
    }
  }

  if (topGroup === 'Assorted Program') {
    if (title.includes(' - ')) {
      return title.split(' - ')[0].trim();
    }

    return pageMeta.pageTitle && pageMeta.pageTitle !== 'Programs' ? pageMeta.pageTitle : 'General';
  }

  if (topGroup === 'Multiplayer Program') {
    return pageMeta.pageTitle && pageMeta.pageTitle !== 'Programs' ? pageMeta.pageTitle : 'General';
  }

  if (topGroup !== title) {
    return title;
  }

  return '';
}

function inferTopGroupFromTitle(title) {
  const lowerTitle = `${title}`.toLowerCase();

  if (lowerTitle.includes('multiplayer')) {
    return 'Multiplayer Program';
  }

  if (lowerTitle.includes('inning')) {
    return title;
  }

  return title;
}

async function extractProgramTitle(page) {
  return page.evaluate(() => {
    const selectors = ['h1', '.page-head h1', '.layout-primary h1', '.title h1', '.page-body h1', '.section-block h1'];

    for (const selector of selectors) {
      const element = document.querySelector(selector);
      const text = (element?.textContent || '').replace(/\s+/g, ' ').trim();
      if (text) {
        return text;
      }
    }

    const breadcrumb = Array.from(document.querySelectorAll('.section-block a, .breadcrumb a, .breadcrumbs a, .section-block'))
      .map((node) => (node?.textContent || '').replace(/\s+/g, ' ').trim())
      .filter(Boolean);

    if (breadcrumb.length >= 2) {
      return breadcrumb[breadcrumb.length - 1];
    }

    const bodyText = (document.body?.innerText || '').replace(/\s+/g, ' ').trim();
    const inningMatches = Array.from(bodyText.matchAll(/\b(\d+)(st|nd|rd|th)\s+Inning XP Path\b/gi))
      .map((match) => ({
        number: Number(match[1]),
        suffix: match[2].toLowerCase(),
      }))
      .filter((match) => Number.isFinite(match.number));

    if (inningMatches.length) {
      const highestInning = inningMatches.reduce((best, current) => (current.number > best.number ? current : best));
      return `${highestInning.number}${highestInning.suffix} Inning XP Path`;
    }

    const multiplayerMatches = Array.from(bodyText.matchAll(/\bMultiplayer\s+(\d+)\s+Program\b/gi))
      .map((match) => Number(match[1]))
      .filter((value) => Number.isFinite(value));

    if (multiplayerMatches.length) {
      return `Multiplayer ${Math.max(...multiplayerMatches)} Program`;
    }

    const pageTitle = (document.title || '').replace(/\s+-\s+The Show MLB 26.*$/i, '').replace(/\s+/g, ' ').trim();
    if (pageTitle) {
      return pageTitle;
    }

    return 'Programa sin titulo';
  });
}

async function hydrateMissingProgramTitles(context, programs) {
  const hydrated = [];

  for (const program of programs || []) {
    if (program?.title && program.title !== 'Programa sin titulo') {
      hydrated.push(program);
      continue;
    }

    const page = await context.newPage();

    try {
      await page.goto(program.url, {
        waitUntil: 'domcontentloaded',
        timeout: PAGE_NAV_TIMEOUT_MS,
      });
      await page.waitForTimeout(800);
      ensureAuthenticatedPage(page);

      const title = await extractProgramTitle(page);
      hydrated.push({
        ...program,
        title: title || program.title,
      });
    } catch {
      hydrated.push(program);
    } finally {
      await page.close();
    }
  }

  return hydrated;
}

async function scanFullInventory(context, page, onProgress) {
  const cards = [];
  const seenPages = new Set();
  const seenCards = new Set();
  let nextUrl = INVENTORY_URL;

  while (nextUrl && !seenPages.has(nextUrl)) {
    seenPages.add(nextUrl);

    await page.goto(nextUrl, {
      waitUntil: 'domcontentloaded',
      timeout: 60000,
    });
    await page.waitForTimeout(1200);
    ensureAuthenticatedPage(page);
    await scrollInventoryPage(page);

    const pageCards = await extractInventoryCardsFromDom(page);
    for (const card of pageCards) {
      const key = `${card.name || ''}::${card.series || ''}::${card.team || ''}::${card.position || ''}::${card.overall || 0}`;
      if (seenCards.has(key)) {
        continue;
      }

      seenCards.add(key);
      cards.push(card);
    }

    if (onProgress) onProgress(seenPages.size, cards.length);
    nextUrl = await extractNextInventoryPageUrl(page);
  }

  return cards;
}

async function scrollInventoryPage(page) {
  await page.evaluate(async () => {
    await new Promise((resolve) => {
      let totalHeight = 0;
      const distance = 800;
      const timer = setInterval(() => {
        const scrollHeight = document.body.scrollHeight;
        window.scrollBy(0, distance);
        totalHeight += distance;

        if (totalHeight >= scrollHeight) {
          clearInterval(timer);
          resolve();
        }
      }, 150);
    });
  });
  await page.waitForTimeout(800);
}

async function extractNextInventoryPageUrl(page) {
  return page.evaluate(() => {
    const anchors = Array.from(document.querySelectorAll('a[href]'));
    const nextAnchor = anchors.find((anchor) => {
      const href = anchor.href || '';
      const text = (anchor.textContent || '').replace(/\s+/g, ' ').trim().toLowerCase();
      return href.includes('/inventory?page=') && (text === 'next' || text === '>' || text === '»' || /next/i.test(text));
    });

    if (nextAnchor?.href) {
      return nextAnchor.href;
    }

    const currentPageMatch = window.location.href.match(/[?&]page=(\d+)/i);
    const currentPage = currentPageMatch ? Number(currentPageMatch[1]) : 1;
    const numberedAnchors = anchors
      .map((anchor) => {
        const href = anchor.href || '';
        const match = href.match(/[?&]page=(\d+)/i);
        return match ? { href, page: Number(match[1]) } : null;
      })
      .filter(Boolean)
      .sort((a, b) => a.page - b.page);

    const nextPage = numberedAnchors.find((anchor) => anchor.page === currentPage + 1);
    return nextPage?.href || null;
  });
}

async function extractInventoryCardsFromDom(page) {
  return page.evaluate(() => {
    const textOf = (node) => (node?.textContent || '').replace(/\s+/g, ' ').trim();
    const positionRegex = /\b(LF|CF|RF|OF|1B|2B|3B|SS|C|SP|RP|CP|DH)\b/i;
    const overallRegex = /\b(\d{2,3})\b/;
    const seriesKeywords = [
      'Topps Now',
      'Spotlight',
      'Live Series',
      'Pipeline',
      'Captain',
      'All-Star',
      'Milestone',
      'Breakout',
      'Postseason',
      'Rookie',
      'Veteran',
      'Prime',
      'Awards',
    ];

    const selectors = [
      '[class*="inventory"][class*="item"]',
      '[class*="inventory"][class*="card"]',
      '[class*="item"][class*="card"]',
      '[class*="listing"]',
      'article',
      'li',
      'tr',
    ];

    const nodes = Array.from(document.querySelectorAll(selectors.join(',')));
    const seen = new Set();
    const results = [];

    for (const node of nodes) {
      const text = textOf(node);
      if (!text || text.length < 12 || text.length > 500) {
        continue;
      }

      const positionMatch = text.match(positionRegex);
      if (!positionMatch && !seriesKeywords.some((keyword) => text.toLowerCase().includes(keyword.toLowerCase()))) {
        continue;
      }

      const lines = Array.from(new Set(
        text
          .split(/\n|\s{2,}/)
          .map((line) => line.trim())
          .filter(Boolean)
      ));

      const name =
        lines.find((line) => line.length >= 4 && !positionRegex.test(line) && !/owned|sell|buy/i.test(line)) ||
        lines[0] ||
        '';

      const position =
        lines.find((line) => positionRegex.test(line))?.match(positionRegex)?.[1]?.toUpperCase() ||
        positionMatch?.[1]?.toUpperCase() ||
        '';

      const series =
        seriesKeywords.find((keyword) => text.toLowerCase().includes(keyword.toLowerCase())) ||
        lines.find((line) => /series|spotlight|topps now|pipeline|captain|all-star|milestone|breakout|postseason|rookie|veteran|prime|awards/i.test(line)) ||
        '';

      const overall = Number(lines.find((line) => overallRegex.test(line))?.match(overallRegex)?.[1] || 0);
      const team =
        lines.find((line) => /diamondbacks|athletics|braves|orioles|red sox|cubs|white sox|reds|guardians|rockies|tigers|astros|royals|angels|dodgers|marlins|brewers|twins|mets|yankees|phillies|pirates|padres|giants|mariners|cardinals|rays|rangers|blue jays|nationals/i.test(line)) ||
        '';

      if (!name) {
        continue;
      }

      const key = `${name}::${series}::${position}::${team}`;
      if (seen.has(key)) {
        continue;
      }

      seen.add(key);
      results.push({
        name,
        series,
        team,
        position,
        overall,
      });
    }

    return results;
  });
}

function extractMissionArray(data) {
  if (Array.isArray(data?.missions)) {
    return data.missions;
  }

  return [];
}

async function extractProgramsPayloadFromDom(page) {
  ensureAuthenticatedPage(page);

  const missions = await page.evaluate(() => {
    const textOf = (node) => (node?.textContent || '').replace(/\s+/g, ' ').trim();
    const progressRegex = /(\d+)\s*\/\s*(\d+)/;
    const rewardRegex = /^reward\b/i;
    const whereToPlayRegex = /^where to play:/i;
    const results = [];
    const seen = new Set();

    const blocks = Array.from(document.querySelectorAll('.accordion-content'));

    for (const block of blocks) {
      const header =
        block.closest('.accordion-block')?.querySelector('.accordion-toggle') ||
        block.parentElement?.querySelector('.accordion-toggle');
      const objectiveGroupNode =
        block.closest('.accordion-list')?.previousElementSibling ||
        block.closest('.accordion-block')?.closest('.accordion-content')?.previousElementSibling;

      const name = textOf(header) || textOf(block.querySelector('p'));
      const objectiveGroup = textOf(objectiveGroupNode) || 'General';
      const meter = block.querySelector('meter');
      const blockText = textOf(block);
      const paragraphs = Array.from(block.querySelectorAll('p'))
        .map((node) => textOf(node))
        .filter(Boolean);

      let current = null;
      let target = null;

      if (meter) {
        current = Number(meter.getAttribute('value'));
        target = Number(meter.getAttribute('max'));
      }

      if ((!Number.isFinite(current) || !Number.isFinite(target) || target <= 0) && blockText) {
        const match = blockText.match(progressRegex);
        if (match) {
          current = Number(match[1]);
          target = Number(match[2]);
        }
      }

      if (!name || !Number.isFinite(current) || !Number.isFinite(target) || target <= 0) {
        continue;
      }

      const whereToPlay =
        paragraphs.find((paragraph) => {
          return whereToPlayRegex.test(paragraph);
        }) || '';

      const description =
        paragraphs.find((paragraph) => {
          if (!paragraph) {
            return false;
          }

          if (paragraph === name) {
            return false;
          }

          if (progressRegex.test(paragraph)) {
            return false;
          }

          if (rewardRegex.test(paragraph)) {
            return false;
          }

          if (whereToPlayRegex.test(paragraph)) {
            return false;
          }

          return paragraph.length >= 6;
        }) || '';

      const key = `${name}::${current}/${target}`;
      if (seen.has(key)) {
        continue;
      }

      seen.add(key);
      results.push({
        name,
        objectiveGroup,
        description,
        whereToPlay,
        current,
        target,
        completed: current >= target,
      });
    }

    if (results.length) {
      return results;
    }

    const fallbackResults = [];
    const candidateNodes = Array.from(document.querySelectorAll('div, li, section, article'));

    for (const node of candidateNodes) {
      const text = textOf(node);

      if (!text || text.length < 8 || text.length > 500) {
        continue;
      }

      const progressMatch = text.match(progressRegex);
      if (!progressMatch) {
        continue;
      }

      const [progressText, currentText, targetText] = progressMatch;
      const current = Number(currentText);
      const target = Number(targetText);

      if (!Number.isFinite(current) || !Number.isFinite(target) || target <= 0) {
        continue;
      }

      const lines = text
        .split(/\s{2,}|\n/)
        .map((line) => line.trim())
        .filter(Boolean);

      const name = lines.find((line) => !progressRegex.test(line) && line.length >= 4) || text.replace(progressText, '').trim();
      const objectiveGroup = 'General';
      const whereToPlay = lines.find((line) => whereToPlayRegex.test(line)) || '';
      const description =
        lines.find((line) => (
          line !== name &&
          !progressRegex.test(line) &&
          !rewardRegex.test(line) &&
          !whereToPlayRegex.test(line) &&
          line.length >= 6
        )) || '';

      if (!name) {
        continue;
      }

      const key = `${name}::${current}/${target}`;
      if (seen.has(key)) {
        continue;
      }

      seen.add(key);
      fallbackResults.push({
        name,
        objectiveGroup,
        description,
        whereToPlay,
        current,
        target,
        completed: current >= target,
      });
    }

    return fallbackResults;
  });

  if (!missions.length) {
    return null;
  }

  return { missions };
}

function dedupeMissions(missions) {
  const seen = new Set();
  const deduped = [];

  for (const mission of missions) {
    const key = `${mission.programTitle || ''}::${mission.name || ''}::${mission.current || 0}/${mission.target || 0}`;
    if (seen.has(key)) {
      continue;
    }

    seen.add(key);
    deduped.push(mission);
  }

  return deduped;
}

function dedupeProgramEntries(entries) {
  const map = new Map();

  for (const entry of entries) {
    if (!entry?.url) {
      continue;
    }

    if (!map.has(entry.url)) {
      map.set(entry.url, {
        url: entry.url,
        title: entry.title || 'Programa sin titulo',
      });
    }
  }

  return Array.from(map.values());
}

function attachInventorySuggestionsToScanResults(scanResults, inventoryResults) {
  const cards = Array.isArray(inventoryResults?.cards) ? inventoryResults.cards : [];
  const missions = Array.isArray(scanResults?.missions) ? scanResults.missions : [];

  let enrichedMissions = missions;

  if (cards.length && missions.length) {
    enrichedMissions = missions.map((mission) => {
      const recommendedCards = recommendCardsForMission(mission, cards, missions);
      return {
        ...mission,
        recommendedCards: recommendedCards.cards,
        comboMissionCount: recommendedCards.comboMissionCount,
      };
    });
  }

  const finalMissions = enrichedMissions.length ? addCrossObjectiveHints(enrichedMissions) : enrichedMissions;

  return {
    ...scanResults,
    inventory: inventoryResults || { scannedAt: null, total: 0, cards: [] },
    missions: finalMissions,
  };
}

function recommendCardsForMission(mission, cards, allMissions) {
  const filters = extractMissionFilters(mission);
  const hasFilters = filters.series.length || filters.teams.length || filters.positions.length || filters.positionGroups.length;

  if (!hasFilters) {
    return {
      cards: [],
      comboMissionCount: 0,
    };
  }

  const matchedCards = cards.filter((card) => cardMatchesMission(card, filters));
  const topCards = matchedCards
    .map((card) => ({
      ...card,
      overlapCount: countMissionOverlap(card, allMissions),
    }))
    .sort((a, b) => (b.overlapCount - a.overlapCount) || ((b.overall || 0) - (a.overall || 0)) || a.name.localeCompare(b.name))
    .slice(0, 5);

  return {
    cards: topCards,
    comboMissionCount: topCards[0] ? Math.max(0, topCards[0].overlapCount - 1) : 0,
  };
}

function countMissionOverlap(card, missions) {
  return missions.reduce((count, mission) => {
    const filters = extractMissionFilters(mission);
    return count + (cardMatchesMission(card, filters) ? 1 : 0);
  }, 0);
}

function extractMissionFilters(mission) {
  const text = `${mission.name || ''} ${mission.description || ''}`.toLowerCase();
  const filters = {
    series: [],
    teams: [],
    positions: [],
    positionGroups: [],
  };

  if (text.includes('spotlight')) {
    filters.series.push('spotlight');
  }

  if (text.includes('topps now')) {
    filters.series.push('topps now');
  }

  if (text.includes('live series')) {
    filters.series.push('live series');
  }

  const teamMap = {
    athletics: ['athletics'],
    orioles: ['orioles'],
    'red sox': ['red sox'],
    cubs: ['cubs'],
    'white sox': ['white sox'],
    reds: ['reds'],
    guardians: ['guardians', 'cle guardians'],
    rockies: ['rockies'],
    tigers: ['tigers'],
    astros: ['astros'],
    royals: ['royals'],
    angels: ['angels'],
    dodgers: ['dodgers'],
    marlins: ['marlins'],
    brewers: ['brewers'],
    twins: ['twins'],
    mets: ['mets'],
    yankees: ['yankees'],
    phillies: ['phillies'],
    pirates: ['pirates'],
    padres: ['padres'],
    giants: ['giants', 'sf giants'],
    mariners: ['mariners'],
    cardinals: ['cardinals'],
    rays: ['rays'],
    rangers: ['rangers'],
    'blue jays': ['blue jays'],
    nationals: ['nationals', 'wsh nationals'],
    braves: ['braves'],
    diamondbacks: ['diamondbacks', 'dbacks'],
  };

  for (const [canonical, variants] of Object.entries(teamMap)) {
    if (variants.some((variant) => text.includes(variant))) {
      filters.teams.push(canonical);
    }
  }

  if (text.includes('outfielder')) {
    filters.positionGroups.push('outfield');
  }

  if (text.includes('infielder')) {
    filters.positionGroups.push('infield');
  }

  if (text.includes('pitcher')) {
    filters.positionGroups.push('pitcher');
  }

  const positions = ['lf', 'cf', 'rf', '1b', '2b', '3b', 'ss', 'c', 'sp', 'rp', 'cp', 'dh'];
  for (const position of positions) {
    if (new RegExp(`\\b${position}\\b`, 'i').test(text)) {
      filters.positions.push(position.toUpperCase());
    }
  }

  return filters;
}

function cardMatchesMission(card, filters) {
  const cardSeries = `${card.series || ''}`.toLowerCase();
  const cardTeam = `${card.team || ''}`.toLowerCase();
  const cardPosition = `${card.position || ''}`.toUpperCase();

  if (filters.series.length && !filters.series.some((series) => cardSeries.includes(series))) {
    return false;
  }

  if (filters.teams.length && !filters.teams.some((team) => cardTeam.includes(team))) {
    return false;
  }

  if (filters.positions.length && !filters.positions.includes(cardPosition)) {
    return false;
  }

  if (filters.positionGroups.includes('outfield') && !['LF', 'CF', 'RF', 'OF'].includes(cardPosition)) {
    return false;
  }

  if (filters.positionGroups.includes('infield') && !['1B', '2B', '3B', 'SS'].includes(cardPosition)) {
    return false;
  }

  if (filters.positionGroups.includes('pitcher') && !['SP', 'RP', 'CP'].includes(cardPosition)) {
    return false;
  }

  return true;
}

function readScanResults(userId) {
  const file = getScanResultsFile(userId);
  if (!fs.existsSync(file)) {
    return {
      scannedAt: null,
      total: 0,
      programsVisited: 0,
      programsSkipped: 0,
      sessionExpired: false,
      skippedLinks: [],
      catalogPrograms: [],
      missions: [],
    };
  }

  try {
    return JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch {
    return {
      scannedAt: null,
      total: 0,
      programsVisited: 0,
      programsSkipped: 0,
      sessionExpired: false,
      skippedLinks: [],
      catalogPrograms: [],
      missions: [],
    };
  }
}

function writeScanResults(userId, results) {
  fs.writeFileSync(getScanResultsFile(userId), JSON.stringify(results, null, 2));
}

function readInventoryResults(userId) {
  const file = getInventoryResultsFile(userId);
  if (!fs.existsSync(file)) {
    return {
      scannedAt: null,
      total: 0,
      cards: [],
    };
  }

  try {
    return JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch {
    return {
      scannedAt: null,
      total: 0,
      cards: [],
    };
  }
}

function writeInventoryResults(userId, results) {
  fs.writeFileSync(getInventoryResultsFile(userId), JSON.stringify(results, null, 2));
}

function buildPersistedScanResults({ previous, scannedMissions, scannedProgramUrls, catalogPrograms, sessionExpired, skippedLinks, cancelled }) {
  const scannedSet = new Set(scannedProgramUrls);
  const previousMissions = Array.isArray(previous?.missions) ? previous.missions.filter((mission) => !isIgnoredMission(mission)) : [];
  const merged = [];
  const seen = new Set();

  for (const mission of scannedMissions.filter((item) => !isIgnoredMission(item))) {
    const nextMission = {
      ...mission,
      scanStatus: 'updated',
      lastUpdatedAt: new Date().toISOString(),
    };
    const key = missionIdentity(nextMission);
    seen.add(key);
    merged.push(nextMission);
  }

  for (const mission of previousMissions) {
    const key = missionIdentity(mission);
    if (seen.has(key)) {
      continue;
    }

    if (scannedSet.size > 0 && !scannedSet.has(mission.sourceUrl)) {
      merged.push({
        ...mission,
        scanStatus: 'stale',
      });
      seen.add(key);
    }
  }

  return {
    scannedAt: new Date().toISOString(),
    total: merged.length,
    programsVisited: scannedSet.size,
    programsSkipped: skippedLinks.length,
    sessionExpired,
    cancelled: Boolean(cancelled),
    skippedLinks,
    catalogPrograms: filterIgnoredPrograms(catalogPrograms),
    missions: merged,
  };
}

function missionIdentity(mission) {
  return `${mission.programTitle || ''}::${mission.name || ''}::${mission.sourceUrl || ''}`;
}

async function launchBrowserContext() {
  const launchOptions = {
    headless: isProduction,
    args: isProduction ? ['--no-sandbox', '--disable-setuid-sandbox'] : [],
  };

  if (!isProduction && LOCAL_BROWSER_CHANNEL) {
    try {
      return await chromium.launchPersistentContext(USER_DATA_DIR, {
        ...launchOptions,
        channel: LOCAL_BROWSER_CHANNEL,
      });
    } catch (error) {
      console.warn(
        `No se pudo abrir el canal local "${LOCAL_BROWSER_CHANNEL}". Se intentara con Chromium de Playwright.`,
        error.message
      );
    }
  }

  return chromium.launchPersistentContext(USER_DATA_DIR, launchOptions);
}

async function launchBrowser() {
  const launchOptions = {
    headless: isProduction,
    args: isProduction ? ['--no-sandbox', '--disable-setuid-sandbox'] : [],
  };

  if (!isProduction && LOCAL_BROWSER_CHANNEL) {
    try {
      return await chromium.launch({
        ...launchOptions,
        channel: LOCAL_BROWSER_CHANNEL,
      });
    } catch (error) {
      console.warn(
        `No se pudo abrir el canal local "${LOCAL_BROWSER_CHANNEL}". Se intentara con Chromium de Playwright.`,
        error.message
      );
    }
  }

  return chromium.launch(launchOptions);
}

function hasSavedAuthState(userId) {
  return fs.existsSync(getAuthStateFile(userId));
}

function normalizeImportedSession(parsed) {
  const cookiesSource = Array.isArray(parsed)
    ? parsed
    : Array.isArray(parsed?.cookies)
      ? parsed.cookies
      : null;

  if (!cookiesSource || cookiesSource.length === 0) {
    throw new Error('El JSON importado no contiene cookies validas.');
  }

  const cookies = cookiesSource.map((cookie) => normalizeCookie(cookie));

  return {
    cookies,
    origins: Array.isArray(parsed?.origins) ? parsed.origins : [],
  };
}

function normalizeCookie(cookie) {
  if (!cookie || typeof cookie !== 'object') {
    throw new Error('Se encontro una cookie invalida en el JSON importado.');
  }

  if (!cookie.name || !cookie.value || !cookie.domain) {
    throw new Error('Cada cookie debe incluir al menos name, value y domain.');
  }

  return {
    name: `${cookie.name}`,
    value: `${cookie.value}`,
    domain: `${cookie.domain}`,
    path: cookie.path ? `${cookie.path}` : '/',
    expires: normalizeCookieExpiry(cookie.expires),
    httpOnly: Boolean(cookie.httpOnly),
    secure: cookie.secure !== false,
    sameSite: normalizeSameSite(cookie.sameSite),
  };
}

function normalizeCookieExpiry(expires) {
  if (typeof expires === 'number' && Number.isFinite(expires)) {
    return expires;
  }

  if (expires === -1) {
    return -1;
  }

  return -1;
}

function normalizeSameSite(value) {
  if (value === 'Strict' || value === 'Lax' || value === 'None') {
    return value;
  }

  return 'Lax';
}

function slugifyUsername(username) {
  const slug = `${username || ''}`
    .toLowerCase()
    .replace(/[^a-z0-9_-]/g, '_')
    .replace(/_{2,}/g, '_')
    .replace(/^_+|_+$/g, '')
    .slice(0, 50);
  return slug.length >= 2 ? slug : null;
}

function migrateUserDir(fromUserId, toUserId) {
  if (!fromUserId || !toUserId || fromUserId === toUserId) return;

  const fromDir = getUserDir(fromUserId);
  if (!fs.existsSync(fromDir)) return;

  const toDir = getUserDir(toUserId);
  fs.mkdirSync(toDir, { recursive: true });

  // auth_state siempre se sobreescribe: el usuario acaba de importar cookies frescas
  const authSrc = path.join(fromDir, 'auth_state.json');
  const authDst = path.join(toDir, 'auth_state.json');
  if (fs.existsSync(authSrc)) {
    fs.copyFileSync(authSrc, authDst);
  }

  // scan e inventario solo se copian si el destino no existe aun
  for (const file of ['scan_results.json', 'inventory_results.json']) {
    const src = path.join(fromDir, file);
    const dst = path.join(toDir, file);
    if (fs.existsSync(src) && !fs.existsSync(dst)) {
      fs.copyFileSync(src, dst);
    }
  }
}

async function extractMlbUsernameFromPage(page) {
  return page.evaluate(() => {
    const usernamePattern = /^[a-zA-Z0-9_-]{2,30}$/;

    // Strategy 1: JSON data embedded in inline script tags
    for (const script of Array.from(document.querySelectorAll('script:not([src])'))) {
      const text = script.textContent || '';
      const match = text.match(/"(?:username|display_name|psn_online_id|psn_id|handle|gamertag)"\s*:\s*"([^"]{2,30})"/i);
      if (match?.[1] && usernamePattern.test(match[1])) return match[1];
    }

    // Strategy 2: DOM selectors where the username might be visible
    const selectors = [
      '[data-username]', '[data-user-name]', '[data-psn-id]',
      '.username', '.user-name', '.display-name', '.profile-name',
      '.psn-id', '.nav-username', '.header-username', '.account-name',
    ];
    for (const sel of selectors) {
      const el = document.querySelector(sel);
      if (!el) continue;
      const text = (
        el.getAttribute('data-username') ||
        el.getAttribute('data-user-name') ||
        el.getAttribute('data-psn-id') ||
        el.textContent || ''
      ).replace(/\s+/g, ' ').trim();
      if (text && usernamePattern.test(text)) return text;
    }

    return null;
  });
}

async function validateSavedSession(userId) {
  let browser;
  let context;

  try {
    browser = await launchBrowser();
    context = await browser.newContext({
      storageState: getAuthStateFile(userId),
    });

    const page = await context.newPage();

    await page.goto(AUTH_CHECK_URL, {
      waitUntil: 'domcontentloaded',
      timeout: 60000,
    });

    const authenticated = isAuthenticatedMlbUrl(page.url());
    let detectedUserId = null;

    if (!authenticated) {
      fs.rmSync(getAuthStateFile(userId), { force: true });
    } else {
      await persistAuthState(context, userId);
      const rawUsername = await extractMlbUsernameFromPage(page);
      detectedUserId = slugifyUsername(rawUsername);
      if (detectedUserId && detectedUserId !== userId) {
        migrateUserDir(userId, detectedUserId);
      }
    }

    return {
      authenticated,
      currentUrl: page.url(),
      checkedAt: new Date().toISOString(),
      detectedUserId,
    };
  } finally {
    if (context) {
      await context.close();
    }

    if (browser) {
      await browser.close();
    }
  }
}

function buildUserFacingError(error) {
  const message = error?.message || 'Error desconocido';

  if (message.includes('429 Too Many Requests')) {
    return buildSonyRateLimitMessage(message);
  }

  if (
    message.includes('ERR_CONNECTION_RESET') ||
    message.includes('ERR_TIMED_OUT') ||
    message.includes('Se ha agotado el tiempo de espera para conectar al servidor')
  ) {
    return [
      'El login de Sony fallo por conexion o timeout.',
      'Prueba reiniciando la sesion local con POST /api/reset-session y vuelve a intentar.',
      `Navegador local configurado: ${LOCAL_BROWSER_CHANNEL}.`,
      `Detalle tecnico: ${message}`,
    ].join(' ');
  }

  return message;
}

async function persistAuthState(context, userId) {
  if (!context) {
    return;
  }

  await context.storageState({ path: getAuthStateFile(userId) });
}

function ensureAuthenticatedPage(page) {
  if (!isAuthenticatedMlbUrl(page.url())) {
    throw new Error('SESSION_EXPIRED');
  }
}

function isSessionExpiredError(error) {
  return `${error?.message || ''}`.includes('SESSION_EXPIRED');
}

function isSonyRateLimited() {
  if (!lastSonyRateLimitAt) {
    return false;
  }

  return Date.now() - lastSonyRateLimitAt < 15 * 60 * 1000;
}

function buildSonyRateLimitMessage(detail = '') {
  const remainingMs = Math.max(0, 15 * 60 * 1000 - (Date.now() - lastSonyRateLimitAt));
  const minutesLeft = Math.max(1, Math.ceil(remainingMs / 60000));

  return [
    'Sony esta devolviendo 429 Too Many Requests en el flujo de login.',
    `Conviene esperar aproximadamente ${minutesLeft} minuto(s) antes de reintentar.`,
    'Evita repetir clics mientras tanto para no extender el bloqueo.',
    detail ? `Detalle tecnico: ${detail}` : '',
  ]
    .filter(Boolean)
    .join(' ');
}

app.listen(PORT, () => {
  console.log(`Servidor iniciado en http://localhost:${PORT}`);
});
