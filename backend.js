// ==============================
// backend.js - API REST para Rifas Cuba
// Sirve WebApp y endpoints, con keep-alive para el bot
// ==============================

require('dotenv').config();
const express = require('express');
const multer = require('multer');
const path = require('path');
const { createClient } = require('@supabase/supabase-js');
const crypto = require('crypto');
const axios = require('axios');
const cors = require('cors');

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

// ========== CONFIGURACIÓN DE MULTER PARA SUBIR ARCHIVOS ==========
const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 5 * 1024 * 1024 } // 5MB
});

// ========== FUNCIONES AUXILIARES ==========

/**
 * Verificar initData de Telegram WebApp
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
 * Obtener o crear usuario en Supabase
 */
async function getOrCreateUser(telegramId, firstName = 'Jugador') {
  let { data: user, error } = await supabase
    .from('users')
    .select('*')
    .eq('telegram_id', telegramId)
    .single();

  if (!user) {
    const { data: newUser, error: insertError } = await supabase
      .from('users')
      .insert({ telegram_id: telegramId, first_name: firstName })
      .select()
      .single();
    user = newUser;
  }
  return user;
}

/**
 * Obtener tasa de cambio actual
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
 * Parsear monto (usd, cup) desde texto
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
 * Parsear costo de apuesta
 */
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
    // Usar precio por defecto
    usdCost = defaultPrices.amount_usd || 0.2;
    cupCost = defaultPrices.amount_cup || 70;
  }
  return { ok: usdCost > 0 || cupCost > 0, usdCost, cupCost };
}

// ========== MIDDLEWARE DE AUTENTICACIÓN PARA ENDPOINTS DE ADMIN ==========
async function requireAdmin(req, res, next) {
  const { userId } = req.body;
  if (!userId || parseInt(userId) !== ADMIN_ID) {
    return res.status(403).json({ error: 'No autorizado' });
  }
  next();
}

// ========== ENDPOINTS PÚBLICOS ==========

/**
 * POST /api/auth
 * Autenticar usuario mediante initData de Telegram
 */
app.post('/api/auth', async (req, res) => {
  const { initData } = req.body;
  if (!initData) {
    return res.status(400).json({ error: 'Falta initData' });
  }

  const verified = verifyTelegramWebAppData(initData, BOT_TOKEN);
  if (!verified) {
    return res.status(401).json({ error: 'Firma inválida' });
  }

  const params = new URLSearchParams(decodeURIComponent(initData));
  const userStr = params.get('user');
  if (!userStr) {
    return res.status(400).json({ error: 'No hay datos de usuario' });
  }

  const tgUser = JSON.parse(userStr);
  const telegramId = tgUser.id;
  const firstName = tgUser.first_name || 'Jugador';

  const user = await getOrCreateUser(telegramId, firstName);
  const exchangeRate = await getExchangeRate();
  const botInfo = await axios.get(`https://api.telegram.org/bot${BOT_TOKEN}/getMe`).then(res => res.data.result).catch(() => ({ username: 'RifasCubaBot' }));

  res.json({
    user,
    isAdmin: telegramId === ADMIN_ID,
    exchangeRate,
    botUsername: botInfo.username
  });
});

/**
 * GET /api/deposit-methods
 * Listar métodos de depósito activos
 */
app.get('/api/deposit-methods', async (req, res) => {
  const { data, error } = await supabase
    .from('deposit_methods')
    .select('*')
    .order('id', { ascending: true });
  if (error) return res.status(500).json({ error: error.message });
  res.json(data);
});

/**
 * GET /api/deposit-methods/:id
 * Obtener un método de depósito por ID
 */
app.get('/api/deposit-methods/:id', async (req, res) => {
  const { id } = req.params;
  const { data, error } = await supabase
    .from('deposit_methods')
    .select('*')
    .eq('id', id)
    .single();
  if (error) return res.status(404).json({ error: 'Método no encontrado' });
  res.json(data);
});

/**
 * GET /api/withdraw-methods
 * Listar métodos de retiro activos
 */
