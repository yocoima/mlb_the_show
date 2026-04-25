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
cancelScanButton.disabled = true;

bootstrap();

async function bootstrap() {
  await Promise.all([refreshSessionStatus(), loadLastScan(), refreshProgramCatalog(false), loadInventory()]);
}

importButton.addEventListener('click', async () => {
  setBusyState(true);
  hideError();
  statusNode.textContent = 'Importando la sesion pegada en auth_state.json...';

  try {
    const response = await fetch('/api/import-session', {
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

  try {
    const selectedPrograms = getSelectedProgramUrls();
    const response = await fetch('/api/scan', {
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
    await refreshSessionStatus();
  } finally {
    setBusyState(false);
  }
});

cancelScanButton.addEventListener('click', async () => {
  hideError();
  statusNode.textContent = 'Solicitando detener el escaneo...';

  try {
    const response = await fetch('/api/scan/cancel', { method: 'POST' });
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

  try {
    const response = await fetch('/api/reset-session', { method: 'POST' });
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

  try {
    const response = await fetch('/api/inventory/scan', { method: 'POST' });
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
  const response = await fetch('/api/last-scan');
  const payload = await response.json();
  applyScanPayload(payload);
}

async function loadInventory() {
  const response = await fetch('/api/inventory');
  const payload = await response.json();
  inventoryPayload = payload;
  renderInventorySummary(payload);
}

async function refreshSessionStatus() {
  try {
    const response = await fetch('/api/session-status');
    const payload = await response.json();

    if (!response.ok) {
      throw new Error(payload.detail || payload.error || 'Error desconocido');
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
  const response = await fetch(`/api/programs/catalog${forceRefresh ? '?refresh=1' : ''}`);
  const payload = await response.json();

  if (!response.ok) {
    throw new Error(payload.detail || payload.error || 'Error desconocido');
  }

  const lastScanResponse = await fetch('/api/last-scan');
  const lastScanPayload = await lastScanResponse.json();
  programCatalog = payload.programs?.length ? payload.programs : lastScanPayload.catalogPrograms || [];

  if (!selectedProgramUrls.size) {
    selectedProgramUrls = new Set(programCatalog.map((program) => program.url));
  }

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
    if (!selectedProgramUrls.size) {
      selectedProgramUrls = new Set(programCatalog.map((program) => program.url));
    }
    renderProgramSelector(programCatalog);
  }

  renderMissionGroups(missions);
}

function renderProgramSelector(programs) {
  if (!programs.length) {
    programSelectorNode.innerHTML = '<p class="selector-empty">Aun no hay programas descubiertos.</p>';
    return;
  }

  const grouped = groupCatalogPrograms(programs);

  programSelectorNode.innerHTML = grouped
    .map((group) => `
      <details class="selector-group">
        <summary class="selector-group-header">
          <h3>${escapeHtml(group.topGroup)}</h3>
        </summary>
        ${group.subGroups.map((subGroup) => `
          <details class="selector-subgroup">
            <summary class="selector-subgroup-title">${escapeHtml(subGroup.name)}</summary>
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
          </details>
        `).join('')}
      </details>
    `)
    .join('');

  programSelectorNode.querySelectorAll('input[type="checkbox"]').forEach((input) => {
    input.addEventListener('change', () => {
      if (input.checked) {
        selectedProgramUrls.add(input.value);
      } else {
        selectedProgramUrls.delete(input.value);
      }
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

  const grouped = groupMissionsHierarchy(missions);

  missionsGroupsNode.innerHTML = grouped
    .map((topGroup) => `
      <details class="result-top-group">
        <summary class="result-top-group-header">
          <h3>${escapeHtml(topGroup.name)}</h3>
        </summary>
        ${topGroup.subGroups.map((subGroup) => `
          <details class="program-subgroup">
            <summary class="program-subgroup-header">
              <h4>${escapeHtml(subGroup.name)}</h4>
            </summary>
            ${subGroup.programs.map((program) => `
              <details class="program-group">
                <summary class="program-group-header">
                  <div>
                    <h3>${escapeHtml(program.programTitle)}</h3>
                    <p>${program.missions.length} mision(es)</p>
                  </div>
                  <span class="status-badge ${program.status === 'updated' ? 'status-updated' : 'status-stale'}">
                    ${program.status === 'updated' ? 'Actualizadas' : 'Sin actualizar'}
                  </span>
                </summary>
                ${renderObjectiveGroups(program.missions)}
              </details>
            `).join('')}
          </details>
        `).join('')}
      </details>
    `)
    .join('');
}

function renderObjectiveGroups(missions) {
  const grouped = groupProgramMissionsByObjective(missions);

  return grouped.map((group) => `
    <details class="objective-group">
      <summary class="objective-group-header">
        <strong>${escapeHtml(group.name)}</strong>
        <span>${group.missions.length} objetivo(s)</span>
      </summary>
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
            ${group.missions.map(renderMissionRow).join('')}
          </tbody>
        </table>
      </div>
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

function renderSuggestionDetails(mission) {
  const cardsMarkup = renderCardSuggestions(mission);
  if (!cardsMarkup) {
    return '';
  }

  return `
    <tr class="suggestion-detail-row">
      <td colspan="6">
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
