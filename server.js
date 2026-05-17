const http = require("http");
const fs = require("fs");
const path = require("path");
const { URL } = require("url");

const HOST = process.env.HOST || "0.0.0.0";
const PORT = Number(process.env.PORT || 3000);
const PUBLIC_HOST = process.env.PUBLIC_HOST || "192.168.1.9";
const DATA_FILE = process.env.DATA_FILE || path.join(__dirname, "data", "buildings.json");
const LOG_DIR = path.join(__dirname, "logs");
const REQUEST_LOG = path.join(LOG_DIR, "requests.log");
const SIMULATION_TICK_MS = Number(process.env.SIMULATION_TICK_MS || 1000);
const INCIDENT_INTERVAL_MS = Number(process.env.INCIDENT_INTERVAL_MS || 60000);

const incidentTypes = [
  "PowerOutage",
  "WaterLeak",
  "FireAlert",
  "StructuralHazard",
  "ToxicSmog"
];

const demoBuildingIds = new Set([
  "173372371",
  "44408283",
  "1092798737",
  "251650026",
  "513392176"
]);

const incidentNames = {
  poweroutage: "PowerOutage",
  power: "PowerOutage",
  pwr: "PowerOutage",
  electricity: "PowerOutage",
  waterleak: "WaterLeak",
  water: "WaterLeak",
  h2o: "WaterLeak",
  firealert: "FireAlert",
  fire: "FireAlert",
  structuralhazard: "StructuralHazard",
  structure: "StructuralHazard",
  structural: "StructuralHazard",
  toxicsmog: "ToxicSmog",
  smog: "ToxicSmog",
  pollution: "ToxicSmog",
  air: "ToxicSmog"
};

let eventClients = [];
let buildings = ensureBuildingState(readBuildings());
let lastSimulationAt = Date.now();
let lastIncidentAt = Date.now();
resetStartupState(buildings);

function readBuildings() {
  return JSON.parse(fs.readFileSync(DATA_FILE, "utf8"));
}

function writeBuildings(buildings) {
  fs.writeFileSync(DATA_FILE, `${JSON.stringify(publicBuildings(buildings), null, 2)}\n`, "utf8");
}

function clamp(value, min = 0, max = 100) {
  const number = Number(value);
  if (!Number.isFinite(number)) {
    return min;
  }

  return Math.max(min, Math.min(max, number));
}

function parseBoolean(value) {
  if (typeof value === "boolean") {
    return value;
  }

  if (typeof value === "number") {
    return value !== 0;
  }

  const normalized = normalize(value);
  return normalized === "true" || normalized === "1" || normalized === "yes" || normalized === "on" || normalized === "cut";
}

function ensureBuildingState(source) {
  return source.map((building) => {
    building.electricity = clamp(building.electricity);
    building.water = clamp(building.water);
    building.structure = clamp(building.structure);
    building.fireRisk = clamp(building.fireRisk);
    building.pollution = clamp(building.pollution);
    building.incidents = Array.isArray(building.incidents) ? building.incidents : [];
    building.electricitySupplyCut = Boolean(building.electricitySupplyCut);
    building.waterSupplyCut = Boolean(building.waterSupplyCut);
    return building;
  });
}

function resetStartupState(source = buildings) {
  for (const building of source) {
    building.incidents = [];
    building.electricitySupplyCut = false;
    building.waterSupplyCut = false;
    delete building.lastReport;
    delete building.lastFlowControl;
  }

  lastSimulationAt = Date.now();
  lastIncidentAt = Date.now();
  return source;
}

function normalize(value) {
  return String(value || "").toLowerCase().replace(/[^a-z0-9]/g, "");
}

function normalizeIncident(value) {
  const normalized = normalize(value);
  return incidentNames[normalized] || value;
}

function findBuilding(buildings, id) {
  const normalized = normalize(id);
  return buildings.find((building) => {
    return normalize(building.stableId) === normalized ||
      normalize(building.stableID) === normalized ||
      normalize(building.shortId) === normalized ||
      normalize(building.name) === normalized;
  });
}

