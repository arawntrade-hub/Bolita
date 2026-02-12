#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
Bot de Rifas Cuba + WebApp - Producción
Requiere: flask, python-dotenv, pyTelegramBotAPI, supabase, pytz
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
from flask import Flask, render_template_string, request

# ========== Cargar configuración desde .env ==========
load_dotenv()

BOT_TOKEN = os.getenv("BOT_TOKEN")
ADMIN_ID = int(os.getenv("ADMIN_ID", "0"))
TIMEZONE = os.getenv("TIMEZONE", "America/Havana")
BONUS_CUP_DEFAULT = float(os.getenv("BONUS_CUP_DEFAULT", "70"))
SUPABASE_URL = os.getenv("SUPABASE_URL")
SUPABASE_KEY = os.getenv("SUPABASE_KEY")
ADMIN_CHAT_ID = int(os.getenv("ADMIN_CHAT_ID", "0"))
WEBAPP_URL = os.getenv("WEBAPP_URL", "https://tudominio.com")

# ========== Configurar logging ==========
logging.basicConfig(
    format="%(asctime)s - %(name)s - %(levelname)s - %(message)s",
    level=logging.INFO
)
logger = logging.getLogger(__name__)

# ========== Inicializar Supabase ==========
supabase: Client = create_client(SUPABASE_URL, SUPABASE_KEY)

# ========== CONSTANTES ==========
BONUS_USD = BONUS_CUP_DEFAULT / 110.0

# ========== FUNCIONES DE BASE DE DATOS ==========

def get_user(user_id: int, first_name: str = None) -> dict:
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
    user = get_user(user_id)
    supabase.table("users").update({
        "usd": round(user["usd"] + usd_delta, 2),
        "cup": round(user["cup"] + cup_delta, 2),
        "bonus_usd": round(user["bonus_usd"] + bonus_delta, 2)
    }).eq("user_id", user_id).execute()

def get_exchange_rate() -> float:
    resp = supabase.table("config").select("value").eq("key", "exchange_rate").execute()
    if resp.data:
        return float(resp.data[0]["value"])
    return 110.0

def set_exchange_rate(rate: float):
    supabase.table("config").update({"value": str(rate)}).eq("key", "exchange_rate").execute()

def get_play_prices() -> dict:
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
    prices = get_play_prices()
    prices[bet_type] = {"cup": cup, "usd": usd}
    supabase.table("config").update({"value": json.dumps(prices)}).eq("key", "play_prices").execute()

def get_deposit_methods(active_only=True) -> List[dict]:
    query = supabase.table("deposit_methods").select("*")
    if active_only:
        query = query.eq("active", True)
    resp = query.execute()
    return resp.data

def add_deposit_method(name: str, card: str, confirm: str):
    supabase.table("deposit_methods").insert({
        "name": name, "card": card, "confirm": confirm, "active": True
    }).execute()

def get_withdraw_methods(active_only=True) -> List[dict]:
    query = supabase.table("withdraw_methods").select("*")
    if active_only:
        query = query.eq("active", True)
    resp = query.execute()
    return resp.data

def add_withdraw_method(name: str, card: str, confirm: str):
    supabase.table("withdraw_methods").insert({
        "name": name, "card": card, "confirm": confirm, "active": True
    }).execute()

def add_bet(user_id: int, lottery: str, bet_type: str, raw: str, cost_usd: float, cost_cup: float):
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

def get_user_bets(user_id: int, limit: int = 10) -> List[dict]:
    resp = supabase.table("bets").select("*").eq("user_id", user_id).order("created_at", desc=True).limit(limit).execute()
    return resp.data

def create_transaction(user_id: int, ttype: str, amount_usd=0.0, amount_cup=0.0,
                       method_id=None, proof_file_id=None, target_user=None, details=None) -> int:
    tx = {
        "user_id": user_id,
        "type": ttype,
        "amount_usd": round(amount_usd, 2),
        "amount_cup": round(amount_cup, 2),
        "method_id": method_id,
        "proof_file_id": proof_file_id,
        "target_user": target_user,
        "admin_message": details,
        "status": "pending"
    }
    resp = supabase.table("transactions").insert(tx).execute()
    return resp.data[0]["id"]

def update_transaction_status(tx_id: int, status: str, admin_message: str = None):
    update = {"status": status}
    if admin_message:
        update["admin_message"] = admin_message
    supabase.table("transactions").update(update).eq("id", tx_id).execute()

def get_transaction(tx_id: int) -> Optional[dict]:
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
    u = get_user(user_id)
    return (f"🇨🇺 *CUP:* {u['cup']:.2f}\n"
            f"💵 *USD:* {u['usd']:.2f}\n"
            f"🎁 *Bono:* {u['bonus_usd']:.2f} USD")

def parse_amount(text: str) -> Tuple[float, float]:
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

# ========== TECLADOS ==========

