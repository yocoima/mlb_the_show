// All screens for Diamond Dynasty Scanner mobile
// Components are attached to window at the end so app.jsx can use them.

const { useState, useMemo, useEffect } = React;

// ─── Icon set (inline SVGs, consistent stroke style) ────────
const Icon = {
  home: (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      <path d="M3 12 12 3l9 9" /><path d="M5 10v10h14V10" />
    </svg>
  ),
  list: (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      <line x1="8" y1="6" x2="21" y2="6" /><line x1="8" y1="12" x2="21" y2="12" /><line x1="8" y1="18" x2="21" y2="18" />
      <circle cx="4" cy="6" r="1.5" fill="currentColor" /><circle cx="4" cy="12" r="1.5" fill="currentColor" /><circle cx="4" cy="18" r="1.5" fill="currentColor" />
    </svg>
  ),
  cards: (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      <rect x="3" y="5" width="13" height="16" rx="2" /><path d="M8 3h13v15" />
    </svg>
  ),
  user: (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      <circle cx="12" cy="8" r="4" /><path d="M4 21c0-4 4-7 8-7s8 3 8 7" />
    </svg>
  ),
  ai: (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round">
      <path d="M12 3v3M12 18v3M3 12h3M18 12h3M5.6 5.6l2.1 2.1M16.3 16.3l2.1 2.1M5.6 18.4l2.1-2.1M16.3 7.7l2.1-2.1" />
      <circle cx="12" cy="12" r="4" />
    </svg>
  ),
  bell: (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      <path d="M6 8a6 6 0 0 1 12 0c0 7 3 8 3 8H3s3-1 3-8" /><path d="M10 21a2 2 0 0 0 4 0" />
    </svg>
  ),
  check: (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="3" strokeLinecap="round" strokeLinejoin="round">
      <path d="M5 12l5 5L20 7" />
    </svg>
  ),
  chevronR: (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round">
      <path d="M9 6l6 6-6 6" />
    </svg>
  ),
  chevronL: (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round">
      <path d="M15 6l-6 6 6 6" />
    </svg>
  ),
  close: (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      <path d="M6 6l12 12M18 6l-12 12" />
    </svg>
  ),
  refresh: (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      <path d="M3 12a9 9 0 0 1 15-6.7L21 8" /><path d="M21 3v5h-5" />
      <path d="M21 12a9 9 0 0 1-15 6.7L3 16" /><path d="M3 21v-5h5" />
    </svg>
  ),
  scan: (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      <path d="M3 7V5a2 2 0 0 1 2-2h2M17 3h2a2 2 0 0 1 2 2v2M21 17v2a2 2 0 0 1-2 2h-2M7 21H5a2 2 0 0 1-2-2v-2" />
      <line x1="7" y1="12" x2="17" y2="12" />
    </svg>
  ),
  plus: (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.4" strokeLinecap="round" strokeLinejoin="round">
      <path d="M12 5v14M5 12h14" />
    </svg>
  ),
  arrow: (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      <path d="M5 12h14M13 5l7 7-7 7" />
    </svg>
  ),
  trophy: (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      <path d="M6 4h12v5a6 6 0 0 1-12 0z" /><path d="M6 6H3a2 2 0 0 0 2 4M18 6h3a2 2 0 0 1-2 4" />
      <path d="M9 20h6M12 15v5" />
    </svg>
  ),
};

// ─── Header ─────────────────────────────────────────────────
function AppHeader({ profile, onProfile }) {
  return (
    <header className="app-header">
      <div className="brand">
        <div className="brand-mark"><span>D</span></div>
        <div className="brand-text">
          <div className="brand-eyebrow">Diamond Dynasty</div>
          <div className="brand-title">Scanner ’26</div>
        </div>
      </div>
      <div className="header-pills">
        <button className="icon-button" aria-label="Notificaciones">{Icon.bell}</button>
        <button className="user-pill" onClick={onProfile}>
          <span className="avatar">{profile.initials}</span>
          <span>{profile.username}</span>
        </button>
      </div>
    </header>
  );
}