function publicBuilding(building) {
  return {
    ...building,
    electricity: Math.round(clamp(building.electricity)),
    water: Math.round(clamp(building.water)),
    structure: Math.round(clamp(building.structure)),
    fireRisk: Math.round(clamp(building.fireRisk)),
    pollution: Math.round(clamp(building.pollution))
  };
}

function publicBuildings(source) {
  return source.map(publicBuilding);
}

function isDemoBuilding(building) {
  return demoBuildingIds.has(String(building.stableId || building.stableID || ""));
}

function hasIncident(building, incidentType) {
  building.incidents = Array.isArray(building.incidents) ? building.incidents : [];
  return building.incidents.includes(incidentType);
}

function addIncident(building, incidentType, source = "backend-auto") {
  building.incidents = Array.isArray(building.incidents) ? building.incidents : [];
  const added = !building.incidents.includes(incidentType);
  if (added) {
    building.incidents.push(incidentType);
  }

  building.lastReport = {
    incidentType,
    role: "System",
    source,
    rawQrPayload: "",
    at: new Date().toISOString()
  };
  return added;
}

function fixIncident(building, incidentType, details = {}) {
  building.incidents = Array.isArray(building.incidents) ? building.incidents : [];
  building.incidents = building.incidents.filter((incident) => incident !== incidentType);

  switch (incidentType) {
    case "PowerOutage":
      building.electricity = 100;
      break;
    case "WaterLeak":
      building.water = 100;
      break;
    case "FireAlert":
      building.fireRisk = 0;
      break;
    case "StructuralHazard":
      building.structure = 100;
      break;
    case "ToxicSmog":
      building.pollution = 0;
      break;
  }

  building.lastFix = {
    incidentType,
    role: details.role || "Staff",
    source: details.source || "unknown",
    at: new Date().toISOString()
  };
}

function categoryRates(building) {
  const rates = {
    electricity: 0.12,
    water: 0.10,
    structure: 0.05,
    pollution: 0.08,
    fireRisk: 0.10
  };

  switch (normalize(building.category)) {
    case "industry":
    case "powerplant":
      rates.pollution *= 3.5;
      rates.fireRisk *= 2.0;
      break;
    case "waterstation":
      rates.water *= 3.5;
      break;
    case "house":
    case "apartment":
      rates.water *= 1.5;
      rates.electricity *= 1.5;
      break;
    case "hospital":
    case "school":
      rates.electricity *= 0.25;
      rates.water *= 0.25;
      rates.structure *= 0.25;
      rates.pollution *= 0.25;
      rates.fireRisk *= 0.25;
      break;
    case "work":
    case "shop":
      rates.electricity *= 2.5;
      break;
    case "pleasure":
      rates.structure *= 2.5;
      break;
  }

  if (hasIncident(building, "PowerOutage")) {
    rates.electricity *= 3.0;
  }
  if (hasIncident(building, "WaterLeak")) {
    rates.water *= 3.0;
  }
  if (hasIncident(building, "StructuralHazard")) {
    rates.structure *= 3.0;
  }
  if (hasIncident(building, "ToxicSmog")) {
    rates.pollution *= 3.0;
  }
  if (hasIncident(building, "FireAlert")) {
    rates.fireRisk *= 3.0;
  }

  return rates;
}

function advanceBuilding(building, deltaSeconds) {
  const rates = categoryRates(building);

  if (!building.electricitySupplyCut) {
    building.electricity = clamp(building.electricity - rates.electricity * deltaSeconds);
  }
  if (!building.waterSupplyCut) {
    building.water = clamp(building.water - rates.water * deltaSeconds);
  }

  building.structure = clamp(building.structure - rates.structure * deltaSeconds);
  building.pollution = clamp(building.pollution + rates.pollution * deltaSeconds);
  building.fireRisk = clamp(building.fireRisk + rates.fireRisk * deltaSeconds);
}

