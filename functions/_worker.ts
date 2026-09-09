import { Hono } from "hono";

// ─── Types ──────────────────────────────────────────────────────────────
type Env = {
  DB: D1Database;
  VAPID_PUBLIC_KEY: string;
  VAPID_PRIVATE_KEY: string;
  VAPID_SUBJECT: string;
};

type Player = {
  id: string;
  name: string;
  count: number;          // total count (manual + bonuses)
  manual_count: number;   // number of manual taps (charged)
  bonus_count: number;    // total free numbers earned
  is_bot: boolean;
};

type Subscription = {
  player_id: string;
  endpoint: string;
  keys: string;           // JSON string of keys
};

// ─── App ─────────────────────────────────────────────────────────────────
const app = new Hono<{ Bindings: Env }>();
app.get("/ping", (c) => c.json({ status: "ok" }));
// ─── Helpers ─────────────────────────────────────────────────────────────

function getWeekStart(date: Date): string {
  // Saturday night reset: get the most recent Saturday at 22:00 UTC
  const d = new Date(date);
  d.setUTCHours(22, 0, 0, 0);
  const day = d.getUTCDay(); // 0=Sun, 6=Sat
  const diff = (day === 6) ? 0 : (day + 1) % 7; // days to go back to Saturday
  d.setUTCDate(d.getUTCDate() - diff);
  return d.toISOString().split("T")[0];
}

function isGameActive(now: Date): boolean {
  const hours = now.getUTCHours();
  const minutes = now.getUTCMinutes();
  const currentMinutes = hours * 60 + minutes;
  return currentMinutes < 22 * 60; // before 22:00 UTC
}

async function getOrCreatePlayer(
  db: D1Database,
  id: string,
  name: string,
  isBot = false
): Promise<Player> {
  const row = await db
    .prepare("SELECT * FROM players WHERE id = ?")
    .bind(id)
    .first<Player>();
  if (row) return row;

  // Create new player
  await db
    .prepare(
      "INSERT INTO players (id, name, count, manual_count, bonus_count, is_bot) VALUES (?, ?, ?, ?, ?, ?)"
    )
    .bind(id, name, 0, 0, 0, isBot ? 1 : 0)
    .run();
  return { id, name, count: 0, manual_count: 0, bonus_count: 0, is_bot };
}

async function getCurrentDay(db: D1Database): Promise<string> {
  const now = new Date();
  const day = getWeekStart(now);
  // We'll store current day in a settings table
  let settings = await db
    .prepare("SELECT value FROM settings WHERE key = 'current_day'")
    .first<{ value: string }>();
  if (!settings) {
    await db
      .prepare("INSERT INTO settings (key, value) VALUES ('current_day', ?)")
      .bind(day)
      .run();
    return day;
  }
  // If the stored day is older than today's week start, reset the game
  if (settings.value !== day) {
    // Reset: move all players' counts to history, then reset counts
    await db
      .prepare(
        "INSERT INTO history (day, player_id, name, count) SELECT ?, id, name, count FROM players WHERE count > 0"
      )
      .bind(settings.value)
      .run();
    await db.prepare("UPDATE players SET count = 0, manual_count = 0, bonus_count = 0").run();
    await db
      .prepare("UPDATE settings SET value = ? WHERE key = 'current_day'")
      .bind(day)
      .run();
    // Re‑create bots for all active players? We'll keep bots that are in players table
    // Bots are automatically created on login, so we can just leave them.
  }
  return day;
}

// ─── Middleware to ensure DB and state ──────────────────────────────────

async function ensureState(c: any) {
  const db = c.env.DB;
  const day = await getCurrentDay(db);
  c.set("currentDay", day);
  c.set("gameActive", isGameActive(new Date()));
}

// ─── Routes ─────────────────────────────────────────────────────────────

// Serve static files from /public




