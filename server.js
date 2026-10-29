const WebSocket = require('ws');
const PORT = process.env.PORT || 3000;
const wss = new WebSocket.Server({ port: PORT });

// rooms[code] = { host: ws|null, n: number, codes: string[], seats: (ws|null)[] }
const rooms = {};

console.log(`Labirynt server running on port ${PORT}`);

wss.on('connection', (ws) => {
  let roomCode = null;
  let seat = -1;

  ws.on('message', (raw) => {
    let msg;
    try { msg = JSON.parse(raw); } catch { return; }

    // ============ HOST: tworzy lub wznawia pokój ============
    if (msg.type === 'create') {
      roomCode = String(msg.code || '');
      const n = Math.max(2, Math.min(4, msg.n || 2));
      const codes = Array.isArray(msg.codes) ? msg.codes.map(String) : [];

      // Jeśli pokój istnieje, ale host uciekł (ma null), wznawiamy go
      if (rooms[roomCode] && rooms[roomCode].host === null) {
        rooms[roomCode].host = ws;
        rooms[roomCode].seats[0] = ws;
        seat = 0;
        ws.send(JSON.stringify({ type: 'created', code: roomCode }));
        broadcastRoom(rooms[roomCode], { type: 'room_state', seats: rooms[roomCode].seats.map(s => !!s) });
        return;
      }

      // Jeśli pokój istnieje i host jest aktywny, niszczymy stary
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
      
      const idx = room.codes.indexOf(playerCode);
      if (idx < 0) {
        ws.send(JSON.stringify({ type: 'error', message: 'Nieprawidłowy kod gracza.' }));
        return;
      }
      const seatIndex = idx + 1;
      
      // Sprawdzamy, czy miejsce nie jest zajęte przez AKTYWNE połączenie
      if (room.seats[seatIndex] && room.seats[seatIndex].readyState === WebSocket.OPEN) {
        ws.send(JSON.stringify({ type: 'error', message: 'Ten kod jest już użyty.' }));
        return;
      }

      room.seats[seatIndex] = ws;
      seat = seatIndex;

      ws.send(JSON.stringify({ type: 'joined', seat: seatIndex }));
      broadcastRoom(room, { type: 'room_state', seats: room.seats.map(s => !!s) });
      return;
    }

    // ============ RELAY ============
    const room = rooms[roomCode];
    if (!room) return;

    if (room.host === ws) {
      const raw2 = raw.toString();
      for (let i = 1; i < room.seats.length; i++) {
        const s = room.seats[i];
        if (s && s.readyState === WebSocket.OPEN) s.send(raw2);
      }
    } else {
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
      // Zamiast usuwać, dajemy hostowi 15 sekund na powrót (np. odświeżenie)
      room.host = null;
      room.seats[0] = null;
      broadcastRoom(room, { type: 'room_state', seats: room.seats.map(s => !!s) });
      
      setTimeout(() => {
        if (rooms[roomCode] && rooms[roomCode].host === null) {
          for (const s of rooms[roomCode].seats) {
            if (s && s.readyState === WebSocket.OPEN) {
              s.send(JSON.stringify({ type: 'error', message: 'Host opuścił pokój.' }));
              s.close();
            }
          }
          delete rooms[roomCode];
        }
      }, 15000);
      return;
    }

    // Gracz wyszedł
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
