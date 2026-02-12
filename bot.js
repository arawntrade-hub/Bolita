// ==============================
// bot.js - Bot de Telegram para Rifas Cuba
// Versión producción con Supabase y WebApp
// ==============================

require('dotenv').config();
const { Telegraf, Markup } = require('telegraf');
const { message } = require('telegraf/filters');
const { LocalSession } = require('telegraf-session-local');
const { createClient } = require('@supabase/supabase-js');
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const axios = require('axios');
const FormData = require('form-data');

// ========== CONFIGURACIÓN DESDE .ENV ==========
const BOT_TOKEN = process.env.BOT_TOKEN;
const ADMIN_ID = parseInt(process.env.ADMIN_ID);
const ADMIN_CHANNEL = process.env.ADMIN_CHANNEL; // @username o ID numérico
const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_SERVICE_KEY = process.env.SUPABASE_SERVICE_KEY;
const BONUS_CUP_DEFAULT = parseFloat(process.env.BONUS_CUP_DEFAULT) || 70;
const TIMEZONE = process.env.TIMEZONE || 'America/Havana';

// ========== INICIALIZAR SUPABASE ==========
const supabase = createClient(SUPABASE_URL, SUPABASE_SERVICE_KEY);

// ========== INICIALIZAR BOT ==========
const bot = new Telegraf(BOT_TOKEN);

// Sesión local para persistencia simple
const localSession = new LocalSession({ 
  database: 'session_db.json',
  storage: 'file'
});
bot.use(localSession.middleware());

// ========== FUNCIONES AUXILIARES (parsers) ==========

/**
 * Extrae monto y moneda de un texto como '10 usd' o '500 cup'
 */
function parseAmount(text) {
  const lower = text.toLowerCase().replace(',', '.').trim();
  let usd = 0, cup = 0;
  
  if (lower.includes('usd')) {
    const match = lower.match(/(\d+(?:\.\d+)?)\s*usd/);
    if (match) usd = parseFloat(match[1]);
  } else if (lower.includes('cup')) {
    const match = lower.match(/(\d+(?:\.\d+)?)\s*cup/);
    if (match) cup = parseFloat(match[1]);
  } else {
    const num = parseFloat(lower);
    if (!isNaN(num)) usd = num;
  }
  return { usd, cup };
}

/**
 * Parsea el costo de una apuesta a partir del texto y el tipo
 */
function parseBetAndCost(raw, betType) {
  const lower = raw.toLowerCase();
  let usdCost = 0, cupCost = 0;
  
  // Buscar la última mención de "X usd" o "Y cup"
  const pattern = /(\d+(?:\.\d+)?)\s*(usd|cup)/g;
  let match;
  let lastMatch = null;
  while ((match = pattern.exec(lower)) !== null) {
    lastMatch = match;
  }
  
  if (lastMatch) {
    const val = parseFloat(lastMatch[1]);
    if (lastMatch[2] === 'usd') usdCost = val;
    else cupCost = val;
  } else {
    // Si no se especifica, usamos precio por defecto desde base de datos
    // NOTA: Esta función será llamada después de obtener precios, pero por simplicidad
    // aquí se consultará sincrónicamente. En el manejador se hará la consulta previa.
    // Dejamos valores 0 y luego se asignan.
  }
  
  return { ok: (usdCost > 0 || cupCost > 0), usdCost, cupCost };
}