function spawnRandomIncident(now) {
  if (now - lastIncidentAt < INCIDENT_INTERVAL_MS) {
    return null;
  }

  lastIncidentAt = now;
  const candidates = buildings
    .filter((building) => !isDemoBuilding(building))
    .map((building) => ({
      building,
      availableIncidents: incidentTypes.filter((incidentType) => !hasIncident(building, incidentType))
    }))
    .filter((candidate) => candidate.availableIncidents.length > 0);

  if (candidates.length === 0) {
    return null;
  }

  const emptyCandidates = candidates.filter((candidate) => candidate.building.incidents.length === 0);
  const pool = emptyCandidates.length > 0 ? emptyCandidates : candidates;
  const selected = pool[Math.floor(Math.random() * pool.length)];
  const incidentType = selected.availableIncidents[Math.floor(Math.random() * selected.availableIncidents.length)];

  addIncident(selected.building, incidentType);
  return selected.building;
}

function runSimulationTick() {
  const now = Date.now();
  const deltaSeconds = Math.max(0, (now - lastSimulationAt) / 1000);
  lastSimulationAt = now;

  if (deltaSeconds <= 0) {
    return;
  }

  for (const building of buildings) {
    advanceBuilding(building, deltaSeconds);
  }

  const newIncidentBuilding = spawnRandomIncident(now);

  if (newIncidentBuilding) {
    writeBuildings(buildings);
    broadcast("building-updated", newIncidentBuilding);
  }
}

function sendJson(response, statusCode, payload) {
  const body = JSON.stringify(payload, null, 2);
  response.writeHead(statusCode, {
    "Access-Control-Allow-Origin": "*",
    "Access-Control-Allow-Methods": "GET,POST,OPTIONS",
    "Access-Control-Allow-Headers": "Content-Type,Authorization",
    "Content-Type": "application/json; charset=utf-8",
    "Content-Length": Buffer.byteLength(body)
  });
  response.end(body);
}

function sendError(response, statusCode, message) {
  sendJson(response, statusCode, { error: message });
}

function readBody(request) {
  return new Promise((resolve, reject) => {
    let body = "";
    request.on("data", (chunk) => {
      body += chunk;
      if (body.length > 1024 * 1024) {
        reject(new Error("Request body is too large"));
        request.destroy();
      }
    });
    request.on("end", () => {
      if (!body.trim()) {
        resolve({});
        return;
      }

      try {
        resolve(JSON.parse(body));
      } catch {
        reject(new Error("Body must be valid JSON"));
      }
    });
    request.on("error", reject);
  });
}

function publicBaseUrl() {
  return `http://${PUBLIC_HOST}:${PORT}/api`;
}

function logRequest(request) {
  try {
    fs.mkdirSync(LOG_DIR, { recursive: true });
    const remote = request.socket && request.socket.remoteAddress ? request.socket.remoteAddress : "unknown";
    const userAgent = request.headers["user-agent"] || "unknown";
    const line = `${new Date().toISOString()} ${remote} ${request.method} ${request.url} ${userAgent}\n`;
    fs.appendFile(REQUEST_LOG, line, () => {});
  } catch {
    // Request logging should never block the API itself.
  }
}

function broadcast(event, building) {
  const payload = `event: ${event}\ndata: ${JSON.stringify({ event, building: publicBuilding(building) })}\n\n`;
  eventClients = eventClients.filter((client) => !client.destroyed);
  for (const client of eventClients) {
    client.write(payload);
  }
}

function openEvents(request, response) {
  response.writeHead(200, {
    "Access-Control-Allow-Origin": "*",
    "Cache-Control": "no-cache",
    "Connection": "keep-alive",
    "Content-Type": "text/event-stream"
  });
  response.write(`event: ready\ndata: ${JSON.stringify({ ok: true })}\n\n`);
  eventClients.push(response);
  request.on("close", () => {
    eventClients = eventClients.filter((client) => client !== response);
  });
}

