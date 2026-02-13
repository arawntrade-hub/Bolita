// ==============================
// backend.js - API REST + Bot de Telegram (UNIFICADO)
// Versión FINAL con notificaciones globales y visibilidad de ganadores
// ==============================

require('dotenv').config();
const express = require('express');
const multer = require('multer');
const path = require('path');
const { createClient } = require('@supabase/supabase-js');
const crypto = require('crypto');
const axios = require('axios');
const cors = require('cors');
const moment = require('moment-timezone');

// ========== IMPORTAR BOT DE TELEGRAM ==========
const bot = require('./bot');

// ========== CONFIGURACIÓN DESDE .ENV ==========
const PORT = process.env.PORT || 3000;
const BOT_TOKEN = process.env.BOT_TOKEN;
const ADMIN_ID = parseInt(process.env.ADMIN_ID);
const ADMIN_CHANNEL = process.env.ADMIN_CHANNEL;
const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_SERVICE_KEY = process.env.SUPABASE_SERVICE_KEY;
const BONUS_CUP_DEFAULT = parseFloat(process.env.BONUS_CUP_DEFAULT) || 70;
const WEBAPP_URL = process.env.WEBAPP_URL || `http://localhost:${PORT}`;
const TIMEZONE = process.env.TIMEZONE || 'America/Havana';

// ========== INICIALIZAR SUPABASE ==========
const supabase = createClient(SUPABASE_URL, SUPABASE_SERVICE_KEY);

// ========== INICIALIZAR EXPRESS ==========
const app = express();
app.use(cors());
app.use(express.json());
app.use(express.urlencoded({ extended: true }));
app.use(express.static(path.join(__dirname, 'webapp')));

// ========== CONFIGURACIÓN DE MULTER ==========
const upload = multer({
    storage: multer.memoryStorage(),
    limits: { fileSize: 5 * 1024 * 1024 } // 5MB
});

// ========== FUNCIONES AUXILIARES ==========

/**
 * Verifica la firma de Telegram WebApp.
 */
function verifyTelegramWebAppData(initData, botToken) {
    const encoded = decodeURIComponent(initData);
    const arr = encoded.split('&');
    const hashIndex = arr.findIndex(e => e.startsWith('hash='));
    const hash = arr.splice(hashIndex)[0].split('=')[1];
    arr.sort((a, b) => a.localeCompare(b));
    const dataCheckString = arr.join('\n');
    const secretKey = crypto.createHmac('sha256', 'WebAppData').update(botToken).digest();
    const computedHash = crypto.createHmac('sha256', secretKey).update(dataCheckString).digest('hex');
    return computedHash === hash;
}

/**
 * Obtiene o crea un usuario en Supabase.
 */
async function getOrCreateUser(telegramId, firstName = 'Jugador') {
    let { data: user } = await supabase
        .from('users')
        .select('*')
        .eq('telegram_id', telegramId)
        .single();

    if (!user) {
        const { data: newUser } = await supabase
            .from('users')
            .insert({ telegram_id: telegramId, first_name: firstName })
            .select()
            .single();
        user = newUser;
    }
    return user;
}

/**
 * Obtiene la tasa de cambio actual.
 */
async function getExchangeRate() {
    const { data } = await supabase
        .from('exchange_rate')
        .select('rate')
        .eq('id', 1)
        .single();
    return data?.rate || 110;
}

/**
 * Parsea una línea de apuesta (mismo algoritmo que en bot.js)
 */
function parseBetLine(line, betType) {
    line = line.trim().toLowerCase();
    if (!line) return null;

    let numero, montoStr, moneda = 'usd';
    const match = line.match(/^([\dx]+)\s*(?:con|\*)\s*([0-9.]+)\s*(usd|cup)?$/);
    if (!match) return null;

    numero = match[1].trim();
    montoStr = match[2];
    if (match[3]) moneda = match[3];

    if (betType === 'fijo' || betType === 'corridos') {
        if (!/^\d{2}$/.test(numero) && !/^[DdTt]\d$/.test(numero)) return null;
        if (/^[Dd](\d)$/.test(numero)) numero = '0' + numero.slice(1);
        if (/^[Tt](\d)$/.test(numero)) numero = numero.slice(1) + '0';
    } else if (betType === 'centena') {
        if (!/^\d{3}$/.test(numero)) return null;
    } else if (betType === 'parle') {
        if (!/^\d{2}x\d{2}$/.test(numero)) return null;
    } else {
        return null;
    }

    const monto = parseFloat(montoStr);
    if (isNaN(monto) || monto <= 0) return null;

    return {
        numero,
        usd: moneda === 'usd' ? monto : 0,
        cup: moneda === 'cup' ? monto : 0
    };
}

