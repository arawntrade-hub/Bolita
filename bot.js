// ==============================
// bot.js - Bot de Telegram para Rifas Cuba
// Exporta el bot listo para ser lanzado desde backend.js
// ==============================

require('dotenv').config();
const { Telegraf, Markup } = require('telegraf');
const { message } = require('telegraf/filters');
const LocalSession = require('telegraf-session-local');
const { createClient } = require('@supabase/supabase-js');
const crypto = require('crypto');
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

// ✅ SESIÓN LOCAL – CORREGIDA
const localSession = new LocalSession({ 
  database: 'session_db.json'
});
bot.use(localSession.middleware());

// ========== FUNCIONES AUXILIARES ==========
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

function parseBetCost(raw, betType, defaultPrices) {
  const lower = raw.toLowerCase();
  let usdCost = 0, cupCost = 0;
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
    usdCost = defaultPrices.amount_usd || 0.2;
    cupCost = defaultPrices.amount_cup || 70;
  }
  return { ok: usdCost > 0 || cupCost > 0, usdCost, cupCost };
}

async function getExchangeRate() {
  const { data } = await supabase
    .from('exchange_rate')
    .select('rate')
    .eq('id', 1)
    .single();
  return data?.rate || 110;
}

// ========== MIDDLEWARE: CARGAR USUARIO ==========
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
        const { data: newUser } = await supabase
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
  const menuButtons = [
    [Markup.button.callback('🎲 Jugar', 'play')],
    [Markup.button.callback('💰 Mi dinero', 'my_money')],
    [Markup.button.callback('📋 Mis jugadas', 'my_bets')],
    [Markup.button.callback('👥 Referidos', 'referrals')],
    [Markup.button.callback('❓ Cómo jugar', 'how_to_play')],
    ...(uid === ADMIN_ID ? [[Markup.button.callback('🔧 Admin', 'admin_panel')]] : []),
    [Markup.button.webApp('🌐 Abrir WebApp', `${WEBAPP_URL}/app.html`)]
  ];
  
  await ctx.replyWithMarkdown(
    `¡Hola de nuevo, *${firstName}* 👋\nBienvenido de regreso a Rifas Cuba, tu asistente de la suerte 🍀\n\n🎲 ¿Listo para jugar?\nApuesta, gana y disfruta. ¡La suerte está de tu lado!`,
    Markup.inlineKeyboard(menuButtons)
  );
});

// ========== MENÚ PRINCIPAL ==========
bot.action('main', async (ctx) => {
  const uid = ctx.from.id;
  const menuButtons = [
    [Markup.button.callback('🎲 Jugar', 'play')],
    [Markup.button.callback('💰 Mi dinero', 'my_money')],
    [Markup.button.callback('📋 Mis jugadas', 'my_bets')],
    [Markup.button.callback('👥 Referidos', 'referrals')],
    [Markup.button.callback('❓ Cómo jugar', 'how_to_play')],
    ...(uid === ADMIN_ID ? [[Markup.button.callback('🔧 Admin', 'admin_panel')]] : []),
    [Markup.button.webApp('🌐 Abrir WebApp', `${WEBAPP_URL}/app.html`)]
  ];
  await safeEdit(ctx, 'Menú principal:', Markup.inlineKeyboard(menuButtons));
});

// ========== FUNCIÓN SEGURA PARA EDITAR MENSAJES ==========
async function safeEdit(ctx, text, keyboard, parseMode = 'Markdown') {
  try {
    await ctx.editMessageText(text, {
      parse_mode: parseMode,
      reply_markup: keyboard?.reply_markup
    });
  } catch (err) {
    console.warn('Error editando mensaje, enviando nuevo:', err.message);
    await ctx.reply(text, {
      parse_mode: parseMode,
      reply_markup: keyboard?.reply_markup
    });
  }
}

// ========== JUGAR ==========
bot.action('play', async (ctx) => {
  await safeEdit(ctx, 'Selecciona una lotería:', Markup.inlineKeyboard([
    [Markup.button.callback('🦩 Florida', 'lot_florida'), Markup.button.callback('🍑 Georgia', 'lot_georgia')],
    [Markup.button.callback('🗽 Nueva York', 'lot_newyork'), Markup.button.callback('◀ Volver', 'main')]
  ]));
});

bot.action(/lot_(.+)/, async (ctx) => {
  const lotteryKey = ctx.match[1];
  const lotteryName = {
    florida: 'Florida',
    georgia: 'Georgia',
    newyork: 'Nueva York'
  }[lotteryKey];
  
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
  await safeEdit(ctx, `Has seleccionado *${lotteryName}*. Ahora elige el tipo de jugada:`, Markup.inlineKeyboard([
    [Markup.button.callback('🎯 Fijo', 'type_fijo')],
    [Markup.button.callback('🏃 Corridos', 'type_corridos')],
    [Markup.button.callback('💯 Centena', 'type_centena')],
    [Markup.button.callback('🔒 Parle', 'type_parle')],
    [Markup.button.callback('◀ Volver', 'play')]
  ]), 'Markdown');
});

