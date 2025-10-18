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

// TikTok LIVE credentials (hardcode)
const tiktokUsername = '@achmadsyams';
const sessionId = null;
const ttTargetIdc = null;

// Debug credentials
console.log('Debug TikTok credentials:');
console.log('TIKTOK_USERNAME:', tiktokUsername);
console.log('TIKTOK_SESSION_ID:', sessionId ? 'SET' : 'NOT SET');
console.log('TIKTOK_TT_TARGET_IDC:', ttTargetIdc || 'NOT SET');

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

// Buat Map untuk validasi cepat
const kbbiMap = new Map(kbbiData.map(w => [(w.kata_dasar || w.kata).toLowerCase(), w]));

// Filter kata 5 huruf
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

// Endpoint untuk start game baru
app.get('/api/new-game', (req, res) => {
    targetWord = fiveLetterWords[Math.floor(Math.random() * fiveLetterWords.length)].kata_dasar || fiveLetterWords[Math.floor(Math.random() * fiveLetterWords.length)].kata;
    guesses = [];
    currentRow = 0;
    timeLeft = 600;
    bestGuess = null;
    clearInterval(timerInterval);
    startTimer();
    console.log(`New game started, target word: ${targetWord}`);
    res.json({ status: 'Game started' });
    broadcastGameState();
});

// Endpoint validasi kata
app.get('/api/validate-word/:word', (req, res) => {
    const { word } = req.params;
    console.log(`Validating word: ${word}`);
    if (!/^[a-z]{5}$/.test(word)) {
        console.log(`Word "${word}" rejected: Not 5 letters or contains invalid characters`);
        return res.json({ valid: false, meaning: 'Kata harus 5 huruf (hanya a-z)' });
    }
    const entry = kbbiMap.get(word.toLowerCase());
    if (entry) {
        console.log(`Word "${word}" valid: ${entry.makna}`);
        res.json({ valid: true, meaning: `${entry.makna} (${entry.contoh || 'Tanpa contoh'})` });
    } else {
        console.log(`Word "${word}" invalid: Not in KBBI`);
        res.json({ valid: false, meaning: 'Kata tidak ditemukan di KBBI' });
    }
});

// Polling endpoint untuk state
app.get('/api/game-state', (req, res) => {
    res.json({ guesses, currentRow, timeLeft, targetWord, bestGuess });
});

// Endpoint untuk leaderboard
app.get('/api/leaderboard', (req, res) => {
    res.json(leaderboard);
});

// Endpoint untuk test TikTok
app.get('/api/test-tiktok', async (req, res) => {
    try {
        const state = await tiktokConnection.connect();
        res.json({ status: 'Connected', roomId: state.roomId, username: tiktokUsername });
    } catch (err) {
        console.error('Test TikTok error:', err.message, JSON.stringify(err, null, 2));
        res.status(500).json({ error: err.message, details: err.errors || err });
    }
});

// Serve frontend
app.get('/', (req, res) => {
    res.sendFile(path.join(__dirname, 'frontend', 'index.html'));
});

// Broadcast state
function broadcastGameState() {
    console.log(`Broadcasting game state: row=${currentRow}, guesses=${guesses.length}, timeLeft=${timeLeft}, bestGuess=${bestGuess ? bestGuess.word : 'none'}`);
    wss.clients.forEach(client => {
        if (client.readyState === WebSocket.OPEN) {
            client.send(JSON.stringify({ type: 'gameState', guesses, currentRow, timeLeft, bestGuess }));
        }
    });
}

function broadcastMessage(message) {
    console.log(`Broadcasting message: ${message}`);
    wss.clients.forEach(client => {
        if (client.readyState === WebSocket.OPEN) {
            client.send(JSON.stringify({ type: 'message', content: message }));
        }
    });
}

function broadcastAnswer(word, meaning) {
    console.log(`Broadcasting answer: word=${word}, meaning=${meaning}`);
    wss.clients.forEach(client => {
        if (client.readyState === WebSocket.OPEN) {
            client.send(JSON.stringify({ type: 'answer', word, meaning }));
        }
    });
}

// Timer server-side
function startTimer() {
    console.log('Starting server timer');
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
            console.log(`Time up! Answer: ${targetWord}, Meaning: ${meaning}`);
            targetWord = '';
            // Jeda 15 detik sebelum game baru
            setTimeout(() => {
                targetWord = fiveLetterWords[Math.floor(Math.random() * fiveLetterWords.length)].kata_dasar || fiveLetterWords[Math.floor(Math.random() * fiveLetterWords.length)].kata;
                guesses = [];
                currentRow = 0;
                timeLeft = 600;
                bestGuess = null;
                startTimer();
                console.log(`New game started after delay, target word: ${targetWord}`);
                broadcastGameState();
            }, 15000);
        }
    }, 1000);
}

// Hitung skor tebakan
function calculateGuessScore(guess) {
    let green = 0;
    let yellow = 0;
    guess.result.forEach(res => {
        if (res.status === 'green') green++;
        else if (res.status === 'yellow') yellow++;
    });
    return green * 2 + yellow; // Hijau lebih berbobot
}

function broadcastWinCount(username, nickname, winCount) {
    console.log(`Broadcasting win count for ${username}: ${winCount}`);
    wss.clients.forEach(client => {
        if (client.readyState === WebSocket.OPEN) {
            client.send(JSON.stringify({
                type: 'showWinCount',
                username,
                nickname,
                winCount
            }));
        }
    });
}

