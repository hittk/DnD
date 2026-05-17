/**
 * Chronicle — D&D 5e Campaign Tracker  v2.0
 * WebSocket + REST server with JSON file persistence
 * Requires: express, ws, cors, uuid  |  Node.js >= 18
 */

const express  = require("express");
const http     = require("http");
const WebSocket= require("ws");
const cors     = require("cors");
const fs       = require("fs");
const path     = require("path");
const { v4: uuidv4 } = require("uuid");

// ── Config ────────────────────────────────────────────────────────────────────
const PORT      = process.env.PORT      || 3000;
const DATA_FILE = process.env.DATA_FILE || path.join(__dirname,"data","session.json");
const ADMIN_KEY = process.env.ADMIN_KEY || "changeme";

fs.mkdirSync(path.dirname(DATA_FILE), { recursive: true });

// ── Persistence ───────────────────────────────────────────────────────────────
function loadSession() {
  try { if (fs.existsSync(DATA_FILE)) return JSON.parse(fs.readFileSync(DATA_FILE,"utf8")); }
  catch(e) { console.error("Load failed:",e.message); }
  return null;
}
function saveSession(s) {
  try { fs.writeFileSync(DATA_FILE, JSON.stringify(s,null,2),"utf8"); }
  catch(e) { console.error("Save failed:",e.message); }
}

// ── State ─────────────────────────────────────────────────────────────────────
let session = loadSession();
console.log(session ? `✓ Session loaded: "${session.campaign}"` : "  No session — waiting for DM.");

// ── Express ───────────────────────────────────────────────────────────────────
const app    = express();
const server = http.createServer(app);
app.use(cors());
app.use(express.json({ limit: "8mb" }));   // raised for portrait + full sheet payloads

// Static client — works whether running from repo root or from server/ subfolder
const CLIENT_DIR = fs.existsSync(path.join(__dirname,"..","client"))
  ? path.join(__dirname,"..","client")
  : path.join(__dirname,"client");
app.use(express.static(CLIENT_DIR));

// Explicit root route in case static middleware misses it
app.get("/", (_,res) => {
  const html = path.join(CLIENT_DIR,"chronicle.html");
  if (fs.existsSync(html)) res.sendFile(html);
  else res.send("Chronicle server running — place chronicle.html in the client/ folder.");
});

// DM-only route — serves the DM interface
app.get("/dm", (_,res) => {
  const html = path.join(CLIENT_DIR,"chronicle-dm.html");
  if (fs.existsSync(html)) res.sendFile(html);
  else res.redirect("/");
});

// ── Helpers ───────────────────────────────────────────────────────────────────
function blankSession(dmPin, campaign, joinCode) {
  return {
    dmPin,
    joinCode,                // players use this to join pre-campaign
    campaign: campaign || "New Adventure",
    phase: "setup",          // "setup" | "active"
    characters: [],
    npcs: [],
    pendingPlayers: [],      // players who joined but awaiting DM approval
    roundCounter: 1,
    combatActive: false,
    initiativeOrder: [],     // [{charId, initiative, name}]
    initiativeTurn: 0,
    sessionLog: [],          // [{ts, author, text, type}]  type: log|roll|system
    updatedAt: Date.now(),
  };
}

function logEntry(author, text, type="log") {
  return { id: uuidv4(), ts: Date.now(), author, text, type };
}

// ── REST ──────────────────────────────────────────────────────────────────────

app.get("/health", (_,res) => res.json({ ok:true, ts:Date.now() }));

// Check if session exists + get join info (no secrets exposed)
app.get("/session", (req,res) => {
  if (!session) return res.json({ exists:false });
  // Players joining with a code just need to confirm the session is live
  const { joinCode } = req.query;
  if (joinCode) {
    if (session.joinCode !== joinCode) return res.status(403).json({ error:"Invalid join code" });
    return res.json({ exists:true, campaign:session.campaign, phase:session.phase, session });
  }
  res.json({ exists:true, session });
});

// DM: create / open session
app.post("/session", (req,res) => {
  const { dmPin, campaign, joinCode } = req.body;
  if (!dmPin) return res.status(400).json({ error:"dmPin required" });
  if (session && session.dmPin !== dmPin)
    return res.status(403).json({ error:"Wrong DM PIN" });
  if (!session) {
    const code = joinCode || Math.random().toString(36).slice(2,8).toUpperCase();
    session = blankSession(dmPin, campaign, code);
    saveSession(session);
    console.log(`✓ Session created: "${session.campaign}" code:${session.joinCode}`);
  }
  res.json({ ok:true, session });
});

