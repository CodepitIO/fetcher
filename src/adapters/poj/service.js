'use strict';

const async   = require('async'),
      assert  = require('assert'),
      path    = require('path'),
      cheerio = require('cheerio'),
      util    = require('util'),
      iconv   = require('iconv-lite'),
      _       = require('lodash');

const Errors        = require('../../../common/errors'),
      RequestClient = require('../../../common/lib/requestClient'),
      Util          = require('../../../common/lib/utils');

const TYPE = path.basename(__dirname);
const Config = Util.getOJConfig(TYPE);

const client = new RequestClient(Config.url);

const PROBLEMS_PATH_UNF = "/problemlist?volume=%s";

const TIMELIMIT_PATTERN = /time\s*limit:\s*([\d.,]+)\s*\w/i;
const MEMOLIMIT_PATTERN = /memory\s*limit:\s*([\d\w\s]+)/i;

let dynamicWait = 0;

exports.import = (problem, callback) => {
  let urlPath = Config.getProblemPath(problem.id);
  client.get(urlPath, (err, res, html) => {
    let data = {};
    try {
      if (err) throw err;
      data.supportedLangs = Config.getSupportedLangs();
      html = html.replace(/(<)([^a-zA-Z\s\/\\!])/g, '&lt;$2');
      let $ = cheerio.load(html);
      Util.adjustAnchors($, Config.url + urlPath);
      let header = $('.plm');
      let match;
      if (match = header.text().match(TIMELIMIT_PATTERN)) {
        data.timelimit = parseFloat(match[1]) / 1000.;
      }
      if (match = header.text().match(MEMOLIMIT_PATTERN)) {
        data.memorylimit = Math.round(parseFloat(match[1]) / 1024.) + ' MB';
      }
      let body = '<div class="poj-problem problem-statement ttypography">';
      let parent = $('p.pst').parent();
      if (parent.children().slice(-2).html() === 'Source') {
        data.source = 'Source: ' + parent.children().slice(-1).text();
      }
      parent.children().slice(0,4).remove();
      if (data.source) {
        parent.children().slice(-2).remove();
      }
      assert(parent.html().length > 0);
      body += parent.html();
      body += '</div>' +
       '<script>' +
         '$(function() { MathJax.Hub.Typeset("poj"); });' +
       '</script>';
      data.html = body;
    } catch (err) {
      dynamicWait += 5000;
      return setTimeout(() => {
        return callback(err);
      }, dynamicWait);
    }
    dynamicWait = 0;
    return callback(null, data);
  });
}

function processProblems(problemsPath, problems, callback) {
  client.get(problemsPath, (err, res, html) => {
    html = html || '';
    let $ = cheerio.load(html);
    let problemsList = $('form').next().children('tr');
    if (problemsList.length <= 1) {
      return callback(new Error("No problems to parse"));
    }
    let problemMatches = problemsList.each((i, item) => {
      if (i == 0) return;
      try {
        let id = $(item).children().eq(0).text();
        let name = $(item).children().eq(1).text();
        if (id && name) {
          problems.push({
            id: id,
            name: name,
            oj: TYPE
          });
        }
      } catch (e) {}
    });
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