/**
 * Parsea el mensaje completo de apuesta (varias líneas)
 */
function parseBetMessage(text, betType) {
    const lines = text.split('\n').map(l => l.trim()).filter(l => l);
    const items = [];
    let totalUSD = 0, totalCUP = 0;

    for (const line of lines) {
        const parsed = parseBetLine(line, betType);
        if (parsed) {
            items.push(parsed);
            totalUSD += parsed.usd;
            totalCUP += parsed.cup;
        }
    }

    return {
        items,
        totalUSD,
        totalCUP,
        ok: items.length > 0
    };
}

/**
 * Genera fecha de cierre de sesión según turno (Día/Noche)
 */
function getEndTimeFromSlot(timeSlot) {
    const today = moment.tz(TIMEZONE).format('YYYY-MM-DD');
    let hour, minute;
    if (timeSlot === 'Día') {
        hour = 12;
        minute = 0;
    } else { // Noche
        hour = 23;
        minute = 0;
    }
    return moment.tz(`${today} ${hour}:${minute}:00`, TIMEZONE).toDate();
}

// ========== MIDDLEWARE DE ADMIN ==========
async function requireAdmin(req, res, next) {
    let userId = req.body.userId || req.query.userId || req.headers['x-telegram-id'];
    if (!userId) {
        return res.status(403).json({ error: 'No autorizado: falta userId' });
    }
    userId = parseInt(userId);
    if (userId !== ADMIN_ID) {
        return res.status(403).json({ error: 'No autorizado: no eres admin' });
    }
    next();
}

// ========== ENDPOINTS PÚBLICOS ==========

// --- Autenticación ---
app.post('/api/auth', async (req, res) => {
    const { initData } = req.body;
    if (!initData) return res.status(400).json({ error: 'Falta initData' });

    const verified = verifyTelegramWebAppData(initData, BOT_TOKEN);
    if (!verified) return res.status(401).json({ error: 'Firma inválida' });

    const params = new URLSearchParams(decodeURIComponent(initData));
    const userStr = params.get('user');
    if (!userStr) return res.status(400).json({ error: 'No hay datos de usuario' });

    const tgUser = JSON.parse(userStr);
    const user = await getOrCreateUser(tgUser.id, tgUser.first_name);
    const exchangeRate = await getExchangeRate();

    const botInfo = await axios.get(`https://api.telegram.org/bot${BOT_TOKEN}/getMe`)
        .then(r => r.data.result)
        .catch(() => ({ username: 'RifasCubaBot' }));

    res.json({
        user,
        isAdmin: tgUser.id === ADMIN_ID,
        exchangeRate,
        botUsername: botInfo.username
    });
});

// --- Métodos de depósito ---
app.get('/api/deposit-methods', async (req, res) => {
    const { data } = await supabase.from('deposit_methods').select('*').order('id');
    res.json(data || []);
});
app.get('/api/deposit-methods/:id', async (req, res) => {
    const { data } = await supabase.from('deposit_methods').select('*').eq('id', req.params.id).single();
    res.json(data);
});

// --- Métodos de retiro ---
app.get('/api/withdraw-methods', async (req, res) => {
    const { data } = await supabase.from('withdraw_methods').select('*').order('id');
    res.json(data || []);
});
app.get('/api/withdraw-methods/:id', async (req, res) => {
    const { data } = await supabase.from('withdraw_methods').select('*').eq('id', req.params.id).single();
    res.json(data);
});

// --- Precios de jugadas ---
app.get('/api/play-prices', async (req, res) => {
    const { data } = await supabase.from('play_prices').select('*');
    res.json(data || []);
});

// --- Tasa de cambio ---
app.get('/api/exchange-rate', async (req, res) => {
    const rate = await getExchangeRate();
    res.json({ rate });
});

