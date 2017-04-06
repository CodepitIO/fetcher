'use strict';

const async       = require('async');

const Dbs     = require('./src/services/dbs'),
      Fetcher = require('./src/services/fetcher');

Fetcher.start();