// Player: join campaign with code + submit their character profile
app.post("/session/join", (req,res) => {
  if (!session) return res.status(404).json({ error:"No session" });
  const { joinCode, characterName, playerName } = req.body;
  if (session.joinCode !== joinCode) return res.status(403).json({ error:"Invalid join code" });
  if (!characterName?.trim()) return res.status(400).json({ error:"Character name required" });

  // Check not already in characters or pending
  const allNames = [
    ...session.characters.map(c=>c.name.toLowerCase()),
    ...session.pendingPlayers.map(c=>c.name.toLowerCase()),
  ];
  if (allNames.includes(characterName.trim().toLowerCase()))
    return res.status(409).json({ error:"That character name is already taken" });

  // Create a pending player entry (shell character)
  const pending = {
    id: uuidv4(),
    name: characterName.trim(),
    playerName: playerName?.trim() || "",
    submittedAt: Date.now(),
    profileDraft: null,       // filled when player submits full sheet
    portraitPending: "",
    status: "joined",         // "joined" | "submitted" | "approved"
  };
  session.pendingPlayers = session.pendingPlayers || [];
  session.pendingPlayers.push(pending);
  saveSession(session);
  broadcast({ type:"SESSION_UPDATE", session });
  res.json({ ok:true, pendingId:pending.id, pending });
});

// Player: submit draft profile for DM approval
app.post("/session/submit-profile", (req,res) => {
  if (!session) return res.status(404).json({ error:"No session" });
  const { pendingId, profileDraft, portraitPending } = req.body;
  const p = (session.pendingPlayers||[]).find(x=>x.id===pendingId);
  if (!p) return res.status(404).json({ error:"Pending player not found" });
  p.profileDraft    = profileDraft;
  p.portraitPending = portraitPending || p.portraitPending || "";
  p.status          = "submitted";
  p.submittedAt     = Date.now();
  saveSession(session);
  broadcast({ type:"SESSION_UPDATE", session });
  // Also tell DM specifically
  broadcast({ type:"PROFILE_SUBMITTED", pendingId:p.id, name:p.name });
  res.json({ ok:true });
});

// DM: approve or reject a pending player
app.post("/session/approve", (req,res) => {
  if (!session) return res.status(404).json({ error:"No session" });
  const { dmPin, pendingId, approve, rejectNote } = req.body;
  if (session.dmPin !== dmPin) return res.status(403).json({ error:"Wrong DM PIN" });
  const idx = (session.pendingPlayers||[]).findIndex(x=>x.id===pendingId);
  if (idx===-1) return res.status(404).json({ error:"Not found" });
  const p = session.pendingPlayers[idx];
  if (approve) {
    // Move from pending → characters, using their submitted draft as the live sheet
    const char = { ...(p.profileDraft || blankCharForPending(p)), portrait: p.portraitPending || "" };
    char.id = p.id;  // keep same ID so player's local pendingId still matches
    session.characters.push(char);
    session.pendingPlayers.splice(idx,1);
    session.sessionLog = session.sessionLog || [];
    session.sessionLog.push(logEntry("System", `${char.name} has joined the party!`, "system"));
    saveSession(session);
    broadcast({ type:"SESSION_UPDATE", session });
    broadcast({ type:"PLAYER_APPROVED", charId:char.id });
    res.json({ ok:true, charId:char.id });
  } else {
    p.status = "rejected";
    p.rejectNote = rejectNote || "";
    saveSession(session);
    broadcast({ type:"SESSION_UPDATE", session });
    broadcast({ type:"PLAYER_REJECTED", pendingId, note:rejectNote||"" });
    res.json({ ok:true });
  }
});

function blankCharForPending(p) {
  return {
    id: p.id, name: p.name, playerName: p.playerName,
    race:"Human", class:"Fighter", subclass:"", level:1, background:"", alignment:"True Neutral",
    xp:0, abilities:{STR:10,DEX:10,CON:10,INT:10,WIS:10,CHA:10},
    savingThrowProfs:{}, skillProfs:{},
    hp:{max:10,current:10,temp:0}, ac:10, speed:30, hitDie:"d10",
    spellcastingAbility:"", spellSaveDC:8, spellAttackBonus:0, spellSlots:{},
    deathSaves:{successes:0,failures:0}, conditions:[], inspiration:false,
    weapons:[], features:"", equipment:"", languages:"", proficiencies:"",
    personalityTraits:"", ideals:"", bonds:"", flaws:"", notes:"",
    currency:{cp:0,sp:0,ep:0,gp:0,pp:0}, portrait:"", portraitPending:"", isNPC:false,
  };
}

