// ==============================
// bot.js - Bot de Telegram para 4pu3$t4$_Qva
// Versión con soporte multi-moneda (CUP, USD, USDT, TRX, MLC)
// Tasas configurables por admin
// Emojis regionales en números ganadores
// ==============================

require('dotenv').config();
const { Telegraf, Markup } = require('telegraf');
const { message } = require('telegraf/filters');
const LocalSession = require('telegraf-session-local');
const { createClient } = require('@supabase/supabase-js');
const cron = require('node-cron');
const moment = require('moment-timezone');
const axios = require('axios');

// ========== CONFIGURACIÓN DESDE .ENV ==========
const BOT_TOKEN = process.env.BOT_TOKEN;
const ADMIN_IDS = process.env.ADMIN_IDS ? process.env.ADMIN_IDS.split(',').map(id => parseInt(id.trim())) : [];
const ADMIN_CHANNEL = process.env.ADMIN_CHANNEL;
const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_SERVICE_KEY = process.env.SUPABASE_SERVICE_KEY;
const BONUS_CUP_DEFAULT = parseFloat(process.env.BONUS_CUP_DEFAULT) || 70; // Bono en CUP
const TIMEZONE = process.env.TIMEZONE || 'America/Havana';
const WEBAPP_URL = process.env.WEBAPP_URL || 'http://localhost:3000';

// ========== HORARIO DE RETIROS (hora Cuba) ==========
const WITHDRAW_HOURS = { start: 22, end: 23.5 }; // 22:00 a 23:30

function isWithdrawTime() {
    const now = moment.tz(TIMEZONE);
    const currentHour = now.hour() + now.minute() / 60;
    return currentHour >= WITHDRAW_HOURS.start && currentHour < WITHDRAW_HOURS.end;
}

// ========== INICIALIZAR SUPABASE ==========
const supabase = createClient(SUPABASE_URL, SUPABASE_SERVICE_KEY);

// ========== INICIALIZAR BOT ==========
const bot = new Telegraf(BOT_TOKEN);

// ========== CONFIGURAR COMANDOS DEL MENÚ LATERAL ==========
bot.telegram.setMyCommands([
  { command: 'start', description: '🏠 Inicio' },
  { command: 'jugar', description: '🎲 Jugar' },
  { command: 'mi_dinero', description: '💰 Mi dinero' },
  { command: 'mis_jugadas', description: '📋 Mis jugadas' },
  { command: 'referidos', description: '👥 Referidos' },
  { command: 'ayuda', description: '❓ Ayuda' },
  { command: 'webapp', description: '🌐 Abrir WebApp' }
]).catch(err => console.error('Error al setear comandos:', err));

// ========== SESIÓN LOCAL ==========
const localSession = new LocalSession({ database: 'session_db.json' });
bot.use(localSession.middleware());

// ========== FUNCIÓN PARA VERIFICAR SI UN USUARIO ES ADMIN ==========
function isAdmin(userId) {
    return ADMIN_IDS.includes(userId);
}

// ========== FUNCIONES AUXILIARES ==========

