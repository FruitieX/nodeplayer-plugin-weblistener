var nodeplayerConfig = require('nodeplayer').config;

var defaultConfig = {};

defaultConfig.setAsRoot = true; // should requests to '/' be redirected to this module?

module.exports = defaultConfig;
