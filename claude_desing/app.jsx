// Main app shell — Diamond Dynasty Scanner mobile
const { useState, useEffect, useRef } = React;

function App() {
  const [authed, setAuthed] = useState(false);
  const [profile, setProfile] = useState(MOCK_PROFILE);
  const [tab, setTab] = useState("home");
  const [selected, setSelected] = useState(new Set(["p1", "p3", "p4", "p6", "p7"]));
  const [openProgram, setOpenProgram] = useState(null);
  const [aiOpen, setAiOpen] = useState(false);
  const [toast, setToast] = useState(null);
  const [scanState, setScanState] = useState({ running: false, pct: 0, detail: "" });
  const scrollRef = useRef(null);

  // Toast auto-dismiss
  useEffect(() => {
    if (!toast) return;
    const t = setTimeout(() => setToast(null), 3200);
    return () => clearTimeout(t);
  }, [toast]);

  // Scroll to top on tab change
  useEffect(() => {
    if (scrollRef.current) scrollRef.current.scrollTop = 0;
  }, [tab]);

  // Mock scan animation
  const runScan = () => {
    setToast({ kind: "scan", msg: `Escaneando ${selected.size} programas…` });
    setScanState({ running: true, pct: 0, detail: "Conectando con servidores…" });
    let p = 0;
    const stages = [
      "Conectando con servidores…",
      "Leyendo programas…",
      "Procesando misiones…",
      "Cruzando con inventario…",
      "Listo.",
    ];
    const iv = setInterval(() => {
      p += 8;
      const stage = stages[Math.min(Math.floor(p / 25), stages.length - 1)];
      setScanState({ running: p < 100, pct: Math.min(p, 100), detail: stage });
      if (p >= 100) {
        clearInterval(iv);
        setScanState({ running: false, pct: 100, detail: "" });
        setToast({ kind: "ok", msg: "Escaneo completo · 12 misiones nuevas" });
      }
    }, 220);
  };

  const handleEnter = (username) => {
    setProfile({ ...profile, username, initials: username.slice(0, 2).toUpperCase() });
    setAuthed(true);
  };

  if (!authed) {
    return (
      <div className="app">
        <ProfileGate onEnter={handleEnter} />
      </div>
    );
  }

  return (
    <div className="app">
      <AppHeader profile={profile} onProfile={() => setTab("sesion")} />

      <div className="app-scroll" ref={scrollRef}>
        {tab === "home" && (
          <HomeScreen
            profile={profile}
            scanState={scanState}
            onScan={runScan}
            goTab={setTab}
            openAi={() => setAiOpen(true)}
          />
        )}
        {tab === "programas" && (
          <ProgramasScreen
            selected={selected}
            setSelected={setSelected}
            openProgram={setOpenProgram}
            onScan={runScan}
          />
        )}
        {tab === "cartas" && <InventarioScreen />}
        {tab === "sesion" && (
          <SesionScreen
            profile={profile}
            sessionValid={true}
            onReimport={() => setToast({ kind: "ok", msg: "Cookies importadas · sesión renovada" })}
            onReset={() => setToast({ kind: "warn", msg: "Sesión cerrada (simulado)" })}
          />
        )}
      </div>

      <TabBar tab={tab} setTab={setTab} openAi={() => setAiOpen(true)} />

      {openProgram && (
        <ProgramDetailSheet program={openProgram} onClose={() => setOpenProgram(null)} />
      )}

      {aiOpen && <AiSheet onClose={() => setAiOpen(false)} />}

      {toast && (
        <div className="toast">
          <span className={`led-dot ${toast.kind === "warn" ? "warn" : toast.kind === "ok" ? "" : "dim"}`} />
          <span style={{ flex: 1 }}>{toast.msg}</span>
          <button className="close-btn" style={{ width: 24, height: 24 }} onClick={() => setToast(null)}>
            {Icon.close}
          </button>
        </div>
      )}
    </div>
  );
}

// ─── Mount inside the Android frame ─────────────────────────
function Mount() {
  // Make Android frame fit the viewport with letterbox.
  const [scale, setScale] = useState(1);
  const [size] = useState({ w: 412, h: 892 });

  useEffect(() => {
    const fit = () => {
      const pad = 24;
      const sx = (window.innerWidth - pad) / size.w;
      const sy = (window.innerHeight - pad) / size.h;
      setScale(Math.min(1, sx, sy));
    };
    fit();
    window.addEventListener("resize", fit);
    return () => window.removeEventListener("resize", fit);
  }, []);

  return (
    <div style={{
      width: "100vw", height: "100vh",
      display: "grid", placeItems: "center",
      background: "#0a0a0a",
      overflow: "hidden",
    }}>
      <div style={{ transform: `scale(${scale})`, transformOrigin: "center" }}>
        <AndroidDevice width={size.w} height={size.h} dark={true}>
          <App />
        </AndroidDevice>
      </div>
    </div>
  );
}

ReactDOM.createRoot(document.getElementById("root")).render(<Mount />);