// ─── HOME / DASHBOARD ───────────────────────────────────────
function HomeScreen({ profile, scanState, onScan, goTab, openAi }) {
  const totalMissions = MOCK_PROGRAMS.reduce((a, p) => a + p.missions, 0);
  const totalDone = MOCK_PROGRAMS.reduce((a, p) => a + p.missionsDone, 0);

  return (
    <>
      <div className="status-hero">
        <div className="status-row">
          <div className="status-led">
            <span className="led-dot" />
            <span>Sesión activa</span>
          </div>
          <span className="mono" style={{ fontSize: 11, color: 'var(--ink-muted)' }}>
            Exp {profile.sessionExpiry.split(' ')[0]}
          </span>
        </div>

        <h1 className="status-title">
          {scanState.running ? "Escaneando programas…" : "Listo para escanear."}
        </h1>
        <p className="status-sub">
          {scanState.running
            ? scanState.detail
            : `Último escaneo: ${profile.lastScan} · ${totalMissions} misiones detectadas`}
        </p>

        <div className="scan-progress">
          <div className="scan-progress-head">
            <span className="label">Progreso global</span>
            <span className="pct">{Math.round(totalDone / totalMissions * 100)}%</span>
          </div>
          <div className="scan-track">
            <div className="fill" style={{ width: `${Math.round(totalDone / totalMissions * 100)}%` }} />
          </div>
        </div>

        <div className="status-divider" />

        <div className="status-metrics">
          <div className="metric">
            <span className="metric-label">Programas</span>
            <span className="metric-value accent">{profile.programsActive}<span className="metric-unit">/{MOCK_PROGRAMS.length}</span></span>
          </div>
          <div className="metric">
            <span className="metric-label">Misiones</span>
            <span className="metric-value">{totalDone}<span className="metric-unit">/{totalMissions}</span></span>
          </div>
          <div className="metric">
            <span className="metric-label">Cartas</span>
            <span className="metric-value">{profile.cardsTotal}</span>
          </div>
        </div>
      </div>

      <div className="section-head">
        <h2 className="h-section">Workflow</h2>
        <span className="mono" style={{ fontSize: 11, color: 'var(--ink-muted)' }}>3 / 4 listos</span>
      </div>

      <div className="workflow">
        <button className="step done" onClick={() => goTab("sesion")}>
          <div className="step-num">01</div>
          <div className="step-body">
            <h3 className="step-title">Importar sesión</h3>
            <p className="step-sub">Cookies cargadas · válidas 7 días</p>
          </div>
          <span className="step-state state-done">Listo</span>
        </button>

        <button className="step done" onClick={() => goTab("programas")}>
          <div className="step-num">02</div>
          <div className="step-body">
            <h3 className="step-title">Descubrir contenido</h3>
            <p className="step-sub">Catálogo actualizado · {MOCK_PROGRAMS.length} programas</p>
          </div>
          <span className="step-state state-done">Listo</span>
        </button>

        <button className="step active" onClick={onScan}>
          <div className="step-num">03</div>
          <div className="step-body">
            <h3 className="step-title">Escanear objetivos</h3>
            <p className="step-sub">Toca para escanear los 5 programas seleccionados</p>
          </div>
          <span className="step-state state-now">Ahora</span>
        </button>

        <button className="step" onClick={openAi}>
          <div className="step-num">04</div>
          <div className="step-body">
            <h3 className="step-title">Análisis estratégico IA</h3>
            <p className="step-sub">Cruza tus objetivos con tu inventario</p>
          </div>
          <span className="step-state state-todo">Pendiente</span>
        </button>
      </div>

      <div className="section-head">
        <h2 className="h-section">Programas activos</h2>
        <button className="link" onClick={() => goTab("programas")}>Ver todos →</button>
      </div>

      <div className="list-stack">
        {MOCK_PROGRAMS.filter(p => p.active).slice(0, 3).map(p => (
          <ProgramCardCompact key={p.id} program={p} />
        ))}
      </div>
    </>
  );
}