bot.action(/type_(.+)/, async (ctx) => {
  const betType = ctx.match[1];
  ctx.session.betType = betType;
  ctx.session.awaitingBet = true;
  const lottery = ctx.session.lottery || 'Florida';
  let instructions = '';
  switch (betType) {
    case 'fijo':
      instructions = `🎯 *Jugada FIJO* - 🦩 ${lottery}\n\n📌 Escribe cada número con su valor específico:\n\n📖 *Ejemplos:*\n• 12 con 1 usd, 34 con 2 usd\n• 7*1.5usd, 23*2cup\nEn caso de decenas y terminal:\n• D2 con 1 usd, T5*2cup\n\n⚡ Se procesará inmediatamente\n\n💭 *Escribe tus números:*`;
      break;
    case 'corridos':
      instructions = `🏃 *Jugada CORRIDOS* - 🦩 ${lottery}\n\n📌 Escribe cada número con su valor específico:\n\n📖 *Ejemplos:*\n• 12 con 1 usd, 34 con 2 usd\n• 7*1.5usd, 23*2cup\n\n⚡ Se procesará inmediatamente\n\n💭 *Escribe tus números:*`;
      break;
    case 'centena':
      instructions = `💯 *Jugada CENTENA* - 🦩 ${lottery}\n\n📌 Escribe cada número con su valor específico (3 dígitos):\n\n📖 *Ejemplos:*\n• 123 con 1 usd, 456 con 2 usd\n• 001*1.5usd, 125*2cup\n\n⚡ Se procesará inmediatamente\n\n💭 *Escribe tus números (3 dígitos):*`;
      break;
    case 'parle':
      instructions = `🔒 *Jugada PARLE* - 🦩 ${lottery}\n\n📌 Escribe cada parle con su valor específico:\n\n📖 *Ejemplos:*\n• 12x34 con 1 usd, 56x78 con 2 usd\n• 12x34*1.5usd, 56x78*2cup\n• 12x T5 con 1 usd\n\n⚡ Se procesará inmediatamente\n\n💭 *Escribe tus parles (usa 'x' entre números):*`;
      break;
  }
  await safeEdit(ctx, instructions, null, 'Markdown');
});

// ========== MI DINERO ==========
bot.action('my_money', async (ctx) => {
  const user = ctx.dbUser;
  const text = `💰 *Tu saldo actual:*\n🇨🇺 *CUP:* ${parseFloat(user.cup).toFixed(2)}\n💵 *USD:* ${parseFloat(user.usd).toFixed(2)}\n🎁 *Bono:* ${parseFloat(user.bonus_usd).toFixed(2)} USD`;
  await safeEdit(ctx, text, Markup.inlineKeyboard([
    [Markup.button.callback('📥 Recargar', 'recharge')],
    [Markup.button.callback('📤 Retirar', 'withdraw')],
    [Markup.button.callback('🔄 Transferir', 'transfer')],
    [Markup.button.callback('◀ Volver', 'main')]
  ]), 'Markdown');
});

// ========== RECARGAR (DEPÓSITO) ==========
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
    `💵 *¿Cómo deseas recargar?*\n\nElige una opción para ver los datos de pago y luego *envía una captura de pantalla*.\n\n*Tasa de cambio:* 1 USD = ${rate} CUP`,
    Markup.inlineKeyboard(rows), 'Markdown'
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
    `🧾 *${method.name}*\nNúmero: \`${method.card}\`\nConfirmar: \`${method.confirm}\`\n\n✅ *Después de transferir, envía una CAPTURA DE PANTALLA* de la operación.\nTu solicitud será revisada y acreditada en breve.`,
    null, 'Markdown'
  );
});

// ========== RETIRAR ==========
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
  await safeEdit(ctx, '📤 *Elige un método de retiro:*', Markup.inlineKeyboard(rows), 'Markdown');
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
  ctx.session.awaitingWithdrawAmount = true;
  await safeEdit(ctx,
    `Has elegido *${method.name}*.\n\n💰 *Tu saldo disponible:* ${parseFloat(ctx.dbUser.usd).toFixed(2)} USD\nEnvía ahora el *monto en USD* que deseas retirar (mínimo 1 USD).`,
    null, 'Markdown'
  );
});

