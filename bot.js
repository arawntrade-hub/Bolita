// ==============================
// bot.js - Bot de Telegram para Rifas Cuba
// Versión final con soporte para D/T, depósitos con captura, y menú persistente
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
const ADMIN_ID = parseInt(process.env.ADMIN_ID);
const ADMIN_CHANNEL = process.env.ADMIN_CHANNEL;
const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_SERVICE_KEY = process.env.SUPABASE_SERVICE_KEY;
const BONUS_CUP_DEFAULT = parseFloat(process.env.BONUS_CUP_DEFAULT) || 70;
const TIMEZONE = process.env.TIMEZONE || 'America/Havana';
const WEBAPP_URL = process.env.WEBAPP_URL || 'http://localhost:3000';

// ========== INICIALIZAR SUPABASE ==========
const supabase = createClient(SUPABASE_URL, SUPABASE_SERVICE_KEY);

// ========== INICIALIZAR BOT ==========
const bot = new Telegraf(BOT_TOKEN);

// ========== SESIÓN LOCAL ==========
const localSession = new LocalSession({ database: 'session_db.json' });
bot.use(localSession.middleware());

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

async function getUser(telegramId, firstName = 'Jugador') {
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

async function getExchangeRate() {
    const { data } = await supabase
        .from('exchange_rate')
        .select('rate')
        .eq('id', 1)
        .single();
    return data?.rate || 110;
}

function parseAmount(text) {
    const lower = text.toLowerCase().replace(',', '.').trim();
    let usd = 0, cup = 0;
    const usdMatch = lower.match(/(\d+(?:\.\d+)?)\s*usd/);
    const cupMatch = lower.match(/(\d+(?:\.\d+)?)\s*cup/);
    if (usdMatch) usd = parseFloat(usdMatch[1]);
    if (cupMatch) cup = parseFloat(cupMatch[1]);
    return { usd, cup };
}

// ========== PARSEO DE APUESTAS CON SOPORTE PARA D Y T ==========
function parseBetLine(line, betType) {
    line = line.trim().toLowerCase();
    if (!line) return null;

    let numero, montoStr, moneda = 'usd';
    const match = line.match(/^([\dx]+)\s*(?:con|\*)\s*([0-9.]+)\s*(usd|cup)?$/);
    if (!match) return null;

    numero = match[1].trim();
    montoStr = match[2];
    if (match[3]) moneda = match[3];

    const montoBase = parseFloat(montoStr);
    if (isNaN(montoBase) || montoBase <= 0) return null;

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
            return null;
        }
    } else if (betType === 'corridos') {
        if (!/^\d{2}$/.test(numero)) return null;
    } else if (betType === 'centena') {
        if (!/^\d{3}$/.test(numero)) return null;
    } else if (betType === 'parle') {
        if (!/^\d{2}x\d{2}$/.test(numero)) return null;
    } else {
        return null;
    }

    return {
        numero: numeroGuardado,
        usd: moneda === 'usd' ? montoReal : 0,
        cup: moneda === 'cup' ? montoReal : 0
    };
}

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

function getEndTimeFromSlot(timeSlot) {
    const now = moment.tz(TIMEZONE);
    let hour, minute;
    if (timeSlot === 'Día') {
        hour = 12;
        minute = 0;
    } else {
        hour = 23;
        minute = 0;
    }
    const endTime = now.clone().hour(hour).minute(minute).second(0).millisecond(0);
    return endTime.toDate();
}

// ========== FUNCIÓN DE BROADCAST GLOBAL ==========
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

// ========== FUNCIÓN PARA CREAR SOLICITUD DE DEPÓSITO ==========
async function createDepositRequest(userId, methodId, fileBuffer, amountText) {
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
            status: 'pending'
        })
        .select()
        .single();

    if (insertError) throw insertError;

    return request;
}

// ========== TECLADO PRINCIPAL (solo admin ve el botón admin) ==========
function getMainKeyboard(ctx) {
    const buttons = [
        [Markup.button.callback('🎲 Jugar', 'play')],
        [Markup.button.callback('💰 Mi dinero', 'my_money')],
        [Markup.button.callback('📋 Mis jugadas', 'my_bets')],
        [Markup.button.callback('👥 Referidos', 'referrals')],
        [Markup.button.callback('❓ Cómo jugar', 'how_to_play')],
        [Markup.button.webApp('🌐 Abrir WebApp', `${WEBAPP_URL}/app.html`)]
    ];
    if (ctx.from.id === ADMIN_ID) {
        buttons.push([Markup.button.callback('🔧 Admin', 'admin_panel')]);
    }
    return Markup.inlineKeyboard(buttons);
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
        [Markup.button.callback('➕ Añadir método RETIRO', 'adm_add_wit')],
        [Markup.button.callback('💰 Configurar tasa USD/CUP', 'adm_set_rate')],
        [Markup.button.callback('🎲 Configurar precios y pagos', 'adm_set_prices')],
        [Markup.button.callback('📋 Ver datos actuales', 'adm_view')],
        [Markup.button.callback('◀ Menú principal', 'main')]
    ];
    return Markup.inlineKeyboard(buttons);
}

// ========== MIDDLEWARE: USUARIO ==========
bot.use(async (ctx, next) => {
    const uid = ctx.from?.id;
    if (uid) {
        try {
            const firstName = ctx.from.first_name || 'Jugador';
            ctx.dbUser = await getUser(uid, firstName);
        } catch (e) {
            console.error('Error cargando usuario:', e);
        }
    }
    return next();
});

// ========== COMANDO /start ==========
bot.start(async (ctx) => {
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
        `¡Hola de nuevo, ${escapeHTML(firstName)}! 👋\n` +
        `Bienvenido de regreso a Rifas Cuba, tu asistente de la suerte 🍀\n\n` +
        `🎲 ¿Listo para jugar?\n` +
        `Apuesta, gana y disfruta. ¡La suerte está de tu lado!`,
        getMainKeyboard(ctx)
    );
});

