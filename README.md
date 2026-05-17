# Smart City RVRA Backend

This backend is the shared source of truth for the AR mobile app and the VR city project.

Start it from this folder:

```powershell
npm start
```

The server listens on all network interfaces:

```text
http://0.0.0.0:3000/api
```

Use these URLs:

```text
AR Android app: http://192.168.1.9:3000/api
VR Unity project on this PC: http://localhost:3000/api
```

Main endpoints:

```text
GET  /api
GET  /api/buildings
GET  /api/building/:stableId
POST /api/building/:stableId/report
POST /api/building/:stableId/fix/:type
POST /api/building/:stableId/flow/:type
POST /api/reset-incidents
GET  /api/events
```

The AR app calls `GET /api/building/:stableId` after QR scan, then calls the POST endpoints after report/fix. The VR project can poll `GET /api/buildings` or listen to `GET /api/events` using Server-Sent Events.

The VR project uses `POST /api/building/:stableId/flow/electricity` and `POST /api/building/:stableId/flow/water` with `{ "cut": true | false }` to pause or resume utility degradation without changing the AR report/fix routes.
