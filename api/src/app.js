const express = require('express');
const cors = require('cors');
const dashboardRoutes = require('./routes/dashboardRoutes');

const app = express();

app.use(cors());
app.use(express.json());

// Registrando rotas
app.use('/api/v1/dashboard', dashboardRoutes);
app.use('/api/v1/auth', require('./routes/authRoutes'));

// Rota raiz de healthcheck
app.get('/', (req, res) => {
  res.json({ message: 'Portal Comercial Executivo API rodando!' });
});

module.exports = app;