// --- Números ganadores (últimos 10) ---
app.get('/api/winning-numbers', async (req, res) => {
    const { data } = await supabase
        .from('winning_numbers')
        .select('*')
        .order('published_at', { ascending: false })
        .limit(10);
    res.json(data || []);
});

// --- Sesión activa para una lotería (usado en WebApp) ---
app.get('/api/lottery-sessions/active', async (req, res) => {
    const { lottery, date } = req.query;
    if (!lottery || !date) {
        return res.status(400).json({ error: 'Faltan parámetros' });
    }
    const { data } = await supabase
        .from('lottery_sessions')
        .select('*')
        .eq('lottery', lottery)
        .eq('date', date)
        .eq('status', 'open')
        .maybeSingle();
    res.json(data);
});

// --- Solicitud de depósito (con captura) ---
app.post('/api/deposit-requests', upload.single('screenshot'), async (req, res) => {
    const { methodId, userId, amount } = req.body;
    const file = req.file;
    if (!methodId || !userId || !file || !amount) {
        return res.status(400).json({ error: 'Faltan datos' });
    }

    const user = await getOrCreateUser(parseInt(userId));
    const fileName = `deposit_${userId}_${Date.now()}.jpg`;
    const filePath = `deposits/${fileName}`;

    const { error: uploadError } = await supabase.storage
        .from('deposit-screenshots')
        .upload(filePath, file.buffer, { contentType: 'image/jpeg' });

    if (uploadError) {
        return res.status(500).json({ error: 'Error al subir captura' });
    }

    const { data: { publicUrl } } = supabase.storage
        .from('deposit-screenshots')
        .getPublicUrl(filePath);

    const { data: request, error: insertError } = await supabase
        .from('deposit_requests')
        .insert({
            user_id: parseInt(userId),
            method_id: parseInt(methodId),
            screenshot_url: publicUrl,
            amount,
            status: 'pending'
        })
        .select()
        .single();

    if (insertError) {
        return res.status(500).json({ error: 'Error al guardar solicitud' });
    }

    // Notificar al canal de admin
    try {
        const method = await supabase.from('deposit_methods').select('name').eq('id', methodId).single();
        const methodName = method.data?.name || 'Desconocido';
        await axios.post(`https://api.telegram.org/bot${BOT_TOKEN}/sendMessage`, {
            chat_id: ADMIN_CHANNEL,
            text: `📥 <b>Nueva solicitud de DEPÓSITO</b> (WebApp)\n👤 Usuario: ${user.first_name} (${userId})\n🏦 Método: ${methodName}\n💰 Monto: ${amount}\n📎 <a href="${publicUrl}">Ver captura</a>\n🆔 Solicitud: ${request.id}`,
            parse_mode: 'HTML',
            reply_markup: {
                inline_keyboard: [[
                    { text: '✅ Aprobar', callback_data: `approve_deposit_${request.id}` },
                    { text: '❌ Rechazar', callback_data: `reject_deposit_${request.id}` }
                ]]
            }
        });
    } catch (e) {
        console.error('Error enviando notificación de depósito:', e);
    }

    res.json({ success: true, requestId: request.id });
});

// --- Solicitud de retiro ---
app.post('/api/withdraw-requests', async (req, res) => {
    const { methodId, amount, account, userId } = req.body;
    if (!methodId || !amount || !account || !userId) {
        return res.status(400).json({ error: 'Faltan datos' });
    }

    const user = await getOrCreateUser(parseInt(userId));
    if (parseFloat(user.usd) < amount) {
        return res.status(400).json({ error: 'Saldo insuficiente' });
    }

    const { data: request, error: insertError } = await supabase
        .from('withdraw_requests')
        .insert({
            user_id: parseInt(userId),
            method_id: parseInt(methodId),
            amount_usd: amount,
            account_info: account,
            status: 'pending'
        })
        .select()
        .single();

    if (insertError) {
        return res.status(500).json({ error: 'Error al crear solicitud' });
    }

    // Descontar saldo inmediatamente (política de la plataforma)
    await supabase
        .from('users')
        .update({ usd: parseFloat(user.usd) - amount, updated_at: new Date() })
        .eq('telegram_id', userId);

    try {
        const method = await supabase.from('withdraw_methods').select('name').eq('id', methodId).single();
        const methodName = method.data?.name || 'Desconocido';
        await axios.post(`https://api.telegram.org/bot${BOT_TOKEN}/sendMessage`, {
            chat_id: ADMIN_CHANNEL,
            text: `📤 <b>Nueva solicitud de RETIRO</b> (WebApp)\n👤 Usuario: ${user.first_name} (${userId})\n💰 Monto: ${amount} USD\n🏦 Método: ${methodName}\n📞 Cuenta: ${account}\n🆔 Solicitud: ${request.id}`,
            parse_mode: 'HTML',
            reply_markup: {
                inline_keyboard: [[
                    { text: '✅ Aprobar', callback_data: `approve_withdraw_${request.id}` },
                    { text: '❌ Rechazar', callback_data: `reject_withdraw_${request.id}` }
                ]]
            }
        });
    } catch (e) {
        console.error('Error enviando notificación de retiro:', e);
    }

    res.json({ success: true, requestId: request.id });
});

