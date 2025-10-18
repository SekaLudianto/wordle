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
const PORT = process.env.PORT || 3000; // Siap menerima port dari Render

app.use(cors({ origin: '*' }));
app.use(express.json());

// --- PERHATIAN: HANYA UNTUK DEVELOPMENT LOKAL ---
// Baris di bawah ini akan diservis oleh Netlify saat sudah di-deploy.
// Jadi, tidak apa-apa jika ini tidak berfungsi sempurna di Render.
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
let currentConnection = null; // --- BARU: Untuk menyimpan koneksi TikTok saat ini

// --- ENDPOINT BARU UNTUK KONEKSI TIKTOK ---
app.post('/api/connect-tiktok', async (req, res) => {
    const { username } = req.body;

    if (!username) {
        return res.status(400).json({ message: 'Username is required' });
    }

    if (currentConnection) {
        try {
            currentConnection.disconnect();
            console.log('Disconnected from previous session.');
        } catch (err) {
            console.error('Error disconnecting previous session:', err);
        }
    }
    
    console.log(`Attempting to connect to TikTok LIVE: ${username}`);
    
    const tiktokConnection = new TikTokLiveConnection(username, {
        processInitialData: false,
        fetchRoomInfoOnConnect: true,
        enableLog: true,
        clientParams: {
            "app_language": "id-ID", // Menggunakan bahasa Indonesia
            "device_platform": "web"
        },
        requestHeaders: {
            "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/109.0.0.0 Safari/537.36"
        }
    });

    tiktokConnection.on(WebcastEvent.CHAT, async (data) => {
        const rawComment = data.comment.trim().toLowerCase();
        const user = data.user.uniqueId;
        const nickname = data.user.nickname || user;
        
        // Cek command !win
        if (rawComment === '!win') {
            const winCount = leaderboard[user] || 0;
            broadcastWinCount(user, nickname, winCount);
            return;
        }

        const comment = rawComment.replace(/[^a-z]/g, '').slice(0, 5);
        if (comment.length === 5) {
            await processGuess(comment, user, nickname);
        }
    });

    tiktokConnection.on('error', (err) => {
        console.error('TikTok connection error:', JSON.stringify(err, null, 2));
    });

    tiktokConnection.on('disconnected', () => {
        console.log('TikTok WebSocket disconnected.');
        broadcastMessage('Koneksi ke TikTok LIVE terputus.');
    });

    try {
        const state = await tiktokConnection.connect();
        currentConnection = tiktokConnection;
        console.log(`Connected to TikTok LIVE: ${state.roomId}`);
        
        // Mulai game baru setelah berhasil terhubung
        startNewGame();
        broadcastMessage(`Terhubung ke LIVE ${username}! Permainan dimulai.`);
        
        res.json({ message: `Successfully connected to ${username}` });
    } catch (err) {
        console.error('Failed to connect to TikTok LIVE:', err.message);
        res.status(500).json({ message: err.message || 'Failed to connect. Is the user live?' });
    }
});


// Endpoint untuk start game baru (bisa dipanggil jika perlu)
app.get('/api/new-game', (req, res) => {
    startNewGame();
    res.json({ status: 'New game started' });
    broadcastGameState();
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
}

app.get('/api/validate-word/:word', (req, res) => {
    // ... (fungsi ini tetap sama)
});

app.get('/api/game-state', (req, res) => {
    res.json({ guesses, currentRow, timeLeft, targetWord, bestGuess });
});

app.get('/api/leaderboard', (req, res) => {
    res.json(leaderboard);
});

// Broadcast functions (tetap sama)
function broadcastGameState() { /* ... */ }
function broadcastMessage(message) { /* ... */ }
function broadcastAnswer(word, meaning) { /* ... */ }
function broadcastWinner(word, meaning, nickname, winCount) { /* ... */ }
function broadcastWinCount(username, nickname, winCount) { /* ... */ }


function startTimer() {
    // ... (fungsi ini tetap sama, pastikan timeLeft = 600)
}

function calculateGuessScore(guess) {
    // ... (fungsi ini tetap sama)
}

async function processGuess(word, username, nickname) {
    // ... (fungsi ini tetap sama, pastikan setTimeout jeda adalah 15000)
}


// --- KODE KONEKSI OTOMATIS DIHAPUS DARI SINI ---


// Start server
server.listen(PORT, () => {
    console.log(`Server + WebSocket running on port ${PORT}`);
    // Server sekarang hanya menyala dan menunggu perintah dari frontend.
});