bot.action('main', async (ctx) => {
    const firstName = ctx.from.first_name || 'Jugador';
    await safeEdit(ctx,
        `¡Hola de nuevo, ${escapeHTML(firstName)}! 👋\n` +
        `Bienvenido de regreso a Rifas Cuba, tu asistente de la suerte 🍀\n\n` +
        `🎲 ¿Listo para jugar?\n` +
        `Apuesta, gana y disfruta. ¡La suerte está de tu lado!`,
        getMainKeyboard(ctx)
    );
});

// ========== JUGAR ==========
bot.action('play', async (ctx) => {
    await safeEdit(ctx, 'Selecciona una lotería:', playLotteryKbd());
});

bot.action(/lot_(.+)/, async (ctx) => {
    try {
        const lotteryKey = ctx.match[1];
        const lotteryName = {
            florida: 'Florida',
            georgia: 'Georgia',
            newyork: 'Nueva York'
        }[lotteryKey];

        console.log(`Jugador ${ctx.from.id} seleccionó lotería ${lotteryName}`);

        // Horario para Georgia
        if (lotteryKey === 'georgia') {
            const now = moment.tz(TIMEZONE);
            const hour = now.hour();
            const minute = now.minute();
            const current = hour * 60 + minute;
            const allowed = [
                [9 * 60, 12 * 60],
                [14 * 60, 18 * 60 + 30],
                [20 * 60, 23 * 60]
            ];
            const isAllowed = allowed.some(([start, end]) => current >= start && current <= end);
            if (!isAllowed) {
                await ctx.answerCbQuery('⏰ Fuera de horario para Georgia', { show_alert: true });
                return;
            }
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
            await ctx.reply('❌ Error al verificar sesión. Intenta más tarde.');
            return;
        }

        if (!activeSession) {
            await ctx.answerCbQuery('❌ No hay una sesión abierta para esta lotería en el día de hoy.', { show_alert: true });
            return;
        }

        ctx.session.lottery = lotteryName;
        ctx.session.sessionId = activeSession.id;
        await safeEdit(ctx,
            `Has seleccionado <b>${escapeHTML(lotteryName)}</b> - Turno <b>${escapeHTML(activeSession.time_slot)}</b>.\n` +
            `Ahora elige el tipo de jugada:`,
            playTypeKbd()
        );
    } catch (e) {
        console.error('Error en lot_ handler:', e);
        await ctx.reply('❌ Ocurrió un error inesperado.');
    }
});

bot.action(/type_(.+)/, async (ctx) => {
    const betType = ctx.match[1];
    ctx.session.betType = betType;
    ctx.session.awaitingBet = true;
    const lottery = ctx.session.lottery || 'Florida';

    let instructions = '';
    switch (betType) {
        case 'fijo':
            instructions = `🎯 <b>FIJO</b> - 🎰 ${escapeHTML(lottery)}\n\n` +
                `Escribe UNA LÍNEA por cada número de 2 DÍGITOS.\n` +
                `<b>Formato:</b> <code>12 con 5 usd</code>  o  <code>34*2cup</code>\n` +
                `También puedes usar <b>D</b> (decena) o <b>T</b> (terminal):\n` +
                `- <code>D2 con 5 usd</code> significa TODOS los números que empiezan con 2 (20-29). El costo se multiplica por 10.\n` +
                `- <code>T5 con 1 cup</code> significa TODOS los números que terminan con 5 (05,15,...,95). El costo se multiplica por 10.\n\n` +
                `Ejemplos:\n12 con 1 usd\nD2 con 5 usd\nT5*1cup\n34*2 usd\n\n` +
                `💭 <b>Escribe tus jugadas (una por línea):</b>`;
            break;
        case 'corridos':
            instructions = `🏃 <b>CORRIDOS</b> - 🎰 ${escapeHTML(lottery)}\n\n` +
                `Escribe UNA LÍNEA por cada número de 2 DÍGITOS.\n` +
                `<b>Formato:</b> <code>17 con 1 usd</code>  o  <code>32*0.5usd</code>\n\n` +
                `Ejemplo:\n17 con 1 usd\n32*0.5 usd\n62 con 10 cup\n\n` +
                `💭 <b>Escribe tus jugadas:</b>`;
            break;
        case 'centena':
            instructions = `💯 <b>CENTENA</b> - 🎰 ${escapeHTML(lottery)}\n\n` +
                `Escribe UNA LÍNEA por cada número de 3 DÍGITOS.\n` +
                `<b>Formato:</b> <code>517 con 2 usd</code>  o  <code>019*1usd</code>\n\n` +
                `Ejemplo:\n517 con 2 usd\n019*1 usd\n123 con 5 cup\n\n` +
                `💭 <b>Escribe tus jugadas:</b>`;
            break;
        case 'parle':
            instructions = `🔒 <b>PARLE</b> - 🎰 ${escapeHTML(lottery)}\n\n` +
                `Escribe UNA LÍNEA por cada combinación de dos números de 2 dígitos separados por "x".\n` +
                `<b>Formato:</b> <code>17x32 con 1 usd</code>  o  <code>17x62*2usd</code>\n\n` +
                `Ejemplo:\n17x32 con 1 usd\n17x62*2 usd\n32x62 con 5 cup\n\n` +
                `💭 <b>Escribe tus parles:</b>`;
            break;
    }
    await safeEdit(ctx, instructions, null);
});

// ========== MI DINERO ==========
bot.action('my_money', async (ctx) => {
    const user = ctx.dbUser;
    const text = `💰 <b>Tu saldo actual:</b>\n` +
        `🇨🇺 <b>CUP:</b> ${parseFloat(user.cup).toFixed(2)}\n` +
        `💵 <b>USD:</b> ${parseFloat(user.usd).toFixed(2)}\n` +
        `🎁 <b>Bono:</b> ${parseFloat(user.bonus_usd).toFixed(2)} USD`;
    await safeEdit(ctx, text, myMoneyKbd());
});