// --- Transferencia entre usuarios ---
app.post('/api/transfer', async (req, res) => {
    const { from, to, amount } = req.body;
    if (!from || !to || !amount || amount <= 0) {
        return res.status(400).json({ error: 'Datos inválidos' });
    }
    if (from === to) {
        return res.status(400).json({ error: 'No puedes transferirte a ti mismo' });
    }

    const userFrom = await getOrCreateUser(parseInt(from));
    const userTo = await getOrCreateUser(parseInt(to));
    if (!userFrom || !userTo) {
        return res.status(404).json({ error: 'Usuario no encontrado' });
    }
    if (parseFloat(userFrom.usd) < amount) {
        return res.status(400).json({ error: 'Saldo insuficiente' });
    }

    await supabase
        .from('users')
        .update({ usd: parseFloat(userFrom.usd) - amount, updated_at: new Date() })
        .eq('telegram_id', from);

    await supabase
        .from('users')
        .update({ usd: parseFloat(userTo.usd) + amount, updated_at: new Date() })
        .eq('telegram_id', to);

    res.json({ success: true });
});

// --- Registro de apuestas (con items y verificación de sesión) ---
app.post('/api/bets', async (req, res) => {
    const { userId, lottery, betType, rawText, sessionId } = req.body;
    if (!userId || !lottery || !betType || !rawText) {
        return res.status(400).json({ error: 'Faltan datos' });
    }

    // Verificar sesión activa
    if (sessionId) {
        const { data: activeSession } = await supabase
            .from('lottery_sessions')
            .select('*')
            .eq('id', sessionId)
            .eq('status', 'open')
            .maybeSingle();
        if (!activeSession) {
            return res.status(400).json({ error: 'La sesión de juego no está activa' });
        }
    }

    const user = await getOrCreateUser(parseInt(userId));
    const parsed = parseBetMessage(rawText, betType);
    if (!parsed.ok) {
        return res.status(400).json({ error: 'No se pudo interpretar la apuesta. Verifica el formato.' });
    }

    const totalUSD = parsed.totalUSD;
    const totalCUP = parsed.totalCUP;
    if (totalUSD === 0 && totalCUP === 0) {
        return res.status(400).json({ error: 'Debes especificar un monto válido (USD o CUP)' });
    }

    // Verificar y descontar saldo
    let newUsd = parseFloat(user.usd);
    let newBonus = parseFloat(user.bonus_usd);
    let newCup = parseFloat(user.cup);

    if (totalUSD > 0) {
        const totalDisponible = newUsd + newBonus;
        if (totalDisponible < totalUSD) {
            return res.status(400).json({ error: 'Saldo USD (incluyendo bono) insuficiente' });
        }
        const usarBono = Math.min(newBonus, totalUSD);
        newBonus -= usarBono;
        newUsd -= (totalUSD - usarBono);
    }

    if (totalCUP > 0) {
        if (newCup < totalCUP) {
            return res.status(400).json({ error: 'Saldo CUP insuficiente' });
        }
        newCup -= totalCUP;
    }

    await supabase
        .from('users')
        .update({
            usd: newUsd,
            bonus_usd: newBonus,
            cup: newCup,
            updated_at: new Date()
        })
        .eq('telegram_id', userId);

    // Insertar apuesta
    const { data: bet, error: betError } = await supabase
        .from('bets')
        .insert({
            user_id: parseInt(userId),
            lottery,
            session_id: sessionId || null,
            bet_type: betType,
            raw_text: rawText,
            items: parsed.items,
            cost_usd: totalUSD,
            cost_cup: totalCUP,
            placed_at: new Date()
        })
        .select()
        .single();

    if (betError) {
        console.error('Error insertando apuesta:', betError);
        return res.status(500).json({ error: 'Error al registrar la apuesta' });
    }

    const updatedUser = await getOrCreateUser(parseInt(userId));
    res.json({ success: true, bet, updatedUser });
});

