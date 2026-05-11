const importButton = document.getElementById('import-button');
const importBodyButton = document.getElementById('import-body-button');
const clearImportButton = document.getElementById('clear-import-button');
const scanButton = document.getElementById('scan-button');
const aiSuggestButton = document.getElementById('ai-suggest-button');
const aiRegenerateButton = document.getElementById('ai-regenerate-button');
const aiPanel = document.getElementById('ai-panel');
const aiResultsNode = document.getElementById('ai-results');
const aiSummaryBlock = document.getElementById('ai-summary-block');
const cancelScanButton = document.getElementById('cancel-scan-button');
const resetButton = document.getElementById('reset-button');
const refreshProgramsButton = document.getElementById('refresh-programs-button');
const scanInventoryButton = document.getElementById('scan-inventory-button');
const shareLinkButton = document.getElementById('share-link-button');
const tokenDisplay = document.getElementById('token-display');
const tokenApplyButton = document.getElementById('token-apply-button');
const shareLinkOutput = document.getElementById('share-link-output');
const shareLinkStatus = document.getElementById('share-link-status');
const selectAllButton = document.getElementById('select-all-button');
const clearSelectionButton = document.getElementById('clear-selection-button');
const sessionInput = document.getElementById('session-input');
const statusNode = document.getElementById('status');
const scanDetailNode = document.getElementById('scan-detail');
const scanProgressLabelNode = document.getElementById('scan-progress-label');
const scanProgressBarNode = document.getElementById('scan-progress-bar');
const errorBanner = document.getElementById('error-banner');
const scanTimeNode = document.getElementById('scan-time');
const missionTotalNode = document.getElementById('mission-total');
const inventoryTimeNode = document.getElementById('inventory-time');
const inventoryTotalNode = document.getElementById('inventory-total');
const sessionStateNode = document.getElementById('session-state');
const sessionCheckedAtNode = document.getElementById('session-checked-at');
const programSelectorNode = document.getElementById('program-selector');
const missionsGroupsNode = document.getElementById('missions-groups');
const profileGate = document.getElementById('profile-gate');
const profileCreateTab = document.getElementById('profile-create-tab');
const profileLoginTab = document.getElementById('profile-login-tab');
const profileUsernameInput = document.getElementById('profile-username-input');
const profileGateHelp = document.getElementById('profile-gate-help');
const profileGateError = document.getElementById('profile-gate-error');
const profileSubmitButton = document.getElementById('profile-submit-button');

let programCatalog = [];
let selectedProgramUrls = new Set();
let inventoryPayload = { scannedAt: null, total: 0, cards: [] };
let scanStatusTimer = null;
let inventoryStatusTimer = null;
let groupedCatalogCache = [];
let groupedMissionCache = [];
let waitingForScanCompletion = false;
let currentScanStartedAt = null;
let profileMode = 'create';
cancelScanButton.disabled = true;
const PROFILE_USERNAME_KEY = 'mlb_profile_username';

function applyTokenFromUrl() {
  const urlToken = new URLSearchParams(window.location.search).get('token');
  if (urlToken && /^[a-zA-Z0-9_-]{2,50}$/.test(urlToken)) {
    localStorage.setItem('mlb_user_token', urlToken);
    const clean = new URL(window.location.href);
    clean.searchParams.delete('token');
    window.history.replaceState({}, '', clean.toString());
  }
}

function getStoredUserToken() {
  applyTokenFromUrl();
  const token = localStorage.getItem('mlb_user_token');
  return token && /^[a-zA-Z0-9_-]{2,50}$/.test(token) ? token : null;
}

function getUserToken() {
  let token = getStoredUserToken();

  if (!token) {
    token = (typeof crypto !== 'undefined' && crypto.randomUUID)
      ? crypto.randomUUID()
      : 'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, c => {
          const r = Math.random() * 16 | 0;
          return (c === 'x' ? r : (r & 0x3 | 0x8)).toString(16);
        });
    localStorage.setItem('mlb_user_token', token);
  }
  return token;
}

async function apiFetch(url, options = {}) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 20000);
  try {
    return await fetch(url, {
      ...options,
      signal: controller.signal,
      headers: {
        ...options.headers,
        'X-User-Token': getUserToken(),
      },
    });
  } finally {
    clearTimeout(timeout);
  }
}

let toastTimer = null;

function showToast(message, type = 'info', durationMs = 7000) {
  const toast = document.getElementById('scan-toast');
  const toastMsg = document.getElementById('scan-toast-message');
  toastMsg.textContent = message;
  toast.className = `scan-toast ${type}`;
  clearTimeout(toastTimer);
  if (durationMs > 0) {
    toastTimer = setTimeout(() => toast.classList.add('hidden'), durationMs);
  }
}

document.getElementById('scan-toast-close').addEventListener('click', () => {
  document.getElementById('scan-toast').classList.add('hidden');
  clearTimeout(toastTimer);
});

async function initializeProfile() {
  applyTokenFromUrl();

  const storedToken = getStoredUserToken();
  const storedUsername = localStorage.getItem(PROFILE_USERNAME_KEY);
  if (storedToken && storedUsername) {
    syncProfileShareFields();
    return;
  }

  if (storedToken) {
    try {
      const response = await fetch('/api/profile/current', {
        headers: { 'X-User-Token': storedToken },
      });
      const payload = await response.json();
      if (payload?.username) {
        localStorage.setItem(PROFILE_USERNAME_KEY, payload.username);
        syncProfileShareFields();
        return;
      }
    } catch {
      // Fall through to the profile gate.
    }
  }

  await showProfileGate();
  syncProfileShareFields();
}

function setProfileMode(mode) {
  profileMode = mode;
  const isCreate = mode === 'create';
  profileCreateTab.classList.toggle('active', isCreate);
  profileLoginTab.classList.toggle('active', !isCreate);
  profileSubmitButton.textContent = isCreate ? 'Crear usuario' : 'Entrar';
  profileGateHelp.textContent = isCreate
    ? 'Crea un usuario unico. Si este navegador ya tenia resultados, se asociaran a ese usuario.'
    : 'Ingresa tu usuario para abrir este mismo perfil en este dispositivo.';
  profileGateError.classList.add('hidden');
  profileGateError.textContent = '';
  profileUsernameInput.focus();
}

