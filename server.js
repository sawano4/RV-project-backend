const http = require("http");
const fs = require("fs");
const path = require("path");
const { URL } = require("url");

const HOST = process.env.HOST || "0.0.0.0";
const PORT = Number(process.env.PORT || 3000);
const PUBLIC_HOST = process.env.PUBLIC_HOST || "192.168.1.9";
const DATA_FILE = path.join(__dirname, "data", "buildings.json");
const LOG_DIR = path.join(__dirname, "logs");
const REQUEST_LOG = path.join(LOG_DIR, "requests.log");

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

function readBuildings() {
  return JSON.parse(fs.readFileSync(DATA_FILE, "utf8"));
}

function writeBuildings(buildings) {
  fs.writeFileSync(DATA_FILE, `${JSON.stringify(buildings, null, 2)}\n`, "utf8");
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
  const payload = `event: ${event}\ndata: ${JSON.stringify({ event, building })}\n\n`;
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
        "GET /api/events"
      ]
    });
    return;
  }

  if (request.method === "GET" && parts[1] === "health") {
    sendJson(response, 200, { ok: true, androidUrl: publicBaseUrl() });
    return;
  }

  const buildings = readBuildings();

  if (request.method === "GET" && parts[1] === "buildings") {
    sendJson(response, 200, buildings);
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
    sendJson(response, 200, building);
    return;
  }

  if (request.method === "POST" && parts[3] === "report") {
    const body = await readBody(request);
    const incidentType = normalizeIncident(body.incidentType || body.type);
    if (!incidentType) {
      sendError(response, 400, "incidentType is required");
      return;
    }

    building.incidents = Array.isArray(building.incidents) ? building.incidents : [];
    if (!building.incidents.includes(incidentType)) {
      building.incidents.push(incidentType);
    }

    building.lastReport = {
      incidentType,
      role: body.role || "Unknown",
      source: body.source || "unknown",
      rawQrPayload: body.rawQrPayload || "",
      at: new Date().toISOString()
    };

    writeBuildings(buildings);
    broadcast("building-updated", building);
    sendJson(response, 200, building);
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

    building.incidents = Array.isArray(building.incidents) ? building.incidents : [];
    building.incidents = building.incidents.filter((incident) => incident !== incidentType);
    building.lastFix = {
      incidentType,
      role: body.role || "Staff",
      source: body.source || "unknown",
      at: new Date().toISOString()
    };

    writeBuildings(buildings);
    broadcast("building-updated", building);
    sendJson(response, 200, building);
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