app.get('/api/withdraw-methods', async (req, res) => {
  const { data, error } = await supabase
    .from('withdraw_methods')
    .select('*')
    .order('id', { ascending: true });
  if (error) return res.status(500).json({ error: error.message });
  res.json(data);
});

/**
 * GET /api/withdraw-methods/:id
 * Obtener un método de retiro por ID
 */
app.get('/api/withdraw-methods/:id', async (req, res) => {
  const { id } = req.params;
  const { data, error } = await supabase
    .from('withdraw_methods')
    .select('*')
    .eq('id', id)
    .single();
  if (error) return res.status(404).json({ error: 'Método no encontrado' });
  res.json(data);
});

/**
 * GET /api/play-prices
 * Obtener precios de jugadas
 */
app.get('/api/play-prices', async (req, res) => {
  const { data, error } = await supabase
    .from('play_prices')
    .select('*');
  if (error) return res.status(500).json({ error: error.message });
  const prices = {};
  data.forEach(p => { prices[p.bet_type] = { amount_cup: p.amount_cup, amount_usd: p.amount_usd }; });
  res.json(prices);
});

/**
 * GET /api/exchange-rate
 * Obtener tasa de cambio
 */
app.get('/api/exchange-rate', async (req, res) => {
  const rate = await getExchangeRate();
  res.json({ rate });
});

/**
 * POST /api/deposit-requests
 * Crear una solicitud de depósito (con captura)
 */
app.post('/api/deposit-requests', upload.single('screenshot'), async (req, res) => {
  const { methodId, userId } = req.body;
  const file = req.file;

  if (!methodId || !userId || !file) {
    return res.status(400).json({ error: 'Faltan datos' });
  }

  const user = await getOrCreateUser(parseInt(userId));
  if (!user) return res.status(404).json({ error: 'Usuario no encontrado' });

  const fileName = `deposit_${userId}_${Date.now()}.jpg`;
  const filePath = `deposits/${fileName}`;

  const { error: uploadError } = await supabase.storage
    .from('deposit-screenshots')
    .upload(filePath, file.buffer, { contentType: 'image/jpeg', upsert: false });

  if (uploadError) {
    console.error(uploadError);
    return res.status(500).json({ error: 'Error al subir la captura' });
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
      status: 'pending',
      created_at: new Date()
    })
    .select()
    .single();

  if (insertError) {
    console.error(insertError);
    return res.status(500).json({ error: 'Error al guardar la solicitud' });
  }

  try {
    const method = await supabase.from('deposit_methods').select('name').eq('id', methodId).single();
    const methodName = method.data?.name || 'Desconocido';
    const userInfo = await supabase.from('users').select('first_name').eq('telegram_id', userId).single();
    const firstName = userInfo.data?.first_name || 'Usuario';

    const message = 
      `📥 *Nueva solicitud de DEPÓSITO* (WebApp)\n\n` +
      `👤 Usuario: ${firstName} (${userId})\n` +
      `🏦 Método: ${methodName}\n` +
      `📎 [Ver captura](${publicUrl})\n` +
      `🆔 Solicitud: ${request.id}\n\n` +
      `💬 El usuario no especificó monto. Confirma el monto y luego aprueba.`;

    await axios.post(`https://api.telegram.org/bot${BOT_TOKEN}/sendMessage`, {
      chat_id: ADMIN_CHANNEL,
      text: message,
      parse_mode: 'Markdown',
      reply_markup: {
        inline_keyboard: [
          [
            { text: '✅ Aprobar', callback_data: `approve_deposit_${request.id}` },
            { text: '❌ Rechazar', callback_data: `reject_deposit_${request.id}` }
          ]
        ]
      }
    });
  } catch (e) {
    console.error('Error enviando notificación a Telegram:', e);
  }

  res.json({ success: true, requestId: request.id });
});

/**
 * POST /api/withdraw-requests
 * Crear una solicitud de retiro
 */
