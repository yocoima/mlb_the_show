require('dotenv').config();
const express = require('express');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
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
const AI_MODEL = process.env.GROQ_MODEL || 'llama-3.1-8b-instant';
const AI_DEBUG_PROMPT = process.env.AI_DEBUG_PROMPT === 'true';
const AI_DEBUG_PROMPT_MAX_CHARS = Number(process.env.AI_DEBUG_PROMPT_MAX_CHARS) || 12000;
const PROGRAM_DISCOVERY_PATTERNS = [
  '/programs/program_view',
  '/programs/team_affinity',
  '/programs/team_affinity_by_team',
  '/programs/other_programs',
];
const PROFILE_REGISTRY_FILE = path.join(DATA_DIR, 'profiles.json');
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
      percent: 0,
      visitedDiscoveryPages: 0,
      totalDiscoveryPages: 0,
      discoveredPrograms: 0,
      hydratedPrograms: 0,
      totalPrograms: 0,
      currentUrl: '',
      startedAt: null,
      completedAt: null,
      lastError: null,
    });
  }
  return catalogScanStates.get(userId);
}

fs.mkdirSync(DATA_DIR, { recursive: true });

function readProfileRegistry() {
  if (!fs.existsSync(PROFILE_REGISTRY_FILE)) {
    return { profiles: {} };
  }

  try {
    const parsed = JSON.parse(fs.readFileSync(PROFILE_REGISTRY_FILE, 'utf8'));
    return parsed && typeof parsed === 'object' && parsed.profiles
      ? parsed
      : { profiles: {} };
  } catch {
    return { profiles: {} };
  }
}

function writeProfileRegistry(registry) {
  fs.writeFileSync(PROFILE_REGISTRY_FILE, JSON.stringify(registry, null, 2));
}

function normalizeUsername(username) {
  const normalized = `${username || ''}`.trim().toLowerCase();
  return /^[a-z0-9_-]{3,30}$/.test(normalized) ? normalized : null;
}

function normalizeUserToken(token) {
  const normalized = `${token || ''}`.trim().toLowerCase();
  return /^[a-zA-Z0-9_-]{2,50}$/.test(normalized) ? normalized : null;
}

function createUserToken() {
  return crypto.randomUUID();
}

function findProfileByToken(registry, token) {
  const normalizedToken = normalizeUserToken(token);
  if (!normalizedToken) {
    return null;
  }

  return Object.entries(registry.profiles || {}).find(([, profile]) => profile?.token === normalizedToken) || null;
}

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
  return normalizeUserToken(req.headers['x-user-token']);
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

app.get('/api/profile/current', (req, res) => {
  const token = getUserId(req);
  if (!token) {
    return res.json({ username: null, token: null });
  }

  const registry = readProfileRegistry();
  const found = findProfileByToken(registry, token);
  if (!found) {
    return res.json({ username: null, token });
  }

  const [username, profile] = found;
  return res.json({
    username,
    token: profile.token,
    createdAt: profile.createdAt || null,
  });
});

app.post('/api/profile/create', (req, res) => {
  const username = normalizeUsername(req.body?.username);
  const requestedToken = normalizeUserToken(req.body?.token);

  if (!username) {
    return res.status(400).json({
      error: 'Usuario invalido.',
      detail: 'Usa 3 a 30 caracteres: letras, numeros, guion o guion bajo.',
    });
  }

  const registry = readProfileRegistry();
  if (registry.profiles[username]) {
    return res.status(409).json({
      error: 'Usuario no disponible.',
      detail: 'Ese usuario ya existe. Ingresa con ese usuario o elige otro nombre.',
    });
  }

  const existingTokenOwner = requestedToken ? findProfileByToken(registry, requestedToken) : null;
  if (existingTokenOwner) {
    return res.status(409).json({
      error: 'Perfil ya registrado.',
      detail: `Ese perfil ya pertenece al usuario ${existingTokenOwner[0]}.`,
    });
  }

  const token = requestedToken || createUserToken();
  registry.profiles[username] = {
    token,
    createdAt: new Date().toISOString(),
  };
  writeProfileRegistry(registry);
  ensureUserDir(token);

  return res.json({ ok: true, username, token });
});

