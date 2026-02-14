// ==============================
// bot.js - Bot de Telegram para Rifas Cuba
// Versión con teclado de respuesta funcional y botón WebApp
// Mejoras: horario retiros, bono no retirable, mensajes más atentos
// Funcionalidades: editar/eliminar métodos de pago
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
const BONUS_CUP_DEFAULT = parseFloat(process.env.BONUS_CUP_DEFAULT) || 70;
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

function parseAmount(text) {
    const lower = text.toLowerCase().replace(',', '.').trim();
    let usd = 0, cup = 0;
    const usdMatch = lower.match(/(\d+(?:\.\d+)?)\s*usd/);
    const cupMatch = lower.match(/(\d+(?:\.\d+)?)\s*cup/);
    if (usdMatch) usd = parseFloat(usdMatch[1]);
    if (cupMatch) cup = parseFloat(cupMatch[1]);
    return { usd, cup };
}

function parseBetLine(line, betType) {
    line = line.trim().toLowerCase();
    if (!line) return [];

    const match = line.match(/^([\d\s,]+)\s*(?:con|\*)\s*([0-9.]+)\s*(usd|cup)?$/);
    if (!match) return [];

    let numerosStr = match[1].trim();
    const montoStr = match[2];
    const moneda = match[3] || 'usd';

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
            usd: moneda === 'usd' ? montoReal : 0,
            cup: moneda === 'cup' ? montoReal : 0
        });
    }

    return resultados;
}

function parseBetMessage(text, betType) {
    const lines = text.split('\n').map(l => l.trim()).filter(l => l);
    const items = [];
    let totalUSD = 0, totalCUP = 0;

    for (const line of lines) {
        const parsedItems = parseBetLine(line, betType);
        for (const item of parsedItems) {
            items.push(item);
            totalUSD += item.usd;
            totalCUP += item.cup;
        }
    }

    return {
        items,
        totalUSD,
        totalCUP,
        ok: items.length > 0
    };
}

// ========== FUNCIÓN CORREGIDA ==========
function getEndTimeFromSlot(lottery, timeSlot) {
    const schedule = getAllowedHours(lottery);
    if (!schedule) return null;
    const slot = schedule.slots.find(s => s.name === timeSlot);
    if (!slot) return null;
    
    const now = moment.tz(TIMEZONE);
    const today = now.format('YYYY-MM-DD');
    
    // Crear la hora de cierre para HOY a la hora específica del slot
    let hour = Math.floor(slot.end);
    let minute = (slot.end % 1) * 60;
    
    // Crear el momento de cierre para hoy a esa hora
    const endTime = moment.tz(`${today} ${hour}:${minute}:00`, 'YYYY-MM-DD HH:mm:ss', TIMEZONE);
    
    // Si la hora de cierre ya pasó hoy, devolver null (no se puede abrir)
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
        [Markup.button.callback('💰 Configurar tasa USD/CUP', 'adm_set_rate')],
        [Markup.button.callback('🎲 Configurar precios y pagos', 'adm_set_prices')],
        [Markup.button.callback('💰 Mínimos por jugada', 'adm_min_per_bet')],
        [Markup.button.callback('💰 Mínimo depósito', 'adm_min_deposit')],
        [Markup.button.callback('💰 Mínimo retiro', 'adm_min_withdraw')],
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
                { name: '☀️ Tarde',  start: 15, end: 22 }
            ]
        }
    };
    return schedules[lotteryKey];
}

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
        `👋 ¡Hola, ${escapeHTML(firstName)}! Bienvenido de nuevo a Rifas Cuba, tu asistente de la suerte 🍀\n\n` +
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
    const text = `💰 <b>Tu saldo actual es:</b>\n\n` +
        `🇨🇺 <b>CUP:</b> ${parseFloat(user.cup).toFixed(2)}\n` +
        `💵 <b>USD:</b> ${parseFloat(user.usd).toFixed(2)}\n` +
        `🎁 <b>Bono (no retirable, solo para jugar):</b> ${parseFloat(user.bonus_usd).toFixed(2)} USD\n\n` +
        `¿Qué deseas hacer con tu dinero?`;
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
            text += `<b>${i + 1}.</b> 🎰 ${escapeHTML(b.lottery)} - ${escapeHTML(b.bet_type)}\n` +
                `   📝 <code>${escapeHTML(b.raw_text)}</code>\n` +
                `   💰 ${b.cost_usd} USD / ${b.cost_cup} CUP\n` +
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
        const schedule = getAllowedHours(lotteryKey);
        const lotteryName = schedule.name;

        console.log(`Jugador ${ctx.from.id} seleccionó lotería ${lotteryName}`);

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
                `<b>Formato:</b> <code>12 con 5 usd</code>  o  <code>09 10 34*2cup</code>\n` +
                `También puedes usar <b>D</b> (decena) o <b>T</b> (terminal):\n` +
                `- <code>D2 con 5 usd</code> significa TODOS los números que empiezan con 2 (20-29). El costo se multiplica por 10.\n` +
                `- <code>T5 con 1 cup</code> significa TODOS los números que terminan con 5 (05,15,...,95). El costo se multiplica por 10.\n\n` +
                `Ejemplos:\n12 con 1 usd\n09 10 34 con 50 cup\nD2 con 5 usd\nT5*1cup\n34*2 usd\n\n` +
                `💭 <b>Escribe tus jugadas (una o varias líneas):</b>`;
            break;
        case 'corridos':
            instructions = `🏃 <b>CORRIDOS</b> - 🎰 ${escapeHTML(lottery)}\n\n` +
                priceInfo +
                `Escribe una línea por cada número de 2 DÍGITOS, o varios separados.\n` +
                `<b>Formato:</b> <code>17 con 1 usd</code>  o  <code>32 33*0.5usd</code>\n\n` +
                `Ejemplo:\n17 con 1 usd\n32 33*0.5 usd\n62 con 10 cup\n\n` +
                `💭 <b>Escribe tus jugadas:</b>`;
            break;
        case 'centena':
            instructions = `💯 <b>CENTENA</b> - 🎰 ${escapeHTML(lottery)}\n\n` +
                priceInfo +
                `Escribe una línea por cada número de 3 DÍGITOS, o varios separados.\n` +
                `<b>Formato:</b> <code>517 con 2 usd</code>  o  <code>019 123*1usd</code>\n\n` +
                `Ejemplo:\n517 con 2 usd\n019 123*1 usd\n123 con 5 cup\n\n` +
                `💭 <b>Escribe tus jugadas:</b>`;
            break;
        case 'parle':
            instructions = `🔒 <b>PARLE</b> - 🎰 ${escapeHTML(lottery)}\n\n` +
                priceInfo +
                `Escribe una línea por cada combinación de dos números de 2 dígitos separados por "x".\n` +
                `<b>Formato:</b> <code>17x32 con 1 usd</code>  o  <code>17x62*2usd</code>\n\n` +
                `Ejemplo:\n17x32 con 1 usd\n17x62*2 usd\n32x62 con 5 cup\n\n` +
                `💭 <b>Escribe tus parles:</b>`;
            break;
    }
    await safeEdit(ctx, instructions, null);
});

