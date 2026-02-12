// ==============================
// backend.js - API REST + Bot de Telegram (unificado)
// Sirve WebApp, endpoints API y lanza el bot
// ==============================

require('dotenv').config();
const express = require('express');
const multer = require('multer');
const path = require('path');
const { createClient } = require('@supabase/supabase-js');
const crypto = require('crypto');
const axios = require('axios');
const cors = require('cors');

// ========== IMPORTAR BOT ==========
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

async function getExchangeRate() {
  const { data } = await supabase
    .from('exchange_rate')
    .select('rate')
    .eq('id', 1)
    .single();
  return data?.rate || 110;
}

// ========== MIDDLEWARE DE ADMIN ==========
async function requireAdmin(req, res, next) {
  const { userId } = req.body;
  if (!userId || parseInt(userId) !== ADMIN_ID) {
    return res.status(403).json({ error: 'No autorizado' });
  }
  next();
}

// ========== ENDPOINTS PÚBLICOS ==========
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
  const botInfo = await axios.get(`https://api.telegram.org/bot${BOT_TOKEN}/getMe`).then(r => r.data.result).catch(() => ({ username: 'RifasCubaBot' }));
  res.json({ user, isAdmin: tgUser.id === ADMIN_ID, exchangeRate, botUsername: botInfo.username });
});

app.get('/api/deposit-methods', async (req, res) => {
  const { data } = await supabase.from('deposit_methods').select('*').order('id');
  res.json(data);
});
app.get('/api/deposit-methods/:id', async (req, res) => {
  const { data } = await supabase.from('deposit_methods').select('*').eq('id', req.params.id).single();
  res.json(data);
});
app.get('/api/withdraw-methods', async (req, res) => {
  const { data } = await supabase.from('withdraw_methods').select('*').order('id');
  res.json(data);
});
app.get('/api/withdraw-methods/:id', async (req, res) => {
  const { data } = await supabase.from('withdraw_methods').select('*').eq('id', req.params.id).single();
  res.json(data);
});
app.get('/api/play-prices', async (req, res) => {
  const { data } = await supabase.from('play_prices').select('*');
  res.json(data);
});
app.get('/api/exchange-rate', async (req, res) => {
  const rate = await getExchangeRate();
  res.json({ rate });
});
app.get('/api/winning-numbers', async (req, res) => {
  const { data } = await supabase.from('winning_numbers').select('*').order('published_at', { ascending: false }).limit(10);
  res.json(data);
});

app.post('/api/deposit-requests', upload.single('screenshot'), async (req, res) => {
  const { methodId, userId } = req.body;
  const file = req.file;
  if (!methodId || !userId || !file) return res.status(400).json({ error: 'Faltan datos' });
  const user = await getOrCreateUser(parseInt(userId));
  const fileName = `deposit_${userId}_${Date.now()}.jpg`;
  const filePath = `deposits/${fileName}`;
  const { error: uploadError } = await supabase.storage
    .from('deposit-screenshots')
    .upload(filePath, file.buffer, { contentType: 'image/jpeg' });
  if (uploadError) return res.status(500).json({ error: 'Error al subir captura' });
  const { data: { publicUrl } } = supabase.storage.from('deposit-screenshots').getPublicUrl(filePath);
  const { data: request, error: insertError } = await supabase
    .from('deposit_requests')
    .insert({ user_id: parseInt(userId), method_id: parseInt(methodId), screenshot_url: publicUrl, status: 'pending' })
    .select()
    .single();
  if (insertError) return res.status(500).json({ error: 'Error al guardar solicitud' });
  try {
    const method = await supabase.from('deposit_methods').select('name').eq('id', methodId).single();
    const methodName = method.data?.name || 'Desconocido';
    await axios.post(`https://api.telegram.org/bot${BOT_TOKEN}/sendMessage`, {
      chat_id: ADMIN_CHANNEL,
      text: `📥 *Nueva solicitud de DEPÓSITO* (WebApp)\n👤 Usuario: ${user.first_name} (${userId})\n🏦 Método: ${methodName}\n📎 [Ver captura](${publicUrl})\n🆔 Solicitud: ${request.id}`,
      parse_mode: 'Markdown',
      reply_markup: {
        inline_keyboard: [[
          { text: '✅ Aprobar', callback_data: `approve_deposit_${request.id}` },
          { text: '❌ Rechazar', callback_data: `reject_deposit_${request.id}` }
        ]]
      }
    });
  } catch (e) { console.error('Error enviando notificación:', e); }
  res.json({ success: true, requestId: request.id });
});

