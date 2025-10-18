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

// Endpoints
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


// --- FUNGSI VALIDASI BARU ---
function validateWord(word) {
    if (!/^[a-z]{5}$/.test(word)) {
        return { valid: false, meaning: 'Kata harus 5 huruf (hanya a-z)' };
    }
    const entry = kbbiMap.get(word.toLowerCase());
    if (entry) {
        return { valid: true, meaning: `${entry.makna} (${entry.contoh || 'Tanpa contoh'})` };
    } else {
        return { valid: false, meaning: 'Kata tidak ditemukan di KBBI' };
    }
}

function startNewGame() {
    targetWord = fiveLetterWords[Math.floor(Math.random() * fiveLetterWords.length)].kata_dasar;
    guesses = [];
    currentRow = 0;
    timeLeft = 600;
    bestGuess = null;
    clearInterval(timerInterval);
    startTimer();
    console.log(`New game started, target word: ${targetWord}`);
    broadcastGameState();
}

// Fungsi broadcast (tidak berubah)
function broadcastGameState() { /* ... */ }
function broadcastMessage(message) { /* ... */ }
function broadcastAnswer(word, meaning) { /* ... */ }
function broadcastWinner(word, meaning, nickname, winCount) { /* ... */ }
function broadcastWinCount(username, nickname, winCount) { /* ... */ }


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
            setTimeout(startNewGame, 15000);
        }
    }, 1000);
}

// --- FUNGSI PROCESSGUESS DIPERBAIKI ---
async function processGuess(word, username, nickname) {
    if (timeLeft <= 0 || !targetWord) {
        broadcastMessage('Waktu habis atau game belum dimulai!');
        return;
    }

    // Panggil fungsi validasi secara langsung, bukan via fetch
    const { valid, meaning } = validateWord(word);

    if (!valid) {
        broadcastMessage(`${nickname}: "${word}" tidak valid di KBBI.`);
        return;
    }

    const guessResult = [];
    for (let i = 0; i < 5; i++) {
        if (word[i] === targetWord[i]) {
            guessResult.push({ letter: word[i], status: 'green' });
        } else if (targetWord.includes(word[i])) {
            guessResult.push({ letter: word[i], status: 'yellow' });
        } else {
            guessResult.push({ letter: word[i], status: 'gray' });
        }
    }
    const guess = { word, result: guessResult, username, nickname };
    guesses.push(guess);
    currentRow++;

    // Update tebakan terbaik
    const score = guess.result.filter(r => r.status === 'green').length * 2 + guess.result.filter(r => r.status === 'yellow').length;
    const bestScore = bestGuess ? bestGuess.result.filter(r => r.status === 'green').length * 2 + bestGuess.result.filter(r => r.status === 'yellow').length : 0;
    if (!bestGuess || score > bestScore) {
        bestGuess = guess;
    }

    broadcastGameState();

    if (word === targetWord) {
        leaderboard[username] = (leaderboard[username] || 0) + 1;
        broadcastWinner(word, meaning, nickname, leaderboard[username]);
        timeLeft = 0;
        clearInterval(timerInterval);
        targetWord = '';
        setTimeout(startNewGame, 15000);
    }
}


// Koneksi Otomatis TikTok
const tiktokConnection = new TikTokLiveConnection(tiktokUsername, {
    processInitialData: false,
    fetchRoomInfoOnConnect: true,
    enableLog: true
});

tiktokConnection.connect().then(state => {
    console.info(`Connected to TikTok LIVE: ${state.roomId}`);
    broadcastMessage(`Terhubung ke LIVE ${tiktokUsername}! Permainan dimulai.`);
    startNewGame();
}).catch(err => {
    console.error('Failed to connect to TikTok LIVE:', err.message);
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

tiktokConnection.on('error', (err) => console.error('TikTok connection error:', JSON.stringify(err, null, 2)));
tiktokConnection.on('disconnected', () => broadcastMessage('Koneksi ke TikTok LIVE terputus.'));

server.listen(PORT, () => {
    console.log(`Server + WebSocket running on port ${PORT}`);
    console.log(`Attempting to connect to ${tiktokUsername}. Make sure they are LIVE.`);
});

