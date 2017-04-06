'use strict';

const fs        = require('fs'),
      async     = require('async'),
      assert    = require('assert'),
      path      = require('path'),
      util      = require('util'),
      _         = require('lodash')

const Errors        = require('../../../common/errors'),
      RequestClient = require('../../../common/lib/requestClient'),
      Util          = require('../../../common/lib/utils');

const TYPE = path.basename(__dirname);
const Config = Util.getOJConfig(TYPE);

const PROBLEMS_PATH_UNF = "/api/v1/problems?max=%s&offset=%s";
const client = new RequestClient(Config.url);
const maxPerPage = 100;

const PROBLEM_PATH_UNF = "/api/v1/problems/%s";
const EXAMPLES_PATH_UNF = "/api/v1/problems/%s/examples?max=10";

const tmplPath = './src/adapters/huxley/problem_template.html';
const tmpl = _.template(fs.readFileSync(tmplPath, 'utf8'));

exports.import = (problem, callback) => {
  let problemPath = util.format(PROBLEM_PATH_UNF, problem.id);
  let examplesPath = util.format(EXAMPLES_PATH_UNF, problem.id);
  async.parallel({
    meta: (next) => {
      return client.get(problemPath, {json: true}, next);
    },
    tests: (next) => {
      return client.get(examplesPath, {json: true}, next);
    }
  }, (err, results) => {
    if (err) return callback(err);
    let data = {};
    try {
      let meta = results.meta[1];
      assert(meta.description.length > 0);
      let tests = results.tests[1];
      if (meta.status === '404') {
        return callback(Errors.ResourceNotFound);
      }
      _.map(tests, (obj) => {
        obj.input = obj.input || '';
        obj.input = obj.input.replace(/\r?\n/g, '<br>');
        obj.output = obj.output || '';
        obj.output = obj.output.replace(/\r?\n/g, '<br>');
        return obj;
      });
      data.supportedLangs = Config.getSupportedLangs();
      data.timelimit = meta.timeLimit;
      if (meta.source) data.source = 'Fonte: ' + meta.source;

      meta.description = meta.description || '';
      meta.description = meta.description.replace(/<=/g, '&lt;=');
      meta.inputFormat = meta.inputFormat || '';
      meta.inputFormat = meta.inputFormat.replace(/<=/g, '&lt;=');
      meta.outputFormat = meta.outputFormat || '';
      meta.outputFormat = meta.outputFormat.replace(/<=/g, '&lt;=');
      data.html = tmpl({
        description: meta.description,
        inputFormat: meta.inputFormat,
        outputFormat: meta.outputFormat,
        tests: tests
      });
    } catch (err) {
      return callback(err);
    }
    return callback(null, data);
  });
}

function processProblems(problemsPath, problems, callback) {
  client.get(problemsPath, (err, res, data) => {
    try {
      data = JSON.parse(data);
    } catch (e) {
      return callback(e);
    }
    for (let i = 0; i < data.length; i++) {
      problems.push({
        id: data[i].id + '',
        name: data[i].name,
        oj: TYPE
      });
    }
    if (data.length !== maxPerPage) {
      return callback(Errors.ResourceNotFound);
    }
    return callback(null);
  });
}

exports.fetchProblems = (callback) => {
  let problems = [];
  let idx = 0;
  async.forever(
    (next) => {
      idx = idx + 1;
      let problemsPath = util.format(PROBLEMS_PATH_UNF, maxPerPage, (idx-1) * maxPerPage);
      return processProblems(problemsPath, problems, next);
    },
    (err) => {
      return callback(null, problems);
    }
  );
}