// --- Historial de apuestas del usuario ---
app.get('/api/user/:userId/bets', async (req, res) => {
    const { userId } = req.params;
    const limit = parseInt(req.query.limit) || 5;
    const { data } = await supabase
        .from('bets')
        .select('*')
        .eq('user_id', userId)
        .order('placed_at', { ascending: false })
        .limit(limit);
    res.json(data || []);
});

// --- Cantidad de referidos ---
app.get('/api/user/:userId/referrals/count', async (req, res) => {
    const { userId } = req.params;
    const { count } = await supabase
        .from('users')
        .select('*', { count: 'exact', head: true })
        .eq('ref_by', userId);
    res.json({ count: count || 0 });
});

// ========== ENDPOINTS DE ADMIN ==========

// --- Añadir método de depósito ---
app.post('/api/admin/deposit-methods', requireAdmin, async (req, res) => {
    const { name, card, confirm } = req.body;
    if (!name || !card || !confirm) {
        return res.status(400).json({ error: 'Todos los campos son obligatorios' });
    }
    const { data, error } = await supabase
        .from('deposit_methods')
        .insert({ name, card, confirm })
        .select()
        .single();
    if (error) return res.status(500).json({ error: error.message });
    res.json(data);
});

// --- Añadir método de retiro ---
app.post('/api/admin/withdraw-methods', requireAdmin, async (req, res) => {
    const { name, card, confirm } = req.body;
    if (!name || !card) {
        return res.status(400).json({ error: 'Nombre e instrucción son obligatorios' });
    }
    const { data, error } = await supabase
        .from('withdraw_methods')
        .insert({ name, card, confirm: confirm || 'ninguno' })
        .select()
        .single();
    if (error) return res.status(500).json({ error: error.message });
    res.json(data);
});

// --- Actualizar tasa de cambio ---
app.put('/api/admin/exchange-rate', requireAdmin, async (req, res) => {
    const { rate } = req.body;
    if (!rate || rate <= 0) {
        return res.status(400).json({ error: 'Tasa inválida' });
    }
    await supabase
        .from('exchange_rate')
        .update({ rate, updated_at: new Date() })
        .eq('id', 1);
    res.json({ success: true, rate });
});

// --- Actualizar precios y multiplicadores de una jugada ---
app.put('/api/admin/play-prices/:betType', requireAdmin, async (req, res) => {
    const { betType } = req.params;
    const { amount_cup, amount_usd, payout_multiplier } = req.body;
    if (amount_cup === undefined || amount_usd === undefined || payout_multiplier === undefined) {
        return res.status(400).json({ error: 'Faltan campos (amount_cup, amount_usd, payout_multiplier)' });
    }
    if (amount_cup < 0 || amount_usd < 0 || payout_multiplier < 0) {
        return res.status(400).json({ error: 'Los valores no pueden ser negativos' });
    }
    const { error } = await supabase
        .from('play_prices')
        .update({
            amount_cup,
            amount_usd,
            payout_multiplier,
            updated_at: new Date()
        })
        .eq('bet_type', betType);
    if (error) return res.status(500).json({ error: error.message });
    res.json({ success: true });
});

// --- Obtener sesiones de una fecha específica (admin) ---
app.get('/api/admin/lottery-sessions', requireAdmin, async (req, res) => {
    const { date } = req.query;
    if (!date) {
        return res.status(400).json({ error: 'Falta fecha' });
    }
    const { data } = await supabase
        .from('lottery_sessions')
        .select('*')
        .eq('date', date);
    res.json(data || []);
});