// ---------- RECARGAR (nuevo flujo con captura) ----------
bot.action('recharge', async (ctx) => {
    const { data: methods } = await supabase
        .from('deposit_methods')
        .select('*')
        .order('id', { ascending: true });

    if (!methods || methods.length === 0) {
        await ctx.answerCbQuery('❌ No hay métodos de depósito configurados.', { show_alert: true });
        return;
    }

    const buttons = methods.map(m => [Markup.button.callback(m.name, `dep_${m.id}`)]);
    buttons.push([Markup.button.callback('◀ Volver', 'my_money')]);

    const rate = await getExchangeRate();
    await safeEdit(ctx,
        `💵 <b>¿Cómo deseas recargar?</b>\n\n` +
        `Elige una opción para ver los datos de pago. Luego deberás enviar una <b>captura de pantalla</b> de la transferencia y el monto.\n\n` +
        `<b>Tasa de cambio:</b> 1 USD = ${rate} CUP`,
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
        await ctx.answerCbQuery('Método no encontrado', { show_alert: true });
        return;
    }

    ctx.session.depositMethod = method;
    ctx.session.awaitingDepositPhoto = true;

    await safeEdit(ctx,
        `🧾 <b>${escapeHTML(method.name)}</b>\n` +
        `Número: <code>${escapeHTML(method.card)}</code>\n` +
        `Confirmar: <code>${escapeHTML(method.confirm)}</code>\n\n` +
        `📸 <b>Envía una captura de pantalla de la transferencia realizada.</b>`,
        null
    );
});

// ---------- RETIRAR ----------
bot.action('withdraw', async (ctx) => {
    const user = ctx.dbUser;
    if (parseFloat(user.usd) < 1.0) {
        await ctx.answerCbQuery('❌ Necesitas al menos 1 USD para retirar.', { show_alert: true });
        return;
    }

    const { data: methods } = await supabase
        .from('withdraw_methods')
        .select('*')
        .order('id', { ascending: true });

    if (!methods || methods.length === 0) {
        await ctx.answerCbQuery('❌ No hay métodos de retiro configurados.', { show_alert: true });
        return;
    }

    const buttons = methods.map(m => [Markup.button.callback(m.name, `wit_${m.id}`)]);
    buttons.push([Markup.button.callback('◀ Volver', 'my_money')]);

    await safeEdit(ctx, '📤 <b>Elige un método de retiro:</b>', Markup.inlineKeyboard(buttons));
});

bot.action(/wit_(\d+)/, async (ctx) => {
    const methodId = parseInt(ctx.match[1]);
    const { data: method } = await supabase
        .from('withdraw_methods')
        .select('*')
        .eq('id', methodId)
        .single();

    if (!method) {
        await ctx.answerCbQuery('Método no encontrado', { show_alert: true });
        return;
    }

    ctx.session.withdrawMethod = method;
    ctx.session.awaitingWithdrawAccount = true;

    await safeEdit(ctx,
        `Has elegido <b>${escapeHTML(method.name)}</b>.\n\n` +
        `💰 <b>Tu saldo disponible:</b> ${parseFloat(ctx.dbUser.usd).toFixed(2)} USD\n` +
        `Envía ahora el <b>número/ID de la tarjeta/cuenta</b> a la que deseas que retiremos:`,
        null
    );
});

// ---------- TRANSFERIR ----------
bot.action('transfer', async (ctx) => {
    ctx.session.awaitingTransferTarget = true;
    await safeEdit(ctx,
        '🔄 <b>Transferir saldo</b>\n\n' +
        'Envía el <b>ID de Telegram</b> del usuario al que deseas transferir (ej: 123456789):',
        null
    );
});

// ========== MIS JUGADAS ==========
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
            '📭 No tienes jugadas activas en este momento.\n\n⚠️ Envía tus jugadas con el formato correcto.',
            getMainKeyboard(ctx)
        );
    } else {
        let text = '📋 <b>Tus últimas 5 jugadas:</b>\n\n';
        bets.forEach((b, i) => {
            const date = moment(b.placed_at).tz(TIMEZONE).format('DD/MM/YYYY HH:mm');
            text += `<b>${i + 1}.</b> 🎰 ${escapeHTML(b.lottery)} - ${escapeHTML(b.bet_type)}\n` +
                `   📝 <code>${escapeHTML(b.raw_text)}</code>\n` +
                `   💰 ${b.cost_usd} USD / ${b.cost_cup} CUP\n` +
                `   🕒 ${date}\n\n`;
        });
        await safeEdit(ctx, text, getMainKeyboard(ctx));
    }
});

// ========== REFERIDOS ==========
bot.action('referrals', async (ctx) => {
    const uid = ctx.from.id;
    const { count } = await supabase
        .from('users')
        .select('*', { count: 'exact', head: true })
        .eq('ref_by', uid);

    const botInfo = await ctx.telegram.getMe();
    const link = `https://t.me/${botInfo.username}?start=${uid}`;

    await safeEdit(ctx,
        `💸 <b>¡INVITA Y GANA DINERO AUTOMÁTICO! 💰</b>\n\n` +
        `🎯 <b>¿Cómo funciona?</b>\n` +
        `1️⃣ Comparte tu enlace con amigos\n` +
        `2️⃣ Cuando se registren y jueguen, TÚ ganas\n` +
        `3️⃣ Recibes comisión CADA VEZ que apuesten\n` +
        `4️⃣ ¡Dinero GRATIS para siempre! 🔄\n\n` +
        `🔥 SIN LÍMITES - SIN TOPES - PARA SIEMPRE\n\n` +
        `📲 <b>ESTE ES TU ENLACE MÁGICO:</b> 👇\n` +
        `<code>${escapeHTML(link)}</code>\n\n` +
        `📊 <b>Tus estadísticas:</b>\n` +
        `👥 Total de referidos: ${count || 0}`,
        getMainKeyboard(ctx)
    );
});

// ========== CÓMO JUGAR ==========
bot.action('how_to_play', async (ctx) => {
    await safeEdit(ctx,
        '📩 <b>¿Tienes dudas?</b>\n' +
        'Escribe directamente en el chat del bot, tu mensaje será respondido por una persona real.\n\n' +
        'ℹ️ Estamos aquí para ayudarte.',
        Markup.inlineKeyboard([[Markup.button.callback('◀ Volver', 'main')]])
    );
});