// Login – create/retrieve player, create a bot for them if new
app.post("/api/player/login", async (c) => {
  await ensureState(c);
  const db = c.env.DB;
  const { name } = await c.req.json();
  if (!name || name.trim().length < 4) {
    return c.json({ error: "Name must be at least 4 characters" }, 400);
  }
  const sanitized = name.trim().replace(/\s+/g, "-");
  const playerId = sanitized.toLowerCase();

  // Check if already exists
  const existing = await db
    .prepare("SELECT id FROM players WHERE id = ?")
    .bind(playerId)
    .first();
  if (existing) {
    // If player exists, just return their info
    const player = await db
      .prepare("SELECT * FROM players WHERE id = ?")
      .bind(playerId)
      .first<Player>();
    if (!player) return c.json({ error: "Player not found" }, 404);
    return c.json({
      playerId,
      player: { name: player.name, count: player.count },
      vapidPublicKey: c.env.VAPID_PUBLIC_KEY,
    });
  }

  // Create player
  await db
    .prepare(
      "INSERT INTO players (id, name, count, manual_count, bonus_count, is_bot) VALUES (?, ?, ?, ?, ?, ?)"
    )
    .bind(playerId, sanitized, 0, 0, 0, 0)
    .run();

  // Create a bot for this player (random 9‑digit numeric name)
  const botId = String(Math.floor(100000000 + Math.random() * 900000000));
  await db
    .prepare(
      "INSERT INTO players (id, name, count, manual_count, bonus_count, is_bot) VALUES (?, ?, ?, ?, ?, ?)"
    )
    .bind(botId, botId, 0, 0, 0, 1)
    .run();

  const player = await db
    .prepare("SELECT * FROM players WHERE id = ?")
    .bind(playerId)
    .first<Player>();

  return c.json({
    playerId,
    player: { name: player!.name, count: player!.count },
    vapidPublicKey: c.env.VAPID_PUBLIC_KEY,
  });
});

// Subscribe for push notifications
app.post("/api/subscribe", async (c) => {
  const { playerId, subscription } = await c.req.json();
  if (!playerId || !subscription?.endpoint) {
    return c.json({ error: "Invalid subscription" }, 400);
  }
  const db = c.env.DB;
  await db
    .prepare(
      "INSERT INTO subscriptions (player_id, endpoint, keys) VALUES (?, ?, ?) ON CONFLICT(player_id) DO UPDATE SET endpoint = ?, keys = ?"
    )
    .bind(playerId, subscription.endpoint, JSON.stringify(subscription.keys), subscription.endpoint, JSON.stringify(subscription.keys))
    .run();
  return c.json({ ok: true });
});

// Submit – send local counts to server
app.post("/api/submit", async (c) => {
  await ensureState(c);
  const db = c.env.DB;
  const { playerId, manualIncrements, bonusIncrements } = await c.req.json();
  if (!playerId) return c.json({ error: "Missing playerId" }, 400);

  const player = await db
    .prepare("SELECT * FROM players WHERE id = ?")
    .bind(playerId)
    .first<Player>();
  if (!player) return c.json({ error: "Player not found" }, 404);

  // Update player counts
  const newManual = player.manual_count + manualIncrements;
  const newBonus = player.bonus_count + bonusIncrements;
  const newTotal = player.count + manualIncrements + bonusIncrements;
  await db
    .prepare(
      "UPDATE players SET count = ?, manual_count = ?, bonus_count = ? WHERE id = ?"
    )
    .bind(newTotal, newManual, newBonus, playerId)
    .run();

  // Calculate payable amount (manual increments only, because bonuses are free)
  // But we also need to subtract any free numbers they might have used? The user says:
  // "0.01 x (the amount of numbers you just submitted - the amount of free numbers you used)"
  // Here "submitted" = manualIncrements + bonusIncrements, and "free numbers used" = bonusIncrements
  // So payable = manualIncrements
  const payable = manualIncrements;
  const amount = (payable * 0.01).toFixed(2);

  // Redirect to PayPal
  return c.json({
    redirectUrl: `https://www.paypal.me/number-game-3bd5/${amount}`,
    totalCount: newTotal,
    playerCount: newManual,
  });
});

// State endpoint – returns current rankings, game active flag, and per‑player data
app.get("/api/state", async (c) => {
  await ensureState(c);
  const db = c.env.DB;
  const players = await db
    .prepare("SELECT id, name, count, manual_count, bonus_count, is_bot FROM players ORDER BY count DESC")
    .all<Player>();
  const todayTotal = players.results.reduce((sum, p) => sum + p.count, 0);
  return c.json({
    totalCount: todayTotal,
    rankings: players.results.map((p) => ({ id: p.id, name: p.name, count: p.count })),
    gameActive: c.get("gameActive"),
    currentDay: c.get("currentDay"),
    players: players.results,
  });
});

