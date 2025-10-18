import express from 'express';
import { createServer } from 'http';
import WebSocket from 'ws';
import { TikTokLiveConnection, WebcastEvent } from 'tiktok-live-connector';
import cors from 'cors';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const app = express();
const server = createServer(app);
const wss = new WebSocket.WebSocketServer({ server });
const PORT = process.env.PORT || 3000;

// --- KEMBALIKAN USERNAME TIKTOK DI SINI ---
const tiktokUsername = '@achmadsyams'; // Ganti dengan username yang akan LIVE

app.use(cors({ origin: '*' }));
app.use(express.json());
app.use(express.static(path.join(__dirname, 'frontend')));

// Load KBBI JSON
let kbbiData = [];
const jsonFiles = ['kbbi_v_part1.json', 'kbbi_v_part2.json', 'kbbi_v_part3.json', 'kbbi_v_part4.json'];
try {
    for (const file of jsonFiles) {
        const jsonPath = path.join(__dirname, 'data', file);
        const data = JSON.parse(fs.readFileSync(jsonPath, 'utf-8'));
        const entries = Object.keys(data).map(key => ({
            kata: data[key].data.entri[0].nama.replace(/\./g, ''),
            kata_dasar: data[key].data.entri[0].kata_dasar[0] || key,
            makna: data[key].data.entri[0].makna.map(m => m.submakna.join('; ')).join('; '),
            contoh: data[key].data.entri[0].makna.flatMap(m => m.contoh || []).join('; ')
        }));
        kbbiData.push(...entries);
    }
    console.log(`Loaded KBBI: ${kbbiData.length} words`);
} catch (error) {
    console.error('Error loading KBBI JSON:', error.message);
    process.exit(1);
}

const kbbiMap = new Map(kbbiData.map(w => [(w.kata_dasar || w.kata).toLowerCase(), w]));
const fiveLetterWords = kbbiData.filter(word => {
    const target = word.kata_dasar || word.kata;
    return target.length === 5 && /^[a-z]+$/.test(target);
});
console.log(`5-letter words: ${fiveLetterWords.length}`);

// State permainan
let targetWord = '';
let guesses = [];
let currentRow = 0;
let timeLeft = 600; // 10 menit
let timerInterval;
let leaderboard = {};
let bestGuess = null;

// Endpoint (Endpoint koneksi dihapus)
app.get('/api/new-game', (req, res) => {
    startNewGame();
    res.json({ status: 'New game started' });
});

app.get('/api/game-state', (req, res) => {
    res.json({ guesses, currentRow, timeLeft, targetWord, bestGuess });
});

app.get('/api/leaderboard', (req, res) => {
    res.json(leaderboard);
});

function startNewGame() {
    targetWord = fiveLetterWords[Math.floor(Math.random() * fiveLetterWords.length)].kata_dasar;
    guesses = [];
    currentRow = 0;
    timeLeft = 600; // 10 menit
    bestGuess = null;
    clearInterval(timerInterval);
    startTimer();
    console.log(`New game started, target word: ${targetWord}`);
    broadcastGameState();
}

// ... (Fungsi-fungsi lain seperti broadcastGameState, startTimer, processGuess tetap sama)

// Fungsi broadcast
function broadcastGameState() { /* ... kode tidak berubah ... */ }
function broadcastMessage(message) { /* ... kode tidak berubah ... */ }
function broadcastAnswer(word, meaning) { /* ... kode tidak berubah ... */ }
function broadcastWinner(word, meaning, nickname, winCount) { /* ... kode tidak berubah ... */ }
function broadcastWinCount(username, nickname, winCount) { /* ... kode tidak berubah ... */ }

function startTimer() {
    clearInterval(timerInterval);
    timeLeft = 600;
    timerInterval = setInterval(() => {
        timeLeft--;
        broadcastGameState();
        if (timeLeft <= 0 && targetWord) {
            clearInterval(timerInterval);
            const entry = kbbiMap.get(targetWord.toLowerCase());
            const meaning = entry ? `${entry.makna} (${entry.contoh || 'Tanpa contoh'})` : 'Makna tidak ditemukan';
            broadcastAnswer(targetWord, meaning);
            console.log(`Time up! Answer: ${targetWord}`);
            targetWord = '';
            setTimeout(startNewGame, 15000); // 15 detik jeda
        }
    }, 1000);
}

async function processGuess(word, username, nickname) {
    // ... (kode processGuess tidak berubah, pastikan ada logika !win di dalamnya)
    if (word === '!win') {
        const winCount = leaderboard[username] || 0;
        broadcastWinCount(username, nickname, winCount);
        return;
    }

    if (timeLeft <= 0 || !targetWord) return;

    const res = await fetch(`http://localhost:${PORT}/api/validate-word/${word}`); // ini perlu disesuaikan jika deploy
    const { valid, meaning } = await res.json();
    if (!valid) return;

    // ... (sisa logika processGuess)
    if (word === targetWord) {
        leaderboard[username] = (leaderboard[username] || 0) + 1;
        broadcastWinner(word, meaning, nickname, leaderboard[username]);
        timeLeft = 0;
        clearInterval(timerInterval);
        targetWord = '';
        setTimeout(startNewGame, 15000); // 15 detik jeda
    }
}


// --- KEMBALIKAN KONEKSI OTOMATIS TIKTOK ---
const tiktokConnection = new TikTokLiveConnection(tiktokUsername, {
    processInitialData: false,
    fetchRoomInfoOnConnect: true,
    enableLog: true
});

tiktokConnection.connect().then(state => {
    console.info(`Connected to TikTok LIVE: ${state.roomId}`);
    broadcastMessage(`Terhubung ke LIVE ${tiktokUsername}! Permainan dimulai.`);
    // Mulai game pertama setelah berhasil terhubung
    startNewGame();
}).catch(err => {
    console.error('Failed to connect to TikTok LIVE:', err.message);
    console.error('PASTIKAN PENGGUNA SEDANG LIVE SAAT SERVER DINYALAKAN.');
});

tiktokConnection.on(WebcastEvent.CHAT, async (data) => {
    const rawComment = data.comment.trim().toLowerCase();
    const username = data.user.uniqueId;
    const nickname = data.user.nickname || username;

    if (rawComment === '!win') {
        const winCount = leaderboard[username] || 0;
        broadcastWinCount(username, nickname, winCount);
        return;
    }

    const comment = rawComment.replace(/[^a-z]/g, '').slice(0, 5);
    if (comment.length === 5) {
        await processGuess(comment, username, nickname);
    }
});

tiktokConnection.on('error', (err) => {
    console.error('TikTok connection error:', JSON.stringify(err, null, 2));
});

tiktokConnection.on('disconnected', () => {
    console.log('TikTok WebSocket disconnected.');
    broadcastMessage('Koneksi ke TikTok LIVE terputus.');
});

// Start server
server.listen(PORT, () => {
    console.log(`Server + WebSocket running on port ${PORT}`);
    console.log(`Attempting to connect to ${tiktokUsername}. Make sure they are LIVE.`);
});