// --- Crear nueva sesión (abrir) ---
app.post('/api/admin/lottery-sessions', requireAdmin, async (req, res) => {
    const { lottery, time_slot } = req.body;
    if (!lottery || !time_slot) {
        return res.status(400).json({ error: 'Faltan datos' });
    }
    if (time_slot !== 'Día' && time_slot !== 'Noche') {
        return res.status(400).json({ error: 'Turno debe ser Día o Noche' });
    }

    const today = moment.tz(TIMEZONE).format('YYYY-MM-DD');
    const endTime = getEndTimeFromSlot(time_slot);

    // Verificar si ya existe
    const { data: existing } = await supabase
        .from('lottery_sessions')
        .select('id')
        .eq('lottery', lottery)
        .eq('date', today)
        .eq('time_slot', time_slot)
        .maybeSingle();

    if (existing) {
        return res.status(400).json({ error: 'Ya existe una sesión para este turno hoy' });
    }

    const { data, error } = await supabase
        .from('lottery_sessions')
        .insert({
            lottery,
            date: today,
            time_slot,
            status: 'open',
            end_time: endTime.toISOString()
        })
        .select()
        .single();

    if (error) return res.status(500).json({ error: error.message });
    res.json(data);
});

// --- Cambiar estado de una sesión (abrir/cerrar) ---
app.post('/api/admin/lottery-sessions/toggle', requireAdmin, async (req, res) => {
    const { sessionId, status } = req.body;
    if (!sessionId || !status) {
        return res.status(400).json({ error: 'Faltan datos' });
    }
    if (status !== 'open' && status !== 'closed') {
        return res.status(400).json({ error: 'Estado inválido' });
    }

    const { data, error } = await supabase
        .from('lottery_sessions')
        .update({ status, updated_at: new Date() })
        .eq('id', sessionId)
        .select()
        .single();

    if (error) return res.status(500).json({ error: error.message });
    res.json(data);
});

// --- Obtener sesiones cerradas (para publicar ganadores) ---
app.post('/api/admin/lottery-sessions/closed', requireAdmin, async (req, res) => {
    const { data } = await supabase
        .from('lottery_sessions')
        .select('*')
        .eq('status', 'closed')
        .order('date', { ascending: false });
    res.json(data || []);
});

// --- NUEVO ENDPOINT: Obtener ganadores de una sesión (para WebApp) ---
app.get('/api/admin/winning-numbers/:sessionId/winners', requireAdmin, async (req, res) => {
    const { sessionId } = req.params;

    // 1. Obtener sesión
    const { data: session } = await supabase
        .from('lottery_sessions')
        .select('*')
        .eq('id', sessionId)
        .single();

    if (!session) {
        return res.status(404).json({ error: 'Sesión no encontrada' });
    }

    // 2. Obtener número ganador publicado
    const { data: winning } = await supabase
        .from('winning_numbers')
        .select('numbers')
        .eq('lottery', session.lottery)
        .eq('date', session.date)
        .eq('time_slot', session.time_slot)
        .maybeSingle();

    if (!winning) {
        return res.json({ winners: [], message: 'Esta sesión aún no tiene número ganador publicado' });
    }

    const winningStr = winning.numbers[0]; // asumimos 1 número
    const centena = winningStr.slice(0, 3);
    const cuarteta = winningStr.slice(3);
    const fijo = centena.slice(1);
    const corridos = [
        fijo,
        cuarteta.slice(0, 2),
        cuarteta.slice(2)
    ];
    const parles = [
        `${corridos[0]}x${corridos[1]}`,
        `${corridos[0]}x${corridos[2]}`,
        `${corridos[1]}x${corridos[2]}`
    ];

    // 3. Obtener multiplicadores
    const { data: multipliers } = await supabase
        .from('play_prices')
        .select('bet_type, payout_multiplier');
    const multiplierMap = {};
    multipliers.forEach(m => { multiplierMap[m.bet_type] = parseFloat(m.payout_multiplier) || 0; });

    // 4. Obtener todas las apuestas de la sesión
    const { data: bets } = await supabase
        .from('bets')
        .select('*')
        .eq('session_id', sessionId);

    const winners = [];

    for (const bet of bets || []) {
        let premioTotalUSD = 0;
        let premioTotalCUP = 0;
        const items = bet.items || [];

        for (const item of items) {
            const numero = item.numero;
            const multiplicador = multiplierMap[bet.bet_type] || 0;
            let ganado = false;

            switch (bet.bet_type) {
                case 'fijo':
                    if (numero === fijo) ganado = true;
                    break;
                case 'corridos':
                    if (corridos.includes(numero)) ganado = true;
                    break;
                case 'centena':
                    if (numero === centena) ganado = true;
                    break;
                case 'parle':
                    if (parles.includes(numero)) ganado = true;
                    break;
            }

            if (ganado) {
                premioTotalUSD += item.usd * multiplicador;
                premioTotalCUP += item.cup * multiplicador;
            }
        }

        if (premioTotalUSD > 0 || premioTotalCUP > 0) {
            // Obtener nombre del usuario
            const { data: user } = await supabase
                .from('users')
                .select('first_name')
                .eq('telegram_id', bet.user_id)
                .single();

            winners.push({
                user_id: bet.user_id,
                first_name: user?.first_name || 'Usuario',
                prize_usd: premioTotalUSD,
                prize_cup: premioTotalCUP,
                bet_text: bet.raw_text
            });
        }
    }

    res.json({ winners, winning_number: winningStr });
});