def main_menu_kbd():
    kb = types.InlineKeyboardMarkup(row_width=2)
    buttons = [
        types.InlineKeyboardButton("🎲 Jugar", callback_data="play"),
        types.InlineKeyboardButton("💰 Mi dinero", callback_data="my_money"),
        types.InlineKeyboardButton("📋 Mis jugadas", callback_data="my_bets"),
        types.InlineKeyboardButton("👥 Referidos", callback_data="referrals"),
        types.InlineKeyboardButton("❓ Cómo jugar", callback_data="how_to_play"),
        types.InlineKeyboardButton("🌐 WebApp", web_app=types.WebAppInfo(url=WEBAPP_URL)),
    ]
    if ADMIN_ID and ADMIN_ID == int(os.getenv("ADMIN_ID")):  # Solo admin ve el botón
        buttons.append(types.InlineKeyboardButton("🛠 Admin", callback_data="admin_panel"))
    kb.add(*buttons)
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
user_states = {}

# ========== HANDLERS DEL BOT ==========

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
        bot.send_message(ref_id, f"🎉 ¡Felicidades! *{first}* se unió usando tu enlace.")
    welcome = (f"✨ ¡Hola de nuevo, *{first}*!\n"
               "Bienvenido a **Rifas Cuba** – tu asistente de la suerte 🍀\n\n"
               "🎯 ¿Listo para ganar?\n"
               "Apuesta, gana y disfruta. ¡La suerte está de tu lado!")
    bot.send_message(uid, welcome, reply_markup=main_menu_kbd())

@bot.callback_query_handler(func=lambda call: call.data == "main")
def main_menu_callback(call):
    bot.edit_message_text("📌 *Menú principal*", call.message.chat.id, call.message.message_id,
                          reply_markup=main_menu_kbd())

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

@bot.callback_query_handler(func=lambda call: call.data == "my_money")
def my_money_callback(call):
    uid = call.from_user.id
    text = f"💰 *Tu saldo actual:*\n\n{format_money(uid)}"
    bot.edit_message_text(text, call.message.chat.id, call.message.message_id,
                          reply_markup=my_money_kbd())

@bot.callback_query_handler(func=lambda call: call.data == "recharge")
def recharge_callback(call):
    uid = call.from_user.id
    cid = call.message.chat.id
    mid = call.message.message_id
    methods = get_deposit_methods()
    if not methods:
        bot.answer_callback_query(call.id, "❌ No hay métodos de depósito configurados.")
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

@bot.message_handler(content_types=['photo'])
def handle_deposit_photo(message):
    uid = message.from_user.id
    state = user_states.get(uid, {})
    if state.get("action") != "awaiting_deposit_proof":
        bot.reply_to(message, "❌ No esperaba una foto. Usa los botones del menú.")
        return
    caption = message.caption or ""
    usd, cup = parse_amount(caption)
    if usd == 0 and cup == 0:
        bot.reply_to(message, "❌ No pude entender el monto. Asegúrate de escribir en el caption algo como `10 usd` o `500 cup`.")
        return
    file_id = message.photo[-1].file_id
    method_id = state["method_id"]
    tx_id = create_transaction(
        user_id=uid,
        ttype="deposit",
        amount_usd=usd,
        amount_cup=cup,
        method_id=method_id,
        proof_file_id=file_id
    )
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
                         f"🎁 Bonus: +{bonus:.2f} USD.\n"
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
    methods = get_withdraw_methods()
    method = next((m for m in methods if m["id"] == method_id), None)
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
                 f"⏳ Procesaremos tu pago en breve.")
    user_states.pop(uid, None)

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

@bot.callback_query_handler(func=lambda call: call.data == "admin_panel")
def admin_panel_callback(call):
    if call.from_user.id != ADMIN_ID:
        bot.answer_callback_query(call.id, "⛔ No autorizado")
        return
    bot.edit_message_text("🔧 *Panel de Administración*",
                          call.message.chat.id, call.message.message_id,
                          reply_markup=admin_menu_kbd())

@bot.callback_query_handler(func=lambda call: call.data == "adm_add_dep")
def admin_add_dep_callback(call):
    if call.from_user.id != ADMIN_ID:
        bot.answer_callback_query(call.id, "⛔ No autorizado")
        return
    bot.send_message(call.from_user.id,
                     "➕ *Añadir método de DEPÓSITO*\n\n"
                     "Envía el *nombre* del método:")
    user_states[call.from_user.id] = {"action": "admin_add_dep", "step": 1}
    bot.answer_callback_query(call.id)

@bot.callback_query_handler(func=lambda call: call.data == "adm_add_wit")
def admin_add_wit_callback(call):
    if call.from_user.id != ADMIN_ID:
        bot.answer_callback_query(call.id, "⛔ No autorizado")
        return
    bot.send_message(call.from_user.id,
                     "➕ *Añadir método de RETIRO*\n\n"
                     "Envía el *nombre* del método:")
    user_states[call.from_user.id] = {"action": "admin_add_wit", "step": 1}
    bot.answer_callback_query(call.id)

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
            bot.reply_to(message, "❌ *Formato inválido.* Envía un número positivo.")
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