// ========== TRANSFERIR ==========
bot.action('transfer', async (ctx) => {
  ctx.session.awaitingTransferTarget = true;
  await safeEdit(ctx,
    '🔄 *Transferir saldo*\n\nEnvía el *ID de Telegram* del usuario al que deseas transferir (ej: 123456789):',
    null, 'Markdown'
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
      null, 'Markdown'
    );
  } else {
    let text = '📋 *Tus últimas 5 jugadas:*\n\n';
    bets.forEach((b, i) => {
      const date = new Date(b.placed_at).toLocaleString('es-CU', { timeZone: TIMEZONE });
      text += `*${i+1}.* 🎰 ${b.lottery} - ${b.bet_type}\n   📝 \`${b.raw_text}\`\n   💰 ${b.cost_usd} USD / ${b.cost_cup} CUP\n   🕒 ${date}\n\n`;
    });
    await safeEdit(ctx, text, null, 'Markdown');
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
    `💸 *¡INVITA Y GANA DINERO AUTOMÁTICO!* 💰\n\n🎯 *¿Cómo funciona?*\n1️⃣ Comparte tu enlace con amigos\n2️⃣ Cuando se registren y jueguen, TÚ ganas\n3️⃣ Recibes comisión CADA VEZ que apuesten\n4️⃣ ¡Dinero GRATIS para siempre! 🔄\n\n🔥 SIN LÍMITES - SIN TOPES - PARA SIEMPRE\n\n📲 *ESTE ES TU ENLACE MÁGICO:* 👇\n\`${link}\`\n\n📊 *Tus estadísticas:*\n👥 Total de referidos: ${count || 0}`,
    null, 'Markdown'
  );
});

// ========== CÓMO JUGAR ==========
bot.action('how_to_play', async (ctx) => {
  await safeEdit(ctx,
    '📩 *¿Tienes dudas?*\nEscribe directamente en el chat del bot, tu mensaje será respondido por una persona real.\n\nℹ️ Estamos aquí para ayudarte.',
    Markup.inlineKeyboard([[Markup.button.callback('◀ Volver', 'main')]]), 'Markdown'
  );
});

// ========== PANEL DE ADMINISTRACIÓN ==========
bot.action('admin_panel', async (ctx) => {
  if (ctx.from.id !== ADMIN_ID) {
    await ctx.answerCbQuery('⛔ No autorizado', { show_alert: true });
    return;
  }
  
  // ✅ BOTONES ORGANIZADOS HORIZONTALMENTE
  await safeEdit(ctx, '🔧 *Panel de administración*', Markup.inlineKeyboard([
    [Markup.button.callback('➕ Añadir Dep', 'adm_add_dep'), 
     Markup.button.callback('✏️ Editar Dep', 'adm_edit_dep'), 
     Markup.button.callback('🗑 Eliminar Dep', 'adm_del_dep')],
    [Markup.button.callback('➕ Añadir Ret', 'adm_add_wit'), 
     Markup.button.callback('✏️ Editar Ret', 'adm_edit_wit'), 
     Markup.button.callback('🗑 Eliminar Ret', 'adm_del_wit')],
    [Markup.button.callback('💰 Tasa', 'adm_set_rate'), 
     Markup.button.callback('🎲 Precios', 'adm_set_price')],
    [Markup.button.callback('📋 Ver datos', 'adm_view'), 
     Markup.button.callback('📥 Pendientes', 'adm_pending')],
    [Markup.button.callback('🎰 Abrir sesión', 'adm_open_session'), 
     Markup.button.callback('🔢 Números', 'adm_winning_numbers')],
    [Markup.button.callback('◀ Menú principal', 'main')]
  ]), 'Markdown');
});

// ---------- ADMIN: CRUD DEPÓSITOS ----------
bot.action('adm_add_dep', async (ctx) => {
  if (ctx.from.id !== ADMIN_ID) return;
  ctx.session.adminAction = 'add_dep';
  ctx.session.adminStep = 1;
  await ctx.reply('➕ *Añadir método de DEPÓSITO*\n\nEscribe el *nombre* del método:', { parse_mode: 'Markdown' });
  await ctx.answerCbQuery();
});

bot.action('adm_edit_dep', async (ctx) => {
  if (ctx.from.id !== ADMIN_ID) return;
  const { data: methods } = await supabase.from('deposit_methods').select('*');
  if (!methods || methods.length === 0) {
    await ctx.reply('No hay métodos de depósito para editar.');
    return;
  }
  const buttons = methods.map(m => Markup.button.callback(`${m.id} - ${m.name}`, `edit_dep_${m.id}`));
  const rows = [];
  for (let i = 0; i < buttons.length; i += 2) rows.push(buttons.slice(i, i + 2));
  rows.push([Markup.button.callback('◀ Cancelar', 'admin_panel')]);
  await ctx.reply('Selecciona el método de depósito a editar:', Markup.inlineKeyboard(rows));
  await ctx.answerCbQuery();
});

bot.action('adm_del_dep', async (ctx) => {
  if (ctx.from.id !== ADMIN_ID) return;
  const { data: methods } = await supabase.from('deposit_methods').select('*');
  if (!methods || methods.length === 0) {
    await ctx.reply('No hay métodos de depósito para eliminar.');
    return;
  }
  const buttons = methods.map(m => Markup.button.callback(`${m.id} - ${m.name}`, `del_dep_${m.id}`));
  const rows = [];
  for (let i = 0; i < buttons.length; i += 2) rows.push(buttons.slice(i, i + 2));
  rows.push([Markup.button.callback('◀ Cancelar', 'admin_panel')]);
  await ctx.reply('Selecciona el método de depósito a eliminar:', Markup.inlineKeyboard(rows));
  await ctx.answerCbQuery();
});

