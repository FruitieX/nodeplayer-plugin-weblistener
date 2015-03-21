'use strict';

var MODULE_NAME = 'plugin-weblistener';

var express = require('express');

var nodeplayerConfig = require('nodeplayer').config;
var coreConfig = nodeplayerConfig.getConfig();
var defaultConfig = require('./default-config.js');
var config = nodeplayerConfig.getConfig(MODULE_NAME, defaultConfig);

var player;

exports.init = function(_player, _logger, callback) {
    player = _player;

    if (!player.plugins['express']) {
        callback('module must be initialized after expressjs module!');
    } else if (!player.plugins['socketio']) {
        // weblistener client depends on socketio module
        callback('module must be initialized after socketio module!');
    } else if (!player.plugins['rest']) {
        // weblistener client depends on rest module
        callback('module must be initialized after rest module!');
    } else {
        player.app.use('/weblistener', express.static(__dirname + '/client'));

        if (config.setAsRoot) {
            player.app.use('/', express.static(__dirname + '/client'));
        }

        callback();
    }
};