app.post('/api/withdraw-requests', async (req, res) => {
  const { methodId, amount, account, userId } = req.body;
  if (!methodId || !amount || !account || !userId) return res.status(400).json({ error: 'Faltan datos' });
  const user = await getOrCreateUser(parseInt(userId));
  if (parseFloat(user.usd) < amount) return res.status(400).json({ error: 'Saldo insuficiente' });
  const { data: request, error: insertError } = await supabase
    .from('withdraw_requests')
    .insert({ user_id: parseInt(userId), method_id: parseInt(methodId), amount_usd: amount, account_info: account, status: 'pending' })
    .select()
    .single();
  if (insertError) return res.status(500).json({ error: 'Error al crear solicitud' });
  try {
    const method = await supabase.from('withdraw_methods').select('name').eq('id', methodId).single();
    const methodName = method.data?.name || 'Desconocido';
    await axios.post(`https://api.telegram.org/bot${BOT_TOKEN}/sendMessage`, {
      chat_id: ADMIN_CHANNEL,
      text: `📤 *Nueva solicitud de RETIRO* (WebApp)\n👤 Usuario: ${user.first_name} (${userId})\n💰 Monto: ${amount} USD\n🏦 Método: ${methodName}\n📞 Cuenta: ${account}\n🆔 Solicitud: ${request.id}`,
      parse_mode: 'Markdown',
      reply_markup: {
        inline_keyboard: [[
          { text: '✅ Aprobar', callback_data: `approve_withdraw_${request.id}` },
          { text: '❌ Rechazar', callback_data: `reject_withdraw_${request.id}` }
        ]]
      }
    });
  } catch (e) { console.error('Error enviando notificación:', e); }
  res.json({ success: true, requestId: request.id });
});

app.post('/api/bets', async (req, res) => {
  const { userId, lottery, betType, rawText } = req.body;
  if (!userId || !lottery || !betType || !rawText) return res.status(400).json({ error: 'Faltan datos' });
  const user = await getOrCreateUser(parseInt(userId));
  const { data: priceData } = await supabase.from('play_prices').select('amount_usd, amount_cup').eq('bet_type', betType).single();
  const defaultPrices = priceData || { amount_usd: 0.2, amount_cup: 70 };
  const lower = rawText.toLowerCase();
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
  if (usdCost === 0 && cupCost === 0) return res.status(400).json({ error: 'Formato de jugada no reconocido' });
  let newUsd = parseFloat(user.usd), newBonus = parseFloat(user.bonus_usd), newCup = parseFloat(user.cup);
  if (usdCost > 0) {
    const totalUSD = newUsd + newBonus;
    if (totalUSD < usdCost) return res.status(400).json({ error: 'Saldo USD insuficiente' });
    const useBonus = Math.min(newBonus, usdCost);
    newBonus -= useBonus;
    newUsd -= (usdCost - useBonus);
  } else if (cupCost > 0) {
    if (newCup < cupCost) return res.status(400).json({ error: 'Saldo CUP insuficiente' });
    newCup -= cupCost;
  }
  await supabase.from('users').update({ usd: newUsd, bonus_usd: newBonus, cup: newCup, updated_at: new Date() }).eq('telegram_id', userId);
  const { data: bet } = await supabase.from('bets').insert({
    user_id: parseInt(userId), lottery, bet_type: betType, raw_text: rawText, cost_usd: usdCost, cost_cup: cupCost, placed_at: new Date()
  }).select().single();
  const updatedUser = await getOrCreateUser(parseInt(userId));
  res.json({ success: true, bet, updatedUser });
});

app.get('/api/user/:userId/bets', async (req, res) => {
  const { userId } = req.params;
  const limit = parseInt(req.query.limit) || 5;
  const { data } = await supabase.from('bets').select('*').eq('user_id', userId).order('placed_at', { ascending: false }).limit(limit);
  res.json(data);
});

app.get('/api/user/:userId/referrals/count', async (req, res) => {
  const { userId } = req.params;
  const { count } = await supabase.from('users').select('*', { count: 'exact', head: true }).eq('ref_by', userId);
  res.json({ count });
});