// ---------- ADMIN: CRUD RETIROS ----------
bot.action('adm_add_wit', async (ctx) => {
  if (ctx.from.id !== ADMIN_ID) return;
  ctx.session.adminAction = 'add_wit';
  ctx.session.adminStep = 1;
  await ctx.reply('➕ *Añadir método de RETIRO*\n\nEscribe el *nombre* del método:', { parse_mode: 'Markdown' });
  await ctx.answerCbQuery();
});

bot.action('adm_edit_wit', async (ctx) => {
  if (ctx.from.id !== ADMIN_ID) return;
  const { data: methods } = await supabase.from('withdraw_methods').select('*');
  if (!methods || methods.length === 0) {
    await ctx.reply('No hay métodos de retiro para editar.');
    return;
  }
  const buttons = methods.map(m => Markup.button.callback(`${m.id} - ${m.name}`, `edit_wit_${m.id}`));
  const rows = [];
  for (let i = 0; i < buttons.length; i += 2) rows.push(buttons.slice(i, i + 2));
  rows.push([Markup.button.callback('◀ Cancelar', 'admin_panel')]);
  await ctx.reply('Selecciona el método de retiro a editar:', Markup.inlineKeyboard(rows));
  await ctx.answerCbQuery();
});

bot.action('adm_del_wit', async (ctx) => {
  if (ctx.from.id !== ADMIN_ID) return;
  const { data: methods } = await supabase.from('withdraw_methods').select('*');
  if (!methods || methods.length === 0) {
    await ctx.reply('No hay métodos de retiro para eliminar.');
    return;
  }
  const buttons = methods.map(m => Markup.button.callback(`${m.id} - ${m.name}`, `del_wit_${m.id}`));
  const rows = [];
  for (let i = 0; i < buttons.length; i += 2) rows.push(buttons.slice(i, i + 2));
  rows.push([Markup.button.callback('◀ Cancelar', 'admin_panel')]);
  await ctx.reply('Selecciona el método de retiro a eliminar:', Markup.inlineKeyboard(rows));
  await ctx.answerCbQuery();
});

// ---------- ADMIN: EDIT/DELETE CALLBACKS ----------
bot.action(/edit_dep_(\d+)/, async (ctx) => {
  if (ctx.from.id !== ADMIN_ID) return;
  const id = parseInt(ctx.match[1]);
  ctx.session.adminAction = 'edit_dep';
  ctx.session.editId = id;
  ctx.session.adminStep = 1;
  await ctx.reply('Envía el *nuevo nombre* del método:', { parse_mode: 'Markdown' });
  await ctx.answerCbQuery();
});

bot.action(/del_dep_(\d+)/, async (ctx) => {
  if (ctx.from.id !== ADMIN_ID) return;
  const id = parseInt(ctx.match[1]);
  await supabase.from('deposit_methods').delete().eq('id', id);
  await ctx.reply('✅ Método de depósito eliminado.');
  await ctx.answerCbQuery();
});

bot.action(/edit_wit_(\d+)/, async (ctx) => {
  if (ctx.from.id !== ADMIN_ID) return;
  const id = parseInt(ctx.match[1]);
  ctx.session.adminAction = 'edit_wit';
  ctx.session.editId = id;
  ctx.session.adminStep = 1;
  await ctx.reply('Envía el *nuevo nombre* del método:', { parse_mode: 'Markdown' });
  await ctx.answerCbQuery();
});

bot.action(/del_wit_(\d+)/, async (ctx) => {
  if (ctx.from.id !== ADMIN_ID) return;
  const id = parseInt(ctx.match[1]);
  await supabase.from('withdraw_methods').delete().eq('id', id);
  await ctx.reply('✅ Método de retiro eliminado.');
  await ctx.answerCbQuery();
});

// ---------- ADMIN: CONFIGURAR TASA ----------
bot.action('adm_set_rate', async (ctx) => {
  if (ctx.from.id !== ADMIN_ID) return;
  const rate = await getExchangeRate();
  ctx.session.adminAction = 'set_rate';
  await ctx.reply(`💰 *Tasa actual:* 1 USD = ${rate} CUP\n\nEnvía la *nueva tasa* (ej: 120):`, { parse_mode: 'Markdown' });
  await ctx.answerCbQuery();
});

// ---------- ADMIN: CONFIGURAR PRECIOS ----------
bot.action('adm_set_price', async (ctx) => {
  if (ctx.from.id !== ADMIN_ID) return;
  const { data: prices } = await supabase.from('play_prices').select('*');
  const buttons = prices.map(p => Markup.button.callback(p.bet_type, `set_price_${p.bet_type}`));
  const rows = [];
  for (let i = 0; i < buttons.length; i += 2) rows.push(buttons.slice(i, i + 2));
  rows.push([Markup.button.callback('◀ Cancelar', 'admin_panel')]);
  await ctx.reply('🎲 *Configurar precios de jugadas*\nElige el tipo que deseas modificar:', {
    parse_mode: 'Markdown',
    reply_markup: Markup.inlineKeyboard(rows)
  });
  await ctx.answerCbQuery();
});

