#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
Servidor Web + Bot de Rifas Cuba
Con renderizado de plantilla para inyectar variables de entorno
"""

import os
import threading
import logging
from flask import Flask, render_template_string

# Importar el bot
import bot_rifas_cuba

# Configurar logging
logging.basicConfig(level=logging.INFO)
logger = logging.getLogger(__name__)

# Crear aplicación Flask
app = Flask(__name__)

# Cargar el contenido del index.html
with open('index.html', 'r', encoding='utf-8') as f:
    INDEX_HTML = f.read()

@app.route('/')
def serve_webapp():
    """Sirve la WebApp con las variables de entorno inyectadas."""
    # Obtener variables del entorno (ya cargadas por python-dotenv en el bot)
    supabase_url = os.environ.get('SUPABASE_URL', '')
    supabase_key = os.environ.get('SUPABASE_KEY', '')
    admin_id = os.environ.get('ADMIN_ID', '0')
    bot_username = os.environ.get('BOT_USERNAME', '')  # ⚠️ NUEVA VARIABLE
    
    # Renderizar el HTML reemplazando los placeholders
    rendered = INDEX_HTML.replace('{{ SUPABASE_URL }}', supabase_url) \
                         .replace('{{ SUPABASE_ANON_KEY }}', supabase_key) \
                         .replace('{{ ADMIN_ID }}', admin_id) \
                         .replace('{{ BOT_USERNAME }}', bot_username)
    
    return rendered

# Ruta opcional para health check
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
    
    app.run(host='0.0.0.0', port=port, debug=False)
