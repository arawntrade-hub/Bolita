#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
Web Service unificado para Render:
- Sirve la WebApp (index.html) en la raíz.
- Ejecuta el bot de Telegram en un hilo separado.
"""

import os
import threading
import logging
from flask import Flask, send_from_directory

# Importar el módulo del bot
import bot_rifas_cuba

# Configurar logging
logging.basicConfig(level=logging.INFO)
logger = logging.getLogger(__name__)

# Crear aplicación Flask
app = Flask(__name__, static_folder='.')

# Ruta principal: sirve el index.html
@app.route('/')
def serve_webapp():
    return send_from_directory('.', 'index.html')

# Ruta opcional para otros archivos estáticos (CSS, JS, etc.)
@app.route('/<path:path>')
def serve_static(path):
    return send_from_directory('.', path)

# Función para iniciar el bot en un hilo separado
def start_bot():
    logger.info("Iniciando bot en hilo separado...")
    bot_rifas_cuba.run_bot()

if __name__ == '__main__':
    # Iniciar el bot en un hilo demonio
    bot_thread = threading.Thread(target=start_bot, daemon=True)
    bot_thread.start()
    logger.info("Bot lanzado en segundo plano")

    # Obtener puerto de Render (variable de entorno PORT)
    port = int(os.environ.get('PORT', 5000))
    logger.info(f"Servidor Flask corriendo en puerto {port}")
    app.run(host='0.0.0.0', port=port)
