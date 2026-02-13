// ==============================
// bot.js - Bot de Telegram para Rifas Cuba
// Flujo simplificado, sesiones de lotería, cierre automático
// ==============================

require('dotenv').config();
const { Telegraf, Markup } = require('telegraf');
const { message } = require('telegraf/filters');
const LocalSession = require('telegraf-session-local');
const { createClient } = require('@supabase/supabase-js');
const cron = require('node-cron');

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

/**
 * Escapa caracteres especiales para HTML (parse_mode = 'HTML')
 */
function escapeHTML(text) {
    return String(text)
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;')
        .replace(/'/g, '&#039;');
}

/**
 * Envía o edita un mensaje con parse_mode HTML y maneja errores.
 */
async function safeEdit(ctx, text, keyboard = null) {
    try {
        const escapedText = escapeHTML(text);
        if (ctx.callbackQuery) {
            await ctx.editMessageText(escapedText, {
                parse_mode: 'HTML',
                reply_markup: keyboard?.reply_markup
            });
        } else {
            await ctx.reply(escapedText, {
                parse_mode: 'HTML',
                reply_markup: keyboard?.reply_markup
            });
        }
    } catch (err) {
        console.warn('Error en safeEdit, enviando nuevo mensaje:', err.message);
        try {
            await ctx.reply(escapeHTML(text), {
                parse_mode: 'HTML',
                reply_markup: keyboard?.reply_markup
            });
        } catch (e) {
            console.error('No se pudo enviar el mensaje:', e);
        }
    }
}

/**
 * Obtiene o crea un usuario en Supabase.
 */
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
 * Convierte CUP a USD según tasa actual.
 */
async function cupToUsd(cup) {
    const rate = await getExchangeRate();
    return cup / rate;
}

/**
 * Parsea un string para extraer monto y moneda (ej: "10 usd", "500 cup").
 */
function parseAmount(text) {
    const lower = text.toLowerCase().replace(',', '.').trim();
    let usd = 0, cup = 0;
    const usdMatch = lower.match(/(\d+(?:\.\d+)?)\s*usd/);
    const cupMatch = lower.match(/(\d+(?:\.\d+)?)\s*cup/);
    if (usdMatch) usd = parseFloat(usdMatch[1]);
    if (cupMatch) cup = parseFloat(cupMatch[1]);
    return { usd, cup };
}

/**
 * Parsea el costo de una jugada.
 * Si el mensaje contiene un monto (ej: "10 usd"), usa ese; si no, usa los precios por defecto.
 */
async function parseBetCost(raw, betType) {
    const { data: priceData } = await supabase
        .from('play_prices')
        .select('amount_usd, amount_cup')
        .eq('bet_type', betType)
        .single();

    const defaultPrices = priceData || { amount_usd: 0.2, amount_cup: 70 };
    const lower = raw.toLowerCase();

    let usdCost = 0, cupCost = 0;
    const pattern = /(\d+(?:\.\d+)?)\s*(usd|cup)/g;
    let match, lastMatch = null;
    while ((match = pattern.exec(lower)) !== null) lastMatch = match;

    if (lastMatch) {
        const val = parseFloat(lastMatch[1]);
        if (lastMatch[2] === 'usd') usdCost = val;
        else cupCost = val;
    } else {
        usdCost = defaultPrices.amount_usd;
        cupCost = defaultPrices.amount_cup;
    }

    return { ok: usdCost > 0 || cupCost > 0, usdCost, cupCost };
}

/**
 * Middleware: carga el usuario actual en ctx.dbUser.
 */
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

// ========== TECLADOS (INLINE KEYBOARDS) ==========

function mainMenuKbd() {
    return Markup.inlineKeyboard([
        [Markup.button.callback('🎲 Jugar', 'play')],
        [Markup.button.callback('💰 Mi dinero', 'my_money')],
        [Markup.button.callback('📋 Mis jugadas', 'my_bets')],
        [Markup.button.callback('👥 Referidos', 'referrals')],
        [Markup.button.callback('❓ Cómo jugar', 'how_to_play')],
        [Markup.button.callback('🔧 Admin', 'admin_panel')],
        [Markup.button.webApp('🌐 Abrir WebApp', `${WEBAPP_URL}/app.html`)]
    ]);
}

function playLotteryKbd() {
    return Markup.inlineKeyboard([
        [Markup.button.callback('🦩 Florida', 'lot_florida'), Markup.button.callback('🍑 Georgia', 'lot_georgia')],
        [Markup.button.callback('🗽 Nueva York', 'lot_newyork')],
        [Markup.button.callback('◀ Volver', 'main')]
    ]);
}

function playTypeKbd() {
    return Markup.inlineKeyboard([
        [Markup.button.callback('🎯 Fijo', 'type_fijo')],
        [Markup.button.callback('🏃 Corridos', 'type_corridos')],
        [Markup.button.callback('💯 Centena', 'type_centena')],
        [Markup.button.callback('🔒 Parle', 'type_parle')],
        [Markup.button.callback('◀ Volver', 'play')]
    ]);
}

function myMoneyKbd() {
    return Markup.inlineKeyboard([
        [Markup.button.callback('📥 Recargar', 'recharge')],
        [Markup.button.callback('📤 Retirar', 'withdraw')],
        [Markup.button.callback('🔄 Transferir', 'transfer')],
        [Markup.button.callback('◀ Volver', 'main')]
    ]);
}

function adminPanelKbd() {
    return Markup.inlineKeyboard([
        [Markup.button.callback('➕ Añadir método DEPÓSITO', 'adm_add_dep')],
        [Markup.button.callback('➕ Añadir método RETIRO', 'adm_add_wit')],
        [Markup.button.callback('💰 Configurar tasa USD/CUP', 'adm_set_rate')],
        [Markup.button.callback('🎲 Configurar precios de jugadas', 'adm_set_price')],
        [Markup.button.callback('📋 Ver datos actuales', 'adm_view')],
        [Markup.button.callback('🎰 Abrir sesión de lotería', 'adm_open_session')],
        [Markup.button.callback('🔢 Publicar números ganadores', 'adm_winning_numbers')],
        [Markup.button.callback('◀ Menú principal', 'main')]
    ]);
}

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
        `¡Hola de nuevo, <b>${firstName}</b> 👋\nBienvenido de regreso a Rifas Cuba, tu asistente de la suerte 🍀\n\n🎲 ¿Listo para jugar?\nApuesta, gana y disfruta. ¡La suerte está de tu lado!`,
        mainMenuKbd()
    );
});

