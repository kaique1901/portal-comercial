const express = require('express');
const router = express.Router();
const Cifal = require('../auth/cifal');
const { emitir } = require('../auth/token');
const { exigirSessao, escopoDe } = require('../auth/middleware');
const DashboardCacheManager = require('../jobs/DashboardCacheManager');

// Único admin do painel: o "gerente" DIRETORIA (cifalcomercial.gerente.codgerente = 28).
const ADMIN_COD_GERENTE = String(process.env.ADMIN_COD_GERENTE || '28');

// POST /api/v1/auth/login  { role: 'supervisor'|'gerente'|'diretoria', login, senha }
// Valida na API da Cifal (no servidor — o navegador não fala mais com ela) e devolve
// { token, sessao }. O cargo do token sai da RESPOSTA da Cifal, nunca do pedido.
router.post('/login', async (req, res) => {
  try {
    const { role, login, senha } = req.body || {};
    if (!['supervisor', 'gerente', 'diretoria'].includes(role) || !login || !senha) {
      return res.status(400).json({ message: 'role, login e senha são obrigatórios' });
    }
    const rota = role === 'diretoria' ? 'gerente' : role;
    const data = await Cifal.login(rota, String(login), String(senha));
    if (!data) return res.status(401).json({ message: 'Usuário ou senha inválidos.' });

    let cargo, cod;
    if (rota === 'gerente') {
      cod = Cifal.pickCI(data, 'codgerente', 'codger');
      cargo = String(cod) === ADMIN_COD_GERENTE ? 'admin' : 'gerente';
    } else {
      cod = Cifal.pickCI(data, 'codsupervisor', 'codsup');
      cargo = 'supervisor';
    }
    if (cod == null) return res.status(401).json({ message: 'Usuário ou senha inválidos.' });
    // "Diretoria" escolhido com credencial de outro gerente: não vira gerente comum.
    if (role === 'diretoria' && cargo !== 'admin') return res.status(401).json({ message: 'Usuário ou senha inválidos.' });

    const token = emitir({ role: cargo, cod: String(cod) });
    res.json({ token, sessao: { ...data, role: cargo } });
  } catch (err) {
    console.error('[auth/login]', err.message);
    res.status(502).json({ message: 'Falha na comunicação com a API de login', details: err.message });
  }
});

// GET /api/v1/auth/carteira — vendedores e clientes da própria sessão (filtro Cliente).
// Os supervisores vêm do escopo resolvido no servidor, não de algo que o navegador mande.
router.get('/carteira', exigirSessao, async (req, res) => {
  try {
    if (req.sessao.role === 'admin') return res.json({ vendedores: [], todos: [], byVend: {} });
    const esc = escopoDe(req);
    const cache = DashboardCacheManager.getCache();
    const codsSup = [];
    for (const g of ((cache && cache._hierarquia) || {}).gerentes || []) {
      for (const s of g.supervisores || []) if (esc.sups.has(s.nomesupervisor) && s.codsupervisor != null) codsSup.push(s.codsupervisor);
    }
    if (!codsSup.length && esc.role === 'supervisor') codsSup.push(esc.cod);
    res.json(await Cifal.carteiraDosSupervisores([...new Set(codsSup.map(String))]));
  } catch (err) {
    console.error('[auth/carteira]', err.message);
    res.status(err.status || 502).json({ message: err.message });
  }
});

module.exports = router;