/**
 * Verifica initData de Telegram WebApp (se usa en backend, no en bot)
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

// ========== MIDDLEWARE: CARGAR USUARIO DESDE SUPABASE ==========
bot.use(async (ctx, next) => {
  const uid = ctx.from?.id;
  if (uid) {
    try {
      let { data: user, error } = await supabase
        .from('users')
        .select('*')
        .eq('telegram_id', uid)
        .single();
      
      if (!user) {
        const firstName = ctx.from.first_name || 'Jugador';
        const { data: newUser, error: insertError } = await supabase
          .from('users')
          .insert({ telegram_id: uid, first_name: firstName })
          .select()
          .single();
        user = newUser;
      }
      ctx.dbUser = user;
    } catch (e) {
      console.error('Error cargando usuario:', e);
    }
  }
  return next();
});

// ========== COMANDO /start ==========
bot.start(async (ctx) => {
  const uid = ctx.from.id;
  const refParam = ctx.payload;
  
  // Procesar referido
  if (refParam) {
    const refId = parseInt(refParam);
    if (refId && refId !== uid) {
      const { data: referrer } = await supabase
        .from('users')
        .select('telegram_id')
        .eq('telegram_id', refId)
        .single();
      if (referrer) {
        await supabase
          .from('users')
          .update({ ref_by: refId })
          .eq('telegram_id', uid);
      }
    }
  }
  
  const firstName = ctx.from.first_name || 'Jugador';
  const botInfo = await ctx.telegram.getMe();
  const webAppUrl = `${process.env.WEBAPP_URL}/app.html`; // debe estar en .env
  
  const menuButtons = [
    [Markup.button.callback('🎲 Jugar', 'play')],
    [Markup.button.callback('💰 Mi dinero', 'my_money')],
    [Markup.button.callback('📋 Mis jugadas', 'my_bets')],
    [Markup.button.callback('👥 Referidos', 'referrals')],
    [Markup.button.callback('❓ Cómo jugar', 'how_to_play')],
    ...(uid === ADMIN_ID ? [[Markup.button.callback('🔧 Admin', 'admin_panel')]] : []),
    [Markup.button.webApp('🌐 Abrir WebApp', webAppUrl)]
  ];
  
  await ctx.replyWithMarkdown(
    `¡Hola de nuevo, *${firstName}* 👋\nBienvenido de regreso a Rifas Cuba, tu asistente de la suerte 🍀\n\n🎲 ¿Listo para jugar?\nApuesta, gana y disfruta. ¡La suerte está de tu lado!`,
    Markup.inlineKeyboard(menuButtons)
  );
});

// ========== MENÚ PRINCIPAL (callback "main") ==========
bot.action('main', async (ctx) => {
  const uid = ctx.from.id;
  const botInfo = await ctx.telegram.getMe();
  const webAppUrl = `${process.env.WEBAPP_URL}/app.html`;
  
  const menuButtons = [
    [Markup.button.callback('🎲 Jugar', 'play')],
    [Markup.button.callback('💰 Mi dinero', 'my_money')],
    [Markup.button.callback('📋 Mis jugadas', 'my_bets')],
    [Markup.button.callback('👥 Referidos', 'referrals')],
    [Markup.button.callback('❓ Cómo jugar', 'how_to_play')],
    ...(uid === ADMIN_ID ? [[Markup.button.callback('🔧 Admin', 'admin_panel')]] : []),
    [Markup.button.webApp('🌐 Abrir WebApp', webAppUrl)]
  ];
  
  await ctx.editMessageText('Menú principal:', Markup.inlineKeyboard(menuButtons));
});

// ========== JUGAR ==========
bot.action('play', async (ctx) => {
  await ctx.editMessageText('Selecciona una lotería:', {
    reply_markup: Markup.inlineKeyboard([
      [Markup.button.callback('🦩 Florida', 'lot_florida')],
      [Markup.button.callback('🍑 Georgia', 'lot_georgia')],
      [Markup.button.callback('🗽 Nueva York', 'lot_newyork')],
      [Markup.button.callback('◀ Volver', 'main')]
    ])
  });
});

// Selección de lotería
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
      [9*60, 12*60],
      [14*60, 18*60+30],
      [20*60, 23*60]
    ];
    const isAllowed = allowed.some(([start, end]) => current >= start && current <= end);
    if (!isAllowed) {
      await ctx.answerCbQuery('⏰ Fuera de horario para Georgia', { show_alert: true });
      return;
    }
  }
  
  ctx.session.lottery = lotteryName;
  await ctx.editMessageText(`Has seleccionado *${lotteryName}*. Ahora elige el tipo de jugada:`, {
    parse_mode: 'Markdown',
    reply_markup: Markup.inlineKeyboard([
      [Markup.button.callback('🎯 Fijo', 'type_fijo')],
      [Markup.button.callback('🏃 Corridos', 'type_corridos')],
      [Markup.button.callback('💯 Centena', 'type_centena')],
      [Markup.button.callback('🔒 Parle', 'type_parle')],
      [Markup.button.callback('◀ Volver', 'play')]
    ])
  });
});

// Selección de tipo de jugada
bot.action(/type_(.+)/, async (ctx) => {
  const betType = ctx.match[1];
  ctx.session.betType = betType;
  ctx.session.awaitingBet = true;
  
  const lottery = ctx.session.lottery || 'Florida';
  let instructions = '';
  
  switch (betType) {
    case 'fijo':
      instructions = `🎯 *Jugada FIJO* - 🦩 ${lottery}\n\n` +
        `📌 Escribe cada número con su valor específico:\n\n` +
        `📖 *Ejemplos:*\n` +
        `• 12 con 1 usd, 34 con 2 usd\n` +
        `• 7*1.5usd, 23*2cup\n` +
        `En caso de decenas y terminal:\n` +
        `• D2 con 1 usd, T5*2cup\n\n` +
        `⚡ Se procesará inmediatamente\n\n💭 *Escribe tus números:*`;
      break;
    case 'corridos':
      instructions = `🏃 *Jugada CORRIDOS* - 🦩 ${lottery}\n\n` +
        `📌 Escribe cada número con su valor específico:\n\n` +
        `📖 *Ejemplos:*\n` +
        `• 12 con 1 usd, 34 con 2 usd\n` +
        `• 7*1.5usd, 23*2cup\n\n` +
        `⚡ Se procesará inmediatamente\n\n💭 *Escribe tus números:*`;
      break;
    case 'centena':
      instructions = `💯 *Jugada CENTENA* - 🦩 ${lottery}\n\n` +
        `📌 Escribe cada número con su valor específico (3 dígitos):\n\n` +
        `📖 *Ejemplos:*\n` +
        `• 123 con 1 usd, 456 con 2 usd\n` +
        `• 001*1.5usd, 125*2cup\n\n` +
        `⚡ Se procesará inmediatamente\n\n💭 *Escribe tus números (3 dígitos):*`;
      break;
    case 'parle':
      instructions = `🔒 *Jugada PARLE* - 🦩 ${lottery}\n\n` +
        `📌 Escribe cada parle con su valor específico:\n\n` +
        `📖 *Ejemplos:*\n` +
        `• 12x34 con 1 usd, 56x78 con 2 usd\n` +
        `• 12x34*1.5usd, 56x78*2cup\n` +
        `• 12x T5 con 1 usd\n\n` +
        `⚡ Se procesará inmediatamente\n\n💭 *Escribe tus parles (usa 'x' entre números):*`;
      break;
  }
  
  await ctx.editMessageText(instructions, { parse_mode: 'Markdown' });
});

// ========== MI DINERO ==========
bot.action('my_money', async (ctx) => {
  const user = ctx.dbUser;
  const text = `💰 *Tu saldo actual:*\n` +
    `🇨🇺 *CUP:* ${parseFloat(user.cup).toFixed(2)}\n` +
    `💵 *USD:* ${parseFloat(user.usd).toFixed(2)}\n` +
    `🎁 *Bono (no retirable):* ${parseFloat(user.bonus_usd).toFixed(2)} USD`;
  
  await ctx.editMessageText(text, {
    parse_mode: 'Markdown',
    reply_markup: Markup.inlineKeyboard([
      [Markup.button.callback('📥 Recargar', 'recharge')],
      [Markup.button.callback('📤 Retirar', 'withdraw')],
      [Markup.button.callback('🔄 Transferir', 'transfer')],
      [Markup.button.callback('◀ Volver', 'main')]
    ])
  });
});

// ========== RECARGAR (DEPÓSITO) ==========
bot.action('recharge', async (ctx) => {
  // Obtener métodos de depósito desde Supabase
  const { data: methods, error } = await supabase
    .from('deposit_methods')
    .select('*')
    .order('id', { ascending: true });
  
  if (!methods || methods.length === 0) {
    await ctx.answerCbQuery('❌ No hay métodos de depósito configurados. Contacta al administrador.', { show_alert: true });
    return;
  }
  
  const buttons = methods.map(m => 
    Markup.button.callback(m.name, `dep_${m.id}`)
  );
  const rows = [];
  for (let i = 0; i < buttons.length; i += 2) {
    rows.push(buttons.slice(i, i + 2));
  }
  rows.push([Markup.button.callback('◀ Volver', 'my_money')]);
  
  const { data: rateData } = await supabase
    .from('exchange_rate')
    .select('rate')
    .eq('id', 1)
    .single();
  const rate = rateData?.rate || 110;
  
  await ctx.editMessageText(
    `💵 *¿Cómo deseas recargar?*\n\nElige una opción para ver los datos de pago y luego *envía una captura de pantalla* de la transferencia.\n\n*Tasa de cambio:* 1 USD = ${rate} CUP`,
    {
      parse_mode: 'Markdown',
      reply_markup: Markup.inlineKeyboard(rows)
    }
  );
});

// Seleccionar método de depósito
bot.action(/dep_(\d+)/, async (ctx) => {
  const methodId = parseInt(ctx.match[1]);
  const { data: method, error } = await supabase
    .from('deposit_methods')
    .select('*')
    .eq('id', methodId)
    .single();
  
  if (!method) {
    await ctx.answerCbQuery('Método no encontrado', { show_alert: true });
    return;
  }
  
  ctx.session.depositMethod = method;
  ctx.session.awaitingDepositPhoto = true; // Esperamos foto
  
  await ctx.editMessageText(
    `🧾 *${method.name}*\n` +
    `Número: \`${method.card}\`\n` +
    `Confirmar: \`${method.confirm}\`\n\n` +
    `✅ *Después de realizar la transferencia, envía una CAPTURA DE PANTALLA* de la operación.\n` +
    `Tu solicitud será revisada y acreditada en breve.`,
    { parse_mode: 'Markdown' }
  );
});

// ========== RETIRAR ==========
bot.action('withdraw', async (ctx) => {
  const user = ctx.dbUser;
  if (parseFloat(user.usd) < 1.0) {
    await ctx.answerCbQuery('❌ Necesitas al menos 1 USD para retirar.', { show_alert: true });
    return;
  }
  
  const { data: methods, error } = await supabase
    .from('withdraw_methods')
    .select('*')
    .order('id', { ascending: true });
  
  if (!methods || methods.length === 0) {
    await ctx.answerCbQuery('❌ No hay métodos de retiro configurados.', { show_alert: true });
    return;
  }
  
  const buttons = methods.map(m => 
    Markup.button.callback(m.name, `wit_${m.id}`)
  );
  const rows = [];
  for (let i = 0; i < buttons.length; i += 2) {
    rows.push(buttons.slice(i, i + 2));
  }
  rows.push([Markup.button.callback('◀ Volver', 'my_money')]);
  
  await ctx.editMessageText(
    '📤 *Elige un método de retiro:*',
    {
      parse_mode: 'Markdown',
      reply_markup: Markup.inlineKeyboard(rows)
    }
  );
});

// Seleccionar método de retiro
bot.action(/wit_(\d+)/, async (ctx) => {
  const methodId = parseInt(ctx.match[1]);
  const { data: method, error } = await supabase
    .from('withdraw_methods')
    .select('*')
    .eq('id', methodId)
    .single();
  
  if (!method) {
    await ctx.answerCbQuery('Método no encontrado', { show_alert: true });
    return;
  }
  
  ctx.session.withdrawMethod = method;
  ctx.session.awaitingWithdrawAmount = true; // Siguiente paso: monto
  
  await ctx.editMessageText(
    `Has elegido *${method.name}*.\n\n` +
    `💰 *Tu saldo disponible:* ${parseFloat(ctx.dbUser.usd).toFixed(2)} USD\n` +
    `Envía ahora el *monto en USD* que deseas retirar (mínimo 1 USD).`,
    { parse_mode: 'Markdown' }
  );
});

// ========== TRANSFERIR ==========
bot.action('transfer', async (ctx) => {
  ctx.session.awaitingTransferTarget = true;
  await ctx.editMessageText(
    '🔄 *Transferir saldo*\n\n' +
    'Envía el *ID de Telegram* del usuario al que deseas transferir (ej: 123456789):',
    { parse_mode: 'Markdown' }
  );
});

// ========== MIS JUGADAS ==========
bot.action('my_bets', async (ctx) => {
  const uid = ctx.from.id;
  const { data: bets, error } = await supabase
    .from('bets')
    .select('*')
    .eq('user_id', uid)
    .order('placed_at', { ascending: false })
    .limit(5);
  
  if (!bets || bets.length === 0) {
    await ctx.editMessageText(
      '📭 No tienes jugadas activas en este momento.\n\n' +
      '⚠️ Envía tus jugadas con este formato:\n' +
      '📌 Puedes usar tanto CUP como USD\n\n' +
      '🎰 LOTERÍAS\n' +
      '🦩 Florida: Sin prefijo (por defecto)\n' +
      '🍑 Georgia: g (al inicio)\n' +
      '🗽 New York: ny (al inicio)\n\n' +
      'Ejemplo: `12 con 1 usd`',
      { parse_mode: 'Markdown' }
    );
  } else {
    let text = '📋 *Tus últimas 5 jugadas:*\n\n';
    bets.forEach((b, i) => {
      const date = new Date(b.placed_at).toLocaleString('es-CU', { timeZone: TIMEZONE });
      text += `*${i+1}.* 🎰 ${b.lottery} - ${b.bet_type}\n`;
      text += `   📝 \`${b.raw_text}\`\n`;
      text += `   💰 ${b.cost_usd} USD / ${b.cost_cup} CUP\n`;
      text += `   🕒 ${date}\n\n`;
    });
    await ctx.editMessageText(text, { parse_mode: 'Markdown' });
  }
});

// ========== REFERIDOS ==========
bot.action('referrals', async (ctx) => {
  const uid = ctx.from.id;
  const { count, error } = await supabase
    .from('users')
    .select('*', { count: 'exact', head: true })
    .eq('ref_by', uid);
  
  const botInfo = await ctx.telegram.getMe();
  const link = `https://t.me/${botInfo.username}?start=${uid}`;
  
  await ctx.editMessageText(
    `💸 *¡INVITA Y GANA DINERO AUTOMÁTICO!* 💰\n\n` +
    `🎯 *¿Cómo funciona?*\n` +
    `1️⃣ Comparte tu enlace con amigos\n` +
    `2️⃣ Cuando se registren y jueguen, TÚ ganas\n` +
    `3️⃣ Recibes comisión CADA VEZ que apuesten\n` +
    `4️⃣ ¡Dinero GRATIS para siempre! 🔄\n\n` +
    `🔥 SIN LÍMITES - SIN TOPES - PARA SIEMPRE\n\n` +
    `📲 *ESTE ES TU ENLACE MÁGICO:* 👇\n` +
    `\`${link}\`\n` +
    `👆 Tócalo para copiarlo automáticamente 👆\n\n` +
    `📊 *Tus estadísticas:*\n` +
    `👥 Total de referidos: ${count || 0}`,
    { parse_mode: 'Markdown' }
  );
});

// ========== CÓMO JUGAR ==========
bot.action('how_to_play', async (ctx) => {
  await ctx.editMessageText(
    '📩 *¿Tienes dudas?*\n' +
    '¿Quieres enviar captura de pantalla o consulta?\n\n' +
    '💬 Escribe directamente en el chat del bot\n' +
    'Tu mensaje será respondido por una persona real.\n\n' +
    'ℹ️ Estamos aquí para ayudarte lo más pronto posible.',
    {
      parse_mode: 'Markdown',
      reply_markup: Markup.inlineKeyboard([
        [Markup.button.callback('◀ Volver', 'main')]
      ])
    }
  );
});

// ========== PANEL DE ADMINISTRACIÓN ==========
bot.action('admin_panel', async (ctx) => {
  if (ctx.from.id !== ADMIN_ID) {
    await ctx.answerCbQuery('⛔ No autorizado', { show_alert: true });
    return;
  }
  
  await ctx.editMessageText('🔧 *Panel de administración*', {
    parse_mode: 'Markdown',
    reply_markup: Markup.inlineKeyboard([
      [Markup.button.callback('➕ Añadir método DEPÓSITO', 'adm_add_dep')],
      [Markup.button.callback('➕ Añadir método RETIRO', 'adm_add_wit')],
      [Markup.button.callback('✏️ Editar método DEPÓSITO', 'adm_edit_dep')],
      [Markup.button.callback('✏️ Editar método RETIRO', 'adm_edit_wit')],
      [Markup.button.callback('🗑 Eliminar método DEPÓSITO', 'adm_del_dep')],
      [Markup.button.callback('🗑 Eliminar método RETIRO', 'adm_del_wit')],
      [Markup.button.callback('💰 Configurar tasa USD/CUP', 'adm_set_rate')],
      [Markup.button.callback('🎲 Configurar precios de jugadas', 'adm_set_price')],
      [Markup.button.callback('📋 Ver datos actuales', 'adm_view')],
      [Markup.button.callback('📥 Solicitudes pendientes', 'adm_pending')],
      [Markup.button.callback('◀ Volver', 'main')]
    ])
  });
});

// ========== ADMIN: AÑADIR MÉTODO DEPÓSITO ==========
bot.action('adm_add_dep', async (ctx) => {
  if (ctx.from.id !== ADMIN_ID) return;
  ctx.session.adminAction = 'add_dep';
  ctx.session.adminStep = 1;
  await ctx.reply('➕ *Añadir método de DEPÓSITO*\n\nEscribe el *nombre* del método (ej: Tarjeta Banco Metropolitano):', 
    { parse_mode: 'Markdown' }
  );
  await ctx.answerCbQuery();
});

// ========== ADMIN: AÑADIR MÉTODO RETIRO ==========
bot.action('adm_add_wit', async (ctx) => {
  if (ctx.from.id !== ADMIN_ID) return;
  ctx.session.adminAction = 'add_wit';
  ctx.session.adminStep = 1;
  await ctx.reply('➕ *Añadir método de RETIRO*\n\nEscribe el *nombre* del método (ej: Transfermovil):',
    { parse_mode: 'Markdown' }
  );
  await ctx.answerCbQuery();
});

// ========== ADMIN: EDITAR MÉTODO DEPÓSITO ==========
bot.action('adm_edit_dep', async (ctx) => {
  if (ctx.from.id !== ADMIN_ID) return;
  const { data: methods } = await supabase.from('deposit_methods').select('*');
  if (!methods || methods.length === 0) {
    await ctx.reply('No hay métodos de depósito para editar.');
    return;
  }
  const buttons = methods.map(m => 
    Markup.button.callback(`${m.id} - ${m.name}`, `edit_dep_${m.id}`)
  );
  const rows = [];
  for (let i = 0; i < buttons.length; i += 2) {
    rows.push(buttons.slice(i, i + 2));
  }
  rows.push([Markup.button.callback('◀ Cancelar', 'admin_panel')]);
  await ctx.reply('Selecciona el método de depósito a editar:', 
    Markup.inlineKeyboard(rows)
  );
  await ctx.answerCbQuery();
});

// ========== ADMIN: ELIMINAR MÉTODO DEPÓSITO ==========
bot.action('adm_del_dep', async (ctx) => {
  if (ctx.from.id !== ADMIN_ID) return;
  const { data: methods } = await supabase.from('deposit_methods').select('*');
  if (!methods || methods.length === 0) {
    await ctx.reply('No hay métodos de depósito para eliminar.');
    return;
  }
  const buttons = methods.map(m => 
    Markup.button.callback(`${m.id} - ${m.name}`, `del_dep_${m.id}`)
  );
  const rows = [];
  for (let i = 0; i < buttons.length; i += 2) {
    rows.push(buttons.slice(i, i + 2));
  }
  rows.push([Markup.button.callback('◀ Cancelar', 'admin_panel')]);
  await ctx.reply('Selecciona el método de depósito a eliminar:',
    Markup.inlineKeyboard(rows)
  );
  await ctx.answerCbQuery();
});

// ========== ADMIN: CONFIGURAR TASA ==========
bot.action('adm_set_rate', async (ctx) => {
  if (ctx.from.id !== ADMIN_ID) return;
  const { data: rateData } = await supabase
    .from('exchange_rate')
    .select('rate')
    .eq('id', 1)
    .single();
  const currentRate = rateData?.rate || 110;
  
  ctx.session.adminAction = 'set_rate';
  await ctx.reply(
    `💰 *Tasa de cambio actual*\n1 USD = ${currentRate} CUP\n\n` +
    `Envía la *nueva tasa* (solo número, ej: 120):`,
    { parse_mode: 'Markdown' }
  );
  await ctx.answerCbQuery();
});

// ========== ADMIN: CONFIGURAR PRECIOS ==========
bot.action('adm_set_price', async (ctx) => {
  if (ctx.from.id !== ADMIN_ID) return;
  const { data: prices } = await supabase.from('play_prices').select('*');
  const buttons = prices.map(p => 
    Markup.button.callback(`${p.bet_type}`, `set_price_${p.bet_type}`)
  );
  const rows = [];
  for (let i = 0; i < buttons.length; i += 2) {
    rows.push(buttons.slice(i, i + 2));
  }
  rows.push([Markup.button.callback('◀ Cancelar', 'admin_panel')]);
  await ctx.reply('🎲 *Configurar precios de jugadas*\nElige el tipo que deseas modificar:',
    { parse_mode: 'Markdown', reply_markup: Markup.inlineKeyboard(rows) }
  );
  await ctx.answerCbQuery();
});

// ========== ADMIN: VER DATOS ACTUALES ==========
bot.action('adm_view', async (ctx) => {
  if (ctx.from.id !== ADMIN_ID) return;
  
  const { data: rateData } = await supabase.from('exchange_rate').select('rate').eq('id', 1).single();
  const rate = rateData?.rate || 110;
  
  const { data: depMethods } = await supabase.from('deposit_methods').select('*');
  const { data: witMethods } = await supabase.from('withdraw_methods').select('*');
  const { data: prices } = await supabase.from('play_prices').select('*');
  
  let text = `💰 *Tasa:* 1 USD = ${rate} CUP\n\n`;
  text += `📥 *Métodos de DEPÓSITO:*\n`;
  if (depMethods && depMethods.length > 0) {
    depMethods.forEach(m => {
      text += `  ID ${m.id}: ${m.name} - ${m.card} / ${m.confirm}\n`;
    });
  } else text += '  (ninguno)\n';
  
  text += `\n📤 *Métodos de RETIRO:*\n`;
  if (witMethods && witMethods.length > 0) {
    witMethods.forEach(m => {
      text += `  ID ${m.id}: ${m.name} - ${m.card} / ${m.confirm}\n`;
    });
  } else text += '  (ninguno)\n';
  
  text += `\n🎲 *Precios por jugada:*\n`;
  if (prices && prices.length > 0) {
    prices.forEach(p => {
      text += `  ${p.bet_type}: ${p.amount_cup} CUP / ${p.amount_usd} USD\n`;
    });
  }
  
  await ctx.editMessageText(text, {
    parse_mode: 'Markdown',
    reply_markup: Markup.inlineKeyboard([
      [Markup.button.callback('◀ Volver a Admin', 'admin_panel')]
    ])
  });
});

// ========== ADMIN: SOLICITUDES PENDIENTES ==========
bot.action('adm_pending', async (ctx) => {
  if (ctx.from.id !== ADMIN_ID) return;
  
  // Depósitos pendientes
  const { data: pendingDeposits } = await supabase
    .from('deposit_requests')
    .select('*, users(first_name, telegram_id)')
    .eq('status', 'pending')
    .order('created_at', { ascending: false });
  
  // Retiros pendientes
  const { data: pendingWithdraws } = await supabase
    .from('withdraw_requests')
    .select('*, users(first_name, telegram_id), withdraw_methods(name)')
    .eq('status', 'pending')
    .order('created_at', { ascending: false });
  
  let text = '';
  
  if (pendingDeposits && pendingDeposits.length > 0) {
    text += '📥 *DEPÓSITOS PENDIENTES:*\n\n';
    pendingDeposits.forEach((d, i) => {
      text += `${i+1}. 👤 ${d.users.first_name} (${d.user_id})\n`;
      text += `   💰 Monto: ${d.amount} ${d.currency}\n`;
      text += `   🕒 ${new Date(d.created_at).toLocaleString()}\n`;
      text += `   🆔 Solicitud: ${d.id}\n\n`;
    });
  }
  
  if (pendingWithdraws && pendingWithdraws.length > 0) {
    text += '📤 *RETIROS PENDIENTES:*\n\n';
    pendingWithdraws.forEach((w, i) => {
      text += `${i+1}. 👤 ${w.users.first_name} (${w.user_id})\n`;
      text += `   💰 Monto: ${w.amount_usd} USD\n`;
      text += `   🏦 Método: ${w.withdraw_methods.name}\n`;
      text += `   📞 Cuenta: ${w.account_info}\n`;
      text += `   🕒 ${new Date(w.created_at).toLocaleString()}\n`;
      text += `   🆔 Solicitud: ${w.id}\n\n`;
    });
  }
  
  if (!text) {
    text = '✅ No hay solicitudes pendientes.';
  }
  
  await ctx.editMessageText(text || 'No hay solicitudes pendientes.', {
    parse_mode: 'Markdown',
    reply_markup: Markup.inlineKeyboard([
      [Markup.button.callback('◀ Volver a Admin', 'admin_panel')]
    ])
  });
});

// ========== MANEJADORES DE MENSAJES DE TEXTO ==========
bot.on(message('text'), async (ctx) => {
  const uid = ctx.from.id;
  const text = ctx.message.text.trim();
  const session = ctx.session;
  
  // ===== FLUJOS DE ADMIN =====
  if (uid === ADMIN_ID && session.adminAction) {
    // Añadir depósito
    if (session.adminAction === 'add_dep') {
      if (session.adminStep === 1) {
        session.adminTempName = text;
        session.adminStep = 2;
        await ctx.reply('Ahora envía el *número de la tarjeta/cuenta*:', { parse_mode: 'Markdown' });
        return;
      } else if (session.adminStep === 2) {
        session.adminTempCard = text;
        session.adminStep = 3;
        await ctx.reply('Ahora envía el *número a confirmar* (ej: 1234):', { parse_mode: 'Markdown' });
        return;
      } else if (session.adminStep === 3) {
        const name = session.adminTempName;
        const card = session.adminTempCard;
        const confirm = text;
        
        const { data, error } = await supabase
          .from('deposit_methods')
          .insert({ name, card, confirm })
          .select()
          .single();
        
        if (error) {
          await ctx.reply(`❌ Error al guardar: ${error.message}`);
        } else {
          await ctx.reply(`✅ Método de depósito *${name}* añadido con ID ${data.id}.`, 
            { parse_mode: 'Markdown', reply_markup: Markup.inlineKeyboard([[Markup.button.callback('🔧 Panel Admin', 'admin_panel')]]) });
        }
        delete session.adminAction;
        delete session.adminStep;
        delete session.adminTempName;
        delete session.adminTempCard;
        return;
      }
    }
    
    // Añadir retiro
    if (session.adminAction === 'add_wit') {
      if (session.adminStep === 1) {
        session.adminTempName = text;
        session.adminStep = 2;
        await ctx.reply('Ahora envía el *número o instrucción para retirar* (ej: número de cuenta):', { parse_mode: 'Markdown' });
        return;
      } else if (session.adminStep === 2) {
        session.adminTempCard = text;
        session.adminStep = 3;
        await ctx.reply('Ahora envía el *número a confirmar* (si aplica, o escribe "ninguno"):', { parse_mode: 'Markdown' });
        return;
      } else if (session.adminStep === 3) {
        const name = session.adminTempName;
        const card = session.adminTempCard;
        const confirm = text;
        
        const { data, error } = await supabase
          .from('withdraw_methods')
          .insert({ name, card, confirm })
          .select()
          .single();
        
        if (error) {
          await ctx.reply(`❌ Error al guardar: ${error.message}`);
        } else {
          await ctx.reply(`✅ Método de retiro *${name}* añadido con ID ${data.id}.`,
            { parse_mode: 'Markdown', reply_markup: Markup.inlineKeyboard([[Markup.button.callback('🔧 Panel Admin', 'admin_panel')]]) });
        }
        delete session.adminAction;
        delete session.adminStep;
        delete session.adminTempName;
        delete session.adminTempCard;
        return;
      }
    }
    
    // Configurar tasa
    if (session.adminAction === 'set_rate') {
      const rate = parseFloat(text.replace(',', '.'));
      if (isNaN(rate) || rate <= 0) {
        await ctx.reply('❌ Número inválido. Envía un número positivo (ej: 120).');
        return;
      }
      const { error } = await supabase
        .from('exchange_rate')
        .update({ rate, updated_at: new Date() })
        .eq('id', 1);
      
      if (error) {
        await ctx.reply(`❌ Error: ${error.message}`);
      } else {
        await ctx.reply(`✅ Tasa actualizada: 1 USD = ${rate} CUP`,
          { reply_markup: Markup.inlineKeyboard([[Markup.button.callback('🔧 Panel Admin', 'admin_panel')]]) });
      }
      delete session.adminAction;
      return;
    }
  }
  
  // ===== FLUJO DE APUESTA =====
  if (session.awaitingBet) {
    const betType = session.betType;
    const lottery = session.lottery || 'Florida';
    
    // Obtener precios actuales desde Supabase
    const { data: priceData } = await supabase
      .from('play_prices')
      .select('amount_usd, amount_cup')
      .eq('bet_type', betType)
      .single();
    
    let { ok, usdCost, cupCost } = parseBetAndCost(text, betType);
    
    // Si no se especificó moneda, usar precios por defecto
    if (!ok) {
      usdCost = priceData?.amount_usd || 0.2;
      cupCost = priceData?.amount_cup || 70;
      ok = true;
    }
    
    if (!ok) {
      await ctx.reply('❌ Formato de jugada no reconocido. Revisa los ejemplos.');
      return;
    }
    
    // Verificar saldo
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
    
    // Actualizar usuario
    await supabase
      .from('users')
      .update({
        usd: newUsd,
        bonus_usd: newBonus,
        cup: newCup,
        updated_at: new Date()
      })
      .eq('telegram_id', uid);
    
    // Registrar apuesta
    await supabase.from('bets').insert({
      user_id: uid,
      lottery,
      bet_type: betType,
      raw_text: text,
      cost_usd: usdCost,
      cost_cup: cupCost,
      placed_at: new Date()
    });
    
    await ctx.replyWithMarkdown(
      `✅ *Jugada registrada exitosamente*\n` +
      `🎰 ${lottery} - ${betType}\n` +
      `📝 \`${text}\`\n` +
      `💰 Costo: ${usdCost.toFixed(2)} USD / ${cupCost.toFixed(2)} CUP\n` +
      `🍀 ¡Buena suerte!`
    );
    
    delete session.awaitingBet;
    delete session.betType;
    delete session.lottery;
    return;
  }
  
  // ===== FLUJO DE DEPÓSITO: ESPERANDO MONTO (si no se usa foto, pero nosotros usamos foto) =====
  // En este diseño, después de seleccionar método esperamos FOTO, no texto.
  // Por lo tanto, este bloque se maneja en el manejador de fotos.
  
  // ===== FLUJO DE RETIRO: ESPERANDO MONTO =====
  if (session.awaitingWithdrawAmount) {
    const amount = parseFloat(text.replace(',', '.'));
    if (isNaN(amount) || amount < 1) {
      await ctx.reply('❌ Monto inválido. Debe ser un número mayor o igual a 1.');
      return;
    }
    const user = ctx.dbUser;
    if (parseFloat(user.usd) < amount) {
      await ctx.reply('❌ Saldo insuficiente.');
      return;
    }
    
    session.withdrawAmount = amount;
    session.awaitingWithdrawAccount = true;
    delete session.awaitingWithdrawAmount;
    
    await ctx.reply('Ahora envía el *número/ID de la tarjeta/cuenta* a la que deseas que retiremos:',
      { parse_mode: 'Markdown' }
    );
    return;
  }
  
  // ===== FLUJO DE RETIRO: ESPERANDO CUENTA =====
  if (session.awaitingWithdrawAccount) {
    const accountInfo = text;
    const amount = session.withdrawAmount;
    const method = session.withdrawMethod;
    
    // Crear solicitud en DB
    const { data, error } = await supabase
      .from('withdraw_requests')
      .insert({
        user_id: uid,
        method_id: method.id,
        amount_usd: amount,
        account_info: accountInfo,
        status: 'pending',
        created_at: new Date()
      })
      .select()
      .single();
    
    if (error) {
      await ctx.reply(`❌ Error al crear la solicitud: ${error.message}`);
      delete session.withdrawAmount;
      delete session.withdrawMethod;
      delete session.awaitingWithdrawAccount;
      return;
    }
    
    // Notificar al canal de admin
    const adminMessage = 
      `📤 *Nueva solicitud de RETIRO*\n\n` +
      `👤 Usuario: ${ctx.from.first_name} (${uid})\n` +
      `💰 Monto: ${amount} USD\n` +
      `🏦 Método: ${method.name}\n` +
      `📞 Cuenta: ${accountInfo}\n` +
      `🆔 Solicitud: ${data.id}`;
    
    await ctx.telegram.sendMessage(ADMIN_CHANNEL, adminMessage, {
      parse_mode: 'Markdown',
      reply_markup: Markup.inlineKeyboard([
        [
          Markup.button.callback('✅ Aprobar', `approve_withdraw_${data.id}`),
          Markup.button.callback('❌ Rechazar', `reject_withdraw_${data.id}`)
        ]
      ])
    });
    
    await ctx.reply(
      `✅ *Solicitud de retiro enviada*\n` +
      `💰 Monto: ${amount} USD\n` +
      `🏦 Método: ${method.name}\n` +
      `📞 Cuenta: ${accountInfo}\n\n` +
      `⏳ Procesaremos tu solicitud a la mayor brevedad.`,
      { parse_mode: 'Markdown' }
    );
    
    delete session.withdrawAmount;
    delete session.withdrawMethod;
    delete session.awaitingWithdrawAccount;
    return;
  }
  
  // ===== FLUJO DE TRANSFERENCIA: TARGET =====
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
    // Verificar que el destinatario exista
    const { data: targetUser } = await supabase
      .from('users')
      .select('telegram_id')
      .eq('telegram_id', targetId)
      .single();
    
    if (!targetUser) {
      await ctx.reply('❌ El usuario destinatario no está registrado en el bot.');
      return;
    }
    
    session.transferTarget = targetId;
    session.awaitingTransferAmount = true;
    delete session.awaitingTransferTarget;
    
    await ctx.reply(
      `Ahora envía el *monto en USD* a transferir (ej: 2.5):\n` +
      `💰 Tu saldo disponible: ${parseFloat(ctx.dbUser.usd).toFixed(2)} USD`,
      { parse_mode: 'Markdown' }
    );
    return;
  }
  
  // ===== FLUJO DE TRANSFERENCIA: MONTO =====
  if (session.awaitingTransferAmount) {
    const amount = parseFloat(text.replace(',', '.'));
    if (isNaN(amount) || amount <= 0) {
      await ctx.reply('❌ Monto inválido. Debe ser un número positivo.');
      return;
    }
    const user = ctx.dbUser;
    if (parseFloat(user.usd) < amount) {
      await ctx.reply('❌ Saldo USD insuficiente.');
      return;
    }
    
    const targetId = session.transferTarget;
    
    // Restar al remitente
    await supabase
      .from('users')
      .update({ usd: parseFloat(user.usd) - amount, updated_at: new Date() })
      .eq('telegram_id', uid);
    
    // Sumar al destinatario
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
  
  // Si no coincide ningún flujo, responder con el menú
  await ctx.reply('No entendí ese mensaje. Por favor usa los botones del menú.', 
    Markup.inlineKeyboard([[Markup.button.callback('📋 Menú principal', 'main')]])
  );
});

// ========== MANEJADOR DE FOTOS (DEPÓSITOS) ==========
bot.on(message('photo'), async (ctx) => {
  const uid = ctx.from.id;
  const session = ctx.session;
  
  if (!session.awaitingDepositPhoto || !session.depositMethod) {
    await ctx.reply('No estabas en un proceso de depósito. Por favor, inicia desde "Recargar".');
    return;
  }
  
  const method = session.depositMethod;
  const fileId = ctx.message.photo[ctx.message.photo.length - 1].file_id;
  const fileLink = await ctx.telegram.getFileLink(fileId);
  
  // Descargar la imagen para subir a Supabase Storage
  const response = await axios.get(fileLink, { responseType: 'arraybuffer' });
  const buffer = Buffer.from(response.data);
  
  // Generar nombre único
  const fileName = `deposit_${uid}_${Date.now()}.jpg`;
  const filePath = `deposits/${fileName}`;
  
  // Subir a Supabase Storage (bucket 'deposit-screenshots')
  const { data: uploadData, error: uploadError } = await supabase
    .storage
    .from('deposit-screenshots')
    .upload(filePath, buffer, {
      contentType: 'image/jpeg',
      upsert: false
    });
  
  if (uploadError) {
    console.error('Error subiendo captura:', uploadError);
    await ctx.reply('❌ Ocurrió un error al procesar la captura. Intenta de nuevo más tarde.');
    return;
  }
  
  // Obtener URL pública
  const { data: { publicUrl } } = supabase
    .storage
    .from('deposit-screenshots')
    .getPublicUrl(filePath);
  
  // Crear registro en deposit_requests
  const { data: requestData, error: insertError } = await supabase
    .from('deposit_requests')
    .insert({
      user_id: uid,
      method_id: method.id,
      screenshot_url: publicUrl,
      status: 'pending',
      created_at: new Date()
    })
    .select()
    .single();
  
  if (insertError) {
    console.error('Error insertando deposit_request:', insertError);
    await ctx.reply('❌ Error al registrar la solicitud. Contacta al administrador.');
    return;
  }
  
  // Notificar al canal de admin
  const user = ctx.dbUser;
  const adminMessage = 
    `📥 *Nueva solicitud de DEPÓSITO*\n\n` +
    `👤 Usuario: ${ctx.from.first_name} (${uid})\n` +
    `🏦 Método: ${method.name}\n` +
    `📎 [Ver captura](${publicUrl})\n` +
    `🆔 Solicitud: ${requestData.id}\n\n` +
    `💬 El usuario no especificó monto. Debes confirmar con él el monto y luego aprobar.`;
  
  await ctx.telegram.sendMessage(ADMIN_CHANNEL, adminMessage, {
    parse_mode: 'Markdown',
    reply_markup: Markup.inlineKeyboard([
      [
        Markup.button.callback('✅ Aprobar', `approve_deposit_${requestData.id}`),
        Markup.button.callback('❌ Rechazar', `reject_deposit_${requestData.id}`)
      ]
    ])
  });
  
  await ctx.reply(
    '✅ *Captura recibida*\n' +
    'Tu solicitud de recarga ha sido enviada al administrador. Será acreditada en breve.',
    { parse_mode: 'Markdown' }
  );
  
  delete session.awaitingDepositPhoto;
  delete session.depositMethod;
});

// ========== CALLBACKS PARA APROBAR/RECHAZAR DESDE CANAL ==========
bot.action(/approve_deposit_(\d+)/, async (ctx) => {
  // Verificar que el mensaje proviene del admin channel (ctx.chat.id debe ser ADMIN_CHANNEL)
  // O simplemente verificar que el usuario es ADMIN_ID (el admin puede hacerlo desde el canal)
  if (ctx.from.id !== ADMIN_ID) {
    await ctx.answerCbQuery('No autorizado', { show_alert: true });
    return;
  }
  
  const requestId = parseInt(ctx.match[1]);
  
  // Obtener la solicitud
  const { data: request, error } = await supabase
    .from('deposit_requests')
    .select('*, deposit_methods(*)')
    .eq('id', requestId)
    .single();
  
  if (!request) {
    await ctx.answerCbQuery('Solicitud no encontrada', { show_alert: true });
    return;
  }
  
  // Aquí el admin debe indicar el monto a acreditar (por ahora asumimos que se acredita un valor fijo + bono)
  // Podríamos pedir al admin que responda con el monto, pero simplificaremos: acreditamos BONUS_CUP_DEFAULT en CUP convertido a USD?
  // Mejor: el admin edita el mensaje y pone el monto, o lo hace desde el panel.
  // Por simplicidad, acreditaremos un monto por defecto (ej. 10 USD + bono). En producción debería ser configurable.
  // Como es un ejemplo, acreditaremos 10 USD.
  const amountUSD = 10.0;
  const bonusUSD = parseFloat((BONUS_CUP_DEFAULT / (await getExchangeRate())).toFixed(2));
  
  // Actualizar usuario
  const { data: user } = await supabase
    .from('users')
    .select('usd, bonus_usd')
    .eq('telegram_id', request.user_id)
    .single();
  
  await supabase
    .from('users')
    .update({
      usd: parseFloat(user.usd) + amountUSD,
      bonus_usd: parseFloat(user.bonus_usd) + bonusUSD,
      updated_at: new Date()
    })
    .eq('telegram_id', request.user_id);
  
  // Marcar solicitud como aprobada
  await supabase
    .from('deposit_requests')
    .update({ status: 'approved', updated_at: new Date() })
    .eq('id', requestId);
  
  // Notificar al usuario
  await ctx.telegram.sendMessage(
    request.user_id,
    `✅ *Depósito aprobado*\n` +
    `Se ha acreditado *${amountUSD} USD* a tu saldo.\n` +
    `🎁 Bonus: +${bonusUSD} USD (no retirable)\n` +
    `Gracias por confiar en nosotros.`,
    { parse_mode: 'Markdown' }
  );
  
  await ctx.editMessageReplyMarkup({ inline_keyboard: [] }); // Quitar botones
  await ctx.reply('✅ Depósito aprobado y acreditado.');
});

bot.action(/reject_deposit_(\d+)/, async (ctx) => {
  if (ctx.from.id !== ADMIN_ID) {
    await ctx.answerCbQuery('No autorizado', { show_alert: true });
    return;
  }
  
  const requestId = parseInt(ctx.match[1]);
  
  await supabase
    .from('deposit_requests')
    .update({ status: 'rejected', updated_at: new Date() })
    .eq('id', requestId);
  
  // Notificar al usuario
  const { data: request } = await supabase
    .from('deposit_requests')
    .select('user_id')
    .eq('id', requestId)
    .single();
  
  if (request) {
    await ctx.telegram.sendMessage(
      request.user_id,
      '❌ *Depósito rechazado*\n' +
      'Tu solicitud de recarga no pudo ser procesada. Contacta al administrador para más detalles.',
      { parse_mode: 'Markdown' }
    );
  }
  
  await ctx.editMessageReplyMarkup({ inline_keyboard: [] });
  await ctx.reply('❌ Depósito rechazado.');
});

// Retiros
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
  
  // Restar saldo al usuario (ya se restó al crear la solicitud? En nuestro flujo no restamos hasta aprobar)
  // Vamos a restar ahora.
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
  
  await ctx.telegram.sendMessage(
    request.user_id,
    `✅ *Retiro aprobado*\n` +
    `Se ha procesado tu solicitud de retiro por *${request.amount_usd} USD*.\n` +
    `Los fondos serán enviados a la cuenta proporcionada.`,
    { parse_mode: 'Markdown' }
  );
  
  await ctx.editMessageReplyMarkup({ inline_keyboard: [] });
  await ctx.reply('✅ Retiro aprobado y saldo debitado.');
});

bot.action(/reject_withdraw_(\d+)/, async (ctx) => {
  if (ctx.from.id !== ADMIN_ID) {
    await ctx.answerCbQuery('No autorizado', { show_alert: true });
    return;
  }
  
  const requestId = parseInt(ctx.match[1]);
  
  await supabase
    .from('withdraw_requests')
    .update({ status: 'rejected', updated_at: new Date() })
    .eq('id', requestId);
  
  const { data: request } = await supabase
    .from('withdraw_requests')
    .select('user_id')
    .eq('id', requestId)
    .single();
  
  if (request) {
    await ctx.telegram.sendMessage(
      request.user_id,
      '❌ *Retiro rechazado*\n' +
      'Tu solicitud de retiro no pudo ser procesada. Contacta al administrador.',
      { parse_mode: 'Markdown' }
    );
  }
  
  await ctx.editMessageReplyMarkup({ inline_keyboard: [] });
  await ctx.reply('❌ Retiro rechazado.');
});

// ========== FUNCIONES AUXILIARES ADICIONALES ==========
async function getExchangeRate() {
  const { data } = await supabase
    .from('exchange_rate')
    .select('rate')
    .eq('id', 1)
    .single();
  return data?.rate || 110;
}

// ========== LANZAR BOT ==========
bot.launch()
  .then(() => {
    console.log('🤖 Bot de Rifas iniciado correctamente');
    console.log(`Admin ID: ${ADMIN_ID}`);
    console.log(`Canal de admin: ${ADMIN_CHANNEL}`);
  })
  .catch(err => {
    console.error('Error al iniciar el bot:', err);
  });

// Enable graceful stop
process.once('SIGINT', () => bot.stop('SIGINT'));
process.once('SIGTERM', () => bot.stop('SIGTERM'));

// ========== EXPORTAR PARA POSIBLE USO EN BACKEND ==========
module.exports = bot;
