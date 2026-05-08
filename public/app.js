const importButton = document.getElementById('import-button');
const scanButton = document.getElementById('scan-button');
const cancelScanButton = document.getElementById('cancel-scan-button');
const resetButton = document.getElementById('reset-button');
const refreshProgramsButton = document.getElementById('refresh-programs-button');
const scanInventoryButton = document.getElementById('scan-inventory-button');
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

let programCatalog = [];
let selectedProgramUrls = new Set();
let inventoryPayload = { scannedAt: null, total: 0, cards: [] };
let scanStatusTimer = null;
let groupedCatalogCache = [];
let groupedMissionCache = [];
cancelScanButton.disabled = true;

function getUserToken() {
  let token = localStorage.getItem('mlb_user_token');
  if (!token || !/^[a-zA-Z0-9_-]{2,50}$/.test(token)) {
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
  return fetch(url, {
    ...options,
    headers: {
      ...options.headers,
      'X-User-Token': getUserToken(),
    },
  });
}

bootstrap();

async function bootstrap() {
  await Promise.all([refreshSessionStatus(), loadLastScan(), refreshProgramCatalog(false), loadInventory()]);
}

importButton.addEventListener('click', async () => {
  setBusyState(true);
  hideError();
  statusNode.textContent = 'Importando la sesion pegada en auth_state.json...';
  scanDetailNode.textContent = 'Guardando cookies en auth_state.json...';

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
    await Promise.all([refreshSessionStatus(), refreshProgramCatalog()]);
  } catch (error) {
    showError(error.message);
    statusNode.textContent = 'No se pudo importar la sesion.';
  } finally {
    setBusyState(false);
  }
});

scanButton.addEventListener('click', async () => {
  setBusyState(true);
  hideError();
  statusNode.textContent = 'Reutilizando la sesion guardada y escaneando programas...';
  scanDetailNode.textContent = 'Preparando el escaneo de programas seleccionados...';
  startScanStatusPolling();

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

    applyScanPayload(payload);
    statusNode.textContent = payload.cancelled
      ? 'Escaneo detenido. Se guardaron los objetivos encontrados hasta ese momento.'
      : payload.sessionExpired
      ? 'Escaneo parcial completado. La sesion expiro antes de terminar.'
      : 'Escaneo completado.';

    if (payload.sessionExpired) {
      showError('La sesion se cerro durante el escaneo. Se muestran los objetivos encontrados hasta ese momento.');
    }

    if (payload.cancelled) {
      showError('El escaneo fue detenido por el usuario. Se muestran los resultados parciales guardados.');
    }

    await refreshSessionStatus();
  } catch (error) {
    showError(error.message);
    statusNode.textContent = 'El escaneo fallo.';
    scanDetailNode.textContent = error.message;
    await refreshSessionStatus();
  } finally {
    stopScanStatusPolling();
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

refreshProgramsButton.addEventListener('click', async () => {
  setBusyState(true);
  hideError();
  statusNode.textContent = 'Actualizando catalogo de programas...';
  scanDetailNode.textContent = 'Descubriendo programas y grupos disponibles.';

  try {
    await refreshProgramCatalog(true);
    statusNode.textContent = 'Catalogo actualizado.';
  } catch (error) {
    showError(error.message);
    statusNode.textContent = 'No se pudo actualizar el catalogo.';
  } finally {
    setBusyState(false);
  }
});

scanInventoryButton.addEventListener('click', async () => {
  setBusyState(true);
  hideError();
  statusNode.textContent = 'Leyendo inventario de cartas...';
  scanDetailNode.textContent = 'Recorriendo tu inventario y guardando cartas detectadas.';

  try {
    const response = await apiFetch('/api/inventory/scan', { method: 'POST' });
    const payload = await response.json();

    if (!response.ok) {
      throw new Error(payload.detail || payload.error || 'Error desconocido');
    }

    inventoryPayload = payload;
    renderInventorySummary(payload);
    await loadLastScan();
    statusNode.textContent = 'Inventario actualizado.';
  } catch (error) {
    showError(error.message);
    statusNode.textContent = 'No se pudo leer el inventario.';
  } finally {
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

async function refreshProgramCatalog(forceRefresh = false) {
  const response = await apiFetch(`/api/programs/catalog${forceRefresh ? '?refresh=1' : ''}`);
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
                            <th>Progreso</th>
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
      <td><div class="mission-name">${escapeHtml(mission.name)}</div></td>
      <td>${escapeHtml(mission.description || '')}</td>
      <td>${escapeHtml(mission.whereToPlay || '')}</td>
      <td>${current} / ${target}</td>
      <td>
        <div class="progress-cell">
          <div class="progress-bar">
            <span style="width: ${percent}%"></span>
          </div>
          <strong>${percent}%</strong>
        </div>
      </td>
      <td>${escapeHtml(mission.suggestion || '')}</td>
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
      <td colspan="6">
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

function startScanStatusPolling() {
  stopScanStatusPolling();
  updateScanProgress({ active: true, percent: 0, phase: 'starting', totalPrograms: 0, completedPrograms: 0, currentProgramTitle: '' });
  scanStatusTimer = setInterval(refreshScanStatus, 1200);
  refreshScanStatus();
}

function stopScanStatusPolling() {
  if (scanStatusTimer) {
    clearInterval(scanStatusTimer);
    scanStatusTimer = null;
  }
  scanProgressBarNode.parentElement.classList.remove('indeterminate');
  scanProgressBarNode.style.width = '0%';
  scanProgressLabelNode.textContent = '0%';
}

async function refreshScanStatus() {
  try {
    const response = await apiFetch('/api/scan/status');
    const payload = await response.json();
    updateScanProgress(payload);
  } catch {
    // Ignore transient polling errors while the main request is still running.
  }
}

function updateScanProgress(payload) {
  const percent = Number(payload?.percent) || 0;
  const track = scanProgressBarNode.parentElement;
  const isDiscovering = payload?.active && percent === 0;

  if (isDiscovering) {
    track.classList.add('indeterminate');
    scanProgressLabelNode.textContent = '...';
  } else {
    track.classList.remove('indeterminate');
    scanProgressBarNode.style.width = `${percent}%`;
    scanProgressLabelNode.textContent = `${percent}%`;
  }

  if (!payload?.active) {
    if (!scanStatusTimer) {
      scanDetailNode.textContent = 'Todavia no hay un escaneo en progreso.';
      scanProgressBarNode.style.width = '0%';
      scanProgressLabelNode.textContent = '0%';
    }
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