function showProfileGate() {
  return new Promise((resolve) => {
    profileGate.classList.remove('hidden');
    setProfileMode('create');

    const submit = async () => {
      const username = profileUsernameInput.value.trim().toLowerCase();
      profileGateError.classList.add('hidden');
      profileGateError.textContent = '';
      profileSubmitButton.disabled = true;
      profileSubmitButton.textContent = profileMode === 'create' ? 'Creando...' : 'Entrando...';

      try {
        const body = { username };
        const existingToken = getStoredUserToken();
        if (profileMode === 'create' && existingToken) {
          body.token = existingToken;
        }

        const response = await fetch(`/api/profile/${profileMode === 'create' ? 'create' : 'login'}`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(body),
        });
        const payload = await response.json();

        if (!response.ok) {
          throw new Error(payload.detail || payload.error || 'Error desconocido');
        }

        localStorage.setItem('mlb_user_token', payload.token);
        localStorage.setItem(PROFILE_USERNAME_KEY, payload.username);
        profileGate.classList.add('hidden');
        resolve();
      } catch (error) {
        profileGateError.textContent = error.message;
        profileGateError.classList.remove('hidden');
      } finally {
        profileSubmitButton.disabled = false;
        profileSubmitButton.textContent = profileMode === 'create' ? 'Crear usuario' : 'Entrar';
      }
    };

    profileCreateTab.onclick = () => setProfileMode('create');
    profileLoginTab.onclick = () => setProfileMode('login');
    profileSubmitButton.onclick = submit;
    profileUsernameInput.onkeydown = (event) => {
      if (event.key === 'Enter') {
        submit();
      }
    };
  });
}

initializeProfile().then(() => bootstrap());

async function bootstrap() {
  await Promise.all([refreshSessionStatus(), loadLastScan(), refreshProgramCatalog(), loadInventory()]);

  try {
    const statusResponse = await apiFetch('/api/scan/status');
    const statusPayload = await statusResponse.json();
    if (statusPayload?.active) {
      setBusyState(true);
      currentScanStartedAt = statusPayload.startedAt || new Date().toISOString();
      statusNode.textContent = 'Escaneo en progreso (continuando seguimiento)...';
      startScanStatusPolling(true);
    }
  } catch {
    // Ignore status check errors on startup.
  }
}

async function doImportSession() {
  setBusyState(true);
  hideError();
  statusNode.textContent = 'Importando la sesion pegada en auth_state.json...';
  scanDetailNode.textContent = 'Guardando cookies en auth_state.json...';
  const track = scanProgressBarNode.parentElement;
  track.classList.add('indeterminate');
  scanProgressLabelNode.textContent = '...';

  try {
    const response = await apiFetch('/api/import-session', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ raw: sessionInput.value }),
    });
    const payload = await response.json();

    if (!response.ok) {
      throw new Error(payload.detail || payload.error || 'Error desconocido');
    }

    statusNode.textContent = `Sesion importada. ${payload.cookieCount || 0} cookie(s) guardadas.`;
    scanDetailNode.textContent = 'Sesion lista. Puedes escanear programas ahora.';
    await Promise.all([refreshSessionStatus(), refreshProgramCatalog()]);
  } catch (error) {
    showError(error.message);
    statusNode.textContent = 'No se pudo importar la sesion.';
    scanDetailNode.textContent = error.message;
  } finally {
    track.classList.remove('indeterminate');
    scanProgressBarNode.style.width = '0%';
    scanProgressLabelNode.textContent = '—';
    setBusyState(false);
  }
}

importButton.addEventListener('click', doImportSession);
importBodyButton.addEventListener('click', doImportSession);
clearImportButton.addEventListener('click', () => {
  sessionInput.value = '';
  sessionInput.focus();
});

scanButton.addEventListener('click', async () => {
  setBusyState(true);
  hideError();
  statusNode.textContent = 'Iniciando escaneo...';
  scanDetailNode.textContent = 'Preparando el escaneo de programas seleccionados...';

  try {
    const selectedPrograms = getSelectedProgramUrls();
    const response = await apiFetch('/api/scan', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ selectedPrograms }),
    });
    const payload = await response.json();

    if (!response.ok) {
      throw new Error(payload.detail || payload.error || 'Error desconocido');
    }

    currentScanStartedAt = payload.startedAt || new Date().toISOString();
    statusNode.textContent = 'Reutilizando la sesion guardada y escaneando programas...';
    startScanStatusPolling(true);
    // setBusyState(false) will be called by the polling when scan completes
  } catch (error) {
    showError(error.message);
    statusNode.textContent = 'El escaneo fallo.';
    scanDetailNode.textContent = error.message;
    setBusyState(false);
  }
});

cancelScanButton.addEventListener('click', async () => {
  hideError();
  statusNode.textContent = 'Solicitando detener el escaneo...';
  scanDetailNode.textContent = 'Esperando que el backend termine el programa actual y se detenga.';

  try {
    const response = await apiFetch('/api/scan/cancel', { method: 'POST' });
    const payload = await response.json();

    if (!response.ok) {
      throw new Error(payload.detail || payload.error || 'Error desconocido');
    }

    statusNode.textContent = payload.message || 'Solicitud de cancelacion enviada.';
  } catch (error) {
    showError(error.message);
    statusNode.textContent = 'No se pudo detener el escaneo.';
  }
});

resetButton.addEventListener('click', async () => {
  setBusyState(true);
  hideError();
  statusNode.textContent = 'Reiniciando la sesion local de Playwright...';
  scanDetailNode.textContent = 'Borrando sesion local y manteniendo resultados guardados.';

  try {
    const response = await apiFetch('/api/reset-session', { method: 'POST' });
    const payload = await response.json();

    if (!response.ok) {
      throw new Error(payload.detail || payload.error || 'Error desconocido');
    }

    statusNode.textContent = 'Sesion reiniciada. Los resultados guardados se conservan hasta el proximo escaneo.';
    await refreshSessionStatus();
  } catch (error) {
    showError(error.message);
    statusNode.textContent = 'No se pudo reiniciar la sesion.';
  } finally {
    setBusyState(false);
  }
});

function buildShareUrl() {
  const url = new URL(window.location.href);
  url.searchParams.set('token', getUserToken());
  return url.toString();
}