function ProgramCardCompact({ program }) {
  return (
    <div className="program-card">
      <div className="program-body" style={{ marginLeft: 0 }}>
        <div className="program-meta" style={{ marginBottom: 4 }}>
          <span className="tag">{program.tag}</span>
          <span>{program.type}</span>
        </div>
        <h3 className="program-title">{program.name}</h3>
        <div className="program-meta">
          <span>{program.missionsDone}/{program.missions} misiones</span>
          <span className="dot" />
          <span>{program.reward}</span>
        </div>
      </div>
      <div className="program-progress">
        <span className="pct">{program.progress}%</span>
        <div className="mini-bar"><div className="fill" style={{ width: `${program.progress}%` }} /></div>
      </div>
    </div>
  );
}

// ─── PROGRAMAS TAB ──────────────────────────────────────────
function ProgramasScreen({ selected, setSelected, openProgram, onScan }) {
  const [filter, setFilter] = useState("todos");
  const [search, setSearch] = useState("");

  const filtered = useMemo(() => {
    let list = MOCK_PROGRAMS;
    if (filter === "seleccion") list = list.filter(p => selected.has(p.id));
    if (filter === "activos") list = list.filter(p => p.active);
    if (filter === "completos") list = list.filter(p => p.completed);
    if (search.trim()) {
      const q = search.toLowerCase();
      list = list.filter(p => p.name.toLowerCase().includes(q));
    }
    return list;
  }, [filter, search, selected]);

  const toggle = (id) => {
    setSelected(prev => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  };

  const counts = {
    todos: MOCK_PROGRAMS.length,
    seleccion: selected.size,
    activos: MOCK_PROGRAMS.filter(p => p.active).length,
    completos: MOCK_PROGRAMS.filter(p => p.completed).length,
  };

  return (
    <>
      <p className="eyebrow" style={{ marginTop: 8 }}>Catálogo</p>
      <h1 className="h-display" style={{ margin: '4px 0 16px' }}>Programas</h1>

      <div className="search-row">
        <input
          className="search-input"
          placeholder="Buscar programa…"
          value={search}
          onChange={(e) => setSearch(e.target.value)}
        />
      </div>

      <div className="chip-row">
        {[
          ["todos", "Todos"],
          ["seleccion", "Selección"],
          ["activos", "Activos"],
          ["completos", "Completos"],
        ].map(([key, label]) => (
          <button
            key={key}
            className={`chip ${filter === key ? "active" : ""}`}
            onClick={() => setFilter(key)}
          >
            {label}
            <span className="count">{counts[key]}</span>
          </button>
        ))}
      </div>

      <div className="list-stack">
        {filtered.map(p => (
          <button
            key={p.id}
            className={`program-card ${selected.has(p.id) ? "selected" : ""}`}
            onClick={() => toggle(p.id)}
            onDoubleClick={() => openProgram(p)}
          >
            <div className="checkmark">{Icon.check}</div>
            <div className="program-body">
              <div className="program-meta" style={{ marginBottom: 4 }}>
                <span className="tag">{p.tag}</span>
                <span>{p.type}</span>
                {p.completed && (<><span className="dot" /><span style={{ color: 'var(--ok)' }}>Completo</span></>)}
              </div>
              <h3 className="program-title">{p.name}</h3>
              <div className="program-meta">
                <span>{p.missionsDone}/{p.missions} mis.</span>
                <span className="dot" />
                <span>{p.reward}</span>
              </div>
            </div>
            <div className="program-progress">
              <span className="pct">{p.progress}%</span>
              <div className="mini-bar"><div className="fill" style={{ width: `${p.progress}%` }} /></div>
            </div>
          </button>
        ))}

        {filtered.length === 0 && (
          <div className="empty">
            <div className="icon">○</div>
            <h3>Sin resultados</h3>
            <p>Cambia el filtro o la búsqueda.</p>
          </div>
        )}
      </div>

      {selected.size > 0 && (
        <div className="bulk-bar">
          <div className="count-pill"><span className="n">{selected.size}</span>seleccionados</div>
          <button className="btn btn-primary" style={{ flex: 1 }} onClick={onScan}>
            {Icon.scan}
            <span>Escanear</span>
          </button>
        </div>
      )}
    </>
  );
}

// ─── PROGRAM DETAIL SHEET ───────────────────────────────────
function ProgramDetailSheet({ program, onClose }) {
  if (!program) return null;
  const missions = MOCK_MISSIONS[program.id] || [
    { id: "m1", text: "Conecta 4 home runs en partidos online", reward: "+250 XP", done: true },
    { id: "m2", text: "Acumula 12 ponches con cards del programa", reward: "+300 XP", done: false },
    { id: "m3", text: "Gana un partido en Mini Seasons con lineup elegible", reward: "+500 XP", done: false },
  ];
  const recommended = MOCK_INVENTORY.slice(0, 3);

  return (
    <div className="sheet-overlay" onClick={onClose}>
      <div className="sheet" onClick={(e) => e.stopPropagation()}>
        <div className="sheet-handle" />
        <div className="sheet-head">
          <div>
            <div className="program-meta" style={{ marginBottom: 6 }}>
              <span className="tag">{program.tag}</span>
              <span>{program.type}</span>
            </div>
            <h2 className="h-section" style={{ fontSize: 22 }}>{program.name}</h2>
            <p className="status-sub" style={{ marginTop: 4 }}>
              {program.missionsDone}/{program.missions} misiones · Recompensa: {program.reward}
            </p>
          </div>
          <button className="close-btn" onClick={onClose}>{Icon.close}</button>
        </div>

        <div className="sheet-body">
          <div className="scan-progress" style={{ marginTop: 0, marginBottom: 20 }}>
            <div className="scan-progress-head">
              <span className="label">Progreso</span>
              <span className="pct">{program.progress}%</span>
            </div>
            <div className="scan-track"><div className="fill" style={{ width: `${program.progress}%` }} /></div>
          </div>

          <h3 className="eyebrow" style={{ marginBottom: 8 }}>Misiones</h3>
          <div style={{ marginBottom: 22 }}>
            {missions.map(m => (
              <div key={m.id} className={`mission-row ${m.done ? "done" : ""}`}>
                <div className={`mission-check ${m.done ? "done" : ""}`}>{m.done && Icon.check}</div>
                <div className="mission-text">{m.text}</div>
                <div className="mission-reward">{m.reward}</div>
              </div>
            ))}
          </div>

          <h3 className="eyebrow" style={{ marginBottom: 8 }}>Cartas recomendadas</h3>
          <div className="list-stack">
            {recommended.map(c => (
              <div key={c.id} className="player-row">
                <div className="player-portrait">
                  {c.name.split(' ').map(s => s[0]).join('').slice(0,2)}
                  <span className="ovr">{c.ovr}</span>
                </div>
                <div>
                  <h4 className="player-name">{c.name}</h4>
                  <p className="player-meta">{c.pos} · {c.team} · {c.rare}</p>
                </div>
                <span className="player-tag">IA PICK</span>
              </div>
            ))}
          </div>

          <button className="btn btn-primary btn-block btn-lg" style={{ marginTop: 20 }}>
            <span>Marcar progreso manual</span>
            {Icon.arrow}
          </button>
        </div>
      </div>
    </div>
  );
}

// ─── INVENTARIO TAB ─────────────────────────────────────────
function InventarioScreen() {
  const [filter, setFilter] = useState("todas");
  const filtered = useMemo(() => {
    if (filter === "todas") return MOCK_INVENTORY;
    if (filter === "diamond") return MOCK_INVENTORY.filter(c => c.rare === "Diamond");
    if (filter === "gold") return MOCK_INVENTORY.filter(c => c.rare === "Gold");
    if (filter === "usadas") return MOCK_INVENTORY.filter(c => c.used > 0);
    return MOCK_INVENTORY;
  }, [filter]);

  const counts = {
    todas: MOCK_INVENTORY.length,
    diamond: MOCK_INVENTORY.filter(c => c.rare === "Diamond").length,
    gold: MOCK_INVENTORY.filter(c => c.rare === "Gold").length,
    usadas: MOCK_INVENTORY.filter(c => c.used > 0).length,
  };

  return (
    <>
      <p className="eyebrow" style={{ marginTop: 8 }}>Inventario</p>
      <h1 className="h-display" style={{ margin: '4px 0 16px' }}>Mis cartas</h1>

      <div className="card" style={{ marginBottom: 16 }}>
        <div className="status-metrics" style={{ gridTemplateColumns: '1fr 1fr 1fr' }}>
          <div className="metric">
            <span className="metric-label">Total</span>
            <span className="metric-value accent">{MOCK_PROFILE.cardsTotal}</span>
          </div>
          <div className="metric">
            <span className="metric-label">Diamond</span>
            <span className="metric-value">12</span>
          </div>
          <div className="metric">
            <span className="metric-label">En uso IA</span>
            <span className="metric-value">{MOCK_INVENTORY.filter(c => c.used > 0).length}</span>
          </div>
        </div>
        <div className="status-divider" />
        <button className="btn btn-block">
          {Icon.refresh}
          <span>Escanear inventario · última: {MOCK_PROFILE.lastInventory}</span>
        </button>
      </div>

      <div className="chip-row" style={{ margin: '0 -16px 14px' }}>
        {[
          ["todas", "Todas"],
          ["diamond", "Diamond"],
          ["gold", "Gold"],
          ["usadas", "En misiones"],
        ].map(([k, l]) => (
          <button key={k} className={`chip ${filter === k ? "active" : ""}`} onClick={() => setFilter(k)}>
            {l}<span className="count">{counts[k]}</span>
          </button>
        ))}
      </div>

      <div className="inv-grid">
        {filtered.map(c => (
          <div key={c.id} className="inv-card">
            <div className="portrait">
              {c.name.split(' ').map(s => s[0]).join('').slice(0,2)}
              <span className="ovr-badge">{c.ovr}</span>
              <span className="pos-badge">{c.pos}</span>
            </div>
            <h4 className="name">{c.name}</h4>
            <p className="sub">{c.team} · {c.rare}</p>
            {c.used > 0 && <span className="used-tag">{c.used} mis.</span>}
          </div>
        ))}
      </div>
    </>
  );
}

// ─── SESIÓN TAB ─────────────────────────────────────────────
function SesionScreen({ profile, sessionValid, onReimport, onReset }) {
  const [showImport, setShowImport] = useState(false);
  const [importValue, setImportValue] = useState("");

  return (
    <>
      <p className="eyebrow" style={{ marginTop: 8 }}>Cuenta</p>
      <h1 className="h-display" style={{ margin: '4px 0 16px' }}>Sesión y perfil</h1>

      <div className="card" style={{ marginBottom: 16 }}>
        <div className="status-row">
          <div className="status-led">
            <span className={`led-dot ${sessionValid ? "" : "warn"}`} />
            <span>{sessionValid ? "Sesión válida" : "Sesión expirada"}</span>
          </div>
          <button className="btn btn-sm btn-ghost" onClick={() => location.reload()}>
            {Icon.refresh}<span>Verificar</span>
          </button>
        </div>
        <div className="status-divider" />
        <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 16 }}>
          <div>
            <p className="metric-label">Usuario</p>
            <p style={{ margin: '4px 0 0', fontSize: 15, fontWeight: 700 }}>{profile.username}</p>
          </div>
          <div>
            <p className="metric-label">Expira</p>
            <p className="mono" style={{ margin: '4px 0 0', fontSize: 12, color: 'var(--ink)' }}>
              {profile.sessionExpiry}
            </p>
          </div>
        </div>
      </div>

      <h3 className="eyebrow" style={{ marginBottom: 10 }}>Acciones de sesión</h3>
      <div className="list-stack" style={{ marginBottom: 22 }}>
        <button className="step" onClick={() => setShowImport(v => !v)}>
          <div className="step-num">⇪</div>
          <div className="step-body">
            <h3 className="step-title">Importar cookies</h3>
            <p className="step-sub">Pega un JSON exportado del navegador</p>
          </div>
          <span className="step-state state-todo">JSON</span>
        </button>

        <button className="step">
          <div className="step-num">⇆</div>
          <div className="step-body">
            <h3 className="step-title">Compartir perfil</h3>
            <p className="step-sub">Generar token para otro dispositivo</p>
          </div>
          <span className="step-state state-todo">Token</span>
        </button>

        <button className="step" onClick={onReset}>
          <div className="step-num" style={{ color: 'var(--warn)' }}>×</div>
          <div className="step-body">
            <h3 className="step-title" style={{ color: 'var(--warn)' }}>Reiniciar sesión</h3>
            <p className="step-sub">Cierra y borra cookies guardadas</p>
          </div>
          <span className="step-state state-err">Riesgo</span>
        </button>
      </div>

      {showImport && (
        <div className="card" style={{ marginBottom: 16 }}>
          <h3 className="h-section" style={{ marginBottom: 4 }}>Pega tu storageState</h3>
          <p className="status-sub" style={{ marginBottom: 12 }}>
            Acepta arreglo de cookies o objeto Playwright con <code className="kbd">cookies</code> y <code className="kbd">origins</code>.
          </p>
          <textarea
            className="input"
            rows="5"
            placeholder={'{"cookies":[{"name":"sid","value":"...","domain":".theshow.com"}],"origins":[]}'}
            style={{ fontFamily: 'JetBrains Mono, monospace', fontSize: 11 }}
            value={importValue}
            onChange={(e) => setImportValue(e.target.value)}
          />
          <div style={{ display: 'flex', gap: 8, marginTop: 10 }}>
            <button className="btn btn-primary" style={{ flex: 1 }} onClick={onReimport}>Importar</button>
            <button className="btn btn-ghost" onClick={() => setImportValue("")}>Limpiar</button>
          </div>
        </div>
      )}

      <h3 className="eyebrow" style={{ marginBottom: 10 }}>Token de perfil</h3>
      <div className="card" style={{ marginBottom: 22 }}>
        <p className="status-sub" style={{ marginBottom: 10 }}>
          Usa este token para abrir el mismo perfil en otro dispositivo.
        </p>
        <div className="token-display">dd26_a1f9b3c8e7d24fa9b1·diego_dyn·2026-05-12</div>
        <div style={{ display: 'flex', gap: 8, marginTop: 10 }}>
          <button className="btn" style={{ flex: 1 }}>Copiar</button>
          <button className="btn" style={{ flex: 1 }}>Compartir link</button>
        </div>
      </div>

      <h3 className="eyebrow" style={{ marginBottom: 10 }}>Preferencias</h3>
      <div className="card">
        <div className="toggle-row">
          <div className="label-block">
            <p className="label">Auto-escanear al abrir</p>
            <p className="sub">Refresca catálogo y misiones automáticamente</p>
          </div>
          <button className="toggle on" />
        </div>
        <div className="toggle-row">
          <div className="label-block">
            <p className="label">Notificaciones de IA</p>
            <p className="sub">Avisa cuando hay nuevas recomendaciones</p>
          </div>
          <button className="toggle on" />
        </div>
        <div className="toggle-row">
          <div className="label-block">
            <p className="label">Modo compacto</p>
            <p className="sub">Densidad alta en listas</p>
          </div>
          <button className="toggle" />
        </div>
      </div>
    </>
  );
}