async function handleRequest(request, response) {
  logRequest(request);
  const url = new URL(request.url, `http://${request.headers.host || "localhost"}`);
  const parts = url.pathname.replace(/\/+$/, "").split("/").filter(Boolean);

  if (request.method === "OPTIONS") {
    sendJson(response, 200, { ok: true });
    return;
  }

  if (request.method === "GET" && url.pathname === "/api/events") {
    openEvents(request, response);
    return;
  }

  if (parts[0] !== "api") {
    sendError(response, 404, "Use /api");
    return;
  }

  if (request.method === "GET" && parts.length === 1) {
    sendJson(response, 200, {
      ok: true,
      service: "Smart City RVRA Backend",
      listenUrl: `http://localhost:${PORT}/api`,
      androidUrl: publicBaseUrl(),
      endpoints: [
        "GET /api/buildings",
        "GET /api/building/:stableId",
        "POST /api/building/:stableId/report",
        "POST /api/building/:stableId/fix/:type",
        "POST /api/building/:stableId/flow/:type",
        "POST /api/reset-incidents",
        "GET /api/events"
      ]
    });
    return;
  }

  if (request.method === "GET" && parts[1] === "health") {
    sendJson(response, 200, { ok: true, androidUrl: publicBaseUrl() });
    return;
  }

  if (request.method === "POST" && parts[1] === "reset-incidents") {
    buildings = resetStartupState(ensureBuildingState(readBuildings()));
    writeBuildings(buildings);
    sendJson(response, 200, { ok: true, buildings: publicBuildings(buildings) });
    return;
  }

  if (request.method === "GET" && parts[1] === "buildings") {
    sendJson(response, 200, publicBuildings(buildings));
    return;
  }

  if (parts[1] !== "building" || !parts[2]) {
    sendError(response, 404, "Unknown endpoint");
    return;
  }

  const stableId = decodeURIComponent(parts[2]);
  const building = findBuilding(buildings, stableId);
  if (!building) {
    sendError(response, 404, `Unknown building '${stableId}'`);
    return;
  }

  if (request.method === "GET" && parts.length === 3) {
    sendJson(response, 200, publicBuilding(building));
    return;
  }

  if (request.method === "POST" && parts[3] === "report") {
    const body = await readBody(request);
    const incidentType = normalizeIncident(body.incidentType || body.type);
    if (!incidentType) {
      sendError(response, 400, "incidentType is required");
      return;
    }

    addIncident(building, incidentType, body.source || "unknown");
    building.lastReport.role = body.role || "Unknown";
    building.lastReport.rawQrPayload = body.rawQrPayload || "";

    writeBuildings(buildings);
    broadcast("building-updated", building);
    sendJson(response, 200, publicBuilding(building));
    return;
  }

  if (request.method === "POST" && parts[3] === "fix") {
    const body = await readBody(request);
    if (body.role && String(body.role).toLowerCase() !== "staff") {
      sendError(response, 403, "Only Staff can fix incidents");
      return;
    }

    const incidentType = normalizeIncident(parts[4] || body.incidentType || body.type);
    if (!incidentType) {
      sendError(response, 400, "incidentType is required");
      return;
    }

    fixIncident(building, incidentType, body);

    writeBuildings(buildings);
    broadcast("building-updated", building);
    sendJson(response, 200, publicBuilding(building));
    return;
  }

  if (request.method === "POST" && parts[3] === "flow") {
    const body = await readBody(request);
    const flowType = normalize(parts[4] || body.flowType || body.type);
    const cut = parseBoolean(body.cut);

    if (flowType !== "electricity" && flowType !== "power" && flowType !== "water") {
      sendError(response, 400, "flow type must be electricity or water");
      return;
    }

    if (flowType === "water") {
      building.waterSupplyCut = cut;
    } else {
      building.electricitySupplyCut = cut;
    }

    building.lastFlowControl = {
      type: flowType === "water" ? "water" : "electricity",
      cut,
      source: body.source || "rvra-unity",
      at: new Date().toISOString()
    };

    writeBuildings(buildings);
    broadcast("building-updated", building);
    sendJson(response, 200, publicBuilding(building));
    return;
  }

  sendError(response, 404, "Unknown endpoint");
}

const server = http.createServer((request, response) => {
  handleRequest(request, response).catch((error) => {
    sendError(response, 500, error.message || "Server error");
  });
});

server.listen(PORT, HOST, () => {
  console.log(`Smart City RVRA backend listening on http://${HOST}:${PORT}/api`);
  console.log(`Android URL: ${publicBaseUrl()}`);
});

setInterval(runSimulationTick, Math.max(250, SIMULATION_TICK_MS));
