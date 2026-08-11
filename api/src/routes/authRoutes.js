const express = require('express');
const router = express.Router();

router.post('/login', async (req, res) => {
  try {
    const { role, login, senha } = req.body;
    if (!role || !login || !senha) {
      return res.status(400).json({ message: 'role, login e senha são obrigatórios' });
    }

    // Faz o POST por debaixo dos panos, ignorando CORS do navegador
    const externalUrl = `https://apis.cifaldistribuidora.com.br:8001/Roteiro/${role}/login`;
    
    // Como a API backend original roda em node, podemos usar o node-fetch embutido no node 18+
    const response = await fetch(externalUrl, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ login, senha })
    });

    if (!response.ok) {
      return res.status(response.status).json({ message: 'Credenciais inválidas' });
    }

    const data = await response.json();
    return res.json(data);
  } catch (err) {
    console.error('Erro no proxy de login:', err.message);
    return res.status(500).json({ message: 'Falha na comunicação com a API externa', details: err.message });
  }
});

module.exports = router;