app.post('/api/profile/login', (req, res) => {
  const username = normalizeUsername(req.body?.username);
  if (!username) {
    return res.status(400).json({
      error: 'Usuario invalido.',
      detail: 'Usa 3 a 30 caracteres: letras, numeros, guion o guion bajo.',
    });
  }

  const registry = readProfileRegistry();
  const profile = registry.profiles[username];
  if (!profile?.token) {
    return res.status(404).json({
      error: 'Usuario no encontrado.',
      detail: 'No existe un perfil con ese usuario. Revisa el nombre o crea uno nuevo.',
    });
  }

  ensureUserDir(profile.token);
  return res.json({
    ok: true,
    username,
    token: profile.token,
    createdAt: profile.createdAt || null,
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

app.get('/api/session-status', async (req, res) => {
  const userId = requireUserId(req, res);
  if (!userId) return;

  const savedStateExists = hasSavedAuthState(userId);
  if (!savedStateExists) {
    return res.json({
      authenticated: false,
      currentUrl: null,
      checkedAt: new Date().toISOString(),
      hasSavedAuthState: false,
      suggestedUserId: null,
      rateLimited: isSonyRateLimited(),
      lastSonyRateLimitAt: lastSonyRateLimitAt || null,
    });
  }

  try {
    const sessionState = await validateSavedSession(userId);
    res.json({
      authenticated: sessionState.authenticated,
      currentUrl: sessionState.currentUrl,
      checkedAt: sessionState.checkedAt,
      hasSavedAuthState: hasSavedAuthState(sessionState.detectedUserId || userId),
      suggestedUserId: sessionState.detectedUserId || null,
      rateLimited: isSonyRateLimited(),
      lastSonyRateLimitAt: lastSonyRateLimitAt || null,
    });
  } catch (error) {
    console.error('[session-status] Error:', error.message);
    res.status(500).json({
      error: 'No se pudo verificar la sesion.',
      detail: buildUserFacingError(error),
      authenticated: false,
      currentUrl: null,
      checkedAt: new Date().toISOString(),
      hasSavedAuthState: hasSavedAuthState(userId),
      suggestedUserId: null,
      rateLimited: isSonyRateLimited(),
      lastSonyRateLimitAt: lastSonyRateLimitAt || null,
    });
  }
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
  state.percent = 0;
  state.visitedDiscoveryPages = 0;
  state.totalDiscoveryPages = 0;
  state.discoveredPrograms = 0;
  state.hydratedPrograms = 0;
  state.totalPrograms = 0;
  state.currentUrl = '';
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
    state.percent = 5;
    const discovery = await discoverProgramTargets(context, page, (progress) => {
      state.phase = 'discovering';
      state.visitedDiscoveryPages = progress.visitedPages;
      state.totalDiscoveryPages = progress.totalPages;
      state.discoveredPrograms = progress.discoveredPrograms;
      state.currentUrl = progress.currentUrl;
      const discoveryPercent = progress.totalPages
        ? Math.round((progress.visitedPages / progress.totalPages) * 70)
        : 5;
      state.percent = Math.max(state.percent || 0, Math.min(70, discoveryPercent));
    });
    state.phase = 'hydrating-titles';
    state.percent = Math.max(state.percent || 0, 72);
    const programs = normalizeCatalogPrograms(
      (await hydrateMissingProgramTitles(context, filterIgnoredPrograms(discovery.programs), (progress) => {
        state.phase = 'hydrating-titles';
        state.hydratedPrograms = progress.completedPrograms;
        state.totalPrograms = progress.totalPrograms;
        state.currentUrl = progress.currentUrl;
        const hydrationPercent = progress.totalPrograms
          ? 72 + Math.round((progress.completedPrograms / progress.totalPrograms) * 23)
          : 90;
        state.percent = Math.max(state.percent || 0, Math.min(95, hydrationPercent));
      }))
        .filter((program) => !isUntitledProgram(program))
    );

    state.phase = 'saving';
    state.percent = 98;
    const previousResults = normalizeUntitledPrograms(readScanResults(userId));
    writeScanResults(userId, { ...previousResults, catalogPrograms: programs });
    state.percent = 100;
  } catch (error) {
    console.error('[catalog/refresh] Error:', error.message);
    state.lastError = buildUserFacingError(error);
  } finally {
    state.active = false;
    state.phase = 'idle';
    state.currentUrl = '';
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
    const finalTotalPrograms = Number(state.totalPrograms) || 0;
    state.phase = 'completed';
    state.completedAt = new Date().toISOString();
    state.completedPrograms = finalTotalPrograms || Number(state.completedPrograms) || 0;
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
      detail: 'La variable GROQ_API_KEY no esta configurada en el servidor. Agregala en el archivo .env del proyecto.',
    });
  }

  try {
    const scanResults = normalizeUntitledPrograms(readScanResults(userId));
    const inventory = readInventoryResults(userId);

    const allActiveMissions = dedupeMissions(scanResults.missions || [])
      .filter((m) => (m.current || 0) < (m.target || 0))
      .filter(isActionableMissionForAi);
    const selectedMissionKeys = Array.isArray(req.body?.missionKeys)
      ? new Set(req.body.missionKeys.map((key) => String(key)))
      : null;
    const missions = selectedMissionKeys?.size
      ? allActiveMissions.filter((mission) => selectedMissionKeys.has(getMissionKey(mission)))
      : allActiveMissions;
    const cards = inventory?.cards || [];

    if (!missions.length) {
      return res.status(400).json({
        error: 'No hay objetivos activos para analizar.',
        detail: selectedMissionKeys?.size
          ? 'Los objetivos seleccionados ya no existen, ya fueron completados o no tienen una instruccion jugable. Actualiza el escaneo.'
          : 'Ejecuta un escaneo de programas primero. Las colecciones y objetivos generales no jugables se excluyen del analisis.',
      });
    }

    const filteredCards = filterInventoryCardsForMissions(missions, cards, 50);
    const prompt = buildAiSuggestPrompt(missions, filteredCards, cards.length);
    logAiPromptForDebug(userId, prompt, missions.length, filteredCards.length);
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

    const responsePayload = {
      recommendations: parsed.recommendations || [],
      best_overall_modes: parsed.best_overall_modes || [],
      summary: parsed.summary || '',
      analyzedAt: new Date().toISOString(),
      missionsAnalyzed: missions.length,
      cardsProvided: filteredCards.length,
      cardsAvailable: cards.length,
    };

    sanitizeAiRecommendations(responsePayload, missions, filteredCards);

    if (shouldReturnAiDebugPrompt(req)) {
      responsePayload.debugPrompt = {
        model: AI_MODEL,
        prompt,
        missionsIncluded: Math.min(missions.length, 20),
        cardsIncluded: filteredCards.length,
        cardsAvailable: cards.length,
      };
    }

    return res.json(responsePayload);
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
      model: AI_MODEL,
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
      max_tokens: 1500,
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

function shouldReturnAiDebugPrompt(req) {
  return req.query?.debugAiPrompt === '1' || req.headers['x-ai-debug-prompt'] === '1';
}

function logAiPromptForDebug(userId, prompt, missionCount, cardCount) {
  if (!AI_DEBUG_PROMPT) return;

  const clippedPrompt = prompt.length > AI_DEBUG_PROMPT_MAX_CHARS
    ? `${prompt.slice(0, AI_DEBUG_PROMPT_MAX_CHARS)}\n...[prompt recortado: ${prompt.length} caracteres totales]`
    : prompt;

  console.log(`[ai-suggest] Prompt debug user=${userId} model=${AI_MODEL} missions=${missionCount} cards=${cardCount} chars=${prompt.length}`);
  console.log(clippedPrompt);
}

function sanitizeAiRecommendations(payload, missions, inventoryCards) {
  const recommendations = Array.isArray(payload.recommendations) ? payload.recommendations : [];
  const missionLookup = buildMissionLookup(missions);
  const inventoryLookup = buildInventoryLookup(inventoryCards);
  const bestOverall = new Set();
  let removedInvalidCards = false;

  for (const recommendation of recommendations) {
    const covered = Array.isArray(recommendation.missions_covered) ? recommendation.missions_covered : [];
    const coveredMissions = covered
      .map((label) => findMissionForAiLabel(label, missionLookup))
      .filter(Boolean);

    const commonModes = intersectMissionModes(coveredMissions);
    if (commonModes.length) {
      recommendation.best_modes = commonModes.map(formatModeKeyForAi);
      commonModes.forEach((mode) => bestOverall.add(formatModeKeyForAi(mode)));
    }

    const sanitizedCards = sanitizeAiRecommendedCards(
      recommendation.recommended_cards,
      coveredMissions,
      inventoryLookup
    );
    recommendation.recommended_cards = sanitizedCards.cards;

    if (sanitizedCards.removedNames.length) {
      removedInvalidCards = true;
      recommendation.strategy = buildValidatedStrategy(
        recommendation.strategy,
        recommendation.recommended_cards,
        coveredMissions,
        recommendation.best_modes
      );
    }
  }

  if (bestOverall.size) {
    payload.best_overall_modes = Array.from(bestOverall);
    payload.summary = sanitizeAiSummaryModeText(payload.summary, payload.best_overall_modes);
  }

  if (removedInvalidCards) {
    payload.summary = buildValidatedSummary(recommendations, payload.best_overall_modes);
  }
}

function buildValidatedSummary(recommendations, bestModes) {
  const validCards = new Set();
  const coveredPrograms = new Set();

  for (const recommendation of recommendations) {
    for (const card of Array.isArray(recommendation.recommended_cards) ? recommendation.recommended_cards : []) {
      if (card?.name) validCards.add(card.name);
    }
    for (const program of Array.isArray(recommendation.programs) ? recommendation.programs : []) {
      if (program) coveredPrograms.add(program);
    }
  }

  const modeText = Array.isArray(bestModes) && bestModes.length ? ` en ${bestModes.join(', ')}` : '';
  const cardText = validCards.size ? ` usando ${Array.from(validCards).join(', ')}` : '';
  const programText = coveredPrograms.size ? ` para ${Array.from(coveredPrograms).join(', ')}` : '';
  return `Resumen validado: se filtraron cartas que no cumplian equipo, jugador o requisito. Recomendacion final${modeText}${cardText}${programText}.`;
}

function sanitizeAiRecommendedCards(cards, coveredMissions, inventoryLookup) {
  if (!Array.isArray(cards) || !coveredMissions.length) return { cards: [], removedNames: [] };

  const kept = [];
  const removedNames = [];

  for (const rawCard of cards) {
    const card = enrichAiCardFromInventory(rawCard, inventoryLookup);
    if (coveredMissions.some((mission) => cardCanSatisfyMission(card, mission))) {
      kept.push(card);
    } else if (rawCard?.name) {
      removedNames.push(rawCard.name);
    }
  }

  return { cards: kept, removedNames };
}

function buildValidatedStrategy(originalStrategy, cards, coveredMissions, modes) {
  const cardNames = cards.map((card) => card.name).filter(Boolean);
  const missionLabels = coveredMissions
    .map((mission) => `[${mission.programTitle}] ${mission.description || mission.name}`)
    .filter(Boolean);
  const modeText = Array.isArray(modes) && modes.length ? ` en ${modes.join(', ')}` : '';

  if (cardNames.length) {
    return `Juega${modeText} con ${cardNames.join(', ')} para avanzar los objetivos compatibles: ${missionLabels.join(' | ')}.`;
  }

  return originalStrategy
    ? `${originalStrategy} No se mostraron cartas porque las recomendaciones de la IA no cumplian equipo, jugador o requisito.`
    : 'No se mostraron cartas porque las recomendaciones de la IA no cumplian equipo, jugador o requisito.';
}

function enrichAiCardFromInventory(card, inventoryLookup) {
  const inventoryCard = findInventoryCardForAiCard(card, inventoryLookup);
  if (!inventoryCard) return card;

  return {
    ...card,
    name: cleanInventoryCardName(inventoryCard.name) || card.name,
    overall: card.overall || inventoryCard.overall || '',
    position: card.position || inventoryCard.position || '',
    team: card.team || normalizeCardTeam(inventoryCard.team) || '',
    series: card.series || inventoryCard.series || '',
    in_inventory: true,
  };
}

function findInventoryCardForAiCard(card, inventoryLookup) {
  const name = normalizeAiMatchText(card?.name || '');
  if (!name) return null;
  if (inventoryLookup.exact.has(name)) return inventoryLookup.exact.get(name);

  for (const [candidate, inventoryCard] of inventoryLookup.searchable.entries()) {
    if (candidate.includes(name) || name.includes(candidate)) {
      return inventoryCard;
    }
  }

  return null;
}

function buildInventoryLookup(cards) {
  const exact = new Map();
  const searchable = new Map();

  for (const card of Array.isArray(cards) ? cards : []) {
    const cleanName = normalizeAiMatchText(cleanInventoryCardName(card.name));
    const fullName = normalizeAiMatchText(card.name || '');
    if (cleanName) exact.set(cleanName, card);
    if (cleanName) searchable.set(cleanName, card);
    if (fullName) searchable.set(fullName, card);
  }

  return { exact, searchable };
}

function cardCanSatisfyMission(card, mission) {
  if (!card || !mission) return false;

  const playerTokens = extractSpecificPlayerTokens(mission);
  if (playerTokens.length) {
    const cardText = normalizeAiMatchText(`${card.name || ''} ${card.series || ''}`);
    return playerTokens.every((token) => cardText.includes(token));
  }

  const filters = extractMissionFilters(mission);
  const hasFilters = filters.series.length || filters.teams.length || filters.positions.length || filters.positionGroups.length;
  if (hasFilters) {
    return cardMatchesMission(card, filters);
  }

  if (hasHittingObjective(mission)) {
    return !isPitcherPosition(card.position);
  }

  return true;
}

function extractSpecificPlayerTokens(mission) {
  const normalized = normalizeAiMatchText(`${mission.description || ''} ${mission.name || ''}`);
  return extractQuotedLikePlayerPhrases(normalized)
    .flatMap((phrase) => extractAiMatchTokens(phrase))
    .filter((token) => !isSeriesToken(token));
}

function sanitizeAiSummaryModeText(summary, validModes) {
  if (!summary || !Array.isArray(validModes) || !validModes.length) return summary;
  let nextSummary = summary;
  for (const mode of validModes) {
    nextSummary = nextSummary.replace(/Conquest\s+en\s+1\s+vs\s+1\s+Ranked/gi, mode);
    nextSummary = nextSummary.replace(/Conquest\s+in\s+1\s+vs\s+1\s+Ranked/gi, mode);
  }
  return nextSummary;
}

function findMissionForAiLabel(label, missionLookup) {
  const normalized = normalizeAiMatchText(label);
  if (!normalized) return null;
  if (missionLookup.has(normalized)) return missionLookup.get(normalized);

  for (const [candidate, mission] of missionLookup.entries()) {
    if (!candidate) continue;
    if (candidate.includes(normalized) || normalized.includes(candidate)) {
      return mission;
    }
  }

  return null;
}

function buildMissionLookup(missions) {
  const lookup = new Map();
  for (const mission of missions) {
    [
      mission.name,
      mission.description,
      `${mission.programTitle} ${mission.name}`,
      `${mission.programTitle} ${mission.description}`,
    ].filter(Boolean).forEach((label) => {
      lookup.set(normalizeAiMatchText(label), mission);
    });
  }
  return lookup;
}

function intersectMissionModes(missions) {
  if (!missions.length) return [];
  let common = null;

  for (const mission of missions) {
    const modes = extractModeSet(mission.whereToPlay);
    if (!modes.size) continue;
    common = common === null
      ? new Set(modes)
      : new Set(Array.from(common).filter((mode) => modes.has(mode)));
  }

  return common ? Array.from(common) : [];
}

function buildAiSuggestPrompt(missions, cards, totalCardsAvailable = cards.length) {
  const missionsText = missions
    .slice(0, 20)
    .map((m, i) =>
      `${i + 1}.[${escapeJsonString(m.programTitle)}]${escapeJsonString(m.description || m.name)}|${escapeJsonString(m.whereToPlay)}|MODOS:${formatModeListForAi(m.whereToPlay)}|${m.current}/${m.target}`
    )
    .join('\n');

  const cardsText = cards.length
    ? cards
        .map((c) => formatCardForAiPrompt(c))
        .join('\n')
    : 'Sin cartas filtradas por requisito.';

  return `Analiza objetivos de MLB The Show 26 Diamond Dynasty. Debes hacer un ANALISIS GLOBAL, no una recomendacion individual por mision. Agrupa todos los objetivos seleccionados en bloques compatibles por modo de juego y requisitos de cartas.

OBJETIVOS (${missions.length} total${missions.length > 20 ? ', primeros 20' : ''}):
${missionsText}

INVENTARIO FILTRADO (${cards.length} cartas enviadas de ${totalCardsAvailable} disponibles):
${cardsText}

Reglas:
- No recomiendes objetivo por objetivo. Cada recommendation debe representar un plan: "para objetivos A/B/C juega X modo con estas cartas; para D/E juega Y modo con estas cartas".
- missions_covered debe listar todos los objetivos que ese plan avanza juntos.
- strategy debe explicar el plan general por bloques, no repetir una frase por cada mision.
- Recomienda SOLO cartas listadas en INVENTARIO FILTRADO.
- Cada carta recomendada debe estar relacionada con un requisito real de al menos un objetivo cubierto: equipo, jugador, serie, posicion/rol de bateador o pitcher.
- Si un requisito dice "with Twins players", recomienda solo cartas TEAM Twins para ese objetivo; si dice "with Mariners players", recomienda solo cartas TEAM Mariners.
- Si el requisito pide hits, home runs, RBI, runs, total bases o bases robadas, recomienda bateadores y no pitchers.
- Si el requisito pide strikeouts o innings pitched, recomienda pitchers y no bateadores.
- Si el requisito pide Parallel XP con un jugador especifico, recomienda solo ese jugador si aparece en el inventario filtrado; si no aparece, explicalo en strategy y no inventes una carta sustituta.
- No incluyas Boss Collection, collections, exchanges, vouchers ni objetivos generales sin accion ejecutable.
- Para cada recommendation, best_modes debe contener solo modos exactos que aparezcan en TODOS los objetivos cubiertos por esa recommendation. No combines dos modos distintos en una frase: "Conquest en 1 vs 1 Ranked" es invalido. Si un objetivo solo tiene Conquest y otro tiene Conquest, Ranked y Events, el modo comun correcto es solo Conquest.

JSON de respuesta (sin texto extra):
{"recommendations":[{"missions_covered":["",""],"programs":[""],"best_modes":[""],"recommended_cards":[{"name":"","overall":"","position":"","team":"","series":"","in_inventory":true,"covers_missions_count":"","reason":""}],"strategy":""}],"best_overall_modes":[""],"summary":""}`;
}

function escapeJsonString(value) {
  return String(value || '').replace(/[\n\r"\\]/g, ' ').trim();
}

function formatCardForAiPrompt(card) {
  return [
    cleanInventoryCardName(card.name) || card.name || '',
    card.overall ? `OVR ${card.overall}` : '',
    card.position ? `POS ${card.position}` : '',
    normalizeCardTeam(card.team) ? `TEAM ${normalizeCardTeam(card.team)}` : '',
    card.series ? `SERIES ${card.series}` : '',
  ].filter(Boolean).join(' | ');
}

function cleanInventoryCardName(name) {
  return String(name || '')
    .replace(/^x\d+\s+/i, '')
    .replace(/\s+\d+\s+(?:SP|RP|CP|C|1B|2B|3B|SS|LF|CF|RF|DH)\b.*$/i, '')
    .trim();
}

function normalizeCardTeam(team) {
  const text = normalizeAiMatchText(team || '');
  const filters = extractMissionFilters({ name: text, description: text });
  return filters.teams[0] || String(team || '').replace(/^x\d+\s+/i, '').trim();
}

function formatModeListForAi(whereToPlay) {
  const modes = Array.from(extractModeSet(whereToPlay)).map(formatModeKeyForAi);
  return modes.length ? modes.join(', ') : 'Sin modo especifico';
}

function formatModeKeyForAi(mode) {
  const labels = {
    conquest: 'Conquest',
    mini_seasons: 'Mini Seasons',
    ranked: '1 vs 1 Ranked',
    ranked_coop: 'Ranked Co-op',
    events: 'Events',
    weekend_classic: 'Weekend Classic',
    moments: 'Moments',
    showdown: 'Showdown',
    battle_royale: 'Battle Royale',
    vs_cpu: 'Play vs CPU',
    diamond_quest: 'Diamond Quest',
  };
  return labels[mode] || mode;
}

function getMissionKey(mission) {
  return [
    mission.sourceUrl || '',
    mission.programTitle || '',
    mission.name || '',
    mission.description || '',
  ].join('||');
}

function filterInventoryCardsForMissions(missions, cards, limit = 50) {
  if (!cards.length) return [];

  const requirementTokens = new Set();
  const exactPhrases = [];
  const playerNameTokens = new Set();
  const missionFilters = missions.slice(0, 20).map(extractMissionFilters);
  const promptCards = cards.map((card) => ({
    ...card,
    name: cleanInventoryCardName(card.name) || card.name,
    team: normalizeCardTeam(card.team),
  }));

  for (const mission of missions.slice(0, 20)) {
    const text = `${mission.description || ''} ${mission.name || ''}`;
    const normalized = normalizeAiMatchText(text);
    const phrases = extractQuotedLikePlayerPhrases(normalized);
    exactPhrases.push(...phrases);
    for (const phrase of phrases) {
      extractAiMatchTokens(phrase)
        .filter((token) => !isSeriesToken(token))
        .forEach((token) => playerNameTokens.add(token));
    }
    extractAiMatchTokens(normalized).forEach((token) => requirementTokens.add(token));
  }

  const scored = promptCards
    .map((card, index) => {
      const cardText = normalizeAiMatchText(`${card.name || ''} ${card.team || ''} ${card.series || ''} ${card.position || ''}`);
      const cardTokens = extractAiMatchTokens(cardText);
      let score = 0;

      for (const token of cardTokens) {
        if (requirementTokens.has(token)) score += 3;
        if (playerNameTokens.has(token)) score += 10;
      }

      for (const phrase of exactPhrases) {
        if (phrase && cardText.includes(phrase)) score += 12;
      }

      for (const filters of missionFilters) {
        const hasFilters = filters.series.length || filters.teams.length || filters.positions.length || filters.positionGroups.length;
        if (hasFilters && cardMatchesMission(card, filters)) {
          score += 20;
        }
      }

      const team = normalizeAiMatchText(card.team || '');
      if (team && requirementTokens.has(team)) score += 8;

      return { card, index, score, cardTokens };
    })
    .filter((item) => {
      if (item.score <= 0) return false;
      if (!playerNameTokens.size) return true;
      for (const token of item.cardTokens) {
        if (playerNameTokens.has(token)) return true;
      }
      return item.score >= 8;
    })
    .sort((a, b) => b.score - a.score || (Number(b.card.overall) || 0) - (Number(a.card.overall) || 0) || a.index - b.index);

  const augmented = addGenericObjectiveCards(scored, promptCards, missions.slice(0, 20), limit);
  return augmented.slice(0, limit).map((item) => item.card);
}

function addGenericObjectiveCards(scoredItems, cards, missions, limit) {
  const byKey = new Map();
  const addCard = (card, index, score) => {
    const key = normalizeAiMatchText(`${card.name || ''} ${card.team || ''} ${card.series || ''} ${card.position || ''}`);
    const current = byKey.get(key);
    if (!current || score > current.score) {
      byKey.set(key, { card, index, score, cardTokens: extractAiMatchTokens(key) });
    }
  };

  scoredItems.forEach((item) => addCard(item.card, item.index, item.score));

  const needsHitters = missions.some(hasGenericHittingObjective);
  const needsPitchers = missions.some(hasPitchingObjective);
  const needsAnyPxp = missions.some(hasGenericPxpObjective);

  if (needsHitters) {
    topCardsByRole(cards, (card) => !isPitcherPosition(card.position), Math.ceil(limit * 0.55))
      .forEach(({ card, index }) => addCard(card, index, 12 + (Number(card.overall) || 0) / 100));
  }

  if (needsPitchers) {
    topCardsByRole(cards, (card) => isPitcherPosition(card.position), Math.ceil(limit * 0.45))
      .forEach(({ card, index }) => addCard(card, index, 12 + (Number(card.overall) || 0) / 100));
  }

  if (needsAnyPxp && byKey.size < limit) {
    topCardsByRole(cards, () => true, limit)
      .forEach(({ card, index }) => addCard(card, index, 6 + (Number(card.overall) || 0) / 100));
  }

  if (!byKey.size) {
    topCardsByRole(cards, () => true, limit)
      .forEach(({ card, index }) => addCard(card, index, (Number(card.overall) || 0) / 100));
  }

  return Array.from(byKey.values())
    .sort((a, b) => b.score - a.score || (Number(b.card.overall) || 0) - (Number(a.card.overall) || 0) || a.index - b.index);
}

function topCardsByRole(cards, predicate, limit) {
  return cards
    .map((card, index) => ({ card, index }))
    .filter(({ card }) => predicate(card))
    .sort((a, b) => (Number(b.card.overall) || 0) - (Number(a.card.overall) || 0) || a.index - b.index)
    .slice(0, limit);
}

function normalizeAiMatchText(value) {
  return String(value || '')
    .toLowerCase()
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/[^a-z0-9' ]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function extractAiMatchTokens(value) {
  const stopWords = new Set([
    'with', 'players', 'player', 'tally', 'parallel', 'xp', 'pxp', 'the', 'and', 'or',
    'in', 'on', 'to', 'a', 'an', 'of', 'from', 'get', 'earn', 'record', 'total', 'hits',
    'hit', 'home', 'runs', 'run', 'rbi', 'strikeouts', 'strikeout', 'innings', 'inning',
    'fan', 'number', 'no', 'vs', 'cpu', 'ranked', 'events', 'conquest', 'season', 'seasons',
    'any', 'difficulty', 'city', 'kansas', 'new', 'york', 'los', 'angeles', 'san', 'diego',
    'francisco', 'tampa', 'bay', 'st', 'louis', 'chicago',
  ]);

  return value
    .split(' ')
    .map((token) => token.trim())
    .filter((token) => token.length >= 3 && !stopWords.has(token) && !/^\d+$/.test(token));
}

function isSeriesToken(token) {
  return ['jolt', 'live', 'awards', 'breakout', 'spotlight', 'cornerstone', 'topps', 'now'].includes(token);
}

function hasHittingObjective(mission) {
  const text = `${mission.description || ''} ${mission.name || ''}`.toLowerCase();
  return /\b(hit|hits|home runs?|hr|rbi|stolen base|bases robadas?|steal)\b/.test(text);
}

function hasGenericHittingObjective(mission) {
  if (!hasHittingObjective(mission)) return false;
  return !hasSpecificPlayerRequirement(mission);
}

function hasPitchingObjective(mission) {
  const text = `${mission.description || ''} ${mission.name || ''}`.toLowerCase();
  return /\b(strikeouts?|innings pitched|innings?|k's|ks)\b/.test(text);
}

function hasGenericPxpObjective(mission) {
  const text = `${mission.description || ''} ${mission.name || ''}`.toLowerCase();
  return (text.includes('parallel xp') || text.includes('pxp')) && !hasSpecificPlayerRequirement(mission);
}

function isActionableMissionForAi(mission) {
  return !isNonPlayableMissionForAi(mission) && hasExecutableObjectiveForAi(mission);
}

function isNonPlayableMissionForAi(mission) {
  const name = normalizeAiMatchText(mission.name || '');
  const group = normalizeAiMatchText(mission.objectiveGroup || '');
  const description = normalizeAiMatchText(mission.description || '');
  const text = `${name} ${description} ${group}`;
  return name.includes('boss collection') ||
    group.includes('boss collection') ||
    group === 'inning boss collection' ||
    description.includes('collect the') ||
    /\bcollect\s+\d*\s*(?:the\s+)?(?:two\s+)?\w*\s*boss/.test(description) ||
    text.includes('complete a series of missions') ||
    text.includes('complete hits missions') ||
    text.includes('find a repeatable mission') ||
    text.includes('wheel spins') ||
    text.includes('voucher') ||
    text.includes('exchange');
}

function hasExecutableObjectiveForAi(mission) {
  const text = normalizeAiMatchText(`${mission.name || ''} ${mission.description || ''}`);
  const hasAction = /\b(tally|record|get|earn|hit|hits|home run|home runs|hr|rbi|run|runs|stolen base|steal|total bases|extra base|strikeout|strikeouts|innings pitched|inning pitched|pxp|parallel xp|player xp|win|wins|defeat)\b/.test(text);
  if (!hasAction) return false;
  if (normalizeAiMatchText(mission.objectiveGroup || '') === 'general') {
    return hasHittingObjective(mission) ||
      hasPitchingObjective(mission) ||
      /\b(pxp|parallel xp|player xp|win|wins|defeat)\b/.test(text);
  }
  return true;
}

function hasSpecificPlayerRequirement(mission) {
  return extractSpecificPlayerTokens(mission).length > 0;
}

function isPitcherPosition(position) {
  return ['SP', 'RP', 'CP'].includes(String(position || '').toUpperCase());
}

function extractQuotedLikePlayerPhrases(value) {
  const phrases = [];
  const match = value.match(/\bwith\s+(.+?)(?:\s+players?|\s+cards?|\s+in\b|\.|$)/);
  if (match?.[1]) {
    const phrase = match[1].trim();
    if (phrase.split(' ').length >= 2) phrases.push(phrase);
  }
  return phrases;
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
  if (w.includes('1 vs 1 ranked')) modes.add('ranked');
  if (w.includes('ranked co-op') || w.includes('ranked co op')) modes.add('ranked_coop');
  if (w.includes('events')) modes.add('events');
  if (w.includes('weekend classic')) modes.add('weekend_classic');
  if (w.includes('moments')) modes.add('moments');
  if (w.includes('showdown')) modes.add('showdown');
  if (w.includes('battle royale')) modes.add('battle_royale');
  if (w.includes('play vs cpu') || w.includes('vs cpu') || w.includes('vs. cpu')) modes.add('vs_cpu');
  if (w.includes('diamond quest')) modes.add('diamond_quest');
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

async function discoverProgramTargets(context, rootPage, onProgress) {
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
    if (onProgress) {
      onProgress({
        visitedPages: visited.size,
        totalPages: visited.size + toVisit.length,
        discoveredPrograms: programMap.size,
        currentUrl,
      });
    }

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
      if (onProgress) {
        onProgress({
          visitedPages: visited.size,
          totalPages: visited.size + toVisit.length,
          discoveredPrograms: programMap.size,
          currentUrl,
        });
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
          anchor.querySelector('.mlb26-program-tile-text') ||
          anchor.querySelector('.sidebar-links-toggle-label') ||
          anchor.querySelector('h1, h2, h3, h4');
        const title = (titleNode?.textContent || anchor.textContent || '').replace(/\s+/g, ' ').trim();

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
  const rawTitle = normalizeKnownProgramTitle(`${item?.title || ''}`.trim());

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
      return {
        ...program,
        title: normalizeKnownProgramTitle(program.title) || program.title,
        topGroup: normalizeKnownProgramTitle(program.topGroup) || program.topGroup,
      };
    }

    const specificTitle = normalizeKnownProgramTitle(program.title);
    const hasSpecificInningTitle = /\b\d+(st|nd|rd|th)\s+inning\s+xp\s+path\b/i.test(specificTitle);

    return {
      ...program,
      title: hasSpecificInningTitle ? specificTitle : replacement.title || specificTitle || program.title,
      topGroup: hasSpecificInningTitle ? specificTitle : replacement.topGroup || program.topGroup,
      subGroup: replacement.subGroup ?? program.subGroup,
    };
  });
}

function normalizeKnownProgramTitle(title) {
  const rawTitle = `${title || ''}`.replace(/\s+/g, ' ').trim();
  const inningMatch = rawTitle.match(/\b(\d+)(st|nd|rd|th)\s+inning\s+xp\s+path\b/i);

  if (inningMatch) {
    return `${Number(inningMatch[1])}${inningMatch[2].toLowerCase()} Inning XP Path`;
  }

  return rawTitle;
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

async function hydrateMissingProgramTitles(context, programs, onProgress) {
  const hydrated = [];
  const totalPrograms = Array.isArray(programs) ? programs.length : 0;

  for (const program of programs || []) {
    if (onProgress) {
      onProgress({
        completedPrograms: hydrated.length,
        totalPrograms,
        currentUrl: program.url,
      });
    }

    if (program?.title && program.title !== 'Programa sin titulo') {
      hydrated.push(program);
      if (onProgress) {
        onProgress({
          completedPrograms: hydrated.length,
          totalPrograms,
          currentUrl: program.url,
        });
      }
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

    if (onProgress) {
      onProgress({
        completedPrograms: hydrated.length,
        totalPrograms,
        currentUrl: program.url,
      });
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
  const byKey = new Map();

  for (const rawMission of missions) {
    const mission = normalizeMissionPresentation(rawMission);
    const key = buildMissionDedupeKey(mission);
    const existing = byKey.get(key);
    if (!existing || missionSpecificityScore(mission) > missionSpecificityScore(existing)) {
      byKey.set(key, mission);
    }
  }

  return Array.from(byKey.values());
}

function normalizeMissionPresentation(mission) {
  const description = String(mission?.description || '');
  const bossCollectionMatch = description.match(/Collect the two (\d+(?:st|nd|rd|th)) Inning XP Reward Path bosses/i);
  if (bossCollectionMatch) {
    return {
      ...mission,
      name: `${bossCollectionMatch[1]} Inning Boss Collection`,
      objectiveGroup: 'Inning Boss Collection',
    };
  }

  return mission;
}

function buildMissionDedupeKey(mission) {
  return [
    normalizeAiMatchText(mission.sourceUrl || ''),
    normalizeAiMatchText(mission.programTitle || ''),
    normalizeAiMatchText(mission.description || mission.name || ''),
    normalizeAiMatchText(mission.whereToPlay || ''),
    `${mission.current || 0}/${mission.target || 0}`,
  ].join('::');
}

function missionSpecificityScore(mission) {
  const name = String(mission.name || '').trim();
  const group = String(mission.objectiveGroup || '').trim();
  let score = name.length ? 1 : 0;
  if (name && group && name !== group) score += 3;
  if (!/\bmissions?\b/i.test(name)) score += 2;
  if (mission.description && name && !mission.description.includes(name)) score += 1;
  return score;
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
  const normalizedResults = {
    ...results,
    missions: Array.isArray(results?.missions) ? dedupeMissions(results.missions) : [],
  };
  fs.writeFileSync(getScanResultsFile(userId), JSON.stringify(normalizedResults, null, 2));
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