function syncProfileShareFields() {
  tokenDisplay.value = getUserToken();
  shareLinkOutput.value = buildShareUrl();
}

syncProfileShareFields();
tokenDisplay.addEventListener('focus', () => tokenDisplay.select());
shareLinkOutput.addEventListener('focus', () => shareLinkOutput.select());

tokenApplyButton.addEventListener('click', () => {
  const val = tokenDisplay.value.trim();
  if (!/^[a-zA-Z0-9_-]{2,50}$/.test(val)) {
    shareLinkStatus.textContent = 'Token invalido. Usa solo letras, numeros, guiones y guiones bajos.';
    shareLinkStatus.style.color = 'var(--danger)';
    return;
  }
  localStorage.setItem('mlb_user_token', val);
  localStorage.removeItem(PROFILE_USERNAME_KEY);
  window.location.reload();
});

async function copyText(text) {
  if (navigator.clipboard?.writeText) {
    await navigator.clipboard.writeText(text);
    return true;
  }

  shareLinkOutput.focus();
  shareLinkOutput.select();
  return document.execCommand?.('copy') || false;
}

shareLinkButton.addEventListener('click', async () => {
  const shareUrl = buildShareUrl();
  shareLinkOutput.value = shareUrl;
  shareLinkOutput.focus();
  shareLinkOutput.select();

  try {
    const copied = await copyText(shareUrl);
    const original = shareLinkButton.textContent;
    shareLinkButton.textContent = copied ? 'Enlace copiado!' : 'Enlace seleccionado';
    shareLinkStatus.textContent = copied
      ? 'Enlace copiado. Abrelo en el celular para usar este mismo perfil.'
      : 'No se pudo copiar automaticamente. El enlace quedo seleccionado para copiarlo manualmente.';
    shareLinkStatus.style.color = 'var(--muted)';
    setTimeout(() => { shareLinkButton.textContent = original; }, 2000);
  } catch {
    shareLinkStatus.textContent = 'No se pudo copiar automaticamente. El enlace quedo seleccionado para copiarlo manualmente.';
    shareLinkStatus.style.color = 'var(--muted)';
  }
});

refreshProgramsButton.addEventListener('click', async () => {
  setBusyState(true);
  hideError();
  statusNode.textContent = 'Actualizando catalogo de programas...';
  scanDetailNode.textContent = 'Descubriendo programas y grupos disponibles.';
  const track = scanProgressBarNode.parentElement;
  track.classList.remove('indeterminate');
  scanProgressBarNode.style.width = '0%';
  scanProgressLabelNode.textContent = '0%';
  scanProgressLabelNode.classList.add('active');

  try {
    const startRes = await apiFetch('/api/programs/catalog/refresh', { method: 'POST' });
    const startPayload = await startRes.json();
    if (!startRes.ok) {
      throw new Error(startPayload.detail || startPayload.error || 'Error desconocido');
    }

    const finalState = await pollUntilDone(
      '/api/programs/catalog/refresh-status',
      1500,
      updateCatalogProgress
    );

    if (finalState.lastError) {
      throw new Error(finalState.lastError);
    }

    await refreshProgramCatalog(false);
    statusNode.textContent = 'Catalogo actualizado.';
    scanDetailNode.textContent = 'Programas disponibles para escanear.';
    showToast('Catalogo de programas actualizado.', 'success', 6000);
  } catch (error) {
    showError(error.message);
    statusNode.textContent = 'No se pudo actualizar el catalogo.';
    showToast(error.message, 'error', 0);
    scanDetailNode.textContent = error.message;
  } finally {
    track.classList.remove('indeterminate');
    scanProgressBarNode.style.width = '0%';
    scanProgressLabelNode.textContent = '—';
    scanProgressLabelNode.classList.remove('active');
    setBusyState(false);
  }
});

scanInventoryButton.addEventListener('click', async () => {
  setBusyState(true);
  hideError();
  statusNode.textContent = 'Leyendo inventario de cartas...';
  startInventoryStatusPolling();

  try {
    const startRes = await apiFetch('/api/inventory/scan', { method: 'POST' });
    const startPayload = await startRes.json();
    if (!startRes.ok) {
      throw new Error(startPayload.detail || startPayload.error || 'Error desconocido');
    }

    const finalState = await pollUntilDone(
      '/api/inventory/scan-status',
      1500,
      (st) => {
        scanDetailNode.textContent = `Leyendo inventario · Pagina ${st.pagesScanned} · ${st.cardsFound} cartas encontradas`;
      }
    );

    if (finalState.lastError) {
      throw new Error(finalState.lastError);
    }

    await loadInventory();
    await loadLastScan();
    statusNode.textContent = 'Inventario actualizado.';
    showToast(`Inventario actualizado: ${finalState.cardsFound || 0} cartas encontradas.`, 'success', 7000);
  } catch (error) {
    showError(error.message);
    statusNode.textContent = 'No se pudo leer el inventario.';
    showToast(error.message, 'error', 0);
  } finally {
    stopInventoryStatusPolling();
    setBusyState(false);
  }
});

selectAllButton.addEventListener('click', () => {
  programSelectorNode.querySelectorAll('input[type="checkbox"]').forEach((input) => {
    input.checked = true;
    selectedProgramUrls.add(input.value);
  });
});

clearSelectionButton.addEventListener('click', () => {
  programSelectorNode.querySelectorAll('input[type="checkbox"]').forEach((input) => {
    input.checked = false;
  });
  selectedProgramUrls.clear();
});

async function loadLastScan() {
  const response = await apiFetch('/api/last-scan');
  const payload = await response.json();
  applyScanPayload(payload);
}

async function loadInventory() {
  const response = await apiFetch('/api/inventory');
  const payload = await response.json();
  inventoryPayload = payload;
  renderInventorySummary(payload);
}