// ========== CALLBACKS DEL MENÚ PRINCIPAL ==========
bot.action('main', async (ctx) => {
    const firstName = ctx.from.first_name || 'Jugador';
    await safeEdit(ctx,
        `¡Hola de nuevo, <b>${firstName}</b> 👋\nBienvenido de regreso a Rifas Cuba, tu asistente de la suerte 🍀\n\n🎲 ¿Listo para jugar?\nApuesta, gana y disfruta. ¡La suerte está de tu lado!`,
        mainMenuKbd()
    );
});

// ========== JUGAR ==========
bot.action('play', async (ctx) => {
    await safeEdit(ctx, 'Selecciona una lotería:', playLotteryKbd());
});

bot.action(/lot_(.+)/, async (ctx) => {
    const lotteryKey = ctx.match[1];
    const lotteryName = {
        florida: 'Florida',
        georgia: 'Georgia',
        newyork: 'Nueva York'
    }[lotteryKey];

    // Horario para Georgia
    if (lotteryKey === 'georgia') {
        const now = new Date().toLocaleString('en-US', { timeZone: TIMEZONE });
        const hour = new Date(now).getHours();
        const minute = new Date(now).getMinutes();
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

    ctx.session.lottery = lotteryName;
    await safeEdit(ctx, `Has seleccionado <b>${lotteryName}</b>. Ahora elige el tipo de jugada:`, playTypeKbd());
});

bot.action(/type_(.+)/, async (ctx) => {
    const betType = ctx.match[1];
    ctx.session.betType = betType;
    ctx.session.awaitingBet = true;
    const lottery = ctx.session.lottery || 'Florida';

    let instructions = '';
    switch (betType) {
        case 'fijo':
            instructions = `🎯 <b>Jugada FIJO</b> - 🦩 ${lottery}\n\n📌 Escribe cada número con su valor específico:\n\n📖 <b>Ejemplos:</b>\n• 12 con 1 usd, 34 con 2 usd\n• 7*1.5usd, 23*2 cup\nEn caso de decenas y terminal:\n• D2 con 1 usd, T5*2 cup\n\n⚡ Se procesará inmediatamente\n\n💭 <b>Escribe tus números:</b>`;
            break;
        case 'corridos':
            instructions = `🏃 <b>Jugada CORRIDOS</b> - 🦩 ${lottery}\n\n📌 Escribe cada número con su valor específico:\n\n📖 <b>Ejemplos:</b>\n• 12 con 1 usd, 34 con 2 usd\n• 7*1.5usd, 23*2 cup\n\n⚡ Se procesará inmediatamente\n\n💭 <b>Escribe tus números:</b>`;
            break;
        case 'centena':
            instructions = `💯 <b>Jugada CENTENA</b> - 🦩 ${lottery}\n\n📌 Escribe cada número con su valor específico (3 dígitos):\n\n📖 <b>Ejemplos:</b>\n• 123 con 1 usd, 456 con 2 usd\n• 001*1.5usd, 125*2 cup\n\n⚡ Se procesará inmediatamente\n\n💭 <b>Escribe tus números (3 dígitos):</b>`;
            break;
        case 'parle':
            instructions = `🔒 <b>Jugada PARLE</b> - 🦩 ${lottery}\n\n📌 Escribe cada parle con su valor específico:\n\n📖 <b>Ejemplos:</b>\n• 12x34 con 1 usd, 56x78 con 2 usd\n• 12x34*1.5usd, 56x78*2 cup\n• 12x T5 con 1 usd\n\n⚡ Se procesará inmediatamente\n\n💭 <b>Escribe tus parles (usa 'x' entre números):</b>`;
            break;
    }
    await safeEdit(ctx, instructions, null);
});

// ========== MI DINERO ==========
bot.action('my_money', async (ctx) => {
    const user = ctx.dbUser;
    const text = `💰 <b>Tu saldo actual:</b>\n🇨🇺 <b>CUP:</b> ${parseFloat(user.cup).toFixed(2)}\n💵 <b>USD:</b> ${parseFloat(user.usd).toFixed(2)}\n🎁 <b>Bono:</b> ${parseFloat(user.bonus_usd).toFixed(2)} USD`;
    await safeEdit(ctx, text, myMoneyKbd());
});

// ---------- RECARGAR ----------
bot.action('recharge', async (ctx) => {
    const { data: methods } = await supabase
        .from('deposit_methods')
        .select('*')
        .order('id', { ascending: true });

    if (!methods || methods.length === 0) {
        await ctx.answerCbQuery('❌ No hay métodos de depósito configurados.', { show_alert: true });
        return;
    }

    const buttons = methods.map(m => Markup.button.callback(m.name, `dep_${m.id}`));
    const rows = [];
    for (let i = 0; i < buttons.length; i += 2) rows.push(buttons.slice(i, i + 2));
    rows.push([Markup.button.callback('◀ Volver', 'my_money')]);

    const rate = await getExchangeRate();
    await safeEdit(ctx,
        `💵 <b>¿Cómo deseas recargar?</b>\n\nElige una opción para ver los datos de pago y luego <b>envía el monto</b> que transferiste (ej: <code>10 usd</code> o <code>500 cup</code>).\n\n<b>Tasa de cambio:</b> 1 USD = ${rate} CUP`,
        Markup.inlineKeyboard(rows)
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
    ctx.session.awaitingDepositAmount = true;

    await safeEdit(ctx,
        `🧾 <b>${method.name}</b>\nNúmero: <code>${method.card}</code>\nConfirmar: <code>${method.confirm}</code>\n\n✅ <b>Después de transferir, envía el MONTO que transferiste</b> (ej: <code>10 usd</code> o <code>500 cup</code>).`,
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

    const buttons = methods.map(m => Markup.button.callback(m.name, `wit_${m.id}`));
    const rows = [];
    for (let i = 0; i < buttons.length; i += 2) rows.push(buttons.slice(i, i + 2));
    rows.push([Markup.button.callback('◀ Volver', 'my_money')]);

    await safeEdit(ctx, '📤 <b>Elige un método de retiro:</b>', Markup.inlineKeyboard(rows));
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
        `Has elegido <b>${method.name}</b>.\n\n💰 <b>Tu saldo disponible:</b> ${parseFloat(ctx.dbUser.usd).toFixed(2)} USD\nEnvía ahora el <b>número/ID de la tarjeta/cuenta</b> a la que deseas que retiremos:`,
        null
    );
});

// ---------- TRANSFERIR ----------
bot.action('transfer', async (ctx) => {
    ctx.session.awaitingTransferTarget = true;
    await safeEdit(ctx,
        '🔄 <b>Transferir saldo</b>\n\nEnvía el <b>ID de Telegram</b> del usuario al que deseas transferir (ej: 123456789):',
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
            null
        );
    } else {
        let text = '📋 <b>Tus últimas 5 jugadas:</b>\n\n';
        bets.forEach((b, i) => {
            const date = new Date(b.placed_at).toLocaleString('es-CU', { timeZone: TIMEZONE });
            text += `<b>${i + 1}.</b> 🎰 ${b.lottery} - ${b.bet_type}\n   📝 <code>${b.raw_text}</code>\n   💰 ${b.cost_usd} USD / ${b.cost_cup} CUP\n   🕒 ${date}\n\n`;
        });
        await safeEdit(ctx, text, null);
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
        `💸 <b>¡INVITA Y GANA DINERO AUTOMÁTICO! 💰</b>\n\n🎯 <b>¿Cómo funciona?</b>\n1️⃣ Comparte tu enlace con amigos\n2️⃣ Cuando se registren y jueguen, TÚ ganas\n3️⃣ Recibes comisión CADA VEZ que apuesten\n4️⃣ ¡Dinero GRATIS para siempre! 🔄\n\n🔥 SIN LÍMITES - SIN TOPES - PARA SIEMPRE\n\n📲 <b>ESTE ES TU ENLACE MÁGICO:</b> 👇\n<code>${link}</code>\n\n📊 <b>Tus estadísticas:</b>\n👥 Total de referidos: ${count || 0}`,
        null
    );
});

// ========== CÓMO JUGAR ==========
bot.action('how_to_play', async (ctx) => {
    await safeEdit(ctx,
        '📩 <b>¿Tienes dudas?</b>\nEscribe directamente en el chat del bot, tu mensaje será respondido por una persona real.\n\nℹ️ Estamos aquí para ayudarte.',
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

// ---------- ADMIN: Añadir método DEPÓSITO ----------
bot.action('adm_add_dep', async (ctx) => {
    if (ctx.from.id !== ADMIN_ID) return;
    ctx.session.adminAction = 'add_dep';
    ctx.session.adminStep = 1;
    await ctx.reply('➕ <b>Añadir método de DEPÓSITO</b>\n\nEscribe el <b>nombre</b> del método (ej: Tarjeta Banco Metropolitano):');
    await ctx.answerCbQuery();
});

// ---------- ADMIN: Añadir método RETIRO ----------
bot.action('adm_add_wit', async (ctx) => {
    if (ctx.from.id !== ADMIN_ID) return;
    ctx.session.adminAction = 'add_wit';
    ctx.session.adminStep = 1;
    await ctx.reply('➕ <b>Añadir método de RETIRO</b>\n\nEscribe el <b>nombre</b> del método (ej: Transfermovil):');
    await ctx.answerCbQuery();
});

// ---------- ADMIN: Configurar tasa ----------
bot.action('adm_set_rate', async (ctx) => {
    if (ctx.from.id !== ADMIN_ID) return;
    const rate = await getExchangeRate();
    ctx.session.adminAction = 'set_rate';
    await ctx.reply(`💰 <b>Tasa actual:</b> 1 USD = ${rate} CUP\n\nEnvía la <b>nueva tasa</b> (solo número, ej: 120):`);
    await ctx.answerCbQuery();
});

// ---------- ADMIN: Configurar precios ----------
bot.action('adm_set_price', async (ctx) => {
    if (ctx.from.id !== ADMIN_ID) return;
    const { data: prices } = await supabase.from('play_prices').select('*');
    const buttons = prices.map(p => Markup.button.callback(p.bet_type, `set_price_${p.bet_type}`));
    const rows = [];
    for (let i = 0; i < buttons.length; i += 2) rows.push(buttons.slice(i, i + 2));
    rows.push([Markup.button.callback('◀ Cancelar', 'admin_panel')]);
    await ctx.reply('🎲 <b>Configurar precios de jugadas</b>\nElige el tipo que deseas modificar:',
        Markup.inlineKeyboard(rows)
    );
    await ctx.answerCbQuery();
});

bot.action(/set_price_(.+)/, async (ctx) => {
    if (ctx.from.id !== ADMIN_ID) return;
    const betType = ctx.match[1];
    ctx.session.adminAction = 'set_price';
    ctx.session.betType = betType;
    await ctx.reply(`Configurando <b>${betType}</b>\nEnvía en el formato: <code>&lt;monto_cup&gt; &lt;monto_usd&gt;</code>\nEjemplo: <code>70 0.20</code>`);
    await ctx.answerCbQuery();
});

// ---------- ADMIN: Ver datos actuales ----------
bot.action('adm_view', async (ctx) => {
    if (ctx.from.id !== ADMIN_ID) return;
    const rate = await getExchangeRate();
    const { data: depMethods } = await supabase.from('deposit_methods').select('*');
    const { data: witMethods } = await supabase.from('withdraw_methods').select('*');
    const { data: prices } = await supabase.from('play_prices').select('*');

    let text = `💰 <b>Tasa:</b> 1 USD = ${rate} CUP\n\n📥 <b>Métodos DEPÓSITO:</b>\n`;
    depMethods?.forEach(m => text += `  ID ${m.id}: ${m.name} - ${m.card} / ${m.confirm}\n`);
    text += `\n📤 <b>Métodos RETIRO:</b>\n`;
    witMethods?.forEach(m => text += `  ID ${m.id}: ${m.name} - ${m.card} / ${m.confirm}\n`);
    text += `\n🎲 <b>Precios por jugada:</b>\n`;
    prices?.forEach(p => text += `  ${p.bet_type}: ${p.amount_cup} CUP / ${p.amount_usd} USD\n`);

    await safeEdit(ctx, text, Markup.inlineKeyboard([[Markup.button.callback('◀ Volver a Admin', 'admin_panel')]]));
});

// ---------- ADMIN: Abrir sesión de lotería ----------
bot.action('adm_open_session', async (ctx) => {
    if (ctx.from.id !== ADMIN_ID) return;
    ctx.session.adminAction = 'open_session';
    ctx.session.adminStep = 1;
    await safeEdit(ctx,
        '🎰 <b>Abrir sesión de lotería</b>\n\nSelecciona la lotería:',
        Markup.inlineKeyboard([
            [Markup.button.callback('🦩 Florida', 'open_lot_florida')],
            [Markup.button.callback('🍑 Georgia', 'open_lot_georgia')],
            [Markup.button.callback('🗽 Nueva York', 'open_lot_newyork')],
            [Markup.button.callback('◀ Cancelar', 'admin_panel')]
        ])
    );
});

bot.action(/open_lot_(.+)/, async (ctx) => {
    if (ctx.from.id !== ADMIN_ID) return;
    const lotteryKey = ctx.match[1];
    const lotteryName = {
        florida: 'Florida',
        georgia: 'Georgia',
        newyork: 'Nueva York'
    }[lotteryKey];
    ctx.session.tempLottery = lotteryName;
    ctx.session.adminStep = 2;
    await safeEdit(ctx,
        `Lotería: <b>${lotteryName}</b>\nSelecciona el turno:`,
        Markup.inlineKeyboard([
            [Markup.button.callback('☀️ Mañana (9:00 - 12:00)', 'slot_morning')],
            [Markup.button.callback('🌆 Tarde (14:00 - 18:30)', 'slot_afternoon')],
            [Markup.button.callback('🌙 Noche (20:00 - 23:00)', 'slot_evening')],
            [Markup.button.callback('◀ Volver', 'adm_open_session')]
        ])
    );
});

bot.action(/slot_(.+)/, async (ctx) => {
    if (ctx.from.id !== ADMIN_ID) return;
    const slotKey = ctx.match[1];
    const slotNames = { morning: 'Mañana', afternoon: 'Tarde', evening: 'Noche' };
    const timeSlot = slotNames[slotKey];
    if (!timeSlot) return;

    const lottery = ctx.session.tempLottery;
    if (!lottery) {
        await ctx.answerCbQuery('❌ Primero selecciona una lotería.', { show_alert: true });
        return;
    }

    // Calcular fecha y hora de cierre
    const now = new Date().toLocaleString('en-US', { timeZone: TIMEZONE });
    const today = new Date(now).toISOString().split('T')[0];
    let endHour, endMinute;
    if (slotKey === 'morning') { endHour = 12; endMinute = 0; }
    else if (slotKey === 'afternoon') { endHour = 18; endMinute = 30; }
    else { endHour = 23; endMinute = 0; }

    const endTimeStr = `${today} ${endHour.toString().padStart(2, '0')}:${endMinute.toString().padStart(2, '0')}:00`;
    const endTime = new Date(endTimeStr + ' ' + TIMEZONE).toISOString();

    const { error } = await supabase
        .from('lottery_sessions')
        .insert({
            lottery,
            date: today,
            time_slot: timeSlot,
            status: 'open',
            end_time: endTime
        });

    if (error) {
        await ctx.reply(`❌ Error al abrir sesión: ${error.message}`);
    } else {
        await ctx.reply(`✅ Sesión de <b>${lottery}</b> (${today} - ${timeSlot}) abierta. Se cerrará automáticamente a las ${endHour}:${endMinute.toString().padStart(2, '0')} (hora Cuba).`);
    }

    delete ctx.session.tempLottery;
    delete ctx.session.adminAction;
    await ctx.answerCbQuery();
});

// ---------- ADMIN: Publicar números ganadores ----------
bot.action('adm_winning_numbers', async (ctx) => {
    if (ctx.from.id !== ADMIN_ID) return;

    const { data: closedSessions } = await supabase
        .from('lottery_sessions')
        .select('*')
        .eq('status', 'closed')
        .order('date', { ascending: false })
        .limit(10);

    if (!closedSessions || closedSessions.length === 0) {
        await ctx.reply('🔢 No hay sesiones cerradas. Abre y cierra una sesión primero.');
        return;
    }

    const buttons = closedSessions.map(s =>
        Markup.button.callback(`${s.lottery} - ${s.date} (${s.time_slot})`, `win_session_${s.id}`)
    );
    const rows = [];
    for (let i = 0; i < buttons.length; i += 2) rows.push(buttons.slice(i, i + 2));
    rows.push([Markup.button.callback('◀ Cancelar', 'admin_panel')]);

    await ctx.reply('🔢 <b>Publicar números ganadores</b>\nSelecciona la sesión:', Markup.inlineKeyboard(rows));
    await ctx.answerCbQuery();
});

bot.action(/win_session_(\d+)/, async (ctx) => {
    if (ctx.from.id !== ADMIN_ID) return;
    const sessionId = parseInt(ctx.match[1]);
    ctx.session.winningSessionId = sessionId;
    ctx.session.adminAction = 'winning_numbers';
    ctx.session.adminStep = 1;
    await ctx.reply('✍️ Envía los números ganadores separados por comas (ej: 12,34,56):');
    await ctx.answerCbQuery();
});

// ========== MANEJADOR DE MENSAJES DE TEXTO ==========
bot.on(message('text'), async (ctx) => {
    const uid = ctx.from.id;
    const text = ctx.message.text.trim();
    const session = ctx.session;

    // ---------- FLUJOS ADMIN ----------
    if (uid === ADMIN_ID && session.adminAction) {

        // ----- Añadir depósito -----
        if (session.adminAction === 'add_dep') {
            if (session.adminStep === 1) {
                session.adminTempName = text;
                session.adminStep = 2;
                await ctx.reply('Ahora envía el <b>número de la tarjeta/cuenta</b>:');
                return;
            } else if (session.adminStep === 2) {
                session.adminTempCard = text;
                session.adminStep = 3;
                await ctx.reply('Ahora envía el <b>número a confirmar</b> (ej: 1234):');
                return;
            } else if (session.adminStep === 3) {
                const { data, error } = await supabase
                    .from('deposit_methods')
                    .insert({ name: session.adminTempName, card: session.adminTempCard, confirm: text })
                    .select()
                    .single();
                if (error) await ctx.reply(`❌ Error: ${error.message}`);
                else await ctx.reply(`✅ Método de depósito <b>${session.adminTempName}</b> añadido con ID ${data.id}.`);
                delete session.adminAction;
                return;
            }
        }

        // ----- Añadir retiro -----
        if (session.adminAction === 'add_wit') {
            if (session.adminStep === 1) {
                session.adminTempName = text;
                session.adminStep = 2;
                await ctx.reply('Ahora envía el <b>número o instrucción para retirar</b>:');
                return;
            } else if (session.adminStep === 2) {
                session.adminTempCard = text;
                session.adminStep = 3;
                await ctx.reply('Ahora envía el <b>número a confirmar</b> (o "ninguno"):');
                return;
            } else if (session.adminStep === 3) {
                const { data, error } = await supabase
                    .from('withdraw_methods')
                    .insert({ name: session.adminTempName, card: session.adminTempCard, confirm: text })
                    .select()
                    .single();
                if (error) await ctx.reply(`❌ Error: ${error.message}`);
                else await ctx.reply(`✅ Método de retiro <b>${session.adminTempName}</b> añadido con ID ${data.id}.`);
                delete session.adminAction;
                return;
            }
        }

        // ----- Configurar tasa -----
        if (session.adminAction === 'set_rate') {
            const rate = parseFloat(text.replace(',', '.'));
            if (isNaN(rate) || rate <= 0) {
                await ctx.reply('❌ Número inválido. Envía un número positivo.');
                return;
            }
            await supabase.from('exchange_rate').update({ rate, updated_at: new Date() }).eq('id', 1);
            await ctx.reply(`✅ Tasa actualizada: 1 USD = ${rate} CUP`);
            delete session.adminAction;
            return;
        }

        // ----- Configurar precio -----
        if (session.adminAction === 'set_price') {
            const parts = text.split(' ');
            if (parts.length < 2) {
                await ctx.reply('❌ Formato inválido. Usa: <code>&lt;cup&gt; &lt;usd&gt;</code> (ej: 70 0.20)');
                return;
            }
            const cup = parseFloat(parts[0].replace(',', '.'));
            const usd = parseFloat(parts[1].replace(',', '.'));
            if (isNaN(cup) || isNaN(usd) || cup < 0 || usd < 0) {
                await ctx.reply('❌ Montos inválidos.');
                return;
            }
            await supabase
                .from('play_prices')
                .update({ amount_cup: cup, amount_usd: usd, updated_at: new Date() })
                .eq('bet_type', session.betType);
            await ctx.reply(`✅ Precio para <b>${session.betType}</b> actualizado: ${cup} CUP / ${usd} USD`);
            delete session.adminAction;
            delete session.betType;
            return;
        }

        // ----- Publicar números ganadores -----
        if (session.adminAction === 'winning_numbers') {
            const sessionId = session.winningSessionId;
            const numbers = text.split(',').map(n => n.trim()).filter(n => n);
            const { data: ses } = await supabase.from('lottery_sessions').select('*').eq('id', sessionId).single();
            if (!ses) {
                await ctx.reply('❌ Sesión no encontrada.');
                delete session.adminAction;
                return;
            }
            const { error } = await supabase
                .from('winning_numbers')
                .insert({
                    lottery: ses.lottery,
                    date: ses.date,
                    time_slot: ses.time_slot,
                    numbers,
                    published_at: new Date()
                });
            if (error) {
                await ctx.reply(`❌ Error al publicar: ${error.message}`);
            } else {
                await ctx.reply(`✅ Números ganadores de ${ses.lottery} (${ses.date} - ${ses.time_slot}) publicados.`);
                await notifyUsersOfWinningNumbers(ses, numbers);
            }
            delete session.adminAction;
            delete session.winningSessionId;
            return;
        }
    }

    // ---------- FLUJOS DE USUARIO ----------

    // ----- Depósito: monto -----
    if (session.awaitingDepositAmount) {
        const { usd, cup } = parseAmount(text);
        if (usd === 0 && cup === 0) {
            await ctx.reply('❌ Formato inválido. Envía algo como <code>10 usd</code> o <code>500 cup</code>.');
            return;
        }

        const user = ctx.dbUser;
        const method = session.depositMethod;
        let amountUSD = 0, amountCUP = 0;

        if (usd > 0) {
            amountUSD = usd;
            const rate = await getExchangeRate();
            const bonusUSD = parseFloat((BONUS_CUP_DEFAULT / rate).toFixed(2));
            await supabase
                .from('users')
                .update({
                    usd: parseFloat(user.usd) + amountUSD,
                    bonus_usd: parseFloat(user.bonus_usd) + bonusUSD,
                    updated_at: new Date()
                })
                .eq('telegram_id', uid);
            await ctx.reply(`✅ Depósito de <b>${amountUSD} USD</b> confirmado.\n🎁 Bonus añadido: +${bonusUSD} USD (no retirable).`);
        } else {
            amountCUP = cup;
            const rate = await getExchangeRate();
            const bonusUSD = parseFloat((BONUS_CUP_DEFAULT / rate).toFixed(2));
            await supabase
                .from('users')
                .update({
                    cup: parseFloat(user.cup) + amountCUP,
                    bonus_usd: parseFloat(user.bonus_usd) + bonusUSD,
                    updated_at: new Date()
                })
                .eq('telegram_id', uid);
            await ctx.reply(`✅ Depósito de <b>${amountCUP} CUP</b> confirmado.\n🎁 Bonus añadido: +${bonusUSD} USD (no retirable).`);
        }

        delete session.awaitingDepositAmount;
        delete session.depositMethod;
        return;
    }

    // ----- Retiro: cuenta -----
    if (session.awaitingWithdrawAccount) {
        const account = text;
        const amount = parseFloat(ctx.dbUser.usd);
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
                `📤 <b>Nueva solicitud de RETIRO</b>\n👤 Usuario: ${ctx.from.first_name} (${uid})\n💰 Monto: ${amount} USD\n🏦 Método: ${method.name}\n📞 Cuenta: ${account}\n🆔 Solicitud: ${request.id}`,
                {
                    parse_mode: 'HTML',
                    reply_markup: Markup.inlineKeyboard([
                        [Markup.button.callback('✅ Aprobar', `approve_withdraw_${request.id}`),
                         Markup.button.callback('❌ Rechazar', `reject_withdraw_${request.id}`)]
                    ]).reply_markup
                }
            );
            await ctx.reply(`✅ <b>Solicitud de retiro enviada</b>\n💰 Monto: ${amount} USD\n⏳ Procesaremos tu solicitud a la mayor brevedad.`);
        }

        delete session.awaitingWithdrawAccount;
        delete session.withdrawMethod;
        return;
    }

    // ----- Transferencia: destino -----
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
        await ctx.reply(`Ahora envía el <b>monto en USD</b> a transferir:\n💰 Tu saldo: ${parseFloat(ctx.dbUser.usd).toFixed(2)} USD`);
        return;
    }

    // ----- Transferencia: monto -----
    if (session.awaitingTransferAmount) {
        const amount = parseFloat(text.replace(',', '.'));
        if (isNaN(amount) || amount <= 0) {
            await ctx.reply('❌ Monto inválido.');
            return;
        }
        if (parseFloat(ctx.dbUser.usd) < amount) {
            await ctx.reply('❌ Saldo insuficiente.');
            return;
        }

        const targetId = session.transferTarget;
        await supabase
            .from('users')
            .update({ usd: parseFloat(ctx.dbUser.usd) - amount, updated_at: new Date() })
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

        await ctx.reply(`✅ Transferencia realizada: ${amount.toFixed(2)} USD a ${targetId}.`);
        delete session.transferTarget;
        delete session.awaitingTransferAmount;
        return;
    }

    // ----- Apuestas -----
    if (session.awaitingBet) {
        const betType = session.betType;
        const lottery = session.lottery || 'Florida';
        const { ok, usdCost, cupCost } = await parseBetCost(text, betType);

        if (!ok) {
            await ctx.reply('❌ Formato de jugada no reconocido.');
            return;
        }

        const user = ctx.dbUser;
        let newUsd = parseFloat(user.usd);
        let newBonus = parseFloat(user.bonus_usd);
        let newCup = parseFloat(user.cup);

        if (usdCost > 0) {
            const totalUSD = newUsd + newBonus;
            if (totalUSD < usdCost) {
                await ctx.reply('❌ Saldo USD insuficiente (incluyendo bono).');
                return;
            }
            const useBonus = Math.min(newBonus, usdCost);
            newBonus -= useBonus;
            newUsd -= (usdCost - useBonus);
        } else if (cupCost > 0) {
            if (newCup < cupCost) {
                await ctx.reply('❌ Saldo CUP insuficiente.');
                return;
            }
            newCup -= cupCost;
        }

        await supabase
            .from('users')
            .update({ usd: newUsd, bonus_usd: newBonus, cup: newCup, updated_at: new Date() })
            .eq('telegram_id', uid);

        await supabase.from('bets').insert({
            user_id: uid,
            lottery,
            bet_type: betType,
            raw_text: text,
            cost_usd: usdCost,
            cost_cup: cupCost,
            placed_at: new Date()
        });

        await ctx.replyWithHTML(
            `✅ <b>Jugada registrada</b>\n🎰 ${lottery} - ${betType}\n📝 <code>${text}</code>\n💰 Costo: ${usdCost.toFixed(2)} USD / ${cupCost.toFixed(2)} CUP\n🍀 ¡Buena suerte!`
        );

        delete session.awaitingBet;
        delete session.betType;
        delete session.lottery;
        return;
    }

    // Si nada coincide, sugerir menú
    await ctx.reply('No entendí ese mensaje. Por favor usa los botones del menú.',
        Markup.inlineKeyboard([[Markup.button.callback('📋 Menú principal', 'main')]])
    );
});

// ========== APROBACIÓN/RECHAZO DE RETIROS (desde canal) ==========
bot.action(/approve_withdraw_(\d+)/, async (ctx) => {
    if (ctx.from.id !== ADMIN_ID) {
        await ctx.answerCbQuery('No autorizado', { show_alert: true });
        return;
    }
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
});

bot.action(/reject_withdraw_(\d+)/, async (ctx) => {
    if (ctx.from.id !== ADMIN_ID) return;
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
});

// ========== CIERRE AUTOMÁTICO DE SESIONES DE LOTERÍA ==========
async function closeExpiredSessions() {
    try {
        const now = new Date().toISOString();
        const { data: expiredSessions, error } = await supabase
            .from('lottery_sessions')
            .select('*')
            .eq('status', 'open')
            .lt('end_time', now);

        if (error) {
            console.error('Error al obtener sesiones expiradas:', error);
            return;
        }

        if (!expiredSessions || expiredSessions.length === 0) return;

        for (const session of expiredSessions) {
            await supabase
                .from('lottery_sessions')
                .update({ status: 'closed', updated_at: new Date() })
                .eq('id', session.id);

            // Notificar a usuarios que apostaron en esta sesión
            const { data: bets } = await supabase
                .from('bets')
                .select('user_id')
                .eq('lottery', session.lottery)
                .gte('placed_at', `${session.date}T00:00:00`)
                .lte('placed_at', `${session.date}T23:59:59`);

            const notified = new Set();
            for (const bet of bets || []) {
                if (!notified.has(bet.user_id)) {
                    await bot.telegram.sendMessage(bet.user_id,
                        `⏰ <b>Sesión de ${session.lottery} (${session.date} - ${session.time_slot}) cerrada</b>\n\nEl tiempo para apostar ha terminado. Pronto se publicarán los números ganadores y los resultados.`,
                        { parse_mode: 'HTML' }
                    );
                    notified.add(bet.user_id);
                }
            }
            console.log(`Sesión ${session.id} cerrada automáticamente.`);
        }
    } catch (e) {
        console.error('Error en closeExpiredSessions:', e);
    }
}

async function notifyUsersOfWinningNumbers(session, numbers) {
    try {
        const { data: bets } = await supabase
            .from('bets')
            .select('user_id')
            .eq('lottery', session.lottery)
            .gte('placed_at', `${session.date}T00:00:00`)
            .lte('placed_at', `${session.date}T23:59:59`);

        const notified = new Set();
        for (const bet of bets || []) {
            if (!notified.has(bet.user_id)) {
                await bot.telegram.sendMessage(bet.user_id,
                    `🔢 <b>Números ganadores de ${session.lottery} (${session.date} - ${session.time_slot})</b>\n\n${numbers.join(', ')}\n\nRevisa tus jugadas. ¡Pronto se acreditarán los premios!`,
                    { parse_mode: 'HTML' }
                );
                notified.add(bet.user_id);
            }
        }
    } catch (e) {
        console.error('Error notifying winning numbers:', e);
    }
}

// Programar tarea cada minuto
cron.schedule('* * * * *', () => {
    closeExpiredSessions();
}, {
    timezone: TIMEZONE
});

// ========== EXPORTAR BOT ==========
module.exports = bot;