app.post('/api/withdraw-requests', async (req, res) => {
  const { methodId, amount, account, userId } = req.body;

  if (!methodId || !amount || !account || !userId) {
    return res.status(400).json({ error: 'Faltan datos' });
  }

  const user = await getOrCreateUser(parseInt(userId));
  if (!user) return res.status(404).json({ error: 'Usuario no encontrado' });

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
      status: 'pending',
      created_at: new Date()
    })
    .select()
    .single();

  if (insertError) {
    console.error(insertError);
    return res.status(500).json({ error: 'Error al crear la solicitud' });
  }

  try {
    const method = await supabase.from('withdraw_methods').select('name').eq('id', methodId).single();
    const methodName = method.data?.name || 'Desconocido';
    const userInfo = await supabase.from('users').select('first_name').eq('telegram_id', userId).single();
    const firstName = userInfo.data?.first_name || 'Usuario';

    const message = 
      `📤 *Nueva solicitud de RETIRO* (WebApp)\n\n` +
      `👤 Usuario: ${firstName} (${userId})\n` +
      `💰 Monto: ${amount} USD\n` +
      `🏦 Método: ${methodName}\n` +
      `📞 Cuenta: ${account}\n` +
      `🆔 Solicitud: ${request.id}`;

    await axios.post(`https://api.telegram.org/bot${BOT_TOKEN}/sendMessage`, {
      chat_id: ADMIN_CHANNEL,
      text: message,
      parse_mode: 'Markdown',
      reply_markup: {
        inline_keyboard: [
          [
            { text: '✅ Aprobar', callback_data: `approve_withdraw_${request.id}` },
            { text: '❌ Rechazar', callback_data: `reject_withdraw_${request.id}` }
          ]
        ]
      }
    });
  } catch (e) {
    console.error('Error enviando notificación:', e);
  }

  res.json({ success: true, requestId: request.id });
});

/**
 * POST /api/bets
 * Registrar una apuesta
 */
app.post('/api/bets', async (req, res) => {
  const { userId, lottery, betType, rawText } = req.body;

  if (!userId || !lottery || !betType || !rawText) {
    return res.status(400).json({ error: 'Faltan datos' });
  }

  const user = await getOrCreateUser(parseInt(userId));
  if (!user) return res.status(404).json({ error: 'Usuario no encontrado' });

  const { data: priceData } = await supabase
    .from('play_prices')
    .select('amount_usd, amount_cup')
    .eq('bet_type', betType)
    .single();

  const defaultPrices = priceData || { amount_usd: 0.2, amount_cup: 70 };
  const { ok, usdCost, cupCost } = parseBetCost(rawText, betType, defaultPrices);

  if (!ok) {
    return res.status(400).json({ error: 'Formato de jugada no reconocido' });
  }

  let newUsd = parseFloat(user.usd);
  let newBonus = parseFloat(user.bonus_usd);
  let newCup = parseFloat(user.cup);

  if (usdCost > 0) {
    const totalUSD = newUsd + newBonus;
    if (totalUSD < usdCost) {
      return res.status(400).json({ error: 'Saldo USD insuficiente (incluyendo bono)' });
    }
    const useBonus = Math.min(newBonus, usdCost);
    newBonus -= useBonus;
    newUsd -= (usdCost - useBonus);
  } else if (cupCost > 0) {
    if (newCup < cupCost) {
      return res.status(400).json({ error: 'Saldo CUP insuficiente' });
    }
    newCup -= cupCost;
  }

  const { error: updateError } = await supabase
    .from('users')
    .update({
      usd: newUsd,
      bonus_usd: newBonus,
      cup: newCup,
      updated_at: new Date()
    })
    .eq('telegram_id', userId);

  if (updateError) {
    console.error(updateError);
    return res.status(500).json({ error: 'Error al actualizar saldo' });
  }

  const { data: bet, error: betError } = await supabase
    .from('bets')
    .insert({
      user_id: parseInt(userId),
      lottery,
      bet_type: betType,
      raw_text: rawText,
      cost_usd: usdCost,
      cost_cup: cupCost,
      placed_at: new Date()
    })
    .select()
    .single();

  if (betError) {
    console.error(betError);
    return res.status(500).json({ error: 'Error al registrar apuesta' });
  }

  const updatedUser = await getOrCreateUser(parseInt(userId));

  res.json({
    success: true,
    bet,
    updatedUser
  });
});