// ========== PANEL DE ADMINISTRACIÓN ==========
bot.action('admin_panel', async (ctx) => {
    if (ctx.from.id !== ADMIN_ID) {
        await ctx.answerCbQuery('⛔ No autorizado', { show_alert: true });
        return;
    }
    await safeEdit(ctx, '🔧 <b>Panel de administración</b>', adminPanelKbd());
});

// ========== GESTIÓN DE SESIONES ==========
bot.action('admin_sessions', async (ctx) => {
    if (ctx.from.id !== ADMIN_ID) return;
    await showRegionsMenu(ctx);
});

async function showRegionsMenu(ctx) {
    const buttons = [
        [Markup.button.callback('🦩 Florida', 'sess_region_Florida')],
        [Markup.button.callback('🍑 Georgia', 'sess_region_Georgia')],
        [Markup.button.callback('🗽 Nueva York', 'sess_region_Nueva York')],
        [Markup.button.callback('◀ Volver a Admin', 'admin_panel')]
    ];
    await safeEdit(ctx, '🎰 <b>Gestionar sesiones</b>\n\nSelecciona una región:', Markup.inlineKeyboard(buttons));
}

bot.action(/sess_region_(.+)/, async (ctx) => {
    if (ctx.from.id !== ADMIN_ID) return;
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

        const turnos = ['Día', 'Noche'];
        let text = `🎰 <b>${lottery}</b>\n📅 ${today}\n\n`;
        const buttons = [];

        for (const turno of turnos) {
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
        await ctx.answerCbQuery('❌ Error al cargar sesiones', { show_alert: true });
    }
}

// Crear sesión
bot.action(/create_session_(.+)_(.+)/, async (ctx) => {
    if (ctx.from.id !== ADMIN_ID) return;
    try {
        const lottery = ctx.match[1];
        const timeSlot = ctx.match[2];
        const endTime = getEndTimeFromSlot(timeSlot);
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

        await ctx.answerCbQuery('✅ Sesión abierta');

        // Broadcast inspirador
        await broadcastToAllUsers(
            `🎲 <b>¡SESIÓN ABIERTA!</b> 🎲\n\n` +
            `✨ La región <b>${escapeHTML(lottery)}</b> acaba de abrir su turno de <b>${escapeHTML(timeSlot)}</b>.\n` +
            `💎 ¡Es tu momento! Realiza tus apuestas y llévate grandes premios.\n\n` +
            `⏰ Cierre: ${moment(endTime).tz(TIMEZONE).format('HH:mm')} (hora Cuba)\n` +
            `🍀 ¡La suerte te espera!`
        );

        await showRegionSessions(ctx, lottery);
    } catch (e) {
        console.error(e);
        await ctx.answerCbQuery('❌ Error al abrir sesión', { show_alert: true });
    }
});

// Cambiar estado de sesión
bot.action(/toggle_session_(\d+)_(.+)/, async (ctx) => {
    if (ctx.from.id !== ADMIN_ID) return;
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

        if (newStatus === 'closed') {
            await broadcastToAllUsers(
                `🔴 <b>SESIÓN CERRADA</b>\n\n` +
                `🎰 <b>${escapeHTML(session.lottery)}</b> - Turno <b>${escapeHTML(session.time_slot)}</b>\n` +
                `📅 Fecha: ${session.date}\n\n` +
                `❌ Ya no se reciben más apuestas.\n` +
                `🔢 Pronto anunciaremos el número ganador. ¡Muy atento!`
            );
        }

        await ctx.answerCbQuery(newStatus === 'open' ? '✅ Sesión abierta' : '🔴 Sesión cerrada');
        await showRegionSessions(ctx, session.lottery);
    } catch (e) {
        console.error(e);
        await ctx.answerCbQuery('❌ Error al cambiar estado', { show_alert: true });
    }
});

// ========== ADMIN: AÑADIR MÉTODO DEPÓSITO ==========
bot.action('adm_add_dep', async (ctx) => {
    if (ctx.from.id !== ADMIN_ID) return;
    ctx.session.adminAction = 'add_dep';
    ctx.session.adminStep = 1;
    await ctx.reply('➕ <b>Añadir método de DEPÓSITO</b>\n\nEscribe el <b>nombre</b> del método (ej: Tarjeta Banco Metropolitano):', { parse_mode: 'HTML' });
    await ctx.answerCbQuery();
});

bot.action('adm_add_wit', async (ctx) => {
    if (ctx.from.id !== ADMIN_ID) return;
    ctx.session.adminAction = 'add_wit';
    ctx.session.adminStep = 1;
    await ctx.reply('➕ <b>Añadir método de RETIRO</b>\n\nEscribe el <b>nombre</b> del método (ej: Transfermovil):', { parse_mode: 'HTML' });
    await ctx.answerCbQuery();
});

bot.action('adm_set_rate', async (ctx) => {
    if (ctx.from.id !== ADMIN_ID) return;
    const rate = await getExchangeRate();
    ctx.session.adminAction = 'set_rate';
    await ctx.reply(`💰 <b>Tasa actual:</b> 1 USD = ${rate} CUP\n\nEnvía la <b>nueva tasa</b> (solo número, ej: 120):`, { parse_mode: 'HTML' });
    await ctx.answerCbQuery();
});

bot.action('adm_set_prices', async (ctx) => {
    if (ctx.from.id !== ADMIN_ID) return;
    const { data: prices } = await supabase.from('play_prices').select('*');
    const buttons = prices.map(p => [Markup.button.callback(p.bet_type, `set_price_${p.bet_type}`)]);
    buttons.push([Markup.button.callback('◀ Cancelar', 'admin_panel')]);
    await ctx.reply('🎲 <b>Configurar precios y multiplicadores</b>\nElige el tipo:', Markup.inlineKeyboard(buttons));
    await ctx.answerCbQuery();
});

