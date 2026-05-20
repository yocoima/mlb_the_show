// Mock data for Diamond Dynasty Scanner mobile prototype
// All player names are fictional to avoid trademark issues.

const MOCK_PROGRAMS = [
  {
    id: "p1",
    name: "Set 1: Foundations",
    type: "Set Program",
    tag: "S1",
    progress: 62,
    missions: 12,
    missionsDone: 7,
    reward: "99 OVR Boss",
    active: true,
  },
  {
    id: "p2",
    name: "Opening Day Showdown",
    type: "Live Series",
    tag: "EVT",
    progress: 100,
    missions: 8,
    missionsDone: 8,
    reward: "Diamond Bundle",
    completed: true,
  },
  {
    id: "p3",
    name: "Future Stars 2026",
    type: "Player Program",
    tag: "PP",
    progress: 34,
    missions: 10,
    missionsDone: 3,
    reward: "Gold + 5 Packs",
    active: true,
  },
  {
    id: "p4",
    name: "Spring Roster Push",
    type: "Mini Season",
    tag: "MS",
    progress: 78,
    missions: 6,
    missionsDone: 5,
    reward: "Stubs ×15,000",
    active: true,
  },
  {
    id: "p5",
    name: "Topps Now: Mid-April",
    type: "Weekly Drop",
    tag: "NOW",
    progress: 0,
    missions: 5,
    missionsDone: 0,
    reward: "Live Card",
    active: false,
  },
  {
    id: "p6",
    name: "Diamond Quest: Field of Glory",
    type: "Bracket",
    tag: "DQ",
    progress: 45,
    missions: 9,
    missionsDone: 4,
    reward: "Choice Pack",
    active: true,
  },
  {
    id: "p7",
    name: "Awards Pursuit",
    type: "Featured",
    tag: "AWD",
    progress: 18,
    missions: 14,
    missionsDone: 2,
    reward: "97 OVR Card",
    active: true,
  },
];

const MOCK_MISSIONS = {
  p1: [
    { id: "m1", text: "Conecta 5 home runs con peloteros de la AL Este", reward: "+200 XP", done: true },
    { id: "m2", text: "Ponchea 25 bateadores en partidos de Conquest", reward: "+300 XP", done: true },
    { id: "m3", text: "Gana 3 partidos con un lineup all-Gold o superior", reward: "+500 XP", done: false },
    { id: "m4", text: "Roba 10 bases en Ranked Seasons", reward: "+250 XP", done: false },
    { id: "m5", text: "Acumula 50 hits con cards de NL Central", reward: "+400 XP", done: false },
  ],
  p3: [
    { id: "m1", text: "Conecta 3 dobles con prospectos sub-25", reward: "+200 XP", done: true },
    { id: "m2", text: "Lanza una entrada perfecta con un Bronze pitcher", reward: "+350 XP", done: false },
    { id: "m3", text: "Gana un partido en Mini Seasons con Future Star lineup", reward: "+500 XP", done: false },
  ],
};

const MOCK_INVENTORY = [
  { id: "c1", name: "R. Vargas",     ovr: 92, pos: "SS",  team: "BOS", rare: "Diamond", used: 3 },
  { id: "c2", name: "T. Walsh",      ovr: 88, pos: "CF",  team: "NYY", rare: "Diamond", used: 2 },
  { id: "c3", name: "C. Mendoza",    ovr: 87, pos: "1B",  team: "LAD", rare: "Gold",    used: 4 },
  { id: "c4", name: "J. Espinoza",   ovr: 85, pos: "SP",  team: "ATL", rare: "Gold",    used: 1 },
  { id: "c5", name: "D. Holloway",   ovr: 83, pos: "RP",  team: "CHC", rare: "Gold",    used: 0 },
  { id: "c6", name: "M. Patterson",  ovr: 82, pos: "3B",  team: "HOU", rare: "Gold",    used: 5 },
  { id: "c7", name: "A. Sandoval",   ovr: 80, pos: "C",   team: "SEA", rare: "Silver",  used: 2 },
  { id: "c8", name: "K. Brennan",    ovr: 79, pos: "LF",  team: "SFG", rare: "Silver",  used: 0 },
  { id: "c9", name: "P. Donovan",    ovr: 78, pos: "RF",  team: "STL", rare: "Silver",  used: 1 },
  { id: "c10", name: "E. Tomlinson", ovr: 76, pos: "2B",  team: "MIL", rare: "Silver",  used: 0 },
];

const MOCK_AI_RECS = [
  {
    id: "r1",
    title: "Sube a R. Vargas al lineup principal",
    impact: "+4 misiones",
    rationale: "Su perfil contra zurdos cubre los hits requeridos de Set 1: Foundations y Awards Pursuit a la vez. Tienes 86 PA disponibles antes del próximo reset.",
    targets: ["Set 1: Foundations", "Awards Pursuit", "Future Stars 2026"],
  },
  {
    id: "r2",
    title: "Pasa J. Espinoza a Mini Seasons",
    impact: "+2 misiones",
    rationale: "Necesitas 12 outs con un Gold SP. Es tu pitcher con mejor matchup contra los oponentes calculados.",
    targets: ["Spring Roster Push", "Set 1: Foundations"],
  },
  {
    id: "r3",
    title: "Reserva C. Mendoza para Diamond Quest",
    impact: "+1 misión",
    rationale: "Su poder vs derechos completa la misión 'conecta 4 home runs' con margen para 2 intentos extra.",
    targets: ["Diamond Quest"],
  },
];

const MOCK_PROFILE = {
  username: "diego_dyn",
  initials: "DY",
  sessionActive: true,
  sessionExpiry: "2026-05-19 21:40 UTC",
  lastScan: "Hace 12 min",
  lastInventory: "Hace 3 h",
  cardsTotal: 487,
  missionsTotal: 56,
  programsActive: 5,
};

Object.assign(window, {
  MOCK_PROGRAMS,
  MOCK_MISSIONS,
  MOCK_INVENTORY,
  MOCK_AI_RECS,
  MOCK_PROFILE,
});