@bot.message_handler(func=lambda m: True)
def fallback_handler(message):
    uid = message.from_user.id
    text = message.text.lower()
    if text == "/balance":
        bot.reply_to(message, format_money(uid))
    elif text == "/admin" and uid == ADMIN_ID:
        bot.send_message(uid, "🔧 *Panel de administración*", reply_markup=admin_menu_kbd())
    else:
        bot.reply_to(message, "No entendí ese mensaje. Usa los botones del menú.",
                     reply_markup=main_menu_kbd())

# ========== SERVIDOR WEB FLASK ==========
app = Flask(__name__)

# HTML de la WebApp (contenido completo)
WEBAPP_HTML = '''<!DOCTYPE html>
<html lang="es">
<head>
    <meta charset="UTF-8">
    <meta name="viewport" content="width=device-width, initial-scale=1.0, maximum-scale=1.0, user-scalable=no, viewport-fit=cover">
    <title>Rifas Cuba · WebApp</title>
    <script src="https://telegram.org/js/telegram-webapp.js"></script>
    <script src="https://cdn.jsdelivr.net/npm/@supabase/supabase-js@2"></script>
    <link rel="stylesheet" href="https://cdnjs.cloudflare.com/ajax/libs/font-awesome/6.0.0-beta3/css/all.min.css">
    <style>
        * {
            margin: 0;
            padding: 0;
            box-sizing: border-box;
            font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, Helvetica, Arial, sans-serif;
        }

        :root {
            --bg-gradient: linear-gradient(145deg, #f8f5f2 0%, #f0ebe7 100%);
            --surface: rgba(255, 255, 255, 0.8);
            --surface-solid: #ffffff;
            --text-primary: #2c3e4f;
            --text-secondary: #5a6c7a;
            --accent: #b48c5c;
            --accent-soft: #e6d5b8;
            --border: rgba(44, 62, 79, 0.1);
            --shadow: 0 10px 30px rgba(0, 0, 0, 0.05), 0 2px 8px rgba(0, 0, 0, 0.02);
            --card-bg: rgba(255, 255, 255, 0.7);
            --success: #4a7c6b;
            --warning: #b48c5c;
            --danger: #b35e5e;
            --info: #5c8db4;
            --header-bg: rgba(255, 255, 255, 0.85);
            --menu-bg: rgba(255, 255, 255, 0.95);
        }

        [data-theme="dark"] {
            --bg-gradient: linear-gradient(145deg, #1a1e24 0%, #0f1217 100%);
            --surface: rgba(28, 32, 38, 0.85);
            --surface-solid: #1e2229;
            --text-primary: #e3e9f0;
            --text-secondary: #a0aab5;
            --accent: #c0a06b;
            --accent-soft: #3e3a32;
            --border: rgba(192, 160, 107, 0.2);
            --shadow: 0 10px 30px rgba(0, 0, 0, 0.5), 0 2px 8px rgba(0, 0, 0, 0.4);
            --card-bg: rgba(30, 34, 41, 0.8);
            --success: #6b9c8b;
            --warning: #c0a06b;
            --danger: #c57a7a;
            --info: #7a9fc0;
            --header-bg: rgba(18, 22, 28, 0.9);
            --menu-bg: rgba(22, 26, 33, 0.98);
        }

        body {
            background: var(--bg-gradient);
            color: var(--text-primary);
            min-height: 100vh;
            padding-top: 70px;
            padding-bottom: 80px;
            backdrop-filter: blur(2px);
            transition: background 0.3s ease, color 0.2s ease;
            line-height: 1.5;
        }

        .container {
            max-width: 480px;
            margin: 0 auto;
            padding: 0 16px;
        }

        /* ===== HEADER FLOTANTE OCULTABLE ===== */
        .header {
            position: fixed;
            top: 0;
            left: 0;
            right: 0;
            z-index: 50;
            background: var(--header-bg);
            backdrop-filter: blur(16px) saturate(180%);
            -webkit-backdrop-filter: blur(16px) saturate(180%);
            border-bottom: 1px solid var(--border);
            padding: 12px 20px;
            display: flex;
            align-items: center;
            justify-content: space-between;
            box-shadow: var(--shadow);
            transition: transform 0.3s cubic-bezier(0.2, 0, 0, 1);
        }

        .header.hidden {
            transform: translateY(-100%);
        }

        .header h1 {
            font-size: 1.5rem;
            font-weight: 600;
            color: var(--accent);
            letter-spacing: -0.5px;
        }

        .menu-toggle {
            background: var(--surface);
            border: 1px solid var(--border);
            border-radius: 50%;
            width: 44px;
            height: 44px;
            display: flex;
            align-items: center;
            justify-content: center;
            font-size: 1.4rem;
            color: var(--accent);
            cursor: pointer;
            transition: all 0.2s;
            box-shadow: var(--shadow);
        }

        .menu-toggle:hover {
            background: var(--accent-soft);
            color: var(--accent);
        }

        /* ===== MENÚ LATERAL DESPLEGABLE ===== */
        .side-menu {
            position: fixed;
            top: 0;
            left: -280px;
            width: 260px;
            height: 100vh;
            background: var(--menu-bg);
            backdrop-filter: blur(20px);
            -webkit-backdrop-filter: blur(20px);
            border-right: 1px solid var(--border);
            box-shadow: 2px 0 20px rgba(0,0,0,0.1);
            z-index: 100;
            transition: left 0.3s cubic-bezier(0.16, 1, 0.3, 1);
            padding: 24px 16px;
            display: flex;
            flex-direction: column;
        }

        .side-menu.open {
            left: 0;
        }

        .menu-overlay {
            position: fixed;
            top: 0;
            left: 0;
            right: 0;
            bottom: 0;
            background: rgba(0,0,0,0.4);
            backdrop-filter: blur(4px);
            z-index: 90;
            opacity: 0;
            visibility: hidden;
            transition: opacity 0.3s;
        }

        .menu-overlay.active {
            opacity: 1;
            visibility: visible;
        }

        .menu-item {
            display: flex;
            align-items: center;
            gap: 14px;
            padding: 16px 14px;
            border-radius: 20px;
            color: var(--text-primary);
            font-size: 1.1rem;
            font-weight: 500;
            transition: background 0.2s;
            margin-bottom: 4px;
        }

        .menu-item i {
            width: 24px;
            color: var(--accent);
        }

        .menu-item:hover {
            background: var(--accent-soft);
        }

        .menu-item.active {
            background: var(--accent-soft);
            color: var(--accent);
        }

        /* ===== CARDS GLASS ===== */
        .card {
            background: var(--card-bg);
            backdrop-filter: blur(16px) saturate(180%);
            -webkit-backdrop-filter: blur(16px) saturate(180%);
            border-radius: 28px;
            padding: 24px 20px;
            margin-bottom: 18px;
            border: 1px solid var(--border);
            box-shadow: var(--shadow);
            transition: all 0.25s;
        }

        .balance-row {
            display: flex;
            justify-content: space-between;
            align-items: baseline;
            padding: 12px 0;
            border-bottom: 1px dashed var(--border);
        }

        .balance-row:last-child {
            border-bottom: none;
        }

        .currency {
            font-size: 0.95rem;
            color: var(--text-secondary);
            display: flex;
            align-items: center;
            gap: 6px;
        }

        .amount {
            font-size: 1.5rem;
            font-weight: 600;
            color: var(--text-primary);
        }

        .badge {
            background: var(--accent-soft);
            color: var(--accent);
            padding: 6px 14px;
            border-radius: 40px;
            font-size: 0.75rem;
            font-weight: 600;
            letter-spacing: 0.5px;
            text-transform: uppercase;
        }

        /* ===== BOTONES ===== */
        .btn {
            background: var(--surface-solid);
            border: 1px solid var(--border);
            border-radius: 40px;
            padding: 14px 20px;
            font-size: 1rem;
            font-weight: 500;
            color: var(--text-primary);
            display: flex;
            align-items: center;
            justify-content: center;
            gap: 10px;
            cursor: pointer;
            transition: all 0.2s;
            box-shadow: var(--shadow);
            width: 100%;
            margin-top: 12px;
        }

        .btn-primary {
            background: var(--accent);
            color: white;
            border: none;
        }

        .btn-primary i {
            color: white;
        }

        .btn:hover {
            opacity: 0.85;
            transform: translateY(-2px);
        }

        /* ===== TABLA DE JUGADAS ===== */
        .bets-table {
            width: 100%;
            border-collapse: collapse;
        }

        .bets-table th {
            text-align: left;
            font-weight: 500;
            color: var(--text-secondary);
            font-size: 0.75rem;
            padding-bottom: 12px;
            border-bottom: 1px solid var(--border);
        }

        .bets-table td {
            padding: 14px 0;
            border-bottom: 1px dashed var(--border);
            font-size: 0.9rem;
        }

        .lottery-badge {
            background: var(--accent-soft);
            color: var(--accent);
            border-radius: 20px;
            padding: 4px 12px;
            font-size: 0.75rem;
            font-weight: 600;
        }

        /* ===== FORMULARIOS ===== */
        .form-group {
            margin-bottom: 18px;
        }

        .form-label {
            display: block;
            font-size: 0.85rem;
            color: var(--text-secondary);
            margin-bottom: 6px;
        }

        .form-control {
            width: 100%;
            padding: 14px 18px;
            background: var(--surface);
            border: 1px solid var(--border);
            border-radius: 24px;
            color: var(--text-primary);
            font-size: 1rem;
            backdrop-filter: blur(4px);
        }

        .form-control:focus {
            outline: none;
            border-color: var(--accent);
        }

        /* ===== SECCIONES ===== */
        .section {
            display: none;
        }

        .section.active {
            display: block;
        }

        /* ===== FOOTER ===== */
        .footer-note {
            text-align: center;
            color: var(--text-secondary);
            font-size: 0.8rem;
            margin-top: 30px;
            opacity: 0.7;
        }

        /* ===== LOADING ===== */
        .loading {
            display: flex;
            justify-content: center;
            align-items: center;
            padding: 40px 0;
        }

        .spinner {
            width: 44px;
            height: 44px;
            border: 3px solid var(--border);
            border-top-color: var(--accent);
            border-radius: 50%;
            animation: spin 0.8s linear infinite;
        }

        @keyframes spin { to { transform: rotate(360deg); } }

        .hidden { display: none !important; }
    </style>
</head>
<body>
    <!-- Header ocultable -->
    <header class="header" id="mainHeader">
        <div class="menu-toggle" id="menuToggle">
            <i class="fas fa-bars"></i>
        </div>
        <h1>🎰 Rifas</h1>
        <div style="width: 44px;"></div> <!-- placeholder -->
    </header>

    <!-- Menú lateral -->
    <div class="side-menu" id="sideMenu">
        <div style="margin-bottom: 30px; padding: 10px;">
            <h2 style="color: var(--accent);">Menú</h2>
        </div>
        <div class="menu-item active" data-section="dashboard">
            <i class="fas fa-home"></i> Inicio
        </div>
        <div class="menu-item" data-section="play">
            <i class="fas fa-dice"></i> Jugar
        </div>
        <div class="menu-item" data-section="money">
            <i class="fas fa-wallet"></i> Mi Dinero
        </div>
        <div class="menu-item" data-section="bets">
            <i class="fas fa-list"></i> Mis Jugadas
        </div>
        <div class="menu-item" data-section="referrals">
            <i class="fas fa-users"></i> Referidos
        </div>
        <div class="menu-item" data-section="howto">
            <i class="fas fa-question-circle"></i> Cómo jugar
        </div>
        <div id="adminMenuItem" class="menu-item hidden" data-section="admin">
            <i class="fas fa-cog"></i> Admin
        </div>
        <div style="flex-grow: 1;"></div>
        <div class="menu-item" id="themeToggleMenuItem">
            <i class="fas fa-palette"></i> Cambiar tema
        </div>
    </div>
    <div class="menu-overlay" id="menuOverlay"></div>

    <div class="container">
        <!-- SECCIÓN DASHBOARD (INICIO) -->
        <div id="sectionDashboard" class="section active">
            <div class="card">
                <div style="display: flex; justify-content: space-between; align-items: center; margin-bottom: 16px;">
                    <span class="badge">💰 SALDO</span>
                    <span id="bonusBadge" class="badge" style="background: var(--accent-soft);">🎁 Bono</span>
                </div>
                <div id="balanceContent">
                    <div class="loading"><div class="spinner"></div></div>
                </div>
            </div>
            <div class="card">
                <span class="badge">📋 RESUMEN</span>
                <p style="margin-top: 16px;">Bienvenido a Rifas Cuba. Usa el menú para jugar, recargar o ver tus movimientos.</p>
            </div>
        </div>

        <!-- SECCIÓN JUGAR -->
        <div id="sectionPlay" class="section">
            <div class="card">
                <span class="badge">🎲 NUEVA JUGADA</span>
                <div class="form-group" style="margin-top: 20px;">
                    <label class="form-label">Lotería</label>
                    <select id="playLottery" class="form-control">
                        <option value="Florida">🦩 Florida</option>
                        <option value="Georgia">🍑 Georgia</option>
                        <option value="Nueva York">🗽 Nueva York</option>
                    </select>
                </div>
                <div class="form-group">
                    <label class="form-label">Tipo</label>
                    <select id="playType" class="form-control">
                        <option value="fijo">🎯 Fijo</option>
                        <option value="corridos">🏃 Corridos</option>
                        <option value="centena">💯 Centena</option>
                        <option value="parle">🔒 Parle</option>
                    </select>
                </div>
                <div class="form-group">
                    <label class="form-label">Números (ej: 12 con 1 usd)</label>
                    <textarea id="playNumbers" class="form-control" rows="3" placeholder="Ej: 12 con 1 usd, 34 con 2 usd"></textarea>
                </div>
                <button class="btn btn-primary" id="btnPlaceBet">
                    <i class="fas fa-check"></i> Registrar Jugada
                </button>
                <div id="betResult" style="margin-top: 16px;"></div>
            </div>
        </div>

        <!-- SECCIÓN MI DINERO -->
        <div id="sectionMoney" class="section">
            <div class="card">
                <span class="badge">💵 SALDO DETALLADO</span>
                <div id="detailedBalance" style="margin-top: 16px;"></div>
            </div>
            <div class="card">
                <span class="badge">📥 DEPÓSITO</span>
                <div class="form-group">
                    <label class="form-label">Monto (ej: 10 usd)</label>
                    <input type="text" id="depositAmount" class="form-control" placeholder="10 usd">
                </div>
                <div class="form-group">
                    <label class="form-label">Método</label>
                    <select id="depositMethod" class="form-control"></select>
                </div>
                <button class="btn btn-primary" id="btnRequestDeposit">
                    <i class="fas fa-camera"></i> Solicitar Depósito
                </button>
            </div>
            <div class="card">
                <span class="badge">📤 RETIRO</span>
                <div class="form-group">
                    <label class="form-label">Monto USD</label>
                    <input type="number" id="withdrawAmount" class="form-control" placeholder="Mínimo 1 USD" step="0.01">
                </div>
                <div class="form-group">
                    <label class="form-label">Método</label>
                    <select id="withdrawMethod" class="form-control"></select>
                </div>
                <div class="form-group">
                    <label class="form-label">Cuenta | Confirmación</label>
                    <input type="text" id="withdrawDetails" class="form-control" placeholder="1234567890 | 1234">
                </div>
                <button class="btn btn-primary" id="btnRequestWithdraw">
                    <i class="fas fa-money-bill-wave"></i> Solicitar Retiro
                </button>
            </div>
            <div class="card">
                <span class="badge">🔄 TRANSFERIR</span>
                <div class="form-group">
                    <label class="form-label">ID Destino</label>
                    <input type="number" id="transferTarget" class="form-control" placeholder="ID de Telegram">
                </div>
                <div class="form-group">
                    <label class="form-label">Monto USD</label>
                    <input type="number" id="transferAmount" class="form-control" placeholder="0.00" step="0.01">
                </div>
                <button class="btn btn-primary" id="btnTransfer">
                    <i class="fas fa-exchange-alt"></i> Transferir
                </button>
            </div>
        </div>

        <!-- SECCIÓN MIS JUGADAS -->
        <div id="sectionBets" class="section">
            <div class="card">
                <span class="badge">📋 HISTORIAL</span>
                <div id="betsList" style="margin-top: 20px;">
                    <div class="loading"><div class="spinner"></div></div>
                </div>
            </div>
        </div>

        <!-- SECCIÓN REFERIDOS -->
        <div id="sectionReferrals" class="section">
            <div class="card">
                <span class="badge">👥 REFERIDOS</span>
                <div id="referralContent" style="margin-top: 20px;"></div>
            </div>
        </div>

        <!-- SECCIÓN CÓMO JUGAR -->
        <div id="sectionHowto" class="section">
            <div class="card">
                <span class="badge">❓ AYUDA</span>
                <p style="margin-top: 16px;">1. Elige lotería y tipo.<br>2. Escribe números con monto.<br>3. Confirma.<br><br>Depósitos: captura de pantalla.<br>Retiros: mínimo 1 USD.</p>
            </div>
        </div>

        <!-- SECCIÓN ADMIN (solo visible para admin) -->
        <div id="sectionAdmin" class="section">
            <div class="card">
                <span class="badge">🔧 ADMIN</span>
                <div id="adminContent"></div>
            </div>
        </div>

        <div class="footer-note">
            Rifas Cuba · v2.0
        </div>
    </div>

    <script>
        // ========== INYECCIÓN DE VARIABLES DESDE FLASK ==========
        const ADMIN_ID = {{ admin_id }};
        const SUPABASE_URL = "{{ supabase_url }}";
        const SUPABASE_ANON_KEY = "{{ supabase_anon_key }}";

        // ========== INICIALIZACIÓN ==========
        const tg = Telegram.WebApp;
        tg.ready();
        tg.expand();

        const supabase = window.supabase.createClient(SUPABASE_URL, SUPABASE_ANON_KEY);
        let userId = null;
        try {
            if (tg.initDataUnsafe?.user) {
                userId = tg.initDataUnsafe.user.id;
            } else {
                userId = 0; // fallback, no debería pasar
            }
        } catch (e) {
            userId = 0;
        }

        // ========== GESTIÓN DE TEMA ==========
        const savedTheme = localStorage.getItem('theme') || 'light';
        document.documentElement.setAttribute('data-theme', savedTheme);

        function toggleTheme() {
            const current = document.documentElement.getAttribute('data-theme');
            const newTheme = current === 'dark' ? 'light' : 'dark';
            document.documentElement.setAttribute('data-theme', newTheme);
            localStorage.setItem('theme', newTheme);
        }

        // ========== MENÚ LATERAL Y HEADER OCULTABLE ==========
        const menu = document.getElementById('sideMenu');
        const overlay = document.getElementById('menuOverlay');
        const menuToggle = document.getElementById('menuToggle');
        const header = document.getElementById('mainHeader');
        let lastScrollY = 0;

        menuToggle.addEventListener('click', () => {
            menu.classList.add('open');
            overlay.classList.add('active');
        });

        overlay.addEventListener('click', () => {
            menu.classList.remove('open');
            overlay.classList.remove('active');
        });

        document.getElementById('themeToggleMenuItem').addEventListener('click', () => {
            toggleTheme();
            menu.classList.remove('open');
            overlay.classList.remove('active');
        });

        // Ocultar header al hacer scroll hacia abajo
        window.addEventListener('scroll', () => {
            const currentY = window.scrollY;
            if (currentY > lastScrollY && currentY > 60) {
                header.classList.add('hidden');
            } else {
                header.classList.remove('hidden');
            }
            lastScrollY = currentY;
        });

        // ========== NAVEGACIÓN ENTRE SECCIONES ==========
        const sections = ['dashboard', 'play', 'money', 'bets', 'referrals', 'howto', 'admin'];
        const menuItems = document.querySelectorAll('.menu-item[data-section]');

        function showSection(sectionId) {
            sections.forEach(id => {
                document.getElementById(`section${id.charAt(0).toUpperCase() + id.slice(1)}`).classList.remove('active');
            });
            document.getElementById(`section${sectionId.charAt(0).toUpperCase() + sectionId.slice(1)}`).classList.add('active');
            menuItems.forEach(item => item.classList.remove('active'));
            document.querySelector(`.menu-item[data-section="${sectionId}"]`).classList.add('active');
            menu.classList.remove('open');
            overlay.classList.remove('active');
        }

        menuItems.forEach(item => {
            item.addEventListener('click', (e) => {
                const section = e.currentTarget.dataset.section;
                showSection(section);
            });
        });

        // ========== MOSTRAR ADMIN SOLO SI ES ADMIN ==========
        if (userId === ADMIN_ID) {
            document.getElementById('adminMenuItem').classList.remove('hidden');
        }

        // ========== CARGAR DATOS DEL USUARIO ==========
        async function loadUserData() {
            try {
                const { data: user, error } = await supabase
                    .from('users')
                    .select('*')
                    .eq('user_id', userId)
                    .maybeSingle();

                if (error) throw error;

                if (user) {
                    // Dashboard
                    const balanceHtml = `
                        <div class="balance-row">
                            <span class="currency"><i class="fas fa-dollar-sign"></i> USD real</span>
                            <span class="amount">${user.usd?.toFixed(2) || '0.00'}</span>
                        </div>
                        <div class="balance-row">
                            <span class="currency"><i class="fas fa-coins"></i> CUP</span>
                            <span class="amount">${user.cup?.toFixed(2) || '0.00'}</span>
                        </div>
                        <div class="balance-row">
                            <span class="currency"><i class="fas fa-gift"></i> Bono USD</span>
                            <span class="amount" style="color: var(--accent);">${user.bonus_usd?.toFixed(2) || '0.00'}</span>
                        </div>
                    `;
                    document.getElementById('balanceContent').innerHTML = balanceHtml;
                    document.getElementById('detailedBalance').innerHTML = balanceHtml;
                }
            } catch (e) {
                console.error(e);
            }
        }

        // ========== CARGAR MÉTODOS DE PAGO ==========
        async function loadPaymentMethods() {
            try {
                const { data: depMethods } = await supabase.from('deposit_methods').select('*').eq('active', true);
                const { data: witMethods } = await supabase.from('withdraw_methods').select('*').eq('active', true);

                const depSelect = document.getElementById('depositMethod');
                depSelect.innerHTML = depMethods.map(m => `<option value="${m.id}">${m.name}</option>`).join('');

                const witSelect = document.getElementById('withdrawMethod');
                witSelect.innerHTML = witMethods.map(m => `<option value="${m.id}">${m.name}</option>`).join('');
            } catch (e) {}
        }

        // ========== CARGAR JUGADAS ==========
        async function loadBets() {
            try {
                const { data: bets } = await supabase
                    .from('bets')
                    .select('*')
                    .eq('user_id', userId)
                    .order('created_at', { ascending: false })
                    .limit(10);

                const container = document.getElementById('betsList');
                if (!bets || bets.length === 0) {
                    container.innerHTML = '<p style="text-align:center; color:var(--text-secondary);">📭 No hay jugadas</p>';
                } else {
                    let html = '<table class="bets-table"><thead><tr><th>Fecha</th><th>Lot</th><th>Números</th></tr></thead><tbody>';
                    bets.forEach(b => {
                        const date = new Date(b.created_at).toLocaleDateString('es-ES', { day:'2-digit', month:'2-digit', hour:'2-digit', minute:'2-digit' });
                        const lot = b.lottery === 'Florida' ? '🦩' : b.lottery === 'Georgia' ? '🍑' : '🗽';
                        html += `<tr><td style="font-size:0.75rem;">${date}</td><td><span class="lottery-badge">${lot}</span></td><td style="max-width:150px; overflow:hidden; text-overflow:ellipsis;">${b.raw.substring(0,15)}…</td></tr>`;
                    });
                    html += '</tbody></table>';
                    container.innerHTML = html;
                }
            } catch (e) {}
        }

        // ========== REFERIDOS ==========
        async function loadReferrals() {
            try {
                const { data: refs } = await supabase.from('users').select('user_id').eq('ref', userId);
                const total = refs?.length || 0;
                const botUsername = tg.initDataUnsafe?.user?.username ? tg.initDataUnsafe.user.username : 'rifas_cuba_bot';
                const link = `https://t.me/${botUsername}?start=${userId}`;
                document.getElementById('referralContent').innerHTML = `
                    <p><strong>Total:</strong> ${total}</p>
                    <p><strong>Tu enlace:</strong></p>
                    <input class="form-control" value="${link}" readonly onclick="this.select()">
                    <p style="margin-top:12px; font-size:0.9rem;">Gana 5% de cada apuesta de tus referidos.</p>
                `;
            } catch (e) {}
        }

        // ========== REGISTRAR JUGADA ==========
        document.getElementById('btnPlaceBet').addEventListener('click', async () => {
            const lottery = document.getElementById('playLottery').value;
            const betType = document.getElementById('playType').value;
            const numbers = document.getElementById('playNumbers').value.trim();
            if (!numbers) return alert('Escribe los números');

            // Parsear costo (simplificado, se puede mejorar)
            let costUsd = 0, costCup = 0;
            const match = numbers.match(/(\d+(?:\.\d+)?)\s*(usd|cup)/i);
            if (match) {
                const val = parseFloat(match[1]);
                if (match[2].toLowerCase() === 'usd') costUsd = val;
                else costCup = val;
            } else {
                // Precio por defecto
                const { data: prices } = await supabase.from('config').select('value').eq('key', 'play_prices');
                if (prices?.length) {
                    const p = JSON.parse(prices[0].value)[betType];
                    if (p) { costUsd = p.usd; costCup = p.cup; }
                }
            }

            try {
                const { error } = await supabase.rpc('add_bet', {
                    p_user_id: userId,
                    p_lottery: lottery,
                    p_bet_type: betType,
                    p_raw: numbers,
                    p_cost_usd: costUsd,
                    p_cost_cup: costCup
                });
                if (error) throw error;
                document.getElementById('betResult').innerHTML = '<span style="color:var(--success);">✅ Jugada registrada</span>';
                loadBets();
                loadUserData();
            } catch (e) {
                document.getElementById('betResult').innerHTML = '<span style="color:var(--danger);">❌ Error, saldo insuficiente o formato</span>';
            }
        });

        // ========== SOLICITAR DEPÓSITO ==========
        document.getElementById('btnRequestDeposit').addEventListener('click', async () => {
            const amount = document.getElementById('depositAmount').value.trim();
            const methodId = document.getElementById('depositMethod').value;
            if (!amount) return alert('Ingresa monto');
            const { usd, cup } = parseAmount(amount);
            if (usd === 0 && cup === 0) return alert('Formato inválido. Ej: 10 usd');

            // Crear transacción
            const { data, error } = await supabase.rpc('request_deposit', {
                p_user_id: userId,
                p_usd: usd,
                p_cup: cup,
                p_method_id: parseInt(methodId)
            });
            if (error) return alert('Error al solicitar');
            alert('✅ Solicitud enviada. Envía la captura por Telegram.');
            // Abrir chat del bot
            tg.openTelegramLink('https://t.me/' + tg.initDataUnsafe?.user?.username);
        });

        // ========== SOLICITAR RETIRO ==========
        document.getElementById('btnRequestWithdraw').addEventListener('click', async () => {
            const amount = parseFloat(document.getElementById('withdrawAmount').value);
            const methodId = document.getElementById('withdrawMethod').value;
            const details = document.getElementById('withdrawDetails').value.trim();
            if (!amount || amount < 1) return alert('Monto mínimo 1 USD');
            if (!details.includes('|')) return alert('Formato: cuenta | confirmación');

            const { error } = await supabase.rpc('request_withdraw', {
                p_user_id: userId,
                p_amount_usd: amount,
                p_method_id: parseInt(methodId),
                p_details: details
            });
            if (error) return alert('Error al solicitar retiro');
            alert('✅ Solicitud de retiro enviada');
            loadUserData();
        });

        // ========== TRANSFERENCIA ==========
        document.getElementById('btnTransfer').addEventListener('click', async () => {
            const target = parseInt(document.getElementById('transferTarget').value);
            const amount = parseFloat(document.getElementById('transferAmount').value);
            if (!target || !amount || amount <= 0) return alert('Datos inválidos');

            const { error } = await supabase.rpc('transfer_balance', {
                p_from: userId,
                p_to: target,
                p_amount_usd: amount
            });
            if (error) return alert('Error en transferencia (saldo o ID)');
            alert('✅ Transferencia exitosa');
            loadUserData();
        });

        // ========== PARSE AMOUNT ==========
        function parseAmount(t) {
            t = t.toLowerCase().replace(',', '.').trim();
            let usd = 0, cup = 0;
            if (t.includes('usd')) usd = parseFloat(t.split('usd')[0].trim()) || 0;
            else if (t.includes('cup')) cup = parseFloat(t.split('cup')[0].trim()) || 0;
            else usd = parseFloat(t) || 0;
            return { usd, cup };
        }

        // ========== INICIALIZACIÓN ==========
        (async () => {
            await loadUserData();
            await loadPaymentMethods();
            await loadBets();
            await loadReferrals();
        })();

        // Recargar cada 30 seg
        setInterval(() => {
            loadUserData();
            loadBets();
            loadReferrals();
        }, 30000);
    </script>
</body>
</html>
'''

@app.route('/')
def serve_webapp():
    return render_template_string(WEBAPP_HTML, admin_id=ADMIN_ID, supabase_url=SUPABASE_URL, supabase_anon_key=SUPABASE_KEY)

@app.route('/webhook', methods=['POST'])
def webhook():
    if request.headers.get('content-type') == 'application/json':
        json_string = request.get_data().decode('utf-8')
        update = telebot.types.Update.de_json(json_string)
        bot.process_new_updates([update])
        return 'ok', 200
    return 'error', 403

def run_bot():
    bot.remove_webhook()
    bot.infinity_polling()

if __name__ == "__main__":
    threading.Thread(target=run_bot, daemon=True).start()
    app.run(host="0.0.0.0", port=int(os.environ.get("PORT", 5000)))
