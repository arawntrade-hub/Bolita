#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
Bot de Rifas Cuba - Versión unificada con WebApp
- Todas las funcionalidades del bot original
- Recibe acciones desde la WebApp via web_app_data
- Notifica al admin de nuevas transacciones
- Se ejecuta como módulo desde Flask o standalone
"""

import os
import json
import logging
import re
import threading
from datetime import datetime, time
from typing import Dict, List, Optional, Tuple

import pytz
import telebot
from telebot import types
from dotenv import load_dotenv
from supabase import create_client, Client

# ========== Cargar configuración ==========
load_dotenv()

BOT_TOKEN = os.getenv("BOT_TOKEN")
ADMIN_ID = int(os.getenv("ADMIN_ID", "0"))
TIMEZONE = os.getenv("TIMEZONE", "America/Havana")
BONUS_CUP_DEFAULT = float(os.getenv("BONUS_CUP_DEFAULT", "70"))
SUPABASE_URL = os.getenv("SUPABASE_URL")
SUPABASE_KEY = os.getenv("SUPABASE_KEY")
ADMIN_CHAT_ID = int(os.getenv("ADMIN_CHAT_ID", "0"))
WEBAPP_URL = os.getenv("WEBAPP_URL")  # URL de la WebApp (se usa en el menú)

if not all([BOT_TOKEN, SUPABASE_URL, SUPABASE_KEY, WEBAPP_URL]):
    raise ValueError("Faltan variables de entorno: BOT_TOKEN, SUPABASE_URL, SUPABASE_KEY, WEBAPP_URL")
if ADMIN_CHAT_ID == 0:
    raise ValueError("ADMIN_CHAT_ID no configurado")

# ========== Configurar logging ==========
logging.basicConfig(
    format="%(asctime)s - %(name)s - %(levelname)s - %(message)s",
    level=logging.INFO
)
logger = logging.getLogger(__name__)

# ========== Inicializar Supabase ==========
supabase: Client = create_client(SUPABASE_URL, SUPABASE_KEY)

# ========== FUNCIONES DE BASE DE DATOS ==========
def get_user(user_id: int, first_name: str = None) -> dict:
    """Obtiene o crea un usuario en Supabase."""
    resp = supabase.table("users").select("*").eq("user_id", user_id).execute()
    if resp.data:
        return resp.data[0]
    new_user = {
        "user_id": user_id,
        "first_name": first_name or "Jugador",
        "usd": 0.0,
        "cup": 0.0,
        "bonus_usd": 0.0,
        "ref": None
    }
    supabase.table("users").insert(new_user).execute()
    return new_user

def update_user_balance(user_id: int, usd_delta=0.0, cup_delta=0.0, bonus_delta=0.0):
    """Actualiza saldos de un usuario."""
    user = get_user(user_id)
    supabase.table("users").update({
        "usd": round(user["usd"] + usd_delta, 2),
        "cup": round(user["cup"] + cup_delta, 2),
        "bonus_usd": round(user["bonus_usd"] + bonus_delta, 2)
    }).eq("user_id", user_id).execute()

def get_exchange_rate() -> float:
    """Obtiene la tasa USD/CUP."""
    resp = supabase.table("config").select("value").eq("key", "exchange_rate").execute()
    if resp.data:
        return float(resp.data[0]["value"])
    return 110.0

def set_exchange_rate(rate: float):
    """Actualiza la tasa USD/CUP."""
    supabase.table("config").update({"value": str(rate)}).eq("key", "exchange_rate").execute()

def get_play_prices() -> dict:
    """Obtiene los precios de jugadas."""
    resp = supabase.table("config").select("value").eq("key", "play_prices").execute()
    if resp.data:
        return json.loads(resp.data[0]["value"])
    default = {
        "fijo": {"cup": 70.0, "usd": 0.2},
        "corridos": {"cup": 70.0, "usd": 0.2},
        "centena": {"cup": 70.0, "usd": 0.2},
        "parle": {"cup": 70.0, "usd": 0.2}
    }
    return default

def set_play_price(bet_type: str, cup: float, usd: float):
    """Actualiza el precio de un tipo de jugada."""
    prices = get_play_prices()
    prices[bet_type] = {"cup": cup, "usd": usd}
    supabase.table("config").update({"value": json.dumps(prices)}).eq("key", "play_prices").execute()

def get_deposit_methods(active_only=True) -> List[dict]:
    """Lista métodos de depósito activos."""
    query = supabase.table("deposit_methods").select("*")
    if active_only:
        query = query.eq("active", True)
    resp = query.execute()
    return resp.data

def add_deposit_method(name: str, card: str, confirm: str):
    """Añade un nuevo método de depósito."""
    supabase.table("deposit_methods").insert({
        "name": name, "card": card, "confirm": confirm, "active": True
    }).execute()

def get_withdraw_methods(active_only=True) -> List[dict]:
    """Lista métodos de retiro activos."""
    query = supabase.table("withdraw_methods").select("*")
    if active_only:
        query = query.eq("active", True)
    resp = query.execute()
    return resp.data

def add_withdraw_method(name: str, card: str, confirm: str):
    """Añade un nuevo método de retiro."""
    supabase.table("withdraw_methods").insert({
        "name": name, "card": card, "confirm": confirm, "active": True
    }).execute()

def add_bet(user_id: int, lottery: str, bet_type: str, raw: str, cost_usd: float, cost_cup: float):
    """Registra una apuesta."""
    bet = {
        "user_id": user_id,
        "lottery": lottery,
        "bet_type": bet_type,
        "raw": raw,
        "cost_usd": cost_usd,
        "cost_cup": cost_cup,
        "status": "activa"
    }
    supabase.table("bets").insert(bet).execute()

def get_user_bets(user_id: int, limit: int = 5) -> List[dict]:
    """Obtiene las últimas apuestas de un usuario."""
    resp = supabase.table("bets").select("*").eq("user_id", user_id).order("created_at", desc=True).limit(limit).execute()
    return resp.data

def create_transaction(user_id: int, ttype: str, amount_usd=0.0, amount_cup=0.0,
                       method_id=None, proof_file_id=None, proof_url=None,
                       target_user=None, details=None) -> int:
    """Crea una transacción con estado 'pending'."""
    tx = {
        "user_id": user_id,
        "type": ttype,
        "amount_usd": round(amount_usd, 2),
        "amount_cup": round(amount_cup, 2),
        "method_id": method_id,
        "proof_file_id": proof_file_id,
        "proof_url": proof_url,
        "target_user": target_user,
        "admin_message": details,
        "status": "pending"
    }
    resp = supabase.table("transactions").insert(tx).execute()
    return resp.data[0]["id"]

def update_transaction_status(tx_id: int, status: str, admin_message: str = None):
    """Actualiza el estado de una transacción."""
    update = {"status": status}
    if admin_message:
        update["admin_message"] = admin_message
    supabase.table("transactions").update(update).eq("id", tx_id).execute()

def get_transaction(tx_id: int) -> Optional[dict]:
    """Obtiene una transacción por ID."""
    resp = supabase.table("transactions").select("*").eq("id", tx_id).execute()
    return resp.data[0] if resp.data else None

# ========== FUNCIONES AUXILIARES ==========
def cup_to_usd(cup_amount: float) -> float:
    rate = get_exchange_rate()
    return round(cup_amount / rate, 2) if rate else 0.0

def usd_to_cup(usd_amount: float) -> float:
    rate = get_exchange_rate()
    return round(usd_amount * rate, 2)

def format_money(user_id: int) -> str:
    """Devuelve string con saldos del usuario."""
    u = get_user(user_id)
    return (f"🇨🇺 *CUP:* {u['cup']:.2f}\n"
            f"💵 *USD:* {u['usd']:.2f}\n"
            f"🎁 *Bono:* {u['bonus_usd']:.2f} USD")

def parse_amount(text: str) -> Tuple[float, float]:
    """Extrae monto y moneda de un texto como '10 usd' o '500 cup'."""
    t = text.lower().replace(",", ".").strip()
    usd = 0.0
    cup = 0.0
    try:
        if "usd" in t:
            n = float(t.split("usd")[0].strip())
            usd = n
        elif "cup" in t:
            n = float(t.split("cup")[0].strip())
            cup = n
        else:
            n = float(t)
            usd = n
    except:
        pass
    return usd, cup

def parse_bet_and_cost(raw: str, bet_type: str) -> Tuple[bool, float, float]:
    """Extrae costo de una apuesta."""
    lower = raw.lower()
    usd_cost = 0.0
    cup_cost = 0.0
    pattern = r'(\d+(?:\.\d+)?)\s*(usd|cup)'
    matches = re.findall(pattern, lower)
    if matches:
        last_val, last_cur = matches[-1]
        val = float(last_val)
        if last_cur == 'usd':
            usd_cost = val
        else:
            cup_cost = val
    else:
        price = get_play_prices().get(bet_type, {})
        usd_cost = price.get("usd", 0.0)
        cup_cost = price.get("cup", 0.0)
    if usd_cost == 0.0 and cup_cost == 0.0:
        return False, 0.0, 0.0
    return True, usd_cost, cup_cost

# ========== TECLADOS (InlineKeyboards) ==========
def main_menu_kbd():
    kb = types.InlineKeyboardMarkup(row_width=2)
    kb.add(
        types.InlineKeyboardButton("🎲 Jugar", callback_data="play"),
        types.InlineKeyboardButton("💰 Mi dinero", callback_data="my_money"),
        types.InlineKeyboardButton("📋 Mis jugadas", callback_data="my_bets"),
        types.InlineKeyboardButton("👥 Referidos", callback_data="referrals"),
        types.InlineKeyboardButton("❓ Cómo jugar", callback_data="how_to_play"),
        types.InlineKeyboardButton("🛠 Admin", callback_data="admin_panel"),
        types.InlineKeyboardButton("🌐 WebApp", web_app=types.WebAppInfo(url=WEBAPP_URL))
    )
    return kb

def back_button(callback_data="main"):
    kb = types.InlineKeyboardMarkup()
    kb.row(types.InlineKeyboardButton("🔙 Volver", callback_data=callback_data))
    return kb

def game_options_kbd():
    kb = types.InlineKeyboardMarkup(row_width=2)
    kb.add(
        types.InlineKeyboardButton("🦩 Florida", callback_data="florida"),
        types.InlineKeyboardButton("🍑 Georgia", callback_data="georgia"),
        types.InlineKeyboardButton("🗽 Nueva York", callback_data="new_york")
    )
    kb.row(types.InlineKeyboardButton("🔙 Volver", callback_data="main"))
    return kb

def play_type_kbd():
    kb = types.InlineKeyboardMarkup(row_width=2)
    kb.add(
        types.InlineKeyboardButton("🎯 Fijo", callback_data="type_fijo"),
        types.InlineKeyboardButton("🏃 Corridos", callback_data="type_corridos"),
        types.InlineKeyboardButton("💯 Centena", callback_data="type_centena"),
        types.InlineKeyboardButton("🔒 Parle", callback_data="type_parle")
    )
    kb.row(types.InlineKeyboardButton("🔙 Volver", callback_data="play"))
    return kb

def my_money_kbd():
    kb = types.InlineKeyboardMarkup(row_width=2)
    kb.add(
        types.InlineKeyboardButton("📥 Recargar", callback_data="recharge"),
        types.InlineKeyboardButton("📤 Retirar", callback_data="withdraw"),
        types.InlineKeyboardButton("🔄 Transferir", callback_data="transfer")
    )
    kb.row(types.InlineKeyboardButton("🔙 Volver", callback_data="main"))
    return kb

def admin_menu_kbd():
    kb = types.InlineKeyboardMarkup(row_width=1)
    kb.add(
        types.InlineKeyboardButton("➕ Añadir método DEPÓSITO", callback_data="adm_add_dep"),
        types.InlineKeyboardButton("➕ Añadir método RETIRO", callback_data="adm_add_wit"),
        types.InlineKeyboardButton("💰 Configurar tasa USD/CUP", callback_data="adm_set_rate"),
        types.InlineKeyboardButton("🎲 Configurar precios de jugadas", callback_data="adm_set_price"),
        types.InlineKeyboardButton("📋 Ver datos actuales", callback_data="adm_view"),
        types.InlineKeyboardButton("🔙 Volver al menú principal", callback_data="main")
    )
    return kb

# ========== INICIALIZAR BOT ==========
bot = telebot.TeleBot(BOT_TOKEN, parse_mode="Markdown")
user_states = {}  # Diccionario de estados para flujos

# ========== HANDLERS DEL BOT (Funcionalidad completa) ==========

# ----- Comando /start -----
@bot.message_handler(commands=["start"])
def cmd_start(message):
    uid = message.from_user.id
    first = message.from_user.first_name or "Jugador"
    parts = message.text.split()
    ref_id = None
    if len(parts) > 1:
        try:
            ref_id = int(parts[1])
            if ref_id == uid:
                ref_id = None
        except:
            pass

    user = get_user(uid, first)

    if ref_id and user.get("ref") is None:
        supabase.table("users").update({"ref": ref_id}).eq("user_id", uid).execute()
        bot.send_message(ref_id, f"🎉 ¡Felicidades! *{first}* se unió usando tu enlace. ¡Ganas comisión por cada apuesta que realice!")

    welcome = (f"✨ ¡Hola de nuevo, *{first}*!\n"
               "Bienvenido a **Rifas Cuba** – tu asistente de la suerte 🍀\n\n"
               "🎯 ¿Listo para ganar?\n"
               "Apuesta, gana y disfruta. ¡La suerte está de tu lado!")
    bot.send_message(uid, welcome, reply_markup=main_menu_kbd())

# ----- Callback del menú principal -----
@bot.callback_query_handler(func=lambda call: call.data == "main")
def main_menu_callback(call):
    bot.edit_message_text("📌 *Menú principal*", call.message.chat.id, call.message.message_id,
                          reply_markup=main_menu_kbd())

# ----- Jugar: selección de lotería -----
@bot.callback_query_handler(func=lambda call: call.data == "play")
def play_callback(call):
    bot.edit_message_text("🎰 *Selecciona una lotería:*", call.message.chat.id, call.message.message_id,
                          reply_markup=game_options_kbd())

@bot.callback_query_handler(func=lambda call: call.data in ["florida", "georgia", "new_york"])
def lottery_selected(call):
    uid = call.from_user.id
    cid = call.message.chat.id
    mid = call.message.message_id
    lot = {"florida": "Florida", "georgia": "Georgia", "new_york": "Nueva York"}[call.data]

    if call.data == "georgia":
        tz = pytz.timezone(TIMEZONE)
        now = datetime.now(tz).time()
        allowed = (
            (time(9, 0) <= now <= time(12, 0)) or
            (time(14, 0) <= now <= time(18, 30)) or
            (time(20, 0) <= now <= time(23, 0))
        )
        if not allowed:
            bot.edit_message_text(
                "⏰ *Fuera de horario para 🍑 Georgia*\n\n"
                "Horarios permitidos (hora de Cuba):\n"
                "☀️ Mañana: 9:00 – 12:00\n"
                "🌙 Tarde: 2:00 – 6:30\n"
                "🌙 Noche: 8:00 – 11:00\n\n"
                "⏳ Intenta en el horario indicado.",
                cid, mid, reply_markup=game_options_kbd()
            )
            return

    user_states[uid] = {"action": "playing", "lottery": lot}
    bot.edit_message_text(f"✅ Seleccionaste *{lot}*. Ahora elige el *tipo de jugada*:",
                          cid, mid, reply_markup=play_type_kbd())

@bot.callback_query_handler(func=lambda call: call.data.startswith("type_"))
def bet_type_selected(call):
    uid = call.from_user.id
    cid = call.message.chat.id
    mid = call.message.message_id
    bet_type = call.data.split("_", 1)[1]
    state = user_states.setdefault(uid, {})
    state["bet_type"] = bet_type
    state["action"] = "awaiting_bet"
    lottery = state.get("lottery", "Florida")

    messages = {
        "fijo": (f"🎯 *Jugada FIJO* - 🦩 {lottery}\n\n"
                 "Escribe cada número con su valor:\n"
                 "📎 Ejemplos:\n"
                 "• `12 con 1 usd, 34 con 2 usd`\n"
                 "• `7*1.5usd, 23*2cup`\n"
                 "• `D2 con 1 usd, T5*2cup`\n\n"
                 "💬 *Envía tus números:*"),
        "corridos": (f"🏃 *Jugada CORRIDOS* - 🦩 {lottery}\n\n"
                     "Escribe cada número con su valor:\n"
                     "📎 Ejemplos:\n"
                     "• `12 con 1 usd, 34 con 2 usd`\n"
                     "• `7*1.5usd, 23*2cup`\n\n"
                     "💬 *Envía tus números:*"),
        "centena": (f"💯 *Jugada CENTENA* - 🦩 {lottery}\n\n"
                    "Números de 3 dígitos:\n"
                    "📎 Ejemplos:\n"
                    "• `123 con 1 usd, 456 con 2 usd`\n"
                    "• `001*1.5usd, 125*2cup`\n\n"
                    "💬 *Envía tus números:*"),
        "parle": (f"🔒 *Jugada PARLE* - 🦩 {lottery}\n\n"
                  "Escribe cada parle con su valor:\n"
                  "📎 Ejemplos:\n"
                  "• `12x34 con 1 usd, 56x78 con 2 usd`\n"
                  "• `12x34*1.5usd, 56x78*2cup`\n"
                  "• `12x T5 con 1 usd`\n\n"
                  "💬 *Envía tus parles:*")
    }
    bot.edit_message_text(messages.get(bet_type, "Envía tu jugada:"), cid, mid)

# ----- Manejo de apuestas (texto) -----
@bot.message_handler(func=lambda m: user_states.get(m.from_user.id, {}).get("action") == "awaiting_bet")
def handle_bet(message):
    uid = message.from_user.id
    text = message.text.strip()
    state = user_states.get(uid, {})
    bet_type = state.get("bet_type")
    lottery = state.get("lottery", "Florida")

    ok, cost_usd, cost_cup = parse_bet_and_cost(text, bet_type)
    if not ok:
        bot.reply_to(message, "❌ *Formato no reconocido.* Revisa los ejemplos e intenta de nuevo.")
        return

    user = get_user(uid)
    if cost_usd > 0:
        total_usd = user["usd"] + user["bonus_usd"]
        if total_usd < cost_usd:
            bot.reply_to(message, "❌ *Saldo USD insuficiente.* Recarga para continuar.")
            return
        use_bonus = min(user["bonus_usd"], cost_usd)
        update_user_balance(uid, bonus_delta=-use_bonus, usd_delta=-(cost_usd - use_bonus))
    else:
        if user["cup"] < cost_cup:
            bot.reply_to(message, "❌ *Saldo CUP insuficiente.* Recarga para continuar.")
            return
        update_user_balance(uid, cup_delta=-cost_cup)

    add_bet(uid, lottery, bet_type, text, cost_usd, cost_cup)

    if user.get("ref"):
        commission = round(cost_usd * 0.05, 2) if cost_usd > 0 else 0.0
        if commission > 0:
            update_user_balance(user["ref"], usd_delta=commission)
            bot.send_message(user["ref"], f"💸 *Comisión de referido*\n"
                                          f"Tu referido @{message.from_user.username or uid} hizo una apuesta.\n"
                                          f"💰 Ganaste: *{commission:.2f} USD*")

    bot.reply_to(message,
                 f"✅ *¡Jugada registrada con éxito!*\n"
                 f"🎰 {lottery} - {bet_type.capitalize()}\n"
                 f"📝 `{text}`\n"
                 f"💰 Costo: {cost_usd:.2f} USD / {cost_cup:.2f} CUP\n"
                 f"🍀 ¡Buena suerte!",
                 reply_markup=main_menu_kbd())
    user_states.pop(uid, None)

# ----- Mi dinero -----
@bot.callback_query_handler(func=lambda call: call.data == "my_money")
def my_money_callback(call):
    uid = call.from_user.id
    text = f"💰 *Tu saldo actual:*\n\n{format_money(uid)}"
    bot.edit_message_text(text, call.message.chat.id, call.message.message_id,
                          reply_markup=my_money_kbd())

# ----- Recargar (depósito) -----
@bot.callback_query_handler(func=lambda call: call.data == "recharge")
def recharge_callback(call):
    uid = call.from_user.id
    cid = call.message.chat.id
    mid = call.message.message_id

    methods = get_deposit_methods()
    if not methods:
        bot.answer_callback_query(call.id, "❌ No hay métodos de depósito configurados. Contacta al administrador.")
        return

    markup = types.InlineKeyboardMarkup()
    for m in methods:
        markup.row(types.InlineKeyboardButton(m["name"], callback_data=f"dep_{m['id']}"))
    markup.row(types.InlineKeyboardButton("🔙 Volver", callback_data="my_money"))

    rate = get_exchange_rate()
    text = (f"💵 *¿Cómo deseas recargar?*\n\n"
            f"Selecciona un método para ver los datos de pago.\n"
            f"📊 *Tasa actual:* 1 USD = {rate:.2f} CUP")
    bot.edit_message_text(text, cid, mid, reply_markup=markup)

@bot.callback_query_handler(func=lambda call: call.data.startswith("dep_"))
def deposit_method_selected(call):
    uid = call.from_user.id
    cid = call.message.chat.id
    mid = call.message.message_id
    method_id = int(call.data.split("_")[1])

    methods = get_deposit_methods()
    method = next((m for m in methods if m["id"] == method_id), None)
    if not method:
        bot.answer_callback_query(call.id, "Método no encontrado.")
        return

    text = (f"🧾 *{method['name']}*\n"
            f"📱 Número: `{method['card']}`\n"
            f"🔢 Confirmar: `{method['confirm']}`\n\n"
            "📤 *Instrucciones:*\n"
            "1️⃣ Realiza la transferencia por el monto deseado.\n"
            "2️⃣ Toma una **captura de pantalla** del comprobante.\n"
            "3️⃣ Envía la foto **con el monto en el caption** (ej: `10 usd` o `500 cup`).\n\n"
            "⏳ Tu depósito será revisado y acreditado en breve.")
    bot.edit_message_text(text, cid, mid, reply_markup=back_button("recharge"))
    user_states[uid] = {"action": "awaiting_deposit_proof", "method_id": method_id}

# ----- Manejo de fotos (comprobante de depósito) -----
@bot.message_handler(content_types=['photo'])
def handle_deposit_photo(message):
    uid = message.from_user.id
    state = user_states.get(uid, {})
    if state.get("action") not in ["awaiting_deposit_proof", "awaiting_deposit_proof_webapp"]:
        bot.reply_to(message, "❌ No esperaba una foto. Usa los botones del menú.")
        return

    caption = message.caption or ""
    usd, cup = parse_amount(caption)
    if usd == 0 and cup == 0:
        bot.reply_to(message, "❌ No pude entender el monto. Asegúrate de escribir en el caption algo como `10 usd` o `500 cup`.")
        return

    file_id = message.photo[-1].file_id
    method_id = state["method_id"]

    if state.get("action") == "awaiting_deposit_proof_webapp":
        # Transacción ya creada desde WebApp, solo actualizamos el proof_file_id
        tx_id = state["tx_id"]
        supabase.table("transactions").update({"proof_file_id": file_id}).eq("id", tx_id).execute()
    else:
        # Flujo normal desde bot
        tx_id = create_transaction(
            user_id=uid,
            ttype="deposit",
            amount_usd=usd,
            amount_cup=cup,
            method_id=method_id,
            proof_file_id=file_id
        )

    # Notificar al admin
    caption_admin = (f"🟢 *Nueva solicitud de depósito*\n"
                     f"👤 Usuario: {uid}\n"
                     f"💰 Monto: {usd:.2f} USD / {cup:.2f} CUP\n"
                     f"💳 Método ID: {method_id}\n"
                     f"🆔 Transacción: {tx_id}")
    markup = types.InlineKeyboardMarkup()
    markup.row(
        types.InlineKeyboardButton("✅ Aprobar", callback_data=f"approve_dep_{tx_id}"),
        types.InlineKeyboardButton("❌ Rechazar", callback_data=f"reject_dep_{tx_id}")
    )
    bot.send_photo(ADMIN_CHAT_ID, file_id, caption=caption_admin, reply_markup=markup)

    bot.reply_to(message,
                 "✅ *¡Captura recibida!*\n"
                 "Tu solicitud de depósito está siendo revisada.\n"
                 "Te notificaremos cuando sea aprobada.")
    user_states.pop(uid, None)

# ----- Aprobación/Rechazo de depósito (Admin) -----
@bot.callback_query_handler(func=lambda call: call.data.startswith("approve_dep_") or call.data.startswith("reject_dep_"))
def handle_deposit_review(call):
    if call.from_user.id != ADMIN_ID:
        bot.answer_callback_query(call.id, "⛔ No autorizado")
        return

    parts = call.data.split("_")
    action = parts[0]
    tx_id = int(parts[2])

    tx = get_transaction(tx_id)
    if not tx:
        bot.answer_callback_query(call.id, "Transacción no encontrada")
        return

    user_id = tx["user_id"]
    status = "approved" if action == "approve" else "rejected"

    if status == "approved":
        usd_amount = tx["amount_usd"]
        cup_amount = tx["amount_cup"]
        bonus = cup_to_usd(BONUS_CUP_DEFAULT) if (usd_amount > 0 or cup_amount > 0) else 0
        update_user_balance(user_id, usd_delta=usd_amount, cup_delta=cup_amount, bonus_delta=bonus)
        bot.send_message(user_id,
                         f"✅ *¡Depósito aprobado!*\n"
                         f"Se acreditaron *{usd_amount:.2f} USD / {cup_amount:.2f} CUP*.\n"
                         f"🎁 Bonus: +{bonus:.2f} USD (no retirable).\n"
                         f"💰 Saldo actual:\n{format_money(user_id)}")
    else:
        bot.send_message(user_id,
                         f"❌ *Depósito rechazado.*\n"
                         f"Si crees que es un error, contacta al administrador.")

    update_transaction_status(tx_id, status)
    bot.answer_callback_query(call.id, f"Depósito {status}")
    bot.edit_message_caption(
        chat_id=call.message.chat.id,
        message_id=call.message.message_id,
        caption=call.message.caption + f"\n\n✅ *{status.upper()}*"
    )

# ----- Retirar -----
@bot.callback_query_handler(func=lambda call: call.data == "withdraw")
def withdraw_callback(call):
    uid = call.from_user.id
    user = get_user(uid)
    if user["usd"] < 1.0:
        bot.answer_callback_query(call.id, "❌ Necesitas al menos 1 USD para retirar.")
        return

    methods = get_withdraw_methods()
    if not methods:
        bot.answer_callback_query(call.id, "❌ No hay métodos de retiro configurados.")
        return

    markup = types.InlineKeyboardMarkup()
    for m in methods:
        markup.row(types.InlineKeyboardButton(m["name"], callback_data=f"wit_{m['id']}"))
    markup.row(types.InlineKeyboardButton("🔙 Volver", callback_data="my_money"))

    bot.edit_message_text("💸 *Selecciona un método de retiro:*",
                          call.message.chat.id, call.message.message_id,
                          reply_markup=markup)

@bot.callback_query_handler(func=lambda call: call.data.startswith("wit_"))
def withdraw_method_selected(call):
    uid = call.from_user.id
    cid = call.message.chat.id
    mid = call.message.message_id
    method_id = int(call.data.split("_")[1])

    method = get_withdraw_methods()
    method = next((m for m in method if m["id"] == method_id), None)
    if not method:
        bot.answer_callback_query(call.id, "Método no encontrado.")
        return

    bot.edit_message_text(
        f"🧾 *{method['name']}* seleccionado.\n\n"
        "Ahora envía **los datos de tu cuenta** en el siguiente formato:\n\n"
        "`número de cuenta | número de confirmación`\n\n"
        "📎 Ejemplo: `1234567890 | 1234`",
        cid, mid
    )
    user_states[uid] = {"action": "awaiting_withdraw_details", "method_id": method_id}

@bot.message_handler(func=lambda m: user_states.get(m.from_user.id, {}).get("action") == "awaiting_withdraw_details")
def handle_withdraw_details(message):
    uid = message.from_user.id
    text = message.text.strip()
    if "|" not in text:
        bot.reply_to(message, "❌ *Formato incorrecto.* Debes usar: `número | confirmación`")
        return
    account, confirm = map(str.strip, text.split("|", 1))

    state = user_states[uid]
    method_id = state["method_id"]
    user = get_user(uid)
    amount_usd = user["usd"]

    if amount_usd < 1:
        bot.reply_to(message, "❌ *Saldo insuficiente.* No puedes retirar menos de 1 USD.")
        user_states.pop(uid, None)
        return

    update_user_balance(uid, usd_delta=-amount_usd)
    details = f"Cuenta: {account}, Confirm: {confirm}"
    tx_id = create_transaction(
        user_id=uid,
        ttype="withdraw",
        amount_usd=amount_usd,
        method_id=method_id,
        details=details
    )

    markup = types.InlineKeyboardMarkup()
    markup.row(
        types.InlineKeyboardButton("✅ Procesar", callback_data=f"approve_with_{tx_id}"),
        types.InlineKeyboardButton("❌ Rechazar", callback_data=f"reject_with_{tx_id}")
    )
    admin_text = (f"🟡 *Nueva solicitud de retiro*\n"
                  f"👤 Usuario: {uid}\n"
                  f"💰 Monto: {amount_usd:.2f} USD\n"
                  f"💳 Método ID: {method_id}\n"
                  f"📞 Cuenta: {account}\n"
                  f"🔢 Confirmación: {confirm}")
    bot.send_message(ADMIN_CHAT_ID, admin_text, reply_markup=markup)

    bot.reply_to(message,
                 f"✅ *Solicitud de retiro enviada*\n"
                 f"💰 Monto: {amount_usd:.2f} USD\n"
                 f"📞 Cuenta: {account}\n"
                 f"🔢 Confirmación: {confirm}\n\n"
                 f"⏳ Procesaremos tu pago en breve. Recibirás una notificación.")
    user_states.pop(uid, None)

# ----- Aprobación/Rechazo de retiro (Admin) -----
@bot.callback_query_handler(func=lambda call: call.data.startswith("approve_with_") or call.data.startswith("reject_with_"))
def handle_withdraw_review(call):
    if call.from_user.id != ADMIN_ID:
        bot.answer_callback_query(call.id, "⛔ No autorizado")
        return

    parts = call.data.split("_")
    action = parts[0]
    tx_id = int(parts[2])

    tx = get_transaction(tx_id)
    if not tx:
        bot.answer_callback_query(call.id, "Transacción no encontrada")
        return

    user_id = tx["user_id"]
    status = "approved" if action == "approve" else "rejected"

    if status == "approved":
        bot.send_message(user_id,
                         f"✅ *¡Retiro procesado!*\n"
                         f"Se ha enviado *{tx['amount_usd']:.2f} USD* a tu cuenta.\n"
                         f"Gracias por confiar en nosotros.")
    else:
        # Reembolsar saldo
        update_user_balance(user_id, usd_delta=tx["amount_usd"])
        bot.send_message(user_id,
                         f"❌ *Retiro rechazado.*\n"
                         f"Se ha reembolsado *{tx['amount_usd']:.2f} USD* a tu saldo.\n"
                         f"Contacta al administrador si necesitas ayuda.")

    update_transaction_status(tx_id, status, admin_message=f"Revisado por admin: {status}")
    bot.answer_callback_query(call.id, f"Retiro {status}")
    bot.edit_message_text(
        chat_id=call.message.chat.id,
        message_id=call.message.message_id,
        text=call.message.text + f"\n\n✅ *{status.upper()}*"
    )

# ----- Transferir saldo -----
@bot.callback_query_handler(func=lambda call: call.data == "transfer")
def transfer_callback(call):
    uid = call.from_user.id
    bot.edit_message_text(
        "🔄 *Transferir saldo*\n\n"
        "Envía el *ID de Telegram* del usuario al que deseas transferir:\n"
        "(Ejemplo: `123456789`)",
        call.message.chat.id, call.message.message_id
    )
    user_states[uid] = {"action": "awaiting_transfer_target"}

@bot.message_handler(func=lambda m: user_states.get(m.from_user.id, {}).get("action") == "awaiting_transfer_target")
def handle_transfer_target(message):
    uid = message.from_user.id
    text = message.text.strip()
    if not text.isdigit():
        bot.reply_to(message, "❌ *ID inválido.* Debe ser un número entero.")
        return
    target = int(text)
    if target == uid:
        bot.reply_to(message, "❌ No puedes transferirte a ti mismo.")
        return
    user_states[uid] = {"action": "awaiting_transfer_amount", "target": target}
    bot.reply_to(message, "💰 Ahora envía el *monto en USD* que deseas transferir (ej: `2.5`):")

@bot.message_handler(func=lambda m: user_states.get(m.from_user.id, {}).get("action") == "awaiting_transfer_amount")
def handle_transfer_amount(message):
    uid = message.from_user.id
    text = message.text.strip().replace(",", ".")
    try:
        amount = float(text)
        if amount <= 0:
            raise ValueError
    except:
        bot.reply_to(message, "❌ *Monto inválido.* Debe ser un número positivo (ej: `2.5`).")
        return

    state = user_states[uid]
    target = state["target"]
    user = get_user(uid)
    if user["usd"] < amount:
        bot.reply_to(message, f"❌ *Saldo insuficiente.* Tienes {user['usd']:.2f} USD.")
        user_states.pop(uid, None)
        return

    update_user_balance(uid, usd_delta=-amount)
    update_user_balance(target, usd_delta=amount)
    create_transaction(uid, "transfer", amount_usd=amount, target_user=target)

    bot.reply_to(message,
                 f"✅ *Transferencia realizada con éxito*\n"
                 f"💰 Monto: {amount:.2f} USD\n"
                 f"👤 Destino: {target}\n"
                 f"💵 Saldo restante: {user['usd'] - amount:.2f} USD")
    try:
        bot.send_message(target,
                         f"💸 *Has recibido una transferencia*\n"
                         f"👤 De: {message.from_user.first_name} (ID: {uid})\n"
                         f"💰 Monto: {amount:.2f} USD\n"
                         f"💵 Saldo actual: {get_user(target)['usd']:.2f} USD")
    except:
        pass
    user_states.pop(uid, None)

# ----- Mis jugadas -----
@bot.callback_query_handler(func=lambda call: call.data == "my_bets")
def my_bets_callback(call):
    uid = call.from_user.id
    bets = get_user_bets(uid, limit=10)
    if not bets:
        text = ("📭 *No tienes jugadas registradas.*\n\n"
                "¡Empieza a jugar presionando 🎲 Jugar!")
    else:
        lines = ["📋 *Tus últimas jugadas:*"]
        for b in bets:
            date = b["created_at"][:16].replace("T", " ")
            lines.append(f"• {date} - {b['lottery']} - {b['bet_type']}\n  `{b['raw']}`")
        text = "\n".join(lines)
    bot.edit_message_text(text, call.message.chat.id, call.message.message_id,
                          reply_markup=back_button("main"))

# ----- Referidos -----
@bot.callback_query_handler(func=lambda call: call.data == "referrals")
def referrals_callback(call):
    uid = call.from_user.id
    resp = supabase.table("users").select("user_id").eq("ref", uid).execute()
    total = len(resp.data)
    bot_username = bot.get_me().username
    referral_link = f"https://t.me/{bot_username}?start={uid}"

    text = (f"👥 *Tus referidos*\n\n"
            f"📊 *Total:* {total}\n\n"
            f"🔗 *Tu enlace de invitación:*\n"
            f"`{referral_link}`\n\n"
            f"💎 *¿Cómo funciona?*\n"
            f"• Comparte este enlace con tus amigos.\n"
            f"• Cuando se registren y jueguen, ¡ganas el **5%** de cada apuesta que hagan!\n"
            f"• La comisión se acredita automáticamente en tu saldo USD.\n\n"
            f"🚀 ¡Comparte y gana sin límites!")
    bot.edit_message_text(text, call.message.chat.id, call.message.message_id,
                          reply_markup=back_button("main"))

# ----- Cómo jugar -----
@bot.callback_query_handler(func=lambda call: call.data == "how_to_play")
def how_to_play_callback(call):
    text = ("❓ *¿Cómo jugar?*\n\n"
            "1️⃣ Presiona *🎲 Jugar* y elige una lotería.\n"
            "2️⃣ Selecciona el tipo de jugada: Fijo, Corridos, Centena o Parle.\n"
            "3️⃣ Escribe tus números y el monto (puedes usar USD o CUP).\n"
            "4️⃣ Confirma y ¡listo!\n\n"
            "📌 *Ejemplos:*\n"
            "• `12 con 1 usd, 34 con 2 usd`\n"
            "• `123*0.5usd, 456*2cup`\n"
            "• `12x34 con 1 usd` (para parle)\n\n"
            "💰 *Depósitos:* Ve a *Mi dinero > Recargar*, elige método y envía captura.\n"
            "💸 *Retiros:* Mínimo 1 USD, selecciona método y proporciona tus datos.\n\n"
            "✨ ¡La suerte te espera!")
    bot.edit_message_text(text, call.message.chat.id, call.message.message_id,
                          reply_markup=back_button("main"))

# ----- PANEL DE ADMINISTRACIÓN -----
@bot.callback_query_handler(func=lambda call: call.data == "admin_panel")
def admin_panel_callback(call):
    if call.from_user.id != ADMIN_ID:
        bot.answer_callback_query(call.id, "⛔ No autorizado")
        return
    bot.edit_message_text("🔧 *Panel de Administración*",
                          call.message.chat.id, call.message.message_id,
                          reply_markup=admin_menu_kbd())

# ----- Admin: Añadir método de depósito -----
@bot.callback_query_handler(func=lambda call: call.data == "adm_add_dep")
def admin_add_dep_callback(call):
    if call.from_user.id != ADMIN_ID:
        bot.answer_callback_query(call.id, "⛔ No autorizado")
        return
    bot.send_message(call.from_user.id,
                     "➕ *Añadir método de DEPÓSITO*\n\n"
                     "Envía el *nombre* del método (ej: Tarjeta Banco Metropolitano):")
    user_states[call.from_user.id] = {"action": "admin_add_dep", "step": 1}
    bot.answer_callback_query(call.id)

# ----- Admin: Añadir método de retiro -----
@bot.callback_query_handler(func=lambda call: call.data == "adm_add_wit")
def admin_add_wit_callback(call):
    if call.from_user.id != ADMIN_ID:
        bot.answer_callback_query(call.id, "⛔ No autorizado")
        return
    bot.send_message(call.from_user.id,
                     "➕ *Añadir método de RETIRO*\n\n"
                     "Envía el *nombre* del método (ej: Transfermovil):")
    user_states[call.from_user.id] = {"action": "admin_add_wit", "step": 1}
    bot.answer_callback_query(call.id)

# ----- Admin: Configurar tasa -----
@bot.callback_query_handler(func=lambda call: call.data == "adm_set_rate")
def admin_set_rate_callback(call):
    if call.from_user.id != ADMIN_ID:
        bot.answer_callback_query(call.id, "⛔ No autorizado")
        return
    current = get_exchange_rate()
    bot.send_message(call.from_user.id,
                     f"💰 *Tasa de cambio actual*\n1 USD = {current:.2f} CUP\n\n"
                     "Envía la *nueva tasa* (solo número, ej: 120):")
    user_states[call.from_user.id] = {"action": "admin_set_rate"}
    bot.answer_callback_query(call.id)

# ----- Admin: Configurar precios de jugadas -----
@bot.callback_query_handler(func=lambda call: call.data == "adm_set_price")
def admin_set_price_callback(call):
    if call.from_user.id != ADMIN_ID:
        bot.answer_callback_query(call.id, "⛔ No autorizado")
        return
    markup = types.InlineKeyboardMarkup()
    for t in get_play_prices().keys():
        markup.row(types.InlineKeyboardButton(t.capitalize(), callback_data=f"adm_price_{t}"))
    markup.row(types.InlineKeyboardButton("🔙 Volver", callback_data="admin_panel"))
    bot.send_message(call.from_user.id,
                     "🎲 *Configurar precios de jugadas*\nElige el tipo que deseas modificar:",
                     reply_markup=markup)
    bot.answer_callback_query(call.id)

@bot.callback_query_handler(func=lambda call: call.data.startswith("adm_price_"))
def admin_price_selected(call):
    if call.from_user.id != ADMIN_ID:
        bot.answer_callback_query(call.id, "⛔ No autorizado")
        return
    bet_type = call.data.split("_", 2)[2]
    user_states[call.from_user.id] = {"action": "admin_set_price", "type": bet_type}
    bot.send_message(call.from_user.id,
                     f"Configurando *{bet_type.capitalize()}*\n"
                     "Envía en el formato: `<monto_cup> <monto_usd>`\n"
                     "Ejemplo: `70 0.20`")
    bot.answer_callback_query(call.id)

# ----- Admin: Ver datos actuales -----
@bot.callback_query_handler(func=lambda call: call.data == "adm_view")
def admin_view_callback(call):
    if call.from_user.id != ADMIN_ID:
        bot.answer_callback_query(call.id, "⛔ No autorizado")
        return
    rate = get_exchange_rate()
    prices = get_play_prices()
    dep_methods = get_deposit_methods()
    wit_methods = get_withdraw_methods()

    lines = [f"💰 *Tasa:* 1 USD = {rate:.2f} CUP\n"]
    lines.append("📥 *Métodos de DEPÓSITO:*")
    for m in dep_methods:
        lines.append(f"  ID {m['id']}: {m['name']} - {m['card']} / {m['confirm']}")
    lines.append("\n📤 *Métodos de RETIRO:*")
    for m in wit_methods:
        lines.append(f"  ID {m['id']}: {m['name']} - {m['card']} / {m['confirm']}")
    lines.append("\n🎲 *Precios por jugada:*")
    for t, p in prices.items():
        lines.append(f"  {t.capitalize()}: {p['cup']} CUP / {p['usd']} USD")
    bot.edit_message_text("\n".join(lines),
                          call.message.chat.id, call.message.message_id,
                          reply_markup=back_button("admin_panel"))

# ----- Manejador de mensajes de texto para flujos de admin -----
@bot.message_handler(func=lambda m: user_states.get(m.from_user.id, {}).get("action", "").startswith("admin_"))
def handle_admin_flows(message):
    uid = message.from_user.id
    state = user_states.get(uid, {})
    action = state.get("action")

    if action == "admin_add_dep":
        step = state.get("step", 1)
        if step == 1:
            user_states[uid]["name"] = message.text
            user_states[uid]["step"] = 2
            bot.reply_to(message, "Ahora envía el *número de la tarjeta/cuenta*:")
        elif step == 2:
            user_states[uid]["card"] = message.text
            user_states[uid]["step"] = 3
            bot.reply_to(message, "Ahora envía el *número a confirmar* (ej: 1234):")
        elif step == 3:
            name = user_states[uid].pop("name")
            card = user_states[uid].pop("card")
            confirm = message.text
            add_deposit_method(name, card, confirm)
            user_states.pop(uid, None)
            bot.reply_to(message, f"✅ *Método de depósito añadido*\n{name} - {card} / {confirm}",
                         reply_markup=admin_menu_kbd())
        return

    if action == "admin_add_wit":
        step = state.get("step", 1)
        if step == 1:
            user_states[uid]["name"] = message.text
            user_states[uid]["step"] = 2
            bot.reply_to(message, "Ahora envía el *número o instrucción para retirar*:")
        elif step == 2:
            user_states[uid]["card"] = message.text
            user_states[uid]["step"] = 3
            bot.reply_to(message, "Ahora envía el *número a confirmar* (si aplica, o escribe 'ninguno'):")
        elif step == 3:
            name = user_states[uid].pop("name")
            card = user_states[uid].pop("card")
            confirm = message.text
            add_withdraw_method(name, card, confirm)
            user_states.pop(uid, None)
            bot.reply_to(message, f"✅ *Método de retiro añadido*\n{name} - {card} / {confirm}",
                         reply_markup=admin_menu_kbd())
        return

    if action == "admin_set_rate":
        try:
            rate = float(message.text.replace(",", "."))
            if rate <= 0:
                raise ValueError
            set_exchange_rate(rate)
            user_states.pop(uid, None)
            bot.reply_to(message, f"✅ *Tasa actualizada*\n1 USD = {rate:.2f} CUP",
                         reply_markup=admin_menu_kbd())
        except:
            bot.reply_to(message, "❌ *Formato inválido.* Envía un número positivo (ej: 120).")
        return

    if action == "admin_set_price":
        bet_type = state.get("type")
        try:
            parts = message.text.split()
            cup = float(parts[0].replace(",", "."))
            usd = float(parts[1].replace(",", "."))
            if cup < 0 or usd < 0:
                raise ValueError
            set_play_price(bet_type, cup, usd)
            user_states.pop(uid, None)
            bot.reply_to(message, f"✅ *Precio actualizado para {bet_type}*\n{cup} CUP / {usd} USD",
                         reply_markup=admin_menu_kbd())
        except:
            bot.reply_to(message, "❌ *Formato inválido.* Usa: `<cup> <usd>` (ej: 70 0.20)")
        return

# ========== HANDLER PARA WEB_APP_DATA ==========
@bot.message_handler(content_types=['web_app_data'])
def handle_web_app_data(message):
    """Recibe datos JSON de la WebApp y procesa las acciones."""
    uid = message.from_user.id
    try:
        data = json.loads(message.web_app_data.data)
    except Exception as e:
        logger.error(f"Error parseando web_app_data: {e}")
        return

    action = data.get('action')
    logger.info(f"WebApp data from {uid}: {action}")

    if action == 'deposit_request':
        # WebApp solicita depósito (ya creó la transacción y subió imagen)
        tx_id = int(data.get('tx_id'))
        proof_url = data.get('proof_url')
        amount_usd = float(data.get('amount_usd', 0))
        amount_cup = float(data.get('amount_cup', 0))
        method_id = int(data.get('method_id'))

        # Actualizar transacción con proof_url si no estaba
        supabase.table("transactions").update({"proof_url": proof_url}).eq("id", tx_id).execute()

        # Notificar al admin
        markup = types.InlineKeyboardMarkup()
        markup.row(
            types.InlineKeyboardButton("✅ Aprobar", callback_data=f"approve_dep_{tx_id}"),
            types.InlineKeyboardButton("❌ Rechazar", callback_data=f"reject_dep_{tx_id}")
        )
        caption = (f"🟢 *Nuevo depósito desde WebApp*\n"
                   f"👤 Usuario: {uid}\n"
                   f"💰 Monto: {amount_usd:.2f} USD / {amount_cup:.2f} CUP\n"
                   f"💳 Método ID: {method_id}\n"
                   f"🆔 Transacción: {tx_id}\n"
                   f"[Ver comprobante]({proof_url})")
        bot.send_message(ADMIN_CHAT_ID, caption, reply_markup=markup, parse_mode='Markdown')

        # Confirmar al usuario
        bot.send_message(uid, "✅ *Solicitud de depósito recibida.*\nTu comprobante está en revisión. Te notificaremos cuando sea aprobado.")

    elif action == 'withdraw_request':
        # WebApp solicita retiro (ya descontó saldo y creó transacción)
        tx_id = int(data.get('tx_id'))
        amount_usd = float(data.get('amount_usd'))
        method_id = int(data.get('method_id'))
        account = data.get('account', '')
        confirm = data.get('confirm', '')

        # Notificar al admin
        markup = types.InlineKeyboardMarkup()
        markup.row(
            types.InlineKeyboardButton("✅ Procesar", callback_data=f"approve_with_{tx_id}"),
            types.InlineKeyboardButton("❌ Rechazar", callback_data=f"reject_with_{tx_id}")
        )
        admin_text = (f"🟡 *Nuevo retiro desde WebApp*\n"
                      f"👤 Usuario: {uid}\n"
                      f"💰 Monto: {amount_usd:.2f} USD\n"
                      f"💳 Método ID: {method_id}\n"
                      f"📞 Cuenta: {account}\n"
                      f"🔢 Confirmación: {confirm}")
        bot.send_message(ADMIN_CHAT_ID, admin_text, reply_markup=markup)

        bot.send_message(uid, "✅ *Solicitud de retiro enviada.*\nSe procesará a la brevedad.")

    elif action == 'transfer_request':
        # WebApp solicita transferencia (ya se realizó en la BD)
        target_id = int(data.get('target_id'))
        amount_usd = float(data.get('amount_usd'))
        tx_id = data.get('tx_id')  # Opcional

        # Notificar al destinatario
        try:
            bot.send_message(target_id,
                             f"💸 *Has recibido una transferencia desde WebApp*\n"
                             f"👤 De: {uid}\n"
                             f"💰 Monto: *{amount_usd:.2f} USD*")
        except:
            pass

        bot.send_message(uid, f"✅ *Transferencia completada.*\n💰 {amount_usd:.2f} USD → {target_id}")

    elif action == 'bet_placed':
        # WebApp registró una apuesta, solo notificamos si hay referido
        cost_usd = float(data.get('cost_usd', 0))
        if cost_usd > 0:
            user = get_user(uid)
            if user.get('ref'):
                commission = round(cost_usd * 0.05, 2)
                if commission > 0:
                    update_user_balance(user['ref'], usd_delta=commission)
                    bot.send_message(user['ref'],
                                     f"💸 *Comisión de referido (WebApp)*\n"
                                     f"Tu referido @{message.from_user.username or uid} hizo una apuesta.\n"
                                     f"💰 Ganaste: *{commission:.2f} USD*")

# ========== FUNCIÓN PARA INICIAR EL BOT ==========
def run_bot():
    """Inicia el polling del bot en un bucle infinito (para ejecutar en hilo)."""
    logger.info("🤖 Bot iniciado con polling infinito")
    bot.infinity_polling(timeout=60, long_polling_timeout=60)

# ========== PUNTO DE ENTRADA ==========
if __name__ == "__main__":
    # Configuración adicional: suscripción a Realtime para notificaciones de admin (opcional)
    # Esto se puede hacer en otro hilo o aquí mismo
    logger.info("Iniciando bot en modo standalone...")
    run_bot()
