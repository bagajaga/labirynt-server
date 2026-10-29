Krótka odpowiedź: **Nie, te zmiany zużyją praktycznie zero zasobów**. Wręcz przeciwnie – zapobiegną marnowaniu zasobów na ciągłe restarty serwera.

Oto dlaczego to jest całkowicie bezpieczne dla Twojego darmowego planu (0.1 vCPU, 256 MB RAM):

1. **Heartbeat (ping)**: Wysyłanie `ping` przez WebSocket to nie jest zwykła wiadomość tekstowa. To ramka kontrolna na poziomie protokołu, która waży zaledwie kilka bajtów. Serwer wysyła ją raz na 30 sekund. Obciążenie procesora jest niemierzalne (bliskie 0%), a zużycie transferu to kilka kilobajtów na godzinę.
2. **Endpoint `/health`**: Jeśli platforma Suga zapyta o ten adres, serwer odeśle kilkanaście bajtów JSON. Node.js obsługuje tysiące takich zapytań na sekundę bez zająknięcia. Dla Twojej gry to jak kropla w morzu.
3. **SIGTERM**: Ten kod uruchamia się *tylko wtedy*, gdy platforma chce zrestartować serwer (np. przy wdrażaniu nowej wersji). Przez resztę czasu po prostu „śpi” i nie zużywa nic.

### 💡 Dlaczego to jest opłacalne?
Bez heartbeatu platforma Suga mogła uznać, że serwer „umarł” (bo przez chwilę nie było ruchu w grze), zabić proces (`SIGTERM` z Twoich logów) i uruchomić go od nowa. **Restart serwera to dopiero zużycie zasobów** (procesor musi załadować Node.js, pliki, itp.) oraz – co gorsza – zerwanie połączeń wszystkim graczom. Heartbeat sprawia, że serwer jest stale „widziany” jako żywy, więc nie ma niepotrzebnych restartów.

Dla Twojej gry (kilku graczy, tury, mały ruch) te mechanizmy są jak pielęgniarka sprawdzająca puls – nie obciążają pacjenta, a pozwalają uniknąć nagłego zawału.

---

### 🛠️ Ostateczny, bezpieczny `server.js`

Aby uniknąć błędów z konfiguracją, przygotowałem dla Ciebie kompletny plik `server.js`, który zawiera zarówno Twoją logikę pokoi, jak i te nowe zabezpieczenia. Skopiuj go w całości, wgraj na GitHuba i zrób **Redeploy** w Suga.

```javascript
const http = require('http');
const WebSocket = require('ws');

const PORT = process.env.PORT || 3000;

// 1. Serwer HTTP (dla health checka i podpięcia WebSocketów)
const server = http.createServer((req, res) => {
  if (req.url === '/health') {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ status: 'ok', rooms: Object.keys(rooms).length }));
  } else {
    res.writeHead(404);
    res.end();
  }
});

// 2. Serwer WebSocket podpięty pod ten sam port
const wss = new WebSocket.Server({ server });

// rooms[code] = { host: ws|null, n: number, codes: string[], seats: (ws|null)[] }
const rooms = {};

console.log(`Labirynt server running on port ${PORT}`);

// 3. Heartbeat (co 30 sekund sprawdza, czy klienci żyją)
setInterval(() => {
  wss.clients.forEach((ws) => {
    if (ws.isAlive === false) return ws.terminate();
    ws.isAlive = false;
    ws.ping();
  });
}, 30000);

// 4. Łagodne zamykanie przy restarcie (SIGTERM)
process.on('SIGTERM', () => {
  console.log('SIGTERM received, closing server...');
  wss.clients.forEach((ws) => {
    ws.close(1001, 'Server restarting');
  });
  process.exit(0);
});

wss.on('connection', (ws) => {
  ws.isAlive = true;
  ws.on('pong', () => { ws.isAlive = true; });

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

// Uruchomienie serwera
server.listen(PORT, () => {
  console.log(`HTTP server (health) listening on port ${PORT}`);
});
```