bot.action(/set_price_(.+)/, async (ctx) => {
  if (ctx.from.id !== ADMIN_ID) return;
  const betType = ctx.match[1];
  ctx.session.adminAction = 'set_price';
  ctx.session.betType = betType;
  await ctx.reply(`Configurando *${betType}*\nEnvía en el formato: \`<monto_cup> <monto_usd>\`\nEjemplo: \`70 0.20\``, { parse_mode: 'Markdown' });
  await ctx.answerCbQuery();
});

// ---------- ADMIN: VER DATOS ----------
bot.action('adm_view', async (ctx) => {
  if (ctx.from.id !== ADMIN_ID) return;
  const rate = await getExchangeRate();
  const { data: depMethods } = await supabase.from('deposit_methods').select('*');
  const { data: witMethods } = await supabase.from('withdraw_methods').select('*');
  const { data: prices } = await supabase.from('play_prices').select('*');
  let text = `💰 *Tasa:* 1 USD = ${rate} CUP\n\n📥 *Métodos DEPÓSITO:*\n`;
  depMethods?.forEach(m => text += `  ID ${m.id}: ${m.name} - ${m.card} / ${m.confirm}\n`);
  text += `\n📤 *Métodos RETIRO:*\n`;
  witMethods?.forEach(m => text += `  ID ${m.id}: ${m.name} - ${m.card} / ${m.confirm}\n`);
  text += `\n🎲 *Precios por jugada:*\n`;
  prices?.forEach(p => text += `  ${p.bet_type}: ${p.amount_cup} CUP / ${p.amount_usd} USD\n`);
  await safeEdit(ctx, text, Markup.inlineKeyboard([[Markup.button.callback('◀ Volver a Admin', 'admin_panel')]]), 'Markdown');
});

// ---------- ADMIN: SOLICITUDES PENDIENTES ----------
bot.action('adm_pending', async (ctx) => {
  if (ctx.from.id !== ADMIN_ID) return;
  const { data: pendingDeposits } = await supabase
    .from('deposit_requests')
    .select('*, users(first_name, telegram_id), deposit_methods(name)')
    .eq('status', 'pending')
    .order('created_at', { ascending: false });
  const { data: pendingWithdraws } = await supabase
    .from('withdraw_requests')
    .select('*, users(first_name, telegram_id), withdraw_methods(name)')
    .eq('status', 'pending')
    .order('created_at', { ascending: false });
  let text = '';
  if (pendingDeposits?.length) {
    text += '📥 *DEPÓSITOS PENDIENTES:*\n\n';
    pendingDeposits.forEach((d, i) => {
      text += `${i+1}. 👤 ${d.users.first_name} (${d.user_id})\n   🆔 Solicitud: ${d.id}\n   🕒 ${new Date(d.created_at).toLocaleString()}\n\n`;
    });
  }
  if (pendingWithdraws?.length) {
    text += '📤 *RETIROS PENDIENTES:*\n\n';
    pendingWithdraws.forEach((w, i) => {
      text += `${i+1}. 👤 ${w.users.first_name} (${w.user_id})\n   💰 Monto: ${w.amount_usd} USD\n   🆔 Solicitud: ${w.id}\n\n`;
    });
  }
  if (!text) text = '✅ No hay solicitudes pendientes.';
  await safeEdit(ctx, text, Markup.inlineKeyboard([[Markup.button.callback('◀ Volver a Admin', 'admin_panel')]]), 'Markdown');
});

// ---------- ADMIN: SESIONES DE LOTERÍA ----------
bot.action('adm_open_session', async (ctx) => {
  if (ctx.from.id !== ADMIN_ID) return;
  ctx.session.adminAction = 'open_session';
  ctx.session.adminStep = 1;
  await ctx.reply('🎰 *Abrir sesión de lotería*\n\nEscribe la *lotería* (Florida, Georgia, Nueva York):', { parse_mode: 'Markdown' });
  await ctx.answerCbQuery();
});

bot.action('adm_winning_numbers', async (ctx) => {
  if (ctx.from.id !== ADMIN_ID) return;
  ctx.session.adminAction = 'winning_numbers';
  ctx.session.adminStep = 1;
  await ctx.reply('🔢 *Publicar números ganadores*\n\nEscribe la *lotería* (Florida, Georgia, Nueva York):', { parse_mode: 'Markdown' });
  await ctx.answerCbQuery();
});