app.post('/api/transfer', async (req, res) => {
  const { from, to, amount } = req.body;
  if (!from || !to || !amount || amount <= 0) return res.status(400).json({ error: 'Datos inválidos' });
  if (from === to) return res.status(400).json({ error: 'No puedes transferirte a ti mismo' });
  const userFrom = await getOrCreateUser(parseInt(from));
  const userTo = await getOrCreateUser(parseInt(to));
  if (!userFrom || !userTo) return res.status(404).json({ error: 'Usuario no encontrado' });
  if (parseFloat(userFrom.usd) < amount) return res.status(400).json({ error: 'Saldo insuficiente' });
  await supabase.from('users').update({ usd: parseFloat(userFrom.usd) - amount, updated_at: new Date() }).eq('telegram_id', from);
  await supabase.from('users').update({ usd: parseFloat(userTo.usd) + amount, updated_at: new Date() }).eq('telegram_id', to);
  res.json({ success: true });
});

// ========== ENDPOINTS DE ADMIN ==========
app.post('/api/admin/deposit-methods', requireAdmin, async (req, res) => {
  const { name, card, confirm } = req.body;
  const { data } = await supabase.from('deposit_methods').insert({ name, card, confirm }).select().single();
  res.json(data);
});
app.put('/api/admin/deposit-methods/:id', requireAdmin, async (req, res) => {
  const { id } = req.params;
  const { name, card, confirm } = req.body;
  const { data } = await supabase.from('deposit_methods').update({ name, card, confirm }).eq('id', id).select().single();
  res.json(data);
});
app.delete('/api/admin/deposit-methods/:id', requireAdmin, async (req, res) => {
  const { id } = req.params;
  await supabase.from('deposit_methods').delete().eq('id', id);
  res.json({ success: true });
});
app.post('/api/admin/withdraw-methods', requireAdmin, async (req, res) => {
  const { name, card, confirm } = req.body;
  const { data } = await supabase.from('withdraw_methods').insert({ name, card, confirm }).select().single();
  res.json(data);
});
app.put('/api/admin/withdraw-methods/:id', requireAdmin, async (req, res) => {
  const { id } = req.params;
  const { name, card, confirm } = req.body;
  const { data } = await supabase.from('withdraw_methods').update({ name, card, confirm }).eq('id', id).select().single();
  res.json(data);
});
app.delete('/api/admin/withdraw-methods/:id', requireAdmin, async (req, res) => {
  const { id } = req.params;
  await supabase.from('withdraw_methods').delete().eq('id', id);
  res.json({ success: true });
});
app.put('/api/admin/exchange-rate', requireAdmin, async (req, res) => {
  const { rate } = req.body;
  if (!rate || rate <= 0) return res.status(400).json({ error: 'Tasa inválida' });
  await supabase.from('exchange_rate').update({ rate, updated_at: new Date() }).eq('id', 1);
  res.json({ success: true, rate });
});
app.put('/api/admin/play-prices/:betType', requireAdmin, async (req, res) => {
  const { betType } = req.params;
  const { amount_cup, amount_usd } = req.body;
  if (!amount_cup || !amount_usd) return res.status(400).json({ error: 'Faltan montos' });
  await supabase.from('play_prices').update({ amount_cup, amount_usd, updated_at: new Date() }).eq('bet_type', betType);
  res.json({ success: true });
});
app.get('/api/admin/pending-deposits', requireAdmin, async (req, res) => {
  const { data } = await supabase
    .from('deposit_requests')
    .select('*, users(first_name, telegram_id), deposit_methods(name)')
    .eq('status', 'pending')
    .order('created_at', { ascending: false });
  res.json(data);
});
app.post('/api/admin/approve-deposit/:id', requireAdmin, async (req, res) => {
  const { id } = req.params;
  const { amount_usd, bonus_usd } = req.body;
  if (!amount_usd || amount_usd <= 0) return res.status(400).json({ error: 'Monto inválido' });
  const { data: request } = await supabase.from('deposit_requests').select('*').eq('id', id).single();
  if (!request) return res.status(404).json({ error: 'Solicitud no encontrada' });
  const { data: user } = await supabase.from('users').select('usd, bonus_usd').eq('telegram_id', request.user_id).single();
  await supabase.from('users').update({
    usd: parseFloat(user.usd) + parseFloat(amount_usd),
    bonus_usd: parseFloat(user.bonus_usd) + (parseFloat(bonus_usd) || 0),
    updated_at: new Date()
  }).eq('telegram_id', request.user_id);
  await supabase.from('deposit_requests').update({ status: 'approved', amount: amount_usd, currency: 'USD', updated_at: new Date() }).eq('id', id);
  try {
    await axios.post(`https://api.telegram.org/bot${BOT_TOKEN}/sendMessage`, {
      chat_id: request.user_id,
      text: `✅ *Depósito aprobado*\nSe ha acreditado *${amount_usd} USD* a tu saldo.\n🎁 Bonus: +${bonus_usd || 0} USD`,
      parse_mode: 'Markdown'
    });
  } catch (e) {}
  res.json({ success: true });
});
app.post('/api/admin/reject-deposit/:id', requireAdmin, async (req, res) => {
  const { id } = req.params;
  await supabase.from('deposit_requests').update({ status: 'rejected', updated_at: new Date() }).eq('id', id);
  const { data: request } = await supabase.from('deposit_requests').select('user_id').eq('id', id).single();
  if (request) {
    try {
      await axios.post(`https://api.telegram.org/bot${BOT_TOKEN}/sendMessage`, {
        chat_id: request.user_id,
        text: '❌ *Depósito rechazado*\nTu solicitud no pudo ser procesada.',
        parse_mode: 'Markdown'
      });
    } catch (e) {}
  }
  res.json({ success: true });
});
app.get('/api/admin/pending-withdraws', requireAdmin, async (req, res) => {
  const { data } = await supabase
    .from('withdraw_requests')
    .select('*, users(first_name, telegram_id), withdraw_methods(name)')
    .eq('status', 'pending')
    .order('created_at', { ascending: false });
  res.json(data);
});
app.post('/api/admin/approve-withdraw/:id', requireAdmin, async (req, res) => {
  const { id } = req.params;
  const { data: request } = await supabase.from('withdraw_requests').select('*').eq('id', id).single();
  if (!request) return res.status(404).json({ error: 'Solicitud no encontrada' });
  const { data: user } = await supabase.from('users').select('usd').eq('telegram_id', request.user_id).single();
  if (parseFloat(user.usd) < request.amount_usd) return res.status(400).json({ error: 'Saldo insuficiente' });
  await supabase.from('users').update({ usd: parseFloat(user.usd) - request.amount_usd, updated_at: new Date() }).eq('telegram_id', request.user_id);
  await supabase.from('withdraw_requests').update({ status: 'approved', updated_at: new Date() }).eq('id', id);
  try {
    await axios.post(`https://api.telegram.org/bot${BOT_TOKEN}/sendMessage`, {
      chat_id: request.user_id,
      text: `✅ *Retiro aprobado*\nSe ha procesado tu solicitud por *${request.amount_usd} USD*.`,
      parse_mode: 'Markdown'
    });
  } catch (e) {}
  res.json({ success: true });
});
app.post('/api/admin/reject-withdraw/:id', requireAdmin, async (req, res) => {
  const { id } = req.params;
  await supabase.from('withdraw_requests').update({ status: 'rejected', updated_at: new Date() }).eq('id', id);
  const { data: request } = await supabase.from('withdraw_requests').select('user_id').eq('id', id).single();
  if (request) {
    try {
      await axios.post(`https://api.telegram.org/bot${BOT_TOKEN}/sendMessage`, {
        chat_id: request.user_id,
        text: '❌ *Retiro rechazado*\nTu solicitud no pudo ser procesada.',
        parse_mode: 'Markdown'
      });
    } catch (e) {}
  }
  res.json({ success: true });
});

