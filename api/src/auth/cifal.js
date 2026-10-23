// Cliente da API de login/roteiro da Cifal. Antes o NAVEGADOR chamava esta API
// direto, com as credenciais de sistema escritas no app.js (qualquer um via no
// DevTools). Agora só o servidor fala com ela.
const HOST = process.env.CIFAL_AUTH_HOST || 'https://apis.cifaldistribuidora.com.br:8001';
// Credenciais de sistema da API da Cifal. Defina CIFAL_AUTH_USER/CIFAL_AUTH_PASS no
// ambiente; o padrão é o mesmo usuário que o front usava, para não quebrar o deploy.
const USUARIO = process.env.CIFAL_AUTH_USER || 'cvlima';
const SENHA = process.env.CIFAL_AUTH_PASS || '123';

// A API devolve PascalCase (CodVendedor) e o Swagger documenta camelCase: lê sem
// diferenciar maiúsculas (mesma regra do pickCI do front).
function pickCI(obj, ...chaves) {
  if (!obj || typeof obj !== 'object') return undefined;
  for (const k of Object.keys(obj)) if (chaves.includes(k.toLowerCase())) return obj[k];
  return undefined;
}

let tokenCache = null; // { token, em }
async function tokenBase() {
  // Reaproveita por 10 min: login + carteira de um gerente fazem dezenas de chamadas.
  if (tokenCache && Date.now() - tokenCache.em < 10 * 60 * 1000) return tokenCache.token;
  const r = await fetch(`${HOST}/auth`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ userName: USUARIO, password: SENHA }),
  });
  if (!r.ok) throw new Error(`auth base da Cifal respondeu ${r.status}`);
  const j = await r.json();
  if (!j || !j.token) throw new Error('auth base da Cifal não devolveu token');
  tokenCache = { token: j.token, em: Date.now() };
  return j.token;
}

// rota = 'gerente' | 'supervisor'. Devolve o JSON do login ou null se credencial inválida.
async function login(rota, usuario, senha) {
  const token = await tokenBase();
  const r = await fetch(`${HOST}/Roteiro/${rota}/login`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
    body: JSON.stringify({ login: usuario, senha }),
  });
  if (!r.ok) return null;
  return r.json();
}

async function get(path) {
  const token = await tokenBase();
  try {
    const r = await fetch(`${HOST}${path}`, { headers: { Authorization: `Bearer ${token}` } });
    return r.ok ? await r.json() : [];
  } catch (e) { return []; }
}

async function mapLimit(itens, limite, fn) {
  const out = new Array(itens.length);
  let i = 0;
  await Promise.all(Array.from({ length: Math.min(limite, itens.length) }, async () => {
    while (i < itens.length) { const idx = i++; out[idx] = await fn(itens[idx], idx); }
  }));
  return out;
}

// Carteira (vendedores + clientes) de uma lista de códigos de supervisor — mesmo
// formato que o front montava em fetchCarteira/resolveVendedoresDaSessao.
async function carteiraDosSupervisores(codsSup) {
  const byCod = new Map();
  const listas = await mapLimit(codsSup, 6, cod => get(`/Roteiro/supervisor/${encodeURIComponent(cod)}/vendedores`));
  listas.forEach(arr => (Array.isArray(arr) ? arr : []).forEach(v => {
    const cod = pickCI(v, 'codvendedor', 'codven', 'codvend', 'cod');
    if (cod != null && !byCod.has(String(cod))) byCod.set(String(cod), { cod, nome: pickCI(v, 'vendedor', 'nomven', 'nome') });
  }));
  const vendedores = [...byCod.values()];
  const clientesListas = await mapLimit(vendedores, 6, v => get(`/Roteiro/vendedor/${encodeURIComponent(v.cod)}/clientes`));
  const todosByCod = new Map();
  const byVend = {};
  vendedores.forEach((v, i) => {
    const doVend = [];
    (Array.isArray(clientesListas[i]) ? clientesListas[i] : []).forEach(c => {
      const cod = pickCI(c, 'codcliente');
      if (cod == null) return;
      const item = { codCliente: cod, cliente: pickCI(c, 'cliente'), nomeFantasia: pickCI(c, 'nomefantasia') };
      doVend.push(item);
      if (!todosByCod.has(String(cod))) todosByCod.set(String(cod), item);
    });
    byVend[String(v.cod)] = doVend;
  });
  return { vendedores, todos: [...todosByCod.values()], byVend };
}

module.exports = { login, carteiraDosSupervisores, pickCI };