// ========== MANEJADOR DE MENSAJES DE TEXTO ==========
bot.on(message('text'), async (ctx) => {
  const uid = ctx.from.id;
  const text = ctx.message.text.trim();
  const session = ctx.session;

  // ---------- FLUJOS ADMIN ----------
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
        const { data, error } = await supabase
          .from('deposit_methods')
          .insert({ name: session.adminTempName, card: session.adminTempCard, confirm: text })
          .select()
          .single();
        if (error) await ctx.reply(`❌ Error: ${error.message}`);
        else await ctx.reply(`✅ Método de depósito *${session.adminTempName}* añadido con ID ${data.id}.`, { parse_mode: 'Markdown' });
        delete session.adminAction;
        return;
      }
    }
    // Editar depósito
    if (session.adminAction === 'edit_dep') {
      const id = session.editId;
      if (session.adminStep === 1) {
        session.adminTempName = text;
        session.adminStep = 2;
        await ctx.reply('Ahora envía el *nuevo número de tarjeta/cuenta*:', { parse_mode: 'Markdown' });
        return;
      } else if (session.adminStep === 2) {
        session.adminTempCard = text;
        session.adminStep = 3;
        await ctx.reply('Ahora envía el *nuevo número a confirmar*:', { parse_mode: 'Markdown' });
        return;
      } else if (session.adminStep === 3) {
        const { error } = await supabase
          .from('deposit_methods')
          .update({ name: session.adminTempName, card: session.adminTempCard, confirm: text })
          .eq('id', id);
        if (error) await ctx.reply(`❌ Error: ${error.message}`);
        else await ctx.reply(`✅ Método de depósito ID ${id} actualizado.`);
        delete session.adminAction;
        delete session.editId;
        return;
      }
    }
    // Añadir retiro
    if (session.adminAction === 'add_wit') {
      if (session.adminStep === 1) {
        session.adminTempName = text;
        session.adminStep = 2;
        await ctx.reply('Ahora envía el *número o instrucción para retirar*:', { parse_mode: 'Markdown' });
        return;
      } else if (session.adminStep === 2) {
        session.adminTempCard = text;
        session.adminStep = 3;
        await ctx.reply('Ahora envía el *número a confirmar* (o "ninguno"):', { parse_mode: 'Markdown' });
        return;
      } else if (session.adminStep === 3) {
        const { data, error } = await supabase
          .from('withdraw_methods')
          .insert({ name: session.adminTempName, card: session.adminTempCard, confirm: text })
          .select()
          .single();
        if (error) await ctx.reply(`❌ Error: ${error.message}`);
        else await ctx.reply(`✅ Método de retiro *${session.adminTempName}* añadido con ID ${data.id}.`, { parse_mode: 'Markdown' });
        delete session.adminAction;
        return;
      }
    }
    // Editar retiro
    if (session.adminAction === 'edit_wit') {
      const id = session.editId;
      if (session.adminStep === 1) {
        session.adminTempName = text;
        session.adminStep = 2;
        await ctx.reply('Ahora envía la *nueva instrucción/número*:', { parse_mode: 'Markdown' });
        return;
      } else if (session.adminStep === 2) {
        session.adminTempCard = text;
        session.adminStep = 3;
        await ctx.reply('Ahora envía el *nuevo número a confirmar*:', { parse_mode: 'Markdown' });
        return;
      } else if (session.adminStep === 3) {
        const { error } = await supabase
          .from('withdraw_methods')
          .update({ name: session.adminTempName, card: session.adminTempCard, confirm: text })
          .eq('id', id);
        if (error) await ctx.reply(`❌ Error: ${error.message}`);
        else await ctx.reply(`✅ Método de retiro ID ${id} actualizado.`);
        delete session.adminAction;
        delete session.editId;
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
      await ctx.reply(`✅ Tasa actualizada: 1 USD = ${rate} CUP`);
      delete session.adminAction;
      return;
    }
    // Configurar precio
    if (session.adminAction === 'set_price') {
      const parts = text.split(' ');
      if (parts.length < 2) {
        await ctx.reply('❌ Formato inválido. Usa: `<cup> <usd>` (ej: 70 0.20)');
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
      await ctx.reply(`✅ Precio para *${session.betType}* actualizado: ${cup} CUP / ${usd} USD`, { parse_mode: 'Markdown' });
      delete session.adminAction;
      delete session.betType;
      return;
    }
    // Abrir sesión de lotería
    if (session.adminAction === 'open_session') {
      if (session.adminStep === 1) {
        session.tempLottery = text;
        session.adminStep = 2;
        await ctx.reply('Escribe la *fecha* (YYYY-MM-DD):', { parse_mode: 'Markdown' });
        return;
      } else if (session.adminStep === 2) {
        session.tempDate = text;
        session.adminStep = 3;
        await ctx.reply('Escribe el *turno/horario* (ej: Mañana, Tarde, Noche):', { parse_mode: 'Markdown' });
        return;
      } else if (session.adminStep === 3) {
        const { error } = await supabase
          .from('lottery_sessions')
          .insert({ lottery: session.tempLottery, date: session.tempDate, time_slot: text, status: 'open' });
        if (error) await ctx.reply(`❌ Error: ${error.message}`);
        else await ctx.reply(`✅ Sesión de ${session.tempLottery} (${session.tempDate} - ${text}) abierta.`);
        delete session.adminAction;
        delete session.tempLottery;
        delete session.tempDate;
        return;
      }
    }
    // Publicar números ganadores
    if (session.adminAction === 'winning_numbers') {
      if (session.adminStep === 1) {
        session.tempLottery = text;
        session.adminStep = 2;
        await ctx.reply('Escribe la *fecha* (YYYY-MM-DD):', { parse_mode: 'Markdown' });
        return;
      } else if (session.adminStep === 2) {
        session.tempDate = text;
        session.adminStep = 3;
        await ctx.reply('Escribe el *turno/horario*:', { parse_mode: 'Markdown' });
        return;
      } else if (session.adminStep === 3) {
        session.tempTimeSlot = text;
        session.adminStep = 4;
        await ctx.reply('Escribe los *números ganadores* separados por comas (ej: 12,34,56):', { parse_mode: 'Markdown' });
        return;
      } else if (session.adminStep === 4) {
        const numbers = text.split(',').map(n => n.trim());
        const { error } = await supabase
          .from('winning_numbers')
          .insert({ lottery: session.tempLottery, date: session.tempDate, time_slot: session.tempTimeSlot, numbers });
        if (error) await ctx.reply(`❌ Error: ${error.message}`);
        else await ctx.reply(`✅ Números ganadores de ${session.tempLottery} publicados.`);
        delete session.adminAction;
        delete session.tempLottery;
        delete session.tempDate;
        delete session.tempTimeSlot;
        return;
      }
    }
  }

  // ---------- FLUJO DE APUESTA ----------
  if (session.awaitingBet) {
    const betType = session.betType;
    const lottery = session.lottery || 'Florida';
    const { data: priceData } = await supabase
      .from('play_prices')
      .select('amount_usd, amount_cup')
      .eq('bet_type', betType)
      .single();
    const defaultPrices = priceData || { amount_usd: 0.2, amount_cup: 70 };
    const { ok, usdCost, cupCost } = parseBetCost(text, betType, defaultPrices);
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
    await ctx.replyWithMarkdown(
      `✅ *Jugada registrada*\n🎰 ${lottery} - ${betType}\n📝 \`${text}\`\n💰 Costo: ${usdCost.toFixed(2)} USD / ${cupCost.toFixed(2)} CUP\n🍀 ¡Buena suerte!`
    );
    delete session.awaitingBet;
    delete session.betType;
    delete session.lottery;
    return;
  }

  // ---------- FLUJO DE RETIRO: MONTO ----------
  if (session.awaitingWithdrawAmount) {
    const amount = parseFloat(text.replace(',', '.'));
    if (isNaN(amount) || amount < 1) {
      await ctx.reply('❌ Monto inválido. Debe ser un número mayor o igual a 1.');
      return;
    }
    if (parseFloat(ctx.dbUser.usd) < amount) {
      await ctx.reply('❌ Saldo insuficiente.');
      return;
    }
    session.withdrawAmount = amount;
    session.awaitingWithdrawAccount = true;
    delete session.awaitingWithdrawAmount;
    await ctx.reply('Ahora envía el *número/ID de la tarjeta/cuenta* a la que deseas que retiremos:', { parse_mode: 'Markdown' });
    return;
  }

  // ---------- FLUJO DE RETIRO: CUENTA ----------
  if (session.awaitingWithdrawAccount) {
    const accountInfo = text;
    const amount = session.withdrawAmount;
    const method = session.withdrawMethod;
    const { data: request, error } = await supabase
      .from('withdraw_requests')
      .insert({ user_id: uid, method_id: method.id, amount_usd: amount, account_info: accountInfo, status: 'pending' })
      .select()
      .single();
    if (error) {
      await ctx.reply(`❌ Error al crear la solicitud: ${error.message}`);
    } else {
      await ctx.telegram.sendMessage(ADMIN_CHANNEL,
        `📤 *Nueva solicitud de RETIRO*\n👤 Usuario: ${ctx.from.first_name} (${uid})\n💰 Monto: ${amount} USD\n🏦 Método: ${method.name}\n📞 Cuenta: ${accountInfo}\n🆔 Solicitud: ${request.id}`,
        { parse_mode: 'Markdown', reply_markup: Markup.inlineKeyboard([[Markup.button.callback('✅ Aprobar', `approve_withdraw_${request.id}`), Markup.button.callback('❌ Rechazar', `reject_withdraw_${request.id}`)]]) }
      );
      await ctx.reply(`✅ *Solicitud de retiro enviada*\n💰 Monto: ${amount} USD\n⏳ Procesaremos tu solicitud a la mayor brevedad.`, { parse_mode: 'Markdown' });
    }
    delete session.withdrawAmount;
    delete session.withdrawMethod;
    delete session.awaitingWithdrawAccount;
    return;
  }

  // ---------- FLUJO DE TRANSFERENCIA: TARGET ----------
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
    await ctx.reply(`Ahora envía el *monto en USD* a transferir:\n💰 Tu saldo: ${parseFloat(ctx.dbUser.usd).toFixed(2)} USD`, { parse_mode: 'Markdown' });
    return;
  }

  // ---------- FLUJO DE TRANSFERENCIA: MONTO ----------
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

  // Si nada coincide, menú principal
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
  const response = await axios.get(fileLink, { responseType: 'arraybuffer' });
  const buffer = Buffer.from(response.data);
  const fileName = `deposit_${uid}_${Date.now()}.jpg`;
  const filePath = `deposits/${fileName}`;
  const { error: uploadError } = await supabase.storage
    .from('deposit-screenshots')
    .upload(filePath, buffer, { contentType: 'image/jpeg', upsert: false });
  if (uploadError) {
    await ctx.reply('❌ Error al procesar la captura. Intenta de nuevo.');
    return;
  }
  const { data: { publicUrl } } = supabase.storage
    .from('deposit-screenshots')
    .getPublicUrl(filePath);
  const { data: request, error: insertError } = await supabase
    .from('deposit_requests')
    .insert({ user_id: uid, method_id: method.id, screenshot_url: publicUrl, status: 'pending' })
    .select()
    .single();
  if (insertError) {
    await ctx.reply('❌ Error al registrar la solicitud.');
    return;
  }
  await ctx.telegram.sendMessage(ADMIN_CHANNEL,
    `📥 *Nueva solicitud de DEPÓSITO*\n👤 Usuario: ${ctx.from.first_name} (${uid})\n🏦 Método: ${method.name}\n📎 [Ver captura](${publicUrl})\n🆔 Solicitud: ${request.id}`,
    { parse_mode: 'Markdown', reply_markup: Markup.inlineKeyboard([[Markup.button.callback('✅ Aprobar', `approve_deposit_${request.id}`), Markup.button.callback('❌ Rechazar', `reject_deposit_${request.id}`)]]) }
  );
  await ctx.reply('✅ *Captura recibida*\nTu solicitud de recarga ha sido enviada al administrador. Será acreditada en breve.', { parse_mode: 'Markdown' });
  delete session.awaitingDepositPhoto;
  delete session.depositMethod;
});

