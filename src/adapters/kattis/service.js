'use strict';

const cheerio = require('cheerio'),
      assert  = require('assert'),
      async   = require('async'),
      path    = require('path'),
      util    = require('util'),
      _       = require('lodash');

const RequestClient = require('../../../common/lib/requestClient'),
      Util          = require('../../../common/lib/utils');

const TYPE = path.basename(__dirname);
const Config = Util.getOJConfig(TYPE);

const PROBLEMS_PATH_UNF = "/problems/?page=%s";
const PROBLEM_ID_PATTERN = /\/problems\/(.*)/i;

const TIMELIMIT_PATTERN = /CPU\s+Time\s+limit:\s+(.+)\s+second/i;
const MEMOLIMIT_PATTERN = /Memory\s+limit:\s+(\d+)\s*([a-zA-Z]{1,2})/i;
const AUTHOR_PATTERN    = /Author.+:\s+(.*)\s+/i;
const SOURCE_PATTERN    = /Source:\s+(.*)\s+/i;

const client = new RequestClient(Config.url);

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
      let header = $('.problem-sidebar');
      let match;
      if (match = header.text().match(TIMELIMIT_PATTERN)) {
        data.timelimit = parseFloat(match[1]);
      }
      if (match = header.text().match(MEMOLIMIT_PATTERN)) {
        data.memorylimit = `${match[1]} ${match[2]}`;
      }
      let src1 = null, src2 = null;
      if (match = header.text().match(AUTHOR_PATTERN)) {
        src1 = _.trim(match[1]);
      }
      if (match = header.text().match(SOURCE_PATTERN)) {
        src2 = _.trim(match[1]);
      }
      data.source = (src1 && src2) ? `${src1} (${src2})` : src1 || src2;
      assert($('.problembody').html().length > 0);
      data.html =
        '<div id="kattis" class="kattis-problem">' +
          $('.problembody').html() +
        '</div>' +
        '<script>' +
          '$(function() { MathJax.Hub.Typeset("kattis"); });' +
        '</script>';
    } catch (err) {
      return callback(err);
    }
    return callback(null, data);
  });
}

function processProblems(problemsPath, problems, callback) {
  client.get(problemsPath, (err, res, html) => {
    html = html || '';
    let $ = cheerio.load(html);
    let problemMatches = $('tbody td.name_column');
    if (problemMatches.length === 0) return callback(new Error());
    problemMatches.each((i, elem) => {
      try {
        let id = $(elem).find('a').attr('href');
        id = PROBLEM_ID_PATTERN.exec(id)[1];
        let name = $(elem).text();
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
  let idx = 0;
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