/**
 * GET /api/user/:userId/bets
 * Obtener apuestas de un usuario
 */
app.get('/api/user/:userId/bets', async (req, res) => {
  const { userId } = req.params;
  const limit = parseInt(req.query.limit) || 5;

  const { data, error } = await supabase
    .from('bets')
    .select('*')
    .eq('user_id', userId)
    .order('placed_at', { ascending: false })
    .limit(limit);

  if (error) return res.status(500).json({ error: error.message });
  res.json(data);
});

/**
 * GET /api/user/:userId/referrals/count
 * Obtener número de referidos
 */
app.get('/api/user/:userId/referrals/count', async (req, res) => {
  const { userId } = req.params;
  const { count, error } = await supabase
    .from('users')
    .select('*', { count: 'exact', head: true })
    .eq('ref_by', userId);

  if (error) return res.status(500).json({ error: error.message });
  res.json({ count });
});

/**
 * POST /api/transfer
 * Transferir saldo entre usuarios
 */
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

  const { error: errorFrom } = await supabase
    .from('users')
    .update({ usd: parseFloat(userFrom.usd) - amount, updated_at: new Date() })
    .eq('telegram_id', from);

  if (errorFrom) {
    return res.status(500).json({ error: 'Error al debitar' });
  }

  const { error: errorTo } = await supabase
    .from('users')
    .update({ usd: parseFloat(userTo.usd) + amount, updated_at: new Date() })
    .eq('telegram_id', to);

  if (errorTo) {
    await supabase
      .from('users')
      .update({ usd: parseFloat(userFrom.usd), updated_at: new Date() })
      .eq('telegram_id', from);
    return res.status(500).json({ error: 'Error al acreditar' });
  }

  res.json({ success: true });
});

// ========== ENDPOINTS DE ADMIN ==========

/**
 * POST /api/admin/deposit-methods
 * Crear método de depósito
 */
app.post('/api/admin/deposit-methods', requireAdmin, async (req, res) => {
  const { name, card, confirm, userId } = req.body;
  if (!name || !card || !confirm) {
    return res.status(400).json({ error: 'Faltan datos' });
  }
  const { data, error } = await supabase
    .from('deposit_methods')
    .insert({ name, card, confirm })
    .select()
    .single();
  if (error) return res.status(500).json({ error: error.message });
  res.json(data);
});

/**
 * PUT /api/admin/deposit-methods/:id
 * Editar método de depósito
 */
app.put('/api/admin/deposit-methods/:id', requireAdmin, async (req, res) => {
  const { id } = req.params;
  const { name, card, confirm, userId } = req.body;
  const { data, error } = await supabase
    .from('deposit_methods')
    .update({ name, card, confirm })
    .eq('id', id)
    .select()
    .single();
  if (error) return res.status(500).json({ error: error.message });
  res.json(data);
});

/**
 * DELETE /api/admin/deposit-methods/:id
 * Eliminar método de depósito
 */
app.delete('/api/admin/deposit-methods/:id', requireAdmin, async (req, res) => {
  const { id } = req.params;
  const { userId } = req.body;
  const { error } = await supabase
    .from('deposit_methods')
    .delete()
    .eq('id', id);
  if (error) return res.status(500).json({ error: error.message });
  res.json({ success: true });
});

/**
 * POST /api/admin/withdraw-methods
 * Crear método de retiro
 */
app.post('/api/admin/withdraw-methods', requireAdmin, async (req, res) => {
  const { name, card, confirm, userId } = req.body;
  if (!name || !card || !confirm) {
    return res.status(400).json({ error: 'Faltan datos' });
  }
  const { data, error } = await supabase
    .from('withdraw_methods')
    .insert({ name, card, confirm })
    .select()
    .single();
  if (error) return res.status(500).json({ error: error.message });
  res.json(data);
});

/**
 * PUT /api/admin/withdraw-methods/:id
 * Editar método de retiro
 */