// ─── AI SHEET ───────────────────────────────────────────────
function AiSheet({ onClose }) {
  return (
    <div className="sheet-overlay" onClick={onClose}>
      <div className="sheet" onClick={(e) => e.stopPropagation()}>
        <div className="sheet-handle" />
        <div className="sheet-head">
          <div>
            <p className="mono" style={{ fontSize: 10, fontWeight: 700, letterSpacing: '0.15em', textTransform: 'uppercase', color: 'var(--ai)', margin: '0 0 6px' }}>
              IA · llama-3.3-70b
            </p>
            <h2 className="h-section" style={{ fontSize: 22 }}>Análisis estratégico</h2>
            <p className="status-sub" style={{ marginTop: 4 }}>
              Cruza 5 programas activos con {MOCK_INVENTORY.length} cartas inventariadas.
            </p>
          </div>
          <button className="close-btn" onClick={onClose}>{Icon.close}</button>
        </div>

        <div className="sheet-body">
          <div className="ai-hero">
            <p className="label">Resumen ejecutivo</p>
            <h2>Avanza 7 misiones en 3 movimientos</h2>
            <p>
              Concentra tu jornada de esta tarde en partidos rankeados con R. Vargas en SS y J. Espinoza abriendo. Tres misiones de Set 1 y dos de Awards comparten triggers — cumples ambas en la misma sesión sin grindeo extra.
            </p>
          </div>

          {MOCK_AI_RECS.map(r => (
            <div key={r.id} className="ai-rec">
              <div className="ai-rec-head">
                <h3 className="ai-rec-title">{r.title}</h3>
                <span className="ai-rec-impact">↑ {r.impact}</span>
              </div>
              <p className="ai-rec-rationale">{r.rationale}</p>
              <div className="ai-targets">
                {r.targets.map(t => <span key={t} className="ai-target-pill">{t}</span>)}
              </div>
            </div>
          ))}

          <button className="btn btn-ai btn-block btn-lg" style={{ marginTop: 14 }}>
            {Icon.refresh}<span>Regenerar análisis</span>
          </button>
        </div>
      </div>
    </div>
  );
}

