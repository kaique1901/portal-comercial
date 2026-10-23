const express = require('express');
const cors = require('cors');
const compression = require('compression');
const dashboardRoutes = require('./routes/dashboardRoutes');
const { exigirSessao } = require('./auth/middleware');

const app = express();

app.use(cors());
app.use(compression());
app.use(express.json());

// Registrando rotas
// Todo o /dashboard exige sessão; o escopo (gerente/supervisor) é aplicado no
// controller a partir do token, não do que o navegador pede.
app.use('/api/v1/dashboard', exigirSessao, dashboardRoutes);
app.use('/api/v1/auth', require('./routes/authRoutes'));

// Rota raiz de healthcheck
app.get('/', (req, res) => {
  res.json({ message: 'Portal Comercial Executivo API rodando!' });
});

module.exports = app;