async function refreshSessionStatus() {
  try {
    const response = await apiFetch('/api/session-status');
    const payload = await response.json();

    if (!response.ok) {
      throw new Error(payload.detail || payload.error || 'Error desconocido');
    }

    if (payload.suggestedUserId) {
      const current = localStorage.getItem('mlb_user_token');
      if (payload.suggestedUserId !== current) {
        localStorage.setItem('mlb_user_token', payload.suggestedUserId);
        window.location.reload();
        return;
      }
    }

    if (!payload.hasSavedAuthState) {
      sessionStateNode.textContent = 'No existe auth_state.json';
      sessionCheckedAtNode.textContent = formatDate(payload.checkedAt) || 'Pendiente';
      return;
    }

    sessionStateNode.textContent = payload.authenticated ? 'Activa' : 'Vencida o invalida';
    sessionCheckedAtNode.textContent = formatDate(payload.checkedAt) || 'Sin fecha';
  } catch (error) {
    sessionStateNode.textContent = 'No se pudo verificar';
    sessionCheckedAtNode.textContent = 'Error';
  }
}

async function refreshProgramCatalog() {
  const response = await apiFetch('/api/programs/catalog');
  const payload = await response.json();

  if (!response.ok) {
    throw new Error(payload.detail || payload.error || 'Error desconocido');
  }

  const lastScanResponse = await apiFetch('/api/last-scan');
  const lastScanPayload = await lastScanResponse.json();
  programCatalog = payload.programs?.length ? payload.programs : lastScanPayload.catalogPrograms || [];
  const availableUrls = new Set(programCatalog.map((program) => program.url));
  selectedProgramUrls = new Set(Array.from(selectedProgramUrls).filter((url) => availableUrls.has(url)));

  renderProgramSelector(programCatalog);
}

async function pollUntilDone(statusUrl, intervalMs, onTick, maxNetworkErrors = 6) {
  return new Promise((resolve, reject) => {
    let networkErrors = 0;
    const timer = setInterval(async () => {
      try {
        const response = await apiFetch(statusUrl);
        const state = await response.json();
        networkErrors = 0;
        if (onTick) onTick(state);
        if (!state.active && state.completedAt) {
          clearInterval(timer);
          resolve(state);
        }
      } catch (err) {
        networkErrors++;
        if (networkErrors >= maxNetworkErrors) {
          clearInterval(timer);
          reject(new Error('No se pudo contactar el servidor despues de varios intentos. Verifica tu conexion.'));
        }
      }
    }, intervalMs);
  });
}

function applyScanPayload(payload) {
  const missions = payload?.missions || [];
  const catalogPrograms = payload?.catalogPrograms || [];
  if (payload?.inventory) {
    inventoryPayload = payload.inventory;
    renderInventorySummary(payload.inventory);
  }

  missionTotalNode.textContent = String(payload?.total || missions.length || 0);
  scanTimeNode.textContent = payload?.scannedAt ? formatDate(payload.scannedAt) : 'Todavia no ejecutado';

  if (catalogPrograms.length) {
    programCatalog = catalogPrograms;
    const availableUrls = new Set(programCatalog.map((program) => program.url));
    selectedProgramUrls = new Set(Array.from(selectedProgramUrls).filter((url) => availableUrls.has(url)));
    renderProgramSelector(programCatalog);
  }

  renderMissionGroups(missions);
}

function renderProgramSelector(programs) {
  if (!programs.length) {
    programSelectorNode.innerHTML = '<p class="selector-empty">Aun no hay programas descubiertos.</p>';
    return;
  }

  groupedCatalogCache = groupCatalogPrograms(programs);

  programSelectorNode.innerHTML = groupedCatalogCache
    .map((group, groupIndex) => `
      <details class="selector-group" data-group-index="${groupIndex}">
        <summary class="selector-group-header">
          <h3>${escapeHtml(group.topGroup)}</h3>
        </summary>
        <div class="selector-group-body"></div>
      </details>
    `)
    .join('');

  programSelectorNode.querySelectorAll('.selector-group').forEach((details) => {
    details.addEventListener('toggle', () => {
      if (!details.open) {
        return;
      }

      const body = details.querySelector('.selector-group-body');
      if (body.dataset.rendered === '1') {
        return;
      }

      const group = groupedCatalogCache[Number(details.dataset.groupIndex)];
      body.innerHTML = group.subGroups.map((subGroup, subGroupIndex) => `
        <details class="selector-subgroup" data-group-index="${details.dataset.groupIndex}" data-subgroup-index="${subGroupIndex}">
          <summary class="selector-subgroup-title">${escapeHtml(subGroup.name)}</summary>
          <div class="selector-subgroup-body"></div>
        </details>
      `).join('');
      body.dataset.rendered = '1';

      body.querySelectorAll('.selector-subgroup').forEach((subDetails) => {
        subDetails.addEventListener('toggle', () => {
          if (!subDetails.open) {
            return;
          }

          const subBody = subDetails.querySelector('.selector-subgroup-body');
          if (subBody.dataset.rendered === '1') {
            return;
          }

          const renderedGroup = groupedCatalogCache[Number(subDetails.dataset.groupIndex)];
          const subGroup = renderedGroup.subGroups[Number(subDetails.dataset.subgroupIndex)];
          subBody.innerHTML = `
            <div class="selector-grid">
              ${subGroup.programs.map((program) => `
                <label class="program-option">
                  <input
                    type="checkbox"
                    value="${escapeHtml(program.url)}"
                    ${selectedProgramUrls.has(program.url) ? 'checked' : ''}
                  />
                  <span>${escapeHtml(program.title || 'Programa sin titulo')}</span>
                </label>
              `).join('')}
            </div>
          `;
          subBody.dataset.rendered = '1';

          subBody.querySelectorAll('input[type="checkbox"]').forEach((input) => {
            input.addEventListener('change', () => {
              if (input.checked) {
                selectedProgramUrls.add(input.value);
              } else {
                selectedProgramUrls.delete(input.value);
              }
            });
          });
        });
      });
    });
  });
}

function getSelectedProgramUrls() {
  return Array.from(selectedProgramUrls);
}

