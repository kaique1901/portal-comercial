const express = require('express');
const router = express.Router();
const DashboardController = require('../controllers/DashboardController');
const { exigirAdmin } = require('../auth/middleware');

// Fazemos o bind para não perder o "this" do controller
router.get('/full', DashboardController.getFull.bind(DashboardController));
router.get('/etl-status', DashboardController.getEtlStatus.bind(DashboardController));
router.get('/resumo', exigirAdmin, DashboardController.getResumo.bind(DashboardController));
router.get('/vendas-por-dia', exigirAdmin, DashboardController.getVendasPorDia.bind(DashboardController));
router.get('/categorias', exigirAdmin, DashboardController.getCategorias.bind(DashboardController));
router.get('/hierarquia', exigirAdmin, DashboardController.getHierarquia.bind(DashboardController));
router.get('/clientes', exigirAdmin, DashboardController.getClientes.bind(DashboardController));
router.get('/recorte', DashboardController.getRecorte.bind(DashboardController));
router.get('/dow-cascata', DashboardController.getDowCascata.bind(DashboardController));
router.get('/mix-cascata', DashboardController.getMixCascata.bind(DashboardController));

module.exports = router;