function broadcastWinner(word, meaning, nickname, winCount) {
    console.log(`Broadcasting winner: ${nickname}, word: ${word}, wins: ${winCount}`);
    wss.clients.forEach(client => {
        if (client.readyState === WebSocket.OPEN) {
            client.send(JSON.stringify({
                type: 'winner',
                word,
                meaning,
                nickname,
                winCount
            }));
        }
    });
}

// Proses tebakan
async function processGuess(word, username, nickname) {
    console.log(`Processing guess: "${word}" by ${username}, nickname: ${nickname}`);
    if (timeLeft <= 0 || !targetWord) {
        console.log('Guess rejected: Time up or no target word');
        broadcastMessage('Waktu habis atau game belum dimulai! Tunggu jawaban.');
        return;
    }

    try {
        const res = await fetch(`http://localhost:${PORT}/api/validate-word/${word}`);
        const { valid, meaning } = await res.json();

        if (!valid) {
            console.log(`Guess "${word}" invalid: ${meaning}`);
            broadcastMessage(`@${username}: "${word}" tidak valid di KBBI.`);
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
        const score = calculateGuessScore(guess);
        if (!bestGuess || score > calculateGuessScore(bestGuess)) {
            bestGuess = guess;
        }

        broadcastGameState();

        if (word === targetWord) {
            leaderboard[username] = (leaderboard[username] || 0) + 1;
            const winCount = leaderboard[username];
            
            // Panggil fungsi broadcast baru untuk pemenang
            broadcastWinner(word, meaning, nickname, winCount);

            timeLeft = 0;
            clearInterval(timerInterval);
            targetWord = '';
            
            // Jeda 15 detik sebelum game baru
            setTimeout(() => {
                targetWord = fiveLetterWords[Math.floor(Math.random() * fiveLetterWords.length)].kata_dasar || fiveLetterWords[Math.floor(Math.random() * fiveLetterWords.length)].kata;
                guesses = [];
                currentRow = 0;
                timeLeft = 600;
                bestGuess = null;
                startTimer();
                console.log(`New game started after win, target word: ${targetWord}`);
                broadcastGameState();
            }, 15000); // Pastikan ini 15000 jika Anda menggunakan jeda 15 detik
        }
    } catch (error) {
        console.error(`Error processing guess "${word}":`, error.message);
        broadcastMessage(`@${username}: Gagal memproses tebakan. Coba lagi!`);
    }
}

// TikTok LIVE Connector
const tiktokConnection = new TikTokLiveConnection(tiktokUsername, {
    processInitialData: false,
    fetchRoomInfoOnConnect: true,
    sessionId,
    ttTargetIdc,
    authenticateWs: false,
    disableEulerFallbacks: true,
    enableLog: true,
    signUrl: 'https://www.tiktok.com'
});

tiktokConnection.connect().then(state => {
    console.info(`Connected to TikTok LIVE roomId ${state.roomId}, username: ${tiktokUsername}`);
}).catch(err => {
    console.error('Failed to connect to TikTok LIVE:', err.message);
    console.error('Error details:', JSON.stringify(err, null, 2));
    setTimeout(() => tiktokConnection.connect(), 5000);
});

tiktokConnection.on('error', (err) => {
    console.error('TikTok connection error:', JSON.stringify(err, null, 2));
});

tiktokConnection.on(WebcastEvent.CHAT, async (data) => {
    const rawComment = data.comment.trim().toLowerCase();
    const username = data.user.uniqueId;
    const nickname = data.user.nickname || username;
    console.log(`Raw comment received: "${rawComment}" from ${username}, nickname: ${nickname}`);

    if (rawComment === '!win') {
        const winCount = leaderboard[username] || 0;
        console.log(`!win command from ${username}. Win count: ${winCount}`);
        broadcastWinCount(username, nickname, winCount);
        return; // Hentikan proses jika ini adalah perintah !win
    }

    const comment = rawComment.replace(/[^a-z]/g, '').slice(0, 5);
    if (comment.length === 5) {
        console.log(`Valid comment: "${comment}" from ${username}, nickname: ${nickname}`);
        await processGuess(comment, username, nickname);
    } else {
        console.log(`Comment "${rawComment}" rejected: Not a 5-letter word or !win command.`);
    }
});

tiktokConnection.on('disconnected', () => {
    console.log('TikTok WebSocket disconnected, reconnecting...');
    setTimeout(() => tiktokConnection.connect(), 5000);
});

// Start server
server.listen(PORT, () => {
    console.log(`Server + WebSocket running on port ${PORT}`);
    
    // --- TAMBAHKAN KODE INI ---
    // Memulai game pertama secara otomatis
    console.log('Starting the first game automatically...');
    targetWord = fiveLetterWords[Math.floor(Math.random() * fiveLetterWords.length)].kata_dasar || fiveLetterWords[Math.floor(Math.random() * fiveLetterWords.length)].kata;
    guesses = [];
    currentRow = 0;
    timeLeft = 600;
    bestGuess = null;
    clearInterval(timerInterval);
    startTimer();
    console.log(`First game started automatically, target word: ${targetWord}`);
    broadcastGameState();
    // --- AKHIR DARI KODE TAMBAHAN ---
});