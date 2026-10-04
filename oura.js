// oura.js — récupère tes données Oura via l'API v2 (OAuth2)
// Utilisation :
//   node oura.js auth            → connexion à Oura (une seule fois)
//   node oura.js fetch [jours]   → exporte les N derniers jours (30 par défaut)
// Nécessite Node.js 18 ou plus.

const fs = require("fs");
const path = require("path");
const http = require("http");
const crypto = require("crypto");
const { exec } = require("child_process");

const DIR = __dirname;
const ENV_FILE = path.join(DIR, ".env");
const TOKENS_FILE = path.join(DIR, "tokens.json");
const OUT_DIR = path.join(DIR, "output");

const REDIRECT_URI = "http://localhost:8080/callback";
const AUTH_URL = "https://cloud.ouraring.com/oauth/authorize";
const TOKEN_URL = "https://api.ouraring.com/oauth/token";
const API = "https://api.ouraring.com/v2/usercollection";
const SCOPES = "personal daily heartrate workout session spo2 tag";

// ---------- utilitaires ----------
function loadEnv() {
  if (!fs.existsSync(ENV_FILE)) {
    console.error("❌ Fichier .env introuvable. Crée-le à côté de oura.js (voir .env.example).");
    process.exit(1);
  }
  for (const line of fs.readFileSync(ENV_FILE, "utf8").split(/\r?\n/)) {
    const m = line.match(/^\s*([A-Z_]+)\s*=\s*(.*)\s*$/);
    if (m) process.env[m[1]] = m[2].replace(/^["']|["']$/g, "");
  }
  const { OURA_CLIENT_ID, OURA_CLIENT_SECRET } = process.env;
  if (!OURA_CLIENT_ID || !OURA_CLIENT_SECRET) {
    console.error("❌ OURA_CLIENT_ID et OURA_CLIENT_SECRET doivent être renseignés dans .env");
    process.exit(1);
  }
  return { clientId: OURA_CLIENT_ID, clientSecret: OURA_CLIENT_SECRET };
}

function saveTokens(t) {
  const tokens = {
    access_token: t.access_token,
    refresh_token: t.refresh_token,
    expires_at: Date.now() + (t.expires_in || 86400) * 1000,
  };
  // écriture atomique : on ne perd jamais le refresh token (il est à usage unique)
  const tmp = TOKENS_FILE + ".tmp";
  fs.writeFileSync(tmp, JSON.stringify(tokens, null, 2));
  fs.renameSync(tmp, TOKENS_FILE);
  return tokens;
}

async function postToken(params) {
  const res = await fetch(TOKEN_URL, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams(params),
  });
  const body = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(`Erreur token (${res.status}) : ${JSON.stringify(body)}`);
  return body;
}

function openBrowser(url) {
  const cmd =
    process.platform === "win32" ? `start "" "${url}"` :
    process.platform === "darwin" ? `open "${url}"` : `xdg-open "${url}"`;
  exec(cmd, () => {});
}

// ---------- 1. connexion OAuth ----------
async function auth() {
  const { clientId, clientSecret } = loadEnv();
  const state = crypto.randomBytes(16).toString("hex");
  const url =
    `${AUTH_URL}?response_type=code&client_id=${encodeURIComponent(clientId)}` +
    `&redirect_uri=${encodeURIComponent(REDIRECT_URI)}` +
    `&scope=${encodeURIComponent(SCOPES)}&state=${state}`;

  const server = http.createServer(async (req, res) => {
    const u = new URL(req.url, "http://localhost:8080");
    if (u.pathname !== "/callback") { res.end(); return; }
    res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
    try {
      if (u.searchParams.get("error")) throw new Error(u.searchParams.get("error"));
      if (u.searchParams.get("state") !== state) throw new Error("state invalide");
      const t = await postToken({
        grant_type: "authorization_code",
        code: u.searchParams.get("code"),
        redirect_uri: REDIRECT_URI,
        client_id: clientId,
        client_secret: clientSecret,
      });
      saveTokens(t);
      res.end("<h2>✅ Connecté à Oura. Tu peux fermer cet onglet.</h2>");
      console.log("✅ Connexion réussie, tokens enregistrés dans tokens.json");
      console.log("👉 Lance maintenant : node oura.js fetch");
    } catch (e) {
      res.end(`<h2>❌ Échec : ${e.message}</h2>`);
      console.error("❌", e.message);
    }
    server.close();
  });

  server.listen(8080, () => {
    console.log("Ouverture de la page d'autorisation Oura…");
    console.log("Si rien ne s'ouvre, copie ce lien dans ton navigateur :\n" + url);
    openBrowser(url);
  });
}

// ---------- 2. récupération des données ----------
async function getAccessToken() {
  if (!fs.existsSync(TOKENS_FILE)) {
    console.error("❌ Pas encore connecté. Lance d'abord : node oura.js auth");
    process.exit(1);
  }
  let tokens = JSON.parse(fs.readFileSync(TOKENS_FILE, "utf8"));
  if (Date.now() > tokens.expires_at - 5 * 60 * 1000) {
    const { clientId, clientSecret } = loadEnv();
    console.log("🔄 Rafraîchissement du token…");
    const t = await postToken({
      grant_type: "refresh_token",
      refresh_token: tokens.refresh_token,
      client_id: clientId,
      client_secret: clientSecret,
    });
    tokens = saveTokens(t);
  }
  return tokens.access_token;
}

async function getAll(token, endpoint, params) {
  const items = [];
  let next = null;
  do {
    const q = new URLSearchParams(params);
    if (next) q.set("next_token", next);
    const res = await fetch(`${API}/${endpoint}?${q}`, {
      headers: { Authorization: `Bearer ${token}` },
    });
    if (!res.ok) {
      console.warn(`   ⚠️  ${endpoint} : ${res.status} (ignoré)`);
      return items;
    }
    const body = await res.json();
    items.push(...(body.data || []));
    next = body.next_token;
  } while (next);
  return items;
}

const day = (d) => d.toISOString().slice(0, 10);
const round = (x, n = 0) => (x == null ? "" : Number(x.toFixed(n)));

async function fetchData(days) {
  const token = await getAccessToken();
  const end = new Date();
  end.setDate(end.getDate() + 1); // la date de fin est exclusive
  const start = new Date();
  start.setDate(start.getDate() - days);
  const range = { start_date: day(start), end_date: day(end) };
  console.log(`📥 Récupération du ${range.start_date} au ${day(new Date())}…`);

  const endpoints = [
    "daily_sleep", "sleep", "daily_readiness", "daily_activity",
    "workout", "daily_spo2", "daily_stress", "session", "tag",
  ];
  const data = {};
  for (const ep of endpoints) {
    data[ep] = await getAll(token, ep, range);
    console.log(`   ${ep} : ${data[ep].length}`);
  }
  // FC continue (par fenêtres de 30 jours max)
  data.heartrate = [];
  for (let s = new Date(start); s < end; s.setDate(s.getDate() + 30)) {
    const e = new Date(Math.min(new Date(s).setDate(s.getDate() + 30), end));
    data.heartrate.push(...(await getAll(token, "heartrate", {
      start_datetime: s.toISOString(), end_datetime: e.toISOString(),
    })));
  }
  console.log(`   heartrate : ${data.heartrate.length} mesures`);

  fs.mkdirSync(OUT_DIR, { recursive: true });
  const stamp = day(new Date());
  fs.writeFileSync(path.join(OUT_DIR, `oura_brut_${stamp}.json`), JSON.stringify(data, null, 2));

  // ----- résumé quotidien en CSV -----
  const byDay = {};
  const row = (d) => (byDay[d] ||= { date: d });
  for (const x of data.daily_sleep) row(x.day).score_sommeil = x.score;
  for (const x of data.daily_readiness) {
    const r = row(x.day);
    r.score_readiness = x.score;
    r.ecart_temperature = x.temperature_deviation;
  }
  for (const x of data.daily_activity) {
    const r = row(x.day);
    r.score_activite = x.score;
    r.pas = x.steps;
    r.calories_actives = x.active_calories;
  }
  for (const x of data.daily_stress) row(x.day).stress_eleve_min = round((x.stress_high || 0) / 60);
  for (const x of data.daily_spo2) row(x.day).spo2_moy = x.spo2_percentage?.average;
  for (const x of data.sleep.filter((s) => s.type === "long_sleep")) {
    const r = row(x.day);
    r.coucher = x.bedtime_start;
    r.lever = x.bedtime_end;
    r.sommeil_total_h = round(x.total_sleep_duration / 3600, 2);
    r.sommeil_profond_h = round(x.deep_sleep_duration / 3600, 2);
    r.sommeil_paradoxal_h = round(x.rem_sleep_duration / 3600, 2);
    r.efficacite = x.efficiency;
    r.latence_min = round(x.latency / 60);
    r.fc_min = x.lowest_heart_rate;
    r.fc_moy_nuit = round(x.average_heart_rate, 1);
    r.hrv_moy = x.average_hrv;
  }
  for (const x of data.workout) {
    const r = row(x.day);
    r.entrainements = (r.entrainements ? r.entrainements + " | " : "") +
      `${x.activity} (${x.intensity}, ${round(x.calories)} kcal)`;
  }

  const cols = [
    "date", "score_sommeil", "score_readiness", "score_activite",
    "sommeil_total_h", "sommeil_profond_h", "sommeil_paradoxal_h", "efficacite",
    "latence_min", "coucher", "lever", "fc_min", "fc_moy_nuit", "hrv_moy",
    "ecart_temperature", "spo2_moy", "pas", "calories_actives",
    "stress_eleve_min", "entrainements",
  ];
  const esc = (v) => (v == null ? "" : /[",;\n]/.test(String(v)) ? `"${String(v).replace(/"/g, '""')}"` : v);
  const csv = [cols.join(",")]
    .concat(Object.keys(byDay).sort().map((d) => cols.map((c) => esc(byDay[d][c])).join(",")))
    .join("\n");
  const csvPath = path.join(OUT_DIR, `oura_resume_${stamp}.csv`);
  fs.writeFileSync(csvPath, csv);

  console.log(`\n✅ Terminé ! Fichiers dans le dossier output/ :`);
  console.log(`   • oura_resume_${stamp}.csv  (1 ligne par jour — à m'envoyer pour l'analyse)`);
  console.log(`   • oura_brut_${stamp}.json   (toutes les données détaillées)`);
}

// ---------- lancement ----------
const [cmd, arg] = process.argv.slice(2);
if (cmd === "auth") auth().catch((e) => console.error("❌", e.message));
else if (cmd === "fetch") fetchData(parseInt(arg) || 30).catch((e) => console.error("❌", e.message));
else console.log("Utilisation :\n  node oura.js auth\n  node oura.js fetch [nombre_de_jours]");