function renderMissionGroups(missions) {
  if (!missions.length) {
    missionsGroupsNode.innerHTML = '<div class="empty-state">No hay objetivos guardados todavia.</div>';
    return;
  }

  groupedMissionCache = groupMissionsHierarchy(missions);

  missionsGroupsNode.innerHTML = groupedMissionCache
    .map((topGroup, topGroupIndex) => `
      <details class="result-top-group" data-top-group-index="${topGroupIndex}">
        <summary class="result-top-group-header">
          <h3>${escapeHtml(topGroup.name)}</h3>
        </summary>
        <div class="result-top-group-body"></div>
      </details>
    `)
    .join('');

  missionsGroupsNode.querySelectorAll('.result-top-group').forEach((details) => {
    details.addEventListener('toggle', () => {
      if (!details.open) {
        return;
      }

      const body = details.querySelector('.result-top-group-body');
      if (body.dataset.rendered === '1') {
        return;
      }

      const topGroup = groupedMissionCache[Number(details.dataset.topGroupIndex)];
      body.innerHTML = topGroup.subGroups.map((subGroup, subGroupIndex) => `
        <details class="program-subgroup" data-top-group-index="${details.dataset.topGroupIndex}" data-subgroup-index="${subGroupIndex}">
          <summary class="program-subgroup-header">
            <h4>${escapeHtml(subGroup.name)}</h4>
          </summary>
          <div class="program-subgroup-body"></div>
        </details>
      `).join('');
      body.dataset.rendered = '1';

      body.querySelectorAll('.program-subgroup').forEach((subDetails) => {
        subDetails.addEventListener('toggle', () => {
          if (!subDetails.open) {
            return;
          }

          const subBody = subDetails.querySelector('.program-subgroup-body');
          if (subBody.dataset.rendered === '1') {
            return;
          }

          const renderedTopGroup = groupedMissionCache[Number(subDetails.dataset.topGroupIndex)];
          const subGroup = renderedTopGroup.subGroups[Number(subDetails.dataset.subgroupIndex)];
          subBody.innerHTML = subGroup.programs.map((program, programIndex) => `
            <details class="program-group" data-top-group-index="${subDetails.dataset.topGroupIndex}" data-subgroup-index="${subDetails.dataset.subgroupIndex}" data-program-index="${programIndex}">
              <summary class="program-group-header">
                <div>
                  <h3>${escapeHtml(program.programTitle)}</h3>
                  <p>${program.missions.length} mision(es)</p>
                </div>
                <span class="status-badge ${program.status === 'updated' ? 'status-updated' : 'status-stale'}">
                  ${program.status === 'updated' ? 'Actualizadas' : 'Sin actualizar'}
                </span>
              </summary>
              <div class="program-group-body"></div>
            </details>
          `).join('');
          subBody.dataset.rendered = '1';

          subBody.querySelectorAll('.program-group').forEach((programDetails) => {
            programDetails.addEventListener('toggle', () => {
              if (!programDetails.open) {
                return;
              }

              const programBody = programDetails.querySelector('.program-group-body');
              if (programBody.dataset.rendered === '1') {
                return;
              }

              const groupedTop = groupedMissionCache[Number(programDetails.dataset.topGroupIndex)];
              const groupedSub = groupedTop.subGroups[Number(programDetails.dataset.subgroupIndex)];
              const program = groupedSub.programs[Number(programDetails.dataset.programIndex)];
              programBody.innerHTML = renderObjectiveGroups(program.missions);
              programBody.dataset.rendered = '1';

              programBody.querySelectorAll('.objective-group').forEach((objectiveDetails) => {
                objectiveDetails.addEventListener('toggle', () => {
                  if (!objectiveDetails.open) {
                    return;
                  }

                  const objectiveBody = objectiveDetails.querySelector('.objective-group-body');
                  if (objectiveBody.dataset.rendered === '1') {
                    return;
                  }

                  const objectiveMissions = JSON.parse(objectiveBody.dataset.missions);
                  objectiveBody.innerHTML = `
                    <div class="group-table-wrap">
                      <table>
                        <thead>
                          <tr>
                            <th>Mision</th>
                            <th>Requisito</th>
                            <th>Donde jugar</th>
                            <th>Avance</th>
                            <th>Sugerencia</th>
                          </tr>
                        </thead>
                        <tbody>
                          ${objectiveMissions.map(renderMissionRow).join('')}
                        </tbody>
                      </table>
                    </div>
                  `;
                  objectiveBody.dataset.rendered = '1';
                });
              });
            });
          });
        });
      });
    });
  });
}

function renderObjectiveGroups(missions) {
  const grouped = groupProgramMissionsByObjective(missions);

  return grouped.map((group) => `
    <details class="objective-group">
      <summary class="objective-group-header">
        <strong>${escapeHtml(group.name)}</strong>
        <span>${group.missions.length} objetivo(s)</span>
      </summary>
      <div class="objective-group-body" data-missions="${escapeHtml(JSON.stringify(group.missions))}"></div>
    </details>
  `).join('');
}

function renderMissionRow(mission) {
  const target = mission.target || 0;
  const current = mission.current || 0;
  const percent = target > 0 ? Math.min(100, Math.round((current / target) * 100)) : 0;
  const suggestionDetails = renderSuggestionDetails(mission);

  return `
    <tr>
      <td data-label="Mision"><div class="mission-name">${escapeHtml(mission.name)}</div></td>
      <td data-label="Requisito">${escapeHtml(mission.description || '')}</td>
      <td data-label="Donde jugar">${escapeHtml(mission.whereToPlay || '')}</td>
      <td data-label="Avance">
        <div class="progress-cell">
          <div class="progress-bar">
            <span style="width: ${percent}%"></span>
          </div>
          <div class="progress-cell-info">
            <strong>${percent}%</strong>
            <span class="progress-fraction">${current} / ${target}</span>
          </div>
        </div>
      </td>
      <td data-label="Sugerencia">${escapeHtml(mission.suggestion || '')}</td>
    </tr>
    ${suggestionDetails}
  `;
}

function renderCrossProgramHints(mission) {
  const hints = Array.isArray(mission.crossProgramHints) ? mission.crossProgramHints : [];
  if (!hints.length) return '';
  return `
    <div class="cross-program-hints">
      <strong>Avanza en paralelo:</strong>
      <div class="cross-hint-list">
        ${hints.map((h) => `
          <span class="cross-hint-chip">
            <span class="cross-hint-program">${escapeHtml(h.programTitle)}</span>
            <span class="cross-hint-sep">›</span>
            <span class="cross-hint-mission">${escapeHtml(h.missionName)}</span>
          </span>
        `).join('')}
      </div>
    </div>
  `;
}

function renderSuggestionDetails(mission) {
  const cardsMarkup = renderCardSuggestions(mission);
  const crossHintsMarkup = renderCrossProgramHints(mission);
  if (!cardsMarkup && !crossHintsMarkup) return '';
  return `
    <tr class="suggestion-detail-row">
      <td colspan="5">
        ${crossHintsMarkup}
        ${cardsMarkup}
      </td>
    </tr>
  `;
}