// ========== ENDPOINTS DE ADMIN PARA LOTERÍA ==========
app.post('/api/admin/lottery-sessions', requireAdmin, async (req, res) => {
  const { lottery, date, time_slot } = req.body;
  const { data } = await supabase.from('lottery_sessions').insert({ lottery, date, time_slot, status: 'open' }).select().single();
  res.json(data);
});
app.put('/api/admin/lottery-sessions/:id/close', requireAdmin, async (req, res) => {
  const { id } = req.params;
  await supabase.from('lottery_sessions').update({ status: 'closed', updated_at: new Date() }).eq('id', id);
  res.json({ success: true });
});
app.post('/api/admin/winning-numbers', requireAdmin, async (req, res) => {
  const { lottery, date, time_slot, numbers } = req.body;
  const { data } = await supabase.from('winning_numbers').insert({ lottery, date, time_slot, numbers, published_at: new Date() }).select().single();
  res.json(data);
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

// Lanzar el bot
bot.launch()
  .then(() => console.log('🤖 Bot de Telegram iniciado correctamente'))
  .catch(err => console.error('❌ Error al iniciar el bot:', err));

// Graceful stop
process.once('SIGINT', () => bot.stop('SIGINT'));
process.once('SIGTERM', () => bot.stop('SIGTERM'));

module.exports = app;
