const { verificar } = require('./token');
const Escopo = require('./escopo');
const DashboardCacheManager = require('../jobs/DashboardCacheManager');

// Exige sessão válida (Authorization: Bearer <token emitido por /auth/login>).
function exigirSessao(req, res, next) {
  const h = req.get('authorization') || '';
  const token = h.startsWith('Bearer ') ? h.slice(7).trim() : null;
  const sessao = verificar(token);
  if (!sessao) return res.status(401).json({ error: 'sessão ausente ou expirada — faça login novamente' });
  req.sessao = sessao;
  next();
}

// Só a DIRETORIA (admin).
function exigirAdmin(req, res, next) {
  if (req.sessao && req.sessao.role === 'admin') return next();
  return res.status(403).json({ error: 'acesso restrito à diretoria' });
}

// Escopo da sessão contra o cache atual. null = admin (sem restrição).
// Lança erro com .status (403 sem cadastro, 503 cache ainda não pronto).
function escopoDe(req) {
  if (!req.sessao || req.sessao.role === 'admin') return null;
  const cache = DashboardCacheManager.getCache();
  if (!cache || !cache._hierarquia) { const e = new Error('cadastro da força de vendas ainda não carregado'); e.status = 503; throw e; }
  return Escopo.resolver(cache, req.sessao);
}

module.exports = { exigirSessao, exigirAdmin, escopoDe };