function renderCardSuggestions(mission) {
  const cards = Array.isArray(mission.recommendedCards) ? mission.recommendedCards : [];
  if (!cards.length) {
    return '';
  }

  return `
    <div class="card-suggestions">
      <strong>Cartas sugeridas:</strong>
      <div class="card-chip-row">
        ${cards.map((card) => `
          <span class="card-chip">
            ${escapeHtml(card.name)}
            ${card.position ? ` (${escapeHtml(card.position)})` : ''}
            ${card.series ? ` - ${escapeHtml(card.series)}` : ''}
            ${card.overlapCount > 1 ? ` - cruza ${card.overlapCount} misiones` : ''}
          </span>
        `).join('')}
      </div>
    </div>
  `;
}

function renderInventorySummary(payload) {
  inventoryTimeNode.textContent = payload?.scannedAt ? formatDate(payload.scannedAt) : 'Todavia no ejecutado';
  inventoryTotalNode.textContent = String(payload?.total || payload?.cards?.length || 0);
}

function groupCatalogPrograms(programs) {
  const topGroupMap = new Map();

  for (const program of programs) {
    const topGroup = program.topGroup || 'Programs';
    const subGroup = program.subGroup || 'General';

    if (!topGroupMap.has(topGroup)) {
      topGroupMap.set(topGroup, new Map());
    }

    const subGroupMap = topGroupMap.get(topGroup);
    if (!subGroupMap.has(subGroup)) {
      subGroupMap.set(subGroup, []);
    }

    subGroupMap.get(subGroup).push(program);
  }

  return Array.from(topGroupMap.entries())
    .map(([topGroup, subGroupMap]) => ({
      topGroup,
      subGroups: Array.from(subGroupMap.entries())
        .map(([name, groupedPrograms]) => ({
          name,
          programs: groupedPrograms.sort((a, b) => a.title.localeCompare(b.title)),
        }))
        .sort((a, b) => a.name.localeCompare(b.name)),
    }))
    .sort((a, b) => a.topGroup.localeCompare(b.topGroup));
}

function groupMissionsHierarchy(missions) {
  const topGroupMap = new Map();

  for (const mission of missions) {
    const topGroup = mission.topGroup || 'Programs';
    const subGroup = mission.subGroup || 'General';
    const programTitle = mission.programTitle || 'Programa sin titulo';

    if (!topGroupMap.has(topGroup)) {
      topGroupMap.set(topGroup, new Map());
    }

    const subGroupMap = topGroupMap.get(topGroup);
    if (!subGroupMap.has(subGroup)) {
      subGroupMap.set(subGroup, new Map());
    }

    const programMap = subGroupMap.get(subGroup);
    if (!programMap.has(programTitle)) {
      programMap.set(programTitle, {
        programTitle,
        missions: [],
        status: 'updated',
      });
    }

    const programGroup = programMap.get(programTitle);
    programGroup.missions.push(mission);
    if (mission.scanStatus === 'stale') {
      programGroup.status = 'stale';
    }
  }

  return Array.from(topGroupMap.entries())
    .map(([name, subGroupMap]) => ({
      name,
      subGroups: Array.from(subGroupMap.entries())
        .map(([subName, programMap]) => ({
          name: subName,
          programs: Array.from(programMap.values()).sort((a, b) => a.programTitle.localeCompare(b.programTitle)),
        }))
        .sort((a, b) => a.name.localeCompare(b.name)),
    }))
    .sort((a, b) => a.name.localeCompare(b.name));
}

function groupProgramMissionsByObjective(missions) {
  const objectiveMap = new Map();

  for (const mission of missions) {
    const objectiveGroup = mission.objectiveGroup || 'General';

    if (!objectiveMap.has(objectiveGroup)) {
      objectiveMap.set(objectiveGroup, []);
    }

    objectiveMap.get(objectiveGroup).push(mission);
  }

  return Array.from(objectiveMap.entries())
    .map(([name, groupedMissions]) => ({
      name,
      missions: groupedMissions.sort((a, b) => a.name.localeCompare(b.name)),
    }))
    .sort((a, b) => a.name.localeCompare(b.name));
}

function setBusyState(isLoading) {
  importButton.disabled = isLoading;
  importBodyButton.disabled = isLoading;
  clearImportButton.disabled = isLoading;
  scanButton.disabled = isLoading;
  resetButton.disabled = isLoading;
  refreshProgramsButton.disabled = isLoading;
  scanInventoryButton.disabled = isLoading;
  selectAllButton.disabled = isLoading;
  clearSelectionButton.disabled = isLoading;
  sessionInput.disabled = isLoading;
  cancelScanButton.disabled = !isLoading;
  programSelectorNode.querySelectorAll('input').forEach((input) => {
    input.disabled = isLoading;
  });
  scanButton.textContent = isLoading ? 'Procesando...' : 'Escanear programas';
}

function startScanStatusPolling(scanJustStarted = false) {
  stopScanStatusPolling();
  waitingForScanCompletion = scanJustStarted;
  updateScanProgress({ active: true, percent: 0, phase: 'starting', totalPrograms: 0, completedPrograms: 0, currentProgramTitle: '' });
  scanStatusTimer = setInterval(refreshScanStatus, 1200);
  refreshScanStatus();
}

function stopScanStatusPolling() {
  if (scanStatusTimer) {
    clearInterval(scanStatusTimer);
    scanStatusTimer = null;
  }
  waitingForScanCompletion = false;
  scanProgressBarNode.parentElement.classList.remove('indeterminate');
  scanProgressBarNode.style.width = '0%';
  scanProgressLabelNode.textContent = '—';
}

function startInventoryStatusPolling() {
  stopInventoryStatusPolling();
  const track = scanProgressBarNode.parentElement;
  track.classList.add('indeterminate');
  scanProgressLabelNode.textContent = '...';
  scanProgressLabelNode.classList.add('active');
  scanDetailNode.textContent = 'Iniciando escaneo de inventario...';
  inventoryStatusTimer = setInterval(refreshInventoryStatus, 1500);
}