// --- Publicar número ganador (con notificaciones) ---
app.post('/api/admin/winning-numbers', requireAdmin, async (req, res) => {
    const { sessionId, winningNumber } = req.body;
    if (!sessionId || !winningNumber) {
        return res.status(400).json({ error: 'Faltan datos' });
    }

    const cleanNumber = winningNumber.replace(/\s+/g, '');
    if (!/^\d{7}$/.test(cleanNumber)) {
        return res.status(400).json({ error: 'El número debe tener exactamente 7 dígitos' });
    }

    const { data: session } = await supabase
        .from('lottery_sessions')
        .select('*')
        .eq('id', sessionId)
        .single();

    if (!session) {
        return res.status(404).json({ error: 'Sesión no encontrada' });
    }

    // Verificar que no se haya publicado ya
    const { data: existingWin } = await supabase
        .from('winning_numbers')
        .select('id')
        .eq('lottery', session.lottery)
        .eq('date', session.date)
        .eq('time_slot', session.time_slot)
        .maybeSingle();

    if (existingWin) {
        return res.status(400).json({ error: 'Esta sesión ya tiene un número ganador publicado' });
    }

    // Desglose
    const centena = cleanNumber.slice(0, 3);
    const cuarteta = cleanNumber.slice(3);
    const fijo = centena.slice(1);
    const corridos = [
        fijo,
        cuarteta.slice(0, 2),
        cuarteta.slice(2)
    ];
    const parles = [
        `${corridos[0]}x${corridos[1]}`,
        `${corridos[0]}x${corridos[2]}`,
        `${corridos[1]}x${corridos[2]}`
    ];

    // Guardar número ganador
    const { error: insertError } = await supabase
        .from('winning_numbers')
        .insert({
            lottery: session.lottery,
            date: session.date,
            time_slot: session.time_slot,
            numbers: [cleanNumber],
            published_at: new Date()
        });

    if (insertError) {
        return res.status(500).json({ error: insertError.message });
    }

    // Obtener multiplicadores
    const { data: multipliers } = await supabase
        .from('play_prices')
        .select('bet_type, payout_multiplier');
    const multiplierMap = {};
    multipliers.forEach(m => { multiplierMap[m.bet_type] = parseFloat(m.payout_multiplier) || 0; });

    // Obtener todas las apuestas de la sesión
    const { data: bets } = await supabase
        .from('bets')
        .select('*')
        .eq('session_id', sessionId);

    // Procesar cada apuesta
    for (const bet of bets || []) {
        let premioTotalUSD = 0;
        let premioTotalCUP = 0;
        const items = bet.items || [];

        for (const item of items) {
            const numero = item.numero;
            const multiplicador = multiplierMap[bet.bet_type] || 0;
            let ganado = false;

            switch (bet.bet_type) {
                case 'fijo':
                    if (numero === fijo) ganado = true;
                    break;
                case 'corridos':
                    if (corridos.includes(numero)) ganado = true;
                    break;
                case 'centena':
                    if (numero === centena) ganado = true;
                    break;
                case 'parle':
                    if (parles.includes(numero)) ganado = true;
                    break;
            }

            if (ganado) {
                premioTotalUSD += item.usd * multiplicador;
                premioTotalCUP += item.cup * multiplicador;
            }
        }

        if (premioTotalUSD > 0 || premioTotalCUP > 0) {
            const { data: user } = await supabase
                .from('users')
                .select('usd, cup')
                .eq('telegram_id', bet.user_id)
                .single();

            if (premioTotalUSD > 0) {
                await supabase
                    .from('users')
                    .update({ usd: parseFloat(user.usd) + premioTotalUSD })
                    .eq('telegram_id', bet.user_id);
            }
            if (premioTotalCUP > 0) {
                await supabase
                    .from('users')
                    .update({ cup: parseFloat(user.cup) + premioTotalCUP })
                    .eq('telegram_id', bet.user_id);
            }

            // Notificar al ganador
            try {
                await axios.post(`https://api.telegram.org/bot${BOT_TOKEN}/sendMessage`, {
                    chat_id: bet.user_id,
                    text: `🎉 <b>¡FELICIDADES! Has ganado</b>\n\n` +
                          `🔢 Número ganador: <code>${cleanNumber}</code>\n` +
                          `🎰 ${session.lottery} - ${session.time_slot}\n` +
                          `💰 Premio: ${premioTotalUSD.toFixed(2)} USD / ${premioTotalCUP.toFixed(2)} CUP\n\n` +
                          `✅ El premio ya fue acreditado a tu saldo.`,
                    parse_mode: 'HTML'
                });
            } catch (e) {}
        } else {
            // Notificar que no ganó
            try {
                await axios.post(`https://api.telegram.org/bot${BOT_TOKEN}/sendMessage`, {
                    chat_id: bet.user_id,
                    text: `🔢 <b>Números ganadores de ${session.lottery} (${session.date} - ${session.time_slot})</b>\n\n` +
                          `Número: <code>${cleanNumber}</code>\n\n` +
                          `😔 No has ganado esta vez. ¡Sigue intentando!`,
                    parse_mode: 'HTML'
                });
            } catch (e) {}
        }
    }

    // --- NUEVO: Broadcast global a TODOS los usuarios ---
    try {
        const { data: allUsers } = await supabase
            .from('users')
            .select('telegram_id');

        const announceText = `📢 <b>NÚMERO GANADOR PUBLICADO</b>\n\n` +
            `🎰 <b>${session.lottery}</b> - Turno <b>${session.time_slot}</b>\n` +
            `📅 Fecha: ${session.date}\n` +
            `🔢 Número: <code>${cleanNumber}</code>\n\n` +
            `💬 Revisa tu historial para ver si has ganado. ¡Suerte en la próxima!`;

        for (const u of allUsers || []) {
            try {
                await axios.post(`https://api.telegram.org/bot${BOT_TOKEN}/sendMessage`, {
                    chat_id: u.telegram_id,
                    text: announceText,
                    parse_mode: 'HTML'
                });
            } catch (e) {}
        }
    } catch (e) {
        console.error('Error en broadcast global:', e);
    }

    res.json({ success: true, message: 'Números publicados y premios calculados' });
});