bot.action('my_money', async (ctx) => {
    const user = ctx.dbUser;
    const text = `💰 <b>Tu saldo actual es:</b>\n\n` +
        `🇨🇺 <b>CUP:</b> ${parseFloat(user.cup).toFixed(2)}\n` +
        `💵 <b>USD:</b> ${parseFloat(user.usd).toFixed(2)}\n` +
        `🎁 <b>Bono (no retirable, solo para jugar):</b> ${parseFloat(user.bonus_usd).toFixed(2)} USD\n\n` +
        `¿Qué te gustaría hacer?`;
    await safeEdit(ctx, text, myMoneyKbd());
});

bot.action('recharge', async (ctx) => {
    const minDeposit = await getMinDepositUSD();
    const { data: methods } = await supabase
        .from('deposit_methods')
        .select('*')
        .order('id', { ascending: true });

    if (!methods || methods.length === 0) {
        await ctx.answerCbQuery('❌ Por el momento no hay métodos de depósito disponibles. Intenta más tarde.', { show_alert: true });
        return;
    }

    const buttons = methods.map(m => [Markup.button.callback(m.name, `dep_${m.id}`)]);
    buttons.push([Markup.button.callback('◀ Volver', 'my_money')]);

    const rate = await getExchangeRate();
    await safeEdit(ctx,
        `💵 <b>Recargar saldo</b>\n\n` +
        `Elige un método de pago. Luego deberás enviar una captura de pantalla de la transferencia realizada.\n\n` +
        `<b>Mínimo de depósito:</b> ${minDeposit} USD\n` +
        `<b>Tasa de cambio:</b> 1 USD = ${rate} CUP\n\n` +
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

    await safeEdit(ctx,
        `🧾 <b>${escapeHTML(method.name)}</b>\n` +
        `Número: <code>${escapeHTML(method.card)}</code>\n` +
        `Confirmar: <code>${escapeHTML(method.confirm)}</code>\n\n` +
        `📸 <b>Ahora, por favor, envía una captura de pantalla de la transferencia que realizaste.</b>\n` +
        `(Asegúrate de que se vea claramente el monto y la referencia)`,
        null
    );
});

bot.action('withdraw', async (ctx) => {
    // Verificar horario de retiro
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
    const minWithdraw = await getMinWithdrawUSD();
    if (parseFloat(user.usd) < minWithdraw) {
        await ctx.answerCbQuery(`❌ Necesitas al menos ${minWithdraw} USD en tu saldo USD para solicitar un retiro.`, { show_alert: true });
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

    const buttons = methods.map(m => [Markup.button.callback(m.name, `wit_${m.id}`)]);
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
    ctx.session.awaitingWithdrawAccount = true;

    const user = ctx.dbUser;
    await safeEdit(ctx,
        `Has elegido <b>${escapeHTML(method.name)}</b>.\n\n` +
        `💰 <b>Tu saldo disponible para retirar:</b> ${parseFloat(user.usd).toFixed(2)} USD\n` +
        `(Recuerda que el bono no es retirable).\n\n` +
        `Por favor, escribe el <b>número o datos de la cuenta</b> a la que deseas que enviemos el retiro:`,
        null
    );
});

bot.action('transfer', async (ctx) => {
    ctx.session.awaitingTransferTarget = true;
    await safeEdit(ctx,
        '🔄 <b>Transferir saldo a otro usuario</b>\n\n' +
        'Envía el <b>ID de Telegram</b> del usuario al que deseas transferir (ejemplo: 123456789).\n\n' +
        'Puedes obtener el ID de Telegram de tu amigo si te lo proporciona o usando bots como @userinfobot.',
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
                `   💰 ${b.cost_usd} USD / ${b.cost_cup} CUP\n` +
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

bot.action('admin_panel', async (ctx) => {
    if (!isAdmin(ctx.from.id)) {
        await ctx.answerCbQuery('⛔ No autorizado. Solo administradores.', { show_alert: true });
        return;
    }
    await safeEdit(ctx, '🔧 <b>Panel de administración</b>\nSelecciona una opción:', adminPanelKbd());
});

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

        const schedule = getAllowedHours(lottery.toLowerCase().replace(' ', ''));
        if (!schedule) {
            await ctx.answerCbQuery('❌ Región no válida', { show_alert: true });
            return;
        }

        let text = `🎰 <b>${lottery}</b>\n📅 ${today}\n\n`;
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
        const lotteryKey = lottery.toLowerCase().replace(' ', '');
        const endTime = getEndTimeFromSlot(lotteryKey, timeSlot);
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

        if (newStatus === 'closed') {
            await broadcastToAllUsers(
                `🔴 <b>SESIÓN CERRADA</b>\n\n` +
                `🎰 <b>${escapeHTML(session.lottery)}</b> - Turno <b>${escapeHTML(session.time_slot)}</b>\n` +
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

// ========== ADMIN: AÑADIR MÉTODOS ==========
bot.action('adm_add_dep', async (ctx) => {
    if (!isAdmin(ctx.from.id)) return;
    ctx.session.adminAction = 'add_dep';
    ctx.session.adminStep = 1;
    await ctx.reply('➕ <b>Añadir nuevo método de DEPÓSITO</b>\n\nPaso 1/3: Escribe el <b>nombre</b> del método (ej: Tarjeta Banco Metropolitano):', { parse_mode: 'HTML' });
    await ctx.answerCbQuery();
});

bot.action('adm_add_wit', async (ctx) => {
    if (!isAdmin(ctx.from.id)) return;
    ctx.session.adminAction = 'add_wit';
    ctx.session.adminStep = 1;
    await ctx.reply('➕ <b>Añadir nuevo método de RETIRO</b>\n\nPaso 1/3: Escribe el <b>nombre</b> del método (ej: Transfermovil):', { parse_mode: 'HTML' });
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
    const buttons = methods.map(m => [Markup.button.callback(`${m.name} (ID: ${m.id})`, `edit_dep_${m.id}`)]);
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
    const buttons = methods.map(m => [Markup.button.callback(`${m.name} (ID: ${m.id})`, `edit_wit_${m.id}`)]);
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
    const buttons = methods.map(m => [Markup.button.callback(`${m.name} (ID: ${m.id})`, `delete_dep_${m.id}`)]);
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
    const buttons = methods.map(m => [Markup.button.callback(`${m.name} (ID: ${m.id})`, `delete_wit_${m.id}`)]);
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
        [Markup.button.callback('✏️ Número/Cuenta', 'edit_field_card')],
        [Markup.button.callback('✏️ Número a confirmar', 'edit_field_confirm')],
        [Markup.button.callback('◀ Cancelar', 'admin_panel')]
    ];
    await ctx.reply(
        `✏️ Editando método <b>${escapeHTML(method.name)}</b> (ID: ${methodId})\n\n` +
        `Valores actuales:\n` +
        `📛 Nombre: ${escapeHTML(method.name)}\n` +
        `💳 Número: ${escapeHTML(method.card)}\n` +
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
        [Markup.button.callback('✏️ Número/Cuenta', 'edit_field_card')],
        [Markup.button.callback('✏️ Número a confirmar', 'edit_field_confirm')],
        [Markup.button.callback('◀ Cancelar', 'admin_panel')]
    ];
    await ctx.reply(
        `✏️ Editando método <b>${escapeHTML(method.name)}</b> (ID: ${methodId})\n\n` +
        `Valores actuales:\n` +
        `📛 Nombre: ${escapeHTML(method.name)}\n` +
        `💳 Número: ${escapeHTML(method.card)}\n` +
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

bot.action('edit_field_card', async (ctx) => {
    ctx.session.editField = 'card';
    ctx.session.adminAction = 'edit_method';
    ctx.session.editStep = 'awaiting_value';
    await ctx.reply('✏️ Envía el <b>nuevo número/cuenta</b>:');
    await ctx.answerCbQuery();
});

bot.action('edit_field_confirm', async (ctx) => {
    ctx.session.editField = 'confirm';
    ctx.session.adminAction = 'edit_method';
    ctx.session.editStep = 'awaiting_value';
    await ctx.reply('✏️ Envía el <b>nuevo número a confirmar</b> (o "ninguno"):');
    await ctx.answerCbQuery();
});

// ========== ADMIN: CONFIRMACIÓN PARA ELIMINAR ==========
bot.action(/delete_dep_(\d+)/, async (ctx) => {
    if (!isAdmin(ctx.from.id)) return;
    const methodId = parseInt(ctx.match[1]);
    ctx.session.deleteMethodId = methodId;
    ctx.session.deleteMethodType = 'deposit';
    const buttons = [
        [Markup.button.callback('✅ Sí, eliminar', `confirm_delete_dep_${methodId}`)],
        [Markup.button.callback('❌ Cancelar', 'admin_panel')]
    ];
    await ctx.reply('⚠️ ¿Estás seguro de que deseas eliminar este método de DEPÓSITO?', Markup.inlineKeyboard(buttons));
    await ctx.answerCbQuery();
});

bot.action(/delete_wit_(\d+)/, async (ctx) => {
    if (!isAdmin(ctx.from.id)) return;
    const methodId = parseInt(ctx.match[1]);
    ctx.session.deleteMethodId = methodId;
    ctx.session.deleteMethodType = 'withdraw';
    const buttons = [
        [Markup.button.callback('✅ Sí, eliminar', `confirm_delete_wit_${methodId}`)],
        [Markup.button.callback('❌ Cancelar', 'admin_panel')]
    ];
    await ctx.reply('⚠️ ¿Estás seguro de que deseas eliminar este método de RETIRO?', Markup.inlineKeyboard(buttons));
    await ctx.answerCbQuery();
});

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

// ========== ADMIN: OTRAS ACCIONES (tasa, mínimos, precios, etc.) ==========
bot.action('adm_set_rate', async (ctx) => {
    if (!isAdmin(ctx.from.id)) return;
    const rate = await getExchangeRate();
    ctx.session.adminAction = 'set_rate';
    await ctx.reply(`💰 <b>Tasa de cambio actual:</b> 1 USD = ${rate} CUP\n\nEnvía la <b>nueva tasa</b> (solo número, ej: 120):`, { parse_mode: 'HTML' });
    await ctx.answerCbQuery();
});

bot.action('adm_min_deposit', async (ctx) => {
    if (!isAdmin(ctx.from.id)) return;
    const current = await getMinDepositUSD();
    ctx.session.adminAction = 'set_min_deposit';
    await ctx.reply(`💰 <b>Mínimo de depósito actual:</b> ${current} USD\n\nEnvía el nuevo mínimo (solo número, ej: 5):`, { parse_mode: 'HTML' });
    await ctx.answerCbQuery();
});

bot.action('adm_min_withdraw', async (ctx) => {
    if (!isAdmin(ctx.from.id)) return;
    const current = await getMinWithdrawUSD();
    ctx.session.adminAction = 'set_min_withdraw';
    await ctx.reply(`💰 <b>Mínimo de retiro actual:</b> ${current} USD\n\nEnvía el nuevo mínimo (solo número, ej: 2):`, { parse_mode: 'HTML' });
    await ctx.answerCbQuery();
});

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

bot.action('adm_view', async (ctx) => {
    if (!isAdmin(ctx.from.id)) return;
    const rate = await getExchangeRate();
    const minDep = await getMinDepositUSD();
    const minWit = await getMinWithdrawUSD();
    const { data: depMethods } = await supabase.from('deposit_methods').select('*');
    const { data: witMethods } = await supabase.from('withdraw_methods').select('*');
    const { data: prices } = await supabase.from('play_prices').select('*');

    let text = `💰 <b>Tasa de cambio:</b> 1 USD = ${rate} CUP\n`;
    text += `📥 <b>Mínimo depósito:</b> ${minDep} USD\n`;
    text += `📤 <b>Mínimo retiro:</b> ${minWit} USD\n\n`;
    text += `📥 <b>Métodos de DEPÓSITO:</b>\n`;
    depMethods?.forEach(m => text += `  ID ${m.id}: ${escapeHTML(m.name)} - ${escapeHTML(m.card)} / ${escapeHTML(m.confirm)}\n`);
    text += `\n📤 <b>Métodos de RETIRO:</b>\n`;
    witMethods?.forEach(m => text += `  ID ${m.id}: ${escapeHTML(m.name)} - ${escapeHTML(m.card)} / ${escapeHTML(m.confirm)}\n`);
    text += `\n🎲 <b>Precios por jugada (globales):</b>\n`;
    prices?.forEach(p => text += `  ${p.bet_type}: ${p.amount_cup} CUP / ${p.amount_usd} USD  (paga x${p.payout_multiplier || 0})  (mín: ${p.min_cup||0} CUP / ${p.min_usd||0} USD)\n`);

    await safeEdit(ctx, text, Markup.inlineKeyboard([[Markup.button.callback('◀ Volver a Admin', 'admin_panel')]]));
});

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

    const buttons = availableSessions.map(s =>
        [Markup.button.callback(
            `${s.lottery} - ${s.date} (${s.time_slot})`,
            `publish_win_${s.id}`
        )]
    );
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

    const rate = await getExchangeRate();

    for (const bet of bets || []) {
        const { data: userBefore } = await supabase
            .from('users')
            .select('usd, cup, bonus_usd')
            .eq('telegram_id', bet.user_id)
            .single();

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
            let newUsd = parseFloat(userBefore.usd);
            let newCup = parseFloat(userBefore.cup);
            if (premioTotalUSD > 0) newUsd += premioTotalUSD;
            if (premioTotalCUP > 0) newCup += premioTotalCUP;

            await supabase
                .from('users')
                .update({ usd: newUsd, cup: newCup, updated_at: new Date() })
                .eq('telegram_id', bet.user_id);

            const usdEquivalentCup = (premioTotalUSD * rate).toFixed(2);
            const cupEquivalentUsd = (premioTotalCUP / rate).toFixed(2);
            await bot.telegram.sendMessage(bet.user_id,
                `🎉 <b>¡FELICIDADES! Has ganado</b>\n\n` +
                `🔢 Número ganador: <code>${winningStr}</code>\n` +
                `🎰 ${escapeHTML(session.lottery)} - ${escapeHTML(session.time_slot)}\n` +
                `💰 Premio: ${premioTotalUSD.toFixed(2)} USD / ${premioTotalCUP.toFixed(2)} CUP\n` +
                (premioTotalUSD > 0 ? `   (equivale a ${usdEquivalentCup} CUP aprox.)\n` : '') +
                (premioTotalCUP > 0 ? `   (equivale a ${cupEquivalentUsd} USD aprox.)\n` : '') +
                `\n📊 <b>Saldo anterior:</b> ${parseFloat(userBefore.usd).toFixed(2)} USD / ${parseFloat(userBefore.cup).toFixed(2)} CUP\n` +
                `📊 <b>Saldo actual:</b> ${newUsd.toFixed(2)} USD / ${newCup.toFixed(2)} CUP\n\n` +
                `✅ El premio ya fue acreditado a tu saldo. ¡Sigue disfrutando!`,
                { parse_mode: 'HTML' }
            );
        } else {
            await bot.telegram.sendMessage(bet.user_id,
                `🔢 <b>Números ganadores de ${escapeHTML(session.lottery)} (${session.date} - ${escapeHTML(session.time_slot)})</b>\n\n` +
                `Número: <code>${winningStr}</code>\n\n` +
                `😔 Esta vez no has ganado, pero no te desanimes. ¡Sigue intentando y la suerte llegará!\n\n` +
                `📊 <b>Tu saldo actual:</b> ${parseFloat(userBefore.usd).toFixed(2)} USD / ${parseFloat(userBefore.cup).toFixed(2)} CUP\n\n` +
                `🍀 ¡Mucha suerte en la próxima!`,
                { parse_mode: 'HTML' }
            );
        }
    }

    await broadcastToAllUsers(
        `📢 <b>NÚMERO GANADOR PUBLICADO</b>\n\n` +
        `🎰 <b>${escapeHTML(session.lottery)}</b> - Turno <b>${escapeHTML(session.time_slot)}</b>\n` +
        `📅 Fecha: ${session.date}\n` +
        `🔢 Número: <code>${winningStr}</code>\n\n` +
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

    const mainButtons = ['🎲 Jugar', '💰 Mi dinero', '📋 Mis jugadas', '👥 Referidos', '❓ Cómo jugar', '🌐 Abrir WebApp', '🔧 Admin'];
    if (mainButtons.includes(text)) {
        if (text === '🎲 Jugar') {
            await safeEdit(ctx, '🎲 Por favor, selecciona una lotería para comenzar a jugar:', playLotteryKbd());
            return;
        } else if (text === '💰 Mi dinero') {
            const user = ctx.dbUser;
            const text = `💰 <b>Tu saldo actual es:</b>\n\n` +
                `🇨🇺 <b>CUP:</b> ${parseFloat(user.cup).toFixed(2)}\n` +
                `💵 <b>USD:</b> ${parseFloat(user.usd).toFixed(2)}\n` +
                `🎁 <b>Bono (no retirable, solo para jugar):</b> ${parseFloat(user.bonus_usd).toFixed(2)} USD\n\n` +
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
                        `   💰 ${b.cost_usd} USD / ${b.cost_cup} CUP\n` +
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
        return;
    }

    // ========== ADMIN: FLUJOS DE AÑADIR, TASA, MÍNIMOS, PRECIOS, GANADORES ==========
    if (isAdmin(uid) && session.adminAction) {
        if (session.adminAction === 'add_dep') {
            if (session.adminStep === 1) {
                session.adminTempName = text;
                session.adminStep = 2;
                await ctx.reply('Paso 2/3: Ahora envía el <b>número de la tarjeta o cuenta</b> (ej: 1234 5678 9012 3456):', { parse_mode: 'HTML' });
                return;
            } else if (session.adminStep === 2) {
                session.adminTempCard = text;
                session.adminStep = 3;
                await ctx.reply('Paso 3/3: Finalmente, envía el <b>número a confirmar</b> (ej: 1234):', { parse_mode: 'HTML' });
                return;
            } else if (session.adminStep === 3) {
                const { data, error } = await supabase
                    .from('deposit_methods')
                    .insert({ name: session.adminTempName, card: session.adminTempCard, confirm: text })
                    .select()
                    .single();
                if (error) await ctx.reply(`❌ Error al añadir: ${error.message}`);
                else await ctx.reply(`✅ Método de depósito <b>${escapeHTML(session.adminTempName)}</b> añadido correctamente con ID ${data.id}.`, { parse_mode: 'HTML' });
                delete session.adminAction;
                return;
            }
        }

        if (session.adminAction === 'add_wit') {
            if (session.adminStep === 1) {
                session.adminTempName = text;
                session.adminStep = 2;
                await ctx.reply('Paso 2/3: Ahora envía el <b>número o instrucciones para retirar</b> (ej: 1234 5678 9012 3456):', { parse_mode: 'HTML' });
                return;
            } else if (session.adminStep === 2) {
                session.adminTempCard = text;
                session.adminStep = 3;
                await ctx.reply('Paso 3/3: Finalmente, envía el <b>número a confirmar</b> (o escribe "ninguno" si no aplica):', { parse_mode: 'HTML' });
                return;
            } else if (session.adminStep === 3) {
                const { data, error } = await supabase
                    .from('withdraw_methods')
                    .insert({ name: session.adminTempName, card: session.adminTempCard, confirm: text })
                    .select()
                    .single();
                if (error) await ctx.reply(`❌ Error al añadir: ${error.message}`);
                else await ctx.reply(`✅ Método de retiro <b>${escapeHTML(session.adminTempName)}</b> añadido correctamente con ID ${data.id}.`, { parse_mode: 'HTML' });
                delete session.adminAction;
                return;
            }
        }

        if (session.adminAction === 'set_rate') {
            const rate = parseFloat(text.replace(',', '.'));
            if (isNaN(rate) || rate <= 0) {
                await ctx.reply('❌ Número inválido. Por favor, envía un número positivo (ej: 120).');
                return;
            }
            await supabase.from('exchange_rate').update({ rate, updated_at: new Date() }).eq('id', 1);
            await ctx.reply(`✅ Tasa actualizada correctamente: 1 USD = ${rate} CUP`, { parse_mode: 'HTML' });
            delete session.adminAction;
            return;
        }

        if (session.adminAction === 'set_min_deposit') {
            const value = parseFloat(text.replace(',', '.'));
            if (isNaN(value) || value <= 0) {
                await ctx.reply('❌ Número inválido. Envía un número positivo (ej: 5).');
                return;
            }
            await setMinDepositUSD(value);
            await ctx.reply(`✅ Mínimo de depósito actualizado a: ${value} USD`, { parse_mode: 'HTML' });
            delete session.adminAction;
            return;
        }

        if (session.adminAction === 'set_min_withdraw') {
            const value = parseFloat(text.replace(',', '.'));
            if (isNaN(value) || value <= 0) {
                await ctx.reply('❌ Número inválido. Envía un número positivo (ej: 2).');
                return;
            }
            await setMinWithdrawUSD(value);
            await ctx.reply(`✅ Mínimo de retiro actualizado a: ${value} USD`, { parse_mode: 'HTML' });
            delete session.adminAction;
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
                return;
            }
        }

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

    // ========== FLUJOS DE USUARIO (DEPÓSITO, RETIRO, TRANSFERENCIA, APUESTAS) ==========
    if (session.awaitingDepositAmount) {
        const amountText = text;
        const method = session.depositMethod;
        const buffer = session.depositPhotoBuffer;
        if (!buffer) {
            await ctx.reply('❌ Error: no se encontró la captura. Por favor, comienza el proceso de recarga de nuevo.', getMainKeyboard(ctx));
            delete session.awaitingDepositAmount;
            return;
        }

        const { usd } = parseAmount(amountText);
        const minDeposit = await getMinDepositUSD();
        if (usd < minDeposit) {
            await ctx.reply(`❌ El monto mínimo de depósito es ${minDeposit} USD. Por favor, envía un monto válido.`, getMainKeyboard(ctx));
            return;
        }

        try {
            const request = await createDepositRequest(uid, method.id, buffer, amountText);
            for (const adminId of ADMIN_IDS) {
                try {
                    await bot.telegram.sendMessage(adminId,
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

    if (session.awaitingWithdrawAccount) {
        const account = text;
        const amount = parseFloat(user.usd);
        const minWithdraw = await getMinWithdrawUSD();
        if (amount < minWithdraw) {
            await ctx.reply(`❌ No tienes saldo USD suficiente para retirar. El mínimo requerido es ${minWithdraw} USD.`, getMainKeyboard(ctx));
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
            await ctx.reply(`❌ Error al crear la solicitud: ${error.message}`, getMainKeyboard(ctx));
        } else {
            for (const adminId of ADMIN_IDS) {
                try {
                    await bot.telegram.sendMessage(adminId,
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
                } catch (e) {}
            }
            await ctx.reply(`✅ <b>Solicitud de retiro enviada</b>\n💰 Monto: ${amount} USD\n⏳ Procesaremos tu solicitud a la mayor brevedad. Te avisaremos cuando esté lista.`, { parse_mode: 'HTML' });
        }

        delete session.awaitingWithdrawAccount;
        delete session.withdrawMethod;
        return;
    }

    if (session.awaitingTransferTarget) {
        const targetId = parseInt(text);
        if (isNaN(targetId)) {
            await ctx.reply('❌ ID inválido. Debe ser un número entero. Por favor, inténtalo de nuevo.', getMainKeyboard(ctx));
            return;
        }
        if (targetId === uid) {
            await ctx.reply('❌ No puedes transferirte saldo a ti mismo. Elige otro usuario.', getMainKeyboard(ctx));
            return;
        }

        const { data: targetUser } = await supabase
            .from('users')
            .select('telegram_id')
            .eq('telegram_id', targetId)
            .single();

        if (!targetUser) {
            await ctx.reply('❌ El usuario destinatario no está registrado en el bot. Asegúrate de que el ID sea correcto.', getMainKeyboard(ctx));
            return;
        }

        session.transferTarget = targetId;
        session.awaitingTransferAmount = true;
        delete session.awaitingTransferTarget;
        await ctx.reply(`Ahora envía el <b>monto en USD</b> que deseas transferir:\n💰 Tu saldo disponible: ${parseFloat(user.usd).toFixed(2)} USD`, { parse_mode: 'HTML' });
        return;
    }

    if (session.awaitingTransferAmount) {
        const amount = parseFloat(text.replace(',', '.'));
        if (isNaN(amount) || amount <= 0) {
            await ctx.reply('❌ Monto inválido. Debe ser un número positivo.', getMainKeyboard(ctx));
            return;
        }
        if (parseFloat(user.usd) < amount) {
            await ctx.reply('❌ Saldo USD insuficiente para realizar la transferencia.', getMainKeyboard(ctx));
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

        await ctx.reply(`✅ Transferencia realizada con éxito: ${amount.toFixed(2)} USD a ${targetId}.`, { parse_mode: 'HTML' });
        delete session.transferTarget;
        delete session.awaitingTransferAmount;
        return;
    }

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

        const totalUSD = parsed.totalUSD;
        const totalCUP = parsed.totalCUP;

        if (totalUSD === 0 && totalCUP === 0) {
            await ctx.reply('❌ Debes especificar un monto válido en USD o CUP.', getMainKeyboard(ctx));
            return;
        }

        const { data: priceData } = await supabase
            .from('play_prices')
            .select('min_cup, min_usd')
            .eq('bet_type', betType)
            .single();

        const minCup = priceData?.min_cup || 0;
        const minUsd = priceData?.min_usd || 0;

        for (const item of parsed.items) {
            if (item.cup > 0 && item.cup < minCup) {
                await ctx.reply(`❌ El monto mínimo para jugadas en CUP es ${minCup} CUP. Por favor, ajusta tu apuesta.`, getMainKeyboard(ctx));
                return;
            }
            if (item.usd > 0 && item.usd < minUsd) {
                await ctx.reply(`❌ El monto mínimo para jugadas en USD es ${minUsd} USD. Por favor, ajusta tu apuesta.`, getMainKeyboard(ctx));
                return;
            }
        }

        let newUsd = parseFloat(user.usd);
        let newBonus = parseFloat(user.bonus_usd);
        let newCup = parseFloat(user.cup);

        if (totalUSD > 0) {
            const totalDisponible = newUsd + newBonus;
            if (totalDisponible < totalUSD) {
                await ctx.reply('❌ Saldo USD (incluyendo bono) insuficiente para realizar esta jugada. Recarga o reduce el monto.', getMainKeyboard(ctx));
                return;
            }
            const usarBono = Math.min(newBonus, totalUSD);
            newBonus -= usarBono;
            newUsd -= (totalUSD - usarBono);
        }

        if (totalCUP > 0) {
            if (newCup < totalCUP) {
                await ctx.reply('❌ Saldo CUP insuficiente. Recarga o reduce el monto.', getMainKeyboard(ctx));
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
            await ctx.reply('❌ Error al registrar la apuesta. Por favor, intenta más tarde.', getMainKeyboard(ctx));
            return;
        }

        await ctx.replyWithHTML(
            `✅ <b>Jugada registrada exitosamente</b>\n` +
            `🎰 ${escapeHTML(lottery)} - ${escapeHTML(betType)}\n` +
            `📝 <code>${escapeHTML(text)}</code>\n` +
            `💰 Costo total: ${totalUSD.toFixed(2)} USD / ${totalCUP.toFixed(2)} CUP\n\n` +
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

        await ctx.reply('✅ Captura recibida correctamente. Ahora, por favor, envía el <b>monto transferido</b> (ej: <code>10 usd</code> o <code>500 cup</code>).', { parse_mode: 'HTML' });
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
            await ctx.answerCbQuery('Monto no válido en la solicitud', { show_alert: true });
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
            `✅ <b>Depósito aprobado</b>\nSe ha acreditado <b>${request.amount}</b> a tu saldo.\n🎁 Además, has recibido un bono adicional.\n\n¡Gracias por confiar en nosotros!`,
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
            .select('usd')
            .eq('telegram_id', request.user_id)
            .single();

        if (parseFloat(user.usd) < request.amount_usd) {
            await ctx.reply('❌ El usuario ya no tiene saldo suficiente para este retiro. Se recomienda rechazar la solicitud.');
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
            `✅ <b>Retiro aprobado</b>\nSe ha procesado tu solicitud por <b>${request.amount_usd} USD</b>.\nLos fondos serán enviados a la cuenta proporcionada en breve.`,
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

            await broadcastToAllUsers(
                `⏰ <b>SESIÓN CERRADA AUTOMÁTICAMENTE</b>\n\n` +
                `🎰 <b>${escapeHTML(session.lottery)}</b> - Turno <b>${escapeHTML(session.time_slot)}</b>\n` +
                `📅 Fecha: ${session.date}\n\n` +
                `❌ El tiempo para apostar ha finalizado.\n` +
                `🔢 Pronto se publicará el número ganador. ¡Gracias por participar y mucha suerte!`
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
            const schedule = getAllowedHours(lottery.toLowerCase().replace(' ', ''));
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
                        const endTime = getEndTimeFromSlot(lottery.toLowerCase().replace(' ', ''), slot.name);
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
                                `🎲 <b>¡SESIÓN ABIERTA AUTOMÁTICAMENTE!</b> 🎲\n\n` +
                                `✨ La región <b>${escapeHTML(lottery)}</b> ha abierto su turno de <b>${escapeHTML(slot.name)}</b>.\n` +
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

cron.schedule('* * * * *', () => {
    closeExpiredSessions();
    openScheduledSessions();
}, { timezone: TIMEZONE });

module.exports = bot;
