#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
Servidor Web + Bot de Rifas Cuba
Versión corregida - Sirve index.html desde la raíz
"""

import os
import threading
import logging
from flask import Flask, send_from_directory, abort

# Importar el bot
import bot_rifas_cuba

# Configurar logging
logging.basicConfig(level=logging.INFO)
logger = logging.getLogger(__name__)

# Crear aplicación Flask
app = Flask(__name__)

# Ruta principal: sirve index.html
@app.route('/')
def serve_webapp():
    try:
        # Busca index.html en el directorio actual
        return send_from_directory('.', 'index.html')
    except Exception as e:
        logger.error(f"Error sirviendo index.html: {e}")
        abort(404)

# Ruta para archivos estáticos (si los hay)
@app.route('/<path:path>')
def serve_static(path):
    try:
        return send_from_directory('.', path)
    except Exception:
        abort(404)

# Health check para Render (opcional pero recomendado)
@app.route('/health')
def health():
    return 'OK', 200

# Función para iniciar el bot en un hilo separado
def start_bot():
    logger.info("🚀 Iniciando bot en hilo separado...")
    bot_rifas_cuba.run_bot()

if __name__ == '__main__':
    # Iniciar el bot en un hilo demonio
    bot_thread = threading.Thread(target=start_bot, daemon=True)
    bot_thread.start()
    logger.info("✅ Bot lanzado en segundo plano")

    # Obtener puerto de Render (variable de entorno PORT)
    port = int(os.environ.get('PORT', 5000))
    logger.info(f"🌐 Servidor Flask corriendo en puerto {port}")

    # Iniciar servidor Flask
    app.run(host='0.0.0.0', port=port, debug=False)