// ─── TAB BAR ────────────────────────────────────────────────
function TabBar({ tab, setTab, openAi }) {
  const tabs = [
    { id: "home", label: "Inicio", icon: Icon.home },
    { id: "programas", label: "Programas", icon: Icon.list },
    { id: "cartas", label: "Cartas", icon: Icon.cards },
    { id: "sesion", label: "Sesión", icon: Icon.user },
  ];
  return (
    <nav className="tab-bar">
      <button className={`tab-btn ${tab === "home" ? "active" : ""}`} onClick={() => setTab("home")}>
        {Icon.home}<span>Inicio</span>
      </button>
      <button className={`tab-btn ${tab === "programas" ? "active" : ""}`} onClick={() => setTab("programas")}>
        {Icon.list}<span>Programas</span>
      </button>
      <button className="tab-fab" onClick={openAi} aria-label="Análisis IA">
        {Icon.ai}
      </button>
      <button className={`tab-btn ${tab === "cartas" ? "active" : ""}`} onClick={() => setTab("cartas")}>
        {Icon.cards}<span>Cartas</span>
      </button>
      <button className={`tab-btn ${tab === "sesion" ? "active" : ""}`} onClick={() => setTab("sesion")}>
        {Icon.user}<span>Sesión</span>
      </button>
    </nav>
  );
}