// Full session update from any authorised client
app.put("/session", (req,res) => {
  const { dmPin, data } = req.body;
  if (!session) return res.status(404).json({ error:"No session" });
  if (session.dmPin !== dmPin && dmPin !== ADMIN_KEY)
    return res.status(403).json({ error:"Wrong PIN" });
  session = { ...data, dmPin:session.dmPin, updatedAt:Date.now() };
  saveSession(session);
  broadcastExcept(null, { type:"SESSION_UPDATE", session });
  res.json({ ok:true, updatedAt:session.updatedAt });
});

// Admin wipe
app.delete("/session", (req,res) => {
  if (req.headers["x-admin-key"] !== ADMIN_KEY) return res.status(403).json({ error:"Forbidden" });
  session = null;
  if (fs.existsSync(DATA_FILE)) fs.unlinkSync(DATA_FILE);
  broadcast({ type:"SESSION_WIPED" });
  res.json({ ok:true });
});

// ── WebSocket ─────────────────────────────────────────────────────────────────
const wss = new WebSocket.Server({ server });
const clients = new Map();  // ws → { id, role }

function broadcastExcept(excludeWs, payload) {
  const msg = JSON.stringify(payload);
  for (const [ws] of clients) {
    if (ws !== excludeWs && ws.readyState === WebSocket.OPEN) ws.send(msg);
  }
}
function broadcast(payload) { broadcastExcept(null, payload); }

wss.on("connection", (ws) => {
  const id = uuidv4();
  clients.set(ws, { id, role:null });
  console.log(`→ [${id}] connected (total:${clients.size})`);

  ws.send(JSON.stringify({ type:"WELCOME", clientId:id, session:session||null }));

  ws.on("message", (raw) => {
    let msg; try { msg = JSON.parse(raw); } catch { return; }

    switch (msg.type) {

      case "IDENTIFY": {
        const info = clients.get(ws);
        if (info) info.role = msg.role;
        break;
      }

      case "SESSION_UPDATE": {
        if (!session) break;
        if (msg.dmPin !== session.dmPin && msg.dmPin !== ADMIN_KEY) {
          ws.send(JSON.stringify({ type:"ERROR", error:"Wrong PIN" })); break;
        }
        session = { ...msg.session, dmPin:session.dmPin, updatedAt:Date.now() };
        saveSession(session);
        broadcastExcept(ws, { type:"SESSION_UPDATE", session });
        ws.send(JSON.stringify({ type:"ACK", updatedAt:session.updatedAt }));
        break;
      }

      case "PATCH_HP": {
        if (!session) break;
        if (msg.dmPin !== session.dmPin && msg.dmPin !== ADMIN_KEY) break;
        const char = [...session.characters,...session.npcs].find(c=>c.id===msg.charId);
        if (char) {
          char.hp = msg.hp;
          session.updatedAt = Date.now();
          saveSession(session);
          broadcastExcept(ws, { type:"PATCH_HP", charId:msg.charId, hp:msg.hp });
          ws.send(JSON.stringify({ type:"ACK", updatedAt:session.updatedAt }));
        }
        break;
      }

      // Player submits a roll — server logs it and broadcasts to all
      case "ROLL": {
        if (!session) break;
        const entry = logEntry(msg.author||"Unknown", msg.text, "roll");
        session.sessionLog = session.sessionLog || [];
        session.sessionLog.push(entry);
        if (session.sessionLog.length > 200) session.sessionLog = session.sessionLog.slice(-200);
        saveSession(session);
        broadcast({ type:"LOG_ENTRY", entry });
        break;
      }

      // DM or player adds a log message
      case "LOG_MSG": {
        if (!session) break;
        const entry = logEntry(msg.author||"DM", msg.text, msg.logType||"log");
        session.sessionLog = session.sessionLog || [];
        session.sessionLog.push(entry);
        if (session.sessionLog.length > 200) session.sessionLog = session.sessionLog.slice(-200);
        saveSession(session);
        broadcast({ type:"LOG_ENTRY", entry });
        break;
      }

      case "PING": {
        ws.send(JSON.stringify({ type:"PONG", ts:Date.now() }));
        break;
      }
    }
  });

  ws.on("close", () => { clients.delete(ws); console.log(`← [${id}] disconnected`); });
  ws.on("error", (e) => { console.error(`  [${id}] error:`,e.message); clients.delete(ws); });
});

// ── Start ─────────────────────────────────────────────────────────────────────
server.listen(PORT, () => {
  console.log(`\n⚔  Chronicle v2.0 on port ${PORT}`);
  console.log(`   Data: ${DATA_FILE}`);
  console.log(`   Admin key: ${ADMIN_KEY==="changeme"?"⚠ DEFAULT — set ADMIN_KEY env var":"set ✓"}\n`);
});