app.put('/api/admin/withdraw-methods/:id', requireAdmin, async (req, res) => {
  const { id } = req.params;
  const { name, card, confirm, userId } = req.body;
  const { data, error } = await supabase
    .from('withdraw_methods')
    .update({ name, card, confirm })
    .eq('id', id)
    .select()
    .single();
  if (error) return res.status(500).json({ error: error.message });
  res.json(data);
});

/**
 * DELETE /api/admin/withdraw-methods/:id
 * Eliminar método de retiro
 */
app.delete('/api/admin/withdraw-methods/:id', requireAdmin, async (req, res) => {
  const { id } = req.params;
  const { userId } = req.body;
  const { error } = await supabase
    .from('withdraw_methods')
    .delete()
    .eq('id', id);
  if (error) return res.status(500).json({ error: error.message });
  res.json({ success: true });
});

/**
 * PUT /api/admin/exchange-rate
 * Actualizar tasa de cambio
 */
app.put('/api/admin/exchange-rate', requireAdmin, async (req, res) => {
  const { rate, userId } = req.body;
  if (!rate || rate <= 0) {
    return res.status(400).json({ error: 'Tasa inválida' });
  }
  const { error } = await supabase
    .from('exchange_rate')
    .update({ rate, updated_at: new Date() })
    .eq('id', 1);
  if (error) return res.status(500).json({ error: error.message });
  res.json({ success: true, rate });
});

/**
 * PUT /api/admin/play-prices/:betType
 * Actualizar precio de una jugada
 */
app.put('/api/admin/play-prices/:betType', requireAdmin, async (req, res) => {
  const { betType } = req.params;
  const { amount_cup, amount_usd, userId } = req.body;
  if (!amount_cup || !amount_usd) {
    return res.status(400).json({ error: 'Faltan montos' });
  }
  const { error } = await supabase
    .from('play_prices')
    .update({ amount_cup, amount_usd, updated_at: new Date() })
    .eq('bet_type', betType);
  if (error) return res.status(500).json({ error: error.message });
  res.json({ success: true });
});

/**
 * GET /api/admin/pending-deposits
 * Listar depósitos pendientes
 */
app.get('/api/admin/pending-deposits', requireAdmin, async (req, res) => {
  const { userId } = req.query;
  if (parseInt(userId) !== ADMIN_ID) return res.status(403).json({ error: 'No autorizado' });
  const { data, error } = await supabase
    .from('deposit_requests')
    .select('*, users(first_name, telegram_id), deposit_methods(name)')
    .eq('status', 'pending')
    .order('created_at', { ascending: false });
  if (error) return res.status(500).json({ error: error.message });
  res.json(data);
});

/**
 * POST /api/admin/approve-deposit/:id
 * Aprobar depósito (con monto y opcional bono)
 */
app.post('/api/admin/approve-deposit/:id', requireAdmin, async (req, res) => {
  const { id } = req.params;
  const { amount_usd, bonus_usd, userId } = req.body;

  if (!amount_usd || amount_usd <= 0) {
    return res.status(400).json({ error: 'Monto inválido' });
  }

  const { data: request, error: fetchError } = await supabase
    .from('deposit_requests')
    .select('*')
    .eq('id', id)
    .single();

  if (fetchError || !request) {
    return res.status(404).json({ error: 'Solicitud no encontrada' });
  }

  const { data: user } = await supabase
    .from('users')
    .select('usd, bonus_usd')
    .eq('telegram_id', request.user_id)
    .single();

  const newUsd = parseFloat(user.usd) + parseFloat(amount_usd);
  const newBonus = parseFloat(user.bonus_usd) + (parseFloat(bonus_usd) || 0);

  await supabase
    .from('users')
    .update({ usd: newUsd, bonus_usd: newBonus, updated_at: new Date() })
    .eq('telegram_id', request.user_id);

  await supabase
    .from('deposit_requests')
    .update({ status: 'approved', amount: amount_usd, currency: 'USD', updated_at: new Date() })
    .eq('id', id);

  try {
    await axios.post(`https://api.telegram.org/bot${BOT_TOKEN}/sendMessage`, {
      chat_id: request.user_id,
      text: `✅ *Depósito aprobado*\nSe ha acreditado *${amount_usd} USD* a tu saldo.\n🎁 Bonus: +${bonus_usd || 0} USD\nGracias por confiar en nosotros.`,
      parse_mode: 'Markdown'
    });
  } catch (e) {}

  res.json({ success: true });
});