// ─── PROFILE GATE (LOGIN) ───────────────────────────────────
function ProfileGate({ onEnter }) {
  const [mode, setMode] = useState("create");
  const [user, setUser] = useState("");

  const submit = () => {
    if (user.trim()) onEnter(user.trim());
  };

  return (
    <div className="gate">
      <div className="gate-brand">
        <div className="brand-mark"><span>D</span></div>
        <div className="brand-text">
          <div className="brand-eyebrow">Diamond Dynasty</div>
          <div className="brand-title">Scanner ’26</div>
        </div>
      </div>

      <div className="gate-hero">
        <p className="eyebrow">Perfil de la app</p>
        <h1>Tu cuartel general para Diamond Dynasty.</h1>
        <p>
          Importa una sesión exportada de tu navegador una sola vez. Reutilízala desde el celular para escanear programas y dejar que la IA decida tu próxima jugada.
        </p>
      </div>

      <div className="mode-tabs">
        <button className={`mode-tab ${mode === "create" ? "active" : ""}`} onClick={() => setMode("create")}>
          Primera vez
        </button>
        <button className={`mode-tab ${mode === "login" ? "active" : ""}`} onClick={() => setMode("login")}>
          Ya tengo usuario
        </button>
      </div>

      <label className="field-label" htmlFor="username">Usuario</label>
      <input
        id="username"
        className="input"
        type="text"
        autoComplete="username"
        placeholder="ejemplo: mi_usuario"
        value={user}
        onChange={(e) => setUser(e.target.value)}
      />
      <p className="help-text">
        {mode === "create"
          ? "Crea un usuario único. Si este dispositivo ya tenía resultados, se asociarán a él."
          : "Ingresa el usuario que creaste antes. Tus cookies y escaneos se sincronizan al instante."}
      </p>

      <div className="gate-spacer" />

      <button className="btn btn-primary btn-block btn-lg" onClick={submit}>
        <span>{mode === "create" ? "Crear usuario" : "Continuar"}</span>
        {Icon.arrow}
      </button>
    </div>
  );
}

Object.assign(window, {
  AppHeader, HomeScreen, ProgramasScreen, InventarioScreen, SesionScreen,
  AiSheet, TabBar, ProfileGate, ProgramDetailSheet, Icon,
});