function stopInventoryStatusPolling() {
  if (inventoryStatusTimer) {
    clearInterval(inventoryStatusTimer);
    inventoryStatusTimer = null;
  }
  scanProgressBarNode.parentElement.classList.remove('indeterminate');
  scanProgressBarNode.style.width = '0%';
  scanProgressLabelNode.textContent = '—';
  scanProgressLabelNode.classList.remove('active');
}

async function refreshInventoryStatus() {
  try {
    const response = await apiFetch('/api/inventory/scan-status');
    const payload = await response.json();
    if (!payload?.active) return;
    scanDetailNode.textContent = `Leyendo inventario · Pagina ${payload.pagesScanned || 0} · ${payload.cardsFound || 0} cartas encontradas`;
  } catch {
    // Ignore transient polling errors.
  }
}

async function refreshScanStatus() {
  try {
    const response = await apiFetch('/api/scan/status');
    const payload = await response.json();
    updateScanProgress(payload);

    if (waitingForScanCompletion && !payload.active && payload.completedAt) {
      const completedAfterStart = !currentScanStartedAt || new Date(payload.completedAt) >= new Date(currentScanStartedAt) - 5000;
      if (completedAfterStart) {
        waitingForScanCompletion = false;
        stopScanStatusPolling();
        setBusyState(false);

        if (payload.lastError) {
          showError(payload.lastError);
          const isSoftWarning = payload.lastError.includes('detenido') || payload.lastError.includes('expiro');
          statusNode.textContent = isSoftWarning ? 'Escaneo finalizado con avisos.' : 'El escaneo fallo.';
          if (!isSoftWarning) {
            scanDetailNode.textContent = payload.lastError;
          }
          showToast(payload.lastError, isSoftWarning ? 'warning' : 'error', isSoftWarning ? 8000 : 0);
        } else {
          statusNode.textContent = 'Escaneo completado.';
          showToast('Escaneo completado correctamente.', 'success', 8000);
        }

        await loadLastScan();
        await refreshSessionStatus();
      }
    }
  } catch {
    // Ignore transient polling errors.
  }
}

function updateCatalogProgress(payload) {
  const percent = Math.max(0, Math.min(100, Number(payload?.percent) || 0));
  const track = scanProgressBarNode.parentElement;
  track.classList.remove('indeterminate');
  scanProgressBarNode.style.width = `${percent}%`;
  scanProgressLabelNode.textContent = payload?.active ? `${percent}%` : '—';

  if (payload?.active) {
    scanProgressLabelNode.classList.add('active');
  } else {
    scanProgressLabelNode.classList.remove('active');
  }

  const phaseMap = {
    starting: 'Iniciando actualizacion del catalogo...',
    navigating: 'Abriendo la pagina de programas...',
    discovering: 'Descubriendo grupos y programas...',
    'hydrating-titles': 'Resolviendo nombres de programas...',
    saving: 'Guardando catalogo actualizado...',
    idle: 'Catalogo listo.',
  };

  const phaseText = phaseMap[payload?.phase] || 'Actualizando catalogo...';
  const discoveryText = payload?.totalDiscoveryPages
    ? `${payload.visitedDiscoveryPages || 0} de ${payload.totalDiscoveryPages} paginas`
    : '';
  const programsText = payload?.totalPrograms
    ? `${payload.hydratedPrograms || 0} de ${payload.totalPrograms} nombres`
    : `${payload?.discoveredPrograms || 0} programas encontrados`;

  scanDetailNode.textContent = [phaseText, discoveryText, programsText].filter(Boolean).join(' · ');
}

function updateScanProgress(payload) {
  const percent = Number(payload?.percent) || 0;
  const track = scanProgressBarNode.parentElement;
  const isDiscovering = payload?.active && percent === 0;

  if (!payload?.active && !scanStatusTimer) {
    track.classList.remove('indeterminate');
    scanProgressBarNode.style.width = '0%';
    scanProgressLabelNode.textContent = '—';
    scanProgressLabelNode.classList.remove('active');
    scanDetailNode.textContent = 'Todavia no hay un escaneo en progreso.';
    return;
  }

  if (isDiscovering) {
    track.classList.add('indeterminate');
    scanProgressLabelNode.textContent = '...';
    scanProgressLabelNode.classList.add('active');
  } else {
    track.classList.remove('indeterminate');
    scanProgressBarNode.style.width = `${percent}%`;
    scanProgressLabelNode.textContent = payload?.active ? `${percent}%` : '—';
    if (payload?.active) {
      scanProgressLabelNode.classList.add('active');
    } else {
      scanProgressLabelNode.classList.remove('active');
    }
  }

  if (!payload?.active) {
    return;
  }

  const phaseMap = {
    'starting': 'Iniciando escaneo...',
    'validating-session': 'Validando sesion guardada...',
    'discovering-programs': 'Descubriendo programas y resolviendo nombres...',
    'scanning-programs': 'Leyendo objetivos de los programas seleccionados...',
    'finalizing-results': 'Guardando resultados y cruzando inventario...',
  };

  const phaseText = phaseMap[payload.phase] || 'Escaneando...';
  const progressText = payload.totalPrograms
    ? `${payload.completedPrograms || 0} de ${payload.totalPrograms} programas`
    : 'Preparando lista de programas';
  const currentText = payload.currentProgramTitle ? `Actual: ${payload.currentProgramTitle}` : '';

  scanDetailNode.textContent = [phaseText, progressText, currentText].filter(Boolean).join(' · ');
}

function showError(message) {
  errorBanner.textContent = message;
  errorBanner.classList.remove('hidden');
}

function hideError() {
  errorBanner.textContent = '';
  errorBanner.classList.add('hidden');
}

function formatDate(value) {
  if (!value) {
    return '';
  }

  return new Date(value).toLocaleString('es-CL');
}

function escapeHtml(value) {
  return String(value)
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&#39;');
}

// ── Modulo de analisis estrategico con IA ──────────────────────────────────