/**
 * POST /api/admin/reject-deposit/:id
 * Rechazar depósito
 */
app.post('/api/admin/reject-deposit/:id', requireAdmin, async (req, res) => {
  const { id } = req.params;
  const { userId } = req.body;

  await supabase
    .from('deposit_requests')
    .update({ status: 'rejected', updated_at: new Date() })
    .eq('id', id);

  const { data: request } = await supabase
    .from('deposit_requests')
    .select('user_id')
    .eq('id', id)
    .single();

  if (request) {
    try {
      await axios.post(`https://api.telegram.org/bot${BOT_TOKEN}/sendMessage`, {
        chat_id: request.user_id,
        text: '❌ *Depósito rechazado*\nTu solicitud de recarga no pudo ser procesada. Contacta al administrador.',
        parse_mode: 'Markdown'
      });
    } catch (e) {}
  }

  res.json({ success: true });
});

/**
 * GET /api/admin/pending-withdraws
 * Listar retiros pendientes
 */
app.get('/api/admin/pending-withdraws', requireAdmin, async (req, res) => {
  const { userId } = req.query;
  if (parseInt(userId) !== ADMIN_ID) return res.status(403).json({ error: 'No autorizado' });
  const { data, error } = await supabase
    .from('withdraw_requests')
    .select('*, users(first_name, telegram_id), withdraw_methods(name)')
    .eq('status', 'pending')
    .order('created_at', { ascending: false });
  if (error) return res.status(500).json({ error: error.message });
  res.json(data);
});

/**
 * POST /api/admin/approve-withdraw/:id
 * Aprobar retiro
 */
app.post('/api/admin/approve-withdraw/:id', requireAdmin, async (req, res) => {
  const { id } = req.params;
  const { userId } = req.body;

  const { data: request, error: fetchError } = await supabase
    .from('withdraw_requests')
    .select('*')
    .eq('id', id)
    .single();

  if (fetchError || !request) {
    return res.status(404).json({ error: 'Solicitud no encontrada' });
  }

  const { data: user } = await supabase
    .from('users')
    .select('usd')
    .eq('telegram_id', request.user_id)
    .single();

  if (parseFloat(user.usd) < request.amount_usd) {
    return res.status(400).json({ error: 'Saldo insuficiente en la cuenta del usuario' });
  }

  await supabase
    .from('users')
    .update({ usd: parseFloat(user.usd) - request.amount_usd, updated_at: new Date() })
    .eq('telegram_id', request.user_id);

  await supabase
    .from('withdraw_requests')
    .update({ status: 'approved', updated_at: new Date() })
    .eq('id', id);

  try {
    await axios.post(`https://api.telegram.org/bot${BOT_TOKEN}/sendMessage`, {
      chat_id: request.user_id,
      text: `✅ *Retiro aprobado*\nSe ha procesado tu solicitud por *${request.amount_usd} USD*.\nLos fondos serán enviados a la cuenta proporcionada.`,
      parse_mode: 'Markdown'
    });
  } catch (e) {}

  res.json({ success: true });
});

/**
 * POST /api/admin/reject-withdraw/:id
 * Rechazar retiro
 */
app.post('/api/admin/reject-withdraw/:id', requireAdmin, async (req, res) => {
  const { id } = req.params;
  const { userId } = req.body;

  await supabase
    .from('withdraw_requests')
    .update({ status: 'rejected', updated_at: new Date() })
    .eq('id', id);

  const { data: request } = await supabase
    .from('withdraw_requests')
    .select('user_id')
    .eq('id', id)
    .single();

  if (request) {
    try {
      await axios.post(`https://api.telegram.org/bot${BOT_TOKEN}/sendMessage`, {
        chat_id: request.user_id,
        text: '❌ *Retiro rechazado*\nTu solicitud de retiro no pudo ser procesada. Contacta al administrador.',
        parse_mode: 'Markdown'
      });
    } catch (e) {}
  }

  res.json({ success: true });
});