bot.action(/set_price_(.+)/, async (ctx) => {
    if (ctx.from.id !== ADMIN_ID) return;
    const betType = ctx.match[1];
    ctx.session.adminAction = 'set_price';
    ctx.session.betType = betType;
    await ctx.reply(
        `Configurando <b>${betType}</b>\n` +
        `Envía en el formato: <code>&lt;costo_cup&gt; &lt;costo_usd&gt; &lt;multiplicador&gt;</code>\n` +
        `Ejemplo: <code>70 0.20 500</code>`,
        { parse_mode: 'HTML' }
    );
    await ctx.answerCbQuery();
});

bot.action('adm_view', async (ctx) => {
    if (ctx.from.id !== ADMIN_ID) return;
    const rate = await getExchangeRate();
    const { data: depMethods } = await supabase.from('deposit_methods').select('*');
    const { data: witMethods } = await supabase.from('withdraw_methods').select('*');
    const { data: prices } = await supabase.from('play_prices').select('*');

    let text = `💰 <b>Tasa:</b> 1 USD = ${rate} CUP\n\n📥 <b>Métodos DEPÓSITO:</b>\n`;
    depMethods?.forEach(m => text += `  ID ${m.id}: ${escapeHTML(m.name)} - ${escapeHTML(m.card)} / ${escapeHTML(m.confirm)}\n`);
    text += `\n📤 <b>Métodos RETIRO:</b>\n`;
    witMethods?.forEach(m => text += `  ID ${m.id}: ${escapeHTML(m.name)} - ${escapeHTML(m.card)} / ${escapeHTML(m.confirm)}\n`);
    text += `\n🎲 <b>Precios por jugada:</b>\n`;
    prices?.forEach(p => text += `  ${p.bet_type}: ${p.amount_cup} CUP / ${p.amount_usd} USD  (x${p.payout_multiplier || 0})\n`);

    await safeEdit(ctx, text, Markup.inlineKeyboard([[Markup.button.callback('◀ Volver a Admin', 'admin_panel')]]));
});

// ========== ADMIN: PUBLICAR NÚMEROS GANADORES ==========
bot.action('admin_winning', async (ctx) => {
    if (ctx.from.id !== ADMIN_ID) return;

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
        await ctx.reply('🔢 No hay sesiones cerradas pendientes de publicar.');
        return;
    }

    const buttons = availableSessions.map(s =>
        [Markup.button.callback(
            `${s.lottery} - ${s.date} (${s.time_slot})`,
            `publish_win_${s.id}`
        )]
    );
    buttons.push([Markup.button.callback('◀ Cancelar', 'admin_panel')]);

    await ctx.reply('🔢 <b>Publicar números ganadores</b>\nSelecciona la sesión:', Markup.inlineKeyboard(buttons));
    await ctx.answerCbQuery();
});