function escapeHTML(text) {
    if (!text) return '';
    return String(text)
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;')
        .replace(/'/g, '&#039;');
}

async function safeEdit(ctx, text, keyboard = null) {
    try {
        if (ctx.callbackQuery) {
            await ctx.editMessageText(text, {
                parse_mode: 'HTML',
                reply_markup: keyboard?.reply_markup
            });
        } else {
            await ctx.reply(text, {
                parse_mode: 'HTML',
                reply_markup: keyboard?.reply_markup
            });
        }
    } catch (err) {
        console.warn('Error en safeEdit, enviando nuevo mensaje:', err.message);
        try {
            await ctx.reply(text, {
                parse_mode: 'HTML',
                reply_markup: keyboard?.reply_markup
            });
        } catch (e) {}
    }
}

// Obtener tasa de cambio USD/CUP
async function getExchangeRateUSD() {
    const { data } = await supabase
        .from('exchange_rate')
        .select('rate')
        .eq('id', 1)
        .single();
    return data?.rate || 110;
}

// Obtener tasa de cambio USDT/CUP
async function getExchangeRateUSDT() {
    const { data } = await supabase
        .from('exchange_rate')
        .select('rate_usdt')
        .eq('id', 1)
        .single();
    return data?.rate_usdt || 110; // Por defecto igual a USD
}

// Obtener tasa de cambio TRX/CUP
async function getExchangeRateTRX() {
    const { data } = await supabase
        .from('exchange_rate')
        .select('rate_trx')
        .eq('id', 1)
        .single();
    return data?.rate_trx || 1; // Ejemplo: 1 TRX = 1 CUP (ajustable)
}

// Actualizar tasas
async function setExchangeRateUSD(rate) {
    await supabase
        .from('exchange_rate')
        .update({ rate, updated_at: new Date() })
        .eq('id', 1);
}

async function setExchangeRateUSDT(rate) {
    await supabase
        .from('exchange_rate')
        .update({ rate_usdt: rate, updated_at: new Date() })
        .eq('id', 1);
}

async function setExchangeRateTRX(rate) {
    await supabase
        .from('exchange_rate')
        .update({ rate_trx: rate, updated_at: new Date() })
        .eq('id', 1);
}

// ========== FUNCIÓN GETUSER MODIFICADA PARA AÑADIR BONO DE BIENVENIDA Y USERNAME ==========
async function getUser(telegramId, firstName = 'Jugador', username = null) {
    let { data: user } = await supabase
        .from('users')
        .select('*')
        .eq('telegram_id', telegramId)
        .single();

    if (!user) {
        // Calcular bono de bienvenida en CUP (principal)
        const bonusCUP = BONUS_CUP_DEFAULT;

        const { data: newUser } = await supabase
            .from('users')
            .insert({ 
                telegram_id: telegramId, 
                first_name: firstName,
                username: username,
                bonus_cup: bonusCUP,
                // Otros saldos iniciales en 0
                cup: 0,
                usd: 0,
                usdt: 0,
                trx: 0,
                mlc: 0
            })
            .select()
            .single();
        user = newUser;

        // Enviar mensaje de bienvenida con el bono
        try {
            await bot.telegram.sendMessage(telegramId,
                `🎁 <b>¡Bono de bienvenida!</b>\n\n` +
                `Has recibido <b>${bonusCUP} CUP</b> como bono no retirable.\n` +
                `Puedes usar este bono para jugar y ganar premios reales. ¡Buena suerte!`,
                { parse_mode: 'HTML' }
            );
        } catch (e) {}
    } else {
        // Actualizar username si cambió
        if (username && user.username !== username) {
            await supabase.from('users').update({ username }).eq('telegram_id', telegramId);
        }
    }
    return user;
}

// Mínimos en USD (para compatibilidad con configuraciones anteriores)
async function getMinDepositUSD() {
    const { data } = await supabase
        .from('app_config')
        .select('value')
        .eq('key', 'min_deposit_usd')
        .single();
    return data ? parseFloat(data.value) : 1.0;
}

async function getMinWithdrawUSD() {
    const { data } = await supabase
        .from('app_config')
        .select('value')
        .eq('key', 'min_withdraw_usd')
        .single();
    return data ? parseFloat(data.value) : 1.0;
}

async function setMinDepositUSD(value) {
    await supabase
        .from('app_config')
        .upsert({ key: 'min_deposit_usd', value: value.toString() }, { onConflict: 'key' });
}

async function setMinWithdrawUSD(value) {
    await supabase
        .from('app_config')
        .upsert({ key: 'min_withdraw_usd', value: value.toString() }, { onConflict: 'key' });
}

// Parsear monto con moneda (ej: "500 cup", "10 usdt", "100 trx")
function parseAmountWithCurrency(text) {
    const lower = text.toLowerCase().replace(',', '.').trim();
    const match = lower.match(/^(\d+(?:\.\d+)?)\s*(cup|usd|usdt|trx|mlc)$/);
    if (!match) return null;
    return {
        amount: parseFloat(match[1]),
        currency: match[2].toUpperCase()
    };
}

// Convertir cualquier moneda a CUP (para acreditar/débitos)
async function convertToCUP(amount, currency) {
    const rateUSD = await getExchangeRateUSD();
    const rateUSDT = await getExchangeRateUSDT();
    const rateTRX = await getExchangeRateTRX();
    switch (currency) {
        case 'CUP': return amount;
        case 'USD': return amount * rateUSD;
        case 'USDT': return amount * rateUSDT;
        case 'TRX': return amount * rateTRX;
        case 'MLC': return amount * rateUSD; // MLC se trata como USD
        default: return 0;
    }
}

// Convertir de CUP a otra moneda (para mostrar equivalencias)
async function convertFromCUP(amountCUP, targetCurrency) {
    const rateUSD = await getExchangeRateUSD();
    const rateUSDT = await getExchangeRateUSDT();
    const rateTRX = await getExchangeRateTRX();
    switch (targetCurrency) {
        case 'CUP': return amountCUP;
        case 'USD': return amountCUP / rateUSD;
        case 'USDT': return amountCUP / rateUSDT;
        case 'TRX': return amountCUP / rateTRX;
        case 'MLC': return amountCUP / rateUSD;
        default: return 0;
    }
}

// ========== FUNCIONES PARA APUESTAS (sin cambios, pero adaptadas para manejar items con moneda) ==========
function parseBetLine(line, betType) {
    line = line.trim().toLowerCase();
    if (!line) return [];

    const match = line.match(/^([\d\s,]+)\s*(?:con|\*)\s*([0-9.]+)\s*(cup|usd)?$/);
    if (!match) return [];

    let numerosStr = match[1].trim();
    const montoStr = match[2];
    const moneda = match[3] || 'usd'; // Por defecto USD por compatibilidad

    const numeros = numerosStr.split(/[\s,]+/).filter(n => n.length > 0);
    const montoBase = parseFloat(montoStr);
    if (isNaN(montoBase) || montoBase <= 0) return [];

    const resultados = [];

    for (let numero of numeros) {
        let montoReal = montoBase;
        let numeroGuardado = numero;

        if (betType === 'fijo') {
            if (/^\d{2}$/.test(numero)) {
                // normal
            } else if (/^[Dd](\d)$/.test(numero)) {
                montoReal = montoBase * 10;
                numeroGuardado = numero.toUpperCase();
            } else if (/^[Tt](\d)$/.test(numero)) {
                montoReal = montoBase * 10;
                numeroGuardado = numero.toUpperCase();
            } else {
                continue;
            }
        } else if (betType === 'corridos') {
            if (!/^\d{2}$/.test(numero)) continue;
        } else if (betType === 'centena') {
            if (!/^\d{3}$/.test(numero)) continue;
        } else if (betType === 'parle') {
            if (!/^\d{2}x\d{2}$/.test(numero)) continue;
        } else {
            continue;
        }

        resultados.push({
            numero: numeroGuardado,
            currency: moneda.toUpperCase(),
            amount: montoReal
        });
    }

    return resultados;
}

function parseBetMessage(text, betType) {
    const lines = text.split('\n').map(l => l.trim()).filter(l => l);
    const items = [];
    let totalCUP = 0, totalUSD = 0; // Para mantener compatibilidad con código existente, pero ahora usaremos currency

    for (const line of lines) {
        const parsedItems = parseBetLine(line, betType);
        for (const item of parsedItems) {
            items.push(item);
            if (item.currency === 'CUP') totalCUP += item.amount;
            else if (item.currency === 'USD') totalUSD += item.amount;
            // Otros? Por ahora solo CUP y USD en apuestas (podríamos extender)
        }
    }

    return {
        items,
        totalCUP,
        totalUSD,
        ok: items.length > 0
    };
}

// Mapa para convertir nombres de lotería a claves internas y emojis
const regionMap = {
    'Florida': { key: 'florida', emoji: '🦩' },
    'Georgia': { key: 'georgia', emoji: '🍑' },
    'Nueva York': { key: 'newyork', emoji: '🗽' }
};

function getEndTimeFromSlot(lottery, timeSlot) {
    const region = regionMap[lottery];
    if (!region) return null;
    const schedule = getAllowedHours(region.key);
    if (!schedule) return null;
    const slot = schedule.slots.find(s => s.name === timeSlot);
    if (!slot) return null;
    
    const now = moment.tz(TIMEZONE);
    const today = now.format('YYYY-MM-DD');
    
    let hour = Math.floor(slot.end);
    let minute = (slot.end % 1) * 60;
    
    const endTime = moment.tz(`${today} ${hour}:${minute}:00`, 'YYYY-MM-DD HH:mm:ss', TIMEZONE);
    
    if (now.isSameOrAfter(endTime)) {
        return null;
    }
    
    return endTime.toDate();
}

async function broadcastToAllUsers(message, parseMode = 'HTML') {
    const { data: users } = await supabase
        .from('users')
        .select('telegram_id');

    for (const u of users || []) {
        try {
            await bot.telegram.sendMessage(u.telegram_id, message, { parse_mode: parseMode });
            await new Promise(resolve => setTimeout(resolve, 30));
        } catch (e) {
            console.warn(`Error enviando broadcast a ${u.telegram_id}:`, e.message);
        }
    }
}

// Crear solicitud de depósito (ahora incluye currency)
async function createDepositRequest(userId, methodId, fileBuffer, amountText, currency) {
    const fileName = `deposit_${userId}_${Date.now()}.jpg`;
    const filePath = `deposits/${fileName}`;

    const { error: uploadError } = await supabase.storage
        .from('deposit-screenshots')
        .upload(filePath, fileBuffer, { contentType: 'image/jpeg' });

    if (uploadError) throw new Error('Error al subir captura');

    const { data: { publicUrl } } = supabase.storage
        .from('deposit-screenshots')
        .getPublicUrl(filePath);

    const { data: request, error: insertError } = await supabase
        .from('deposit_requests')
        .insert({
            user_id: userId,
            method_id: methodId,
            screenshot_url: publicUrl,
            amount: amountText,
            currency: currency,
            status: 'pending'
        })
        .select()
        .single();

    if (insertError) throw insertError;

    return request;
}

// ========== TECLADOS ==========
function getMainKeyboard(ctx) {
    const buttons = [
        ['🎲 Jugar', '💰 Mi dinero'],
        ['📋 Mis jugadas', '👥 Referidos'],
        ['❓ Cómo jugar', '🌐 Abrir WebApp']
    ];
    if (isAdmin(ctx.from.id)) {
        buttons.push(['🔧 Admin']);
    }
    return Markup.keyboard(buttons).resize();
}

function playLotteryKbd() {
    const buttons = [
        [Markup.button.callback('🦩 Florida', 'lot_florida')],
        [Markup.button.callback('🍑 Georgia', 'lot_georgia')],
        [Markup.button.callback('🗽 Nueva York', 'lot_newyork')],
        [Markup.button.callback('◀ Volver', 'main')]
    ];
    return Markup.inlineKeyboard(buttons);
}

function playTypeKbd() {
    const buttons = [
        [Markup.button.callback('🎯 Fijo', 'type_fijo')],
        [Markup.button.callback('🏃 Corridos', 'type_corridos')],
        [Markup.button.callback('💯 Centena', 'type_centena')],
        [Markup.button.callback('🔒 Parle', 'type_parle')],
        [Markup.button.callback('◀ Volver', 'play')]
    ];
    return Markup.inlineKeyboard(buttons);
}

function myMoneyKbd() {
    const buttons = [
        [Markup.button.callback('📥 Recargar', 'recharge')],
        [Markup.button.callback('📤 Retirar', 'withdraw')],
        [Markup.button.callback('🔄 Transferir', 'transfer')],
        [Markup.button.callback('◀ Volver', 'main')]
    ];
    return Markup.inlineKeyboard(buttons);
}

function adminPanelKbd() {
    const buttons = [
        [Markup.button.callback('🎰 Gestionar sesiones', 'admin_sessions')],
        [Markup.button.callback('🔢 Publicar ganadores', 'admin_winning')],
        [Markup.button.callback('➕ Añadir método DEPÓSITO', 'adm_add_dep')],
        [Markup.button.callback('✏️ Editar método DEPÓSITO', 'adm_edit_dep')],
        [Markup.button.callback('🗑 Eliminar método DEPÓSITO', 'adm_delete_dep')],
        [Markup.button.callback('➕ Añadir método RETIRO', 'adm_add_wit')],
        [Markup.button.callback('✏️ Editar método RETIRO', 'adm_edit_wit')],
        [Markup.button.callback('🗑 Eliminar método RETIRO', 'adm_delete_wit')],
        [Markup.button.callback('💰 Configurar tasa USD/CUP', 'adm_set_rate_usd')],
        [Markup.button.callback('💰 Configurar tasa USDT/CUP', 'adm_set_rate_usdt')],
        [Markup.button.callback('💰 Configurar tasa TRX/CUP', 'adm_set_rate_trx')],
        [Markup.button.callback('🎲 Configurar precios y pagos', 'adm_set_prices')],
        [Markup.button.callback('💰 Mínimos por jugada', 'adm_min_per_bet')],
        [Markup.button.callback('💰 Mínimo depósito (USD)', 'adm_min_deposit')],
        [Markup.button.callback('💰 Mínimo retiro (USD)', 'adm_min_withdraw')],
        [Markup.button.callback('📋 Ver datos actuales', 'adm_view')],
        [Markup.button.callback('◀ Menú principal', 'main')]
    ];
    return Markup.inlineKeyboard(buttons);
}

function getAllowedHours(lotteryKey) {
    const schedules = {
        florida: {
            name: 'Florida',
            emoji: '🦩',
            slots: [
                { name: '🌅 Mañana', start: 9, end: 13 },
                { name: '🌙 Noche',  start: 14, end: 21 }
            ]
        },
        georgia: {
            name: 'Georgia',
            emoji: '🍑',
            slots: [
                { name: '🌅 Mañana', start: 9, end: 12 },
                { name: '☀️ Tarde',  start: 14, end: 18.5 },
                { name: '🌙 Noche',  start: 20, end: 23 }
            ]
        },
        newyork: {
            name: 'Nueva York',
            emoji: '🗽',
            slots: [
                { name: '🌅 Mañana', start: 9, end: 14 },
                { name: '🌙 Noche',  start: 15, end: 22 }
            ]
        }
    };
    return schedules[lotteryKey];
}

// Middleware para cargar usuario
bot.use(async (ctx, next) => {
    const uid = ctx.from?.id;
    if (uid) {
        try {
            const firstName = ctx.from.first_name || 'Jugador';
            const username = ctx.from.username || null;
            ctx.dbUser = await getUser(uid, firstName, username);
        } catch (e) {
            console.error('Error cargando usuario:', e);
        }
    }
    return next();
});

// Comandos
bot.command('start', async (ctx) => {
    const uid = ctx.from.id;
    const firstName = ctx.from.first_name || 'Jugador';
    const refParam = ctx.payload;

    if (refParam) {
        const refId = parseInt(refParam);
        if (refId && refId !== uid) {
            await supabase
                .from('users')
                .update({ ref_by: refId })
                .eq('telegram_id', uid);
        }
    }

    await safeEdit(ctx,
        `👋 ¡Hola, ${escapeHTML(firstName)}! Bienvenido a 4pu3$t4$_Qva, tu asistente de la suerte 🍀\n\n` +
        `Estamos encantados de tenerte aquí. ¿Listo para jugar y ganar? 🎲\n\n` +
        `Usa los botones del menú para explorar todas las opciones. Si tienes dudas, solo escríbenos.`,
        getMainKeyboard(ctx)
    );
});

bot.command('jugar', async (ctx) => {
    await safeEdit(ctx, '🎲 Por favor, selecciona una lotería para comenzar a jugar:', playLotteryKbd());
});

bot.command('mi_dinero', async (ctx) => {
    const user = ctx.dbUser;
    const rateUSD = await getExchangeRateUSD();
    const rateUSDT = await getExchangeRateUSDT();
    const rateTRX = await getExchangeRateTRX();

    const cup = parseFloat(user.cup);
    const usd = parseFloat(user.usd);
    const usdt = parseFloat(user.usdt);
    const trx = parseFloat(user.trx);
    const mlc = parseFloat(user.mlc);
    const bonusCup = parseFloat(user.bonus_cup);

    const text = `💰 <b>Tu saldo actual es:</b>\n\n` +
        `🇨🇺 <b>CUP:</b> ${cup.toFixed(2)} (principal)\n` +
        `💵 <b>USD:</b> ${usd.toFixed(2)} (≈ ${(usd * rateUSD).toFixed(2)} CUP)\n` +
        `₮ <b>USDT:</b> ${usdt.toFixed(2)} (≈ ${(usdt * rateUSDT).toFixed(2)} CUP)\n` +
        `🔷 <b>TRX:</b> ${trx.toFixed(2)} (≈ ${(trx * rateTRX).toFixed(2)} CUP)\n` +
        `💳 <b>MLC:</b> ${mlc.toFixed(2)} (≈ ${(mlc * rateUSD).toFixed(2)} CUP)\n` +
        `🎁 <b>Bono (no retirable):</b> ${bonusCup.toFixed(2)} CUP\n\n` +
        `¿Qué deseas hacer?`;
    await safeEdit(ctx, text, myMoneyKbd());
});

bot.command('mis_jugadas', async (ctx) => {
    const uid = ctx.from.id;
    const { data: bets } = await supabase
        .from('bets')
        .select('*')
        .eq('user_id', uid)
        .order('placed_at', { ascending: false })
        .limit(5);

    if (!bets || bets.length === 0) {
        await safeEdit(ctx,
            '📭 Aún no has realizado ninguna jugada. ¡Anímate a participar! 🎲\n\n' +
            'Para jugar, selecciona "🎲 Jugar" en el menú y sigue las instrucciones. Estamos aquí para ayudarte.',
            getMainKeyboard(ctx)
        );
    } else {
        let text = '📋 <b>Tus últimas 5 jugadas:</b>\n\n';
        bets.forEach((b, i) => {
            const date = moment(b.placed_at).tz(TIMEZONE).format('DD/MM/YYYY HH:mm');
            // Mostrar items simplificado
            text += `<b>${i + 1}.</b> 🎰 ${escapeHTML(b.lottery)} - ${escapeHTML(b.bet_type)}\n` +
                `   📝 <code>${escapeHTML(b.raw_text)}</code>\n` +
                `   💰 Costo: ${b.items.map(it => `${it.amount} ${it.currency}`).join(', ')}\n` +
                `   🕒 ${date}\n\n`;
        });
        text += '¿Quieres ver más? Puedes consultar el historial completo en la WebApp.';
        await safeEdit(ctx, text, getMainKeyboard(ctx));
    }
});

bot.command('referidos', async (ctx) => {
    const uid = ctx.from.id;
    const { count } = await supabase
        .from('users')
        .select('*', { count: 'exact', head: true })
        .eq('ref_by', uid);

    const botInfo = await ctx.telegram.getMe();
    const link = `https://t.me/${botInfo.username}?start=${uid}`;

    await safeEdit(ctx,
        `💸 <b>¡GANA DINERO EXTRA INVITANDO AMIGOS! 💰</b>\n\n` +
        `🎯 <b>¿Cómo funciona?</b>\n` +
        `1️⃣ Comparte tu enlace personal con amigos\n` +
        `2️⃣ Cuando se registren y jueguen, tú ganas una comisión\n` +
        `3️⃣ Recibirás un porcentaje de CADA apuesta que realicen\n` +
        `4️⃣ ¡Es automático y para siempre! 🔄\n\n` +
        `🔥 Sin límites, sin topes, sin esfuerzo.\n\n` +
        `📲 <b>Tu enlace mágico:</b> 👇\n` +
        `<code>${escapeHTML(link)}</code>\n\n` +
        `📊 <b>Tus estadísticas:</b>\n` +
        `👥 Referidos registrados: ${count || 0}\n\n` +
        `¡Comparte y empieza a ganar hoy mismo!`,
        getMainKeyboard(ctx)
    );
});

bot.command('ayuda', async (ctx) => {
    await safeEdit(ctx,
        '📩 <b>¿Tienes dudas o necesitas ayuda?</b>\n\n' +
        'Puedes escribir directamente en este chat. Tu mensaje será recibido por nuestro equipo de soporte y te responderemos a la mayor brevedad.\n\n' +
        'También puedes consultar la sección de preguntas frecuentes en nuestra WebApp.',
        Markup.inlineKeyboard([[Markup.button.callback('◀ Volver al inicio', 'main')]])
    );
});

bot.command('webapp', async (ctx) => {
    const webAppButton = Markup.inlineKeyboard([
        Markup.button.webApp('🚀 Abrir WebApp', `${WEBAPP_URL}/app.html`)
    ]);
    await ctx.reply('Haz clic en el botón para acceder a nuestra plataforma web interactiva:', webAppButton);
});

// Acciones
bot.action('main', async (ctx) => {
    const firstName = ctx.from.first_name || 'Jugador';
    await safeEdit(ctx,
        `👋 ¡Hola de nuevo, ${escapeHTML(firstName)}! ¿En qué podemos ayudarte hoy?\n\n` +
        `Selecciona una opción del menú para continuar.`,
        getMainKeyboard(ctx)
    );
});

bot.action('play', async (ctx) => {
    await safeEdit(ctx, '🎲 Elige una lotería para comenzar:', playLotteryKbd());
});

bot.action(/lot_(.+)/, async (ctx) => {
    try {
        const lotteryKey = ctx.match[1];
        const lotteryName = lotteryKey === 'florida' ? 'Florida' : lotteryKey === 'georgia' ? 'Georgia' : 'Nueva York';
        const region = regionMap[lotteryName];
        const schedule = getAllowedHours(lotteryKey);

        const now = moment.tz(TIMEZONE);
        const currentMinutes = now.hours() * 60 + now.minutes();
        const isAllowed = schedule.slots.some(slot => {
            const startMinutes = slot.start * 60;
            const endMinutes = slot.end * 60;
            return currentMinutes >= startMinutes && currentMinutes <= endMinutes;
        });

        if (!isAllowed) {
            let hoursText = '';
            for (const slot of schedule.slots) {
                const startStr = moment().tz(TIMEZONE).hours(Math.floor(slot.start)).minutes((slot.start % 1) * 60).format('h:mm A');
                const endStr = moment().tz(TIMEZONE).hours(Math.floor(slot.end)).minutes((slot.end % 1) * 60).format('h:mm A');
                hoursText += `${slot.name}: ${startStr} - ${endStr}\n`;
            }

            const errorMsg = 
                `⏰ <b>Horario no disponible para ${schedule.emoji} ${schedule.name}</b>\n\n` +
                `📅 Los horarios permitidos (hora de Cuba) son:\n${hoursText}\n` +
                `🔄 Por favor, intenta dentro del horario o elige otra lotería. ¡Te esperamos!`;

            await safeEdit(ctx, errorMsg, playLotteryKbd());
            return;
        }

        const today = moment.tz(TIMEZONE).format('YYYY-MM-DD');
        const { data: activeSession, error } = await supabase
            .from('lottery_sessions')
            .select('*')
            .eq('lottery', lotteryName)
            .eq('date', today)
            .eq('status', 'open')
            .maybeSingle();

        if (error) {
            console.error('Error al consultar sesión:', error);
            await ctx.reply('❌ Lo sentimos, ocurrió un error al verificar la sesión. Por favor, intenta más tarde.', getMainKeyboard(ctx));
            return;
        }

        if (!activeSession) {
            let hoursText = '';
            for (const slot of schedule.slots) {
                const startStr = moment().tz(TIMEZONE).hours(Math.floor(slot.start)).minutes((slot.start % 1) * 60).format('h:mm A');
                const endStr = moment().tz(TIMEZONE).hours(Math.floor(slot.end)).minutes((slot.end % 1) * 60).format('h:mm A');
                hoursText += `${slot.name}: ${startStr} - ${endStr}\n`;
            }
            const errorMsg = 
                `❌ <b>No hay una sesión abierta en este momento para ${schedule.emoji} ${schedule.name}</b>\n\n` +
                `📅 Horarios de juego (hora de Cuba):\n${hoursText}\n` +
                `🔄 Por favor, espera a que se abra una sesión o elige otra lotería. ¡Estamos contigo!`;
            await safeEdit(ctx, errorMsg, playLotteryKbd());
            return;
        }

        ctx.session.lottery = lotteryName;
        ctx.session.sessionId = activeSession.id;
        await safeEdit(ctx,
            `✅ Has seleccionado <b>${escapeHTML(lotteryName)}</b> - Turno <b>${escapeHTML(activeSession.time_slot)}</b>.\n` +
            `Ahora elige el tipo de jugada que deseas realizar:`,
            playTypeKbd()
        );
    } catch (e) {
        console.error('Error en lot_ handler:', e);
        await ctx.reply('❌ Ups, ocurrió un error inesperado. Por favor, intenta de nuevo.', getMainKeyboard(ctx));
    }
});

bot.action(/type_(.+)/, async (ctx) => {
    const betType = ctx.match[1];
    ctx.session.betType = betType;
    ctx.session.awaitingBet = true;
    const lottery = ctx.session.lottery || 'Florida';

    const { data: price } = await supabase
        .from('play_prices')
        .select('payout_multiplier, amount_cup, amount_usd')
        .eq('bet_type', betType)
        .single();

    let priceInfo = '';
    if (price) {
        priceInfo = `🎁 <b>Pago de Jugada:</b> x${price.payout_multiplier}\n` +
                    `💰 Costo base: ${price.amount_cup} CUP / ${price.amount_usd} USD por cada número\n\n`;
    }

    let instructions = '';
    switch (betType) {
        case 'fijo':
            instructions = `🎯 <b>FIJO</b> - 🎰 ${escapeHTML(lottery)}\n\n` +
                priceInfo +
                `Escribe una línea por cada jugada. Puedes poner varios números separados por espacios o comas en la misma línea.\n` +
                `<b>Formato:</b> <code>12 con 5 cup</code>  o  <code>09 10 34*2cup</code>\n` +
                `También puedes usar <b>D</b> (decena) o <b>T</b> (terminal):\n` +
                `- <code>D2 con 5 cup</code> significa TODOS los números que empiezan con 2 (20-29). El costo se multiplica por 10.\n` +
                `- <code>T5 con 1 cup</code> significa TODOS los números que terminan con 5 (05,15,...,95). El costo se multiplica por 10.\n\n` +
                `Ejemplos:\n12 con 1 cup\n09 10 34 con 50 cup\nD2 con 5 cup\nT5*1cup\n34*2 cup\n\n` +
                `💭 <b>Escribe tus jugadas (una o varias líneas):</b>`;
            break;
        case 'corridos':
            instructions = `🏃 <b>CORRIDOS</b> - 🎰 ${escapeHTML(lottery)}\n\n` +
                priceInfo +
                `Escribe una línea por cada número de 2 DÍGITOS, o varios separados.\n` +
                `<b>Formato:</b> <code>17 con 1 cup</code>  o  <code>32 33*0.5cup</code>\n\n` +
                `Ejemplo:\n17 con 1 cup\n32 33*0.5 cup\n62 con 10 cup\n\n` +
                `💭 <b>Escribe tus jugadas:</b>`;
            break;
        case 'centena':
            instructions = `💯 <b>CENTENA</b> - 🎰 ${escapeHTML(lottery)}\n\n` +
                priceInfo +
                `Escribe una línea por cada número de 3 DÍGITOS, o varios separados.\n` +
                `<b>Formato:</b> <code>517 con 2 cup</code>  o  <code>019 123*1cup</code>\n\n` +
                `Ejemplo:\n517 con 2 cup\n019 123*1 cup\n123 con 5 cup\n\n` +
                `💭 <b>Escribe tus jugadas:</b>`;
            break;
        case 'parle':
            instructions = `🔒 <b>PARLE</b> - 🎰 ${escapeHTML(lottery)}\n\n` +
                priceInfo +
                `Escribe una línea por cada combinación de dos números de 2 dígitos separados por "x".\n` +
                `<b>Formato:</b> <code>17x32 con 1 cup</code>  o  <code>17x62*2cup</code>\n\n` +
                `Ejemplo:\n17x32 con 1 cup\n17x62*2 cup\n32x62 con 5 cup\n\n` +
                `💭 <b>Escribe tus parles:</b>`;
            break;
    }
    await safeEdit(ctx, instructions, null);
});

bot.action('my_money', async (ctx) => {
    const user = ctx.dbUser;
    const rateUSD = await getExchangeRateUSD();
    const rateUSDT = await getExchangeRateUSDT();
    const rateTRX = await getExchangeRateTRX();

    const cup = parseFloat(user.cup);
    const usd = parseFloat(user.usd);
    const usdt = parseFloat(user.usdt);
    const trx = parseFloat(user.trx);
    const mlc = parseFloat(user.mlc);
    const bonusCup = parseFloat(user.bonus_cup);

    const text = `💰 <b>Tu saldo actual es:</b>\n\n` +
        `🇨🇺 <b>CUP:</b> ${cup.toFixed(2)} (principal)\n` +
        `💵 <b>USD:</b> ${usd.toFixed(2)} (≈ ${(usd * rateUSD).toFixed(2)} CUP)\n` +
        `₮ <b>USDT:</b> ${usdt.toFixed(2)} (≈ ${(usdt * rateUSDT).toFixed(2)} CUP)\n` +
        `🔷 <b>TRX:</b> ${trx.toFixed(2)} (≈ ${(trx * rateTRX).toFixed(2)} CUP)\n` +
        `💳 <b>MLC:</b> ${mlc.toFixed(2)} (≈ ${(mlc * rateUSD).toFixed(2)} CUP)\n` +
        `🎁 <b>Bono (no retirable):</b> ${bonusCup.toFixed(2)} CUP\n\n` +
        `¿Qué deseas hacer?`;
    await safeEdit(ctx, text, myMoneyKbd());
});

// DEPÓSITO
bot.action('recharge', async (ctx) => {
    const minDepositUSD = await getMinDepositUSD();
    const rateUSD = await getExchangeRateUSD();
    const { data: methods } = await supabase
        .from('deposit_methods')
        .select('*')
        .order('id', { ascending: true });

    if (!methods || methods.length === 0) {
        await ctx.answerCbQuery('❌ Por el momento no hay métodos de depósito disponibles. Intenta más tarde.', { show_alert: true });
        return;
    }

    const buttons = methods.map(m => [Markup.button.callback(`${m.name} (${m.currency})`, `dep_${m.id}`)]);
    buttons.push([Markup.button.callback('◀ Volver', 'my_money')]);

    await safeEdit(ctx,
        `💵 <b>Recargar saldo</b>\n\n` +
        `Elige un método de pago. Luego deberás enviar una captura de pantalla de la transferencia realizada.\n\n` +
        `<b>Mínimo de depósito:</b> ${minDepositUSD} USD (equivalente a ${(minDepositUSD * rateUSD).toFixed(2)} CUP) para métodos en USD. Para otras monedas, el mínimo se convierte automáticamente.\n\n` +
        `Selecciona el método:`,
        Markup.inlineKeyboard(buttons)
    );
});

bot.action(/dep_(\d+)/, async (ctx) => {
    const methodId = parseInt(ctx.match[1]);
    const { data: method } = await supabase
        .from('deposit_methods')
        .select('*')
        .eq('id', methodId)
        .single();

    if (!method) {
        await ctx.answerCbQuery('Método no encontrado. Por favor, selecciona otro.', { show_alert: true });
        return;
    }

    ctx.session.depositMethod = method;
    ctx.session.awaitingDepositPhoto = true;

    // Instrucciones adicionales para cripto
    let extraInstructions = '';
    if (method.currency === 'USDT' || method.currency === 'TRX') {
        extraInstructions = `\n\n🔐 <b>Importante:</b>\n- Envía el monto exacto en ${method.currency} a la dirección indicada.\n- Asegúrate de usar la red correcta: ${method.card.includes('TRC20') ? 'TRC-20' : method.card.includes('BEP20') ? 'BEP-20' : 'la red especificada'}.\n- La captura debe mostrar claramente el hash de la transacción (TXID) y el monto.`;
    }

    await safeEdit(ctx,
        `🧾 <b>${escapeHTML(method.name)}</b>\n` +
        `Moneda: ${method.currency}\n` +
        `Datos: <code>${escapeHTML(method.card)}</code>\n` +
        `Confirmar: <code>${escapeHTML(method.confirm)}</code>\n${extraInstructions}\n\n` +
        `📸 <b>Ahora, por favor, envía una captura de pantalla de la transferencia que realizaste.</b>\n` +
        `(Asegúrate de que se vea claramente el monto, la moneda y, para cripto, el hash)`,
        null
    );
});

// RETIRO
bot.action('withdraw', async (ctx) => {
    if (!isWithdrawTime()) {
        const startStr = moment.tz(TIMEZONE).hours(22).minutes(0).format('h:mm A');
        const endStr = moment.tz(TIMEZONE).hours(23).minutes(30).format('h:mm A');
        await ctx.answerCbQuery(
            `⏰ Los retiros solo están disponibles de ${startStr} a ${endStr} (hora de Cuba). Por favor, intenta en ese horario.`,
            { show_alert: true }
        );
        return;
    }

    const user = ctx.dbUser;
    const minWithdrawUSD = await getMinWithdrawUSD();
    const rateUSD = await getExchangeRateUSD();
    const minWithdrawCUP = (minWithdrawUSD * rateUSD).toFixed(2);

    // Verificar si tiene algún saldo (excluyendo bono)
    const totalCUP = parseFloat(user.cup) + parseFloat(user.usd)*rateUSD + parseFloat(user.usdt)*await getExchangeRateUSDT() + parseFloat(user.trx)*await getExchangeRateTRX() + parseFloat(user.mlc)*rateUSD;
    if (totalCUP < minWithdrawUSD * rateUSD) {
        await ctx.answerCbQuery(`❌ Necesitas al menos ${minWithdrawCUP} CUP (o su equivalente en otras monedas) en tu saldo real para solicitar un retiro.`, { show_alert: true });
        return;
    }

    const { data: methods } = await supabase
        .from('withdraw_methods')
        .select('*')
        .order('id', { ascending: true });

    if (!methods || methods.length === 0) {
        await ctx.answerCbQuery('❌ Por el momento no hay métodos de retiro disponibles. Intenta más tarde.', { show_alert: true });
        return;
    }

    const buttons = methods.map(m => [Markup.button.callback(`${m.name} (${m.currency})`, `wit_${m.id}`)]);
    buttons.push([Markup.button.callback('◀ Volver', 'my_money')]);

    await safeEdit(ctx, '📤 <b>Selecciona un método de retiro:</b>', Markup.inlineKeyboard(buttons));
});

bot.action(/wit_(\d+)/, async (ctx) => {
    const methodId = parseInt(ctx.match[1]);
    const { data: method } = await supabase
        .from('withdraw_methods')
        .select('*')
        .eq('id', methodId)
        .single();

    if (!method) {
        await ctx.answerCbQuery('Método no encontrado. Por favor, selecciona otro.', { show_alert: true });
        return;
    }

    ctx.session.withdrawMethod = method;
    ctx.session.awaitingWithdrawAmount = true;

    const user = ctx.dbUser;
    const minWithdrawUSD = await getMinWithdrawUSD();
    const rateUSD = await getExchangeRateUSD();
    const minWithdrawCUP = (minWithdrawUSD * rateUSD).toFixed(2);

    // Mostrar saldo en la moneda del método
    let saldoEnMoneda = 0;
    switch (method.currency) {
        case 'CUP': saldoEnMoneda = parseFloat(user.cup); break;
        case 'USD': saldoEnMoneda = parseFloat(user.usd); break;
        case 'USDT': saldoEnMoneda = parseFloat(user.usdt); break;
        case 'TRX': saldoEnMoneda = parseFloat(user.trx); break;
        case 'MLC': saldoEnMoneda = parseFloat(user.mlc); break;
        default: saldoEnMoneda = 0;
    }

    await safeEdit(ctx,
        `Has elegido <b>${escapeHTML(method.name)}</b> (moneda: ${method.currency}).\n\n` +
        `💰 <b>Tu saldo disponible en ${method.currency}:</b> ${saldoEnMoneda.toFixed(2)}\n` +
        `⏳ <b>Mínimo de retiro:</b> ${minWithdrawCUP} CUP (equivalente a ${minWithdrawUSD} USD).\n\n` +
        `Por favor, escribe el <b>monto que deseas retirar</b> en ${method.currency} (ej: <code>500</code> para 500 ${method.currency}).\n` +
        (method.currency === 'USDT' || method.currency === 'TRX' ? `\n🔐 Recuerda enviar el monto exacto a la wallet y luego proporcionar el hash.` : ''),
        null
    );
});

// TRANSFERENCIA
bot.action('transfer', async (ctx) => {
    ctx.session.awaitingTransferTarget = true;
    await safeEdit(ctx,
        '🔄 <b>Transferir saldo a otro usuario</b>\n\n' +
        'Envía el <b>nombre de usuario</b> de Telegram (ej: @usuario) de la persona a la que deseas transferir.\n' +
        'También puedes usar su ID numérico si lo conoces.\n\n' +
        '⚠️ <b>Nota:</b> El bono no es transferible. Puedes transferir cualquier moneda (CUP, USD, USDT, TRX, MLC).\n\n' +
        'Por favor, ingresa el usuario:',
        null
    );
});

bot.action('my_bets', async (ctx) => {
    const uid = ctx.from.id;
    const { data: bets } = await supabase
        .from('bets')
        .select('*')
        .eq('user_id', uid)
        .order('placed_at', { ascending: false })
        .limit(5);

    if (!bets || bets.length === 0) {
        await safeEdit(ctx,
            '📭 No tienes jugadas registradas. ¡Anímate a participar! 🎲\n\n' +
            'Selecciona "🎲 Jugar" en el menú para empezar.',
            getMainKeyboard(ctx)
        );
    } else {
        let text = '📋 <b>Tus últimas 5 jugadas:</b>\n\n';
        bets.forEach((b, i) => {
            const date = moment(b.placed_at).tz(TIMEZONE).format('DD/MM/YYYY HH:mm');
            text += `<b>${i + 1}.</b> 🎰 ${escapeHTML(b.lottery)} - ${escapeHTML(b.bet_type)}\n` +
                `   📝 <code>${escapeHTML(b.raw_text)}</code>\n` +
                `   💰 Costo: ${b.items.map(it => `${it.amount} ${it.currency}`).join(', ')}\n` +
                `   🕒 ${date}\n\n`;
        });
        text += '¿Quieres ver más? Puedes consultar el historial completo en la WebApp.';
        await safeEdit(ctx, text, getMainKeyboard(ctx));
    }
});

bot.action('referrals', async (ctx) => {
    const uid = ctx.from.id;
    const { count } = await supabase
        .from('users')
        .select('*', { count: 'exact', head: true })
        .eq('ref_by', uid);

    const botInfo = await ctx.telegram.getMe();
    const link = `https://t.me/${botInfo.username}?start=${uid}`;

    await safeEdit(ctx,
        `💸 <b>¡GANA DINERO EXTRA INVITANDO AMIGOS! 💰</b>\n\n` +
        `🎯 <b>¿Cómo funciona?</b>\n` +
        `1️⃣ Comparte tu enlace personal con amigos\n` +
        `2️⃣ Cuando se registren y jueguen, tú ganas una comisión\n` +
        `3️⃣ Recibirás un porcentaje de CADA apuesta que realicen\n` +
        `4️⃣ ¡Es automático y para siempre! 🔄\n\n` +
        `🔥 Sin límites, sin topes, sin esfuerzo.\n\n` +
        `📲 <b>Tu enlace mágico:</b> 👇\n` +
        `<code>${escapeHTML(link)}</code>\n\n` +
        `📊 <b>Tus estadísticas:</b>\n` +
        `👥 Referidos registrados: ${count || 0}\n\n` +
        `¡Comparte y empieza a ganar hoy mismo!`,
        getMainKeyboard(ctx)
    );
});

bot.action('how_to_play', async (ctx) => {
    await safeEdit(ctx,
        '📩 <b>¿Necesitas ayuda?</b>\n\n' +
        'Puedes escribirnos directamente en este chat. Nuestro equipo de soporte te responderá a la mayor brevedad.\n\n' +
        'También puedes consultar la sección de preguntas frecuentes en nuestra WebApp.',
        Markup.inlineKeyboard([[Markup.button.callback('◀ Volver al inicio', 'main')]])
    );
});

// ADMIN PANEL
bot.action('admin_panel', async (ctx) => {
    if (!isAdmin(ctx.from.id)) {
        await ctx.answerCbQuery('⛔ No autorizado. Solo administradores.', { show_alert: true });
        return;
    }
    await safeEdit(ctx, '🔧 <b>Panel de administración</b>\nSelecciona una opción:', adminPanelKbd());
});

// Gestionar sesiones (sin cambios importantes, solo usar emojis)
bot.action('admin_sessions', async (ctx) => {
    if (!isAdmin(ctx.from.id)) return;
    await showRegionsMenu(ctx);
});

async function showRegionsMenu(ctx) {
    const buttons = [
        [Markup.button.callback('🦩 Florida', 'sess_region_Florida')],
        [Markup.button.callback('🍑 Georgia', 'sess_region_Georgia')],
        [Markup.button.callback('🗽 Nueva York', 'sess_region_Nueva York')],
        [Markup.button.callback('◀ Volver a Admin', 'admin_panel')]
    ];
    await safeEdit(ctx, '🎰 <b>Gestionar sesiones de juego</b>\n\nSelecciona una región:', Markup.inlineKeyboard(buttons));
}

bot.action(/sess_region_(.+)/, async (ctx) => {
    if (!isAdmin(ctx.from.id)) return;
    const lottery = ctx.match[1];
    await showRegionSessions(ctx, lottery);
});

async function showRegionSessions(ctx, lottery) {
    try {
        const today = moment.tz(TIMEZONE).format('YYYY-MM-DD');
        const { data: sessions } = await supabase
            .from('lottery_sessions')
            .select('*')
            .eq('lottery', lottery)
            .eq('date', today);

        const region = regionMap[lottery];
        if (!region) {
            await ctx.answerCbQuery('❌ Región no válida', { show_alert: true });
            return;
        }
        const schedule = getAllowedHours(region.key);

        let text = `🎰 <b>${region.emoji} ${lottery}</b>\n📅 ${today}\n\n`;
        const buttons = [];

        for (const slot of schedule.slots) {
            const turno = slot.name;
            const session = sessions.find(s => s.time_slot === turno);
            let estado, btnText, callbackData;
            if (session) {
                estado = session.status === 'open' ? '✅ Activa' : '🔴 Cerrada';
                btnText = `${turno} (${estado}) - ${session.status === 'open' ? 'Cerrar' : 'Abrir'}`;
                callbackData = `toggle_session_${session.id}_${session.status}`;
            } else {
                estado = '⚪ Inactiva';
                btnText = `${turno} (${estado}) - Abrir`;
                callbackData = `create_session_${lottery}_${turno}`;
            }
            buttons.push([Markup.button.callback(btnText, callbackData)]);
            text += `• ${turno}: ${estado}\n`;
        }

        buttons.push([Markup.button.callback('◀ Cambiar región', 'admin_sessions')]);
        buttons.push([Markup.button.callback('◀ Volver a Admin', 'admin_panel')]);

        await safeEdit(ctx, text, Markup.inlineKeyboard(buttons));
    } catch (e) {
        console.error(e);
        await ctx.answerCbQuery('❌ Error al cargar sesiones. Intenta más tarde.', { show_alert: true });
    }
}

bot.action(/create_session_(.+)_(.+)/, async (ctx) => {
    if (!isAdmin(ctx.from.id)) return;
    try {
        const lottery = ctx.match[1];
        const timeSlot = ctx.match[2];
        const endTime = getEndTimeFromSlot(lottery, timeSlot);
        if (!endTime) {
            await ctx.answerCbQuery(`❌ La hora de cierre para el turno ${timeSlot} ya pasó hoy. No se puede abrir.`, { show_alert: true });
            return;
        }
        const today = moment.tz(TIMEZONE).format('YYYY-MM-DD');

        const { data: existing } = await supabase
            .from('lottery_sessions')
            .select('id')
            .eq('lottery', lottery)
            .eq('date', today)
            .eq('time_slot', timeSlot)
            .maybeSingle();

        if (existing) {
            await ctx.answerCbQuery('❌ Ya existe una sesión para este turno hoy.', { show_alert: true });
            return;
        }

        const { error } = await supabase
            .from('lottery_sessions')
            .insert({
                lottery,
                date: today,
                time_slot: timeSlot,
                status: 'open',
                end_time: endTime.toISOString()
            });

        if (error) throw error;

        await ctx.answerCbQuery('✅ Sesión abierta correctamente');

        const region = regionMap[lottery];
        await broadcastToAllUsers(
            `🎲 <b>¡SESIÓN ABIERTA!</b> 🎲\n\n` +
            `✨ La región ${region.emoji} <b>${escapeHTML(lottery)}</b> acaba de abrir su turno de <b>${escapeHTML(timeSlot)}</b>.\n` +
            `💎 ¡Es tu momento! Realiza tus apuestas y llévate grandes premios.\n\n` +
            `⏰ Cierre: ${moment(endTime).tz(TIMEZONE).format('HH:mm')} (hora Cuba)\n` +
            `🍀 ¡La suerte te espera!`
        );

        await showRegionSessions(ctx, lottery);
    } catch (e) {
        console.error(e);
        await ctx.answerCbQuery('❌ Error al abrir sesión. Revisa los logs.', { show_alert: true });
    }
});

bot.action(/toggle_session_(\d+)_(.+)/, async (ctx) => {
    if (!isAdmin(ctx.from.id)) return;
    try {
        const sessionId = parseInt(ctx.match[1]);
        const currentStatus = ctx.match[2];
        const newStatus = currentStatus === 'open' ? 'closed' : 'open';

        const { error } = await supabase
            .from('lottery_sessions')
            .update({ status: newStatus, updated_at: new Date() })
            .eq('id', sessionId);

        if (error) throw error;

        const { data: session } = await supabase
            .from('lottery_sessions')
            .select('*')
            .eq('id', sessionId)
            .single();

        const region = regionMap[session.lottery];
        if (newStatus === 'closed') {
            await broadcastToAllUsers(
                `🔴 <b>SESIÓN CERRADA</b>\n\n` +
                `🎰 ${region.emoji} <b>${escapeHTML(session.lottery)}</b> - Turno <b>${escapeHTML(session.time_slot)}</b>\n` +
                `📅 Fecha: ${session.date}\n\n` +
                `❌ Ya no se reciben más apuestas para esta sesión.\n` +
                `🔢 Pronto anunciaremos el número ganador. ¡Mantente atento!`
            );
        }

        await ctx.answerCbQuery(newStatus === 'open' ? '✅ Sesión abierta' : '🔴 Sesión cerrada');
        await showRegionSessions(ctx, session.lottery);
    } catch (e) {
        console.error(e);
        await ctx.answerCbQuery('❌ Error al cambiar estado. Intenta más tarde.', { show_alert: true });
    }
});

// ========== ADMIN: AÑADIR MÉTODOS CON MONEDA ==========
bot.action('adm_add_dep', async (ctx) => {
    if (!isAdmin(ctx.from.id)) return;
    ctx.session.adminAction = 'add_dep';
    ctx.session.adminStep = 1;
    await ctx.reply('➕ <b>Añadir nuevo método de DEPÓSITO</b>\n\nPaso 1/4: Escribe el <b>nombre</b> del método (ej: "USDT-TRC20", "Transfermovil CUP"):', { parse_mode: 'HTML' });
    await ctx.answerCbQuery();
});

bot.action('adm_add_wit', async (ctx) => {
    if (!isAdmin(ctx.from.id)) return;
    ctx.session.adminAction = 'add_wit';
    ctx.session.adminStep = 1;
    await ctx.reply('➕ <b>Añadir nuevo método de RETIRO</b>\n\nPaso 1/4: Escribe el <b>nombre</b> del método (ej: "Efectivo USD", "USDT-BEP20"):', { parse_mode: 'HTML' });
    await ctx.answerCbQuery();
});

// ========== ADMIN: EDITAR MÉTODOS ==========
bot.action('adm_edit_dep', async (ctx) => {
    if (!isAdmin(ctx.from.id)) return;
    const { data: methods } = await supabase.from('deposit_methods').select('*').order('id');
    if (!methods || methods.length === 0) {
        await ctx.answerCbQuery('No hay métodos de depósito para editar.', { show_alert: true });
        return;
    }
    const buttons = methods.map(m => [Markup.button.callback(`${m.name} (${m.currency})`, `edit_dep_${m.id}`)]);
    buttons.push([Markup.button.callback('◀ Cancelar', 'admin_panel')]);
    await ctx.reply('✏️ <b>Editar método de DEPÓSITO</b>\nSelecciona el método que deseas modificar:', Markup.inlineKeyboard(buttons));
    await ctx.answerCbQuery();
});

bot.action('adm_edit_wit', async (ctx) => {
    if (!isAdmin(ctx.from.id)) return;
    const { data: methods } = await supabase.from('withdraw_methods').select('*').order('id');
    if (!methods || methods.length === 0) {
        await ctx.answerCbQuery('No hay métodos de retiro para editar.', { show_alert: true });
        return;
    }
    const buttons = methods.map(m => [Markup.button.callback(`${m.name} (${m.currency})`, `edit_wit_${m.id}`)]);
    buttons.push([Markup.button.callback('◀ Cancelar', 'admin_panel')]);
    await ctx.reply('✏️ <b>Editar método de RETIRO</b>\nSelecciona el método que deseas modificar:', Markup.inlineKeyboard(buttons));
    await ctx.answerCbQuery();
});

// ========== ADMIN: ELIMINAR MÉTODOS ==========
bot.action('adm_delete_dep', async (ctx) => {
    if (!isAdmin(ctx.from.id)) return;
    const { data: methods } = await supabase.from('deposit_methods').select('*').order('id');
    if (!methods || methods.length === 0) {
        await ctx.answerCbQuery('No hay métodos de depósito para eliminar.', { show_alert: true });
        return;
    }
    const buttons = methods.map(m => [Markup.button.callback(`${m.name} (${m.currency})`, `delete_dep_${m.id}`)]);
    buttons.push([Markup.button.callback('◀ Cancelar', 'admin_panel')]);
    await ctx.reply('🗑 <b>Eliminar método de DEPÓSITO</b>\nSelecciona el método que deseas eliminar:', Markup.inlineKeyboard(buttons));
    await ctx.answerCbQuery();
});

bot.action('adm_delete_wit', async (ctx) => {
    if (!isAdmin(ctx.from.id)) return;
    const { data: methods } = await supabase.from('withdraw_methods').select('*').order('id');
    if (!methods || methods.length === 0) {
        await ctx.answerCbQuery('No hay métodos de retiro para eliminar.', { show_alert: true });
        return;
    }
    const buttons = methods.map(m => [Markup.button.callback(`${m.name} (${m.currency})`, `delete_wit_${m.id}`)]);
    buttons.push([Markup.button.callback('◀ Cancelar', 'admin_panel')]);
    await ctx.reply('🗑 <b>Eliminar método de RETIRO</b>\nSelecciona el método que deseas eliminar:', Markup.inlineKeyboard(buttons));
    await ctx.answerCbQuery();
});

// ========== ADMIN: SELECCIÓN PARA EDITAR ==========
bot.action(/edit_dep_(\d+)/, async (ctx) => {
    if (!isAdmin(ctx.from.id)) return;
    const methodId = parseInt(ctx.match[1]);
    const { data: method } = await supabase.from('deposit_methods').select('*').eq('id', methodId).single();
    if (!method) {
        await ctx.answerCbQuery('Método no encontrado.', { show_alert: true });
        return;
    }
    ctx.session.editMethodId = methodId;
    ctx.session.editMethodType = 'deposit';
    ctx.session.adminAction = 'edit_method';
    ctx.session.editStep = 'choose_field';

    const buttons = [
        [Markup.button.callback('✏️ Nombre', 'edit_field_name')],
        [Markup.button.callback('✏️ Moneda', 'edit_field_currency')],
        [Markup.button.callback('✏️ Datos (card)', 'edit_field_card')],
        [Markup.button.callback('✏️ Confirmar', 'edit_field_confirm')],
        [Markup.button.callback('◀ Cancelar', 'admin_panel')]
    ];
    await ctx.reply(
        `✏️ Editando método <b>${escapeHTML(method.name)}</b> (ID: ${methodId})\n\n` +
        `Valores actuales:\n` +
        `📛 Nombre: ${escapeHTML(method.name)}\n` +
        `💱 Moneda: ${method.currency}\n` +
        `💳 Datos: ${escapeHTML(method.card)}\n` +
        `✅ Confirmar: ${escapeHTML(method.confirm)}\n\n` +
        `¿Qué campo deseas modificar?`,
        Markup.inlineKeyboard(buttons)
    );
    await ctx.answerCbQuery();
});

bot.action(/edit_wit_(\d+)/, async (ctx) => {
    if (!isAdmin(ctx.from.id)) return;
    const methodId = parseInt(ctx.match[1]);
    const { data: method } = await supabase.from('withdraw_methods').select('*').eq('id', methodId).single();
    if (!method) {
        await ctx.answerCbQuery('Método no encontrado.', { show_alert: true });
        return;
    }
    ctx.session.editMethodId = methodId;
    ctx.session.editMethodType = 'withdraw';
    ctx.session.adminAction = 'edit_method';
    ctx.session.editStep = 'choose_field';

    const buttons = [
        [Markup.button.callback('✏️ Nombre', 'edit_field_name')],
        [Markup.button.callback('✏️ Moneda', 'edit_field_currency')],
        [Markup.button.callback('✏️ Datos (card)', 'edit_field_card')],
        [Markup.button.callback('✏️ Confirmar', 'edit_field_confirm')],
        [Markup.button.callback('◀ Cancelar', 'admin_panel')]
    ];
    await ctx.reply(
        `✏️ Editando método <b>${escapeHTML(method.name)}</b> (ID: ${methodId})\n\n` +
        `Valores actuales:\n` +
        `📛 Nombre: ${escapeHTML(method.name)}\n` +
        `💱 Moneda: ${method.currency}\n` +
        `💳 Datos: ${escapeHTML(method.card)}\n` +
        `✅ Confirmar: ${escapeHTML(method.confirm)}\n\n` +
        `¿Qué campo deseas modificar?`,
        Markup.inlineKeyboard(buttons)
    );
    await ctx.answerCbQuery();
});

// ========== ADMIN: SELECCIÓN DE CAMPO A EDITAR ==========
bot.action('edit_field_name', async (ctx) => {
    ctx.session.editField = 'name';
    ctx.session.adminAction = 'edit_method';
    ctx.session.editStep = 'awaiting_value';
    await ctx.reply('✏️ Envía el <b>nuevo nombre</b> del método:');
    await ctx.answerCbQuery();
});

bot.action('edit_field_currency', async (ctx) => {
    ctx.session.editField = 'currency';
    ctx.session.adminAction = 'edit_method';
    ctx.session.editStep = 'awaiting_value';
    await ctx.reply('✏️ Envía la <b>nueva moneda</b> (CUP, USD, USDT, TRX, MLC):');
    await ctx.answerCbQuery();
});

bot.action('edit_field_card', async (ctx) => {
    ctx.session.editField = 'card';
    ctx.session.adminAction = 'edit_method';
    ctx.session.editStep = 'awaiting_value';
    await ctx.reply('✏️ Envía el <b>nuevo dato</b> (número de cuenta, dirección wallet, etc.):');
    await ctx.answerCbQuery();
});

bot.action('edit_field_confirm', async (ctx) => {
    ctx.session.editField = 'confirm';
    ctx.session.adminAction = 'edit_method';
    ctx.session.editStep = 'awaiting_value';
    await ctx.reply('✏️ Envía el <b>nuevo dato de confirmación</b> (red, teléfono, etc.):');
    await ctx.answerCbQuery();
});

// ========== ADMIN: CONFIRMACIÓN PARA ELIMINAR ==========
bot.action(/confirm_delete_dep_(\d+)/, async (ctx) => {
    if (!isAdmin(ctx.from.id)) return;
    const methodId = parseInt(ctx.match[1]);
    const { error } = await supabase.from('deposit_methods').delete().eq('id', methodId);
    if (error) {
        await ctx.reply(`❌ Error al eliminar: ${error.message}`);
    } else {
        await ctx.reply('✅ Método de DEPÓSITO eliminado correctamente.');
    }
    await ctx.answerCbQuery();
    await safeEdit(ctx, '🔧 <b>Panel de administración</b>', adminPanelKbd());
});

bot.action(/confirm_delete_wit_(\d+)/, async (ctx) => {
    if (!isAdmin(ctx.from.id)) return;
    const methodId = parseInt(ctx.match[1]);
    const { error } = await supabase.from('withdraw_methods').delete().eq('id', methodId);
    if (error) {
        await ctx.reply(`❌ Error al eliminar: ${error.message}`);
    } else {
        await ctx.reply('✅ Método de RETIRO eliminado correctamente.');
    }
    await ctx.answerCbQuery();
    await safeEdit(ctx, '🔧 <b>Panel de administración</b>', adminPanelKbd());
});

// ========== ADMIN: CONFIGURAR TASAS ==========
bot.action('adm_set_rate_usd', async (ctx) => {
    if (!isAdmin(ctx.from.id)) return;
    const rate = await getExchangeRateUSD();
    ctx.session.adminAction = 'set_rate_usd';
    await ctx.reply(`💰 <b>Tasa USD/CUP actual:</b> 1 USD = ${rate} CUP\n\nEnvía la nueva tasa (solo número, ej: 120):`, { parse_mode: 'HTML' });
    await ctx.answerCbQuery();
});

bot.action('adm_set_rate_usdt', async (ctx) => {
    if (!isAdmin(ctx.from.id)) return;
    const rate = await getExchangeRateUSDT();
    ctx.session.adminAction = 'set_rate_usdt';
    await ctx.reply(`💰 <b>Tasa USDT/CUP actual:</b> 1 USDT = ${rate} CUP\n\nEnvía la nueva tasa (solo número, ej: 110):`, { parse_mode: 'HTML' });
    await ctx.answerCbQuery();
});

bot.action('adm_set_rate_trx', async (ctx) => {
    if (!isAdmin(ctx.from.id)) return;
    const rate = await getExchangeRateTRX();
    ctx.session.adminAction = 'set_rate_trx';
    await ctx.reply(`💰 <b>Tasa TRX/CUP actual:</b> 1 TRX = ${rate} CUP\n\nEnvía la nueva tasa (solo número, ej: 1.5):`, { parse_mode: 'HTML' });
    await ctx.answerCbQuery();
});

// ========== ADMIN: MÍNIMOS ==========
bot.action('adm_min_deposit', async (ctx) => {
    if (!isAdmin(ctx.from.id)) return;
    const current = await getMinDepositUSD();
    ctx.session.adminAction = 'set_min_deposit';
    await ctx.reply(`💰 <b>Mínimo de depósito actual:</b> ${current} USD (equivale a ${(current * await getExchangeRateUSD()).toFixed(2)} CUP)\n\nEnvía el nuevo mínimo en USD (solo número, ej: 5):`, { parse_mode: 'HTML' });
    await ctx.answerCbQuery();
});

bot.action('adm_min_withdraw', async (ctx) => {
    if (!isAdmin(ctx.from.id)) return;
    const current = await getMinWithdrawUSD();
    const rate = await getExchangeRateUSD();
    ctx.session.adminAction = 'set_min_withdraw';
    await ctx.reply(`💰 <b>Mínimo de retiro actual:</b> ${current} USD (equivale a ${(current * rate).toFixed(2)} CUP)\n\nEnvía el nuevo mínimo en USD (solo número, ej: 2):`, { parse_mode: 'HTML' });
    await ctx.answerCbQuery();
});

// ========== ADMIN: PRECIOS DE JUGADAS ==========
bot.action('adm_set_prices', async (ctx) => {
    if (!isAdmin(ctx.from.id)) return;
    const { data: prices } = await supabase.from('play_prices').select('*');
    const buttons = prices.map(p => [Markup.button.callback(p.bet_type, `set_price_${p.bet_type}`)]);
    buttons.push([Markup.button.callback('◀ Cancelar', 'admin_panel')]);
    await ctx.reply('🎲 <b>Configurar precios y pagos</b>\nElige el tipo de jugada que deseas modificar:', Markup.inlineKeyboard(buttons));
    await ctx.answerCbQuery();
});

bot.action(/set_price_(.+)/, async (ctx) => {
    if (!isAdmin(ctx.from.id)) return;
    const betType = ctx.match[1];
    ctx.session.adminAction = 'set_price';
    ctx.session.betType = betType;
    ctx.session.priceStep = 1;
    await ctx.reply(
        `⚙️ Configurando precios para <b>${betType}</b> (valores globales para todas las regiones)\n\n` +
        `Paso 1/3: Ingresa el costo en formato <b>cup/usd</b>\n` +
        `Ejemplo: <code>70/0.20</code>  (70 CUP y 0.20 USD)`,
        { parse_mode: 'HTML' }
    );
    await ctx.answerCbQuery();
});

bot.action('adm_min_per_bet', async (ctx) => {
    if (!isAdmin(ctx.from.id)) return;
    const { data: prices } = await supabase.from('play_prices').select('*');
    const buttons = prices.map(p => [Markup.button.callback(p.bet_type, `set_min_${p.bet_type}`)]);
    buttons.push([Markup.button.callback('◀ Cancelar', 'admin_panel')]);
    await ctx.reply('💰 <b>Configurar montos mínimos por jugada</b>\nElige el tipo de jugada:', Markup.inlineKeyboard(buttons));
    await ctx.answerCbQuery();
});

bot.action(/set_min_(.+)/, async (ctx) => {
    if (!isAdmin(ctx.from.id)) return;
    const betType = ctx.match[1];
    ctx.session.adminAction = 'set_min';
    ctx.session.betType = betType;
    ctx.session.minStep = 1;
    await ctx.reply(
        `⚙️ Configurando mínimos para <b>${betType}</b>\n\n` +
        `Paso 1/2: Ingresa el <b>monto mínimo en CUP</b> (0 = sin mínimo):`,
        { parse_mode: 'HTML' }
    );
    await ctx.answerCbQuery();
});

// ========== ADMIN: VER DATOS ==========
bot.action('adm_view', async (ctx) => {
    if (!isAdmin(ctx.from.id)) return;
    const rateUSD = await getExchangeRateUSD();
    const rateUSDT = await getExchangeRateUSDT();
    const rateTRX = await getExchangeRateTRX();
    const minDep = await getMinDepositUSD();
    const minWit = await getMinWithdrawUSD();
    const { data: depMethods } = await supabase.from('deposit_methods').select('*');
    const { data: witMethods } = await supabase.from('withdraw_methods').select('*');
    const { data: prices } = await supabase.from('play_prices').select('*');

    let text = `💰 <b>Tasas de cambio:</b>\n`;
    text += `USD/CUP: 1 USD = ${rateUSD} CUP\n`;
    text += `USDT/CUP: 1 USDT = ${rateUSDT} CUP\n`;
    text += `TRX/CUP: 1 TRX = ${rateTRX} CUP\n\n`;
    text += `📥 <b>Mínimo depósito:</b> ${minDep} USD (${(minDep * rateUSD).toFixed(2)} CUP)\n`;
    text += `📤 <b>Mínimo retiro:</b> ${minWit} USD (${(minWit * rateUSD).toFixed(2)} CUP)\n\n`;
    text += `📥 <b>Métodos de DEPÓSITO:</b>\n`;
    depMethods?.forEach(m => text += `  ID ${m.id}: ${escapeHTML(m.name)} (${m.currency}) - ${escapeHTML(m.card)} / ${escapeHTML(m.confirm)}\n`);
    text += `\n📤 <b>Métodos de RETIRO:</b>\n`;
    witMethods?.forEach(m => text += `  ID ${m.id}: ${escapeHTML(m.name)} (${m.currency}) - ${escapeHTML(m.card)} / ${escapeHTML(m.confirm)}\n`);
    text += `\n🎲 <b>Precios por jugada (globales):</b>\n`;
    prices?.forEach(p => text += `  ${p.bet_type}: ${p.amount_cup} CUP / ${p.amount_usd} USD  (paga x${p.payout_multiplier || 0})  (mín: ${p.min_cup||0} CUP / ${p.min_usd||0} USD)\n`);

    await safeEdit(ctx, text, Markup.inlineKeyboard([[Markup.button.callback('◀ Volver a Admin', 'admin_panel')]]));
});

// ========== ADMIN: PUBLICAR GANADORES ==========
bot.action('admin_winning', async (ctx) => {
    if (!isAdmin(ctx.from.id)) return;

    const { data: closedSessions } = await supabase
        .from('lottery_sessions')
        .select('*')
        .eq('status', 'closed')
        .order('date', { ascending: false });

    const { data: published } = await supabase
        .from('winning_numbers')
        .select('lottery, date, time_slot');

    const publishedSet = new Set(published?.map(p => `${p.lottery}|${p.date}|${p.time_slot}`) || []);

    const availableSessions = closedSessions.filter(s =>
        !publishedSet.has(`${s.lottery}|${s.date}|${s.time_slot}`)
    );

    if (availableSessions.length === 0) {
        await ctx.reply('🔢 No hay sesiones cerradas pendientes de publicar. Todas las sesiones tienen números ganadores registrados.');
        return;
    }

    const buttons = availableSessions.map(s => {
        const region = regionMap[s.lottery];
        return [Markup.button.callback(
            `${region?.emoji || '🎰'} ${s.lottery} - ${s.date} (${s.time_slot})`,
            `publish_win_${s.id}`
        )];
    });
    buttons.push([Markup.button.callback('◀ Cancelar', 'admin_panel')]);

    await ctx.reply('🔢 <b>Publicar números ganadores</b>\nSelecciona la sesión para la cual deseas ingresar el número ganador:', Markup.inlineKeyboard(buttons));
    await ctx.answerCbQuery();
});

bot.action(/publish_win_(\d+)/, async (ctx) => {
    if (!isAdmin(ctx.from.id)) return;
    const sessionId = parseInt(ctx.match[1]);
    ctx.session.winningSessionId = sessionId;
    ctx.session.adminAction = 'winning_numbers';
    await ctx.reply(
        '✍️ <b>Ingresa el número ganador de 7 DÍGITOS</b>\n' +
        'Formato: centena (3) + cuarteta (4). Ejemplo: <code>5173262</code> o <code>517 3262</code>\n\n' +
        'Se desglosará automáticamente en:\n' +
        '• Centena: primeros 3 dígitos\n' +
        '• Fijo: últimos 2 de la centena\n' +
        '• Corridos: fijo, primeros 2 de cuarteta, últimos 2 de cuarteta\n' +
        '• Parles: combinaciones de los corridos',
        { parse_mode: 'HTML' }
    );
    await ctx.answerCbQuery();
});

// ========== FUNCIÓN AUXILIAR PARA FORMATEAR NÚMERO GANADOR ==========
function formatWinningNumber(num) {
    if (!num || num.length !== 7) return num;
    return num.slice(0, 3) + ' ' + num.slice(3);
}

async function processWinningNumber(sessionId, winningStr, ctx) {
    winningStr = winningStr.replace(/\s+/g, '');
    if (!/^\d{7}$/.test(winningStr)) {
        await ctx.reply('❌ El número debe tener EXACTAMENTE 7 dígitos. Por favor, inténtalo de nuevo.');
        return false;
    }

    const { data: session } = await supabase
        .from('lottery_sessions')
        .select('*')
        .eq('id', sessionId)
        .single();

    if (!session) {
        await ctx.reply('❌ Sesión no encontrada. Verifica el ID.');
        return false;
    }

    const { data: existingWin } = await supabase
        .from('winning_numbers')
        .select('id')
        .eq('lottery', session.lottery)
        .eq('date', session.date)
        .eq('time_slot', session.time_slot)
        .maybeSingle();

    if (existingWin) {
        await ctx.reply('❌ Esta sesión ya tiene un número ganador publicado. No se puede sobrescribir.');
        return false;
    }

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

    const { error: insertError } = await supabase
        .from('winning_numbers')
        .insert({
            lottery: session.lottery,
            date: session.date,
            time_slot: session.time_slot,
            numbers: [winningStr],
            published_at: new Date()
        });

    if (insertError) {
        await ctx.reply(`❌ Error al guardar: ${insertError.message}`);
        return false;
    }

    const { data: multipliers } = await supabase
        .from('play_prices')
        .select('bet_type, payout_multiplier');

    const multiplierMap = {};
    multipliers.forEach(m => { multiplierMap[m.bet_type] = parseFloat(m.payout_multiplier) || 0; });

    const { data: bets } = await supabase
        .from('bets')
        .select('*')
        .eq('session_id', sessionId);

    const rateUSD = await getExchangeRateUSD();
    const rateUSDT = await getExchangeRateUSDT();
    const rateTRX = await getExchangeRateTRX();
    const formattedWinning = formatWinningNumber(winningStr);

    for (const bet of bets || []) {
        const { data: userBefore } = await supabase
            .from('users')
            .select('cup, usd, usdt, trx, mlc, bonus_cup')
            .eq('telegram_id', bet.user_id)
            .single();

        let premioTotalCUP = 0;
        const items = bet.items || [];

        for (const item of items) {
            const numero = item.numero;
            const multiplicador = multiplierMap[bet.bet_type] || 0;
            let ganado = false;

            switch (bet.bet_type) {
                case 'fijo':
                    if (numero.startsWith('D')) {
                        const digito = numero[1];
                        if (fijo.startsWith(digito)) ganado = true;
                    } else if (numero.startsWith('T')) {
                        const digito = numero[1];
                        if (fijo.endsWith(digito)) ganado = true;
                    } else {
                        if (numero === fijo) ganado = true;
                    }
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
                // Convertir el monto de la apuesta a CUP según su moneda
                let montoCUP = 0;
                switch (item.currency) {
                    case 'CUP': montoCUP = item.amount; break;
                    case 'USD': montoCUP = item.amount * rateUSD; break;
                    case 'USDT': montoCUP = item.amount * rateUSDT; break;
                    case 'TRX': montoCUP = item.amount * rateTRX; break;
                    case 'MLC': montoCUP = item.amount * rateUSD; break;
                }
                premioTotalCUP += montoCUP * multiplicador;
            }
        }

        if (premioTotalCUP > 0) {
            // Acreditar en CUP (principal) por simplicidad
            let newCup = parseFloat(userBefore.cup) + premioTotalCUP;
            await supabase
                .from('users')
                .update({ cup: newCup, updated_at: new Date() })
                .eq('telegram_id', bet.user_id);

            await bot.telegram.sendMessage(bet.user_id,
                `🎉 <b>¡FELICIDADES! Has ganado</b>\n\n` +
                `🔢 Número ganador: <code>${formattedWinning}</code>\n` +
                `🎰 ${regionMap[session.lottery]?.emoji || '🎰'} ${escapeHTML(session.lottery)} - ${escapeHTML(session.time_slot)}\n` +
                `💰 Premio: ${premioTotalCUP.toFixed(2)} CUP\n\n` +
                `✅ El premio ya fue acreditado a tu saldo en CUP. ¡Sigue disfrutando!`,
                { parse_mode: 'HTML' }
            );
        } else {
            await bot.telegram.sendMessage(bet.user_id,
                `🔢 <b>Números ganadores de ${regionMap[session.lottery]?.emoji || '🎰'} ${escapeHTML(session.lottery)} (${session.date} - ${escapeHTML(session.time_slot)})</b>\n\n` +
                `Número: <code>${formattedWinning}</code>\n\n` +
                `😔 Esta vez no has ganado, pero no te desanimes. ¡Sigue intentando y la suerte llegará!\n\n` +
                `🍀 ¡Mucha suerte en la próxima!`,
                { parse_mode: 'HTML' }
            );
        }
    }

    await broadcastToAllUsers(
        `📢 <b>NÚMERO GANADOR PUBLICADO</b>\n\n` +
        `🎰 ${regionMap[session.lottery]?.emoji || '🎰'} <b>${escapeHTML(session.lottery)}</b> - Turno <b>${escapeHTML(session.time_slot)}</b>\n` +
        `📅 Fecha: ${session.date}\n` +
        `🔢 Número: <code>${formattedWinning}</code>\n\n` +
        `💬 Revisa tu historial para ver si has ganado. ¡Mucha suerte en las próximas jugadas!`
    );

    await ctx.reply(`✅ Números ganadores publicados y premios calculados correctamente.`);
    return true;
}

// ========== MANEJADOR DE TEXTO ==========
bot.on(message('text'), async (ctx) => {
    const uid = ctx.from.id;
    const text = ctx.message.text.trim();
    const session = ctx.session;
    const user = ctx.dbUser;

    // Botones principales del teclado
    const mainButtons = ['🎲 Jugar', '💰 Mi dinero', '📋 Mis jugadas', '👥 Referidos', '❓ Cómo jugar', '🌐 Abrir WebApp', '🔧 Admin'];
    if (mainButtons.includes(text)) {
        if (text === '🎲 Jugar') {
            await safeEdit(ctx, '🎲 Por favor, selecciona una lotería para comenzar a jugar:', playLotteryKbd());
            return;
        } else if (text === '💰 Mi dinero') {
            const user = ctx.dbUser;
            const rateUSD = await getExchangeRateUSD();
            const rateUSDT = await getExchangeRateUSDT();
            const rateTRX = await getExchangeRateTRX();

            const cup = parseFloat(user.cup);
            const usd = parseFloat(user.usd);
            const usdt = parseFloat(user.usdt);
            const trx = parseFloat(user.trx);
            const mlc = parseFloat(user.mlc);
            const bonusCup = parseFloat(user.bonus_cup);

            const text = `💰 <b>Tu saldo actual es:</b>\n\n` +
                `🇨🇺 <b>CUP:</b> ${cup.toFixed(2)} (principal)\n` +
                `💵 <b>USD:</b> ${usd.toFixed(2)} (≈ ${(usd * rateUSD).toFixed(2)} CUP)\n` +
                `₮ <b>USDT:</b> ${usdt.toFixed(2)} (≈ ${(usdt * rateUSDT).toFixed(2)} CUP)\n` +
                `🔷 <b>TRX:</b> ${trx.toFixed(2)} (≈ ${(trx * rateTRX).toFixed(2)} CUP)\n` +
                `💳 <b>MLC:</b> ${mlc.toFixed(2)} (≈ ${(mlc * rateUSD).toFixed(2)} CUP)\n` +
                `🎁 <b>Bono (no retirable):</b> ${bonusCup.toFixed(2)} CUP\n\n` +
                `¿Qué deseas hacer?`;
            await safeEdit(ctx, text, myMoneyKbd());
            return;
        } else if (text === '📋 Mis jugadas') {
            const uid = ctx.from.id;
            const { data: bets } = await supabase
                .from('bets')
                .select('*')
                .eq('user_id', uid)
                .order('placed_at', { ascending: false })
                .limit(5);

            if (!bets || bets.length === 0) {
                await safeEdit(ctx,
                    '📭 Aún no has realizado ninguna jugada. ¡Anímate a participar! 🎲\n\n' +
                    'Selecciona "🎲 Jugar" en el menú para empezar.',
                    getMainKeyboard(ctx)
                );
            } else {
                let text = '📋 <b>Tus últimas 5 jugadas:</b>\n\n';
                bets.forEach((b, i) => {
                    const date = moment(b.placed_at).tz(TIMEZONE).format('DD/MM/YYYY HH:mm');
                    text += `<b>${i + 1}.</b> 🎰 ${escapeHTML(b.lottery)} - ${escapeHTML(b.bet_type)}\n` +
                        `   📝 <code>${escapeHTML(b.raw_text)}</code>\n` +
                        `   💰 Costo: ${b.items.map(it => `${it.amount} ${it.currency}`).join(', ')}\n` +
                        `   🕒 ${date}\n\n`;
                });
                text += '¿Quieres ver más? Puedes consultar el historial completo en la WebApp.';
                await safeEdit(ctx, text, getMainKeyboard(ctx));
            }
            return;
        } else if (text === '👥 Referidos') {
            const uid = ctx.from.id;
            const { count } = await supabase
                .from('users')
                .select('*', { count: 'exact', head: true })
                .eq('ref_by', uid);

            const botInfo = await ctx.telegram.getMe();
            const link = `https://t.me/${botInfo.username}?start=${uid}`;

            await safeEdit(ctx,
                `💸 <b>¡GANA DINERO EXTRA INVITANDO AMIGOS! 💰</b>\n\n` +
                `🎯 <b>¿Cómo funciona?</b>\n` +
                `1️⃣ Comparte tu enlace personal con amigos\n` +
                `2️⃣ Cuando se registren y jueguen, tú ganas una comisión\n` +
                `3️⃣ Recibirás un porcentaje de CADA apuesta que realicen\n` +
                `4️⃣ ¡Es automático y para siempre! 🔄\n\n` +
                `🔥 Sin límites, sin topes, sin esfuerzo.\n\n` +
                `📲 <b>Tu enlace mágico:</b> 👇\n` +
                `<code>${escapeHTML(link)}</code>\n\n` +
                `📊 <b>Tus estadísticas:</b>\n` +
                `👥 Referidos registrados: ${count || 0}\n\n` +
                `¡Comparte y empieza a ganar hoy mismo!`,
                getMainKeyboard(ctx)
            );
            return;
        } else if (text === '❓ Cómo jugar') {
            await safeEdit(ctx,
                '📩 <b>¿Necesitas ayuda?</b>\n\n' +
                'Puedes escribirnos directamente en este chat. Nuestro equipo de soporte te responderá a la mayor brevedad.\n\n' +
                'También puedes consultar la sección de preguntas frecuentes en nuestra WebApp.',
                Markup.inlineKeyboard([[Markup.button.callback('◀ Volver al inicio', 'main')]])
            );
            return;
        } else if (text === '🌐 Abrir WebApp') {
            const webAppButton = Markup.inlineKeyboard([
                Markup.button.webApp('🚀 Abrir WebApp', `${WEBAPP_URL}/app.html`)
            ]);
            await ctx.reply('Haz clic en el botón para acceder a nuestra plataforma web interactiva:', webAppButton);
            return;
        } else if (text === '🔧 Admin' && isAdmin(uid)) {
            await safeEdit(ctx, '🔧 <b>Panel de administración</b>\nSelecciona una opción:', adminPanelKbd());
            return;
        }
    }

    // ========== ADMIN: FLUJO DE EDICIÓN ==========
    if (isAdmin(uid) && session.adminAction === 'edit_method' && session.editStep === 'awaiting_value') {
        const newValue = text;
        const methodId = session.editMethodId;
        const field = session.editField;
        const type = session.editMethodType;
        const table = type === 'deposit' ? 'deposit_methods' : 'withdraw_methods';

        const updateData = {};
        updateData[field] = newValue;

        const { error } = await supabase.from(table).update(updateData).eq('id', methodId);
        if (error) {
            await ctx.reply(`❌ Error al actualizar: ${error.message}`);
        } else {
            await ctx.reply(`✅ Campo <b>${field}</b> actualizado correctamente.`, { parse_mode: 'HTML' });
        }
        delete session.adminAction;
        delete session.editMethodId;
        delete session.editMethodType;
        delete session.editStep;
        delete session.editField;
        await safeEdit(ctx, '🔧 <b>Panel de administración</b>', adminPanelKbd());
        return;
    }

    // ========== ADMIN: FLUJOS DE AÑADIR MÉTODOS (con moneda) ==========
    if (isAdmin(uid) && session.adminAction) {
        if (session.adminAction === 'add_dep') {
            if (session.adminStep === 1) {
                session.adminTempName = text;
                session.adminStep = 2;
                await ctx.reply('Paso 2/4: Ahora envía la <b>moneda</b> del método (CUP, USD, USDT, TRX, MLC):', { parse_mode: 'HTML' });
                return;
            } else if (session.adminStep === 2) {
                const currency = text.toUpperCase();
                if (!['CUP','USD','USDT','TRX','MLC'].includes(currency)) {
                    await ctx.reply('❌ Moneda no válida. Debe ser CUP, USD, USDT, TRX o MLC.');
                    return;
                }
                session.adminTempCurrency = currency;
                session.adminStep = 3;
                await ctx.reply('Paso 3/4: Ahora envía el <b>dato principal</b> (número de cuenta, dirección wallet, etc.):', { parse_mode: 'HTML' });
                return;
            } else if (session.adminStep === 3) {
                session.adminTempCard = text;
                session.adminStep = 4;
                await ctx.reply('Paso 4/4: Finalmente, envía el <b>dato de confirmación</b> (para cripto, la red; para otros, número a confirmar):', { parse_mode: 'HTML' });
                return;
            } else if (session.adminStep === 4) {
                const { data, error } = await supabase
                    .from('deposit_methods')
                    .insert({
                        name: session.adminTempName,
                        currency: session.adminTempCurrency,
                        card: session.adminTempCard,
                        confirm: text
                    })
                    .select()
                    .single();
                if (error) await ctx.reply(`❌ Error al añadir: ${error.message}`);
                else await ctx.reply(`✅ Método de depósito <b>${escapeHTML(session.adminTempName)}</b> (${session.adminTempCurrency}) añadido correctamente con ID ${data.id}.`, { parse_mode: 'HTML' });
                delete session.adminAction;
                await safeEdit(ctx, '🔧 <b>Panel de administración</b>', adminPanelKbd());
                return;
            }
        }

        if (session.adminAction === 'add_wit') {
            if (session.adminStep === 1) {
                session.adminTempName = text;
                session.adminStep = 2;
                await ctx.reply('Paso 2/4: Ahora envía la <b>moneda</b> del método (CUP, USD, USDT, TRX, MLC):', { parse_mode: 'HTML' });
                return;
            } else if (session.adminStep === 2) {
                const currency = text.toUpperCase();
                if (!['CUP','USD','USDT','TRX','MLC'].includes(currency)) {
                    await ctx.reply('❌ Moneda no válida. Debe ser CUP, USD, USDT, TRX o MLC.');
                    return;
                }
                session.adminTempCurrency = currency;
                session.adminStep = 3;
                await ctx.reply('Paso 3/4: Ahora envía el <b>dato principal</b> (número de cuenta, dirección wallet, etc.):', { parse_mode: 'HTML' });
                return;
            } else if (session.adminStep === 3) {
                session.adminTempCard = text;
                session.adminStep = 4;
                await ctx.reply('Paso 4/4: Finalmente, envía el <b>dato de confirmación</b> (para cripto, la red; para otros, número a confirmar):', { parse_mode: 'HTML' });
                return;
            } else if (session.adminStep === 4) {
                const { data, error } = await supabase
                    .from('withdraw_methods')
                    .insert({
                        name: session.adminTempName,
                        currency: session.adminTempCurrency,
                        card: session.adminTempCard,
                        confirm: text
                    })
                    .select()
                    .single();
                if (error) await ctx.reply(`❌ Error al añadir: ${error.message}`);
                else await ctx.reply(`✅ Método de retiro <b>${escapeHTML(session.adminTempName)}</b> (${session.adminTempCurrency}) añadido correctamente con ID ${data.id}.`, { parse_mode: 'HTML' });
                delete session.adminAction;
                await safeEdit(ctx, '🔧 <b>Panel de administración</b>', adminPanelKbd());
                return;
            }
        }

        // Configurar tasas
        if (session.adminAction === 'set_rate_usd') {
            const rate = parseFloat(text.replace(',', '.'));
            if (isNaN(rate) || rate <= 0) {
                await ctx.reply('❌ Número inválido. Por favor, envía un número positivo (ej: 120).');
                return;
            }
            await setExchangeRateUSD(rate);
            await ctx.reply(`✅ Tasa USD/CUP actualizada: 1 USD = ${rate} CUP`, { parse_mode: 'HTML' });
            delete session.adminAction;
            await safeEdit(ctx, '🔧 <b>Panel de administración</b>', adminPanelKbd());
            return;
        }

        if (session.adminAction === 'set_rate_usdt') {
            const rate = parseFloat(text.replace(',', '.'));
            if (isNaN(rate) || rate <= 0) {
                await ctx.reply('❌ Número inválido. Por favor, envía un número positivo (ej: 110).');
                return;
            }
            await setExchangeRateUSDT(rate);
            await ctx.reply(`✅ Tasa USDT/CUP actualizada: 1 USDT = ${rate} CUP`, { parse_mode: 'HTML' });
            delete session.adminAction;
            await safeEdit(ctx, '🔧 <b>Panel de administración</b>', adminPanelKbd());
            return;
        }

        if (session.adminAction === 'set_rate_trx') {
            const rate = parseFloat(text.replace(',', '.'));
            if (isNaN(rate) || rate <= 0) {
                await ctx.reply('❌ Número inválido. Por favor, envía un número positivo (ej: 1.5).');
                return;
            }
            await setExchangeRateTRX(rate);
            await ctx.reply(`✅ Tasa TRX/CUP actualizada: 1 TRX = ${rate} CUP`, { parse_mode: 'HTML' });
            delete session.adminAction;
            await safeEdit(ctx, '🔧 <b>Panel de administración</b>', adminPanelKbd());
            return;
        }

        if (session.adminAction === 'set_min_deposit') {
            const value = parseFloat(text.replace(',', '.'));
            if (isNaN(value) || value <= 0) {
                await ctx.reply('❌ Número inválido. Envía un número positivo (ej: 5).');
                return;
            }
            await setMinDepositUSD(value);
            await ctx.reply(`✅ Mínimo de depósito actualizado a: ${value} USD (equivale a ${(value * await getExchangeRateUSD()).toFixed(2)} CUP)`, { parse_mode: 'HTML' });
            delete session.adminAction;
            await safeEdit(ctx, '🔧 <b>Panel de administración</b>', adminPanelKbd());
            return;
        }

        if (session.adminAction === 'set_min_withdraw') {
            const value = parseFloat(text.replace(',', '.'));
            if (isNaN(value) || value <= 0) {
                await ctx.reply('❌ Número inválido. Envía un número positivo (ej: 2).');
                return;
            }
            await setMinWithdrawUSD(value);
            await ctx.reply(`✅ Mínimo de retiro actualizado a: ${value} USD (equivale a ${(value * await getExchangeRateUSD()).toFixed(2)} CUP)`, { parse_mode: 'HTML' });
            delete session.adminAction;
            await safeEdit(ctx, '🔧 <b>Panel de administración</b>', adminPanelKbd());
            return;
        }

        if (session.adminAction === 'set_price') {
            if (session.priceStep === 1) {
                const parts = text.split('/');
                if (parts.length !== 2) {
                    await ctx.reply('❌ Formato inválido. Debe ser <code>cup/usd</code> (ej: 70/0.20)', { parse_mode: 'HTML' });
                    return;
                }
                const cup = parseFloat(parts[0].replace(',', '.'));
                const usd = parseFloat(parts[1].replace(',', '.'));
                if (isNaN(cup) || isNaN(usd) || cup < 0 || usd < 0) {
                    await ctx.reply('❌ Montos inválidos. Deben ser números positivos.');
                    return;
                }
                session.priceTempCup = cup;
                session.priceTempUsd = usd;
                session.priceStep = 2;
                await ctx.reply(
                    `Paso 2/3: Ingresa el <b>multiplicador de premio</b> (ej: 500).`,
                    { parse_mode: 'HTML' }
                );
                return;
            } else if (session.priceStep === 2) {
                const multiplier = parseFloat(text.replace(',', '.'));
                if (isNaN(multiplier) || multiplier < 0) {
                    await ctx.reply('❌ Multiplicador inválido. Debe ser un número positivo.');
                    return;
                }
                session.priceTempMultiplier = multiplier;
                session.priceStep = 3;
                await ctx.reply(
                    `Paso 3/3: Confirma los valores:\n` +
                    `💰 Costo: ${session.priceTempCup} CUP / ${session.priceTempUsd} USD\n` +
                    `🎁 Multiplicador: x${session.priceTempMultiplier}\n\n` +
                    `¿Guardar? Responde <b>sí</b> para confirmar o <b>no</b> para cancelar.`,
                    { parse_mode: 'HTML' }
                );
                return;
            } else if (session.priceStep === 3) {
                if (text.toLowerCase() === 'sí' || text.toLowerCase() === 'si') {
                    const betType = session.betType;
                    await supabase
                        .from('play_prices')
                        .update({
                            amount_cup: session.priceTempCup,
                            amount_usd: session.priceTempUsd,
                            payout_multiplier: session.priceTempMultiplier,
                            updated_at: new Date()
                        })
                        .eq('bet_type', betType);
                    await ctx.reply(
                        `✅ Precio para <b>${betType}</b> actualizado globalmente:\n` +
                        `💰 Costo: ${session.priceTempCup} CUP / ${session.priceTempUsd} USD\n` +
                        `🎁 Multiplicador: x${session.priceTempMultiplier}`,
                        { parse_mode: 'HTML' }
                    );
                } else {
                    await ctx.reply('❌ Configuración cancelada.');
                }
                delete session.adminAction;
                delete session.priceStep;
                delete session.priceTempCup;
                delete session.priceTempUsd;
                delete session.priceTempMultiplier;
                delete session.betType;
                await safeEdit(ctx, '🔧 <b>Panel de administración</b>', adminPanelKbd());
                return;
            }
        }

        if (session.adminAction === 'set_min') {
            if (session.minStep === 1) {
                const minCup = parseFloat(text.replace(',', '.'));
                if (isNaN(minCup) || minCup < 0) {
                    await ctx.reply('❌ Monto inválido. Debe ser un número positivo o 0.');
                    return;
                }
                session.minTempCup = minCup;
                session.minStep = 2;
                await ctx.reply(
                    `Paso 2/2: Ingresa el <b>monto mínimo en USD</b> (0 = sin mínimo):`,
                    { parse_mode: 'HTML' }
                );
                return;
            } else if (session.minStep === 2) {
                const minUsd = parseFloat(text.replace(',', '.'));
                if (isNaN(minUsd) || minUsd < 0) {
                    await ctx.reply('❌ Monto inválido. Debe ser un número positivo o 0.');
                    return;
                }
                const betType = session.betType;
                await supabase
                    .from('play_prices')
                    .update({
                        min_cup: session.minTempCup,
                        min_usd: minUsd,
                        updated_at: new Date()
                    })
                    .eq('bet_type', betType);
                await ctx.reply(
                    `✅ Mínimos para <b>${betType}</b> actualizados:\n` +
                    `📉 Mínimo CUP: ${session.minTempCup}\n` +
                    `📉 Mínimo USD: ${minUsd}`,
                    { parse_mode: 'HTML' }
                );
                delete session.adminAction;
                delete session.minStep;
                delete session.minTempCup;
                delete session.betType;
                await safeEdit(ctx, '🔧 <b>Panel de administración</b>', adminPanelKbd());
                return;
            }
        }

        if (session.adminAction === 'winning_numbers') {
            const sessionId = session.winningSessionId;
            const success = await processWinningNumber(sessionId, text, ctx);
            if (success) {
                delete session.adminAction;
                delete session.winningSessionId;
                await safeEdit(ctx, '🔧 <b>Panel de administración</b>', adminPanelKbd());
            }
            return;
        }
    }

    // ========== FLUJOS DE USUARIO (DEPÓSITO, RETIRO, TRANSFERENCIA, APUESTAS) ==========

    // Depósito: después de la foto, esperamos el monto
    if (session.awaitingDepositAmount) {
        const amountText = text;
        const method = session.depositMethod;
        const buffer = session.depositPhotoBuffer;
        if (!buffer) {
            await ctx.reply('❌ Error: no se encontró la captura. Por favor, comienza el proceso de recarga de nuevo.', getMainKeyboard(ctx));
            delete session.awaitingDepositAmount;
            return;
        }

        // Parsear monto con moneda
        const parsed = parseAmountWithCurrency(amountText);
        if (!parsed) {
            await ctx.reply('❌ Formato inválido. Debes escribir el monto seguido de la moneda (ej: <code>500 cup</code> o <code>10 usdt</code>).', getMainKeyboard(ctx));
            return;
        }

        // Validar que la moneda coincida con la del método
        if (parsed.currency !== method.currency) {
            await ctx.reply(`❌ La moneda del monto (${parsed.currency}) no coincide con la del método (${method.currency}). Por favor, envía el monto en ${method.currency}.`, getMainKeyboard(ctx));
            return;
        }

        // Validar mínimo según USD (convertir a USD)
        const minDepositUSD = await getMinDepositUSD();
        const rateUSD = await getExchangeRateUSD();
        let amountUSD = 0;
        switch (parsed.currency) {
            case 'USD': amountUSD = parsed.amount; break;
            case 'CUP': amountUSD = parsed.amount / rateUSD; break;
            case 'USDT': amountUSD = parsed.amount; break; // USDT ≈ USD
            case 'TRX': amountUSD = parsed.amount * await getExchangeRateTRX() / rateUSD; break; // TRX a CUP a USD
            case 'MLC': amountUSD = parsed.amount; break; // MLC ≈ USD
        }
        if (amountUSD < minDepositUSD) {
            await ctx.reply(`❌ El monto mínimo de depósito es ${minDepositUSD} USD (equivalente a ${(minDepositUSD * rateUSD).toFixed(2)} CUP). Tu monto equivale a ${amountUSD.toFixed(2)} USD.`, getMainKeyboard(ctx));
            return;
        }

        try {
            const request = await createDepositRequest(uid, method.id, buffer, amountText, parsed.currency);
            for (const adminId of ADMIN_IDS) {
                try {
                    await bot.telegram.sendMessage(adminId,
                        `📥 <b>Nueva solicitud de DEPÓSITO</b>\n` +
                        `👤 Usuario: ${ctx.from.first_name} (${uid})\n` +
                        `🏦 Método: ${escapeHTML(method.name)} (${method.currency})\n` +
                        `💰 Monto: ${amountText}\n` +
                        `📎 <a href="${request.screenshot_url}">Ver captura</a>\n` +
                        `🆔 Solicitud: ${request.id}`,
                        {
                            parse_mode: 'HTML',
                            reply_markup: Markup.inlineKeyboard([
                                [Markup.button.callback('✅ Aprobar', `approve_deposit_${request.id}`),
                                 Markup.button.callback('❌ Rechazar', `reject_deposit_${request.id}`)]
                            ]).reply_markup
                        }
                    );
                } catch (e) {}
            }
            await ctx.reply(`✅ <b>Solicitud de depósito enviada</b>\nMonto: ${amountText}\n⏳ Tu solicitud está siendo procesada. Te notificaremos cuando se acredite. ¡Gracias por confiar en nosotros!`, { parse_mode: 'HTML' });
        } catch (e) {
            console.error(e);
            await ctx.reply('❌ Error al procesar la solicitud. Por favor, intenta más tarde o contacta a soporte.', getMainKeyboard(ctx));
        }

        delete session.awaitingDepositAmount;
        delete session.depositMethod;
        delete session.depositPhotoBuffer;
        return;
    }

    // Retiro: después de elegir método, esperamos monto
    if (session.awaitingWithdrawAmount) {
        const amountText = text;
        const method = session.withdrawMethod;

        // Parsear monto (se espera solo número, la moneda ya es la del método)
        const amount = parseFloat(amountText.replace(',', '.'));
        if (isNaN(amount) || amount <= 0) {
            await ctx.reply('❌ Monto inválido. Por favor, envía un número positivo.', getMainKeyboard(ctx));
            return;
        }

        // Validar mínimo en USD
        const minWithdrawUSD = await getMinWithdrawUSD();
        const rateUSD = await getExchangeRateUSD();
        let amountUSD = 0;
        switch (method.currency) {
            case 'USD': amountUSD = amount; break;
            case 'CUP': amountUSD = amount / rateUSD; break;
            case 'USDT': amountUSD = amount; break;
            case 'TRX': amountUSD = amount * await getExchangeRateTRX() / rateUSD; break;
            case 'MLC': amountUSD = amount; break;
        }
        if (amountUSD < minWithdrawUSD) {
            await ctx.reply(`❌ El monto mínimo de retiro es ${minWithdrawUSD} USD (equivalente a ${(minWithdrawUSD * rateUSD).toFixed(2)} CUP). Tu monto equivale a ${amountUSD.toFixed(2)} USD.`, getMainKeyboard(ctx));
            return;
        }

        // Verificar saldo en esa moneda
        let saldoDisponible = 0;
        switch (method.currency) {
            case 'CUP': saldoDisponible = parseFloat(user.cup); break;
            case 'USD': saldoDisponible = parseFloat(user.usd); break;
            case 'USDT': saldoDisponible = parseFloat(user.usdt); break;
            case 'TRX': saldoDisponible = parseFloat(user.trx); break;
            case 'MLC': saldoDisponible = parseFloat(user.mlc); break;
        }
        if (saldoDisponible < amount) {
            await ctx.reply(`❌ No tienes suficiente saldo en ${method.currency}. Tu saldo: ${saldoDisponible.toFixed(2)} ${method.currency}`, getMainKeyboard(ctx));
            return;
        }

        // Guardar en sesión
        session.withdrawAmount = amount;
        session.withdrawAmountUSD = amountUSD; // para referencia
        session.awaitingWithdrawAccount = true;
        delete session.awaitingWithdrawAmount;

        await ctx.reply(
            `✅ Monto aceptado: ${amount} ${method.currency} (equivale a ${amountUSD.toFixed(2)} USD)\n\n` +
            `Ahora, por favor, escribe el <b>número o datos de la cuenta</b> a la que deseas que enviemos el retiro (para cripto, la dirección de tu wallet).`,
            { parse_mode: 'HTML' }
        );
        return;
    }

    if (session.awaitingWithdrawAccount) {
        const account = text;
        const amount = session.withdrawAmount;
        const amountUSD = session.withdrawAmountUSD;
        const method = session.withdrawMethod;
        const rateUSD = await getExchangeRateUSD();

        // Verificar saldo nuevamente
        let saldoDisponible = 0;
        switch (method.currency) {
            case 'CUP': saldoDisponible = parseFloat(user.cup); break;
            case 'USD': saldoDisponible = parseFloat(user.usd); break;
            case 'USDT': saldoDisponible = parseFloat(user.usdt); break;
            case 'TRX': saldoDisponible = parseFloat(user.trx); break;
            case 'MLC': saldoDisponible = parseFloat(user.mlc); break;
        }
        if (saldoDisponible < amount) {
            await ctx.reply('❌ Saldo insuficiente. La solicitud ha expirado.', getMainKeyboard(ctx));
            delete session.awaitingWithdrawAccount;
            delete session.withdrawMethod;
            delete session.withdrawAmount;
            delete session.withdrawAmountUSD;
            return;
        }

        // Crear solicitud
        const { data: request, error } = await supabase
            .from('withdraw_requests')
            .insert({
                user_id: uid,
                method_id: method.id,
                amount: amount,
                currency: method.currency,
                amount_usd: amountUSD,
                account_info: account,
                status: 'pending'
            })
            .select()
            .single();

        if (error) {
            await ctx.reply(`❌ Error al crear la solicitud: ${error.message}`, getMainKeyboard(ctx));
        } else {
            for (const adminId of ADMIN_IDS) {
                try {
                    await bot.telegram.sendMessage(adminId,
                        `📤 <b>Nueva solicitud de RETIRO</b>\n` +
                        `👤 Usuario: ${ctx.from.first_name} (${uid})\n` +
                        `💰 Monto: ${amount} ${method.currency} (≈ ${amountUSD.toFixed(2)} USD)\n` +
                        `🏦 Método: ${escapeHTML(method.name)}\n` +
                        `📞 Cuenta: ${escapeHTML(account)}\n` +
                        `🆔 Solicitud: ${request.id}`,
                        {
                            parse_mode: 'HTML',
                            reply_markup: Markup.inlineKeyboard([
                                [Markup.button.callback('✅ Aprobar', `approve_withdraw_${request.id}`),
                                 Markup.button.callback('❌ Rechazar', `reject_withdraw_${request.id}`)]
                            ]).reply_markup
                        }
                    );
                } catch (e) {}
            }
            await ctx.reply(
                `✅ <b>Solicitud de retiro enviada</b>\n` +
                `💰 Monto: ${amount} ${method.currency}\n` +
                `⏳ Procesaremos tu solicitud a la mayor brevedad. Te avisaremos cuando esté lista.`,
                { parse_mode: 'HTML' }
            );
        }

        delete session.awaitingWithdrawAccount;
        delete session.withdrawMethod;
        delete session.withdrawAmount;
        delete session.withdrawAmountUSD;
        return;
    }

    // Transferencia
    if (session.awaitingTransferTarget) {
        let targetIdentifier = text.trim();
        if (targetIdentifier.startsWith('@')) {
            targetIdentifier = targetIdentifier.slice(1);
        }
        let targetUser = null;
        if (targetIdentifier) {
            const { data: userByUsername } = await supabase
                .from('users')
                .select('telegram_id, username, first_name')
                .eq('username', targetIdentifier)
                .maybeSingle();
            if (userByUsername) {
                targetUser = userByUsername;
            } else {
                const targetId = parseInt(targetIdentifier);
                if (!isNaN(targetId)) {
                    const { data: userById } = await supabase
                        .from('users')
                        .select('telegram_id, username, first_name')
                        .eq('telegram_id', targetId)
                        .maybeSingle();
                    if (userById) {
                        targetUser = userById;
                    }
                }
            }
        }

        if (!targetUser) {
            await ctx.reply('❌ Usuario no encontrado. Asegúrate de que el nombre de usuario sea correcto o de que el ID numérico esté registrado.', getMainKeyboard(ctx));
            delete session.awaitingTransferTarget;
            return;
        }
        if (targetUser.telegram_id === uid) {
            await ctx.reply('❌ No puedes transferirte saldo a ti mismo. Elige otro usuario.', getMainKeyboard(ctx));
            delete session.awaitingTransferTarget;
            return;
        }

        session.transferTarget = targetUser.telegram_id;
        session.awaitingTransferAmount = true;
        delete session.awaitingTransferTarget;
        const displayName = targetUser.first_name || targetUser.username || targetUser.telegram_id;
        await ctx.reply(
            `✅ Usuario encontrado: ${escapeHTML(displayName)}\n\n` +
            `Ahora envía el <b>monto y la moneda</b> que deseas transferir (ej: <code>500 cup</code>, <code>10 usdt</code>).\n` +
            `💰 Tus saldos: CUP: ${parseFloat(user.cup).toFixed(2)}, USD: ${parseFloat(user.usd).toFixed(2)}, USDT: ${parseFloat(user.usdt).toFixed(2)}, TRX: ${parseFloat(user.trx).toFixed(2)}, MLC: ${parseFloat(user.mlc).toFixed(2)}`,
            { parse_mode: 'HTML' }
        );
        return;
    }

    if (session.awaitingTransferAmount) {
        const parsed = parseAmountWithCurrency(text);
        if (!parsed) {
            await ctx.reply('❌ Formato inválido. Debe ser <code>monto moneda</code> (ej: 500 cup).', getMainKeyboard(ctx));
            return;
        }

        const amount = parsed.amount;
        const currency = parsed.currency;
        const targetId = session.transferTarget;

        // Verificar saldo en esa moneda
        let saldoOrigen = 0;
        switch (currency) {
            case 'CUP': saldoOrigen = parseFloat(user.cup); break;
            case 'USD': saldoOrigen = parseFloat(user.usd); break;
            case 'USDT': saldoOrigen = parseFloat(user.usdt); break;
            case 'TRX': saldoOrigen = parseFloat(user.trx); break;
            case 'MLC': saldoOrigen = parseFloat(user.mlc); break;
            default: saldoOrigen = 0;
        }
        if (saldoOrigen < amount) {
            await ctx.reply(`❌ No tienes suficiente saldo en ${currency}. Disponible: ${saldoOrigen.toFixed(2)} ${currency}`, getMainKeyboard(ctx));
            return;
        }

        // Descontar del origen
        const updateOrigen = {};
        updateOrigen[currency.toLowerCase()] = saldoOrigen - amount;
        await supabase
            .from('users')
            .update({ ...updateOrigen, updated_at: new Date() })
            .eq('telegram_id', uid);

        // Acreditar al destino
        const { data: targetUser } = await supabase
            .from('users')
            .select('*')
            .eq('telegram_id', targetId)
            .single();

        let saldoDestino = 0;
        switch (currency) {
            case 'CUP': saldoDestino = parseFloat(targetUser.cup); break;
            case 'USD': saldoDestino = parseFloat(targetUser.usd); break;
            case 'USDT': saldoDestino = parseFloat(targetUser.usdt); break;
            case 'TRX': saldoDestino = parseFloat(targetUser.trx); break;
            case 'MLC': saldoDestino = parseFloat(targetUser.mlc); break;
        }
        const updateDestino = {};
        updateDestino[currency.toLowerCase()] = saldoDestino + amount;
        await supabase
            .from('users')
            .update({ ...updateDestino, updated_at: new Date() })
            .eq('telegram_id', targetId);

        // Obtener nombres
        const { data: fromUser } = await supabase
            .from('users')
            .select('first_name, username')
            .eq('telegram_id', uid)
            .single();
        const fromName = fromUser?.first_name || fromUser?.username || uid;
        const { data: toUser } = await supabase
            .from('users')
            .select('first_name, username')
            .eq('telegram_id', targetId)
            .single();
        const toName = toUser?.first_name || toUser?.username || targetId;

        await ctx.reply(
            `✅ Transferencia realizada con éxito:\n` +
            `💰 Monto: ${amount} ${currency}\n` +
            `👤 De: ${escapeHTML(fromName)}\n` +
            `👤 A: ${escapeHTML(toName)}`,
            { parse_mode: 'HTML' }
        );

        // Notificar al destinatario
        try {
            await bot.telegram.sendMessage(targetId,
                `🔄 <b>Has recibido una transferencia</b>\n\n` +
                `👤 De: ${escapeHTML(fromName)}\n` +
                `💰 Monto: ${amount} ${currency}\n` +
                `📊 Saldo actualizado.`,
                { parse_mode: 'HTML' }
            );
        } catch (e) {}

        delete session.transferTarget;
        delete session.awaitingTransferAmount;
        return;
    }

    // Apuestas
    if (session.awaitingBet) {
        const betType = session.betType;
        const lottery = session.lottery;
        const sessionId = session.sessionId;

        if (!sessionId) {
            await ctx.reply('❌ No se ha seleccionado una sesión activa. Por favor, comienza de nuevo desde "🎲 Jugar".', getMainKeyboard(ctx));
            delete session.awaitingBet;
            return;
        }

        const { data: activeSession } = await supabase
            .from('lottery_sessions')
            .select('*')
            .eq('id', sessionId)
            .eq('status', 'open')
            .maybeSingle();

        if (!activeSession) {
            await ctx.reply('❌ La sesión de juego ha sido cerrada. No se pueden registrar más apuestas para esta sesión.', getMainKeyboard(ctx));
            delete session.awaitingBet;
            return;
        }

        const parsed = parseBetMessage(text, betType);
        if (!parsed.ok) {
            await ctx.reply('❌ No se pudo interpretar tu apuesta. Verifica el formato y vuelve a intentarlo.\n\nSi necesitas ayuda, escribe "❓ Cómo jugar".', getMainKeyboard(ctx));
            return;
        }

        // Verificar que todos los items tengan moneda válida (CUP o USD por ahora)
        for (const item of parsed.items) {
            if (!['CUP', 'USD'].includes(item.currency)) {
                await ctx.reply('❌ Solo se permiten apuestas en CUP o USD por ahora.', getMainKeyboard(ctx));
                return;
            }
        }

        // Verificar saldos
        let totalCUPNeeded = 0, totalUSDNeeded = 0;
        for (const item of parsed.items) {
            if (item.currency === 'CUP') totalCUPNeeded += item.amount;
            else totalUSDNeeded += item.amount;
        }

        if (totalCUPNeeded > parseFloat(user.cup)) {
            await ctx.reply(`❌ Saldo CUP insuficiente. Necesitas ${totalCUPNeeded.toFixed(2)} CUP y tienes ${parseFloat(user.cup).toFixed(2)} CUP.`, getMainKeyboard(ctx));
            return;
        }
        if (totalUSDNeeded > parseFloat(user.usd)) {
            await ctx.reply(`❌ Saldo USD insuficiente. Necesitas ${totalUSDNeeded.toFixed(2)} USD y tienes ${parseFloat(user.usd).toFixed(2)} USD.`, getMainKeyboard(ctx));
            return;
        }

        // Descontar saldos
        await supabase
            .from('users')
            .update({
                cup: parseFloat(user.cup) - totalCUPNeeded,
                usd: parseFloat(user.usd) - totalUSDNeeded,
                updated_at: new Date()
            })
            .eq('telegram_id', uid);

        // Guardar apuesta
        const { data: bet, error } = await supabase
            .from('bets')
            .insert({
                user_id: uid,
                lottery,
                session_id: sessionId,
                bet_type: betType,
                raw_text: text,
                items: parsed.items,
                placed_at: new Date()
            })
            .select()
            .single();

        if (error) {
            console.error('Error insertando apuesta:', error);
            await ctx.reply('❌ Error al registrar la apuesta. Por favor, intenta más tarde.', getMainKeyboard(ctx));
            return;
        }

        await ctx.replyWithHTML(
            `✅ <b>Jugada registrada exitosamente</b>\n` +
            `🎰 ${escapeHTML(lottery)} - ${escapeHTML(betType)}\n` +
            `📝 <code>${escapeHTML(text)}</code>\n` +
            `💰 Costo: ${parsed.items.map(it => `${it.amount} ${it.currency}`).join(', ')}\n\n` +
            `🍀 ¡Mucha suerte! Esperamos que seas el próximo ganador.`
        );

        await ctx.reply('¿Qué deseas hacer ahora?', getMainKeyboard(ctx));

        delete session.awaitingBet;
        delete session.betType;
        delete session.lottery;
        delete session.sessionId;
        return;
    }

    // Si no se reconoce el mensaje, ofrecer ayuda
    await ctx.reply(
        'Lo siento, no entendí ese mensaje. 😕\n\n' +
        'Por favor, utiliza los botones del menú para navegar. Si necesitas ayuda, escribe "❓ Cómo jugar".',
        getMainKeyboard(ctx)
    );
});

// ========== MANEJADOR DE FOTOS (DEPÓSITO) ==========
bot.on(message('photo'), async (ctx) => {
    const uid = ctx.from.id;
    const session = ctx.session;

    if (session.awaitingDepositPhoto) {
        const photo = ctx.message.photo.pop();
        const fileId = photo.file_id;
        const fileLink = await ctx.telegram.getFileLink(fileId);
        const response = await axios({ url: fileLink.href, responseType: 'arraybuffer' });
        const buffer = Buffer.from(response.data, 'binary');

        session.depositPhotoBuffer = buffer;
        delete session.awaitingDepositPhoto;
        session.awaitingDepositAmount = true;

        await ctx.reply('✅ Captura recibida correctamente. Ahora, por favor, envía el <b>monto transferido</b> con la moneda (ej: <code>500 cup</code> o <code>10 usdt</code>).', { parse_mode: 'HTML' });
        return;
    }

    await ctx.reply('No se esperaba una foto en este momento. Por favor, usa los botones del menú.', getMainKeyboard(ctx));
});

// ========== MANEJADORES DE APROBACIÓN/RECHAZO DE SOLICITUDES ==========
bot.action(/approve_deposit_(\d+)/, async (ctx) => {
    if (!isAdmin(ctx.from.id)) {
        await ctx.answerCbQuery('⛔ No autorizado', { show_alert: true });
        return;
    }
    try {
        const requestId = parseInt(ctx.match[1]);
        const { data: request } = await supabase
            .from('deposit_requests')
            .select('*')
            .eq('id', requestId)
            .single();

        if (!request) {
            await ctx.answerCbQuery('Solicitud no encontrada', { show_alert: true });
            return;
        }

        // Obtener usuario
        const { data: user } = await supabase
            .from('users')
            .select('*')
            .eq('telegram_id', request.user_id)
            .single();

        if (!user) {
            await ctx.answerCbQuery('Usuario no encontrado', { show_alert: true });
            return;
        }

        // Acreditar según la moneda del depósito
        const amount = parseFloat(request.amount.split(' ')[0]); // asumimos formato "monto moneda"
        const currency = request.currency;

        let updateData = {};
        switch (currency) {
            case 'CUP': updateData.cup = parseFloat(user.cup) + amount; break;
            case 'USD': updateData.usd = parseFloat(user.usd) + amount; break;
            case 'USDT': updateData.usdt = parseFloat(user.usdt) + amount; break;
            case 'TRX': updateData.trx = parseFloat(user.trx) + amount; break;
            case 'MLC': updateData.mlc = parseFloat(user.mlc) + amount; break;
            default: await ctx.answerCbQuery('Moneda no soportada', { show_alert: true }); return;
        }
        updateData.updated_at = new Date();

        await supabase
            .from('users')
            .update(updateData)
            .eq('telegram_id', request.user_id);

        await supabase
            .from('deposit_requests')
            .update({ status: 'approved', updated_at: new Date() })
            .eq('id', requestId);

        // Notificar al usuario
        await ctx.telegram.sendMessage(request.user_id,
            `✅ <b>Depósito aprobado</b>\n\n` +
            `💰 Monto: ${request.amount} ${currency}\n` +
            `💵 Se acreditó a tu saldo en ${currency}.\n\n` +
            `¡Gracias por confiar en nosotros!`,
            { parse_mode: 'HTML' }
        );

        await ctx.editMessageReplyMarkup({ inline_keyboard: [] });
        await ctx.reply('✅ Depósito aprobado y saldo actualizado correctamente.');
        await ctx.answerCbQuery();
    } catch (e) {
        console.error(e);
        await ctx.answerCbQuery('❌ Error al aprobar. Revisa los logs.', { show_alert: true });
    }
});

bot.action(/reject_deposit_(\d+)/, async (ctx) => {
    if (!isAdmin(ctx.from.id)) return;
    try {
        const requestId = parseInt(ctx.match[1]);
        await supabase
            .from('deposit_requests')
            .update({ status: 'rejected', updated_at: new Date() })
            .eq('id', requestId);

        const { data: request } = await supabase
            .from('deposit_requests')
            .select('user_id')
            .eq('id', requestId)
            .single();

        if (request) {
            await ctx.telegram.sendMessage(request.user_id,
                '❌ <b>Depósito rechazado</b>\nLa solicitud no pudo ser procesada. Por favor, contacta al administrador para más información.',
                { parse_mode: 'HTML' }
            );
        }
        await ctx.editMessageReplyMarkup({ inline_keyboard: [] });
        await ctx.reply('❌ Depósito rechazado.');
        await ctx.answerCbQuery();
    } catch (e) {
        console.error(e);
        await ctx.answerCbQuery('❌ Error al rechazar', { show_alert: true });
    }
});

bot.action(/approve_withdraw_(\d+)/, async (ctx) => {
    if (!isAdmin(ctx.from.id)) {
        await ctx.answerCbQuery('⛔ No autorizado', { show_alert: true });
        return;
    }
    try {
        const requestId = parseInt(ctx.match[1]);
        const { data: request } = await supabase
            .from('withdraw_requests')
            .select('*')
            .eq('id', requestId)
            .single();

        if (!request) {
            await ctx.answerCbQuery('Solicitud no encontrada', { show_alert: true });
            return;
        }

        const { data: user } = await supabase
            .from('users')
            .select('*')
            .eq('telegram_id', request.user_id)
            .single();

        // Verificar saldo
        let saldoActual = 0;
        switch (request.currency) {
            case 'CUP': saldoActual = parseFloat(user.cup); break;
            case 'USD': saldoActual = parseFloat(user.usd); break;
            case 'USDT': saldoActual = parseFloat(user.usdt); break;
            case 'TRX': saldoActual = parseFloat(user.trx); break;
            case 'MLC': saldoActual = parseFloat(user.mlc); break;
        }
        if (saldoActual < request.amount) {
            await ctx.reply('❌ El usuario ya no tiene saldo suficiente para este retiro.');
            return;
        }

        // Debitar
        let updateData = {};
        switch (request.currency) {
            case 'CUP': updateData.cup = saldoActual - request.amount; break;
            case 'USD': updateData.usd = saldoActual - request.amount; break;
            case 'USDT': updateData.usdt = saldoActual - request.amount; break;
            case 'TRX': updateData.trx = saldoActual - request.amount; break;
            case 'MLC': updateData.mlc = saldoActual - request.amount; break;
        }
        updateData.updated_at = new Date();

        await supabase
            .from('users')
            .update(updateData)
            .eq('telegram_id', request.user_id);

        await supabase
            .from('withdraw_requests')
            .update({ status: 'approved', updated_at: new Date() })
            .eq('id', requestId);

        await ctx.telegram.sendMessage(request.user_id,
            `✅ <b>Retiro aprobado</b>\n\n` +
            `💰 Monto: ${request.amount} ${request.currency}\n` +
            `💵 Se debitaron de tu saldo.\n\n` +
            `Los fondos serán enviados a la cuenta proporcionada en breve.`,
            { parse_mode: 'HTML' }
        );

        await ctx.editMessageReplyMarkup({ inline_keyboard: [] });
        await ctx.reply('✅ Retiro aprobado y saldo debitado correctamente.');
        await ctx.answerCbQuery();
    } catch (e) {
        console.error(e);
        await ctx.answerCbQuery('❌ Error al aprobar', { show_alert: true });
    }
});

bot.action(/reject_withdraw_(\d+)/, async (ctx) => {
    if (!isAdmin(ctx.from.id)) return;
    try {
        const requestId = parseInt(ctx.match[1]);
        await supabase.from('withdraw_requests').update({ status: 'rejected', updated_at: new Date() }).eq('id', requestId);
        const { data: request } = await supabase.from('withdraw_requests').select('user_id').eq('id', requestId).single();
        if (request) {
            await ctx.telegram.sendMessage(request.user_id,
                '❌ <b>Retiro rechazado</b>\nTu solicitud no pudo ser procesada. Por favor, contacta al administrador para más detalles.',
                { parse_mode: 'HTML' }
            );
        }
        await ctx.editMessageReplyMarkup({ inline_keyboard: [] });
        await ctx.reply('❌ Retiro rechazado.');
        await ctx.answerCbQuery();
    } catch (e) {
        console.error(e);
        await ctx.answerCbQuery('❌ Error al rechazar', { show_alert: true });
    }
});

// ========== TAREAS PROGRAMADAS ==========
async function closeExpiredSessions() {
    try {
        const now = new Date().toISOString();
        const { data: expiredSessions } = await supabase
            .from('lottery_sessions')
            .select('*')
            .eq('status', 'open')
            .lt('end_time', now);

        for (const session of expiredSessions || []) {
            await supabase
                .from('lottery_sessions')
                .update({ status: 'closed', updated_at: new Date() })
                .eq('id', session.id);

            const region = regionMap[session.lottery];
            await broadcastToAllUsers(
                `🔴 <b>SESIÓN CERRADA</b>\n\n` +
                `🎰 ${region?.emoji || '🎰'} <b>${escapeHTML(session.lottery)}</b> - Turno <b>${escapeHTML(session.time_slot)}</b>\n` +
                `📅 Fecha: ${session.date}\n\n` +
                `❌ Ya no se reciben más apuestas para esta sesión.\n` +
                `🔢 Pronto anunciaremos el número ganador. ¡Mantente atento!`
            );
        }
    } catch (e) {
        console.error('Error cerrando sesiones:', e);
    }
}

async function openScheduledSessions() {
    try {
        const now = moment.tz(TIMEZONE);
        const today = now.format('YYYY-MM-DD');
        const currentMinutes = now.hours() * 60 + now.minutes();

        const regions = ['Florida', 'Georgia', 'Nueva York'];
        for (const lottery of regions) {
            const region = regionMap[lottery];
            const schedule = getAllowedHours(region.key);
            if (!schedule) continue;

            for (const slot of schedule.slots) {
                const startMinutes = slot.start * 60;
                if (currentMinutes >= startMinutes && currentMinutes < startMinutes + 5) {
                    const { data: existing } = await supabase
                        .from('lottery_sessions')
                        .select('id')
                        .eq('lottery', lottery)
                        .eq('date', today)
                        .eq('time_slot', slot.name)
                        .maybeSingle();

                    if (!existing) {
                        const endTime = getEndTimeFromSlot(lottery, slot.name);
                        if (endTime) {
                            await supabase
                                .from('lottery_sessions')
                                .insert({
                                    lottery,
                                    date: today,
                                    time_slot: slot.name,
                                    status: 'open',
                                    end_time: endTime.toISOString()
                                });

                            await broadcastToAllUsers(
                                `🎲 <b>¡SESIÓN ABIERTA!</b> 🎲\n\n` +
                                `✨ La región ${region.emoji} <b>${escapeHTML(lottery)}</b> ha abierto su turno de <b>${escapeHTML(slot.name)}</b>.\n` +
                                `💎 ¡Es tu momento! Realiza tus apuestas y llévate grandes premios.\n\n` +
                                `⏰ Cierre: ${moment(endTime).tz(TIMEZONE).format('HH:mm')} (hora Cuba)\n` +
                                `🍀 ¡La suerte te espera!`
                            );
                        }
                    }
                }
            }
        }
    } catch (e) {
        console.error('Error abriendo sesiones:', e);
    }
}

async function withdrawNotifications() {
    const now = moment.tz(TIMEZONE);
    const currentHour = now.hour();
    const currentMinute = now.minute();

    if (currentHour === 22 && currentMinute === 0) {
        await broadcastToAllUsers(
            `⏰ <b>Horario de Retiros ABIERTO</b>\n\n` +
            `Ya puedes solicitar tus retiros de 10:00 PM a 11:30 PM (hora Cuba).\n` +
            `Puedes retirar en CUP, USD, USDT, TRX o MLC según los métodos disponibles.`,
            'HTML'
        );
    } else if (currentHour === 23 && currentMinute === 30) {
        await broadcastToAllUsers(
            `⏰ <b>Horario de Retiros CERRADO</b>\n\n` +
            `La ventana de retiros ha finalizado. Vuelve mañana de 10:00 PM a 11:30 PM (hora Cuba).`,
            'HTML'
        );
    }
}

cron.schedule('* * * * *', () => {
    closeExpiredSessions();
    openScheduledSessions();
    withdrawNotifications();
}, { timezone: TIMEZONE });

module.exports = bot;
