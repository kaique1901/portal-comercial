const crypto = require('crypto');

// Token de sessão do portal: payload JSON assinado com HMAC-SHA256 (formato
// "payload.assinatura", ambos base64url). Não é JWT completo de propósito — só o
// necessário, sem dependência nova. O payload leva o cargo e o CÓDIGO do usuário
// (codgerente/codsupervisor); o escopo de dados é sempre resolvido no servidor a
// partir disso, nunca a partir do que o navegador manda.
//
// AUTH_SECRET deve vir do ambiente. Sem ele a API sobe com um segredo aleatório
// por processo: funciona, mas todo restart da API derruba as sessões abertas
// (cada usuário precisa logar de novo).
let SEGREDO = process.env.AUTH_SECRET;
if (!SEGREDO) {
  SEGREDO = crypto.randomBytes(32).toString('hex');
  console.warn('[auth] AUTH_SECRET não definido — usando segredo aleatório deste processo (sessões caem a cada restart da API).');
}

const VALIDADE_MS = Math.max(1, parseInt(process.env.AUTH_SESSAO_HORAS, 10) || 12) * 60 * 60 * 1000;

const b64 = buf => Buffer.from(buf).toString('base64url');
const assinar = txt => crypto.createHmac('sha256', SEGREDO).update(txt).digest('base64url');

function emitir(dados) {
  const payload = b64(JSON.stringify({ ...dados, exp: Date.now() + VALIDADE_MS }));
  return `${payload}.${assinar(payload)}`;
}

// Devolve o payload se o token é válido e não expirou; senão null.
function verificar(token) {
  if (!token || typeof token !== 'string') return null;
  const [payload, sig] = token.split('.');
  if (!payload || !sig) return null;
  const esperado = assinar(payload);
  const a = Buffer.from(sig), b = Buffer.from(esperado);
  if (a.length !== b.length || !crypto.timingSafeEqual(a, b)) return null;
  let dados;
  try { dados = JSON.parse(Buffer.from(payload, 'base64url').toString('utf8')); } catch (e) { return null; }
  if (!dados || typeof dados.exp !== 'number' || dados.exp < Date.now()) return null;
  return dados;
}

module.exports = { emitir, verificar };