// ========== CALLBACKS DE APROBACIÓN/RECHAZO (DESDE CANAL) ==========
bot.action(/approve_deposit_(\d+)/, async (ctx) => {
  if (ctx.from.id !== ADMIN_ID) {
    await ctx.answerCbQuery('No autorizado', { show_alert: true });
    return;
  }
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
  const amountUSD = 10.0;
  const bonusUSD = parseFloat((BONUS_CUP_DEFAULT / (await getExchangeRate())).toFixed(2));
  const { data: user } = await supabase
    .from('users')
    .select('usd, bonus_usd')
    .eq('telegram_id', request.user_id)
    .single();
  await supabase
    .from('users')
    .update({ usd: parseFloat(user.usd) + amountUSD, bonus_usd: parseFloat(user.bonus_usd) + bonusUSD, updated_at: new Date() })
    .eq('telegram_id', request.user_id);
  await supabase
    .from('deposit_requests')
    .update({ status: 'approved', amount: amountUSD, currency: 'USD', updated_at: new Date() })
    .eq('id', requestId);
  await ctx.telegram.sendMessage(request.user_id,
    `✅ *Depósito aprobado*\nSe ha acreditado *${amountUSD} USD* a tu saldo.\n🎁 Bonus: +${bonusUSD} USD\nGracias por confiar en nosotros.`,
    { parse_mode: 'Markdown' }
  );
  await ctx.editMessageReplyMarkup({ inline_keyboard: [] });
  await ctx.reply('✅ Depósito aprobado y acreditado.');
});