// History endpoint
app.get("/api/history", async (c) => {
  await ensureState(c);
  const db = c.env.DB;
  const history = await db
    .prepare("SELECT day, player_id, name, count FROM history ORDER BY day DESC")
    .all<{ day: string; player_id: string; name: string; count: number }>();
  // Group by day
  const grouped: Record<string, any[]> = {};
  for (const row of history.results) {
    if (!grouped[row.day]) grouped[row.day] = [];
    grouped[row.day].push({ id: row.player_id, name: row.name, count: row.count });
  }
  return c.json(grouped);
});

// ─── Frontend HTML (served at root) ─────────────────────────────────────

const html = `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1.0, maximum-scale=1, user-scalable=no" />
  <title>Number Game</title>
  <style>
    * { margin: 0; padding: 0; box-sizing: border-box; }
    body { font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif; background: #000; color: #fff; overflow: hidden; touch-action: manipulation; }
    #bg-gif { position: fixed; top: 0; left: 0; width: 100%; height: 100%; z-index: -1; opacity: 0.5; object-fit: cover; pointer-events: none; }
    .container { position: relative; z-index: 1; width: 100%; height: 100vh; display: flex; flex-direction: column; align-items: center; justify-content: center; padding: 20px; background: rgba(0,0,0,0.4); overflow-y: auto; }
    .login-screen { text-align: center; background: rgba(0,0,0,0.8); padding: 40px; border-radius: 10px; border: 2px solid #00FF00; }
    .login-screen h1 { color: #00FF00; margin-bottom: 20px; font-size: 2.5em; }
    .login-screen input { padding: 12px; font-size: 1.1em; border: 2px solid #FF00FF; background: #000; color: #00FF00; border-radius: 5px; width: 100%; max-width: 300px; margin-bottom: 20px; }
    .login-screen button { padding: 12px 30px; font-size: 1.1em; background: #00FF00; color: #000; border: none; border-radius: 5px; cursor: pointer; font-weight: bold; transition: all 0.3s; }
    .login-screen button:hover { background: #FF00FF; color: #fff; }
    .game-screen { display: none; text-align: center; width: 100%; max-width: 1200px; }
    .game-screen.active { display: flex; flex-direction: column; align-items: center; gap: 20px; }
    .counter { font-size: 4em; color: #00FF00; font-weight: bold; text-shadow: 0 0 20px #00FF00; }
    .player-count { font-size: 1.5em; color: #FF00FF; }
    .button-group { display: flex; gap: 20px; justify-content: center; flex-wrap: wrap; }
    .increment-btn { padding: 20px 40px; font-size: 1.5em; background: #00FF00; color: #000; border: none; border-radius: 10px; cursor: pointer; font-weight: bold; transition: all 0.3s; min-width: 200px; }
    .increment-btn:hover:not(:disabled) { background: #FF00FF; color: #fff; transform: scale(1.05); }
    .increment-btn:disabled { background: #666; color: #999; cursor: not-allowed; opacity: 0.5; }
    .submit-btn { padding: 20px 40px; font-size: 1.5em; background: #FF00FF; color: #000; border: none; border-radius: 10px; cursor: pointer; font-weight: bold; transition: all 0.3s; min-width: 200px; }
    .submit-btn:hover { background: #00FF00; color: #000; transform: scale(1.05); }
    .nav-btn { padding: 10px 20px; font-size: 1em; background: #FF00FF; color: #fff; border: none; border-radius: 5px; cursor: pointer; font-weight: bold; transition: all 0.3s; }
    .nav-btn:hover { background: #00FF00; color: #000; }
    .audio-btn { padding: 10px 16px; font-size: 1.1em; background: rgba(0,0,0,0.7); color: #00FF00; border: 2px solid #00FF00; border-radius: 5px; cursor: pointer; font-weight: bold; transition: all 0.3s; min-width: 48px; }
    .audio-btn:hover { background: #00FF00; color: #000; }
    .rankings { background: rgba(0,0,0,0.8); padding: 20px; border-radius: 10px; border: 2px solid #FF00FF; width: 100%; max-width: 600px; max-height: 300px; overflow-y: auto; }
    .rankings h2 { color: #00FF00; margin-bottom: 15px; }
    .ranking-item { display: flex; justify-content: space-between; padding: 10px; border-bottom: 1px solid #FF00FF; color: #fff; }
    .ranking-item:last-child { border-bottom: none; }
    .ranking-position { color: #00FF00; font-weight: bold; min-width: 30px; }
    .game-closed { background: rgba(0,0,0,0.8); padding: 40px; border-radius: 10px; border: 2px solid #FF00FF; text-align: center; }
    .game-closed h2 { color: #FF00FF; font-size: 2em; margin-bottom: 20px; }
    .history-screen { display: none; width: 100%; max-width: 1200px; max-height: 80vh; overflow-y: auto; }
    .history-screen.active { display: block; }
    .history-day { background: rgba(0,0,0,0.8); padding: 20px; margin-bottom: 20px; border-radius: 10px; border: 2px solid #00FF00; }
    .history-day h3 { color: #00FF00; margin-bottom: 15px; }
    .bonus-notice { color: #FFD700; font-size: 1.2em; margin-top: 5px; }
  </style>
</head>
<body>
  <img id="bg-gif" src="/bg.gif" alt="background" />
  <audio id="audio-player" loop></audio>
  <div class="container">
    <div class="login-screen" id="login-screen">
      <h1>🎮 Number Game</h1>
      <p style="color: #00FF00; font-size: 1em; margin-bottom: 20px;">Enter your name (4+ characters)</p>
      <input type="text" id="player-name" placeholder="e.g. Player123" />
      <button onclick="login()">Play</button>
    </div>
    <div class="game-screen" id="game-screen">
      <div class="counter" id="counter">0</div>
      <div class="player-count" id="player-count">Your count: 0</div>
      <div class="bonus-notice" id="bonus-notice"></div>
      <div class="button-group">
        <button class="increment-btn" id="increment-btn" onclick="increment()">+1</button>
        <button class="submit-btn" onclick="submitCount()">Submit & Pay</button>
        <button class="audio-btn" id="audio-btn" onclick="toggleAudio()" title="Play/Pause">🔊</button>
      </div>
      <div class="rankings" id="rankings"></div>
      <div class="button-group"><button class="nav-btn" onclick="showHistory()">History</button></div>
    </div>
    <div class="game-closed" id="game-closed" style="display: none;">
      <h2>🏆 This Week's Winners</h2>
      <div class="rankings" id="final-rankings"></div>
      <button class="nav-btn" onclick="showHistory()" style="margin-top: 20px;">View History</button>
    </div>
    <div class="history-screen" id="history-screen"></div>
  </div>
  <script>
    let playerId = null;
    let localCount = 0;          // manual taps
    let bonusCount = 0;         // free numbers earned
    let totalCount = 0;         // localCount + bonusCount (displayed)
    let gameActive = true;

    // ─── Audio ──────────────────────────────────────────────────────────
    const audioPlayer = document.getElementById('audio-player');
    const audioBtn = document.getElementById('audio-btn');
    let audioPlaying = false;

    function toggleAudio() {
      if (audioPlaying) {
        audioPlayer.pause();
        audioBtn.textContent = '🔇';
        audioPlaying = false;
      } else {
        audioPlayer.src = 'https://archive.org/download/CountingUpOn1Tap/AUD-20260124-WA0004.mp3';
        audioPlayer.play().catch(() => {});
        audioBtn.textContent = '🔊';
        audioPlaying = true;
      }
    }

    // ─── Login ──────────────────────────────────────────────────────────
    async function login() {
      const name = document.getElementById('player-name').value.trim();
      if (!name || name.length < 4) {
        alert('Please enter a name with at least 4 characters.');
        return;
      }
      const res = await fetch('/api/player/login', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ name })
      });
      const data = await res.json();
      if (data.error) {
        alert(data.error);
        return;
      }
      playerId = data.playerId;
      localStorage.setItem('playerName', name);
      document.getElementById('login-screen').style.display = 'none';
      document.getElementById('game-screen').classList.add('active');
      updateState();
      setInterval(updateState, 5000);
      // Register push if you want (we'll keep it simple)
    }

    // ─── Increment (local only) ────────────────────────────────────────
    function increment() {
      if (!gameActive) {
        alert('Game is closed for the week.');
        return;
      }
      // Manual increment
      localCount++;
      totalCount = localCount + bonusCount;
      document.getElementById('counter').textContent = totalCount;
      document.getElementById('player-count').textContent = 'Your count: ' + totalCount;

      // Random bonuses
      let bonusMsg = '';
      if (Math.random() < 1/20) {
        bonusCount += 10;
        totalCount += 10;
        bonusMsg = '🎉 +10 free numbers!';
      }
      if (Math.random() < 1/200) {
        bonusCount += 100;
        totalCount += 100;
        bonusMsg = '🎉🎉 +100 free numbers!';
      }
      if (bonusMsg) {
        document.getElementById('bonus-notice').textContent = bonusMsg;
        document.getElementById('counter').textContent = totalCount;
        document.getElementById('player-count').textContent = 'Your count: ' + totalCount;
        setTimeout(() => document.getElementById('bonus-notice').textContent = '', 3000);
      }
    }

    // ─── Submit ─────────────────────────────────────────────────────────
    async function submitCount() {
      if (localCount === 0 && bonusCount === 0) {
        alert('You haven\'t added any numbers yet.');
        return;
      }
      const res = await fetch('/api/submit', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ playerId, manualIncrements: localCount, bonusIncrements: bonusCount })
      });
      const data = await res.json();
      if (data.error) {
        alert(data.error);
        return;
      }
      // Redirect to PayPal
      window.location.href = data.redirectUrl;
    }

    // ─── State update ──────────────────────────────────────────────────
    async function updateState() {
      const res = await fetch('/api/state');
      const data = await res.json();
      gameActive = data.gameActive;
      // Update rankings
      const rankingsEl = document.getElementById('rankings');
      rankingsEl.innerHTML = data.rankings.map((p, i) =>
        '<div class="ranking-item"><span class="ranking-position">#' + (i+1) + '</span><span>' + p.name + '</span><span>' + p.count + '</span></div>'
      ).join('');

      // Check if game is closed
      if (!gameActive) {
        document.getElementById('game-screen').classList.remove('active');
        document.getElementById('game-closed').style.display = 'block';
        document.getElementById('final-rankings').innerHTML = '<h2 style="color:#00FF00;">Leaderboard</h2>' + data.rankings.map((p, i) =>
          '<div class="ranking-item"><span class="ranking-position">#' + (i+1) + '</span><span>' + p.name + '</span><span>' + p.count + '</span></div>'
        ).join('');
      } else {
        document.getElementById('game-screen').classList.add('active');
        document.getElementById('game-closed').style.display = 'none';
      }
    }

    // ─── History ────────────────────────────────────────────────────────
    async function showHistory() {
      const res = await fetch('/api/history');
      const history = await res.json();
      document.getElementById('game-screen').classList.remove('active');
      document.getElementById('game-closed').style.display = 'none';
      const historyScreen = document.getElementById('history-screen');
      historyScreen.classList.add('active');
      if (Object.keys(history).length === 0) {
        historyScreen.innerHTML = '<button class="nav-btn" onclick="location.reload()" style="margin-bottom:20px;">Back</button><div style="text-align:center;color:#FF00FF;">No history yet</div>';
      } else {
        historyScreen.innerHTML = '<button class="nav-btn" onclick="location.reload()" style="margin-bottom:20px;">Back</button>' +
          Object.entries(history).map(([day, players]) =>
            '<div class="history-day"><h3>📅 ' + day + '</h3>' +
            players.sort((a,b) => b.count - a.count).map((p, idx) =>
              '<div class="ranking-item"><span class="ranking-position">#' + (idx+1) + '</span><span>' + p.name + '</span><span>' + p.count + '</span></div>'
            ).join('') + '</div>'
          ).join('');
      }
    }

    // ─── Init ───────────────────────────────────────────────────────────
    const saved = localStorage.getItem('playerName');
    if (saved) document.getElementById('player-name').value = saved;
    document.getElementById('player-name').addEventListener('keypress', e => { if (e.key === 'Enter') login(); });
  </script>
</body>
</html>`;

app.get("/", (c) => c.html(html));
app.get("/health", (c) => c.json({ status: "ok" }));

export default app;