// ========== NUEVAS FUNCIONALIDADES DE ADMIN: NÚMEROS GANADORES Y SESIONES ==========

/**
 * POST /api/admin/lottery-sessions
 * Crear una nueva sesión de lotería (abrir período)
 */
app.post('/api/admin/lottery-sessions', requireAdmin, async (req, res) => {
  const { lottery, date, time_slot, userId } = req.body;
  if (!lottery || !date || !time_slot) {
    return res.status(400).json({ error: 'Faltan datos' });
  }

  const { data, error } = await supabase
    .from('lottery_sessions')
    .insert({
      lottery,
      date,
      time_slot,
      status: 'open',
      created_at: new Date()
    })
    .select()
    .single();

  if (error) return res.status(500).json({ error: error.message });
  res.json(data);
});

/**
 * PUT /api/admin/lottery-sessions/:id/close
 * Cerrar una sesión de lotería
 */
app.put('/api/admin/lottery-sessions/:id/close', requireAdmin, async (req, res) => {
  const { id } = req.params;
  const { userId } = req.body;
  const { error } = await supabase
    .from('lottery_sessions')
    .update({ status: 'closed', updated_at: new Date() })
    .eq('id', id);
  if (error) return res.status(500).json({ error: error.message });
  res.json({ success: true });
});

/**
 * POST /api/admin/winning-numbers
 * Publicar números ganadores
 */
app.post('/api/admin/winning-numbers', requireAdmin, async (req, res) => {
  const { lottery, date, time_slot, numbers, userId } = req.body;
  if (!lottery || !date || !time_slot || !numbers) {
    return res.status(400).json({ error: 'Faltan datos' });
  }

  const { data, error } = await supabase
    .from('winning_numbers')
    .insert({
      lottery,
      date,
      time_slot,
      numbers: Array.isArray(numbers) ? numbers : [numbers],
      published_at: new Date()
    })
    .select()
    .single();

  if (error) return res.status(500).json({ error: error.message });

  res.json(data);
});

/**
 * GET /api/winning-numbers
 * Obtener últimos números ganadores (para usuarios)
 */
app.get('/api/winning-numbers', async (req, res) => {
  const { data, error } = await supabase
    .from('winning_numbers')
    .select('*')
    .order('published_at', { ascending: false })
    .limit(10);
  if (error) return res.status(500).json({ error: error.message });
  res.json(data);
});

// ========== KEEP-ALIVE PARA EL BOT ==========
setInterval(async () => {
  try {
    await axios.get(`https://api.telegram.org/bot${BOT_TOKEN}/getMe`);
    console.log('[Keep-Alive] Ping a Telegram OK');
  } catch (e) {
    console.error('[Keep-Alive] Error:', e.message);
  }
}, 5 * 60 * 1000); // 5 minutos

// ========== SERVIDOR ESTÁTICO PARA WEBAPP ==========
app.get('/', (req, res) => {
  res.sendFile(path.join(__dirname, 'webapp', 'index.html'));
});

// ========== INICIAR SERVIDOR ==========
app.listen(PORT, () => {
  console.log(`🚀 Backend de Rifas Cuba corriendo en http://localhost:${PORT}`);
  console.log(`📡 WebApp servida en ${WEBAPP_URL}`);
  console.log(`🤖 Keep-alive activado (cada 5 minutos)`);
});

module.exports = app;

// ========== INICIAR BOT DE TELEGRAM ==========
const bot = require('./bot'); // Importar el bot

bot.launch()
  .then(() => console.log('🤖 Bot de Telegram iniciado correctamente'))
  .catch(err => console.error('❌ Error al iniciar el bot:', err));

// Graceful stop
process.once('SIGINT', () => bot.stop('SIGINT'));
process.once('SIGTERM', () => bot.stop('SIGTERM'));