bot.action(/reject_deposit_(\d+)/, async (ctx) => {
  if (ctx.from.id !== ADMIN_ID) return;
  const requestId = parseInt(ctx.match[1]);
  await supabase.from('deposit_requests').update({ status: 'rejected', updated_at: new Date() }).eq('id', requestId);
  const { data: request } = await supabase.from('deposit_requests').select('user_id').eq('id', requestId).single();
  if (request) {
    await ctx.telegram.sendMessage(request.user_id, '❌ *Depósito rechazado*\nTu solicitud no pudo ser procesada. Contacta al administrador.', { parse_mode: 'Markdown' });
  }
  await ctx.editMessageReplyMarkup({ inline_keyboard: [] });
  await ctx.reply('❌ Depósito rechazado.');
});

bot.action(/approve_withdraw_(\d+)/, async (ctx) => {
  if (ctx.from.id !== ADMIN_ID) return;
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
    `✅ *Retiro aprobado*\nSe ha procesado tu solicitud por *${request.amount_usd} USD*.\nLos fondos serán enviados a la cuenta proporcionada.`,
    { parse_mode: 'Markdown' }
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
    await ctx.telegram.sendMessage(request.user_id, '❌ *Retiro rechazado*\nTu solicitud no pudo ser procesada.', { parse_mode: 'Markdown' });
  }
  await ctx.editMessageReplyMarkup({ inline_keyboard: [] });
  await ctx.reply('❌ Retiro rechazado.');
});

// ========== EXPORTAR BOT (SIN LANZAR) ==========
module.exports = bot;