// ========== SERVIDOR ESTÁTICO ==========
app.get('/', (req, res) => {
    res.sendFile(path.join(__dirname, 'webapp', 'index.html'));
});
app.get('/app.html', (req, res) => {
    res.sendFile(path.join(__dirname, 'webapp', 'app.html'));
});

// ========== KEEP-ALIVE ==========
setInterval(async () => {
    try {
        await axios.get(`https://api.telegram.org/bot${BOT_TOKEN}/getMe`);
        console.log('[Keep-Alive] Ping a Telegram OK');
    } catch (e) {
        console.error('[Keep-Alive] Error:', e.message);
    }
}, 5 * 60 * 1000);

// ========== INICIAR SERVIDOR Y BOT ==========
app.listen(PORT, () => {
    console.log(`🚀 Backend de Rifas Cuba corriendo en http://localhost:${PORT}`);
    console.log(`📡 WebApp servida en ${WEBAPP_URL}`);
    console.log(`🤖 Iniciando bot de Telegram...`);
});

bot.launch()
    .then(() => console.log('🤖 Bot de Telegram iniciado correctamente'))
    .catch(err => console.error('❌ Error al iniciar el bot:', err));

process.once('SIGINT', () => bot.stop('SIGINT'));
process.once('SIGTERM', () => bot.stop('SIGTERM'));

module.exports = app;
