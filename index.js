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
const AUTH_STATE_FILE = path.join(DATA_DIR, 'auth_state.json');
const SCAN_RESULTS_FILE = path.join(DATA_DIR, 'scan_results.json');
const INVENTORY_RESULTS_FILE = path.join(DATA_DIR, 'inventory_results.json');
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
const scanState = {
  active: false,
  cancelRequested: false,
};

fs.mkdirSync(DATA_DIR, { recursive: true });

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
  try {
    fs.rmSync(USER_DATA_DIR, { recursive: true, force: true });
    fs.rmSync(AUTH_STATE_FILE, { force: true });

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
  const results = normalizeUntitledPrograms(readScanResults());
  const inventory = readInventoryResults();
  const enriched = attachInventorySuggestionsToScanResults(results, inventory);
  const cleanedCatalogPrograms = filterIgnoredPrograms(enriched.catalogPrograms).filter((program) => !isUntitledProgram(program));
  res.json({
    ...enriched,
    catalogPrograms: cleanedCatalogPrograms,
    missions: Array.isArray(enriched.missions) ? enriched.missions.filter((mission) => !isIgnoredMission(mission)) : [],
  });
});

app.get('/api/inventory', async (req, res) => {
  res.json(readInventoryResults());
});

app.post('/api/import-session', async (req, res) => {
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

    fs.writeFileSync(AUTH_STATE_FILE, JSON.stringify(storageState, null, 2));

    res.json({
      ok: true,
      authStatePath: AUTH_STATE_FILE,
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
  try {
    const savedStateExists = hasSavedAuthState();
    const validation = savedStateExists
      ? await validateSavedSession()
      : {
          authenticated: false,
          currentUrl: null,
          checkedAt: new Date().toISOString(),
        };

    res.json({
      authenticated: validation.authenticated,
      currentUrl: validation.currentUrl,
      checkedAt: validation.checkedAt,
      hasSavedAuthState: savedStateExists,
      authStatePath: AUTH_STATE_FILE,
      rateLimited: isSonyRateLimited(),
      lastSonyRateLimitAt: lastSonyRateLimitAt || null,
    });
  } catch (error) {
    res.status(500).json({
      error: 'No se pudo comprobar la sesion.',
      detail: buildUserFacingError(error),
    });
  }
});

app.get('/api/programs/catalog', async (req, res) => {
  let browser;
  let context;

  try {
    const forceRefresh = req.query.refresh === '1';
    const previousResults = normalizeUntitledPrograms(readScanResults());

    const cachedPrograms = filterIgnoredPrograms(previousResults.catalogPrograms).filter((program) => !isUntitledProgram(program));

    if (!forceRefresh && cachedPrograms.length && !cachedPrograms.some((program) => program.title === 'Programa sin titulo')) {
      return res.json({
        discoveredAt: previousResults.scannedAt || null,
        programs: cachedPrograms,
        cached: true,
      });
    }

    if (!hasSavedAuthState()) {
      return res.json({
        programs: [],
        discoveredAt: null,
      });
    }

    browser = await launchBrowser();
    context = await browser.newContext({
      storageState: AUTH_STATE_FILE,
    });

    const page = await context.newPage();

    await page.goto(PROGRAMS_URL, {
      waitUntil: 'domcontentloaded',
      timeout: 60000,
    });

    ensureAuthenticatedPage(page);

    const discovery = await discoverProgramTargets(context, page);
    const programs = normalizeCatalogPrograms(
      (await hydrateMissingProgramTitles(context, filterIgnoredPrograms(discovery.programs)))
        .filter((program) => !isUntitledProgram(program))
    );

    res.json({
      discoveredAt: new Date().toISOString(),
      programs,
      cached: false,
    });
  } catch (error) {
    res.status(500).json({
      error: 'No se pudo descubrir el catalogo de programas.',
      detail: buildUserFacingError(error),
    });
  } finally {
    if (context) {
      await context.close();
    }

    if (browser) {
      await browser.close();
    }
  }
});

app.get('/api/open-login', async (req, res) => {
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

    await context.storageState({ path: AUTH_STATE_FILE });

    res.json({
      ok: true,
      authenticated: true,
      currentUrl: page.url(),
      authStatePath: AUTH_STATE_FILE,
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
  return handleScanRequest([], res);
});

app.post('/api/scan', async (req, res) => {
  const selectedPrograms = Array.isArray(req.body?.selectedPrograms)
    ? req.body.selectedPrograms.filter(Boolean)
    : [];

  return handleScanRequest(selectedPrograms, res);
});

app.post('/api/scan/cancel', (req, res) => {
  if (!scanState.active) {
    return res.json({
      ok: true,
      cancelled: false,
      message: 'No hay un escaneo activo.',
    });
  }

  scanState.cancelRequested = true;
  return res.json({
    ok: true,
    cancelled: true,
    message: 'Se solicito detener el escaneo activo.',
  });
});

app.post('/api/inventory/scan', async (req, res) => {
  let browser;
  let context;

  try {
    if (!hasSavedAuthState()) {
      return res.status(400).json({
        error: 'No existe una sesion persistida.',
        detail: 'Primero importa o prepara una sesion valida.',
      });
    }

    browser = await launchBrowser();
    context = await browser.newContext({
      storageState: AUTH_STATE_FILE,
    });

    const page = await context.newPage();
    const cards = await scanFullInventory(context, page);
    const results = {
      scannedAt: new Date().toISOString(),
      total: cards.length,
      cards,
    };

    writeInventoryResults(results);
    await persistAuthState(context);
    return res.json(results);
  } catch (error) {
    return res.status(500).json({
      error: 'No se pudo leer el inventario.',
      detail: buildUserFacingError(error),
    });
  } finally {
    if (context) {
      await context.close();
    }

    if (browser) {
      await browser.close();
    }
  }
});

async function handleScanRequest(selectedPrograms, res) {
  let browser;
  let context;
  let scanCancelled = false;

  try {
    if (scanState.active) {
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

    if (!hasSavedAuthState()) {
      return res.status(400).json({
        error: 'No existe una sesion persistida.',
        detail: 'Primero prepara una sesion valida desde PC para crear auth_state.json.',
      });
    }

    scanState.active = true;
    scanState.cancelRequested = false;

    browser = await launchBrowser();
    context = await browser.newContext({
      storageState: AUTH_STATE_FILE,
    });

    const page = await context.newPage();

    await page.goto(AUTH_CHECK_URL, {
      waitUntil: 'domcontentloaded',
      timeout: 60000,
    });

    if (!isAuthenticatedMlbUrl(page.url())) {
      fs.rmSync(AUTH_STATE_FILE, { force: true });
      return res.status(401).json({
        error: 'La sesion persistida vencio.',
        detail: 'auth_state.json ya no es valido. Debes renovar la sesion desde PC.',
      });
    }

    await page.goto(PROGRAMS_URL, {
      waitUntil: 'networkidle',
      timeout: 60000,
    });
    await persistAuthState(context);

    const previousResults = normalizeUntitledPrograms(readScanResults());
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

    if (!programLinks.length) {
      throw new Error('Se abrio /programs, pero no se encontraron enlaces visitables de programas.');
    }

    const missions = [];
    const visitedLinks = [];
    const skippedLinks = [];
    let sessionExpired = false;

    for (const link of programLinks) {
      if (scanState.cancelRequested) {
        scanCancelled = true;
        skippedLinks.push({ url: link, reason: 'Escaneo cancelado por el usuario.' });
        break;
      }

      try {
        const programMeta = targetPrograms.find((program) => program.url === link) || { url: link };
        const result = await scanProgramPage(context, programMeta, seenProgramUrls);
        visitedLinks.push(link);
        await persistAuthState(context);

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
    const scanResults = normalizeUntitledPrograms(buildPersistedScanResults({
      previous: readScanResults(),
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

    writeScanResults(scanResults);
    res.json(attachInventorySuggestionsToScanResults(scanResults, readInventoryResults()));
  } catch (error) {
    console.error('Error en la automatizacion:', error);
    res.status(500).json({
      error: 'No se pudo completar el escaneo.',
      detail: buildUserFacingError(error),
    });
  } finally {
    scanState.active = false;
    scanState.cancelRequested = false;

    if (context) {
      await context.close();
    }

    if (browser) {
      await browser.close();
    }
  }
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

    const pageTitle = (document.title || '').replace(/\s+-\s+The Show MLB 26.*$/i, '').replace(/\s+/g, ' ').trim();
    if (pageTitle) {
      return pageTitle;
    }

    const bodyText = (document.body?.innerText || '').replace(/\s+/g, ' ').trim();
    const inningMatch = bodyText.match(/\b\d+(?:st|nd|rd|th)\s+Inning XP Path\b/i);
    if (inningMatch) {
      return inningMatch[0];
    }

    const multiplayerMatch = bodyText.match(/\bMultiplayer\s+\d+\s+Program\b/i);
    if (multiplayerMatch) {
      return multiplayerMatch[0];
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

async function scanFullInventory(context, page) {
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

  if (!cards.length || !missions.length) {
    return {
      ...scanResults,
      inventory: inventoryResults || readInventoryResults(),
    };
  }

  const enrichedMissions = missions.map((mission) => {
    const recommendedCards = recommendCardsForMission(mission, cards, missions);
    return {
      ...mission,
      recommendedCards: recommendedCards.cards,
      comboMissionCount: recommendedCards.comboMissionCount,
    };
  });

  return {
    ...scanResults,
    inventory: inventoryResults,
    missions: enrichedMissions,
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

function readScanResults() {
  if (!fs.existsSync(SCAN_RESULTS_FILE)) {
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
    return JSON.parse(fs.readFileSync(SCAN_RESULTS_FILE, 'utf8'));
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

function writeScanResults(results) {
  fs.writeFileSync(SCAN_RESULTS_FILE, JSON.stringify(results, null, 2));
}

function readInventoryResults() {
  if (!fs.existsSync(INVENTORY_RESULTS_FILE)) {
    return {
      scannedAt: null,
      total: 0,
      cards: [],
    };
  }

  try {
    return JSON.parse(fs.readFileSync(INVENTORY_RESULTS_FILE, 'utf8'));
  } catch {
    return {
      scannedAt: null,
      total: 0,
      cards: [],
    };
  }
}

function writeInventoryResults(results) {
  fs.writeFileSync(INVENTORY_RESULTS_FILE, JSON.stringify(results, null, 2));
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

function hasSavedAuthState() {
  return fs.existsSync(AUTH_STATE_FILE);
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

async function validateSavedSession() {
  let browser;
  let context;

  try {
    browser = await launchBrowser();
    context = await browser.newContext({
      storageState: AUTH_STATE_FILE,
    });

    const page = await context.newPage();

    await page.goto(AUTH_CHECK_URL, {
      waitUntil: 'domcontentloaded',
      timeout: 60000,
    });

    const authenticated = isAuthenticatedMlbUrl(page.url());

    if (!authenticated) {
      fs.rmSync(AUTH_STATE_FILE, { force: true });
    } else {
      await persistAuthState(context);
    }

    return {
      authenticated,
      currentUrl: page.url(),
      checkedAt: new Date().toISOString(),
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

async function persistAuthState(context) {
  if (!context) {
    return;
  }

  await context.storageState({ path: AUTH_STATE_FILE });
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
