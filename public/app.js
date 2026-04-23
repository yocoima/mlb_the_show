const scanButton = document.getElementById('scan-button');
const statusNode = document.getElementById('status');
const errorBanner = document.getElementById('error-banner');
const scanTimeNode = document.getElementById('scan-time');
const missionTotalNode = document.getElementById('mission-total');
const missionsBody = document.getElementById('missions-body');

scanButton.addEventListener('click', async () => {
  setLoadingState(true);
  hideError();
  statusNode.textContent = 'Abriendo navegador y esperando el login...';

  try {
    const response = await fetch('/api/scan');
    const payload = await response.json();

    if (!response.ok) {
      throw new Error(payload.detail || payload.error || 'Error desconocido');
    }

    renderMissions(payload.missions || []);
    missionTotalNode.textContent = String(payload.total || 0);
    scanTimeNode.textContent = new Date(payload.scannedAt).toLocaleString('es-CL');
    statusNode.textContent = 'Escaneo completado.';
  } catch (error) {
    renderMissions([]);
    showError(error.message);
    statusNode.textContent = 'El escaneo fallo.';
  } finally {
    setLoadingState(false);
  }
});

function renderMissions(missions) {
  if (!missions.length) {
    missionsBody.innerHTML = `
      <tr class="empty-row">
        <td colspan="4">No se detectaron misiones pendientes en la respuesta capturada.</td>
      </tr>
    `;
    return;
  }

  missionsBody.innerHTML = missions
    .map((mission) => {
      const target = mission.target || 0;
      const current = mission.current || 0;
      const percent = target > 0 ? Math.min(100, Math.round((current / target) * 100)) : 0;

      return `
        <tr>
          <td>
            <div class="mission-name">${escapeHtml(mission.name)}</div>
          </td>
          <td>${current} / ${target}</td>
          <td>
            <div class="progress-cell">
              <div class="progress-bar">
                <span style="width: ${percent}%"></span>
              </div>
              <strong>${percent}%</strong>
            </div>
          </td>
          <td>${escapeHtml(mission.suggestion)}</td>
        </tr>
      `;
    })
    .join('');
}

function setLoadingState(isLoading) {
  scanButton.disabled = isLoading;
  scanButton.textContent = isLoading ? 'Escaneando...' : 'Escanear programas';
}

function showError(message) {
  errorBanner.textContent = message;
  errorBanner.classList.remove('hidden');
}

function hideError() {
  errorBanner.textContent = '';
  errorBanner.classList.add('hidden');
}

function escapeHtml(value) {
  return String(value)
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&#39;');
}
