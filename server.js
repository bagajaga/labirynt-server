const WebSocket = require('ws');
const PORT = process.env.PORT || 3000;
const wss = new WebSocket.Server({ port: PORT });

// rooms[code] = { host: ws, n: number, codes: string[], seats: (ws|null)[] }
const rooms = {};

console.log(`Labirynt server running on port ${PORT}`);

wss.on('connection', (ws) => {
  let roomCode = null;
  let seat = -1;

  ws.on('message', (raw) => {
    let msg;
    try { msg = JSON.parse(raw); } catch { return; }

    // ============ HOST: tworzy pokój ============
    if (msg.type === 'create') {
      roomCode = String(msg.code || '');
      const n = Math.max(2, Math.min(4, msg.n || 2));
      const codes = Array.isArray(msg.codes) ? msg.codes.map(String) : [];

      if (rooms[roomCode]) {
        try { rooms[roomCode].host?.close(); } catch {}
        for (const s of rooms[roomCode].seats) {
          if (s && s !== rooms[roomCode].host) try { s.close(); } catch {}
        }
        delete rooms[roomCode];
      }

      rooms[roomCode] = {
        host: ws,
        n,
        codes,
        seats: [ws, ...Array(n - 1).fill(null)]
      };
      seat = 0;
      ws.send(JSON.stringify({ type: 'created', code: roomCode }));
      return;
    }

    // ============ GRACZ: dołącza kodem ============
    if (msg.type === 'join') {
      roomCode = String(msg.code || '');
      const playerCode = String(msg.playerCode || '');
      const room = rooms[roomCode];

      if (!room) {
        ws.send(JSON.stringify({ type: 'error', message: 'Nie znaleziono pokoju o tym kodzie.' }));
        return;
      }
      if (!room.seats.some(s => !s)) {
        ws.send(JSON.stringify({ type: 'error', message: 'Pokój jest pełny.' }));
        return;
      }

      const idx = room.codes.indexOf(playerCode);
      if (idx < 0) {
        ws.send(JSON.stringify({ type: 'error', message: 'Nieprawidłowy kod gracza.' }));
        return;
      }
      const seatIndex = idx + 1;
      if (room.seats[seatIndex]) {
        ws.send(JSON.stringify({ type: 'error', message: 'Ten kod jest już użyty.' }));
        return;
      }

      room.seats[seatIndex] = ws;
      seat = seatIndex;

      // 1) Poinformuj dołączającego o jego miejscu
      ws.send(JSON.stringify({ type: 'joined', seat: seatIndex }));

      // 2) Host dostanie room_state i rozgłosi pełny stan gry do wszystkich
      broadcastRoom(room, { type: 'room_state', seats: room.seats.map(s => !!s) });
      return;
    }

    // ============ RELAY ============
    const room = rooms[roomCode];
    if (!room) return;

    if (room.host === ws) {
      // host → wszyscy gracze
      const raw2 = raw.toString();
      for (let i = 1; i < room.seats.length; i++) {
        const s = room.seats[i];
        if (s && s.readyState === WebSocket.OPEN) s.send(raw2);
      }
    } else {
      // gracz → tylko host (z informacją, z którego miejsca)
      const seatIdx = room.seats.indexOf(ws);
      if (seatIdx < 0) return;
      const enriched = { ...msg, _fromSeat: seatIdx };
      if (room.host && room.host.readyState === WebSocket.OPEN) {
        room.host.send(JSON.stringify(enriched));
      }
    }
  });

  ws.on('close', () => {
    if (!roomCode || !rooms[roomCode]) return;
    const room = rooms[roomCode];

    if (room.host === ws) {
      // Host wyszedł → rozwiąż pokój
      for (const s of room.seats) {
        if (s && s !== ws && s.readyState === WebSocket.OPEN) {
          s.send(JSON.stringify({ type: 'error', message: 'Host opuścił pokój.' }));
          s.close();
        }
      }
      delete rooms[roomCode];
      return;
    }

    // Gracz wyszedł → zwolnij miejsce, poinformuj hosta i pozostałych
    const idx = room.seats.indexOf(ws);
    if (idx > 0) {
      room.seats[idx] = null;
      broadcastRoom(room, { type: 'room_state', seats: room.seats.map(s => !!s) });
    }
  });

  ws.on('error', () => { try { ws.close(); } catch {} });
});

function broadcastRoom(room, msg) {
  const raw = JSON.stringify(msg);
  for (const s of room.seats) {
    if (s && s.readyState === WebSocket.OPEN) s.send(raw);
  }
}