async function runAiSuggest() {
  aiSuggestButton.disabled = true;
  aiRegenerateButton.disabled = true;
  aiSuggestButton.textContent = 'Analizando...';
  hideError();

  const track = scanProgressBarNode.parentElement;
  track.classList.add('indeterminate');
  scanProgressLabelNode.textContent = 'IA';
  scanProgressLabelNode.classList.add('active');
  statusNode.textContent = 'La IA esta analizando tus objetivos...';
  scanDetailNode.textContent = 'Cruzando requisitos, modos de juego e inventario. Esto puede tardar 10-20 segundos.';

  aiPanel.classList.remove('hidden');
  aiResultsNode.innerHTML = '<div class="ai-loading"><span class="ai-loading-dot"></span><span class="ai-loading-dot"></span><span class="ai-loading-dot"></span></div>';
  aiSummaryBlock.classList.add('hidden');
  aiPanel.scrollIntoView({ behavior: 'smooth', block: 'start' });

  try {
    const response = await apiFetch('/api/ai-suggest', { method: 'POST' });
    const payload = await response.json();

    if (!response.ok) {
      throw new Error(payload.detail || payload.error || 'Error desconocido');
    }

    renderAiRecommendations(payload);
    statusNode.textContent = `Analisis completado. ${payload.missionsAnalyzed} objetivos · ${payload.cardsProvided} cartas analizadas.`;
    scanDetailNode.textContent = formatDate(payload.analyzedAt);
  } catch (error) {
    showError(error.message);
    statusNode.textContent = 'No se pudo completar el analisis de IA.';
    aiResultsNode.innerHTML = `<div class="ai-error"><p>${escapeHtml(error.message)}</p></div>`;
  } finally {
    track.classList.remove('indeterminate');
    scanProgressBarNode.style.width = '0%';
    scanProgressLabelNode.textContent = '—';
    scanProgressLabelNode.classList.remove('active');
    aiSuggestButton.disabled = false;
    aiRegenerateButton.disabled = false;
    aiSuggestButton.textContent = 'Analizar objetivos con IA';
  }
}

aiSuggestButton.addEventListener('click', runAiSuggest);
aiRegenerateButton.addEventListener('click', runAiSuggest);

function renderAiRecommendations(payload) {
  const recommendations = Array.isArray(payload.recommendations) ? payload.recommendations : [];
  const bestModes = Array.isArray(payload.best_overall_modes) ? payload.best_overall_modes : [];
  const summary = payload.summary || '';

  if (summary) {
    aiSummaryBlock.innerHTML = `
      <div class="ai-summary-inner">
        <strong class="ai-summary-label">Resumen estrategico</strong>
        <p class="ai-summary-text">${escapeHtml(summary)}</p>
        ${bestModes.length ? `
          <div class="ai-summary-modes">
            <span class="ai-field-label">Mejores modos globales:</span>
            ${bestModes.map((mode) => `<span class="ai-mode-chip">${escapeHtml(mode)}</span>`).join('')}
          </div>
        ` : ''}
      </div>
    `;
    aiSummaryBlock.classList.remove('hidden');
  }

  if (!recommendations.length) {
    aiResultsNode.innerHTML = '<div class="ai-empty">No se encontraron combinaciones estrategicas. Intenta escanear mas programas.</div>';
    return;
  }

  aiResultsNode.innerHTML = recommendations.map((rec, index) => renderAiRecommendationCard(rec, index + 1)).join('');
}

function renderAiRecommendationCard(rec, index) {
  const missions = Array.isArray(rec.missions_covered) ? rec.missions_covered : [];
  const programs = Array.isArray(rec.programs) ? rec.programs : [];
  const modes = Array.isArray(rec.best_modes) ? rec.best_modes : [];
  const cards = Array.isArray(rec.recommended_cards) ? rec.recommended_cards : [];
  const strategy = rec.strategy || '';

  const inventoryCards = cards.filter((c) => c.in_inventory);
  const suggestedCards = cards.filter((c) => !c.in_inventory);

  return `
    <div class="ai-rec-card">
      <div class="ai-rec-header">
        <div class="ai-rec-badge">${index}</div>
        <div class="ai-rec-meta">
          <div class="ai-rec-programs">
            ${programs.map((p) => `<span class="ai-program-chip">${escapeHtml(p)}</span>`).join('')}
          </div>
          <div class="ai-rec-modes">
            ${modes.map((m) => `<span class="ai-mode-chip">${escapeHtml(m)}</span>`).join('')}
          </div>
        </div>
        <div class="ai-rec-count">${missions.length} objetivo${missions.length !== 1 ? 's' : ''}</div>
      </div>

      ${strategy ? `
        <div class="ai-strategy">
          <span class="ai-field-label">Estrategia</span>
          <p>${escapeHtml(strategy)}</p>
        </div>
      ` : ''}

      <div class="ai-missions-list">
        <span class="ai-field-label">Objetivos cubiertos</span>
        <ul>
          ${missions.map((m) => `<li>${escapeHtml(m)}</li>`).join('')}
        </ul>
      </div>

      ${inventoryCards.length ? `
        <div class="ai-cards-section">
          <span class="ai-field-label ai-field-label-owned">Cartas en tu inventario</span>
          <div class="ai-card-list">
            ${inventoryCards.map((card) => renderAiCard(card, true)).join('')}
          </div>
        </div>
      ` : ''}

      ${suggestedCards.length ? `
        <div class="ai-cards-section">
          <span class="ai-field-label ai-field-label-missing">Cartas a conseguir</span>
          <div class="ai-card-list">
            ${suggestedCards.map((card) => renderAiCard(card, false)).join('')}
          </div>
        </div>
      ` : ''}
    </div>
  `;
}

function renderAiCard(card, owned) {
  const overlapLabel = card.covers_missions_count > 1
    ? `<span class="ai-card-overlap">cubre ${card.covers_missions_count} objetivos</span>`
    : '';

  return `
    <div class="ai-card-row ${owned ? 'ai-card-owned' : 'ai-card-missing'}">
      <div class="ai-card-indicator">${owned ? '✓' : '+'}</div>
      <div class="ai-card-info">
        <strong class="ai-card-name">${escapeHtml(card.name || '')}</strong>
        <span class="ai-card-attrs">
          ${card.overall ? `${card.overall} OVR` : ''}
          ${card.position ? ` · ${escapeHtml(card.position)}` : ''}
          ${card.team ? ` · ${escapeHtml(card.team)}` : ''}
          ${card.series ? ` · ${escapeHtml(card.series)}` : ''}
        </span>
        ${overlapLabel}
        ${card.reason ? `<span class="ai-card-reason">${escapeHtml(card.reason)}</span>` : ''}
      </div>
    </div>
  `;
}
