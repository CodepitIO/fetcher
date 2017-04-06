'use strict';

const async   = require('async'),
      assert  = require('assert'),
      path    = require('path'),
      cheerio = require('cheerio'),
      util    = require('util'),
      _       = require('lodash');

const Errors        = require('../../../common/errors'),
      RequestClient = require('../../../common/lib/requestClient'),
      Util          = require('../../../common/lib/utils');

const TYPE = path.basename(__dirname);
const Config = Util.getOJConfig(TYPE);

const client = new RequestClient(Config.url);

const PROBLEMS_PATH_UNF = "/toj/list%s.html";

const TIMELIMIT_PATTERN = /time\s*limit:[^\d]+([\d.,]+)/i;
const MEMOLIMIT_PATTERN = /memory\s*limit:[^\d]+([\d.,]+)/i;

exports.import = (problem, callback) => {
  let urlPath = Config.getProblemPath(problem.id);
  client.get(urlPath, (err, res, html) => {
    if (err) return callback(err);
    let data = {};
    try {
      data.supportedLangs = Config.getSupportedLangs();
      html = html.replace(/(<)([^a-zA-Z\s\/\\!])/g, '&lt;$2');
      let $ = cheerio.load(html);
      Util.adjustAnchors($, Config.url + urlPath);
      assert($('#problem').html().length > 0);
      let body =
        '<div class="toj-problem problem-statement ttypography">' +
          $('#problem').html() +
        '</div>' +
        '<script>' +
          '$(function() { MathJax.Hub.Typeset("toj"); });' +
        '</script>';
      let source = $('b:contains("Source")');
      if (source) {
        data.source = 'Source: ' + source.next().text();
      }
      data.timelimit = parseFloat(html.match(TIMELIMIT_PATTERN)[1])
      data.memorylimit = Math.round(parseFloat(html.match(
          MEMOLIMIT_PATTERN)[1]) / 1024.) + ' MB';
      data.html = body;
    } catch (err) {
      return callback(err);
    }
    return callback(null, data);
  });
}

function processProblems(problemsPath, problems, callback) {
  client.get(problemsPath, (err, res, html) => {
    html = html || '';
    let m;
    try {
      let atLeastOnce = false;
      do {
        m = PROBLEMS_PATTERN.exec(html);
        if (m) {
          atLeastOnce = true;
          let id = m[1];
          let name = _.replace(m[2], '\\', '');
          if (id && name) {
            problems.push({
              id: id,
              name: name,
              oj: TYPE
            });
          }
        }
      } while (m);
      if (!atLeastOnce) throw new Error("list is over");
    } catch (e) {
      return callback(e);
    }
    return callback(null, problems);
  });
}

exports.fetchProblems = (callback) => {
  let problems = [];
  let idx = 1;
  async.forever(
    (next) => {
      let problemsPath = util.format(PROBLEMS_PATH_UNF, idx);
      idx = idx + 1;
      return processProblems(problemsPath, problems, next);
    },
    (err) => {
      return callback(null, problems);
    }
  );
}