bot.action(/publish_win_(\d+)/, async (ctx) => {
    if (ctx.from.id !== ADMIN_ID) return;
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

// ========== PROCESAR NÚMERO GANADOR (con soporte D/T) ==========
async function processWinningNumber(sessionId, winningStr, ctx) {
    winningStr = winningStr.replace(/\s+/g, '');
    if (!/^\d{7}$/.test(winningStr)) {
        await ctx.reply('❌ El número debe tener EXACTAMENTE 7 dígitos.');
        return false;
    }

    const { data: session } = await supabase
        .from('lottery_sessions')
        .select('*')
        .eq('id', sessionId)
        .single();

    if (!session) {
        await ctx.reply('❌ Sesión no encontrada.');
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
        await ctx.reply('❌ Esta sesión ya tiene un número ganador publicado.');
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

            try {
                await bot.telegram.sendMessage(bet.user_id,
                    `🎉 <b>¡FELICIDADES! Has ganado</b>\n\n` +
                    `🔢 Número ganador: <code>${winningStr}</code>\n` +
                    `🎰 ${escapeHTML(session.lottery)} - ${escapeHTML(session.time_slot)}\n` +
                    `💰 Premio: ${premioTotalUSD.toFixed(2)} USD / ${premioTotalCUP.toFixed(2)} CUP\n\n` +
                    `✅ El premio ya fue acreditado a tu saldo.`,
                    { parse_mode: 'HTML' }
                );
            } catch (e) {}
        } else {
            try {
                await bot.telegram.sendMessage(bet.user_id,
                    `🔢 <b>Números ganadores de ${escapeHTML(session.lottery)} (${session.date} - ${escapeHTML(session.time_slot)})</b>\n\n` +
                    `Número: <code>${winningStr}</code>\n\n` +
                    `😔 No has ganado esta vez. ¡Sigue intentando!`,
                    { parse_mode: 'HTML' }
                );
            } catch (e) {}
        }
    }

    // Broadcast global
    await broadcastToAllUsers(
        `📢 <b>NÚMERO GANADOR PUBLICADO</b>\n\n` +
        `🎰 <b>${escapeHTML(session.lottery)}</b> - Turno <b>${escapeHTML(session.time_slot)}</b>\n` +
        `📅 Fecha: ${session.date}\n` +
        `🔢 Número: <code>${winningStr}</code>\n\n` +
        `💬 Revisa tu historial para ver si has ganado. ¡Suerte en la próxima!`
    );

    await ctx.reply(`✅ Números ganadores publicados y premios calculados.`);
    return true;
}

// ========== MANEJADOR DE MENSAJES DE TEXTO ==========
bot.on(message('text'), async (ctx) => {
    const uid = ctx.from.id;
    const text = ctx.message.text.trim();
    const session = ctx.session;
    const user = ctx.dbUser;

    // ---------- FLUJOS ADMIN ----------
    if (uid === ADMIN_ID && session.adminAction) {
        // Añadir depósito
        if (session.adminAction === 'add_dep') {
            if (session.adminStep === 1) {
                session.adminTempName = text;
                session.adminStep = 2;
                await ctx.reply('Ahora envía el <b>número de la tarjeta/cuenta</b>:', { parse_mode: 'HTML' });
                return;
            } else if (session.adminStep === 2) {
                session.adminTempCard = text;
                session.adminStep = 3;
                await ctx.reply('Ahora envía el <b>número a confirmar</b> (ej: 1234):', { parse_mode: 'HTML' });
                return;
            } else if (session.adminStep === 3) {
                const { data, error } = await supabase
                    .from('deposit_methods')
                    .insert({ name: session.adminTempName, card: session.adminTempCard, confirm: text })
                    .select()
                    .single();
                if (error) await ctx.reply(`❌ Error: ${error.message}`);
                else await ctx.reply(`✅ Método de depósito <b>${escapeHTML(session.adminTempName)}</b> añadido con ID ${data.id}.`, { parse_mode: 'HTML' });
                delete session.adminAction;
                return;
            }
        }

        // Añadir retiro
        if (session.adminAction === 'add_wit') {
            if (session.adminStep === 1) {
                session.adminTempName = text;
                session.adminStep = 2;
                await ctx.reply('Ahora envía el <b>número o instrucción para retirar</b>:', { parse_mode: 'HTML' });
                return;
            } else if (session.adminStep === 2) {
                session.adminTempCard = text;
                session.adminStep = 3;
                await ctx.reply('Ahora envía el <b>número a confirmar</b> (o "ninguno"):', { parse_mode: 'HTML' });
                return;
            } else if (session.adminStep === 3) {
                const { data, error } = await supabase
                    .from('withdraw_methods')
                    .insert({ name: session.adminTempName, card: session.adminTempCard, confirm: text })
                    .select()
                    .single();
                if (error) await ctx.reply(`❌ Error: ${error.message}`);
                else await ctx.reply(`✅ Método de retiro <b>${escapeHTML(session.adminTempName)}</b> añadido con ID ${data.id}.`, { parse_mode: 'HTML' });
                delete session.adminAction;
                return;
            }
        }

        // Configurar tasa
        if (session.adminAction === 'set_rate') {
            const rate = parseFloat(text.replace(',', '.'));
            if (isNaN(rate) || rate <= 0) {
                await ctx.reply('❌ Número inválido. Envía un número positivo.');
                return;
            }
            await supabase.from('exchange_rate').update({ rate, updated_at: new Date() }).eq('id', 1);
            await ctx.reply(`✅ Tasa actualizada: 1 USD = ${rate} CUP`, { parse_mode: 'HTML' });
            delete session.adminAction;
            return;
        }

        // Configurar precio y multiplicador
        if (session.adminAction === 'set_price') {
            const parts = text.split(' ');
            if (parts.length < 3) {
                await ctx.reply('❌ Formato inválido. Usa: <code>&lt;cup&gt; &lt;usd&gt; &lt;multiplier&gt;</code>', { parse_mode: 'HTML' });
                return;
            }
            const cup = parseFloat(parts[0].replace(',', '.'));
            const usd = parseFloat(parts[1].replace(',', '.'));
            const multiplier = parseFloat(parts[2].replace(',', '.'));
            if (isNaN(cup) || isNaN(usd) || isNaN(multiplier) || cup < 0 || usd < 0 || multiplier < 0) {
                await ctx.reply('❌ Montos o multiplicador inválidos.');
                return;
            }
            await supabase
                .from('play_prices')
                .update({ amount_cup: cup, amount_usd: usd, payout_multiplier: multiplier, updated_at: new Date() })
                .eq('bet_type', session.betType);
            await ctx.reply(`✅ Precio para <b>${session.betType}</b> actualizado: ${cup} CUP / ${usd} USD  (x${multiplier})`, { parse_mode: 'HTML' });
            delete session.adminAction;
            delete session.betType;
            return;
        }

        // Publicar números ganadores
        if (session.adminAction === 'winning_numbers') {
            const sessionId = session.winningSessionId;
            const success = await processWinningNumber(sessionId, text, ctx);
            if (success) {
                delete session.adminAction;
                delete session.winningSessionId;
            }
            return;
        }
    }

    // ---------- FLUJOS DE USUARIO ----------
    // Depósito: después de la foto, esperamos el monto
    if (session.awaitingDepositAmount) {
        const amountText = text;
        const method = session.depositMethod;
        const buffer = session.depositPhotoBuffer;
        if (!buffer) {
            await ctx.reply('❌ Error: no se encontró la captura. Comienza de nuevo.');
            delete session.awaitingDepositAmount;
            return;
        }

        try {
            const request = await createDepositRequest(uid, method.id, buffer, amountText);
            // Notificar al admin
            await ctx.telegram.sendMessage(ADMIN_CHANNEL,
                `📥 <b>Nueva solicitud de DEPÓSITO</b>\n` +
                `👤 Usuario: ${ctx.from.first_name} (${uid})\n` +
                `🏦 Método: ${escapeHTML(method.name)}\n` +
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
            await ctx.reply(`✅ <b>Solicitud de depósito enviada</b>\nMonto: ${amountText}\n⏳ En espera de aprobación. Te notificaremos cuando se acredite.`, { parse_mode: 'HTML' });
        } catch (e) {
            console.error(e);
            await ctx.reply('❌ Error al procesar la solicitud. Intenta más tarde.');
        }

        delete session.awaitingDepositAmount;
        delete session.depositMethod;
        delete session.depositPhotoBuffer;
        // Mostrar menú principal
        await ctx.reply('¿Qué deseas hacer ahora?', getMainKeyboard(ctx));
        return;
    }

    // Retiro: esperando cuenta
    if (session.awaitingWithdrawAccount) {
        const account = text;
        const amount = parseFloat(user.usd);
        if (amount < 1) {
            await ctx.reply('❌ No tienes saldo USD suficiente para retirar.');
            delete session.awaitingWithdrawAccount;
            delete session.withdrawMethod;
            return;
        }

        const method = session.withdrawMethod;
        const { data: request, error } = await supabase
            .from('withdraw_requests')
            .insert({
                user_id: uid,
                method_id: method.id,
                amount_usd: amount,
                account_info: account,
                status: 'pending'
            })
            .select()
            .single();

        if (error) {
            await ctx.reply(`❌ Error al crear la solicitud: ${error.message}`);
        } else {
            await ctx.telegram.sendMessage(ADMIN_CHANNEL,
                `📤 <b>Nueva solicitud de RETIRO</b>\n` +
                `👤 Usuario: ${ctx.from.first_name} (${uid})\n` +
                `💰 Monto: ${amount} USD\n` +
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
            await ctx.reply(`✅ <b>Solicitud de retiro enviada</b>\n💰 Monto: ${amount} USD\n⏳ Procesaremos tu solicitud a la mayor brevedad.`, { parse_mode: 'HTML' });
        }

        delete session.awaitingWithdrawAccount;
        delete session.withdrawMethod;
        return;
    }

    // Transferencia: esperando ID destino
    if (session.awaitingTransferTarget) {
        const targetId = parseInt(text);
        if (isNaN(targetId)) {
            await ctx.reply('❌ ID inválido. Debe ser un número entero.');
            return;
        }
        if (targetId === uid) {
            await ctx.reply('❌ No puedes transferirte a ti mismo.');
            return;
        }

        const { data: targetUser } = await supabase
            .from('users')
            .select('telegram_id')
            .eq('telegram_id', targetId)
            .single();

        if (!targetUser) {
            await ctx.reply('❌ El usuario destinatario no está registrado.');
            return;
        }

        session.transferTarget = targetId;
        session.awaitingTransferAmount = true;
        delete session.awaitingTransferTarget;
        await ctx.reply(`Ahora envía el <b>monto en USD</b> a transferir:\n💰 Tu saldo: ${parseFloat(user.usd).toFixed(2)} USD`, { parse_mode: 'HTML' });
        return;
    }

    // Transferencia: esperando monto
    if (session.awaitingTransferAmount) {
        const amount = parseFloat(text.replace(',', '.'));
        if (isNaN(amount) || amount <= 0) {
            await ctx.reply('❌ Monto inválido.');
            return;
        }
        if (parseFloat(user.usd) < amount) {
            await ctx.reply('❌ Saldo insuficiente.');
            return;
        }

        const targetId = session.transferTarget;
        await supabase
            .from('users')
            .update({ usd: parseFloat(user.usd) - amount, updated_at: new Date() })
            .eq('telegram_id', uid);

        const { data: targetUser } = await supabase
            .from('users')
            .select('usd')
            .eq('telegram_id', targetId)
            .single();

        await supabase
            .from('users')
            .update({ usd: parseFloat(targetUser.usd) + amount, updated_at: new Date() })
            .eq('telegram_id', targetId);

        await ctx.reply(`✅ Transferencia realizada: ${amount.toFixed(2)} USD a ${targetId}.`, { parse_mode: 'HTML' });
        delete session.transferTarget;
        delete session.awaitingTransferAmount;
        return;
    }

    // ----- APUESTA -----
    if (session.awaitingBet) {
        const betType = session.betType;
        const lottery = session.lottery;
        const sessionId = session.sessionId;

        if (!sessionId) {
            await ctx.reply('❌ No se ha seleccionado una sesión activa. Comienza de nuevo.');
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
            await ctx.reply('❌ La sesión de juego ha sido cerrada. No se pueden registrar apuestas.');
            delete session.awaitingBet;
            return;
        }

        const parsed = parseBetMessage(text, betType);
        if (!parsed.ok) {
            await ctx.reply('❌ No se pudo interpretar tu apuesta. Verifica el formato y vuelve a intentarlo.');
            return;
        }

        const totalUSD = parsed.totalUSD;
        const totalCUP = parsed.totalCUP;

        if (totalUSD === 0 && totalCUP === 0) {
            await ctx.reply('❌ Debes especificar un monto válido (USD o CUP).');
            return;
        }

        let newUsd = parseFloat(user.usd);
        let newBonus = parseFloat(user.bonus_usd);
        let newCup = parseFloat(user.cup);

        if (totalUSD > 0) {
            const totalDisponible = newUsd + newBonus;
            if (totalDisponible < totalUSD) {
                await ctx.reply('❌ Saldo USD (incluyendo bono) insuficiente.');
                return;
            }
            const usarBono = Math.min(newBonus, totalUSD);
            newBonus -= usarBono;
            newUsd -= (totalUSD - usarBono);
        }

        if (totalCUP > 0) {
            if (newCup < totalCUP) {
                await ctx.reply('❌ Saldo CUP insuficiente.');
                return;
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
            .eq('telegram_id', uid);

        const { data: bet, error } = await supabase
            .from('bets')
            .insert({
                user_id: uid,
                lottery,
                session_id: sessionId,
                bet_type: betType,
                raw_text: text,
                items: parsed.items,
                cost_usd: totalUSD,
                cost_cup: totalCUP,
                placed_at: new Date()
            })
            .select()
            .single();

        if (error) {
            console.error('Error insertando apuesta:', error);
            await ctx.reply('❌ Error al registrar la apuesta. Intenta más tarde.');
            return;
        }

        await ctx.replyWithHTML(
            `✅ <b>Jugada registrada</b>\n🎰 ${escapeHTML(lottery)} - ${escapeHTML(betType)}\n` +
            `📝 <code>${escapeHTML(text)}</code>\n` +
            `💰 Costo total: ${totalUSD.toFixed(2)} USD / ${totalCUP.toFixed(2)} CUP\n` +
            `🍀 ¡Buena suerte!`
        );

        delete session.awaitingBet;
        delete session.betType;
        delete session.lottery;
        delete session.sessionId;
        // Mostrar menú principal
        await ctx.reply('¿Qué deseas hacer ahora?', getMainKeyboard(ctx));
        return;
    }

    // Si no es ningún flujo, mostrar menú principal
    await ctx.reply('No entendí ese mensaje. Por favor usa los botones del menú.', getMainKeyboard(ctx));
});

// ========== MANEJADOR DE FOTOS (para depósitos) ==========
bot.on(message('photo'), async (ctx) => {
    const uid = ctx.from.id;
    const session = ctx.session;

    if (session.awaitingDepositPhoto) {
        // Obtener la foto de mayor resolución
        const photo = ctx.message.photo.pop();
        const fileId = photo.file_id;
        const fileLink = await ctx.telegram.getFileLink(fileId);
        // Descargar el archivo
        const response = await axios({ url: fileLink.href, responseType: 'arraybuffer' });
        const buffer = Buffer.from(response.data, 'binary');

        // Guardar en sesión
        session.depositPhotoBuffer = buffer;
        delete session.awaitingDepositPhoto;
        session.awaitingDepositAmount = true;

        await ctx.reply('✅ Captura recibida. Ahora envía el <b>monto transferido</b> (ej: <code>10 usd</code> o <code>500 cup</code>).', { parse_mode: 'HTML' });
        return;
    }

    // Si no se esperaba foto, responder con menú
    await ctx.reply('No se esperaba una foto. Usa los botones del menú.', getMainKeyboard(ctx));
});

// ========== APROBACIÓN/RECHAZO DE DEPÓSITOS ==========
bot.action(/approve_deposit_(\d+)/, async (ctx) => {
    if (ctx.from.id !== ADMIN_ID) {
        await ctx.answerCbQuery('No autorizado', { show_alert: true });
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

        // Parsear el monto
        const { usd, cup } = parseAmount(request.amount);
        const user = await getUser(request.user_id);
        let updateData = { updated_at: new Date() };
        if (usd > 0) {
            const rate = await getExchangeRate();
            const bonusUSD = parseFloat((BONUS_CUP_DEFAULT / rate).toFixed(2));
            updateData.usd = parseFloat(user.usd) + usd;
            updateData.bonus_usd = parseFloat(user.bonus_usd) + bonusUSD;
        } else if (cup > 0) {
            const rate = await getExchangeRate();
            const bonusUSD = parseFloat((BONUS_CUP_DEFAULT / rate).toFixed(2));
            updateData.cup = parseFloat(user.cup) + cup;
            updateData.bonus_usd = parseFloat(user.bonus_usd) + bonusUSD;
        } else {
            await ctx.answerCbQuery('Monto no válido', { show_alert: true });
            return;
        }

        await supabase
            .from('users')
            .update(updateData)
            .eq('telegram_id', request.user_id);

        await supabase
            .from('deposit_requests')
            .update({ status: 'approved', updated_at: new Date() })
            .eq('id', requestId);

        await ctx.telegram.sendMessage(request.user_id,
            `✅ <b>Depósito aprobado</b>\nSe ha acreditado <b>${request.amount}</b> a tu saldo.\n🎁 Bonus añadido.`,
            { parse_mode: 'HTML' }
        );

        await ctx.editMessageReplyMarkup({ inline_keyboard: [] });
        await ctx.reply('✅ Depósito aprobado y saldo actualizado.');
        await ctx.answerCbQuery();
    } catch (e) {
        console.error(e);
        await ctx.answerCbQuery('❌ Error al aprobar', { show_alert: true });
    }
});

bot.action(/reject_deposit_(\d+)/, async (ctx) => {
    if (ctx.from.id !== ADMIN_ID) return;
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
                '❌ <b>Depósito rechazado</b>\nLa solicitud no pudo ser procesada. Contacta al administrador.',
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

// ========== APROBACIÓN/RECHAZO DE RETIROS ==========
bot.action(/approve_withdraw_(\d+)/, async (ctx) => {
    if (ctx.from.id !== ADMIN_ID) {
        await ctx.answerCbQuery('No autorizado', { show_alert: true });
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
            .select('usd')
            .eq('telegram_id', request.user_id)
            .single();

        if (parseFloat(user.usd) < request.amount_usd) {
            await ctx.reply('❌ El usuario ya no tiene saldo suficiente. Rechaza la solicitud.');
            return;
        }

        await supabase
            .from('users')
            .update({ usd: parseFloat(user.usd) - request.amount_usd, updated_at: new Date() })
            .eq('telegram_id', request.user_id);

        await supabase
            .from('withdraw_requests')
            .update({ status: 'approved', updated_at: new Date() })
            .eq('id', requestId);

        await ctx.telegram.sendMessage(request.user_id,
            `✅ <b>Retiro aprobado</b>\nSe ha procesado tu solicitud por <b>${request.amount_usd} USD</b>.\nLos fondos serán enviados a la cuenta proporcionada.`,
            { parse_mode: 'HTML' }
        );

        await ctx.editMessageReplyMarkup({ inline_keyboard: [] });
        await ctx.reply('✅ Retiro aprobado y saldo debitado.');
        await ctx.answerCbQuery();
    } catch (e) {
        console.error(e);
        await ctx.answerCbQuery('❌ Error al aprobar', { show_alert: true });
    }
});

bot.action(/reject_withdraw_(\d+)/, async (ctx) => {
    if (ctx.from.id !== ADMIN_ID) return;
    try {
        const requestId = parseInt(ctx.match[1]);
        await supabase.from('withdraw_requests').update({ status: 'rejected', updated_at: new Date() }).eq('id', requestId);
        const { data: request } = await supabase.from('withdraw_requests').select('user_id').eq('id', requestId).single();
        if (request) {
            await ctx.telegram.sendMessage(request.user_id,
                '❌ <b>Retiro rechazado</b>\nTu solicitud no pudo ser procesada.',
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

// ========== CIERRE AUTOMÁTICO DE SESIONES ==========
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

            // Broadcast de cierre automático
            await broadcastToAllUsers(
                `⏰ <b>SESIÓN CERRADA AUTOMÁTICAMENTE</b>\n\n` +
                `🎰 <b>${escapeHTML(session.lottery)}</b> - Turno <b>${escapeHTML(session.time_slot)}</b>\n` +
                `📅 Fecha: ${session.date}\n\n` +
                `❌ El tiempo para apostar ha finalizado.\n` +
                `🔢 Pronto se publicará el número ganador. ¡Gracias por participar!`
            );
        }
    } catch (e) {
        console.error('Error cerrando sesiones:', e);
    }
}

cron.schedule('* * * * *', () => {
    closeExpiredSessions();
}, { timezone: TIMEZONE });

// ========== EXPORTAR BOT ==========
module.exports = bot;
