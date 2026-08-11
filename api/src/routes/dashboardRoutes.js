const express = require('express');
const router = express.Router();
const DashboardController = require('../controllers/DashboardController');

// Fazemos o bind para não perder o "this" do controller
router.get('/full', DashboardController.getFull.bind(DashboardController));
router.get('/resumo', DashboardController.getResumo.bind(DashboardController));
router.get('/vendas-por-dia', DashboardController.getVendasPorDia.bind(DashboardController));
router.get('/categorias', DashboardController.getCategorias.bind(DashboardController));
router.get('/hierarquia', DashboardController.getHierarquia.bind(DashboardController));
router.get('/clientes', DashboardController.getClientes.bind(DashboardController));
router.get('/recorte', DashboardController.getRecorte.bind(DashboardController));

module.exports = router;
